// SPDX-FileCopyrightText: 2026 Mark Phelps
// SPDX-License-Identifier: Apache-2.0

#pragma once

#include "rec_esp_err.h"

#define REC_WIFI_SSID_CAPACITY 33
#define REC_WIFI_PASSWORD_CAPACITY 65

typedef struct {
    char wifi_ssid[REC_WIFI_SSID_CAPACITY];
    char wifi_password[REC_WIFI_PASSWORD_CAPACITY];
} rec_credentials_t;

typedef enum {
    REC_PROVISION_NONE,
    REC_PROVISION_COMPLETE,
} rec_provision_state_t;

esp_err_t rec_credentials_init(void);
esp_err_t rec_credentials_load(rec_credentials_t *credentials);
esp_err_t rec_credentials_state(
    const rec_credentials_t *credentials, rec_provision_state_t *state);
esp_err_t rec_credentials_store_wifi(const char *ssid, const char *password);
esp_err_t rec_credentials_load_state(rec_provision_state_t *state);
