# oracle.meshmini.app / edge.meshmini.app restoration — RUNBOOK (artifacts, NOT deployed)

**Status: design + analysis prepared, NOT deployed.** This is the follow-up to the
in-TEE execution-edge migration (see `../../nitro/AA-EDGE-MIGRATION-RUNBOOK.md`).
Nothing here changes live behavior until an operator runs the steps below.

**Observed 2026-09-28 (read-only probes):** the live worker already maps the legacy
paths onto `apps/web` (`mapToAppBackendPath` in `worker.mjs`). On `edge.neoos.network`
every `GET` route in the [public route list](#public-routes) answered 200 under
`/mainnet`, as did the routes sampled on `oracle.meshmini.app` and `edge.meshmini.app`;
the `POST` passthroughs were not probed. Routes that need the full runtime answer `503
runtime_route_unavailable`. The status line above and the sections after the route
list are the original plan and its open questions.

## Public routes

Every public route is served under a network prefix; `{net}` is `mainnet` or
`testnet`. The runtime behind the production deployment serves mainnet only, so
there `/testnet/health` and `/testnet/v1/status` answer `503
runtime_network_mismatch` (the edge refuses to present a mainnet runtime as
testnet).

| Route                                                        | Served from                                                 |
| ------------------------------------------------------------ | ----------------------------------------------------------- |
| `GET /{net}/health`                                          | `apps/web` `/api/runtime/health?network={net}`              |
| `GET /{net}/v1/status`                                       | `apps/web` `/api/runtime/status?network={net}`              |
| `GET /{net}/api/runtime/status`                              | the edge, from `/health` and `/info` probes of that network |
| `GET /{net}/api/runtime/catalog`                             | the edge, from the bundled `morpheus-runtime-catalog.json`  |
| `GET /{net}/oracle/public-key`                               | `apps/web` `/api/oracle/public-key?network={net}`           |
| `GET /{net}/providers`                                       | `apps/web` `/api/providers?network={net}`                   |
| `GET /{net}/feeds/catalog`, `GET /{net}/feeds/status`        | `apps/web` `/api/feeds/catalog`, `/api/feeds/status`        |
| `GET /{net}/feeds/price/<symbol>`                            | `apps/web` `/api/feeds/<symbol>?network={net}`              |
| `POST /{net}/oracle/decrypt`, `/{net}/oracle/message-reveal` | the attested box, which gates each message in the TEE       |

An unprefixed path is served on the deployment's `MORPHEUS_NETWORK` (`mainnet` in
`wrangler.meshmini.toml`) and says so in `x-morpheus-network`. Without that variable
it answers `400 network_required`, naming the `/mainnet` and `/testnet` forms of the
same path; any value other than `mainnet` or `testnet` answers `500
invalid_network_configuration`. Before this was configurable, unprefixed paths were
always served on testnet, so on the mainnet-only deployment `/health` and
`/v1/status` reported a healthy runtime as down. Monitors, status pages and
integrators should use the prefixed form. After a redeploy the edge cache can keep
an unprefixed answer from the previous deployment for up to its TTL (15 s for
`/health`, 300 s for `/oracle/public-key` and `/feeds/catalog`).

## Problem

`oracle.meshmini.app` / `edge.meshmini.app` are served by the `morpheus-edge-gateway`
worker (`worker.mjs`), which proxies the FULL public oracle/AA API to its origin vars.
Those vars currently point at the **dead Vercel `emergency-runtime` placeholder** (and
the retired Phala feed CVM), so every public oracle/AA call to those hostnames is
degraded:

```
MORPHEUS_ORIGIN_URL          = https://www.morpheus-matrix.dev/api/emergency-runtime
MORPHEUS_{MAINNET,TESTNET}_ORIGIN_URL = .../emergency-runtime/{net}
MORPHEUS_{MAINNET,TESTNET}_FEED_ORIGIN_URL = https://<phala-cvm>/{net}   # retired
```

The in-TEE execution plane (control plane → `runtime.meshmini.app` → enclave) already
works; this is about the SEPARATE public sync API surface.

## Recommended approach: re-point the edge origin at `apps/web` (NOT the box)

The box runtime gateway deliberately exposes only the 6 execution routes; the full
public API must not be widened onto it (that would share the privileged enclave Bearer
with anonymous callers). `apps/web` (the Next.js app) is the right origin: it holds the
tokens, applies per-route auth, and routes to the control plane / in-TEE box. Keep the
enclave's sign/keys/decrypt routes private (host-only) — do NOT proxy them.

