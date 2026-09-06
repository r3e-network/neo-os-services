# User Guide

This guide explains how to use the four main Morpheus capabilities:

- **Privacy Compute**
- **Privacy Oracle**
- **Datafeeds**
- **NeoDID**

It also explains how to inspect supported built-in providers and feed pairs, and how to use the public NeoDID DID resolver.

The on-chain N3 model now follows `miniapp-os + miniapps`:

- `MorpheusOracle` is the shared kernel contract
- built-in modules provide common fetch / compute / identity / shared resource capabilities
- miniapps should focus on business logic instead of reimplementing generic request plumbing
- `OracleCallbackConsumer` is an optional external adapter, not the canonical callback surface

Current architecture note:

- Cloudflare owns public ingress, control-plane routing, queue/workflow orchestration, and recovery.
- Supabase owns durable request, job, automation, and feed state.
- The Oracle CVM handles built-in fetch/query, compute, and NeoDID execution for both mainnet and testnet.
- The DataFeed CVM is isolated so continuous shared resource publication is not blocked by interactive workloads.

Important production rule:

- End users should use Oracle and Compute through the on-chain Morpheus kernel contract plus async fulfillment.
- End users should use NeoDID bind / action / recovery flows through the same shared kernel contract.
- The direct HTTP routes in this guide are for local development, operator workflows, and payload debugging.
- `datafeed` sync is operator-only. User contracts read synchronized on-chain shared resource records directly.
- Each request currently costs `0.01 GAS`-equivalent.
- Neo N3 supports prepaid fee credits, including contract-sponsored payment.
- Neo N3 is the only active supported runtime path right now.
- Some route names and examples still use legacy oracle-shaped naming for compatibility.

## Canonical Network Registry

Always treat these files as the source of truth before copying an address into a frontend, contract, or runbook:

- `config/networks/mainnet.json`
- `config/networks/testnet.json`

Current Neo N3 anchors:

| Item                        | Mainnet                                                | Testnet                                                |
| --------------------------- | ------------------------------------------------------ | ------------------------------------------------------ |
| Oracle Runtime URL          | `https://oracle.meshmini.app/mainnet`                  | `https://oracle.meshmini.app/testnet`                  |
| Oracle Attestation          | in-app `POST /api/attestation/verify` (or `/verifier`) | in-app `POST /api/attestation/verify` (or `/verifier`) |
| DataFeed Attestation        | in-app `POST /api/attestation/verify` (or `/verifier`) | in-app `POST /api/attestation/verify` (or `/verifier`) |
| MorpheusOracle Kernel       | `0xf54d8584ef82315c1800373272ab08ae0db2d5ef`           | `0xf54d8584ef82315c1800373272ab08ae0db2d5ef`           |
| OracleCallbackConsumer Opt. | `0xe1226268f2fe08bea67fb29e1c8fda0d7c8e9844`           | `0x0ac1fa9cdcb66c1672f0642f62d767902f460f2b`           |
| MorpheusDataFeed Module     | `0x03013f49c42a14546c8bbe58f9d434c3517fccab`           | `0x9bea75cf702f6afc09125aa6d22f082bfd2ee064`           |
| AbstractAccount             | `0x0268a387913b250166ddec032b03332690a1ef78`           | `0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2`           |
| AA Web3AuthVerifier         | `0xf5c452cd4ba29dcdc47026383568c0d8b38d9272`           | `0x1111f5b6b046a964c75d208998c13945ce172e85`           |
| AA RecoveryVerifier         | `0x198b3a9cec9bccc2110d19bd929b10374a9d034d`           | `recovery.smartwallet.neo`                             |
| NeoDIDRegistry              | `0xb81f31ea81e279793b30411b82c2e82078b63105`           | unpublished                                            |
| Oracle NNS                  | `oracle.morpheus.neo`                                  | unassigned                                             |
| DataFeed NNS                | `pricefeed.morpheus.neo`                               | unassigned                                             |
| AA NNS                      | `smartwallet.neo`                                      | unassigned                                             |
| AA alias NNS                | `aa.morpheus.neo`                                      | unassigned                                             |
| NeoDID NNS                  | `neodid.morpheus.neo`                                  | unassigned                                             |

