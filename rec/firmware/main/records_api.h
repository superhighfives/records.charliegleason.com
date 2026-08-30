// SPDX-FileCopyrightText: 2026 Mark Phelps
// SPDX-License-Identifier: Apache-2.0

#pragma once

#include <stddef.h>

#include "rec_esp_err.h"

#define RECORDS_ARTIST_CAPACITY 96
#define RECORDS_TITLE_CAPACITY 128
#define RECORDS_COVER_KEY_CAPACITY 160

typedef struct {
    char artist[RECORDS_ARTIST_CAPACITY];
    char title[RECORDS_TITLE_CAPACITY];
    char cover_key[RECORDS_COVER_KEY_CAPACITY];
} rec_record_t;

// Fetches the public collection from records.charliegleason.com and replaces
// the module's cached list. Records with no artist, title, or cover image
// are skipped — there is nothing to show or play for them.
esp_err_t rec_records_refresh(void);
size_t rec_records_count(void);
const rec_record_t *rec_records_get(size_t index);
