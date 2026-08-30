# SPDX-FileCopyrightText: 2026 Mark Phelps
# SPDX-License-Identifier: Apache-2.0

idf_component_register(
    SRCS
        "app_main.c"
        "companion_client.c"
        "credentials.c"
        "diagnostics.c"
        "http_fetch.c"
        "power.c"
        "provisioning/dns_hijack.c"
        "provisioning/portal.c"
        "records_api.c"
        "screenshot.c"
        "slideshow.c"
        "wifi.c"
    INCLUDE_DIRS "."
    REQUIRES
        bootloader_support
        esp32_s3_touch_amoled_1_8
        esp_driver_usb_serial_jtag
        esp-tls
        esp_http_client
        esp_http_server
        esp_jpeg
        esp_netif
        json
        mdns
        esp_timer
        esp_wifi
        espressif__esp_lcd_touch
        espressif__esp_lvgl_port
        lvgl__lvgl
        mbedtls
        nvs_flash
    EMBED_TXTFILES
        "provisioning/portal_page.html"
)

idf_build_get_property(build_components BUILD_COMPONENTS)
if("lvgl__lvgl" IN_LIST build_components)
    idf_component_get_property(LVGL_LIB lvgl__lvgl COMPONENT_LIB)
    if(TARGET ${LVGL_LIB})
        target_compile_options(${LVGL_LIB} PRIVATE -Wno-error=attributes)
    endif()
endif()
