# Change Log

All notable changes to `@homebridge-plugins/homebridge-ecoplugs` will be documented in this file.

## v1.1.0 (unreleased)

### Changes

- add an optional `bindAddress` setting (Advanced Options) to pin the KAB command socket and the legacy socket to one network interface, fixing intermittent `EHOSTUNREACH` on hosts with more than one interface on the same subnet; an invalid (non-IPv4) address is ignored with a warning (thanks @marckagan, #1)
- fix static-IP legacy devices (`protocol: "legacy"`) being commanded on the KAB port (1022) instead of the legacy port (80), and correct an already-cached wrong port (thanks @marckagan, #2)
- an explicit per-device `commandPort` is no longer overwritten by legacy discovery
- fix KAB commands and beacon ACKs never being sent on macOS, where `SO_REUSEPORT` is not supported
- report KAB socket bind failures at warn level instead of leaving commands hanging
- log failed legacy sends and discovery probes (visible with debug logging) instead of dropping them silently
- fix the legacy socket never recovering (and ignoring `bindAddress`) if a status poll ran while its port could not be bound
- fix `protocol: "legacy"` never taking effect for a device already cached as KAB
- a device forced to `protocol: "legacy"` that also sends KAB beacons keeps the legacy command port instead of taking the beacon's KAB port
- the KAB beacon listener now warns when it cannot bind port 10228 (e.g. another instance is using it) and keeps retrying, instead of stopping silently with only a debug message
- one unreachable KAB plug no longer permanently switches the shared command socket (used by every plug and by beacon ACKs) to an ephemeral source port; the configured port is restored when the fallback does not help
- changing the KAB socket's port or address no longer leaves requests waiting on the old socket until they time out, and a bind already in progress picks up the new settings
- remove the KAB "priming" broadcast, which could never be sent (the socket does not enable broadcast)
- docs and config UI: the per-device `commandPort` is the device's port (default 1022 for KAB, not 9090); removed the README's per-device `kabBindPort`, which does not exist; the service type list only offers the supported `outlet` and `switch`; a blank `bindAddress` is accepted by the config form
- add tests for command ports, protocol switching, the KAB socket and beacon listener, and `bindAddress`

## v1.0.3 (2026-11-18)

### Changes

- update supported versions to Node.js `^22.12.0 || ^24.0.0 || ^26.0.0` (aligned with Homebridge 2.x) and Homebridge `^1.8.0 || ^2.0.0`
- update dev dependencies (Homebridge 2.5, ESLint 10, typescript-eslint, `@types/node`) and refresh the lockfile
- fix `npm run lint` (migrate to an ESLint 10 flat config using `typescript-eslint`)
- add a `build` workflow (lint, build and test on Node 22, 24 and 26) and a smoke test run by `npm test`

## v1.0.2 (2026-03-07)

### Changes

- rename plugin to homebridge-ecoplugs

## v1.0.1 (2026-03-06)

### Changes

- fix duplicate enum item in config schema file

## v1.0.0 (2026-03-06)

### Changes

- changes for homebridge-plugins scoped pkg
- edits to package and config schema for verification
