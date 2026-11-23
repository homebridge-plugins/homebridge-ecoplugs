# homebridge-ecoplugs

[![npm version](https://badgen.net/npm/v/@homebridge-plugins/homebridge-ecoplugs?icon=npm&label)](https://www.npmjs.com/package/@homebridge-plugins/homebridge-ecoplugs) 
[![npm downloads](https://badgen.net/npm/dt/@homebridge-plugins/homebridge-ecoplugs?label=downloads)](https://www.npmjs.com/package/@homebridge-plugins/homebridge-ecoplugs) 
[![license](https://badgen.net/github/license/homebridge-plugins/homebridge-ecoplugs)](LICENSE)

<p>The Homebridge plugin for ECO Plugs and WION Wi‑Fi switches. **All communication is local‑network only** (uses UDP broadcasts) and requires the plugin to be on the same subnet as the devices; it does not talk to the EcoPlug cloud servers like the official app.</p>

> **New or factory-reset legacy device that isn't on your Wi-Fi yet?** This plugin only controls devices that are already on your network. To get an older ECO Plugs / WiOn device onto your 2.4 GHz Wi-Fi without the original app, use the independent [ecoplugs-wion-initial-setup](https://github.com/djcarlin/ecoplugs-wion-initial-setup) tool (macOS app and Python CLI for Windows and Linux), then come back here. See [Initial Wi-Fi setup](#initial-wi-fi-setup).

## Table of Contents
1. [Features](#features)
2. [Compatibility](#compatibility)
3. [Installation](#installation)
4. [Configuration](#configuration)
   - [Minimal config](#minimal-config-auto-discovery)
   - [Recommended config](#recommended-config-local-only--intervals)
   - [Static-IP config for newer KAB devices](#static-ip-config-for-newer-kab-devices)
   - [Static-IP config for legacy devices](#static-ip-config-for-legacy-devices)
5. [Parameters](#parameters)
   - [Main options](#main-options)
   - [Advanced options](#advanced-options)
   - [Per-device options](#per-device-options-devices)
6. [Protocol and Port Support](#protocol-and-port-support)
7. [Tested Devices](#tested-devices)
8. [Initial Wi-Fi setup](#initial-wi-fi-setup)
9. [Firewall checklist](#firewall-checklist)
10. [Troubleshooting](#troubleshooting)
11. [Credits](#credits)

## Features

- Supports both protocol families used by ECO devices:
  - Legacy FtNetManager devices
  - Newer KABNetManager devices (including port 9090 command flow)
- Auto discovery for both stacks:
  - Active legacy discovery (polled on interval): a broadcast on every network interface's subnet, plus direct probes of static-IP legacy devices
  - Passive KAB beacon discovery (always listened for; status updates from beacons are automatically applied)
- KAB devices always use the beacon’s host/port and raw integer device ID; the discovery handshake is skipped unconditionally.
- Optional static-IP onboarding per device (no need to wait for beacon)
- **Local‑network only:** relies on broadcast packets; the plugin must run on the same LAN/subnet as the devices and has no cloud connectivity
- Local-only safety mode (prevents control of non-private IPs)
- Per-device overrides for protocol, command port, key, and password

## Compatibility

| Requirement | Version      |
|-------------|--------------|
| Node.js     | 22 (≥ 22.12), 24, 26 |
| Homebridge  | v1 (≥ 1.8), v2       |

## Installation

### Homebridge UI

Search for **@homebridge-plugins/homebridge-ecoplugs** and install.

### Command line

```sh
sudo npm install -g @homebridge-plugins/homebridge-ecoplugs
```

## Configuration

### Minimal config (auto discovery)

```json
"platforms": [
  {
    "platform": "EcoPlug",
    "name": "EcoPlug",
    "enabled": true
  }
]
```

### Recommended config (local-only + intervals)

```json
"platforms": [
  {
    "platform": "EcoPlug",
    "name": "EcoPlug",
    "localOnly": true,
    "port": 9000,
    "pollingInterval": 10,
    "discoverInterval": 60,
    "deviceInactiveTimeout": 180,
    "deviceRemoveTimeout": 0
  }
]
```

### Static-IP config for newer KAB devices

Use this when you want immediate startup registration without waiting for a beacon.

```json
"platforms": [
  {
    "platform": "EcoPlug",
    "name": "EcoPlug",
    "devices": [
      {
        "id": "ECO-78ABCDEF",
        "host": "192.168.1.50",
        "protocol": "kab",
        "kabKey": "keenfeng",
        "kabPass": "111111"
      }
    ]
  }
]
```

### Static-IP config for legacy devices

Use this for an older (FtNetManager) device when you want immediate startup registration, or when broadcasts do not reach Homebridge (for example Homebridge in a container with bridge networking, or on a different VLAN than the device). Set `protocol` to `legacy`: the device is then also probed directly on UDP 25 and 5888 every discovery cycle, so its name, firmware and command port are picked up just as with broadcast discovery.

```json
"devices": [
  {
    "id": "ECO-78ABCDEF",
    "host": "192.168.1.50",
    "protocol": "legacy"
  }
]
```

A device with a `host` and `protocol` left on `auto` is treated as KAB, so set `legacy` explicitly for a legacy device.

## Parameters

### Main options

| Parameter   | Required | Default   | Description                                       |
|-------------|----------|-----------|---------------------------------------------------|
| `platform`  | yes      | `EcoPlug` | Must be `"EcoPlug"`                              |
| `name`      | yes      | `EcoPlug` | Display name in Homebridge logs                  |
| `localOnly` | no       | `true`    | Only allow private LAN addresses for discovery/control |
| `port`      | no       | `9000`    | Incoming UDP port for legacy status messages     |

### Advanced options

| Parameter              | Default | Description                                                                                              |
|------------------------|---------|----------------------------------------------------------------------------------------------------------|
| `pollingInterval`      | `10`    | Seconds between status polls for **legacy** devices (`0` disables polling)                               |
| `discoverInterval`     | `60`    | Seconds between legacy discovery broadcasts (`0` disables)                                               |
| `deviceInactiveTimeout`| `180`   | Mark accessory unavailable after this many seconds without response (`0` disables)                      |
| `deviceRemoveTimeout`  | `0`     | Remove accessory after this many seconds without response (`0` disables)                                |
| `kabMaxFailures`       | `15`    | **(KAB only)** Give up on additional status queries after this many consecutive timeouts; resets on success or discovery |
| `kabBindPort`          | `9090`  | **(KAB only)** UDP source port to bind for outgoing commands (`0` lets OS choose ephemeral port)       |
| `defaultServiceType`   | `switch` | HomeKit service for newly added devices: `switch` or `outlet`. Devices already in HomeKit keep their current type |
| `bindAddress`          | *(unset)* | IPv4 address of the local network interface to use for KAB commands and legacy discovery/status. Leave unset to let the OS choose. See [multiple network interfaces](#troubleshooting) |

### Per-device options (`devices[]`)

| Field         | Required | Description                                                          |
|---------------|----------|----------------------------------------------------------------------|
| `id`          | yes      | Device ID, e.g. `ECO-78ABCDEF`                                      |
| `host`        | no       | Static IP to seed device at startup. With `protocol: "legacy"` it is also probed directly on every discovery cycle |
| `protocol`    | no       | `auto` (default), `legacy`, or `kab`                                |
| `serviceType` | no       | `switch` or `outlet` for this device (default: `defaultServiceType`)  |
| `commandPort` | no       | Override the port the device listens on for commands (default `1022` KAB; legacy uses the port advertised during discovery, usually `80`). This is the device's port, not the local source port (`kabBindPort`); normally leave it unset |
| `kabKey`      | no       | KAB credential key (usually auto-populated from beacon)             |
| `kabPass`     | no       | KAB command password (default `111111`)                             |
| `kabMaxFailures`| no     | Override global max consecutive status failures for this device     |

## Protocol and Port Support

| Protocol                 | Discovery                    | Commands | Typical devices                    |
|--------------------------|------------------------------|----------|-------------------------------------|
| Legacy (FtNetManager)    | UDP 25 + 5888 (broadcast, and direct to a static `host`) | The port the device advertises, usually UDP 80 | Older CT-065W / WiOn models        |
| KAB (KABNetManager)      | UDP 10228 (beacon)           | UDP 1022 (sent from local port 9090) | Newer ECO firmware |

The plugin auto-selects protocol per device by discovery data. You can also force a protocol per device in config.

## Tested Devices

- ECO Plugs CT-065W Wi-Fi Controlled Outlet (legacy + KAB firmware)
- WiOn Outdoor Outlet 50049
- Wion E211835 RC-031W Indoor Plugs
- ~~Woods WiOn 50052 WiFi In-Wall Light Switch~~ (recalled due to fire hazard)
- DEWENWILS 300W Smart Low Voltage Transformer

Some ECO Plugs models were also sold as Woods WiOn, WorkChoice or DEWENWILS. An `ECO-` device ID is a good sign that a device belongs to this family.

## Initial Wi-Fi setup

This plugin controls devices that are already on your Wi-Fi; it cannot put a device onto your network. If a device was factory reset and the original ECO Plugs app can no longer onboard it, the independent [ecoplugs-wion-initial-setup](https://github.com/djcarlin/ecoplugs-wion-initial-setup) tool (macOS app and Python CLI) can send your Wi-Fi credentials to legacy (FtNetManager) devices over their temporary setup network. Its author reports that setup for KAB firmware is unverified. Once the device has joined your network, this plugin discovers it as usual.

## Firewall checklist

Allow these UDP ports on the Homebridge host:

| Direction | Port | Use                                    |
|-----------|------|----------------------------------------|
| Outbound  | 25   | Legacy broadcast discovery             |
| Outbound  | 5888 | Legacy broadcast discovery (alt)       |
| Inbound   | 9000 | Legacy status responses                |
| Outbound  | 80   | Legacy command port / KAB fallback B   |
| Inbound   | 10228| KAB beacons                            |
| Outbound  | 9090 | KAB commands (source port)            |
| Outbound  | 1022 | KAB command destination (device)      |
| Outbound  | 6000 | KAB fallback command port A (device)   |

*Example firewall rules shown use `ufw` on a Linux host; Homebridge installations often don’t include it.  Apply equivalent rules using whatever firewall tool your system provides.*

```sh
# ufw example (Linux)
sudo ufw allow out 25/udp
sudo ufw allow out 5888/udp
sudo ufw allow in 9000/udp
sudo ufw allow out 80/udp     # legacy command port / KAB fallback B
sudo ufw allow in 10228/udp
sudo ufw allow out 9090/udp   # source port for outgoing KAB commands
sudo ufw allow out 1022/udp   # device destination port (default)
sudo ufw allow out 6000/udp   # KAB fallback port A
```
## Troubleshooting

- Device not found:
  - Make sure the device has actually joined your Wi-Fi. A factory-reset or never-configured legacy device only offers its own temporary `ECO-…` hotspot; onboard it first with [ecoplugs-wion-initial-setup](https://github.com/djcarlin/ecoplugs-wion-initial-setup) (see [Initial Wi-Fi setup](#initial-wi-fi-setup))
  - Confirm same LAN/subnet
  - Confirm UDP broadcast allowed
  - Add static `host` under `devices[]` for immediate startup registration. For an older (legacy) device also set `"protocol": "legacy"`: it is then probed directly, which works even where broadcasts do not reach Homebridge (see [Static-IP config for legacy devices](#static-ip-config-for-legacy-devices))
- Accessory shows no response:
  - Check firewall rules above
  - Verify `localOnly` is not blocking a non-private address
  - Verify `commandPort` override for that device
- Device disappears frequently:
  - Increase `deviceInactiveTimeout`
  - Leave `deviceRemoveTimeout` at `0` unless you explicitly want auto-removal
- Intermittent `EHOSTUNREACH` errors, or devices only found some of the time, on a host with **more than one network interface** on the same subnet (for example Ethernet plus Wi-Fi, or Wi-Fi that kept a stale IP after dropping off):
  - Set `bindAddress` (under Advanced Options) to the IPv4 address of the interface that actually reaches the devices, e.g. `"bindAddress": "192.168.1.10"`
  - Use a static IP or DHCP reservation for that address and restart Homebridge if it ever changes
  - The address must belong to the machine running Homebridge; an invalid or unassigned address is reported in the log and the affected sockets will not work until it is fixed
  - KAB beacons are broadcasts, so the beacon listener always listens on all interfaces regardless of this setting
  - Legacy discovery broadcasts to every interface's own subnet (for example `192.168.1.255`) as well as `255.255.255.255`. With `bindAddress` set it only broadcasts to that interface's subnet
  - If legacy devices stop being discovered, or stop reporting status, after you set `bindAddress`, remove the setting again. A socket bound to one address cannot receive broadcast packets, so firmware that replies by broadcast would be missed. Please open an issue with the device model and firmware if this happens
  - With debug logging enabled (`"debug": true`) failed sends are logged, e.g. `Legacy send to 192.168.1.50:80 failed ... EHOSTUNREACH`, which shows whether the setting helped

## Credits

- Danimal4326 — Initial ECO Plug protocol work
- NorthernMan54 — Device auto-discovery
- askovi — Tested WiOn Outdoor Outlet 50049
- JeffreyStocker — Additional addons
- IWCaldwell - KAB Protocal implementation, Homebridge V2 support and conversion to TypeScript