## `apps/web` route coverage (verified 2026-06-15)

Covered (re-point works once the path shape is reconciled — see below):

- `/oracle/query` → `apps/web/app/api/oracle/query`
- `/oracle/smart-fetch` → `app/api/oracle/smart-fetch`
- `/oracle/public-key` → `app/api/oracle/public-key`
- `/providers` → `app/api/providers`
- `/feeds/catalog`, `/feeds/status` → `app/api/feeds/*`
- `/compute/execute` → `app/api/compute/execute`
- `/neodid/resolve`, `/neodid/providers` → `app/api/neodid/*`
- `/keys/derived` → `app/api/runtime/keys/derived`; `/info` → `app/api/runtime/info`

**GAPS — not implemented in `apps/web` (will 404 on re-point):**

- `/paymaster/*` (gasless sponsorship) — none.
- `/vrf/*` — none.
- `/relay/transaction` (gasless relay) — only `relayer/metrics` + `relayer/dead-letters` exist.
- `/oracle/feed` (publish) — feeds are pushed in-TEE; `feeds/catalog|status` are reads only.
- `/neodid/bind|action-ticket|recovery-ticket` — these are the confidential
  execution-plane lanes (control plane → box), not sync `apps/web` routes; confirm
  whether the edge should proxy them at all or whether clients use the control plane.

## ⚠️ Path-shape mismatch (must resolve before re-point)

Resolved by option 1 below: `mapToAppBackendPath` in `worker.mjs` strips the network
segment, prefixes `/api` and passes the network as `?network=`. The original
analysis follows.

`morpheus-edge-gateway` forwards `oracle.meshmini.app/{net}/{path}` →
`ORIGIN_URL/{net}/{path}` (network segment preserved, no rewrite — `resolveNetworkRoute`
in `worker.mjs`). But `apps/web` routes are `/api/{path}` with **no `/{net}/` segment
and an `/api` prefix**. A naive `MORPHEUS_ORIGIN_URL = https://<web>/api` would request
`https://<web>/api/{net}/oracle/query` → 404. Options:

1. Add a small rewrite in `morpheus-edge-gateway` (strip `/{net}`, prefix `/api`, pass
   the network as `x-morpheus-network` or a query param), OR
2. Add `apps/web/app/api/[net]/...` passthrough routes that accept the network segment,
   OR 3. set `ORIGIN_URL` to a dedicated `apps/web` base that already normalizes both.

## Ordered steps (each gates the next)

1. **Decide the GAP routes** (see Open questions) — paymaster/relay/vrf must either be
   implemented in `apps/web` (routing to chain-direct / the control plane) or explicitly
   dropped from the edge (return a clear 501), so the re-point doesn't silently 404 them.
2. **Resolve the path mismatch** (option 1/2/3 above) and test each covered route
   against `apps/web` directly with the network-prefixed path.
3. **Pin `apps/web`'s own runtime URL to the box FIRST** (its execution base →
   `runtime.meshmini.app`) so that after the re-point, `oracle.meshmini.app` → `apps/web`
   → control-plane/box does NOT loop back through `oracle.meshmini.app`.
4. **Re-point the edge origin vars** in `wrangler.meshmini.toml`:
   `MORPHEUS_{,MAINNET_,TESTNET_}ORIGIN_URL` → the `apps/web` base. Leave
   `MORPHEUS_*_FEED_ORIGIN_URL` only if a live feed-read origin exists (else drop;
   feeds are pushed in-TEE and read via `feeds/catalog|status`).
5. `wrangler deploy --config wrangler.meshmini.toml` (morpheus-edge-gateway).
6. **Validate every route** through `oracle.meshmini.app/{net}/...`: covered routes →
   200; GAP routes → the decided behavior; confirm sign/keys/decrypt are NOT reachable.
7. Retire the Vercel `emergency-runtime` placeholder.

## Risks

- **Proxy loop** if `apps/web`'s runtime URL still points at `oracle.meshmini.app` (step 3).
- **Silent 404s** on paymaster/relay/vrf if step 1 is skipped.
- **Privilege leak** if anyone instead widens the box gateway to the full API (do NOT).

## Open questions (need a decision before deploy)

1. Paymaster / gasless relay / VRF: implement in `apps/web` (and route where — chain-direct?
   a control-plane lane? the box?) or drop from the public edge?
2. Enable untrusted-script compute (`/compute/execute` is gated by
   `MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS`, off by default)?
3. Should `apps/web` be the public front (simplest, token-holding) or should clients get a
   TEE-attested API path for the confidential lanes (stronger, more work)?
