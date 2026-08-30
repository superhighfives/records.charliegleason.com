// SPDX-FileCopyrightText: 2026 Mark Phelps
// SPDX-License-Identifier: Apache-2.0

#include "records_api.h"

#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "http_fetch.h"

// The full /api/records payload runs ~1.2MB with every Discogs/pipeline
// field — that reliably died mid-transfer on a weak WiFi signal even across
// retries. /lite trims each record to just what the board needs, cutting
// the payload by roughly an order of magnitude.
#define RECORDS_URL "https://records.charliegleason.com/api/records/lite"
// ~300 records of id/artist/title/coverKey ran a few tens of KB; this
// leaves generous headroom for the collection to grow.
#define RECORDS_JSON_BUFFER_CAPACITY (256 * 1024)
#define RECORDS_MAX_COUNT 400

static const char *TAG = "rec_records";
static rec_record_t *records;
static size_t record_count;

static const char *string_field(const cJSON *record, const char *key)
{
    const cJSON *field = cJSON_GetObjectItemCaseSensitive(record, key);
    return cJSON_IsString(field) && field->valuestring[0] != '\0' ? field->valuestring : NULL;
}

// /lite already picked the approved professional photo over the raw
// Discogs-sourced cover and dropped records with no usable one at all
// (see the site's own `toPublicRecord` and the /lite route).
static size_t parse_records(const char *json, rec_record_t *destination, size_t capacity)
{
    cJSON *root = cJSON_Parse(json);
    if (root == NULL) {
        return 0;
    }
    const cJSON *rows = cJSON_GetObjectItemCaseSensitive(root, "records");
    if (!cJSON_IsArray(rows)) {
        cJSON_Delete(root);
        return 0;
    }

    size_t written = 0;
    const cJSON *row;
    cJSON_ArrayForEach(row, rows)
    {
        if (written == capacity) {
            break;
        }
        const char *artist = string_field(row, "artist");
        const char *title = string_field(row, "title");
        const char *cover_key = string_field(row, "coverKey");
        if (artist == NULL || title == NULL || cover_key == NULL) {
            continue;
        }

        rec_record_t *destination_record = &destination[written];
        strlcpy(destination_record->artist, artist, RECORDS_ARTIST_CAPACITY);
        strlcpy(destination_record->title, title, RECORDS_TITLE_CAPACITY);
        strlcpy(destination_record->cover_key, cover_key, RECORDS_COVER_KEY_CAPACITY);
        ++written;
    }

    cJSON_Delete(root);
    return written;
}

esp_err_t rec_records_refresh(void)
{
    char *json_buffer = heap_caps_malloc(RECORDS_JSON_BUFFER_CAPACITY, MALLOC_CAP_SPIRAM);
    if (json_buffer == NULL) {
        return ESP_ERR_NO_MEM;
    }

    size_t length = 0;
    esp_err_t error = rec_http_fetch(
        RECORDS_URL, (uint8_t *)json_buffer, RECORDS_JSON_BUFFER_CAPACITY - 1, &length);
    if (error != ESP_OK) {
        ESP_LOGE(TAG, "Records fetch failed: %s", esp_err_to_name(error));
        free(json_buffer);
        return error;
    }
    json_buffer[length] = '\0';

    rec_record_t *parsed = heap_caps_malloc(sizeof(rec_record_t) * RECORDS_MAX_COUNT, MALLOC_CAP_SPIRAM);
    if (parsed == NULL) {
        free(json_buffer);
        return ESP_ERR_NO_MEM;
    }
    size_t count = parse_records(json_buffer, parsed, RECORDS_MAX_COUNT);
    free(json_buffer);
    if (count == 0) {
        ESP_LOGE(TAG, "No usable records found in the response");
        free(parsed);
        return ESP_FAIL;
    }

    free(records);
    records = parsed;
    record_count = count;
    ESP_LOGI(TAG, "Loaded %u records", (unsigned)record_count);
    return ESP_OK;
}

size_t rec_records_count(void)
{
    return record_count;
}

const rec_record_t *rec_records_get(size_t index)
{
    return index < record_count ? &records[index] : NULL;
}
