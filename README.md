# avantis-tally

Electron app that connects to an Allen & Heath Avantis console over TCP/IP MIDI and drives tally devices over WebSocket.

## Implemented behavior

- Connects to Avantis over TCP/IP MIDI (`51325` by default)
- Parses Avantis protocol for live channel state:
  - Fader level from NRPN parameter `17`
  - Mute from `Note On` velocity (`01-3F` = mute off, `40-7F` = mute on)
  - Channel mapping derived from base MIDI channel `N`
- Hosts a WebSocket server for tally devices on port `19188`
- Identifies tally devices by MAC address when available
- Maps each tally light to:
  - a connected tally device
  - a selected Avantis channel type + channel number
  - an active threshold percentage
- Sends tally output updates to devices:
  - JSON state payload (`tally-state`)
  - simple text command (`ON` / `OFF`)

## Tally connection settings

Tally connection settings are configured from:

- `File > Tally Connection Settings`

Settings include:

- Proxy Address (optional)
- WiFi SSID
- WiFi Password

When you run `Sync Proxy` for a tally, the app sends connection settings to that device (proxy address + WiFi credentials).

## UI flow

- `File > Console Connection`
  - Opens the Console Connection modal
  - Also shown automatically on first launch when no console address is configured
- `File > Add Tally Light`
  - Opens the Add Tally modal
- `File > Tally Connection Settings`
  - Opens the Tally Connection Settings modal
- Tally deletion is done from the modal using `Forget`

## Install and run

```bash
npm install
npm run start
```
