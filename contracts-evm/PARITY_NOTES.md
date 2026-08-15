# EVM ↔ N3 Parity Hardening — verification record

Next-deployment hardening of the Neo X (EVM) oracle mirror against the Neo N3 kernel
`contracts/MorpheusOracle/MorpheusOracle.cs`. These contracts are bytecode-frozen with
no upgrade path; the changes here are for the NEXT deployment (source only, not deployed).

## Validation path

Two independent gates, both run locally with no network access:

1. **solc compile (repo tool)** — `node deploy/evm/compile.mjs <Name>` (solc 0.8.35,
   evmVersion=paris). All touched contracts compile clean:
   - `MorpheusOracleEVM`: 13377 bytes, 63 abi entries
   - `MiniAppDiceGameEVM`: 6598 bytes, 38 abi entries
   - `MiniAppMessageEVM`: 4566 bytes, 30 abi entries
2. **forge test** — a self-contained offline harness under `contracts-evm/test/`
   (`foundry.toml` + `TestBase.sol` declaring the `Vm` cheatcode interface locally, so
   no `forge-std` fetch is required). Run: `cd contracts-evm && forge test --offline`.
   Result: **16 passed, 0 failed**.

## Invariants and the lines that enforce them

All line references are `contracts-evm/MorpheusOracleEVM.sol` unless noted.

### 1. Callback uniqueness (OR-D-03)

`registerMiniApp` rejects binding a callback contract that already routes to another app:

```solidity
if (bytes(_appByCallback[callbackContract]).length != 0) revert CallbackAlreadyRegistered();
_appByCallback[callbackContract] = appId;
```

Mirrors N3 `PutMiniApp` (`CallbackIndexMap` assert "callback already registered").
Tests: `test_callbackUniqueness_rejectsHijack`, `test_callbackUniqueness_distinctCallbacksOk`,
`test_zeroCallbackAllowedMultipleTimes`.

### 2. Exact fee / no stranded value

`_submit` accrues EXACTLY `requestFee`, reserves it, and refunds the remainder of
`msg.value` to `msg.sender` (the submitter / callback contract). State is fully written
before the external refund (checks-effects-interactions):

```solidity
if (fee > 0) { accruedFees += fee; reservedFees += fee; }
// ... request stored ...
uint256 overage = msg.value - fee;
if (overage > 0) { (bool ok,) = payable(msg.sender).call{value: overage}(""); if (!ok) revert RefundFailed(); }
```

No value is ever stranded: fee==0 → full refund; overpayment → overage refunded; underpay
→ `FeeNotPaid` revert. Tests: `test_feeZero_refundsAllValue_noStrand`,
`test_overpayment_refunded_onlyFeeAccrued`, `test_exactFee_noRefund`, `test_underpayment_reverts`.

### 3. Request TTL + expiry + refund (N3 `ExpireStaleRequest` parity)

- `requestTTL` (seconds), owner-settable via `setRequestTTL` → `RequestTTLChanged` event.
- Each request records `createdAt`, `feePaid` (exact fee), `feePayer` (the submitter).
- `expireStaleRequest(requestId)`: owner/updater only; requires Pending + past TTL; sets
  status Failed; releases the reservation; refunds `feePaid` to `feePayer`; emits
  `RequestExpired`. Effects precede the external refund call:

```solidity
r.status = Status.Failed; r.fulfilledAt = ...; r.errorMessage = "request expired: TTL exceeded";
_releaseReserved(refund);
if (refund > accruedFees) refund = accruedFees;
if (refund > 0) accruedFees -= refund;
emit RequestExpired(...);
if (refund > 0 && to != address(0)) { (bool ok,) = to.call{value: refund}(""); if (!ok) revert RefundFailed(); ... }
```

Refunds the exact fee paid (not the live `requestFee`), matching N3's use of
`req.FeePaid` rather than `SystemRequestFee()`. Tests:
`test_expiry_refundsFeePayer_releasesReserved`, `test_expiry_unauthorizedReverts`,
`test_cannotExpireFulfilled`, `test_expiry_refundsCallbackContract`.

### 4. Reserved-fee invariant (N3 `WithdrawableFees` / `ReservedRequestFees` parity)

`reservedFees` tracks fees backing still-pending requests. Invariant: `accruedFees >=
reservedFees`. The owner withdraw path is capped at the surplus:

```solidity
function withdrawableFees() public view returns (uint256) {
    return accruedFees > reservedFees ? accruedFees - reservedFees : 0;
}
function withdrawFees(address payable to, uint256 amount) external onlyOwner {
    if (amount > withdrawableFees()) revert ExceedsWithdrawable();
    accruedFees -= amount; // effects before interaction
    (bool ok,) = to.call{value: amount}(""); if (!ok) revert RefundFailed();
    ...
}
```

A fee leaves the reserved pool only when the request is fulfilled (earned, `fulfillRequest`
→ `_releaseReserved`) or expired (refunded, `expireStaleRequest`). Tests:
`test_ownerCannotWithdrawReserved`, `test_fulfillReleasesReserved_thenWithdrawable`,
`test_invariant_accruedGteReserved_acrossMixedRequests`.

### 5. Owner-change events

`OwnerChanged(previous, next)` is emitted on every ownership transfer:

- `MorpheusOracleEVM.setOwner` (+ constructor seeds `OwnerChanged(address(0), deployer)`).
- `MiniAppDiceGameEVM.setOwner`.
- `MiniAppMessageEVM.setOwner`.

Test: `test_setOwner_emitsOwnerChanged` (oracle). The two consumers add the same event +
emit; covered by compile + manual inspection.

### 6. Sponsorship gating — deferred (documented follow-up)

N3 sponsorship gating (`IsSponsorshipGated`, allowlist, per-requester cap) gates which
**prepaid-credit balance** (sponsor vs requester) is debited at submit. The EVM kernel has
no prepaid-credit / fee-payer model — the payer is always whoever sends `msg.value` on the
request transaction. Mirroring sponsorship would require importing the entire N3
credit/sponsor accounting model (NEP-17-style deposits, `FeeCreditOf`, `ResolveFeePayer`,
directed-deposit beneficiary auth), which is a separate, larger initiative. Per the
"correctness over coverage" guidance it is intentionally NOT half-implemented here and is
recorded as a follow-up.

## ABI changes (additive only — no existing external signature changed)

New functions: `setRequestTTL`, `withdrawableFees`, `expireStaleRequest`, `appIdByCallback`,
plus public getters `requestTTL`, `reservedFees`, `DEFAULT_REQUEST_TTL`.

New events: `RequestExpired`, `RequestTTLChanged`, `FeeRefunded`, `FeesWithdrawn`,
`RequestFeeChanged`, `OwnerChanged` (and `OwnerChanged` on both consumers).

The `Request` struct gained two trailing fields (`uint256 feePaid`, `address feePayer`).
`getRequest`'s tuple decode is updated in `MiniAppDiceGameEVM`'s `IMorpheusOracleEVM.Request`
interface to match (trailing additions, so prior leading fields keep their positions).

The kernel→consumer callback `onOracleResult(uint256,string,bool,bytes,string)` is
unchanged. No existing external function signature was modified.
