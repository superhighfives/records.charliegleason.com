#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Mark Phelps
# SPDX-License-Identifier: Apache-2.0

"""Verify WiFi-only USB provisioning without a connected board."""

from __future__ import annotations

import csv
from pathlib import Path
import tempfile
from typing import cast
from unittest.mock import Mock, patch

import provision

ROOT = Path(__file__).resolve().parent.parent


def test_namespace_matches_firmware() -> None:
    source = (ROOT / "firmware/main/credentials.c").read_text(encoding="utf-8")
    assert f'#define REC_NVS_NAMESPACE "{provision.NVS_NAMESPACE}"' in source
    assert provision.NVS_NAMESPACE == "rec"


def test_csv_contains_only_wifi_credentials() -> None:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "credentials.csv"
        provision.write_nvs_csv(path, "Home, WiFi", "secret")
        with path.open(newline="", encoding="utf-8") as source:
            rows = list(csv.reader(source))
        assert rows == [
            ["key", "type", "encoding", "value"],
            ["rec", "namespace", "", ""],
            ["wifi_ssid", "data", "string", "Home, WiFi"],
            ["wifi_pass", "data", "string", "secret"],
        ]
        assert path.stat().st_mode & 0o777 == 0o600


def test_credential_key_lists_stay_coupled() -> None:
    device_source = (ROOT / "tools/device.py").read_text(encoding="utf-8")
    credential_source = (ROOT / "firmware/main/credentials.c").read_text(encoding="utf-8")
    assert 'CREDENTIAL_KEYS = ("wifi_ssid", "wifi_pass")' in device_source
    assert 'static const char *WIFI_SSID_KEY = "wifi_ssid";' in credential_source
    assert 'static const char *WIFI_PASSWORD_KEY = "wifi_pass";' in credential_source
    for forbidden in ("client_id", "refresh_tok"):
        assert forbidden not in credential_source
        assert forbidden not in device_source


def test_value_limits_use_utf8_bytes() -> None:
    provision.make_sure_value_fits("WiFi SSID", "x" * 32, 32)
    provision.make_sure_value_fits("WiFi password", "", 64, allow_empty=True)
    for value in ("", "é" * 17):
        try:
            provision.make_sure_value_fits("WiFi SSID", value, 32)
        except ValueError:
            pass
        else:
            raise AssertionError(f"accepted invalid WiFi SSID: {value!r}")


def test_nvs_generator_uses_the_pinned_partition_size() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        csv_path = root / "credentials.csv"
        image_path = root / "nvs.bin"
        image_path.write_bytes(b"\xff" * int(provision.NVS_SIZE, 0))
        runner = Mock()
        with (
            patch.object(provision, "idf_path", return_value=root / "idf"),
            patch.object(provision.subprocess, "run", runner),
            patch.object(provision.os, "name", "posix"),
        ):
            provision.generate_nvs(csv_path, image_path)
        command = runner.call_args.args[0]
        assert (
            str(root / "idf/components/nvs_flash/nvs_partition_generator/nvs_partition_gen.py")
            in command
        )
        assert command[-4:] == ["generate", str(csv_path), str(image_path), "0x6000"]
        assert runner.call_args.kwargs["check"] is True
        assert image_path.stat().st_mode & 0o777 == 0o600


def test_main_writes_generates_then_flashes() -> None:
    events: list[tuple[str, object]] = []

    def write_csv(path: Path, ssid: str, password: str) -> None:
        events.append(("write", (path.name, ssid, password)))

    def generate(csv_path: Path, image_path: Path) -> None:
        events.append(("generate", (csv_path.name, image_path.name)))

    def flash(image_path: Path) -> None:
        events.append(("flash", image_path.name))

    with (
        patch.object(provision, "current_ssid", return_value="Current"),
        patch.object(provision, "prompt_value", side_effect=["Network", "password"]),
        patch.object(provision, "write_nvs_csv", side_effect=write_csv),
        patch.object(provision, "generate_nvs", side_effect=generate),
        patch.object(provision, "flash_nvs", side_effect=flash),
    ):
        assert provision.main() == 0
    assert [event[0] for event in events] == ["write", "generate", "flash"]
    write_event = cast(tuple[str, str, str], events[0][1])
    assert write_event[1:] == ("Network", "password")


def main() -> int:
    test_namespace_matches_firmware()
    test_csv_contains_only_wifi_credentials()
    test_credential_key_lists_stay_coupled()
    test_value_limits_use_utf8_bytes()
    test_nvs_generator_uses_the_pinned_partition_size()
    test_main_writes_generates_then_flashes()
    print("WiFi provisioning checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
