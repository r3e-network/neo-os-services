# Scripts

## Overview

These scripts deploy, configure, and verify NeoOS services. Commands default to
read-only or local validation unless their documentation explicitly requires an
apply flag and network.

## API Reference

### Neo N3

- `node scripts/deploy-service-gateway.mjs`
- `node scripts/deploy-callback-consumer.mjs`
- `node scripts/setup-morpheus.mjs`
- `npm run publish:oracle-key`
- `npm run publish:oracle-verifier-key`
- `npm run write:addresses`
- `npm run verify:n3`
- `npm run smoke:n3`
- `npm run set:updater:n3`
- `node scripts/upgrade-morpheus-oracle.mjs` (dry-run by default; without `--rpc` it reads two official public nodes that must agree, a mainnet apply needs `--rpc`; loads no env file unless `--env-file` names it; `--skip-simulation` keeps a dry run to read-only RPC; index backfill resumes from the on-chain migration cursor)
- `npm run upgrade:datafeed:n3` (read-only dry-run; broadcast requires
  `node scripts/upgrade-morpheus-datafeed.mjs --apply --network testnet|mainnet`)
- `npm run audit:feeds -- --network mainnet`
- `npm run audit:feeds:health` (read-only 6-hour SLO + root-cause report; see `docs/FEED-HEALTH-AUDIT.md`)
- TestNet per-pair `updateFeed` writer (not a live write until deployed): `docs/TESTNET-FEED-WRITER.md`
- `npm run backfill:feeds -- --network mainnet`

### Runtime env rendering

- `npm run render:nitro-env`
- `npm run render:nitro-compose-env`
- `npm run render:nitro-compose-env:mainnet`
- `npm run render:nitro-compose-env:testnet`
- `npm run render:nitro-hub-env`
- `npm run check:signers`
- `npm run check:nitro-env`
- `npm run check:nitro-prereqs`
- `npm run check:control-plane`
- `npm run check:control-plane:strict`

### Control plane and runtime smoke

- `npm run smoke:control-plane`
- `npm run smoke:all`

## Usage Examples

```sh
npm run test:game-engine-sync
npm run test:worker
npm run test:relayer
npm run test:relayer:compat
```

`test:game-engine-sync` regenerates engines only when the sibling
`neo-os-minigames/apps` source tree and its `esbuild` package are available.
Windows and Unix both invoke the package's JavaScript CLI through Node. When the
local-only source tree is absent, source regeneration checks are skipped while
checked-in engine parity goldens still run.

## Validation Suites

- `npm run format:rust:check` (handwritten rustfmt plus generated proto/schema identity; see `docs/RUST-FORMAT-GATE.md`)
- `npm run check:cargo-lock-provenance` (retired-graph deny-list plus documented leftover lock upgrades)
- `npm run verify:repo`
- `bash scripts/run-neo-nexus-signer-contract.sh` (requires a sibling
  `neo-nexus` checkout or `NEO_NEXUS_DIR`; owns a disposable signer/vault)
- `npm run check:audit:root`
- `npm run check:npm-audit` (CI's blocking audit: production scope plus dated dev-only exceptions in
  `config/npm-audit-exceptions.json`; see `docs/security/NPM-DEV-ADVISORY-EXCEPTIONS-20261005.md`)
- `npm run test:game-engine-sync`
- `npm run test:worker`
- `npm run test:relayer`
- `npm run test:relayer:compat` (frozen Node parity/compatibility evidence)
- `npm run test:control-plane`
- `npm run build:web`
- `npm run examples:test:n3`
- `npm run examples:test:n3:privacy`
- `npm run examples:test:n3:automation`
- `npm run examples:test:n3:callback-boundary`
- `npm run examples:test:n3:neodid-registry-boundary`
- `npm run examples:test:n3:encrypted-ref-boundary`
- `npm run examples:test:n3:fulfillment-replay`
- `npm run examples:test:n3:aa-session-oracle-boundary`
- `npm run examples:test:n3:attack-regression`

Root audit note:

- `npm run check:audit:root` accepts only the explicitly excluded CityOfZion / Neon dependency chain and fails on anything new.
- `npm run verify:repo` is the preferred local verification entrypoint before wider live/testnet runs.
- `npm run lint` checks repository-owned JavaScript and TypeScript. Vendored
  Rust dependency sources and generated Cargo targets are excluded and remain
  governed by their content pins and Rust build checks.

## Relayer Operations

- `npm run once:relayer` (Rust)
- `npm run start:relayer` (Rust)
- `npm run metrics:relayer` (Rust)
- `npm run metrics:relayer:prom` (Rust)
- `npm run start:relayer:metrics` (Rust)
- Node parity commands are explicitly suffixed `:compat` and are never the
  production authority: `start:relayer:compat`, `once:relayer:compat`,
  `metrics:relayer:compat`, and `start:relayer:compat:metrics`.
- `npm run stress:runtime`

Important relayer notes:

- `MORPHEUS_RELAYER_MODE=requests_only` for the Oracle CVM
- `MORPHEUS_RELAYER_MODE=feed_only` for the DataFeed CVM
- mainnet request relayers must receive network-scoped
  `MORPHEUS_RELAYER_NEO_N3_*_MAINNET` and
  `MORPHEUS_UPDATER_NEO_N3_*_MAINNET` secrets from secure env injection
- `MORPHEUS_RELAYER_INSTANCE_ID` makes queue ownership explicit
- `MORPHEUS_DURABLE_QUEUE_ENABLED=true` persists chain events before checkpoint advance

## SaaS Sync

- `npm run sync:checkly`
- `npm run sync:checkly:browser`
- `npm run check:betterstack`
- `npm run sync:betterstack`
- `npm run check:betterstack:monitors`
- `npm run sync:betterstack:monitors`
- `npm run check:betterstack:sources`
- `npm run sync:betterstack:sources`
- `npm run export:saas`

## Expected Environment

- `NEO_N3_WIF` (local smoke tooling only, e.g. the testnet RNG loop; deployed lanes sign custody-side)
- legacy `NEO_TESTNET_WIF`
- `NEO_RPC_URL`
- `NEO_NETWORK_MAGIC`
- `CONTRACT_MORPHEUS_ORACLE_HASH`
- `CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH`
- `CONTRACT_MORPHEUS_DATAFEED_HASH`
- optional `MORPHEUS_UPDATER_HASH`

## Local Testnet RNG Loop

```bash
npm run set:updater:n3
npm run start:testnet-rng-local
```
