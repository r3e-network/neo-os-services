# NeoOS Canonical Domain Deployment

Deployment date: 2026-09-10 UTC

The following Cloudflare Workers were deployed from the current workspace and
are attached to the `neoos.network` zone:

| Host | Worker | Evidence |
| --- | --- | --- |
| `admin.neoos.network` | `neoos-admin-proxy` | Canonical callback accepted by Auth0; real-user session acceptance pending |
| `aa.neoos.network` | `neoos-aa-proxy` | HTTPS custom domain active |
| `fura.neoos.network`, `indexer.neoos.network` | `neoos-fura-proxy` | HTTPS custom domains active; upstream routes retain their existing API contract |
| `runtime.neoos.network` | `neoos-runtime-proxy` | `GET /health` returns runtime health JSON |
| `mcp.neoos.network` | `neoos-mcp-proxy` | `GET /healthz` returns 200; unauthenticated `POST /mcp` returns 401 |
| `services.neoos.network` | `neoos-service-gateway` | Root catalog returns fixed service prefixes; `/mcp/healthz` reaches the MCP upstream |
| `explorer.neoos.network` | `neoos-explorer-redirect` | Redirects to `https://www.neo3scan.com/` |

`services.neoos.network` is a fixed-prefix gateway. It exposes `/fura/*`,
`/mcp/*`, `/runtime/*`, and `/control/*`; unknown prefixes return 404. The
gateway does not accept a caller-provided origin and preserves request
authentication headers.

Admin source deployment remains aliased to `admin.neomini.app` internally.
The application now separates public APP_ORIGIN (`https://admin.neoos.network`)
from fixed INGRESS_ORIGIN (`https://admin.neomini.app`). OIDC authorization,
code exchange, return URLs and CSRF use the public origin;
Host validation uses the explicit ingress. Forwarded headers cannot authorize
a Host. Auth0 now accepts the canonical callback and signed-out URLs, retaining
legacy entries and existing roles. Management MFA and white-list changes were
explicitly authorized by the user.

Correction: earlier claims that rewriting the authorization Location alone
completed this migration were incorrect. Authorization and code exchange must
use exactly the same redirect_uri. The proxy now preserves external OIDC URLs
and separate Set-Cookie fields. Production login returns the canonical URI and
a host-only transaction cookie; Auth0 accepts it with 302. A real-user login
and authenticated mutation session have not yet been fully verified.

## Reproduction

```bash
cd neo-os-services
npm test
node --test deploy/cloudflare/*/worker.test.mjs
node --test deploy/cloudflare/lib/*.test.mjs
node scripts/verify-canonical-domains.mjs /tmp/neoos-canonical-domains.json
```

The public probes used for this release are read-only. Fura/Indexer root
requests return the upstream API's 404 because those services expose their
versioned API routes rather than a root health page; this is not treated as a
proxy failure. Contract deployment and global-vault migration remain separate
chain release gates and were not changed by this edge deployment.

## 2026-09-10 Remediation Deployment

Overall `releaseReady=false`. These edge deployments do not deploy the Services,
Fura, Indexer or MCP backend binaries and do not imply fleet acceptance.

| Worker | Deployed version |
| --- | --- |
| neoos-admin-proxy | 6ceed24d-befb-406b-9c28-0cc8e0791552 |
| neoos-aa-proxy | 1f870ef9-bce3-4bfc-b7d1-c62926e9d9b9 |
| neoos-fura-proxy | 906248df-dfd7-49ae-9f02-5882453f73bf |
| neoos-runtime-proxy | 06e463b9-14ea-42d5-b866-088c12f4b781 |
| neoos-mcp-proxy | eb5d4062-610d-4c5f-b8a7-76aac8563813 |
| neoos-service-gateway | e1fe8315-fe51-4c36-88e1-2861c4e84572 |
| neoos-explorer-redirect | d8a2a3f0-6451-4963-a35a-879d39bc4800 |

