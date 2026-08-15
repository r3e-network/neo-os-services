# Testnet Account Stability Runbook

## Purpose

This runbook fixes the operational ground truth for the current Neo N3 testnet validation environment.

Goals:

- keep service accounts stable across iterations
- avoid signer drift between worker / relayer / updater roles
- keep enough testnet GAS on operational accounts so validation and pricefeed work do not stall
- provide a short command set for health checks after future changes

## Canonical Testnet Accounts

### NeoOS Oracle / Worker / Relayer / Updater

- Address: `NiUs458jFbTH1DA3b9QyeDhMaD282h3iJg`
- Script hash: `0xe421999c396ee0249a8a8c9dd95bfbdaf55f8bf7`
- Roles:
  - `worker`
  - `relayer`
  - `updater`
  - `oracle_verifier`

This identity is pinned in:

- `config/signer-identities.json`

### Legacy / Secondary Testnet Service Account

- Address: `NLjQR6uvgaW1nbifSmZbgLpAkkhnPvGpRh`
- Script hash: `0xaacfc5b7766d60d2a01e9e05e7e6a1947a9cf808`

This account still exists in local environments and old runtime envs, but the preferred testnet signer path should resolve to `NiUs...` for active Oracle roles.

### Testnet Validation / Funding Account

- Address: `NTmHjwiadq4g3VHpJ5FQigQcD4fF5m8TyX`
- Script hash: `0x0c3146e78efc42bfb7d4cc2e06e3efd063c01c56`

Current use:

- AA relay validation
- paymaster validation
- emergency testnet top-ups for oracle and miniapp smoke accounts

### Miniapp Test User Account

- Address: `NhMYxG5ATmRjSy6ocnPxrA2DiYba6xhFqu`
- Script hash: `0x69aa227309f35d7196d0d9f97fc22b33613a31eb`

Current use:

- non-flagship and script-driven testnet miniapp smoke flows

## Mainnet Pinning Note

Current canonical mainnet Oracle worker/relayer/updater identity in signer pinning:

- Address: `NR3E4D8NUXh3zhbf5ZkAp3rTxWbQqNih32`
- Script hash: `0x6d0656f6dd91469db1c90cc1e574380613f43738`

The mainnet `worker` pin was corrected so it no longer points to the testnet signer.

## Testnet Top-Up Transactions

The following funding transactions were executed to keep validation and pricefeed stable:

- `0xb8caec1eeb9e092c9f1a93ce081f598dd4f7cbc49c11a885138cc202a1c2e309`
- `0x3eabc86eaa2b22789a886b1b12c76f9fc8b870d9295e8468a30e22580d508461`
- `0x716578df16dddbd60d5321c4c786d403d71840cb1aaed318dc9a9ca3ba1c2b10`
- `0x279ecadab7e4e28c12a5d0be9e00856249038effac8493a62e839bc68a5c97aa`

Top-up intent:

- bring `NiUs...` to roughly `1000 GAS`
- bring `NLjQ...` to roughly `1000 GAS`
- bring `NhMY...` to a high enough balance for repeated miniapp smoke runs

## Expected Testnet Balances After Refuel

Approximate balances at the end of the validation pass:

- `NiUs458jFbTH1DA3b9QyeDhMaD282h3iJg`: `~999.81 GAS`
- `NLjQR6uvgaW1nbifSmZbgLpAkkhnPvGpRh`: `~1002.48 GAS`
- `NhMYxG5ATmRjSy6ocnPxrA2DiYba6xhFqu`: `~16338.18 GAS`
- `NTmHjwiadq4g3VHpJ5FQigQcD4fF5m8TyX`: `~46796.14 GAS`

These are not immutable snapshots; use them as sanity targets, not exact equality checks.

## Signer Stability Rules

### Required rule

Do not let testnet `worker / relayer / updater` execution fall back to unrelated generic WIFs.

### Current code protections

- `config/signer-identities.json` pins the role identities
- `workers/morpheus-relayer/src/relayer.js` now forwards the intended updater signer into feed-sync worker payloads
- `scripts/smoke-oracle-n3.mjs` no longer blocks normal request smoke on updater availability before fallback is needed

### Operational rule

If you change env files, preserve these invariants:

- testnet runtime signing path resolves to `NiUs...`
- mainnet runtime signing path resolves to `NR3E...`
- miniapp smoke admin/user remain distinct accounts

## Health Check Commands

### Oracle

```bash
cd <oracle-repo-root>
npm run test:worker
npm run test:relayer
npm run test:control-plane
npm run check:control-plane
npm run verify:edge-gateway
env MORPHEUS_CONTROL_PLANE_URL=https://control.meshmini.app npm run smoke:control-plane
npm run once:relayer
```

### AA

```bash
cd <abstract-account-repo-root>
dotnet test neo-abstract-account.sln -c Release --nologo
bash scripts/verify_repo.sh
```

### Cross-repo direct testnet

```bash
cd <neo-os-web-repo-root>
AA_TEST_WIF=... ORACLE_TEST_WIF=... NEO_TESTNET_WIF=... npm run test:testnet:direct
```

### Full-stack testnet

```bash
cd <neo-os-web-repo-root>
AA_TEST_WIF=... ORACLE_TEST_WIF=... NEO_TESTNET_WIF=... npm run test:testnet:full-stack
```

## Known Non-Blocking Residuals

- `Unknown script container` may appear while polling `getApplicationLog` on testnet. Current validation scripts already retry through it.
- `neo-abstract-account` still has low-severity frontend audit findings in the `@web3auth` dependency chain.
- `neo-os-web` root workspace audit can still differ from `platform/host-app` package audit because workspace hoisting and shared dependency trees are not identical.

## Operator Guidance

- Before large validation runs, confirm `NiUs...` still has at least `~1 GAS`, preferably much more.
- For repeated miniapp smoke runs, keep `NhMY...` funded so user-side steps do not fail with prepaid gas or transfer fee shortages.
- Use the validation funding account `NTm...` for testnet top-ups only; do not let oracle signer selection drift to that account.
- Never commit WIF values into the repository. Only commit addresses, script hashes, tx hashes, and operational instructions.
