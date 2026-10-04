# Testnet runtime isolation: remediation and release gate

> **Current topology decision (2026-10-03):** The deleted TestNet server is
> not being restored. The target is one approved Nitro host with separately
> supervised mainnet and TestNet profiles. Follow
> [`../../docs/runbooks/NITRO-SINGLE-HOST-DUAL-NETWORK-20261003.md`](../../docs/runbooks/NITRO-SINGLE-HOST-DUAL-NETWORK-20261003.md).
> References below to a second instance or separate host are historical
> alternatives and must not be executed under the current decision.

Prepared 2026-09-05. No service was deployed, restarted, provisioned, signed, or funded during this investigation. Current public testnet service remains unavailable. Local evidence is in `D:/Git/neo-os/qa-artifacts/network-remediation/`. Project maintenance and remediation are already authorized; the remaining blockers are missing verifiable deployment targets, operational identities and isolated configuration, not another permission step.

## Confirmed cause

The public route chain is:

```text
oracle.meshmini.app or edge.meshmini.app /testnet/health
  → Cloudflare morpheus-edge-gateway
  → www.morpheus-matrix.dev/api/runtime/health?network=testnet
  → runtime.meshmini.app/health (previous default)
  → nginx /etc/nginx/conf.d/morpheus-runtime.conf
  → 127.0.0.1:8787 → one enclave configured for mainnet
```

TLS-verified read-only probes establish that `/health`, `/mainnet/health`, and `/testnet/health` directly on `runtime.meshmini.app` all return HTTP 200 with `network: "mainnet"`. The web and outer gateways correctly refuse that mainnet result on testnet with HTTP 503 `runtime_network_mismatch`. The outer worker is not losing the selected network.

`deploy/nitro/runtime-gateway.nginx.conf` forwards both prefixes to the same listener. The deployed Node enclave reports its process `MORPHEUS_NETWORK`; a route prefix is not an independently configured instance. Merely adding a `/testnet` alias, relabeling the response, removing the mismatch guard, or pointing both origins at the same listener does not fix the service.

The checked-in historical dual-network request-hub Compose files are marked **Node compatibility only**, not the current Rust production authority. Their presence is not evidence of a running isolated testnet enclave. The current deployment record identifies only mainnet instance `i-0c52851f134db20ee` and the public runtime hostname. This workstation could not verify a separate live testnet instance.

## Local changes ready for review

- `apps/web/lib/runtime-health.ts` preserves the selected network in the default health path. Explicit per-network URLs remain authoritative. Success requires HTTP 200, a verified matching network, boolean `ready:true`, and no contradictory declared status. Missing, null, string or numeric readiness cannot imply success. The streamed body is limited to 64 KiB and an independent 8-second deadline covers headers and every body read, including transports that ignore abort. Oversized/hung responses are cancelled; malformed raw body strings and private transport details are never returned.
- `scripts/check-runtime-networks.mjs` checks **all eight paths**: runtime, oracle, edge, and web, each on mainnet and testnet. A path passes only with HTTP 200, the exact expected network, boolean `ready:true`, and no contradictory declared status. It uses only GET without credentials, normal TLS validation, bounded time/body, and no redirects. Any failed path makes the command exit 1. The health helper, release probe and nginx preparer share this readiness rule.
- `scripts/render-runtime-network-gateway.mjs` prepares a separate-upstream nginx candidate. Both origins must be distinct numeric loopback HTTP listeners. Before writing, the CLI probes each listener's corresponding health path and requires HTTP 200, the exact network, and `ready:true`. It preserves the existing endpoint and Cloudflare allowlists and does not overwrite an existing output file. It does not install or reload nginx.

No Rust migration, custody implementation, current startup scripts, existing deployment topology, or credentials were overwritten. The original nginx template remains untouched until an operator selects and verifies the actual testnet listener; the renderer creates the concrete replacement only after that proof.

## Required isolated TestNet profile on the approved host

