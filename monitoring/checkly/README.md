# Checkly Monitoring Scaffold

This folder defines the recommended synthetic checks for the Morpheus stack.

## Suggested Checks

### Browser checks

1. `aa-home`
   - URL: AA frontend home
   - Expect main hero heading
2. `aa-identity`
   - URL: AA frontend `/identity`
   - Expect identity workspace heading
3. `oracle-home`
   - URL: Morpheus oracle web home
   - Expect hero + docs links
4. `oracle-explorer`
   - URL: Morpheus oracle `/explorer`
   - Expect dashboard shell

### API checks

1. `oracle-runtime-health`
   - `GET /api/runtime/health`
2. `oracle-runtime-info`
   - `GET /api/runtime/info`
3. `control-plane-health`
   - `GET /testnet/health`
   - `GET /mainnet/health`
4. `oracle-public-key`
   - `GET /api/oracle/public-key`

## Current Seeded Checks

These API checks can now be created directly from this repo:

- `morpheus-oracle-testnet-health`
- `morpheus-oracle-mainnet-health`
- `morpheus-oracle-testnet-public-key`
- `morpheus-oracle-testnet-providers`
- `morpheus-oracle-testnet-feed-catalog`
- `morpheus-oracle-testnet-neodid-providers`
- `morpheus-oracle-mainnet-public-key`
- `morpheus-oracle-mainnet-providers`
- `morpheus-oracle-mainnet-feed-catalog`
- `morpheus-oracle-mainnet-neodid-providers`
- `morpheus-oracle-testnet-info`
- `morpheus-oracle-mainnet-info`
- `morpheus-control-testnet-health-auth-gate`
- `morpheus-control-mainnet-health-auth-gate`
- `morpheus-edge-testnet-health`
- `morpheus-edge-mainnet-health`
- `morpheus-edge-testnet-public-key`
- `morpheus-edge-testnet-providers`
- `morpheus-edge-testnet-feed-catalog`
- `morpheus-edge-testnet-neodid-providers`
- `morpheus-edge-mainnet-public-key`
- `morpheus-edge-mainnet-providers`
- `morpheus-edge-mainnet-feed-catalog`
- `morpheus-edge-mainnet-neodid-providers`
- `morpheus-edge-testnet-info`
- `morpheus-edge-mainnet-info`

Seed command:

```bash
npm run sync:checkly
```

List current checks:

```bash
npm run check:checkly
```

## Browser Checks

Browser checks are not seeded yet because the AA public site domain is not reliably resolvable from the current runtime environment.
AA browser checks are now scaffolded via:

- [scripts/checkly-sync-browser-checks.mjs](../../scripts/checkly-sync-browser-checks.mjs)

Current target:

- `https://neo-abstract-account.vercel.app/`
- `https://neo-abstract-account.vercel.app/identity`

Current seeded browser checks:

- `aa-home-browser`
- `aa-identity-browser`

Seed command:

```bash
npm run sync:checkly:browser
```

## Required Values

- `CHECKLY_API_KEY`
- `CHECKLY_ACCOUNT_ID`
- `CHECKLY_PROJECT_NAME`
- deployment URLs for:
  - AA frontend
  - oracle web frontend
  - control plane

## Recommended Alert Targets

- email
- Slack / Discord webhook
- PagerDuty for production-only health failures