Operational notes:

- the MorpheusOracle kernel hash is identical on testnet and mainnet (`0xf54d8584ef82315c1800373272ab08ae0db2d5ef`); the retired legacy v1 testnet oracle `0x4b882e94ed766807c4fd728768f972e13008ad52` still serves legacy `requestFromCallback` lanes only — do not point new integrations at it
- the canonical testnet optional callback adapter for shared infra is `0x0ac1fa9cdcb66c1672f0642f62d767902f460f2b`
- the current testnet example consumer used by live validation probes resolves to the same shared optional adapter deployment
- testnet NeoDID registry remains unpublished in the shared registry until a stable shared deployment is intentionally promoted
- `UnifiedSmartWalletV3` is the stable AA runtime name; raw deployment manifest suffixes are internal deployment metadata rather than user-facing contract names
- mainnet AA ecosystem contracts are also published under `smartwallet.neo` subdomains such as `core.smartwallet.neo`, `web3auth.smartwallet.neo`, and `recovery.smartwallet.neo`
- `aa.morpheus.neo` now resolves to the same canonical mainnet AA address as `smartwallet.neo`; treat it as an additional alias, not the primary public name

## 1. Concepts

### Privacy Compute

Use Morpheus as an off-chain trusted coprocessor for expensive logic that is not practical on-chain.

Typical cases:

- ZKP preprocessing or witness hashing
- FHE planning and parameter estimation
- matrix / vector operations
- custom script execution in the TEE

### Privacy Oracle

Use Morpheus when you need to fetch external data and optionally process it inside the TEE before returning a derived result.

Typical cases:

- fetch a private API using an encrypted secret
- run a script on sensitive API output
- return only a boolean / score / filtered result on-chain

### Datafeeds

Use Morpheus datafeeds as the primary shared numeric resource registry that user contracts read directly.

Important properties:

- feed publication runs on the isolated DataFeed CVM
- all feed pairs are normalized to `*-USD`
- Morpheus does **not** aggregate or medianize providers
- each provider is stored independently on-chain as `PROVIDER:PAIR`
- prices are stored as scaled USD integers with global precision `1 USD = 1,000,000`
- threshold checks are evaluated against the quantized on-chain integer price, not unbounded source decimals
- example storage pairs:
  - `TWELVEDATA:NEO-USD`
  - `BINANCE-SPOT:NEO-USD`

### NeoDID

Use NeoDID when you need privacy-preserving identity binding, unlinkable action authorization, or AA social recovery.

Important properties:

- production identity issuance still enters through the shared kernel request + async fulfillment path
- the public DID resolver exposes service topology and verifier material, not private claims
- `provider_uid`, JWT claims, master nullifiers, and action nullifiers remain private
- Web3Auth JWT verification happens inside the TEE for `provider = "web3auth"`
- current public service DID is `did:morpheus:neo_n3:service:neodid`

## 2. Privacy Compute Usage

These direct `/compute/*` HTTP examples are for development and operator testing. In production, the same payloads
should be carried through the on-chain kernel request path.

### Built-in functions

List built-ins:

```bash
curl http://localhost:3000/api/compute/functions
```

Or call the worker directly:

```bash
curl "$MORPHEUS_RUNTIME_URL/compute/functions" \
  -H "Authorization: Bearer $MORPHEUS_RUNTIME_TOKEN"
```

Built-in examples:

```json
{
  "mode": "builtin",
  "function": "zkp.public_signal_hash",
  "input": {
    "signals": ["1", "2", "3"]
  },
  "target_chain": "neo_n3"
}
```

```json
{
  "mode": "builtin",
  "function": "fhe.noise_budget_estimate",
  "input": {
    "multiplicative_depth": 3,
    "scale_bits": 40,
    "modulus_bits": 218
  },
  "target_chain": "neo_n3"
}
```

