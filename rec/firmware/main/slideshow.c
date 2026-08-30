// SPDX-FileCopyrightText: 2026 Mark Phelps
// SPDX-License-Identifier: Apache-2.0

#include "slideshow.h"

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "bsp/esp32_s3_touch_amoled_1_8.h"
#include "bsp/display.h"
#include "companion_client.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_random.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "http_fetch.h"
#include "jpeg_decoder.h"
#include "lvgl.h"
#include "records_api.h"

#define SLIDESHOW_INTERVAL_MS 60000
#define COVER_WIDTH 336
// A quality-82, 336px JPEG from the site runs a few tens of KB; this leaves
// generous headroom without holding an unreasonable PSRAM allocation.
#define COVER_JPEG_BUFFER_CAPACITY (128 * 1024)
#define COVER_URL_CAPACITY 256
// The BSP defines a zero display-lock timeout as an indefinite wait.
#define DISPLAY_LOCK_FOREVER_MS 0
// Depth 2, not 1: a tap that lands while a prior play request is still in
// flight should queue behind it once, not be silently dropped outright.
#define PLAY_QUEUE_LENGTH 2

typedef struct {
    char artist[RECORDS_ARTIST_CAPACITY];
    char title[RECORDS_TITLE_CAPACITY];
} play_request_t;

static const char *TAG = "rec_slideshow";
static lv_obj_t *cover_image;
static lv_obj_t *title_label;
static lv_obj_t *artist_label;
static lv_image_dsc_t cover_descriptor;
static uint8_t *cover_pixels;
static QueueHandle_t play_queue;

// Guards the artist/title of whatever is currently on screen. The cycling
// task (core 0) writes it once per minute; a screen tap runs on the LVGL
// task (core 1) and reads it to know what to ask the companion to play.
static portMUX_TYPE current_lock = portMUX_INITIALIZER_UNLOCKED;
static char current_artist[RECORDS_ARTIST_CAPACITY];
static char current_title[RECORDS_TITLE_CAPACITY];

static void screen_tapped(lv_event_t *event)
{
    (void)event;
    play_request_t request;
    portENTER_CRITICAL(&current_lock);
    strlcpy(request.artist, current_artist, sizeof(request.artist));
    strlcpy(request.title, current_title, sizeof(request.title));
    portEXIT_CRITICAL(&current_lock);

    if (request.artist[0] == '\0') {
        return;
    }
    // Never blocks the LVGL task: a full queue means a play request is
    // already in flight, so dropping this tap is correct, not lossy.
    xQueueSend(play_queue, &request, 0);
}

