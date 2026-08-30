// SPDX-FileCopyrightText: 2026 Mark Phelps
// SPDX-License-Identifier: Apache-2.0

#include "companion_client.h"

#include <stdio.h>
#include <string.h>

#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "mdns.h"
#include "records_api.h"

#define SERVICE_TYPE "_recplay"
#define SERVICE_PROTO "_tcp"
#define MDNS_QUERY_TIMEOUT_MS 3000
#define HOSTNAME_CAPACITY 64
#define HOST_CAPACITY 16
#define URL_CAPACITY 64
#define BODY_CAPACITY 512
#define HTTP_TIMEOUT_MS 5000
// Worst case every character needs a backslash escape.
#define ESCAPED_ARTIST_CAPACITY (RECORDS_ARTIST_CAPACITY * 2)
#define ESCAPED_TITLE_CAPACITY (RECORDS_TITLE_CAPACITY * 2)

static const char *TAG = "rec_companion";

// A single mdns_query_ptr() bundles PTR+SRV+A resolution into one query, but
// in practice the A record consistently arrives too late to be included —
// the hostname and port always come back, the address list is always empty.
// Resolving the hostname to an address as its own query, with its own full
// timeout budget, is what actually gets an address back.
static esp_err_t resolve_companion(char *host_out, size_t host_capacity, uint16_t *port_out)
{
    mdns_result_t *results = NULL;
    esp_err_t error =
        mdns_query_ptr(SERVICE_TYPE, SERVICE_PROTO, MDNS_QUERY_TIMEOUT_MS, 1, &results);
    if (error != ESP_OK || results == NULL || results->hostname == NULL) {
        ESP_LOGW(TAG, "Companion service not found on the network");
        mdns_query_results_free(results);
        return ESP_ERR_NOT_FOUND;
    }

    char hostname[HOSTNAME_CAPACITY];
    strlcpy(hostname, results->hostname, sizeof(hostname));
    uint16_t port = results->port;
    mdns_query_results_free(results);

    esp_ip4_addr_t address = {0};
    error = mdns_query_a(hostname, MDNS_QUERY_TIMEOUT_MS, &address);
    if (error != ESP_OK) {
        ESP_LOGW(TAG, "Could not resolve an address for %s: %s", hostname, esp_err_to_name(error));
        return ESP_ERR_NOT_FOUND;
    }
    if (esp_ip4addr_ntoa(&address, host_out, (int)host_capacity) == NULL) {
        return ESP_ERR_NOT_FOUND;
    }
    *port_out = port;
    return ESP_OK;
}

// Escapes '"' and '\' so an untrusted artist/title never breaks out of its
// JSON string — album titles are free text and occasionally contain quotes.
static void json_escape(char *destination, size_t capacity, const char *source)
{
    size_t written = 0;
    for (const char *character = source; *character != '\0' && written + 2 < capacity; ++character) {
        if (*character == '"' || *character == '\\') {
            destination[written++] = '\\';
        }
        destination[written++] = *character;
    }
    destination[written] = '\0';
}

static esp_err_t post_json(const char *path, const char *body)
{
    char host[HOST_CAPACITY];
    uint16_t port = 0;
    esp_err_t error = resolve_companion(host, sizeof(host), &port);
    if (error != ESP_OK) {
        return error;
    }

    char url[URL_CAPACITY];
    snprintf(url, sizeof(url), "http://%s:%u%s", host, (unsigned)port, path);

    const esp_http_client_config_t configuration = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = HTTP_TIMEOUT_MS,
    };
    esp_http_client_handle_t client = esp_http_client_init(&configuration);
    if (client == NULL) {
        return ESP_ERR_NO_MEM;
    }
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_post_field(client, body, (int)strlen(body));

    error = esp_http_client_perform(client);
    int status = esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);
    if (error != ESP_OK || status >= 300) {
        ESP_LOGW(TAG, "%s failed: %s (status %d)", path, esp_err_to_name(error), status);
        return ESP_FAIL;
    }
    return ESP_OK;
}

esp_err_t rec_companion_notify_now_showing(
    const char *artist, const char *title, const char *cover_url)
{
    char escaped_artist[ESCAPED_ARTIST_CAPACITY];
    char escaped_title[ESCAPED_TITLE_CAPACITY];
    json_escape(escaped_artist, sizeof(escaped_artist), artist);
    json_escape(escaped_title, sizeof(escaped_title), title);

    char body[BODY_CAPACITY];
    if (cover_url != NULL) {
        snprintf(
            body,
            sizeof(body),
            "{\"artist\":\"%s\",\"title\":\"%s\",\"coverUrl\":\"%s\"}",
            escaped_artist,
            escaped_title,
            cover_url);
    } else {
        snprintf(
            body, sizeof(body), "{\"artist\":\"%s\",\"title\":\"%s\"}", escaped_artist, escaped_title);
    }
    return post_json("/now", body);
}

esp_err_t rec_companion_play(const char *artist, const char *title)
{
    char escaped_artist[ESCAPED_ARTIST_CAPACITY];
    char escaped_title[ESCAPED_TITLE_CAPACITY];
    json_escape(escaped_artist, sizeof(escaped_artist), artist);
    json_escape(escaped_title, sizeof(escaped_title), title);

    char body[BODY_CAPACITY];
    snprintf(body, sizeof(body), "{\"artist\":\"%s\",\"title\":\"%s\"}", escaped_artist, escaped_title);
    return post_json("/play", body);
}
