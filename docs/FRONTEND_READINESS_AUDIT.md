# Frontend Readiness Audit

Latest pass: 2026-06-01

Scope: Oracle Requests workbench in `neo-os-services`, paymaster/relay readiness surfaces in `neo-abstract-account`, and the shared Morpheus-compatible runtime assumptions those screens expose to users.

## Changes Landed

- Oracle runtime requests now preserve the selected network when fetching providers and public keys.
- Oracle protected-runtime public-key failures are visible in the workbench instead of being hidden behind a ready-looking header.
- Oracle on-chain state failures now disable NEP-21 wallet submission instead of falling back to default live-looking contract data.
- Oracle generated packages now distinguish `WALLET READY`, `PUBLIC PAYLOAD READY`, and `NEEDS VERIFICATION`.
- Public payload submission can remain available when the protected encryption key is unavailable, but the UI now uses a warning badge and explains that encrypted params are disabled.
- Private Compute now uses the same selected-network on-chain readiness model before enabling NEP-21 wallet submission.
- Starter Studio now fetches public-key and on-chain-state readiness with the selected network and disables local encryption when protected public-key access is degraded.
- Starter Studio snippets and manual panels now use the selected network's Oracle contract, callback hash, label, and on-chain fee instead of static `NETWORKS.neo_n3` values.
- NEP-21 request building validates request type, payload base64, Hash160 arguments, callback method, and sets `abortOnFail: true`.
- AA paymaster/relay surfaces now separate local payload readiness from operational relay readiness, and relay submit requires a matching successful preflight.

## Browser Verification

Oracle production build was served at `http://127.0.0.1:3003/explorer?network=testnet` and verified through a browser automation pass:

- Page loaded with meaningful content.
- No browser console errors or page errors were captured.
- `Oracle Requests` tab opened successfully.
- Header showed `ORACLE STATUS`; no `LIVE ORACLE` text remained.
- Protected key degradation showed `Public key unavailable: unauthorized`.
- Generated package showed `PUBLIC PAYLOAD READY` with a warning-colored badge.
- `Submit with NEP-21` stayed enabled for a public payload because on-chain state was verified.

Screenshots:

- `apps/web/oracle-workbench-readiness.png`
- `apps/web/oracle-workbench-generated-readiness.png`

Private Compute and Starter Studio were re-verified in a production browser pass at `http://127.0.0.1:3011` with mocked degraded runtime/state responses:

- `Starter Studio` requested `/api/oracle/public-key?network=testnet` and `/api/onchain/state?limit=20&network=testnet`.
- `Starter Studio` displayed `Public key unavailable` and `On-chain state unavailable`, and `Encrypt Patch Locally` stayed disabled.
- `Private Compute` requested selected-network on-chain state, displayed `On-chain state unavailable`, generated a package with `NEEDS VERIFICATION`, and kept `Submit with NEP-21` disabled.
- No browser console errors or page errors were captured.

Screenshots:

- `apps/web/starter-studio-readiness-after.png`
- `apps/web/private-compute-readiness-after.png`

AA production preview was verified separately at its Vite preview URL:

- Home readiness screenshot: `../neo-abstract-account/frontend/dist-home-readiness-current.png`
- App readiness screenshot: `../neo-abstract-account/frontend/dist-app-readiness-current.png`
- Paymaster copy now says `Paymaster Readiness` instead of overclaiming a fully live path.
- AA app copy now says `Runtime configuration detected` and `Preflight required` instead of `Configured for live AA operations`.

## Automated Checks

Oracle:

- `npm --prefix apps/web run test:run -- __tests__/oracle-public-key-route.test.ts __tests__/providers-route.test.ts __tests__/networks.test.ts lib/nep21.test.ts`
- `npm --prefix apps/web run test:run -- __tests__/oracle-readiness.test.ts __tests__/oracle-public-key-route.test.ts __tests__/providers-route.test.ts __tests__/networks.test.ts`
- `npx tsc --noEmit --pretty false --project apps/web/tsconfig.json`
- `node --check scripts/checkly-sync-browser-checks.mjs`
- `npm --prefix apps/web run build`

AA:

- `node --test tests/docsRendering.test.js tests/relayReadiness.test.js tests/homeOperationsView.test.js tests/sharedDraftView.test.js tests/transactionDrafts.test.js tests/i18nSupport.test.js`
- `npm run build`

## Transaction Boundary

No new funded testnet transaction was broadcast during this UI pass. The current shell did not expose the protected runtime credentials or wallet funding context required to honestly claim a new full relay or Oracle transaction. The UI now makes that boundary explicit instead of presenting degraded credentials, unverified on-chain state, or local package generation as complete readiness.

## Next Sweep

- Continue the miniapps platform sweep for each miniapp's interactive business flow, not only visual presentation.
- Re-run real testnet transaction flows once the funded wallet and runtime credentials are present in the execution environment.
