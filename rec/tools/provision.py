#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Mark Phelps
# SPDX-License-Identifier: Apache-2.0

"""Write WiFi credentials to the device NVS partition through USB."""

from __future__ import annotations

import csv
from getpass import getpass
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile

from deprovision import inspect_device

NVS_OFFSET = "0x9000"
NVS_SIZE = "0x6000"
# The firmware opens this namespace in firmware/main/credentials.c
# (REC_NVS_NAMESPACE). A change to one side without the other leaves a
# provisioned board reading an empty namespace and showing the provisioning
# screen. test_provision.py holds the two sides together.
NVS_NAMESPACE = "rec"


def project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def command_output(command: list[str]) -> str:
    try:
        return subprocess.check_output(command, text=True, stderr=subprocess.DEVNULL).strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def mac_wifi_interfaces() -> list[str]:
    output = command_output(["networksetup", "-listallhardwareports"])
    interfaces: list[str] = []
    wifi_port = False
    for line in output.splitlines():
        if line.startswith("Hardware Port:"):
            wifi_port = line.partition(":")[2].strip() in {"Wi-Fi", "AirPort"}
        elif wifi_port and line.startswith("Device:"):
            interfaces.append(line.partition(":")[2].strip())
    return interfaces


def current_ssid() -> str:
    system = platform.system()
    if system == "Darwin":
        prefix = "Current Wi-Fi Network: "
        for interface in mac_wifi_interfaces():
            output = command_output(["networksetup", "-getairportnetwork", interface])
            if output.startswith(prefix):
                return output[len(prefix) :]
        return ""
    if system == "Linux":
        output = command_output(["nmcli", "-t", "-f", "ACTIVE,SSID", "device", "wifi"])
        for line in output.splitlines():
            if line.startswith("yes:"):
                return line.split(":", 1)[1].replace(r"\:", ":")
    if system == "Windows":
        output = command_output(["netsh", "wlan", "show", "interfaces"])
        for line in output.splitlines():
            key, separator, value = line.partition(":")
            if separator and key.strip() == "SSID":
                return value.strip()
    return ""


def prompt_value(label: str, default: str = "", *, secret: bool = False) -> str:
    suffix = f" [{default}]" if default else ""
    value = getpass(f"{label}{suffix}: ") if secret else input(f"{label}{suffix}: ").strip()
    return value or default


def make_sure_value_fits(
    label: str, value: str, maximum_bytes: int, *, allow_empty: bool = False
) -> None:
    length = len(value.encode("utf-8"))
    if (not allow_empty and length == 0) or length > maximum_bytes:
        raise ValueError(f"{label} must contain 1 to {maximum_bytes} UTF-8 bytes")


def write_nvs_csv(path: Path, ssid: str, password: str) -> None:
    with path.open("w", newline="", encoding="utf-8") as output:
        writer = csv.writer(output)
        writer.writerow(["key", "type", "encoding", "value"])
        writer.writerow([NVS_NAMESPACE, "namespace", "", ""])
        writer.writerow(["wifi_ssid", "data", "string", ssid])
        writer.writerow(["wifi_pass", "data", "string", password])
    path.chmod(0o600)


def idf_path() -> Path:
    configured = os.environ.get("REC_IDF_PATH")
    return Path(configured).expanduser() if configured else Path.home() / ".local/share/esp-idf"


def generate_nvs(csv_path: Path, image_path: Path) -> None:
    root = idf_path()
    generator = root / "components/nvs_flash/nvs_partition_generator/nvs_partition_gen.py"
    arguments = [str(generator), "generate", str(csv_path), str(image_path), NVS_SIZE]
    if os.name == "nt":
        command = (
            f'call "{root / "export.bat"}" >nul && python {subprocess.list2cmdline(arguments)}'
        )
        subprocess.run(["cmd.exe", "/d", "/s", "/c", command], check=True)
    else:
        script = '. "$1" >/dev/null && shift && exec python "$@"'
        subprocess.run(
            ["bash", "-c", script, "idf-wrapper", str(root / "export.sh"), *arguments], check=True
        )
    image_path.chmod(0o600)
    expected_size = int(NVS_SIZE, 0)
    if image_path.stat().st_size != expected_size:
        raise RuntimeError(f"NVS image must be exactly {expected_size} bytes")


def detect_port() -> str:
    result = subprocess.run(
        [sys.executable, str(project_root() / "tools/detect_port.py")],
        check=True,
        text=True,
        capture_output=True,
    )
    return result.stdout.strip()


def flash_nvs(image_path: Path) -> None:
    esptool = shutil.which("esptool") or shutil.which("esptool.py")
    if esptool is None:
        raise RuntimeError("esptool is unavailable. Run `mise install` first")
    identity = inspect_device(detect_port())
    subprocess.run(
        [
            esptool,
            "--chip",
            "esp32s3",
            "--port",
            identity.port,
            "--after",
            "hard-reset",
            "write-flash",
            NVS_OFFSET,
            str(image_path),
        ],
        check=True,
    )


def main() -> int:
    try:
        ssid = prompt_value("WiFi SSID", os.environ.get("REC_WIFI_SSID", current_ssid()))
        password = prompt_value("WiFi password (input is hidden)", secret=True)
        make_sure_value_fits("WiFi SSID", ssid, 32)
        make_sure_value_fits("WiFi password", password, 64, allow_empty=True)

        with tempfile.TemporaryDirectory(prefix="rec-provision-") as directory:
            temporary = Path(directory)
            csv_path = temporary / "credentials.csv"
            image_path = temporary / "nvs.bin"
            write_nvs_csv(csv_path, ssid, password)
            generate_nvs(csv_path, image_path)
            flash_nvs(image_path)
        print("Provisioning is complete. The device restarted.")
    except (EOFError, OSError, RuntimeError, ValueError, subprocess.CalledProcessError) as error:
        print(f"provisioning failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("Canceled.", file=sys.stderr)
        raise SystemExit(130)
