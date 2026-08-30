// SPDX-FileCopyrightText: 2026 Mark Phelps
// SPDX-License-Identifier: Apache-2.0

#include "http_fetch.h"

#include <string.h>

#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"

#define HTTP_TIMEOUT_MS 20000

static const char *TAG = "rec_http_fetch";

typedef struct {
    uint8_t *buffer;
    size_t capacity;
    size_t length;
} fetch_context_t;

static esp_err_t handle_event(esp_http_client_event_t *event)
{
    if (event->event_id != HTTP_EVENT_ON_DATA) {
        return ESP_OK;
    }
    fetch_context_t *context = event->user_data;
    if (context->length + (size_t)event->data_len > context->capacity) {
        ESP_LOGE(TAG, "Response exceeded the download buffer");
        return ESP_FAIL;
    }
    memcpy(context->buffer + context->length, event->data, event->data_len);
    context->length += event->data_len;
    return ESP_OK;
}

esp_err_t rec_http_fetch(const char *url, uint8_t *buffer, size_t capacity, size_t *out_length)
{
    fetch_context_t context = {.buffer = buffer, .capacity = capacity, .length = 0};
    const esp_http_client_config_t configuration = {
        .url = url,
        .event_handler = handle_event,
        .user_data = &context,
        .timeout_ms = HTTP_TIMEOUT_MS,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .buffer_size = 4096,
    };
    esp_http_client_handle_t client = esp_http_client_init(&configuration);
    if (client == NULL) {
        return ESP_ERR_NO_MEM;
    }

    ESP_LOGI(
        TAG,
        "internal free before perform: %u bytes (min ever: %u)",
        (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
        (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL));
    esp_err_t error = esp_http_client_perform(client);
    ESP_LOGI(
        TAG,
        "internal free after perform: %u bytes (min ever: %u)",
        (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
        (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL));
    int status = esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);
    if (error != ESP_OK) {
        return error;
    }
    if (status != 200) {
        ESP_LOGW(TAG, "%s returned status %d", url, status);
        return ESP_FAIL;
    }
    *out_length = context.length;
    return ESP_OK;
}
