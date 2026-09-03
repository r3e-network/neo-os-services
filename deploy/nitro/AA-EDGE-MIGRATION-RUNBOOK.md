# AA / confidential execution-runtime edge migration — RUNBOOK

**Status: DEPLOYED LIVE (2026-06-15).** The confidential execution plane now runs in
the AWS Nitro TEE. The steps below are kept as the canonical procedure + rollback
reference. See "Deployment record" for what is actually live.

## Deployment record (2026-06-15)

- **Enclave:** exec EIF cut over on the live mainnet box (`i-0c52851f134db20ee`).
  Running `PCR0 = 49a142254c73cd4a299b74d78db7f459f3857c6b589cc7c0f67df9657b0f763da76cf29f2d652035aa431608c5f4e281`
  — matches `measurements/oracle-enclave-exec-2026-06-15.json` (reproducible build
  confirmed). Signing identities preserved (oracle_verifier / updater).
- **Gateway:** `https://runtime.meshmini.app` → Cloudflare (proxied) → box nginx
  (`/etc/nginx/conf.d/morpheus-runtime.conf`, listens 80 **and** 443) → `127.0.0.1:8787`
  → vsock → enclave. TLS to the origin is a **self-signed cert** at
  `/etc/morpheus/tls/runtime.meshmini.app.{crt,key}`; the meshmini.app zone SSL mode is
  **Full** (non-strict), which accepts it — no public CA / certbot needed. SG already
  allows 443. DNS: `runtime.meshmini.app` A `32.199.39.216` proxied.
- **Control plane:** `MORPHEUS_EXECUTION_TOKEN` secret set = the enclave's
  `MORPHEUS_RUNTIME_TOKEN`; the two DLQ queues created
  (`morpheus-oracle-request-dlq`, `morpheus-feed-tick-dlq`); `wrangler deploy` done
  with the staged `MORPHEUS_{MAINNET,TESTNET}_EXECUTION_BASE_URL = runtime.meshmini.app/{net}`.
- **Validated live:** `/mainnet/oracle/smart-fetch` → BTC/USD computed in-TEE;
  Cloudflare-originated control-plane traffic confirmed in the box access log
  (`POST /mainnet/oracle/query → 200`, real responses); no-token → 401.
- **Attestation:** the web verifier (`app/api/attestation/verify`) takes
  `expected_pcr*` from the request body (caller-supplied), so the cutover needs **no
  web redeploy** — consumers that want measurement-pinning pass the exec PCRs above.

### Hardened EIF CUT OVER (2026-06-15)

Hardened EIF **`oracle-enclave-exec-2026-06-15.2`** (commit `1b435fc`) is **LIVE on
mainnet** — running **PCR0 `387a69cd1f6e9a69fb616bd326cab9f85f928439972ea1bfd88e1aefb767f3d6a3277272a1ffe4f43bb46d998384f0e2`**
(PCR1 kernel unchanged; manifest: `measurements/oracle-enclave-exec-2026-06-15.2.json`).
Carries the decrypt cache-poison fix + neodid salt-drift fix. Staged at
`/opt/morpheus/nitro/morpheus-oracle-exec-2.eif`; `MORPHEUS_NITRO_EIF` repointed +
`morpheus-nitro-signer` restarted. Validated: state RUNNING, signer:true,
smart-fetch 200 (rotated token), feed-pusher pushed on-chain (txid 0xd178733a…),
provision re-ran (n_keys 19, updater+oracle_verifier true, identity 03399c42
unchanged). **Rollback:** `MORPHEUS_NITRO_EIF` → `morpheus-oracle-exec.eif`
(`49a14225`, retained) + restart. NET-1 / EXP-1 / EGRESS-1 hardening still deferred to
a later EIF (needs caller-path verification of the relayer/feed-pusher
`/oracle/fulfill` + `/feed/sign` calls before tightening the in-enclave route match).

