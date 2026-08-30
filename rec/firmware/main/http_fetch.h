// SPDX-FileCopyrightText: 2026 Mark Phelps
// SPDX-License-Identifier: Apache-2.0

#pragma once

#include <stddef.h>
#include <stdint.h>

#include "rec_esp_err.h"

// Blocking HTTPS GET into a caller-owned buffer. Fails with ESP_FAIL if the
// response would overflow `capacity` rather than truncating it silently.
esp_err_t rec_http_fetch(const char *url, uint8_t *buffer, size_t capacity, size_t *out_length);
