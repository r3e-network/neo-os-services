using System;
using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace NeoOs.SponsorLane
{
    /// <summary>
    /// Journey fixture for the sponsor lane (CU-153): the two script shapes
    /// `neo_os_core::sponsor_intent::validate_sponsorable_intent` accepts, on a
    /// disposable private chain.
    /// </summary>
    /// <remarks>
    /// This is **not** a wallet and it is not a paymaster. `neo-os-aa` owns
    /// `UnifiedSmartWallet`, and its `registerAccount` /
    /// `executeSponsoredUserOp` entry points are the shapes the sponsor lane
    /// validates by script. Nothing in this repository can deploy that contract,
    /// so the private-chain journey needs a fixture with the same method names,
    /// the same arities and the same argument item shapes, or the lane cannot be
    /// driven against a chain at all.
    ///
    /// The one thing this fixture does beyond HALT is the money movement the
    /// journey asserts: `executeSponsoredUserOp` settles
    /// `reimbursementAmount` GAS to the account the intent names, under the
    /// sponsor's own witness and at the sponsor's expense. The sponsor is
    /// charged on chain exactly `reimbursementAmount` plus the execution cost,
    /// and the journey reads both balances off the chain.
    ///
    /// Lives under `tests/fixtures/` rather than `contracts/` because the
    /// repository's own rules say the contracts tree is the live copy awaiting
    /// its move to neo-os-contracts and must not grow. It is built by the
    /// journey with `nccs` and never by `contracts/build.sh`.
    /// </remarks>
    [DisplayName("SponsorableIntentProbe")]
    [ManifestExtra("Author", "NeoOS sponsor lane journey")]
    [ManifestExtra("Version", "0.0.0")]
    [ManifestExtra("Description", "Journey fixture: the two sponsorable script shapes")]
    [ContractPermission("*", "*")]
    public class SponsorableIntentProbe : SmartContract
    {
        public delegate void AccountRegisteredHandler(UInt160 accountId, UInt160 verifier, BigInteger escapeTimelock);
        public delegate void SponsoredUserOpExecutedHandler(UInt160 accountId, UInt160 sponsor, UInt160 paymaster, BigInteger reimbursementAmount);

        [DisplayName("AccountRegistered")]
        public static event AccountRegisteredHandler OnAccountRegistered;

        [DisplayName("SponsoredUserOpExecuted")]
        public static event SponsoredUserOpExecutedHandler OnSponsoredUserOpExecuted;

        /// <summary>
        /// `registerAccount(accountId, verifier, verifierParams, hookId,
        /// backupOwner, escapeTimelock)` — six arguments, no reimbursement claim.
        /// </summary>
        public static void registerAccount(
            UInt160 accountId,
            UInt160 verifier,
            ByteString verifierParams,
            UInt160 hookId,
            UInt160 backupOwner,
            BigInteger escapeTimelock)
        {
            ExecutionEngine.Assert(escapeTimelock >= 0, "invalid escape timelock");
            OnAccountRegistered(accountId, verifier, escapeTimelock);
        }

        /// <summary>
        /// `onNEP17Payment(from, amount, data)` — the callback every NEP-17
        /// transfer to a contract must be able to reach. `Native.Nep17Token`
        /// calls it after minting the recipient's balance and faults the whole
        /// transfer when the recipient contract does not declare it, so a
        /// contract that holds GAS cannot omit it. This fixture holds the
        /// reimbursement it settles and accepts any capital account funds it
        /// with; it mints, burns or moves nothing here.
        /// </summary>
        [DisplayName("onNEP17Payment")]
        public static void OnNEP17Payment(UInt160 from, BigInteger amount, ByteString data)
        {
            ExecutionEngine.Assert(amount >= 0, "negative payment");
        }

        /// <summary>
        /// `executeSponsoredUserOp(accountId, op, paymaster, sponsor,
        /// reimbursementAmount)` — five arguments, the fifth a payment to the
        /// account the intent names. `op` is the six-field `UserOperation`
        /// array the validator reads; this fixture does not execute it, because
        /// what the journey is about is the sponsored payment, not the user
        /// operation.
        /// </summary>
        /// <remarks>
        /// The sponsor authorises this payment and is charged for it on chain,
        /// as the transaction's fee payer, but the reimbursement is disbursed
        /// from this contract's reimbursement balance rather than transferred
        /// out of the sponsor's account. Neo's `CalledByEntryCondition`
        /// (`ApplicationEngine`, decompiled) allows a `CalledByEntry` witness in
        /// the entry script and in the contracts that script calls **directly**,
        /// and in nothing further: `Native.Nep17Token.Transfer` re-checks the
        /// witness inside the GAS contract, one call too deep, and returns
        /// false. The invocation script may carry exactly one
        /// `System.Contract.Call` (`neo_os_core::n3_tx::decode_invoke_call`
        /// refuses a second), so the entry script cannot call `GAS.transfer`
        /// alongside this method either. The sponsor's debit therefore rides in
        /// the transaction's own fee, which is exactly the `sponsor_fee_units`
        /// the intent validator prices (`transaction_fee_units +
        /// reimbursement_units`), and this contract settles the account the
        /// intent names.
        /// </remarks>
        public static void executeSponsoredUserOp(
            UInt160 accountId,
            object op,
            UInt160 paymaster,
            UInt160 sponsor,
            BigInteger reimbursementAmount)
        {
            ExecutionEngine.Assert(reimbursementAmount > 0, "empty reimbursement");
            // The sponsor signed this transaction, so the sponsor is the
            // authoriser and the fee payer of this payment.
            ExecutionEngine.Assert(Runtime.CheckWitness(sponsor), "sponsor witness required");
            // `from` is this contract, which is `CallingScriptHash` in the GAS
            // frame, so the native transfer settles without a second witness.
            ExecutionEngine.Assert(
                GAS.Transfer(Runtime.ExecutingScriptHash, accountId, reimbursementAmount),
                "reimbursement refused");
            OnSponsoredUserOpExecuted(accountId, sponsor, paymaster, reimbursementAmount);
        }
    }
}