**Still on the dead placeholder (separate, larger follow-up — NOT this migration):**
`oracle.meshmini.app` / `edge.meshmini.app` (the `morpheus-edge-gateway` worker) is a
**full public oracle/AA API proxy** (`/providers`, `/feeds/*`, `/oracle/public-key`,
`/keys/derived`, `/paymaster/*`, `/relay/*`, `/vrf/*`, …) and still points its
`MORPHEUS_ORIGIN_URL` at the Vercel `emergency-runtime`. Re-pointing it to the box is
out of scope here: the box gateway deliberately serves only the 6 execution routes
("do NOT widen without review"). Restoring it = a separate "full oracle API in-TEE"
initiative (widen the passthrough + security review, or stand up a non-TEE API origin).
`/neodid/*` reaches the enclave but returns 400 until `WEB3AUTH_CLIENT_ID` is
provisioned; `/compute/execute` returns 400 until `MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS`.

## What this migrates (and what it does not)

The Cloudflare control plane (`control.meshmini.app`,
`deploy/cloudflare/morpheus-control-plane`) dispatches **confidential
execution-plane** jobs to an execution runtime base URL. Today that base URL list is
`oracle.meshmini.app → edge.meshmini.app → <phala>`, and **all three are dead or the
Vercel `emergency-vercel-runtime` placeholder** (`runtime_control_plane_disabled`)
— so every execution-plane lane is degraded.

This migration makes the **AWS Nitro box the execution runtime**, so the compute runs
**in-TEE** (the enclave worker), replacing Phala/Vercel.

Covered (the control plane's `EXECUTION_PLANE_ROUTES` /
`JOB_ROUTE_CONFIG` → `MORPHEUS_ORACLE_REQUEST_QUEUE`):
`/oracle/query`, `/oracle/smart-fetch`, `/compute/execute`, `/neodid/bind`,
`/neodid/action-ticket`, `/neodid/recovery-ticket`.

**Not covered by this migration** (separate paths — verify independently):

- `/feeds/tick` — feeds are already pushed on-chain by the box feed-pusher (in-TEE).
- `/callbacks/broadcast`, `/automation/execute` — route to `MORPHEUS_APP_BACKEND_URL`
  (the Vercel Next.js app), not the execution runtime.
- **AA paymaster / gasless relay** (gas-sponsor, aa-relay-console) — there is **no
  `/paymaster` route in the control plane**; that path is app-backend/chain-direct.
  The AA _contracts_ are live on-chain, so contract-interaction AA apps already work.

## Prerequisites

- `CLOUDFLARE_API_TOKEN` for the `morpheus-control-plane` worker (account
  `bf0d7e814f69945157f30505e9fba9fe`), with `wrangler`.
- DNS control for a runtime hostname (recommended: `runtime.meshmini.app`).
- A TLS cert for that hostname on the box.
- SSM access to the box (`i-0c52851f134db20ee`).
- **Decision:** this exposes the enclave's 8 Rust execution-plane routes publicly (auth-gated).
  The nginx gateway (`runtime-gateway.nginx.conf`) refuses everything else.

## Steps (ordered — each gates the next)

### 1. Build + deploy the execution-plane-capable enclave (maintenance window)

The native Rust execution route set is a **new EIF** → new PCRs. The measured
host has no passthrough target or Node child. Build it on the box:

```
cd /opt/neoos/services && git pull
MORPHEUS_RELEASE=oracle-enclave-exec-<date> \
MORPHEUS_NETWORK=mainnet \
SIGNER_SERVICE_URL=<custody-url> \
SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID=<raw-verifier-key-id> \
SIGNER_ROLE_UPDATER_KEY_ID=<raw-updater-key-id> \
SIGNER_ROLE_RELAYER_KEY_ID=<raw-relayer-key-id> \
SIGNER_ROLE_WORKER_KEY_ID=<raw-worker-key-id> \
  bash deploy/nitro/build-enclave-eif.sh --verify-reproducible
```

