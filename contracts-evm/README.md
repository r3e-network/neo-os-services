# Morpheus EVM (Neo X) Contracts

## Overview

Solidity mirrors of the Neo N3 kernel for Neo X (EVM, chainId 47763). Compile with
`node deploy/evm/compile.mjs <Name>` (solc 0.8.35, evmVersion=paris); deploy records
live in `build/<Name>.neox-mainnet.json`. Operations: `deploy/evm/RUNBOOK.md`.

## Deployed (Neo X mainnet — bytecode-frozen, no upgrade path)

| Contract             | Address                                                             |
| -------------------- | ------------------------------------------------------------------- |
| `MorpheusOracleEVM`  | `0xeCFC1C652B5cCdBfe3E9314a83156787D92a3fD2`                        |
| `MorpheusPriceFeed`  | `0x38DD6BCEBDD47f4234AE11760CEFB58f9ae6a3bB`                        |
| `MiniAppDiceGameEVM` | `0xFA795F814d38F218153d21838360096f3F5cb774` (oracle app `dice`)    |
| `MiniAppMessageEVM`  | `0xd1906192c2308ae416aCDa96238cA846EBB83f15` (oracle app `message`) |

These contracts have no proxy/update mechanism: fixes below require a fresh
deployment + re-registration + consumer repoint.

## Next-deployment notes (required changes; tracked from the 2026-06-11 review)

- **Callback uniqueness (OR-D-03)**: `registerMiniApp` is permissionless and line 90
  overwrites `_appByCallback[callbackContract]` last-write-wins — anyone can register a
  fresh appId over an existing app's callback and brick its `requestFromCallback` path.
  Next deployment must add `require(_appByCallback[cb] == "")` (empty) before writing.
  Interim: `deploy/evm/callback-monitor.mjs` watches `MiniAppRegistered` for hijack/reuse;
  the owner can reclaim a hijacked mapping by re-registering a new appId over the same callback.
- **Exact fee / accrue overage**: `_submit` checks `msg.value < requestFee` but accrues only
  `requestFee`; overpayment (and any value while fee is 0) is stranded forever (no sweep).
  Next deployment: `require(msg.value == requestFee)` or `accruedFees += msg.value`.
  Until then callers must send exactly `requestFee` (currently 0).
- **requestFee must stay 0**: the deployed miniapps forward zero value to
  `requestFromCallback`, so one owner `setRequestFee(>0)` bricks every dice bet and message
  reveal. Pin fee=0 operationally; future miniapps should forward `{value: oracle.requestFee()}`.
- **Owner-change events**: `MorpheusOracleEVM.setOwner`, `MiniAppDiceGameEVM.setOwner` and
  `MiniAppMessageEVM.setOwner` emit no event (only `MorpheusPriceFeed` does), so an ownership
  hijack is invisible to indexers. Emit `OwnerChanged(previous, next)` in the next deployments;
  meanwhile include `owner()` in ops checks.
- **Callback dispatch**: `onOracleResult(uint256,string,bool,bytes,string)` is the ONLY
  callback the kernel calls (best-effort, failures swallowed) — same as the N3 kernel.
  Consumers must implement it exactly; result storage on the kernel stays canonical.

## Compiler / source version

- Pinned compiler: **solc 0.8.35** (`contracts-evm/foundry.toml`, root `package.json`,
  `deploy/evm/compile.mjs`).
- CI installs stable **Foundry v1.8.1** through a commit-SHA-pinned setup
  action. `nightly` is not a release input.
- EVM target stays `paris` for Neo X compatibility, so default EVM-version changes in
  newer solc releases do not affect bytecode.
- solc 0.8.35 warns that `error` will become a keyword. The next-deployment source
  renames the `Request` struct field and `RequestFulfilled` event parameter from
  `error` to `errorMessage`. This changes ABI parameter names but **not** event topics
  or function selectors.

## API Reference

Contract ABIs are produced from the Solidity sources under `contracts-evm/`.
Deployment records under `build/` bind the ABI and bytecode to a network and
address. `foundry.toml` is the compiler/EVM configuration source of truth.

## Usage Examples

```bash
cd contracts-evm
forge build --offline
forge test --offline
```

## Test Coverage

Pull-request CI installs Foundry v1.8.1, builds the contracts and runs the
self-contained offline Solidity suite. Workspace validation separately rejects
mutable GitHub Action references.
