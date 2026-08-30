# AGENTS

This file gives instructions to coding agents that work in this directory.

## What this directory contains

This directory (`rec/`, inside the `records.charliegleason.com` repo) is the
firmware for the `rec` ESP32-S3 board — a record-collection slideshow that
reads the site's own public `/api/records` — built on a starter for the
Waveshare ESP32-S3 Touch AMOLED 1.8 board. Run every command below from
inside `rec/`, not the repo root — `mise` scopes to the nearest `mise.toml`,
which lives here.

This directory has two main parts:

- `firmware/` contains C firmware for ESP-IDF 5.5.5.
- `tools/` contains standard-library Python host tools and plain script checks.

The placeholder name is `rec`. Keep one name through every layer:

- The ESP-IDF project is `rec`.
- Public firmware functions use the `rec_` prefix.
- Capacity macros and environment variables use the `REC_` prefix.
- The NVS namespace is `rec`.
- The setup network uses `rec-setup-XXXX`.

Read the rename procedure in `README.md` before you add product code.

## Commands

```console
mise install
mise run build
mise run build-perf
mise run backup
mise run restore
mise run provision
mise run deprovision
mise run flash
mise run flash -- --force
mise run monitor
mise run screenshot -- screen.png
mise run test-host
mise run format
mise run format-check
mise run lint
mise run licenses
mise run secrets
```

Use `mise run flash` for the normal flash procedure. This command takes or checks a factory backup first.

CAUTION: `mise run flash -- --force` takes no backup. Use it only when recovery without a factory image is permitted.

Run one host check with a command such as `python tools/test_provision.py`. Each check has a `main()` function and bare assertions.

The host checks do not use pytest or third-party test packages.

The performance build uses `firmware/build-perf`. `REC_PERF_MONITOR=1` adds `sdkconfig.perf.defaults` to that build.

Set `REC_PORT` when more than one Espressif board is connected. Set `REC_IDF_PATH` to use a different ESP-IDF checkout.

`REC_SKIP_IDF=1` skips the ESP-IDF install hook. In this mode, no firmware build is possible.

## Continuous integration

`../.github/workflows/rec-ci.yml` (at the repo root — GitHub only reads
workflows from there) contains five jobs, path-filtered to only run when
`rec/**` changes:

- `firmware`.
- `host-tools`.
- `python-style`.
- `secrets`.
- `licenses`.

The host jobs run the matching local mise tasks. The firmware job uses the official ESP-IDF container.

Keep the container release equal to `IDF_TAG` in `tools/setup_idf.py`. No automated check holds these two values together.

Keep all action revisions pinned to commit SHAs. Keep the ESP-IDF container pinned to an image digest.

## Firmware startup

`app_main` starts the display, screenshot state, and power monitor before it reads credentials.

The firmware has two startup states:

- No WiFi credentials starts the setup screen and captive portal.
- Saved WiFi credentials start the demo UI, WiFi connection, and time synchronization.

The demo UI runs a 250 ms LVGL timer on core 1. The startup task runs WiFi and time work on core 0.

The UI timer reads WiFi status and free heap. A screen tap cycles brightness between 85 percent and 40 percent.

The AXP2101 power monitor uses an unpinned task. FreeRTOS can run this task on either core.

## Board-layer rules

These four rules protect the board behavior. Do not weaken or remove them.

1. Every LVGL call outside the LVGL task must hold `bsp_display_lock` or `lvgl_port_lock`. An LVGL timer or callback must not lock again.
2. `flush_display` must send a QSPI NOP after each color transfer.
3. `start_display` must call `recover_display_panel` before `lvgl_port_add_disp`.
4. `round_display_area` must align each invalidated area to even pixels.

The QSPI parameter transfer waits for DMA before LVGL reuses the display buffer.

The panel recovery order is display off, delay, reset, initialize, and display on.

The panel requires even-pixel alignment.

## Provisioning module map