Admin Vercel deployment `dpl_65nfJBQSPktF8pb6ThbhMG2xJehf` was promoted after
build/tests and Auth0 callback acceptance. Its URL is
https://neo-os-admin-pfdxssi2t-jimmys-projects-f05d0acf.vercel.app.

The gateway and Runtime proxy share a mainnet-only enclave check and refuse
TestNet before fetch, including encoded/case variants. Gateway parsing preserves
internal/trailing slashes and rejects ambiguous or inherited-property routes.
All forwarding proxies use manual redirects, stripping untrusted routing
headers and preserving method, body, authentication and protocol headers.
Response headers have a 15-second default deadline with non-cacheable 502/504
failures. Both MCP paths use 310 seconds to allow the backend's documented
300-second request lifetime; established SSE streams remain open. A fake-clock
regression test verifies both MCP entrypoints survive 300 seconds and abort at
310 seconds. A real long-duration subscription is still outside this evidence.

Explorer now redirects directly to www.neo3scan.com, preserving path/query and
removing the previous extra redirect through neo3scan.com.

| Verification | Result |
| --- | --- |
| Admin full suite | 462 passed; 3 existing skipped |
| Admin build and typecheck | Passed; 17 NeoPkg traces and 5 schemas verified |
| Local full OIDC integration | 3 passed: local HTTP IdP, PKCE, RSA signature, session, CSRF, logout, role/state/nonce failures and code reuse |
| Cloudflare suites | 83/83 passed in final combined run; /tmp/neoos-edge-final-tests-20260910.log |
| Services scripts | 228 passed |
| Rust config-schema tests | 4 passed |
| Rust format/generated identity | Passed |
| TLS-verified canonical production probes | 12/12 passed |

The existing control-plane CI matrix lane now runs `npm run test:cloudflare`
so every new proxy and shared helper is included in future CI runs. The Admin
session audience remains its existing purpose-specific identifier; public
domain scoping is supplied by host-only cookies and explicit origin checks.

Production evidence: `/tmp/neoos-canonical-domains-20260910.json`, checked at
2026-09-10T10:28:11Z. Mainnet indexer was ready with lag 0 and height 13108302;
the block endpoint returned height 13108303. Fura getversion returned mainnet
magic 860833102 and TestNet magic 894710606. Runtime mainnet reported compute
and signer healthy. Both TestNet Runtime ingress paths refused with 503.
MCP liveness and unauthenticated refusal passed. Using the existing Explorer
server credential without exposing it, authenticated server/discover and
tools/list passed (58 tools). get_block_height with chain=n3, network=mainnet
returned height 13108551 and blockCount 13108552 through both canonical MCP
entrypoints. The documentation's obsolete get_block_count example failed with
tool-not-found and was corrected to match the actual advertised tool schema.

Admin production negative checks passed: unauthenticated registry API 401,
invalid callback 400, and cross-origin logout 403. The real Chrome browser
reached the branded Auth0 login page from admin.neoos.network.
The subsequent GitHub login reached consent for Auth0's public-profile-only
social application (`FDR Social Dev Keys V2 - US`). That final consent remains
pending; no administrator role was assigned or changed during this check.
The tenant/social development-key configuration also needs production review.

After the final MCP/gateway deployment, both authenticated get_block_height
calls passed again at mainnet height 13108659. The 10:46Z full read-only run
had two client-side fetch failures on runtime.neoos.network (10/12), without
an HTTP response. TLS-verified curl checks via normal resolution and explicit
Cloudflare address both returned healthy JSON. The next full run passed 12/12
at 2026-09-10T10:48:15Z; evidence is retained separately at
`/tmp/neoos-canonical-domains-20260910-final.json` (failed run) and
`/tmp/neoos-canonical-domains-20260910-recheck.json` (passing rerun).

### Remaining Work

1. Real authorized Admin login, protected pages, authenticated mutations and
   logout. Legacy direct Admin entry remains transitional; new browser sessions
   should start from the canonical domain.
2. The parallel Admin capability signer has been retired after confirming no
   Host/MCP/app runtime consumers. The supported Registry package and permission
   authority remains in place. See the follow-up deployment below; no Web
   private key was installed.