Call through web API:

```bash
curl http://localhost:3000/api/compute/execute \
  -H 'content-type: application/json' \
  -d '{
    "mode":"builtin",
    "function":"zkp.public_signal_hash",
    "input":{"signals":["1","2","3"]},
    "target_chain":"neo_n3"
  }'
```

### Custom script compute

Example:

```json
{
  "mode": "script",
  "script": "function run(input) { return input.a + input.b; }",
  "entry_point": "run",
  "input": { "a": 2, "b": 3 },
  "target_chain": "neo_n3"
}
```

Important notes:

- script execution is time-limited
- invalid entry points are rejected
- `script_ref` can fetch the script body from a Neo N3 contract getter when notification size is too small for inline source
- use built-ins whenever possible for stable semantics

Example registry-backed compute script:

```json
{
  "mode": "script",
  "script_ref": {
    "contract_hash": "<production-script-registry-hash>",
    "method": "getScript",
    "script_name": "sum"
  },
  "entry_point": "process",
  "input": { "a": 2, "b": 3 },
  "target_chain": "neo_n3"
}
```

### Confidential compute payloads

If you want the function name, script, or inputs to stay encrypted until they reach the TEE, fetch the Oracle public key first and encrypt a JSON payload patch.

Example confidential builtin call:

```json
{
  "encrypted_payload": "<encrypt({\"mode\":\"builtin\",\"function\":\"math.modexp\",\"input\":{\"base\":\"2\",\"exponent\":\"10\",\"modulus\":\"17\"},\"target_chain\":\"neo_n3\"})>"
}
```

The worker decrypts that JSON object inside the TEE, merges it into the request, executes it, and returns the kernel-ready result envelope.

## 3. Privacy Oracle Usage

These direct `/oracle/*` HTTP examples are also development/operator paths. End-user dApps should submit the payload
through the shared kernel contract and wait for async fulfillment. The route names remain legacy compatibility names for built-in module lanes.

There are two main paths.

### A. Built-in provider mode

Use a built-in provider such as `twelvedata`. Optional providers like `binance-spot` and `coinbase-spot` remain available for project-specific Oracle fetch flows, but production PriceFeed sync defaults to `twelvedata`.

Example:

```json
{
  "provider": "twelvedata",
  "symbol": "TWELVEDATA:NEO-USD",
  "json_path": "price",
  "target_chain": "neo_n3"
}
```

Request via web API:

```bash
curl http://localhost:3000/api/oracle/query \
  -H 'content-type: application/json' \
  -d '{
    "provider":"twelvedata",
    "symbol":"TWELVEDATA:NEO-USD",
    "json_path":"price",
    "target_chain":"neo_n3"
  }'
```

### B. Custom URL mode

Use a custom URL with optional encrypted secrets and optional script.

Example:

```json
{
  "url": "https://api.example.com/private",
  "method": "GET",
  "headers": {},
  "encrypted_token": "<base64 ciphertext>",
  "encrypted_params": "<base64 ciphertext with secret headers/body/provider params/script>",
  "token_header": "Authorization",
  "script": "function process(data) { return data.score > 80; }",
  "target_chain": "neo_n3"
}
```

Request via web API:

```bash
curl http://localhost:3000/api/oracle/smart-fetch \
  -H 'content-type: application/json' \
  -d '{
    "url":"https://api.example.com/private",
    "encrypted_token":"<base64 ciphertext>",
    "encrypted_params":"<base64 ciphertext with secret headers/body/provider params/script>",
    "token_header":"Authorization",
    "script":"function process(data) { return data.score > 80; }",
    "target_chain":"neo_n3"
  }'
```

Important notes:

