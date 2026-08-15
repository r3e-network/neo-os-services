# Scripts

## Deployment And Verification

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
- `node scripts/upgrade-morpheus-oracle.mjs` (dry-run by default; index backfill resumes from the on-chain migration cursor)
- `npm run upgrade:datafeed:n3` (read-only dry-run; broadcast requires
  `node scripts/upgrade-morpheus-datafeed.mjs --apply --network testnet|mainnet`)
- `npm run audit:feeds -- --network mainnet`
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

## Validation Suites

- `npm run verify:repo`
- `npm run check:audit:root`
- `npm run test:game-engine-sync`
- `npm run test:worker`
- `npm run test:relayer`
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

## Relayer Operations

- `npm run once:relayer`
- `npm run start:relayer`
- `npm run metrics:relayer`
- `npm run metrics:relayer:prom`
- `npm run start:relayer:metrics`
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

- `NEO_N3_WIF`
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