static void build_screen(void)
{
    lv_obj_t *screen = lv_screen_active();
    lv_obj_clean(screen);
    lv_obj_set_style_bg_color(screen, lv_color_hex(0x080808), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_add_flag(screen, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_add_event_cb(screen, screen_tapped, LV_EVENT_CLICKED, NULL);

    cover_image = lv_image_create(screen);
    lv_obj_set_size(cover_image, COVER_WIDTH, COVER_WIDTH);
    lv_obj_align(cover_image, LV_ALIGN_TOP_MID, 0, 24);

    title_label = lv_label_create(screen);
    lv_obj_set_width(title_label, COVER_WIDTH);
    lv_obj_align(title_label, LV_ALIGN_TOP_MID, 0, 24 + COVER_WIDTH + 16);
    lv_obj_set_style_text_align(title_label, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_text_color(title_label, lv_color_hex(0xffffff), 0);
    lv_obj_set_style_text_font(title_label, &lv_font_montserrat_24, 0);
    lv_label_set_text(title_label, "Loading your records…");

    artist_label = lv_label_create(screen);
    lv_obj_set_width(artist_label, COVER_WIDTH);
    lv_obj_align(artist_label, LV_ALIGN_TOP_MID, 0, 24 + COVER_WIDTH + 52);
    lv_obj_set_style_text_align(artist_label, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_text_color(artist_label, lv_color_hex(0xaaaaaa), 0);
    lv_obj_set_style_text_font(artist_label, &lv_font_montserrat_14, 0);
}

static esp_err_t fetch_and_decode_cover(
    const char *cover_key, uint8_t **out_pixels, esp_jpeg_image_output_t *out_image)
{
    char url[COVER_URL_CAPACITY];
    snprintf(
        url,
        sizeof(url),
        "https://records.charliegleason.com/api/photos/%s?w=%d&format=jpeg",
        cover_key,
        COVER_WIDTH);

    uint8_t *jpeg_buffer = heap_caps_malloc(COVER_JPEG_BUFFER_CAPACITY, MALLOC_CAP_SPIRAM);
    if (jpeg_buffer == NULL) {
        return ESP_ERR_NO_MEM;
    }
    size_t jpeg_length = 0;
    esp_err_t error = rec_http_fetch(url, jpeg_buffer, COVER_JPEG_BUFFER_CAPACITY, &jpeg_length);
    if (error != ESP_OK) {
        free(jpeg_buffer);
        return error;
    }
    // SOF0 (0xFFC0) is baseline, SOF2 (0xFFC2) is progressive — esp_jpeg can
    // only decode the former. Logged once while this fails consistently.
    bool found_sof = false;
    for (size_t i = 0; i + 3 < jpeg_length && !found_sof; ++i) {
        if (jpeg_buffer[i] == 0xFF && (jpeg_buffer[i + 1] == 0xC0 || jpeg_buffer[i + 1] == 0xC2)) {
            ESP_LOGI(
                TAG,
                "fetched %u bytes, SOF marker: 0x%02X (%s)",
                (unsigned)jpeg_length,
                jpeg_buffer[i + 1],
                jpeg_buffer[i + 1] == 0xC0 ? "baseline" : "progressive");
            found_sof = true;
        }
    }
    if (!found_sof) {
        ESP_LOGW(TAG, "fetched %u bytes, no SOF0/SOF2 marker found", (unsigned)jpeg_length);
    }

    esp_jpeg_image_cfg_t configuration = {
        .indata = jpeg_buffer,
        .indata_size = jpeg_length,
        .out_format = JPEG_IMAGE_FORMAT_RGB565,
        .out_scale = JPEG_IMAGE_SCALE_0,
    };
    esp_jpeg_image_output_t info = {0};
    error = esp_jpeg_get_image_info(&configuration, &info);
    if (error != ESP_OK) {
        ESP_LOGW(TAG, "esp_jpeg_get_image_info failed: %s", esp_err_to_name(error));
        free(jpeg_buffer);
        return error;
    }
    ESP_LOGI(
        TAG,
        "image info: %ux%u, output_len=%u",
        info.width,
        info.height,
        (unsigned)info.output_len);

    uint8_t *pixels = heap_caps_malloc(info.output_len, MALLOC_CAP_SPIRAM);
    if (pixels == NULL) {
        free(jpeg_buffer);
        return ESP_ERR_NO_MEM;
    }
    configuration.outbuf = pixels;
    configuration.outbuf_size = info.output_len;
    error = esp_jpeg_decode(&configuration, &info);
    free(jpeg_buffer);
    if (error != ESP_OK) {
        ESP_LOGW(TAG, "esp_jpeg_decode failed: %s", esp_err_to_name(error));
        free(pixels);
        return error;
    }

    *out_pixels = pixels;
    *out_image = info;
    return ESP_OK;
}

static void show_record(const rec_record_t *record)
{
    uint8_t *pixels = NULL;
    esp_jpeg_image_output_t image = {0};
    esp_err_t error = fetch_and_decode_cover(record->cover_key, &pixels, &image);

    if (!bsp_display_lock(DISPLAY_LOCK_FOREVER_MS)) {
        free(pixels);
        return;
    }
    if (error == ESP_OK) {
        // The UI owns this pointer once it's on screen; the previous
        // buffer is only safe to free after the new one replaces it.
        uint8_t *previous_pixels = cover_pixels;
        cover_descriptor.header.magic = LV_IMAGE_HEADER_MAGIC;
        cover_descriptor.header.cf = LV_COLOR_FORMAT_RGB565;
        cover_descriptor.header.w = image.width;
        cover_descriptor.header.h = image.height;
        cover_descriptor.data_size = image.output_len;
        cover_descriptor.data = pixels;
        lv_image_set_src(cover_image, &cover_descriptor);
        cover_pixels = pixels;
        free(previous_pixels);
    } else {
        ESP_LOGW(TAG, "Cover art failed for %s: %s", record->cover_key, esp_err_to_name(error));
    }
    lv_label_set_text(title_label, record->title);
    lv_label_set_text(artist_label, record->artist);
    bsp_display_unlock();

    portENTER_CRITICAL(&current_lock);
    strlcpy(current_artist, record->artist, sizeof(current_artist));
    strlcpy(current_title, record->title, sizeof(current_title));
    portEXIT_CRITICAL(&current_lock);

    char cover_url[COVER_URL_CAPACITY];
    snprintf(
        cover_url,
        sizeof(cover_url),
        "https://records.charliegleason.com/api/photos/%s?w=500",
        record->cover_key);
    esp_err_t notify_error =
        rec_companion_notify_now_showing(record->artist, record->title, cover_url);
    if (notify_error != ESP_OK) {
        ESP_LOGW(TAG, "Companion notify failed: %s", esp_err_to_name(notify_error));
    }
}

static void cycle_task(void *argument)
{
    (void)argument;
    for (;;) {
        size_t count = rec_records_count();
        if (count > 0) {
            const rec_record_t *record = rec_records_get(esp_random() % count);
            if (record != NULL) {
                show_record(record);
            }
        }
        vTaskDelay(pdMS_TO_TICKS(SLIDESHOW_INTERVAL_MS));
    }
}

static void play_task(void *argument)
{
    (void)argument;
    play_request_t request;
    for (;;) {
        if (xQueueReceive(play_queue, &request, portMAX_DELAY) != pdTRUE) {
            continue;
        }
        esp_err_t error = rec_companion_play(request.artist, request.title);
        if (error != ESP_OK) {
            ESP_LOGW(TAG, "Play request failed: %s", esp_err_to_name(error));
        }
    }
}

esp_err_t rec_slideshow_start(void)
{
    play_queue = xQueueCreate(PLAY_QUEUE_LENGTH, sizeof(play_request_t));
    if (play_queue == NULL) {
        return ESP_ERR_NO_MEM;
    }

    if (!bsp_display_lock(DISPLAY_LOCK_FOREVER_MS)) {
        return ESP_ERR_TIMEOUT;
    }
    build_screen();
    bsp_display_unlock();

    if (xTaskCreate(play_task, "rec_play", 4096, NULL, 4, NULL) != pdPASS) {
        return ESP_ERR_NO_MEM;
    }
    if (xTaskCreatePinnedToCore(cycle_task, "rec_cycle", 8192, NULL, 3, NULL, 0) != pdPASS) {
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}