- `encrypted_token` is the cleanest choice when only an auth secret must stay private
- `encrypted_params`, `encrypted_input`, or a JSON-object `encrypted_payload` can carry confidential headers, provider params, compute input, function names, or scripts
- if the encrypted blob is too large for the chain request payload, first store it through `POST /api/confidential/store` and then carry only `encrypted_params_ref` / `encrypted_payload_ref` on-chain
- if the script body itself is too large for the request payload, move it into a Neo N3 contract getter and use `script_ref`
- Morpheus confidential payloads are sealed with `X25519-HKDF-SHA256-AES-256-GCM`
- the encrypted envelope includes an ephemeral X25519 public key plus AES-GCM ciphertext/tag fields

### Oracle public key

To encrypt user secrets locally, fetch the Oracle public key first:

```bash
curl http://localhost:3000/api/oracle/public-key
```

or directly from worker:

```bash
curl "$MORPHEUS_RUNTIME_URL/oracle/public-key" \
  -H "Authorization: Bearer $MORPHEUS_RUNTIME_TOKEN"
```

Returned fields:

- `algorithm`
- `public_key`
- `public_key_format`
- `key_source`
- `recommended_payload_encryption`
- `supported_payload_encryption`

### Confidential store for large encrypted payloads

Use this route when a JWT or encrypted JSON patch is too large to fit directly into the Oracle request payload:

> Auth note: this route is an operator channel and requires an operator admin key
> (`x-admin-api-key: <key>` header or `Authorization: Bearer <key>`). It is not a
> developer-facing public endpoint: application developers seal ciphertext locally and
> carry the short `encrypted_*_ref` on-chain (see the Neodid and privacy-oracle sections
> of `docs/EXAMPLES.md`). The developer-facing secret API is planned as part of the
> workflow secret management milestone.
>
> 鉴权说明：该路由是运维通道，需要 operator 管理密钥（`x-admin-api-key: <key>` 请求头或
> `Authorization: Bearer <key>`）。它不是面向开发者的公开端点：应用开发者应在本地密封
> 密文并在链上携带短引用 `encrypted_*_ref`（见 `docs/EXAMPLES.md` 的 Neodid 与隐私预言机
> 章节）。面向开发者的 secret API 计划在 workflow secret 管理里程碑中提供。

```bash
curl http://localhost:3000/api/confidential/store \
  -H 'content-type: application/json' \
  -H 'x-admin-api-key: <operator-admin-key>' \
  -d '{
    "ciphertext":"<sealed ciphertext>",
    "target_chain":"neo_n3",
    "project_slug":"<project-slug>"
  }'
```

Response:

```json
{
  "secret_ref": "<uuid>",
  "target_chain": "neo_n3",
  "encryption_algorithm": "client-supplied-ciphertext"
}
```

Then place only the short reference on-chain:

```json
{
  "encrypted_params_ref": "<uuid>"
}
```

## 4. Datafeeds Usage

### Query supported feed pairs

From web API:

```bash
curl http://localhost:3000/api/feeds/catalog
```

From worker directly:

```bash
curl "$MORPHEUS_RUNTIME_URL/feeds/catalog" \
  -H "Authorization: Bearer $MORPHEUS_RUNTIME_TOKEN"
```

Current default pair catalog includes:

- Core crypto:
  - `TWELVEDATA:NEO-USD`
  - `TWELVEDATA:GAS-USD`
  - `TWELVEDATA:BTC-USD`
  - `TWELVEDATA:ETH-USD`
  - `TWELVEDATA:SOL-USD`
  - `TWELVEDATA:TRX-USD`
  - `TWELVEDATA:BNB-USD`
  - `TWELVEDATA:XRP-USD`
  - `TWELVEDATA:DOGE-USD`
  - `TWELVEDATA:USDT-USD`
  - `TWELVEDATA:USDC-USD`
- Commodity / hard-asset:
  - `TWELVEDATA:PAXG-USD`
  - `TWELVEDATA:WTI-USD`
  - `TWELVEDATA:BRENT-USD`
  - `TWELVEDATA:NATGAS-USD`
  - `TWELVEDATA:WHEAT-USD`
  - `TWELVEDATA:CORN-USD`
  - `TWELVEDATA:SOY-USD`
