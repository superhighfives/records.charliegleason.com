# Troubleshooting

Read [INSTALL.md](../INSTALL.md) for the installation and factory-restore procedures.

## A USB command cannot find the board

1. Connect the board with a USB data cable.
2. Run `mise install`.
3. Disconnect other Espressif boards.
4. Run the command again.

If more than one board is connected, set `REC_PORT` to the correct USB port. Do not use a network address.

If the problem continues, use a different USB data cable or USB port. A charge-only cable cannot transfer data.

## The board does not enter download mode

1. Disconnect the USB cable.
2. Press and hold the BOOT button.
3. Connect the USB cable.
4. Release the BOOT button.
5. Run the USB command again.

Use this procedure when automatic reset does not work.

## The captive portal does not open

1. Scan the QR code on the setup screen.
2. Join the `rec-setup-XXXX` network that the screen shows.
3. If the page does not open, go to <http://192.168.4.1/>.
4. If the phone reports no internet, keep the phone connected.

The setup network uses a new password after each restart. Use the values on the current screen.

## The captive portal reports a connection failure

The portal stays available after a failed connection. It also clears the password field.

1. Select the network again.
2. Enter the WiFi password again.
3. Submit the form.

For a hidden network, select manual entry and enter the network name. The portal saves values only after the board gets an IP address.

## The captive portal marks a network as unsupported

The portal supports open, WPA2-Personal, and WPA3-Personal networks. It marks WEP and enterprise networks as unsupported.

Use a supported guest network or change the access-point security mode. Do not enter enterprise credentials through manual entry.

## USB provisioning fails

1. Close `mise run monitor`.
2. Make sure that the board uses a USB data cable.
3. Run `mise install`.
4. Run `mise run provision` again.

The command needs esptool and the ESP-IDF NVS generator. It writes a temporary 24 KB image to the NVS partition.

If the backup task refuses the board, the board already contains credentials. Run `mise run deprovision` before you try USB provisioning again.

## The board shows `offline`

The board cannot connect to the saved WiFi network. It reconnects when the network becomes available.

1. Make sure that the WiFi network is available.
2. Make sure that the saved network name and password are correct.
3. If the values are wrong, run `mise run deprovision`.
4. Configure WiFi with the captive portal or `mise run provision`.

## Time synchronization does not finish

The board synchronizes time with `pool.ntp.org` after it connects to WiFi.

1. Make sure that the WiFi connection works.
2. Make sure that the network can connect to `pool.ntp.org`.
3. Restart the board.
4. If the problem continues, read the serial log.

## The display is blank

1. Disconnect and reconnect USB power.
2. If the display stays blank, enter download mode.
3. Run `mise run flash`.

The flash task tries to take or check the factory backup before it writes.

If the board holds credentials and no valid backup exists, the flash task stops. `mise run flash -- --force` skips the backup.

CAUTION: `mise run flash -- --force` takes no factory backup. Without a valid backup, you cannot restore the shipped board image.

## A screenshot command fails

1. Stop `mise run monitor` with Ctrl+C.
2. Make sure that the output file does not exist.
3. Run `mise run screenshot -- screen.png` again.

The monitor and screenshot commands cannot own the USB serial port at the same time.

The screenshot host and firmware code use the `SNAP` frame marker. Change both sides together if you change this protocol.

## Read the serial log

1. Connect the board with a USB data cable.
2. Run `mise run monitor`.
3. Reproduce the problem.
4. Press Ctrl+C to stop the monitor.

The log can show WiFi, time, power, heap, and display messages. Do not share WiFi passwords or flash images.

## Restore stops after writing starts

Do not use the board after an incomplete write. Run `mise run restore` again with the same checked factory image.

The restore command uses exit code 2 when the flash can be incomplete. Other refused operations use exit code 1.

CAUTION: A restore overwrites all flash contents. You cannot undo this action.

## Related documents

- [README.md](../README.md) gives the feature summary and rename procedure.
- [INSTALL.md](../INSTALL.md) gives installation and recovery procedures.
- [CLAUDE.md](../CLAUDE.md) gives the architecture, board rules, and safety gates.
