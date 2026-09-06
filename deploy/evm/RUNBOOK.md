# Neo X (EVM) Oracle — Runbook

The oracle request lane on **Neo X mainnet** (EVM, chainId 47763), mirroring the
Neo N3 `MorpheusOracle` kernel. Production request and price-feed delivery are
both owned by the Rust `neo-os-relayer`; the Node tools documented below are
deployment utilities or explicit non-production compatibility assets.

## Components

| Piece                | Where                                                     | What                                                          |
| -------------------- | --------------------------------------------------------- | ------------------------------------------------------------- |
| `MorpheusOracleEVM`  | NeoX mainnet `0xeCFC1C652B5cCdBfe3E9314a83156787D92a3fD2` | request lifecycle + ecrecover-verified fulfilment + callbacks |
| `neo-os-relayer`     | Rust production service                                   | scans requests/feeds → custody signs → broadcasts → confirms  |
| `neox-fulfiller.mjs` | non-production compatibility artifact                     | host-key bootstrap tool; exits 78 in production               |
| `MorpheusPriceFeed`  | NeoX mainnet `0x38DD6BCEBDD47f4234AE11760CEFB58f9ae6a3bB` | price feed delivered by the Rust relayer                      |

Production custody roles must be distinct:

- **owner** — admin (register modules/apps, set updater/verifier, fees).
- **updater** — `SIGNER_ROLE_NEOX_UPDATER_KEY_ID`; signs EIP-1559 request/feed
  submissions and pays gas.
- **oracle verifier** — `SIGNER_ROLE_NEOX_VERIFIER_KEY_ID`; signs the semantic
  EIP-191 fulfilment proof checked with `ecrecover`. The measured Rust host
  refuses startup if updater and verifier resolve to the same underlying address.

## Request lifecycle

1. A miniapp calls `submitRequest(appId, moduleId, operation, payload)` (or a
   registered callback contract calls `requestFromCallback(requester, operation, payload)`).
   The app must be registered and the module granted. → `RequestQueued` event.
2. The fulfiller sees the event, runs the lane (VRF locally; HTTP/compute via the
   Nitro worker when `NEOX_WORKER_URL` is set), and signs
   `digest = keccak(abi.encode("morpheus-evm-fulfillment-v1", chainId, oracle, id,
keccak(appId), keccak(moduleId), keccak(operation), success, keccak(result), keccak(errorMessage)))`
   with the verifier key (EIP-191 personal-sign over the 32-byte digest).
3. `fulfillRequest(id, success, result, errorMessage, signature)` — `onlyUpdater`; the kernel
   recomputes the digest and requires `ecrecover == oracleVerifier`, stores the result,
   and best-effort-calls `onOracleResult(uint256,string,bool,bytes,string)` on the
   app's callback contract (a failing callback never reverts the fulfilment).

## Build / deploy / bootstrap (local)

```bash
# compile (solc 0.8.35, evmVersion=paris for NeoX)
node deploy/evm/compile.mjs MorpheusOracleEVM

# deploy (dual-gated)
NEOX_DEPLOY_PK=0x.. DEPLOY_APPLY=1 \
  node deploy/evm/deploy.mjs MorpheusOracleEVM '["0x0","0x0"]'   # 0x0 => default updater/verifier to deployer

# inspect + bootstrap a module/app
node deploy/evm/oracle-admin.mjs info
NEOX_ADMIN_PK=0x.. node deploy/evm/oracle-admin.mjs register-module random.generate
NEOX_ADMIN_PK=0x.. node deploy/evm/oracle-admin.mjs register-app <appId> <admin> [callback]
NEOX_ADMIN_PK=0x.. node deploy/evm/oracle-admin.mjs grant <appId> <moduleId>
node deploy/evm/oracle-admin.mjs request <id>

# end-to-end check (needs the fulfiller running)
NEOX_REQUESTER_PK=0x.. node deploy/evm/validate-vrf.mjs
```

## Fulfilment: Rust production relayer

NeoX is a first-class chain in `workers/neo-os-relayer`. Configure
`MORPHEUS_ACTIVE_CHAINS=neox` (or `neo_n3,neox`), the NeoX RPC/chain-id/oracle
contract, both custody role IDs, the measured runtime URL/token, and the custody
URL with a dedicated bearer caller token. The Rust lane recomputes the semantic
fulfilment digest, obtains the EIP-191 verifier proof, builds and custody-signs the
EIP-1559 updater transaction, broadcasts it, requires receipt `status=1`, and
records durable success before advancing the cursor. See
`deploy/nitro/neo-os-relayer.env.example` for the exact names.

Operate with `morpheus-relayer.service` or `morpheus-relayer-nitro.service`. The
units run `config:validate` before start and conflict with every Node writer.

## Standalone Node fulfiller (non-production compatibility only)

`deploy/evm/neox-fulfiller.mjs` is the former host-key bootstrap path. It is not a
production fallback: with `NODE_ENV=production` it exits with code 78 before
reading a private key. Its systemd unit is labelled compatibility-only, requires
`/opt/morpheus/nitro/ENABLE_NODE_NEOX_FULFILLER_COMPAT`, conflicts with both Rust
relayer units, and has no `[Install]` section. Keep it for non-production parity
and incident forensics; restore the Rust relayer when production delivery fails.

## Compatibility-tool development / app administration

- New work lane: extend `doWork()` in `neox-fulfiller.mjs` (route by `moduleId`/`operation`),
  then `register-module` + `grant` it to the app. HTTP/compute reuse the Nitro worker —
  set `NEOX_WORKER_URL`/`NEOX_WORKER_TOKEN` in the env.
- New app: `register-app <appId> <admin> [callbackContract]` then `grant` each module.
  Callback contracts implement `onOracleResult(uint256 id, string operation, bool success, bytes result, string errorMessage)`.

## Security notes

- Keep the cold owner separate from both measured custody roles; updater and
  verifier must also be distinct. `setUpdater` / `setOracleVerifier` /
  `setOwner` are owner-gated.
- `requestFee` defaults to 0 (free). Set via `setRequestFee` (wei) + `withdrawFees` to monetize.
- Raw `NEOX_*_PK` values belong only to the non-production compatibility tool;
  production consumers use key IDs and never receive private key material.
