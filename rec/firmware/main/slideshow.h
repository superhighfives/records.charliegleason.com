// SPDX-FileCopyrightText: 2026 Mark Phelps
// SPDX-License-Identifier: Apache-2.0

#pragma once

#include "rec_esp_err.h"

// Builds the record-cover screen and starts the cycling and play-request
// tasks. The caller must have already populated the records cache (see
// records_api.h) and must not be holding the display lock.
esp_err_t rec_slideshow_start(void);
