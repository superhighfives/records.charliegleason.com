// SPDX-FileCopyrightText: 2026 Mark Phelps
// SPDX-License-Identifier: Apache-2.0

#pragma once

#include "rec_esp_err.h"

#define REC_PORTAL_AP_NAME_CAPACITY 15
#define REC_PORTAL_AP_PASSWORD_CAPACITY 11
#define REC_PORTAL_QR_PAYLOAD_CAPACITY 64

typedef struct {
    char ap_name[REC_PORTAL_AP_NAME_CAPACITY];
    char ap_password[REC_PORTAL_AP_PASSWORD_CAPACITY];
    char qr_payload[REC_PORTAL_QR_PAYLOAD_CAPACITY];
} rec_portal_config_t;

esp_err_t rec_portal_prepare(rec_portal_config_t *configuration);
esp_err_t rec_portal_start(const rec_portal_config_t *configuration);