An operator must first identify or provision the TestNet execution profile on
the approved host. The following are requirements, not claims that these
resources already exist:

| Item                 | Required value or proof                                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Target               | The single approved Nitro host and region, with verified spare capacity for a separately supervised TestNet profile                                                                                                                                    |
| Release              | Verifiable execution EIF digest/PCRs and corresponding reproducible source release; do not deploy the mixed uncommitted Rust migration workspace                                                                                                       |
| Runtime network      | `MORPHEUS_NETWORK=testnet` in the provisioned execution configuration, verified by the instance's own health response                                                                                                                                  |
| Neo N3 identity      | Testnet RPC whose `getversion.protocol.network` is `894710606`, testnet contract hashes, and testnet-specific signer role IDs/public identities                                                                                                        |
| Key material         | Independently configured testnet custody authorization and attestation-bound sealed material; do not copy mainnet WIFs, private keys, role IDs, or token envelopes                                                                                     |
| Storage and config   | Dedicated testnet configuration files, journal/data directories, state/cursor namespaces and service unit; no mainnet default paths                                                                                                                    |
| Host topology        | Existing frontier is CID 16 / host port 8787; custody is CID 17 / host port 8789; egress uses 8788. TestNet must use a separately supervised profile on the same approved host, subject to the capacity gate                                           |
| Candidate topology   | CID 18 / loopback port 8791 is an **unallocated proposal**, usable only after operator checks show it is free on the approved host; no second host is required                                                                                         |
| Capacity             | Adequate Nitro allocator CPU/memory for both profiles and their custody arrangement; if unavailable, stop and escalate rather than weakening isolation                                                                                                 |
| Startup safety       | Do not invoke the existing startup script with default arguments: it terminates the enclave occupying the configured CID. Its run-report output is also currently global. A reviewed isolated service must avoid CID reuse and mainnet path overwrites |
| Confidential callers | The control-plane and direct confidential gateway credentials must be authorized for the isolated testnet runtime. A healthy public probe does not establish this. Keep those credentials server-side and validate with a non-signing capability check |

This is not a complete ready-to-start TestNet profile because verified host capacity, a verifiable candidate EIF/release, isolated credentials, allocation, and service identity are not available on this workstation. Do not fill those gaps using mainnet settings or by creating a second host.

## Concrete preparation and cutover sequence

The following commands are a concrete deployment plan. They were **not executed against a host** because its target and access configuration are not confirmed. First confirm the actual listener instead of assuming the proposed port 8791 exists. Run preparation from the verified `neo-os-services` release checkout on the runtime host.

1. Read the host topology without dumping environment files or credentials:

   ```sh
   sudo nitro-cli describe-enclaves
   sudo ss -lntp
   sudo systemctl status morpheus-nitro-signer --no-pager
   ```

   Resolve the isolated-profile prerequisites above. `describe-enclaves` must show distinct profile identities; an nginx alias is not sufficient. Do not restart mainnet to change its process network.

2. After an isolated testnet listener exists and is ready, create a candidate. Substitute the verified listener if different:

   ```sh
   node scripts/render-runtime-network-gateway.mjs \
     --mainnet=http://127.0.0.1:8787 \
     --testnet=http://127.0.0.1:8791 \
     --output=/tmp/morpheus-runtime.split-networks.conf
   ```

   A same-network listener or unavailable testnet listener makes this command fail before any file is written. Review the generated mapping and retain `/health` as the legacy mainnet liveness path. `/<network>/...` must route to that network's actual process.

