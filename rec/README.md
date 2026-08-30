# ESP32-S3 Touch AMOLED 1.8 starter

This repository is a source starter for the Waveshare ESP32-S3 Touch AMOLED 1.8 board.

The firmware uses ESP-IDF 5.5.5 and the Waveshare board support package. It includes these features:

- A 368 by 448 LVGL display with touch input.
- Warm-reset recovery for the AMOLED panel.
- A captive portal for WiFi setup.
- A WiFi-only USB provisioning fallback.
- An AXP2101 power monitor.
- A USB screenshot channel.
- A demo screen that shows WiFi state and free heap.
- Host tools for safe flash backup, restore, and credential removal.

The demo cycles display brightness between 85 percent and 40 percent when you tap the screen.

## Requirements

You need these items:

- A Waveshare ESP32-S3 Touch AMOLED 1.8 board.
- A USB data cable.
- A macOS, Linux, or Windows host computer.
- Git and [mise](https://mise.jdx.dev/).
- A WiFi network.

CI builds the firmware on Linux. The hardware procedure is tested on macOS.

## Quick start

1. Clone this repository.
2. Enter the repository directory.
3. Connect the board with a USB data cable.
4. Run `mise install`.
5. Run `mise run flash` without `--force`.
6. Scan the QR code on the screen.
7. Join the `rec-setup-XXXX` network that the screen shows.
8. Select your WiFi network in the captive portal.
9. Enter the WiFi password.
10. Submit the form.

The first flash stores a credential-free factory backup in `backups/`.

CAUTION: Do not use `mise run flash -- --force` for the first flash. This command takes no factory backup.

The board saves WiFi values only after it gets an IP address. Then the board restarts and opens the demo screen.

Read [INSTALL.md](INSTALL.md) for the full installation and recovery procedures.

## First-time WiFi setup

The setup screen shows a temporary network name, password, and QR code. The network password changes after each restart.

The captive portal supports these network types:

- Open networks.
- WPA2-Personal networks.
- WPA3-Personal networks.

The portal marks WEP and enterprise networks as unsupported. It does not send the WiFi password to a log or response.

If the phone does not open the portal, go to <http://192.168.4.1/>. Keep the phone connected when it reports no internet.

### USB fallback

If you cannot use the captive portal, write the WiFi values through USB:

1. Keep the board connected through USB.
2. Run `mise run provision`.
3. Enter the WiFi network name.
4. Enter the WiFi password.

The command writes only `wifi_ssid` and `wifi_pass` to the NVS partition. It does not read credential values from the board.

`provision` depends on `backup`. Thus, the command cannot overwrite the last chance to save a credential-free factory image.

## Screen capture

Close the serial monitor before a capture. Then run:

```console
mise run screenshot -- screen.png
```

The command saves a 368 by 448 PNG file. It refuses to replace an existing file.

## Rename the starter

The placeholder product name is `rec`. Choose a product name before you add product code.

The name must contain one through three lowercase ASCII letters (`a` through `z`). This limit keeps the setup network name in its buffer.

If you use a longer name, increase `REC_PORTAL_AP_NAME_CAPACITY` in `firmware/main/provisioning/portal.h` by one byte for each additional letter. Then run `mise run build`.

ESP-IDF requires the exact `app_main` entry-point name. Never rename this function or its references.

The source file can have a new name. If you rename the file, update `firmware/main/CMakeLists.txt`.

The `rec` value in the second field of the `factory` row in `firmware/partitions.csv` is an ESP-IDF partition type. Never rename it.

The product placeholder appears in these forms:

- Standalone lowercase `rec` product text and literal values.
- `rec_` for public firmware functions and file names.
- `REC_` for capacity macros and environment variables.
- `Rec` for product text that starts with an uppercase letter.
- `project(rec)` for the ESP-IDF project.
- `rec-setup-` for setup network names.
- `rec-provision-` for temporary directory names.
- `.rec-install-version` for the toolchain marker file.
- `"rec"` for the NVS namespace and other exact literal values.

Run these commands to list the placeholder locations and file names:

```console
git grep -n -w 'rec'
git grep -n 'rec_'
git grep -n 'REC_'
git grep -n -w 'Rec'
git grep -n 'project(rec)'
git grep -n 'rec-setup-'
git grep -n 'rec-provision-'
git grep -n '.rec-install-version'
git grep -n '"rec"'
git ls-files | grep -E 'rec_|REC_|rec-setup-|rec-provision-|\.rec-install-version'
```

The first search includes the reserved partition type. The `rec_` searches include the exact `app_main` name.

Rename all other placeholder forms. Rename one form at a time.

Keep the firmware and host names equal. Update references when you rename a file.

Renamed Python imports can have a different sort order. Let Ruff sort the imports before Ruff formats the files.

After the rename, run these commands:

```console
ruff check --fix .
mise run format
mise run build
mise run test-host
mise run format-check
mise run lint
mise run licenses
mise run secrets

python - <<'PY'
from pathlib import Path
import os
import re
import subprocess

entry_point = re.compile(r"(?<![A-Za-z0-9_])app_main(?![A-Za-z0-9_])")
placeholder = re.compile(
    r"(?<![A-Za-z0-9_])(?:rec|Rec)(?![A-Za-z0-9_])|rec_|REC_"
)
definition = re.compile(r"^void[ \t]+app_main\(void\)[ \t]*$")

result = subprocess.run(
    ["git", "ls-files", "-z"],
    check=True,
    stdout=subprocess.PIPE,
)
paths = [os.fsdecode(value) for value in result.stdout.split(b"\0") if value]

factory_rows = []
definitions = []
violations = []

for path in paths:
    masked_path = entry_point.sub("", path)
    if placeholder.search(masked_path):
        violations.append(path)

    if path == "README.md":
        continue

    data = Path(path).read_bytes()
    if b"\0" in data:
        continue

    for line_number, line in enumerate(data.decode("utf-8").splitlines(), 1):
        masked_line = entry_point.sub("", line)

        if definition.fullmatch(line):
            definitions.append(f"{path}:{line_number}")

        if path == "firmware/partitions.csv" and not line.lstrip().startswith("#"):
            fields = [field.strip() for field in line.split(",")]
            if fields and fields[0] == "factory":
                factory_rows.append((line_number, tuple(fields)))
                if len(fields) > 1 and fields[1] == "rec":
                    fields[1] = "ESP_IDF_PARTITION_TYPE"
                    masked_line = ",".join(fields)

        if placeholder.search(masked_line):
            violations.append(f"{path}:{line_number}:{line}")

if len(factory_rows) != 1 or len(factory_rows[0][1]) < 2:
    raise SystemExit("firmware/partitions.csv must contain one factory row")
if factory_rows[0][1][1] != "rec":
    raise SystemExit("The factory partition type must stay rec")
if len(definitions) != 1:
    raise SystemExit("The firmware must contain one exact app_main definition")
if violations:
    print("Rename these remaining placeholder forms:")
    print(*violations, sep="\n")
    raise SystemExit(1)
PY
```

The final search permits only the reserved `rec` partition type and the exact `app_main` name. It validates both exceptions.

References in tests and documents can keep the exact `app_main` name. These references name the required ESP-IDF entry point.

The NVS namespace has two matching definitions:

- `REC_NVS_NAMESPACE` in `firmware/main/credentials.c`.
- `NVS_NAMESPACE` in `tools/provision.py`.

The device identity check in `tools/deprovision.py` also contains the ESP-IDF project name.

## Documents

- [INSTALL.md](INSTALL.md) gives installation, update, credential-removal, and factory-recovery procedures.
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) gives recovery steps for common board and tool problems.
- [CLAUDE.md](CLAUDE.md) records the board rules, module map, safety gates, and project conventions.

## License

Project code uses the Apache License 2.0. Read [LICENSE](LICENSE).