Record PCR0/1/2 → commit a new `deploy/nitro/measurements/<release>.json` (the
attestation verifier serves it). EXPECTED PCR0 (reproducible, this commit): `49a142254c73cd4a299b74d78db7f459f3857c6b589cc7c0f67df9657b0f763da76cf29f2d652035aa431608c5f4e281` (full manifest: deploy/nitro/measurements/oracle-enclave-exec-2026-06-15.json).

Cut over (same staged pattern as the original cutover): point
`MORPHEUS_NITRO_EIF` in `/opt/morpheus/nitro/morpheus-nitro.env` at the new EIF and
`systemctl restart morpheus-nitro-signer` (the egress + provision services re-run;
brief mainnet signing pause, relayer retries cover it). **Rollback:** repoint
`MORPHEUS_NITRO_EIF` to `morpheus-nitro-signer.eif` (current) and restart.

### 2. Stand up the public gateway on the box

```
cp deploy/nitro/runtime-gateway.nginx.conf /etc/nginx/conf.d/morpheus-runtime.conf
certbot certonly --nginx -d runtime.meshmini.app   # or install your cert at the paths in the conf
nginx -t && systemctl reload nginx
```

The gateway proxies ONLY the 8 execution routes (+ /health, /attestation) to
the existing vsock ingress `127.0.0.1:8787` → enclave. (No new box port is
exposed beyond 443.)

### 3. Execution token

The enclave auth-gates the native execution routes with its provisioned trusted tokens
(`MORPHEUS_RUNTIME_TOKEN` / `NITRO_API_TOKEN`, already provisioned). Set the control
plane's `MORPHEUS_EXECUTION_TOKEN` (wrangler secret) to that same token so its
`Authorization: Bearer` is accepted:

The first provisioning request is also authenticated with this host-held token:
`start-nitro-signer.sh` presents it in `Authorization` while provisioning the
same value. The EIF does not contain a bootstrap secret, and sensitive routes
fail closed until provisioning succeeds.

```
cd deploy/cloudflare/morpheus-control-plane && wrangler secret put MORPHEUS_EXECUTION_TOKEN
```

### 4. DNS

Point `runtime.meshmini.app` → the box public IP (`32.199.39.216`). Verify:

```
curl -s https://runtime.meshmini.app/health
curl -s -X POST https://runtime.meshmini.app/mainnet/oracle/smart-fetch \
  -H "authorization: Bearer <execution-token>" -H 'content-type: application/json' \
  -d '{"symbol":"BTC/USD"}'
```

### 5. Re-point the control plane (config already staged)

`wrangler.meshmini.toml` already sets `MORPHEUS_{MAINNET,TESTNET}_EXECUTION_BASE_URL =
https://runtime.meshmini.app/{network}`. Deploy:

```
cd deploy/cloudflare/morpheus-control-plane && wrangler deploy --config wrangler.meshmini.toml
```

Validate: submit an oracle HTTP request through the control plane and confirm it is
fulfilled via the box (the box's egress proxy logs the provider fetch).

### 6. Retire the Vercel placeholder

Once execution flows through the box, disable / re-point the
`apps/web/app/api/emergency-runtime` placeholder so `oracle.meshmini.app` /
`edge.meshmini.app` no longer report `degraded`.

## Per-lane notes (validate after deploy)

- `/oracle/smart-fetch`, `/oracle/query`: need provider egress — already wired
  (the enclave egress proxy + allowlist). Should work out of the box.
- `/neodid/*`: the salt is provisioned (see provision-enclave-compute.sh), but
  **web3auth verification additionally needs `WEB3AUTH_CLIENT_ID`** (not on the box —
  supply it via the provision env if neodid web3auth is required).
- `/compute/execute`: gated by `MORPHEUS_ENABLE_UNTRUSTED_SCRIPTS` (off by default).
- The worker's result-signing for these lanes uses the provisioned signer keys; if a
  lane returns unsigned/`success:false` on "key" errors, extend
  `provision-enclave-compute.sh` to provision that lane's key (same pattern as the
  decrypt key).