- Equities / ETFs:
  - `TWELVEDATA:AAPL-USD`
  - `TWELVEDATA:GOOGL-USD`
  - `TWELVEDATA:MSFT-USD`
  - `TWELVEDATA:AMZN-USD`
  - `TWELVEDATA:TSLA-USD`
  - `TWELVEDATA:META-USD`
  - `TWELVEDATA:NVDA-USD`
  - `TWELVEDATA:SPY-USD`
  - `TWELVEDATA:QQQ-USD`
  - `TWELVEDATA:GLD-USD`
- FX:
  - `TWELVEDATA:EUR-USD`
  - `TWELVEDATA:GBP-USD`
  - `TWELVEDATA:JPY-USD` (inverted from `USD/JPY`)
  - `TWELVEDATA:CNY-USD` (inverted from `USD/CNY`)

With the global `1 USD = 1,000,000` scale, low-priced assets such as `TWELVEDATA:DOGE-USD` and `TWELVEDATA:JPY-USD` can be represented directly without basket pair names.

For the exact meaning of every canonical pair, including the real TwelveData source symbol and any inversion / scaling rule, read the canonical pair table in `docs/PROVIDERS.md`.

Canonical key note:

- use provider-scoped keys such as `TWELVEDATA:NEO-USD` and `TWELVEDATA:BTC-USD` in all new code
- the `TWELVEDATA:` prefix is part of the official on-chain key, not just a display alias

### Query current off-chain quotes

Single provider:

```bash
curl "http://localhost:3000/api/feeds/TWELVEDATA:NEO-USD?provider=twelvedata"
```

All available built-in providers for the pair:

```bash
curl "http://localhost:3000/api/feeds/NEO-USD"
```

This returns:

- `pair`
- `providers_requested`
- `quotes`
- `errors`

If multiple providers are requested, every successful quote is returned and every failed provider is listed in `errors`.
Production feed sync uses `twelvedata` by default unless you explicitly override `MORPHEUS_FEED_PROVIDERS`.

### Inspect feed candidates and publish through the Rust relayer

On-chain feed publication is operator-only. End users should not request
`datafeed` through the Oracle contract; such a request is rejected and finalized
with a failure callback.

The production publisher is `neo-os-relayer` running in `feed_only` or
`combined` mode with feed sync enabled. It calls the measured `/feed/sign`
route, broadcasts the custody-signed transaction, waits for a concrete HALT or
status-1 receipt, and only then advances its durable feed state.

Web cron/control-plane trigger:

```bash
curl http://localhost:3000/api/cron/feed/run \
  -H "X-Morpheus-Cron: $MORPHEUS_CRON_SECRET"
```

Production Vercel Cron is accepted by the Vercel cron user agent. Manual
operator probes use `MORPHEUS_CRON_SECRET` plus the cron BetterStack heartbeat
URLs configured in the `apps/web` deployment environment. The current
control-plane `/feeds/tick` lane is retired and returns `410 Gone`; when that
control plane is enabled, the web cron forwards the retired response instead of
claiming a successful publication. A scheduler invocation or heartbeat is
**not** evidence that a transaction was submitted. Validate on-chain freshness
through relayer delivery metrics and the confirmed contract state instead.
Validate the non-secret presence check with
`npm run check:web-cron-env -- --fail-on-missing`.

Direct host observation route:

```bash
curl "$MORPHEUS_RUNTIME_URL/oracle/feed" \
  -H "Authorization: Bearer $MORPHEUS_RUNTIME_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "symbol":"TWELVEDATA:NEO-USD",
    "target_chain":"neo_n3",
    "providers":["twelvedata"],
    "sync_all_sources":true,
    "wait":true
  }'
```

