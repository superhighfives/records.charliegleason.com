// SPDX-FileCopyrightText: 2026 Mark Phelps
// SPDX-License-Identifier: Apache-2.0

#include <stdbool.h>
#include <string.h>

#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_touch.h"
#include "bsp/esp32_s3_touch_amoled_1_8.h"
#include "bsp/display.h"
#include "bsp/touch.h"
#include "credentials.h"
#include "diagnostics.h"
#include "esp_log.h"
#include "esp_lvgl_port.h"
#include "esp_lvgl_port_touch.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mdns.h"
#include "power.h"
#include "provisioning/portal.h"
#include "records_api.h"
#include "screenshot.h"
#include "slideshow.h"
#include "wifi.h"

#define LVGL_TASK_CORE 1
#define REC_TASK_CORE 0
#define DISPLAY_BUFFER_ROWS 100
// The BSP defines a zero display-lock timeout as an indefinite wait.
#define DISPLAY_LOCK_FOREVER_MS 0
#define CO5300_QSPI_NOP 0x02000000

static const char *TAG = "rec";
static rec_credentials_t credentials;
static rec_provision_state_t provision_state = REC_PROVISION_NONE;
static rec_portal_config_t portal_configuration;
static esp_lcd_panel_handle_t display_panel;
static esp_lcd_panel_io_handle_t display_panel_io;

static lv_obj_t *prepare_setup_screen(void)
{
    lv_obj_t *screen = lv_screen_active();
    lv_obj_clean(screen);
    lv_obj_set_style_bg_color(screen, lv_color_hex(0x080808), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, LV_PART_MAIN);
    return screen;
}

static void create_placeholder(const char *text)
{
    lv_obj_t *screen = prepare_setup_screen();
    lv_obj_t *label = lv_label_create(screen);
    lv_label_set_text(label, text);
    lv_obj_set_width(label, BSP_LCD_H_RES - 32);
    lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_CENTER, LV_PART_MAIN);
    lv_obj_set_style_text_color(label, lv_color_hex(0xffffff), LV_PART_MAIN);
    lv_obj_set_style_text_font(label, &lv_font_montserrat_24, LV_PART_MAIN);
    lv_obj_center(label);
}

