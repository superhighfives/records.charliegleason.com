// SPDX-FileCopyrightText: 2026 Mark Phelps
// SPDX-License-Identifier: Apache-2.0

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "rec_esp_err.h"
#include "credentials.h"

typedef struct {
    bool connected;
    uint32_t connects;
    uint32_t disconnects;
    uint32_t reconnect_attempts;
} rec_wifi_status_t;

esp_err_t rec_wifi_init(void);
esp_err_t rec_wifi_connect(const rec_credentials_t *credentials);
esp_err_t rec_wifi_connect_bounded(const rec_credentials_t *credentials);
esp_err_t rec_wifi_prepare_portal(void);
esp_err_t rec_wifi_start_portal_ap(const char *ssid, const char *password);
esp_err_t rec_wifi_stop_portal_ap(void);
bool rec_wifi_is_connected(void);
void rec_wifi_get_status(rec_wifi_status_t *status);
bool rec_wifi_wait_connected(void);
esp_err_t rec_wifi_get_ip_address(char *buffer, size_t capacity);
esp_err_t rec_time_sync(void);