`/oracle/feed` is an observation, aggregation, and policy adapter. It does not
build or broadcast a chain transaction. `wait:false` returns `409` because the
host has no durable background queue. With `wait:true`, candidates that would
need publication are recorded as observations, reported as
`relay_status:"skipped"` with `skip_reason:"submission_unavailable"`, and the
request returns `503`; `batch_submitted` remains `false` and `anchored_tx`
remains `null`. `require_submission:true` makes the caller's intent explicit and
changes the error detail, but a pending update never produces a false-success
response. The Rust relayer owns publication.

Returned top-level fields include:

- `network`
- `target_chain`
- `symbols`
- `batch_submitted`
- `batch_count`
- `batch_tx`
- `sync_results`
- `errors`
- `state_persisted`
- `sync_policy`

Each provider result contains fields such as:

- `provider`
- `storage_pair`
- `relay_status`
- `skip_reason`
- `anchored_tx`
- `quote`

### On-chain storage model

For the active supported path, providers are stored and read on Neo N3.

Examples:

- `TWELVEDATA:NEO-USD`
- `BINANCE-SPOT:NEO-USD`

This means contracts can choose:

- one specific provider pair
- all stored pairs
- all feed records
- a price format that is always a 1e6-scaled USD integer, for example `2490000` = `2.490000`

### New on-chain DataFeed read methods

#### Neo N3

- `GetLatest(pair)`
- `GetPairCount()`
- `GetPairByIndex(index)`
- `GetAllPairs()`
- `GetAllFeedRecords()`

## 5. NeoDID Usage

These direct `/neodid/*` HTTP examples are development/operator paths. In production, the same payloads should be
be submitted on-chain through the shared kernel request path. The legacy-compatible
`MorpheusOracle.request(...)` flow remains available with:

- `neodid_bind`
- `neodid_action_ticket`
- `neodid_recovery_ticket`

### Resolve the public DID document

Resolve the service DID:

```bash
curl "http://localhost:3000/api/neodid/resolve?did=did:morpheus:neo_n3:service:neodid"
```

Resolve a document-only subject DID:

```bash
curl "http://localhost:3000/api/neodid/resolve?did=did:morpheus:neo_n3:aa:<aa-account-id>&format=document"
```

The public DID layer is for:

- service discovery
- verifier-key publication
- registry / Oracle / AA recovery endpoint hints

It is not for:

- provider UID disclosure
- JWT disclosure
- nullifier disclosure
- encrypted payload disclosure

### Inspect runtime and provider catalog

```bash
curl http://localhost:3000/api/neodid/runtime
curl http://localhost:3000/api/neodid/providers
```

The runtime response includes:

- `app_id`
- `compose_hash`
- `verification_public_key`
- `verifier_curve`
- `web3auth.jwks_url`
- `web3auth.audience_configured`

### Direct bind example

Standard provider:

```bash
curl http://localhost:3000/api/neodid/bind \
  -H 'content-type: application/json' \
  -d '{
    "vault_account":"0x6d0656f6dd91469db1c90cc1e574380613f43738",
    "provider":"github",
    "provider_uid":"github_uid_12345",
    "claim_type":"Github_VerifiedUser",
    "claim_value":"public_profile"
  }'
```

Web3Auth provider:

```bash
curl http://localhost:3000/api/neodid/bind \
  -H 'content-type: application/json' \
  -d '{
    "vault_account":"0x6d0656f6dd91469db1c90cc1e574380613f43738",
    "provider":"web3auth",
    "id_token":"<web3auth jwt>",
    "claim_type":"Web3Auth_PrimaryIdentity",
    "claim_value":"linked_social_root"
  }'
```

### Large JWT production pattern

For large Web3Auth JWT payloads:

1. fetch the Oracle public key
2. seal the JSON patch locally with `X25519-HKDF-SHA256-AES-256-GCM`
3. store the ciphertext through `POST /api/confidential/store`
4. submit only `encrypted_params_ref` on-chain inside the Oracle payload

### Action ticket example