static void create_portal_screen(const rec_portal_config_t *configuration)
{
    lv_obj_t *screen = prepare_setup_screen();

    lv_obj_t *heading = lv_label_create(screen);
    lv_label_set_text(heading, "Rec WiFi setup");
    lv_obj_set_width(heading, BSP_LCD_H_RES - 32);
    lv_obj_set_pos(heading, 16, 18);
    lv_obj_set_style_text_align(heading, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_text_color(heading, lv_color_hex(0xffffff), 0);
    lv_obj_set_style_text_font(heading, &lv_font_montserrat_24, 0);

    lv_obj_t *credentials_label = lv_label_create(screen);
    lv_label_set_text_fmt(
        credentials_label,
        "Network: %s\nPassword: %s",
        configuration->ap_name,
        configuration->ap_password);
    lv_obj_set_width(credentials_label, BSP_LCD_H_RES - 32);
    lv_obj_set_pos(credentials_label, 16, 60);
    lv_obj_set_style_text_align(credentials_label, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_text_color(credentials_label, lv_color_hex(0xFFFFFF), 0);
    lv_obj_set_style_text_font(credentials_label, &lv_font_montserrat_14, 0);

    lv_obj_t *qr_code = lv_qrcode_create(screen);
    lv_qrcode_set_size(qr_code, 210);
    lv_qrcode_set_dark_color(qr_code, lv_color_hex(0x000000));
    lv_qrcode_set_light_color(qr_code, lv_color_hex(0xFFFFFF));
    lv_obj_align(qr_code, LV_ALIGN_TOP_MID, 0, 116);
    if (lv_qrcode_update(
            qr_code,
            configuration->qr_payload,
            strlen(configuration->qr_payload))
        != LV_RESULT_OK) {
        ESP_LOGE(TAG, "Setup QR code creation failed");
    }

    lv_obj_t *caption = lv_label_create(screen);
    lv_label_set_text(caption, "Scan to connect, then follow the setup page");
    lv_obj_set_width(caption, BSP_LCD_H_RES - 40);
    lv_obj_set_pos(caption, 20, 352);
    lv_obj_set_style_text_align(caption, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_text_color(caption, lv_color_hex(0xFFFFFF), 0);
    lv_obj_set_style_text_font(caption, &lv_font_montserrat_14, 0);
}

static esp_err_t show_placeholder(const char *text)
{
    if (!bsp_display_lock(DISPLAY_LOCK_FOREVER_MS)) {
        return ESP_ERR_TIMEOUT;
    }
    create_placeholder(text);
    bsp_display_unlock();
    return ESP_OK;
}

static void startup_task(void *argument)
{
    rec_credentials_t *configured_credentials = argument;
    esp_err_t error = rec_wifi_init();
    if (error == ESP_OK) {
        error = rec_wifi_connect(configured_credentials);
    }
    if (error != ESP_OK) {
        ESP_LOGE(TAG, "Startup failed: %s", esp_err_to_name(error));
        vTaskDelete(NULL);
        return;
    }

    // Required once before any mdns_query_* call — companion_client.c's
    // discovery of the Records.app companion silently finds nothing without
    // it, regardless of network conditions.
    esp_err_t mdns_error = mdns_init();
    if (mdns_error == ESP_OK) {
        mdns_error = mdns_hostname_set("rec");
    }
    if (mdns_error != ESP_OK) {
        ESP_LOGW(TAG, "mDNS init failed: %s", esp_err_to_name(mdns_error));
    }

    esp_err_t time_error = rec_time_sync();
    if (time_error != ESP_OK) {
        ESP_LOGW(TAG, "Time synchronization failed: %s", esp_err_to_name(time_error));
    }

    // A weak WiFi signal drops a TLS handshake for this large a response far
    // more often than a plain HTTP request, so this fetch gets its own
    // bounded retries rather than failing the board on the first attempt.
    esp_err_t records_error = ESP_FAIL;
    for (int attempt = 1; attempt <= 3 && records_error != ESP_OK; ++attempt) {
        records_error = rec_records_refresh();
        if (records_error != ESP_OK && attempt < 3) {
            ESP_LOGW(
                TAG,
                "Records fetch failed (%d/3): %s",
                attempt,
                esp_err_to_name(records_error));
            vTaskDelay(pdMS_TO_TICKS(3000));
        }
    }
    if (records_error != ESP_OK) {
        ESP_LOGE(TAG, "Records fetch failed: %s", esp_err_to_name(records_error));
        show_placeholder("Couldn't load your records.\nCheck your connection.");
        vTaskDelete(NULL);
        return;
    }

    esp_err_t slideshow_error = rec_slideshow_start();
    if (slideshow_error != ESP_OK) {
        ESP_LOGE(TAG, "Slideshow start failed: %s", esp_err_to_name(slideshow_error));
    }
    vTaskDelete(NULL);
}

static void round_display_area(lv_event_t *event)
{
    lv_area_t *area = lv_event_get_param(event);
    area->x1 &= ~1;
    area->y1 &= ~1;
    area->x2 |= 1;
    area->y2 |= 1;
}

static void flush_display(lv_display_t *display, const lv_area_t *area, uint8_t *pixels)
{
    lv_draw_sw_rgb565_swap(pixels, lv_area_get_size(area));
    ESP_ERROR_CHECK(esp_lcd_panel_draw_bitmap(
        display_panel,
        area->x1,
        area->y1,
        area->x2 + 1,
        area->y2 + 1,
        pixels));

    /* Send an encoded QSPI NOP after the color transfer. The parameter
       transfer waits until DMA is complete before LVGL reuses its buffer. */
    ESP_ERROR_CHECK(
        esp_lcd_panel_io_tx_param(display_panel_io, CO5300_QSPI_NOP, NULL, 0));
    rec_screenshot_mirror_area(area, pixels);
    lv_display_flush_ready(display);
}

static esp_err_t recover_display_panel(void)
{
    esp_err_t error = esp_lcd_panel_disp_on_off(display_panel, false);
    if (error != ESP_OK) {
        return error;
    }
    vTaskDelay(pdMS_TO_TICKS(20));
    error = esp_lcd_panel_reset(display_panel);
    if (error != ESP_OK) {
        return error;
    }
    error = esp_lcd_panel_init(display_panel);
    if (error != ESP_OK) {
        return error;
    }
    return esp_lcd_panel_disp_on_off(display_panel, true);
}

static lv_display_t *start_display(void)
{
    lvgl_port_cfg_t lvgl_configuration = ESP_LVGL_PORT_INIT_CONFIG();
    lvgl_configuration.task_affinity = LVGL_TASK_CORE;
    if (lvgl_port_init(&lvgl_configuration) != ESP_OK) {
        return NULL;
    }

    bsp_display_config_t panel_configuration = {0};
    if (bsp_display_new(&panel_configuration, &display_panel, &display_panel_io) != ESP_OK) {
        return NULL;
    }
    esp_err_t recovery_error = recover_display_panel();
    if (recovery_error != ESP_OK) {
        ESP_LOGE(TAG, "Display panel recovery failed: %s", esp_err_to_name(recovery_error));
        return NULL;
    }

    const lvgl_port_display_cfg_t display_configuration = {
        .io_handle = display_panel_io,
        .panel_handle = display_panel,
        .buffer_size = BSP_LCD_H_RES * DISPLAY_BUFFER_ROWS,
        .double_buffer = false,
        .hres = BSP_LCD_H_RES,
        .vres = BSP_LCD_V_RES,
        .monochrome = false,
        .color_format = LV_COLOR_FORMAT_RGB565,
        .rotation = {
            .swap_xy = false,
            .mirror_x = false,
            .mirror_y = false,
        },
        .flags = {
            .sw_rotate = false,
            .buff_dma = true,
            .buff_spiram = false,
            .swap_bytes = false,
        },
    };
    if (!lvgl_port_lock(0)) {
        return NULL;
    }
    lv_display_t *display = lvgl_port_add_disp(&display_configuration);
    if (display == NULL) {
        lvgl_port_unlock();
        return NULL;
    }
    lv_display_set_flush_cb(display, flush_display);
    const esp_lcd_panel_io_callbacks_t no_callbacks = {0};
    esp_err_t callback_error = esp_lcd_panel_io_register_event_callbacks(
        display_panel_io, &no_callbacks, NULL);
    if (callback_error != ESP_OK) {
        lvgl_port_unlock();
        return NULL;
    }
    lv_display_add_event_cb(display, round_display_area, LV_EVENT_INVALIDATE_AREA, NULL);
    lvgl_port_unlock();

    esp_lcd_touch_handle_t touch = NULL;
    if (bsp_touch_new(NULL, &touch) != ESP_OK) {
        return NULL;
    }
    const lvgl_port_touch_cfg_t touch_configuration = {
        .disp = display,
        .handle = touch,
    };
    if (lvgl_port_add_touch(&touch_configuration) == NULL) {
        return NULL;
    }
    if (bsp_display_brightness_init() != ESP_OK) {
        return NULL;
    }
    return display;
}

void app_main(void)
{
    ESP_LOGI(TAG, "Starting the display");
    lv_display_t *display = start_display();
    if (display == NULL) {
        ESP_LOGE(TAG, "Display start failed");
        return;
    }
    esp_err_t screenshot_error = rec_screenshot_init();
    if (screenshot_error != ESP_OK) {
        ESP_LOGW(TAG, "Screenshot initialization failed: %s", esp_err_to_name(screenshot_error));
    }
    ESP_ERROR_CHECK(bsp_display_brightness_set(85));
    esp_err_t power_error = rec_power_start();
    if (power_error != ESP_OK) {
        ESP_LOGW(TAG, "Battery monitor is unavailable: %s", esp_err_to_name(power_error));
    }

    esp_err_t credentials_error = rec_credentials_init();
    if (credentials_error == ESP_OK) {
        credentials_error = rec_credentials_load(&credentials);
    }
    if (credentials_error == ESP_OK) {
        credentials_error = rec_credentials_state(&credentials, &provision_state);
    }
    if (credentials_error == ESP_OK && provision_state != REC_PROVISION_COMPLETE) {
        credentials_error = rec_portal_prepare(&portal_configuration);
    }
    const bool provisioned = credentials_error == ESP_OK
        && provision_state == REC_PROVISION_COMPLETE;

    if (!bsp_display_lock(0)) {
        ESP_LOGE(TAG, "LVGL lock failed");
        return;
    }
    if (provisioned) {
        create_placeholder("Loading your records…");
    } else if (credentials_error != ESP_OK) {
        create_placeholder("Credential error.\nRun:\nmise run deprovision");
    } else if (provision_state == REC_PROVISION_NONE) {
        create_portal_screen(&portal_configuration);
    } else {
        create_placeholder("Credential error.\nRun:\nmise run deprovision");
    }
    // The start runs after an initialization error too, because the serial task
    // answers the host with or without the mirror. rec_screenshot_start refuses
    // on its own when the serial path never came up.
    screenshot_error = rec_screenshot_start(display);
    if (screenshot_error != ESP_OK) {
        ESP_LOGW(TAG, "Screenshot task start failed: %s", esp_err_to_name(screenshot_error));
    }
    bsp_display_unlock();

    if (!provisioned) {
        if (credentials_error != ESP_OK) {
            ESP_LOGE(TAG, "Credential state failed: %s", esp_err_to_name(credentials_error));
            return;
        }
        esp_err_t portal_error = rec_portal_start(&portal_configuration);
        if (portal_error != ESP_OK) {
            ESP_LOGE(TAG, "Portal start failed: %s", esp_err_to_name(portal_error));
            show_placeholder("WiFi setup failed.\nRestart Rec.");
        }
        return;
    }

    esp_err_t diagnostics_error = rec_diagnostics_start();
    if (diagnostics_error != ESP_OK) {
        ESP_LOGW(TAG, "Soak diagnostics did not start: %s", esp_err_to_name(diagnostics_error));
    }
    if (xTaskCreatePinnedToCore(
            startup_task, "rec_startup", 16384, &credentials, 5, NULL, REC_TASK_CORE)
        != pdPASS) {
        ESP_LOGE(TAG, "Startup task creation failed");
    }
}