`firmware/main/provisioning/portal.c` owns these functions:

- Setup-network preparation.
- Network scanning.
- HTTP routes and request parsing.
- The embedded phone page.
- A bounded connection attempt before credential storage.

`firmware/main/provisioning/dns_hijack.c` owns the bounded DNS parser and responder.

`firmware/main/wifi.c` owns shared ESP-IDF services, network interfaces, WiFi driver state, and event handlers.

`firmware/main/credentials.c` is the only firmware module that writes WiFi credentials.

The portal calls `rec_credentials_store_wifi` only after the station gets an IP address.

The portal must not call NVS APIs or name NVS keys. Keep that single-writer boundary.

The portal supports open, WPA2-Personal, and WPA3-Personal networks. It must reject WEP and enterprise networks.

The setup page must stay self-contained. Do not load scripts, styles, images, or fonts from a network.

The page must put scanned network names into the DOM with `textContent`. Do not use `innerHTML` for network data.

## Credential-key coupling

The two NVS keys are `wifi_ssid` and `wifi_pass`.

The key list has three coupled locations:

- `firmware/main/credentials.c` defines the firmware keys and `REC_NVS_NAMESPACE`.
- `tools/device.py` defines `CREDENTIAL_KEYS` for backup and restore safety.
- `tools/provision.py` writes the CSV rows and defines `NVS_NAMESPACE`.

If you change a credential key, change all three locations in one commit. Then update the matching host checks.

The namespace values in `credentials.c` and `provision.py` must stay equal.

Do not log a WiFi password. A portal success log can name the saved SSID.

Host tools must not print WiFi values. They can print public credential-key names.

Clear firmware password buffers with `mbedtls_platform_zeroize` before the function returns.

## Screenshot protocol

The firmware mirrors each completed display rectangle into PSRAM. The USB task sends a full image with a header and CRC.

The firmware and host tool use the `SNAP` marker. Change `firmware/main/screenshot.c` and `tools/screenshot.py` together.

`tools/screenshot.py` pins `WIDTH = 368` and `HEIGHT = 448`.

The screenshot task starts even when the mirror allocation fails. In this state, the task can still return an error frame.

`rec_screenshot_start` must refuse a missing mutex. Every response path takes both mutexes.

## Host safety gates

The safety gates are part of the design. Do not weaken a gate to make another task easier.

- `backup_flash.py` reads the 24 KB NVS region before a full-flash read.
- A provisioned device must not produce a full-flash backup.
- `provision` depends on `backup` in `mise.toml`.
- `flash` and `flash-perf` run `tools/flash.py`.
- `mise run flash -- --force` skips the backup and prints one warning line.
- The forced path must not enter `backup_flash.py`.
- `restore.py` checks image size, digest, and credential-free NVS before approval.
- `WRITE_VERIFIED_FLASH_COMMAND` checks the digest and device MAC again after approval.
- `deprovision.py` needs typed MAC approval, erases NVS, and reads NVS again.
- `leak_scan.py` scans tracked files and the full Git history.

Skipping a backup is not taking a backup. No flag can make a provisioned device produce one.

The esptool helpers in `tools/device.py` run under the esptool interpreter. Read their comments before you edit an inline command.

Do not change the esptool call structure without a focused safety check.

## Conventions

C code uses full words for identifiers. Use `static` for declarations that do not belong in a header.

Public firmware functions use the `rec_` prefix. Capacity macros use the `REC_` prefix.

Functions that return `esp_err_t` use an `error` variable. Comments explain why the code exists.

Python code uses `from __future__ import annotations` and the standard library only.

Runtime errors must name the correction. Module-level Ctrl+C handlers use exit code 130.

Ruff owns Python formatting and lint rules. Run `mise run format` before you commit Python changes.

Some host checks read source text and depend on function order. Read a failed assertion before you change code or a check.

Every new file needs an SPDX header or an exact path in `REUSE.toml`. Run `mise run licenses` after you add a file.