```bash
curl http://localhost:3000/api/neodid/action-ticket \
  -H 'content-type: application/json' \
  -d '{
    "provider":"binance",
    "provider_uid":"binance_uid_12345",
    "disposable_account":"0x89b05cac00804648c666b47ecb1c57bc185821b7",
    "action_id":"Airdrop_Season_1"
  }'
```

### Recovery ticket example

```bash
curl http://localhost:3000/api/neodid/recovery-ticket \
  -H 'content-type: application/json' \
  -d '{
    "provider":"web3auth",
    "network":"neo_n3",
    "aa_contract":"0x0268a387913b250166ddec032b03332690a1ef78",
    "verifier_contract":"0x198b3a9cec9bccc2110d19bd929b10374a9d034d",
    "account_id":"<aa-account-id>",
    "new_owner":"0x89b05cac00804648c666b47ecb1c57bc185821b7",
    "recovery_nonce":"7",
    "expires_at":"1735689600",
    "encrypted_params":"<sealed payload>"
  }'
```

### Browser entrypoints

- live Web3Auth flow: `/launchpad/neodid-live`
- interactive DID resolver: `/launchpad/neodid-resolver`
- reference docs: `/docs/neodid`
- formal DID method spec: `docs/NEODID_DID_METHOD.md`

## 6. Mainnet Update Policy for Neo N3

For **Neo N3 mainnet**, automatic feed sync obeys two rules:

1. the same price pair is updated only if the fresh quote moved by more than **0.1%** versus the current on-chain stored value
2. the same storage pair is updated at most **once every 60 seconds**

Precision caveat:

- because the chain stores quantized integers, a raw source move that is still too small to change the stored on-chain integer value cannot trigger an update, even if that raw source move is already greater than `0.1%`
- with the current `1 USD = 1,000,000` scale, the standard catalog can use direct source-prefixed pairs such as `TWELVEDATA:DOGE-USD` and `TWELVEDATA:JPY-USD` without basket naming

These rules apply per stored provider pair, for example:

- `TWELVEDATA:NEO-USD`
- `BINANCE-SPOT:NEO-USD`

So one provider can update while another provider is skipped.

## 7. Built-in Provider Support

Current built-in providers:

- `twelvedata`
- `binance-spot`
- `coinbase-spot`

To inspect provider metadata:

```bash
curl http://localhost:3000/api/providers
```

or:

```bash
curl "$MORPHEUS_RUNTIME_URL/providers" \
  -H "Authorization: Bearer $MORPHEUS_RUNTIME_TOKEN"
```

## 8. How to Add New Pairs Later

There are two levels.

### Simple level: add symbols only

Set:

- `MORPHEUS_FEED_SYMBOLS`

Example:

```env
MORPHEUS_FEED_SYMBOLS=TWELVEDATA:NEO-USD,TWELVEDATA:GAS-USD,TWELVEDATA:BTC-USD,TWELVEDATA:ETH-USD,TWELVEDATA:SOL-USD,TWELVEDATA:WTI-USD,TWELVEDATA:AAPL-USD,TWELVEDATA:EUR-USD,TWELVEDATA:JPY-USD
```

### Advanced level: add provider-specific mapping

Set:

- `MORPHEUS_FEED_PAIR_REGISTRY_JSON`

Example:

```json
{
  "DOGE-USD": {
    "providers": {
      "twelvedata": { "symbol": "DOGE/USD" },
      "binance-spot": { "symbol": "DOGEUSDT" }
    }
  }
}
```

This is the correct place to add pairs whose provider symbols differ from the normalized `PAIR-USD` format.

## 9. Practical Recommendations

- use `privacy oracle` when you need fetch + optional secret + optional compute
- use `privacy compute` when you do not need an external fetch
- use `pricefeed` for standardized public market data storage
- use `neodid` for privacy-preserving identity binding, action authorization, and AA recovery
- for contracts, prefer provider-scoped storage pairs like `TWELVEDATA:NEO-USD`
- if you need all currently stored feed pairs, use `GetAllPairs()` / `getAllPairs()`
- use the public DID resolver only for service discovery and verifier material, not for private identity claims
