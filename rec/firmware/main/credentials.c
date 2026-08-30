// SPDX-FileCopyrightText: 2026 Mark Phelps
// SPDX-License-Identifier: Apache-2.0

#include "credentials.h"

#include <stdbool.h>
#include <string.h>

#include "nvs.h"
#include "nvs_flash.h"

#define REC_NVS_NAMESPACE "rec"

// If rec adds credential keys here, change CREDENTIAL_KEYS in
// tools/device.py and the CSV in tools/provision.py with this list.
static const char *WIFI_SSID_KEY = "wifi_ssid";
static const char *WIFI_PASSWORD_KEY = "wifi_pass";

extern void mbedtls_platform_zeroize(void *buffer, size_t length);

static esp_err_t load_optional_string(
    nvs_handle_t handle, const char *key, char *output, size_t capacity)
{
    output[0] = '\0';
    size_t required = 0;
    esp_err_t error = nvs_get_str(handle, key, NULL, &required);
    if (error == ESP_ERR_NVS_NOT_FOUND) {
        return ESP_OK;
    }
    if (error != ESP_OK) {
        return error;
    }
    if (required == 0 || required > capacity) {
        return ESP_ERR_INVALID_SIZE;
    }
    return nvs_get_str(handle, key, output, &required);
}

esp_err_t rec_credentials_init(void)
{
    return nvs_flash_init();
}

esp_err_t rec_credentials_load(rec_credentials_t *credentials)
{
    if (credentials == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    mbedtls_platform_zeroize(credentials, sizeof(*credentials));

    nvs_handle_t handle;
    esp_err_t error = nvs_open(REC_NVS_NAMESPACE, NVS_READONLY, &handle);
    if (error == ESP_ERR_NVS_NOT_FOUND) {
        return ESP_OK;
    }
    if (error != ESP_OK) {
        return error;
    }

    error = load_optional_string(
        handle, WIFI_SSID_KEY, credentials->wifi_ssid, sizeof(credentials->wifi_ssid));
    if (error == ESP_OK) {
        error = load_optional_string(
            handle,
            WIFI_PASSWORD_KEY,
            credentials->wifi_password,
            sizeof(credentials->wifi_password));
    }
    nvs_close(handle);
    return error;
}

esp_err_t rec_credentials_state(
    const rec_credentials_t *credentials, rec_provision_state_t *state)
{
    if (credentials == NULL || state == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    const bool has_ssid = credentials->wifi_ssid[0] != '\0';
    const bool has_password = credentials->wifi_password[0] != '\0';

    if (!has_ssid && has_password) {
        return ESP_ERR_INVALID_STATE;
    }
    *state = has_ssid ? REC_PROVISION_COMPLETE : REC_PROVISION_NONE;
    return ESP_OK;
}

esp_err_t rec_credentials_store_wifi(const char *ssid, const char *password)
{
    if (ssid == NULL || password == NULL || ssid[0] == '\0') {
        return ESP_ERR_INVALID_ARG;
    }
    if (strnlen(ssid, REC_WIFI_SSID_CAPACITY) == REC_WIFI_SSID_CAPACITY
        || strnlen(password, REC_WIFI_PASSWORD_CAPACITY) == REC_WIFI_PASSWORD_CAPACITY) {
        return ESP_ERR_INVALID_SIZE;
    }

    nvs_handle_t handle;
    esp_err_t error = nvs_open(REC_NVS_NAMESPACE, NVS_READWRITE, &handle);
    if (error != ESP_OK) {
        return error;
    }
    error = nvs_set_str(handle, WIFI_SSID_KEY, ssid);
    if (error == ESP_OK) {
        error = nvs_set_str(handle, WIFI_PASSWORD_KEY, password);
    }
    if (error == ESP_OK) {
        error = nvs_commit(handle);
    }
    nvs_close(handle);
    return error;
}

esp_err_t rec_credentials_load_state(rec_provision_state_t *state)
{
    if (state == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    rec_credentials_t credentials;
    esp_err_t error = rec_credentials_load(&credentials);
    if (error == ESP_OK) {
        error = rec_credentials_state(&credentials, state);
    }
    mbedtls_platform_zeroize(&credentials, sizeof(credentials));
    return error;
}
