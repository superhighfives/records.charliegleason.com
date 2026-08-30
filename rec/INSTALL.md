# Install the starter

Use this procedure with a Waveshare ESP32-S3 Touch AMOLED 1.8 board and a USB data cable.

The hardware procedure is tested on macOS. CI builds the firmware on Linux. Windows host tools are not hardware-tested.

## Install the tools

1. Install Git.
2. Install [mise](https://mise.jdx.dev/).
3. Clone this repository.
4. Enter the repository directory.
5. Run `mise install`.

`mise install` installs the pinned Python, esptool, Ruff, gitleaks, CMake, and Ninja versions. It also installs ESP-IDF 5.5.5.

Set `REC_IDF_PATH` to use a different ESP-IDF directory. Set `REC_SKIP_IDF=1` only when no firmware build is necessary.

## Flash and configure WiFi

1. Connect the board with a USB data cable.
2. Run `mise run flash` without `--force`.
3. Wait for the setup screen.
4. Scan the QR code on the screen.
5. Join the `rec-setup-XXXX` network that the screen shows.
6. Select your WiFi network in the captive portal.
7. Enter the WiFi password.
8. Submit the form.

The first flash takes a credential-free factory backup. Keep `backups/factory.bin` and its SHA-256 file together.

The portal writes WiFi values only after the board gets an IP address. Then the board restarts and opens the demo screen.

CAUTION: Do not use `mise run flash -- --force` for the first flash. This command takes no factory backup.

No flag permits a backup from a provisioned board. The backup tool reads the 24 KB NVS region before it reads all flash.

If a valid backup exists, the backup task checks it and does not read the board. If the backup is invalid, move it from `backups/`.

## Use USB provisioning instead

Use this fallback when the captive portal is not available:

1. Connect the board with a USB data cable.
2. Run `mise run provision`.
3. Enter the WiFi network name.
4. Enter the WiFi password.

The command creates a temporary 24 KB NVS image. It writes this image at offset `0x9000` and then removes the temporary files.

The command writes only `wifi_ssid` and `wifi_pass`. The NVS namespace is `rec` until you rename the starter.

## Select a USB port

The host tools select one connected Espressif USB serial port.

If more than one board is connected, set `REC_PORT` to the correct USB port. Do not set it to a network address.

Example:

```console
REC_PORT=/dev/cu.usbmodem101 mise run monitor
```

## Update the firmware

1. Pull the source changes.
2. Run `mise install`.
3. Run `mise run flash`.

The flash task checks the existing factory backup before it writes firmware.

A backup after credential removal contains the current firmware. It does not restore the shipped board image.

## Erase credentials

1. Connect the board with a USB data cable.
2. Run `mise run deprovision`.
3. Read the shown USB port and MAC address.
4. Type `ERASE`, followed by the shown MAC address.

The command checks the board identity and partition table. Then it erases NVS, reads NVS again, and resets the board.

The board starts the captive portal after the reset.

## Restore the factory image

`mise run restore` writes `backups/factory.bin` to the device. The image must meet these conditions:

- The image size is 16 MB.
- The SHA-256 value matches `factory.bin.sha256`.
- The NVS region contains no starter credential key.

CAUTION: A restore overwrites all flash contents. You cannot undo this operation.

1. If the firmware starts, run `mise run deprovision`.
2. Connect the board with a USB data cable.
3. Run `mise run restore`.
4. Read the image path, USB port, and MAC address.
5. Type `RESTORE`, followed by the shown MAC address.

The restore tool checks the image digest and board MAC again after approval. It starts the write only when both checks pass.

If the write stops after it starts, do not use the board. Run `mise run restore` again.

## Enter download mode

Use this procedure when automatic reset does not work:

1. Disconnect the USB cable.
2. Press and hold the BOOT button.
3. Connect the USB cable.
4. Release the BOOT button.
5. Run the required USB command again.

## Build without hardware

Run these commands without a connected board:

```console
mise run test-host
mise run format-check
mise run lint
mise run licenses
mise run secrets
mise run build
```

The firmware has no host build and no emulator. A firmware compile does not replace a hardware test.

Read [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) when a command stops.
