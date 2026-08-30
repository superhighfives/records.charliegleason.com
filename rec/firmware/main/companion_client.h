// SPDX-FileCopyrightText: 2026 Mark Phelps
// SPDX-License-Identifier: Apache-2.0

#pragma once

#include "rec_esp_err.h"

// Talks to the Records.app companion on the LAN, discovered by mDNS as
// `_recplay._tcp` rather than a hardcoded IP. `cover_url` may be NULL.
esp_err_t rec_companion_notify_now_showing(
    const char *artist, const char *title, const char *cover_url);
esp_err_t rec_companion_play(const char *artist, const char *title);
