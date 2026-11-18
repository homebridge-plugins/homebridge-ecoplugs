# Change Log

All notable changes to `@homebridge-plugins/homebridge-ecoplugs` will be documented in this file.

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