3. Broader MCP tool coverage and real long-running subscription verification.
   Discovery and one real chain-read tool through both ingress paths passed.
   SSH to the documented host closed before authentication, so backend
   deployment provenance was not refreshed over SSH.
4. Backend deployment provenance, automation wiring and separate TestNet runtime.
5. Contract legacy liability migration, fresh chain acceptance, and per-app/game
   business, asset, integration and UX acceptance.

### Admin Follow-Up: Capability Authority

The active Admin deployment is now `dpl_GZJLcdcE2uffLVxL8tYPDXaHhPV8`,
https://neo-os-admin-kjpvytvbj-jimmys-projects-f05d0acf.vercel.app, promoted on
2026-09-10 after 474 tests, typecheck, build and 17 NeoPkg trace checks. The
immediately previous deployment is `dpl_65nfJBQSPktF8pb6ThbhMG2xJehf`.

The experimental capability API now returns authenticated 410 with a Registry
successor link. It no longer reads a Web signing key, mutates a parallel hash
chain or reports a non-null hash as cryptographic verification. Historical data
is retained. The workspace's standalone signing/catalog scripts refuse execution
and point to the Registry publisher. Current permission and package workflows
were included in the test run. This is retirement of an unused authority path,
not a new TEE capability attestation service.

The final production refusal/login checks passed 7/7 at 11:12:33Z. Login returns
307 to Auth0 with `https://admin.neoos.network/auth/callback`; unauthenticated
capability GET/POST return 401, invalid callback returns 400, and cross-origin
logout returns 403. Authenticated production operator actions remain unverified.
The 11:08:32Z public domain probe passed 12/12; mainnet Indexer lag was zero.

Live on-chain alias verification passed all 99 configuration rows and 117 unique
names across mainnet/TestNet, checking genesis, magic, resolver/target existence,
valid Neo address checksums and equality with approved contract pins. The fresh
TestNet platform-artifact scan still found five differences, one match and one
entry without a deployment record. These results do not authorize an unsafe
upgrade or establish source/NEF equivalence or financial lifecycle acceptance.

Evidence is retained in `docs/reports/canonical-domains-20260910-admin-retirement.json`,
`docs/reports/admin-production-20260910-retirement.json` and the contracts repo's
`docs/reports/contract-aliases-live-20260910.json` and
`docs/reports/platform-contract-testnet-live-20260910.json`.

### Earlier Rollback References

Previous Admin: `dpl_ASVDgvEtxs3EhdSq2twpWi2PxS66`. Old deployments retain their
environment snapshots; a rollback also requires restoring legacy APP_ORIGIN
for future builds. Keep legacy Auth0 URLs during the transition.

Previous workers: Admin `e907e1a8-d923-40cd-b69c-45d35a8eb83c`, AA
`14c50e32-dabf-4b60-8b13-a73f75c0bb18`, Fura
`2dd1f506-345f-4853-95a8-72ca1b7eab4d`, Runtime
`8460da45-1fc6-4445-b272-4bdd37093831`, MCP
`b3526a90-d12b-4567-9b87-745ef39adace`, Services
`f4cf0a60-a366-4b0c-9d62-9958e811f09d`, Explorer
`f157b380-61d4-4f1c-8926-15e334a601c0`.
Use Wrangler rollback with the corresponding config. The old Services gateway
contains the TestNet bypass; disable its runtime route before such a rollback.

### Rust Configuration Correction

The generator explicitly unions JS shared controls with four Rust-only controls:
MORPHEUS_ALLOW_UNAVAILABLE_AUTOMATION, MORPHEUS_DELIVERY_PROTOCOL,
MORPHEUS_N3_RECONCILIATION_ARCHIVE_RPC_URLS, MORPHEUS_ALLOW_LEGACY_LOCAL.
Their consumers were verified in the Rust relayer. This restores keys that the
previous regeneration incorrectly dropped, while preserving generator identity
and the Rust test that requires these runtime controls to remain recognized.
