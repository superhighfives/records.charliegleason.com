#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Mark Phelps
# SPDX-License-Identifier: Apache-2.0

"""Protect the captive-portal startup, parsing, and secret boundaries."""

from __future__ import annotations

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent


def read_source(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def without_c_comments(source: str) -> str:
    output: list[str] = []
    offset = 0
    quote: str | None = None
    while offset < len(source):
        character = source[offset]
        following = source[offset + 1] if offset + 1 < len(source) else ""
        if quote is not None:
            output.append(character)
            if character == "\\" and following:
                output.append(following)
                offset += 2
                continue
            if character == quote:
                quote = None
            offset += 1
            continue
        if character in {'"', "'"}:
            quote = character
            output.append(character)
            offset += 1
            continue
        if character == "/" and following == "/":
            offset += 2
            while offset < len(source) and source[offset] != "\n":
                offset += 1
            continue
        if character == "/" and following == "*":
            offset += 2
            while offset + 1 < len(source) and source[offset : offset + 2] != "*/":
                if source[offset] == "\n":
                    output.append("\n")
                offset += 1
            offset += 2
            continue
        output.append(character)
        offset += 1
    return "".join(output)


def without_hash_comments(source: str) -> str:
    output: list[str] = []
    quote: str | None = None
    offset = 0
    while offset < len(source):
        character = source[offset]
        following = source[offset + 1] if offset + 1 < len(source) else ""
        if quote is not None:
            output.append(character)
            if character == "\\" and following:
                output.append(following)
                offset += 2
                continue
            if character == quote:
                quote = None
            offset += 1
            continue
        if character in {'"', "'"}:
            quote = character
            output.append(character)
            offset += 1
            continue
        if character == "#":
            while offset < len(source) and source[offset] != "\n":
                offset += 1
            continue
        output.append(character)
        offset += 1
    return "".join(output)


def without_html_comments(source: str) -> str:
    return re.sub(r"<!--.*?-->", "", source, flags=re.DOTALL)


def matching_delimiter(source: str, start: int, opening: str, closing: str) -> int:
    depth = 0
    quote: str | None = None
    offset = start
    while offset < len(source):
        character = source[offset]
        following = source[offset + 1] if offset + 1 < len(source) else ""
        if quote is not None:
            if character == "\\" and following:
                offset += 2
                continue
            if character == quote:
                quote = None
            offset += 1
            continue
        if character in {'"', "'"}:
            quote = character
        elif character == opening:
            depth += 1
        elif character == closing:
            depth -= 1
            if depth == 0:
                return offset
        offset += 1
    raise AssertionError(f"unclosed {opening} at offset {start}")


def function_body(source: str, name: str) -> str:
    source = without_c_comments(source)
    for match in re.finditer(rf"\b{re.escape(name)}\s*\(", source):
        open_parenthesis = source.find("(", match.start())
        close_parenthesis = matching_delimiter(source, open_parenthesis, "(", ")")
        offset = close_parenthesis + 1
        while offset < len(source) and source[offset].isspace():
            offset += 1
        if offset < len(source) and source[offset] == "{":
            close_brace = matching_delimiter(source, offset, "{", "}")
            return source[match.start() : close_brace + 1]
    raise AssertionError(f"function {name} was not found")


def call_body(source: str, name: str) -> str:
    match = re.search(rf"\b{re.escape(name)}\s*\(", source)
    assert match is not None, f"call {name} was not found"
    open_parenthesis = source.find("(", match.start())
    close_parenthesis = matching_delimiter(source, open_parenthesis, "(", ")")
    return source[match.start() : close_parenthesis + 1]


def assert_order(source: str, *fragments: str) -> None:
    positions = [source.index(fragment) for fragment in fragments]
    assert positions == sorted(positions), f"wrong order: {' -> '.join(fragments)}"


def test_portal_owns_no_nvs_storage() -> None:
    firmware_root = ROOT / "firmware/main"
    credentials_path = firmware_root / "credentials.c"
    for path in sorted((firmware_root / "provisioning").rglob("*.c")):
        source = without_c_comments(path.read_text(encoding="utf-8"))
        assert not re.search(r"\bnvs_[a-z_]+\s*\(", source), (
            f"{path.relative_to(ROOT)} calls an NVS API"
        )
        assert "REC_NVS_NAMESPACE" not in source, (
            f"{path.relative_to(ROOT)} names the NVS namespace"
        )

    credential_key = re.compile(r'"(?:wifi_ssid|wifi_pass|client_id|refresh_tok)"')
    for path in sorted(firmware_root.rglob("*.c")):
        if path == credentials_path:
            continue
        source = without_c_comments(path.read_text(encoding="utf-8"))
        assert not credential_key.search(source), (
            f"{path.relative_to(ROOT)} names an NVS credential key outside credentials.c"
        )
        for write_call in re.findall(r"\bnvs_set_[a-z0-9_]+\s*\([^;]*\);", source, re.DOTALL):
            assert not re.search(
                r"\b(?:wifi|ssid|pass|password|client|refresh|token)[a-z0-9_]*\b",
                write_call,
                re.IGNORECASE,
            ), f"{path.relative_to(ROOT)} writes credential-like data outside credentials.c"

    credentials = without_c_comments(credentials_path.read_text(encoding="utf-8"))
    assert 'static const char *WIFI_SSID_KEY = "wifi_ssid";' in credentials
    assert 'static const char *WIFI_PASSWORD_KEY = "wifi_pass";' in credentials
    assert "nvs_set_str(handle, WIFI_SSID_KEY, ssid)" in credentials
    assert "nvs_set_str(handle, WIFI_PASSWORD_KEY, password)" in credentials
    assert "nvs_commit(handle)" in credentials
    portal = read_source("firmware/main/provisioning/portal.c")
    connect = function_body(portal, "connect_post")
    assert "rec_credentials_store_wifi(ssid, password)" in connect


def test_build_registers_the_complete_portal() -> None:
    cmake = without_hash_comments(read_source("firmware/main/CMakeLists.txt"))
    registration = call_body(cmake, "idf_component_register")
    for source in (
        '"provisioning/dns_hijack.c"',
        '"provisioning/portal.c"',
        '"provisioning/portal_page.html"',
    ):
        assert source in registration, f"CMake omits {source}"
    assert "EMBED_TXTFILES" in registration
    assert "esp_http_server" in registration
    assert "bootloader_support" in registration


def test_captive_routes_redirect_to_root() -> None:
    portal = read_source("firmware/main/provisioning/portal.c")
    server = function_body(portal, "start_http_server")
    for route in (
        '"/generate_204"',
        '"/hotspot-detect.html"',
        '"/connecttest.txt"',
        '"/ncsi.txt"',
    ):
        assert route in server, f"portal omits captive route {route}"
    assert "configuration.max_uri_handlers = 7" in server
    assert ".uri = captive_routes[index]" in server
    assert ".handler = redirect_get" in server
    assert re.search(
        r"index\s*<\s*sizeof\(captive_routes\)\s*/\s*"
        r"sizeof\(captive_routes\[0\]\)",
        server,
    ), "route loop must cover the complete captive-route array"
    assert "httpd_register_uri_handler(http_server, &captive_route)" in server
    redirect = function_body(portal, "redirect_get")
    assert '"302 Found"' in redirect
    assert '"Location", "/"' in redirect
    missing = function_body(portal, "not_found")
    assert "request->method != HTTP_GET" in missing
    assert "redirect_get(request)" in missing


def test_supported_auth_modes_keep_personal_boundary() -> None:
    portal = read_source("firmware/main/provisioning/portal.c")
    auth_mode = function_body(portal, "supported_auth_mode")
    supported = (
        "WIFI_AUTH_OPEN",
        "WIFI_AUTH_WPA2_PSK",
        "WIFI_AUTH_WPA_WPA2_PSK",
        "WIFI_AUTH_WPA3_PSK",
        "WIFI_AUTH_WPA2_WPA3_PSK",
        "WIFI_AUTH_WPA3_EXT_PSK",
        "WIFI_AUTH_WPA3_EXT_PSK_MIXED_MODE",
    )
    normalized = re.sub(r"\s+", "", auth_mode)
    actual_cases = tuple(re.findall(r"case(WIFI_AUTH_[A-Z0-9_]+):", normalized))
    assert actual_cases == supported, "portal auth-mode cases changed"
    expected_switch = (
        "switch(auth_mode){"
        + "".join(f"case{mode}:" for mode in supported)
        + "returntrue;default:returnfalse;}"
    )
    expected_function = "supported_auth_mode(wifi_auth_mode_tauth_mode){" + expected_switch + "}"
    assert normalized == expected_function, (
        "portal auth modes must remain open or WPA2/WPA3 Personal"
    )


def test_page_is_self_contained_and_uses_safe_dom_updates() -> None:
    page = without_html_comments(read_source("firmware/main/provisioning/portal_page.html"))
    assert 'id="manual-network"' in page, "page omits the manual-network control"
    assert 'id="manual-ssid"' in page, "page omits the hidden-network name field"
    assert 'id="manual-open" type="checkbox" disabled' in page
    assert "manualOpen.disabled = !manual.checked" in page
    assert 'manualOpen.addEventListener("change", updateConnectButton)' in page
    assert "? !manualOpen.checked" in page
    assert re.search(r"manual\.addEventListener\(\s*['\"]change['\"]", page)
    assert re.search(r"manualSsid\.disabled\s*=\s*!manual\.checked", page)
    assert re.search(r"input\.disabled\s*=\s*manual\.checked\s*\|\|", page)
    assert re.search(r"const\s+ssid\s*=\s*manual\.checked\s*\?\s*manualSsid\.value", page)
    assert re.search(r"fetch\(\s*['\"]/networks['\"]\s*\)", page)
    assert re.search(r"fetch\(\s*['\"]/connect['\"]\s*,", page)
    assert 'id="connect" type="submit" disabled' in page
    assert "input.dataset.secure = String(network.secure)" in page
    assert 'selected?.dataset.secure === "true"' in page
    assert 'password.addEventListener("input", updateConnectButton)' in page
    assert 'networks.addEventListener("change", updateConnectButton)' in page
    assert "button.disabled = !ssid || (needsPassword && !password.value)" in page
    assert "innerHTML" not in page, "page must not insert an SSID with innerHTML"
    assert re.search(r"name\.textContent\s*=\s*network\.ssid", page)
    assert re.search(r"input\.value\s*=\s*network\.ssid", page)
    assert not re.search(
        r"\b(?:action|background|cite|data|formaction|href|manifest|ping|poster|"
        r"src|srcset|xlink:href)\s*=",
        page,
        re.IGNORECASE,
    ), "portal page must not reference a separate resource"
    assert not re.search(
        r"@import\b|url\s*\(|<(?:iframe|object|embed)\b|"
        r"(?:fetch|import)\s*\(\s*['\"](?:https?:)?//|"
        r"\b(?:EventSource|WebSocket)\s*\(|"
        r"http-equiv\s*=\s*['\"]?refresh",
        page,
        re.IGNORECASE,
    ), "portal page must not load an external resource"
    assert len(re.findall(r"password\.value\s*=\s*['\"]{2}", page)) >= 2, (
        "page must clear the password after every submission"
    )


def test_startup_has_two_distinct_states() -> None:
    rec = without_c_comments(read_source("firmware/main/app_main.c"))
    header = without_c_comments(read_source("firmware/main/credentials.h"))
    main = function_body(rec, "app_main")
    startup = function_body(rec, "startup_task")
    assert "rec_credentials_load(&credentials)" in main
    assert_order(
        main,
        "rec_credentials_load(&credentials)",
        "rec_credentials_state(&credentials, &provision_state)",
        "rec_portal_prepare(&portal_configuration)",
    )
    for state in ("REC_PROVISION_NONE", "REC_PROVISION_COMPLETE"):
        assert state in rec, f"startup omits {state}"
        assert state in header, f"credential states omit {state}"
    assert "REC_PROVISION_WIFI_ONLY" not in rec
    assert "REC_PROVISION_WIFI_ONLY" not in header
    assert "create_portal_screen(&portal_configuration)" in main
    assert 'create_placeholder("Loading your records' in main
    assert "rec_portal_start(&portal_configuration)" in main
    assert "rec_portal_start" not in startup
    assert "rec_screenshot_start(display)" in main
    assert_order(main, "rec_screenshot_start(display)", "if (!provisioned) {")
    assert "rec_wifi_init()" in startup
    assert "rec_wifi_connect(configured_credentials)" in startup
    assert "rec_time_sync()" in startup
    assert "rec_slideshow_start()" in startup


def test_wifi_driver_uses_ram_only_storage() -> None:
    wifi = read_source("firmware/main/wifi.c")
    initialize = function_body(wifi, "initialize_services")
    assert_order(
        initialize,
        "esp_wifi_init(&initialization)",
        "esp_wifi_set_storage(WIFI_STORAGE_RAM)",
        "esp_event_handler_register(WIFI_EVENT",
    )
    assert "WIFI_STORAGE_FLASH" not in without_c_comments(wifi)


def test_portal_entropy_and_qr_are_prepared_before_wifi() -> None:
    portal = without_c_comments(read_source("firmware/main/provisioning/portal.c"))
    portal_header = without_c_comments(read_source("firmware/main/provisioning/portal.h"))
    prepare = function_body(portal, "rec_portal_prepare")
    alphabet = re.search(r'AP_PASSWORD_ALPHABET\[\] = "([A-Z0-9]+)"', portal)
    assert alphabet is not None
    assert alphabet.group(1) == "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    assert len(alphabet.group(1)) == 32 and len(set(alphabet.group(1))) == 32
    assert "REC_PORTAL_AP_PASSWORD_CAPACITY 11" in portal_header
    assert "index < REC_PORTAL_AP_PASSWORD_CAPACITY - 1" in prepare
    assert '"rec-setup-%02X%02X"' in prepare
    assert "mac_address[4]" in prepare and "mac_address[5]" in prepare
    assert_order(
        prepare,
        "bootloader_random_enable()",
        "esp_random() & 31",
        "bootloader_random_disable()",
    )
    assert '"WIFI:T:WPA;S:%s;P:%s;;"' in prepare
    app_main = function_body(read_source("firmware/main/app_main.c"), "app_main")
    assert_order(
        app_main,
        "rec_portal_prepare(&portal_configuration)",
        "xTaskCreatePinnedToCore(",
    )
    assert "rec_portal_prepare" not in function_body(
        read_source("firmware/main/app_main.c"), "startup_task"
    )


def test_dhcp_keeps_the_captive_portal_uri() -> None:
    portal = without_c_comments(read_source("firmware/main/provisioning/portal.c"))
    configure = function_body(portal, "configure_ap_network_interface")
    assert 'static char captive_portal_uri[] = "http://192.168.4.1/"' in portal
    assert_order(
        configure,
        "esp_netif_dhcps_stop(ap_network_interface)",
        "esp_netif_set_ip_info(ap_network_interface, &address)",
        "ESP_NETIF_CAPTIVEPORTAL_URI",
        "esp_netif_dhcps_start(ap_network_interface)",
    )
    assert 'ipaddr_addr("192.168.4.1")' in configure


def test_connect_request_parser_and_responses_are_bounded() -> None:
    portal = without_c_comments(read_source("firmware/main/provisioning/portal.c"))
    receive = function_body(portal, "receive_request_body")
    parse = function_body(portal, "parse_form")
    decode = function_body(portal, "decode_form_value")
    connect = function_body(portal, "connect_post")
    assert "REC_PORTAL_REQUEST_LIMIT 512" in portal
    assert "request->content_len > REC_PORTAL_REQUEST_LIMIT" in receive
    assert "has_ssid" in parse and "has_password" in parse
    assert 'memcmp(body + field_start, "ssid", 4)' in parse
    assert 'memcmp(body + field_start, "password", 8)' in parse
    assert "value == '%'" in decode
    assert "high < 0 || low < 0" in decode
    assert "value == 0" in decode
    assert "valid_utf8" in decode
    for status, response in (
        ("400 Bad Request", '{\\"ok\\":false,\\"error\\":\\"invalid request\\"}'),
        ("422 Unprocessable Entity", '{\\"ok\\":false,\\"error\\":\\"unsupported network\\"}'),
        ("504 Gateway Timeout", '{\\"ok\\":false,\\"error\\":\\"connection failed\\"}'),
        ("500 Internal Server Error", '{\\"ok\\":false,\\"error\\":\\"credentials not saved\\"}'),
        ("200 OK", '{\\"ok\\":true}'),
    ):
        assert f'"{status}"' in connect
        assert response in connect
    assert "mbedtls_platform_zeroize(raw_body, sizeof(raw_body))" in connect
    assert "mbedtls_platform_zeroize(password, sizeof(password))" in connect
    assert "mbedtls_platform_zeroize(&candidate, sizeof(candidate))" in connect
    assert 'ESP_LOGW(TAG, "WiFi join failed: %s", esp_err_to_name(error))' in connect
    assert "WiFi join failed for SSID" not in connect
    assert_order(
        connect,
        "rec_wifi_connect_bounded(&candidate)",
        "rec_credentials_store_wifi(ssid, password)",
    )


def test_dns_parser_rejects_malformed_questions() -> None:
    dns = read_source("firmware/main/provisioning/dns_hijack.c")
    parser = function_body(dns, "build_response")
    assert "request_length < 12" in parser
    assert "request_length > DNS_MAX_PACKET_SIZE" in parser
    assert "read_u16(request + 4) != 1" in parser
    assert "(label_length & 0xC0) != 0" in parser
    assert "label_length > 63" in parser
    assert "offset + label_length > request_length" in parser
    assert "name_length + label_length + 1 > 254" in parser
    assert "offset + 4 != request_length" in parser
    assert "read_u16(request + offset) != 1" in parser
    assert "read_u16(request + offset + 2) != 1" in parser
    assert "response[offset++] = 192" in parser
    assert "response[offset++] = 168" in parser
    assert "response[offset++] = 4" in parser
    assert "response[offset++] = 1" in parser


def test_passwords_cannot_reach_logs_or_responses() -> None:
    firmware_sources = "\n".join(
        without_c_comments(path.read_text(encoding="utf-8"))
        for path in sorted((ROOT / "firmware/main").rglob("*.c"))
    )
    for log_call in re.findall(r"ESP_LOG[A-Z]+\s*\([^;]*\);", firmware_sources, re.DOTALL):
        assert not re.search(
            r"\b[a-z_]*password[a-z_]*\b|\bwifi_pass\b",
            log_call,
            re.IGNORECASE,
        ), "a target-WiFi password variable reaches a firmware log call"
    portal_source = read_source("firmware/main/provisioning/portal.c")
    portal = function_body(portal_source, "connect_post")
    response_values = re.findall(r"\bresponse\s*=\s*([^;]+);", portal)
    assert response_values
    for value in response_values:
        assert re.fullmatch(r'"(?:\\.|[^"\\])*"', value.strip()), (
            "connect_post responses must remain fixed string literals"
        )
        assert "password" not in value.lower(), "a password reaches an HTTP response"
    assert not re.search(r"\bhttpd_resp_[a-z_]+\s*\(", portal), (
        "connect_post must send responses only through send_json"
    )
    send_calls = re.findall(r"\bsend_json\s*\([^;]*\);", portal, re.DOTALL)
    assert [re.sub(r"\s+", "", call) for call in send_calls] == [
        "send_json(request,status,response);"
    ]
    send_json_body = function_body(portal_source, "send_json")
    assert "password" not in send_json_body.lower()


def main() -> int:
    test_portal_owns_no_nvs_storage()
    test_build_registers_the_complete_portal()
    test_captive_routes_redirect_to_root()
    test_supported_auth_modes_keep_personal_boundary()
    test_page_is_self_contained_and_uses_safe_dom_updates()
    test_startup_has_two_distinct_states()
    test_wifi_driver_uses_ram_only_storage()
    test_portal_entropy_and_qr_are_prepared_before_wifi()
    test_dhcp_keeps_the_captive_portal_uri()
    test_connect_request_parser_and_responses_are_bounded()
    test_dns_parser_rejects_malformed_questions()
    test_passwords_cannot_reach_logs_or_responses()
    print("Captive portal safeguards passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
