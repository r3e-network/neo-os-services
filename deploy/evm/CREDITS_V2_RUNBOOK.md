# MiniAppCreditsV2 on Neo X

Status: **source and local tests only**. There is no production address, no
mainnet deployment record, and no production registry or settler activation in
this change.

## Fixed protocol boundary

- Chain: Neo X MainNet only, EVM chain ID `47763`. Construction and every
  state-changing entrypoint fail closed on any other chain.
- Rate: `1 GAS = 100 Credits`; one Credit costs exactly `10^16` wei. Purchases
  containing sub-Credit dust revert instead of being rounded.
- State: independent V2 storage (`STATE_VERSION=2`,
  `IMPORTS_V1_BALANCES=false`). No V1 balance import or upgrade path exists.
- Settlement: consecutive epochs and `(windowStartExclusive,
windowEndInclusive]` windows; at most 500 strictly sorted, unique EVM
  addresses; every delta is negative.
- Liability: settlement debits are clamped to the current on-chain balance.
  Owner rescue is limited to `held GAS - backing liability`.
- No redemption/refund: this V2 has no Credits-to-GAS user exit and no
  operator Credit refund entrypoint. Refund semantics require a separate,
  reviewed protocol version.

The chain-specific commitment is:

```text
sha256(abi.encode(
  "MiniAppCreditsV2:settlement:v1",
  uint256(47763),
  contractAddress,
  epoch,
  windowStartExclusive,
  windowEndInclusive,
  users,
  deltas
))
```

The contract recomputes this root and rejects a caller-supplied mismatch or a
previously used root. The shared fixed vector for database/settler parity is
[`contracts-evm/testdata/MiniAppCreditsV2.batch-root-vectors.json`](../../contracts-evm/testdata/MiniAppCreditsV2.batch-root-vectors.json).

`SettlementPosted` is the strict receipt proof and contains, in order:

```text
epoch, batchRoot, windowStartExclusive, windowEndInclusive,
userCount, totalRequested, totalDebited
```

A confirmer must bind all seven fields plus chain ID, contract address,
transaction hash, successful receipt, block hash/number, and configured finality.
`totalDebited` is authoritative when clamping occurs; it must not be replaced by
the requested database total.

## Backing and rescue boundary

Credits are in-platform consumable units in this V2. The ABI deliberately has
no `requestExit`, `approveExit`, `claimExit`, or `refundCredits` route. Removing
proof-free redemption closes the race between an off-chain capture and its
later on-chain debit batch.

`rescueSurplusGas` is owner-only and can transfer no more than
`heldGas - backingLiabilityGas`. It cannot touch the native GAS backing any
unsettled on-chain Credit balance. The purchase pause does not block settlement,
so already accepted off-chain work can continue to reduce liability safely.

## Local build and tests

```bash
forge build --root contracts-evm
forge test --root contracts-evm -vv
node deploy/evm/compile.mjs MiniAppCreditsV2
node --test deploy/evm/deploy-credits-v2.test.mjs
npm run check:relayer
npm run test:relayer
```

`compile.mjs` regenerates the ignored bytecode artifact and the reviewed ABI.

## Deployment remains gated and disabled

An offline plan neither opens an RPC connection nor reads a private key:

```bash
NEOX_CREDITS_V2_SETTLER=0x... node deploy/evm/deploy-credits-v2.mjs
```

Broadcast additionally requires all of the following, and still writes a
receipt with `productionEnabled:false` rather than activating any registry:

```bash
DEPLOY_APPLY=1
NEOX_CREDITS_V2_MAINNET_ACK=neo-x-mainnet:47763
NEOX_RPC=<explicit-mainnet-rpc>
NEOX_DEPLOY_PK=<ephemeral-deployer-key>
NEOX_CREDITS_V2_SETTLER=<reviewed-settler-address>
```

The script queries the RPC-reported chain ID, requires exactly `47763`, waits
for configured confirmations, checks receipt success and deployed code, and
reads back the chain/rate/state/settler invariants. Do not broadcast until the
Credits V2 database commitment encoder, Neo X indexer, finality/reorg policy,
signer separation, and production change review are complete.

## Relayer schema compatibility

`db/services/migrations/0016_allow_neox_relayer_jobs.sql` repairs the existing
durable-queue mismatch: the Neo X adapter emits `chain='neox'`, while migration
0004 accepted only `neo_n3`. The migration adds exactly `neox`; it does not add a
testnet value, activate the Neo X worker, or change RLS.