3. Once the target, access configuration, and isolated runtime checks are established, validate the generated configuration with the host's nginx and existing TLS files. Prepare a backup of `/etc/nginx/conf.d/morpheus-runtime.conf` and install the verified candidate:

   ```sh
   sudo cp -p /etc/nginx/conf.d/morpheus-runtime.conf /etc/nginx/conf.d/morpheus-runtime.conf.pre-network-split
   sudo install -m 0644 /tmp/morpheus-runtime.split-networks.conf /etc/nginx/conf.d/morpheus-runtime.conf
   sudo nginx -t
   sudo systemctl reload nginx
   ```

   Execute reload only if `nginx -t` succeeds. On validation failure, restore the backup and validate again before any reload. This workstation has not run nginx configuration validation; the host's installed nginx, certificates and include context are required. The renderer uses nginx's documented [map](https://nginx.org/en/docs/http/ngx_http_map_module.html) and [variable upstream proxying](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass).

4. In the deployed `apps/web` project serving `www.morpheus-matrix.dev`, set server-side configuration:

   ```text
   MORPHEUS_BOX_HEALTH_URL_MAINNET=https://runtime.meshmini.app/mainnet/health
   MORPHEUS_BOX_HEALTH_URL_TESTNET=https://runtime.meshmini.app/testnet/health
   ```

   Existing production code already supports these scoped variables. Publish/redeploy the verified web release and environment change; the locally patched default removes the need for a global unscoped fallback in future releases. The project ID and deployment identity are not linked on this workstation, so no guessed Vercel deployment command is provided. The public Cloudflare origins can continue pointing to the same web deployment; changing them is unnecessary when its selected-network probe is correctly configured.

5. Run the complete release gate from a workstation with TLS validation:

   ```sh
   node scripts/check-runtime-networks.mjs --output=/tmp/runtime-network-release.json
   ```

   All runtime, oracle, edge and web health paths must pass for both networks. Inspect the JSON `actualNetwork` values, not just the exit code or HTTP status. This is identity/liveness verification; it does not send transactions or validate confidential signing workflows. Keep the mainnet results as the regression guard.

6. If the cutover fails, restore the exact previous nginx configuration and web environment values from the operator's backup. Preserve failed probe evidence and the isolated TestNet profile for diagnosis. Do not relabel mainnet responses as testnet or disable identity checks to make the gate pass.

## Access still needed

- An AWS/SSM identity or confirmed SSH host/user/port mapping authorized to inspect the actual testnet target. The current session has no AWS CLI, AWS environment credentials, or local AWS profile. A local SSH key exists but no target configuration establishes its authorization for the runtime host; no speculative SSH connection was attempted.
- Wrangler `whoami` reports **not authenticated**. The documented Cloudflare account is not evidence that the current workstation has access. Cloudflare access is needed only if an operator determines that DNS/worker/runtime credentials must change.
- The deployed web project ID/team and deployment identity, if its scoped health variables need updating.
- The verifiable candidate testnet execution/custody EIF and release, network configuration and sealed credentials, plus an explicit slot or host assignment.

No credentials should be pasted into the repository, generated nginx file, evidence logs, or public output. The operator can provide protected local configuration paths or use their existing deployment secret manager.

## Verification and current result

- Runtime health unit tests: **25 passed** (`runtime-health-tests.json`), including strict readiness, contradictory status, oversized UTF-8 bodies, hanging headers, hanging body reads, and safe failures.
- Network probe and gateway preparation tests: **14 passed** (`network-script-tests.tap`), including an actual local HTTP receiver, redirect refusal, missing/null/string readiness, and contradictory status. Total: **39 tests passed**.
- Focused runtime health TypeScript check: passed (`runtime-health-typecheck.log`). Full web TypeScript currently reports two pre-existing readonly `NODE_ENV` assignments in `__tests__/control-plane-auth.test.ts`; those unrelated tests were not changed.
- Live release probe: **4 mainnet paths passed, 4 testnet paths failed** (`release-probe.json`). Testnet runtime itself returns HTTP 200 with mainnet identity; the other three surfaces correctly return HTTP 503. This remains a deployment blocker, not a completed live remediation.
- An intermediate probe saw transport/invalid-body failures on three paths (`release-probe-transient.json`); one follow-up recovered the stable 4/4 network result above. Liveness is a point-in-time observation, not a guarantee that every request succeeds.
- No real network-specific execution, fund transfer, order, signature, notification, provisioning, or deployment was performed.
