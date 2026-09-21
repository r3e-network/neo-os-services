using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Services;

namespace MorpheusOracle.Contracts
{
    public delegate void VerificationKeyTimelockProposedHandler(ECPoint proposed, bool clearing, BigInteger executeAfter);

    /// <summary>
    /// Timelocked control of the feed's off-chain signature verification key.
    /// </summary>
    /// <remarks>
    /// The verification key is the feed's second factor: while it is registered, a
    /// leaked updater witness alone cannot anchor a price. Re-pointing or removing it
    /// therefore has to be as hard to abuse as rotating the admin, otherwise a stolen
    /// admin key disarms the feed and forges a price inside one transaction.
    ///
    /// This is the same propose/wait/execute shape the sibling contracts already use
    /// for exactly this authority — MorpheusOracle.ProposeRuntimeVerificationPublicKey
    /// and NeoDIDRegistry.ProposeVerifier — reusing this contract's own
    /// TIMELOCK_DELAY_MS (24h), so a watcher has the same notice window to pause
    /// consumers before the change lands.
    ///
    /// Execute is permissionless once a proposal matures (matching ExecuteAdminChange):
    /// the delay, not the executor, is the control. Cancel is admin-only.
    /// </remarks>
    public partial class MorpheusDataFeed
    {
        private static readonly byte[] PREFIX_PENDING_VERIFICATION_KEY = new byte[] { 0x09 };
        private static readonly byte[] PREFIX_PENDING_VERIFICATION_KEY_TIME = new byte[] { 0x0A };

        // A pending change is stored either as the 33-byte compressed key to install or
        // as this single sentinel byte meaning "clear the key". The length discriminates
        // the two, so the code never has to rely on empty-value storage semantics.
        private static readonly byte[] PENDING_CLEAR_MARKER = new byte[] { 0x00 };

        [DisplayName("VerificationKeyTimelockProposed")]
        public static event VerificationKeyTimelockProposedHandler OnVerificationKeyTimelockProposed;

        /// <summary>The key a matured proposal would install, or null (also null for a pending clear).</summary>
        [Safe]
        public static ECPoint PendingOracleVerificationKey()
        {
            ByteString raw = Storage.Get(Storage.CurrentContext, PREFIX_PENDING_VERIFICATION_KEY);
            if (raw == null || raw.Length <= 1) return null;
            return (ECPoint)(byte[])raw;
        }

        /// <summary>True when the pending proposal would REMOVE the verification key.</summary>
        [Safe]
        public static bool PendingOracleVerificationKeyIsClear()
        {
            ByteString raw = Storage.Get(Storage.CurrentContext, PREFIX_PENDING_VERIFICATION_KEY);
            return raw != null && raw.Length == 1;
        }

        /// <summary>Earliest time a pending verification-key change may execute. 0 when none is pending.</summary>
        [Safe]
        public static BigInteger PendingOracleVerificationKeyChangeTime()
        {
            ByteString raw = Storage.Get(Storage.CurrentContext, PREFIX_PENDING_VERIFICATION_KEY_TIME);
            return raw == null ? 0 : (BigInteger)raw;
        }

        /// <summary>
        /// Stage registering (or rotating to) the ECDSA public key used to verify
        /// off-chain price signatures. Executable after TIMELOCK_DELAY_MS. Admin only.
        /// </summary>
        public static void ProposeOracleVerificationKey(ECPoint publicKey)
        {
            ValidateAdmin();
            ExecutionEngine.Assert(publicKey != null && publicKey.IsValid, "invalid verification key");
            ExecutionEngine.Assert(publicKey != OracleVerificationKey(), "same verification key");
            StagePendingVerificationKey((ByteString)(byte[])publicKey, publicKey, false);
        }

        /// <summary>
        /// Stage clearing the verification key, which reverts the feed to
        /// updater-witness-only writes (the escape hatch for a lost signer key).
        /// Executable after TIMELOCK_DELAY_MS. Admin only.
        /// </summary>
        public static void ProposeClearOracleVerificationKey()
        {
            ValidateAdmin();
            ExecutionEngine.Assert(OracleVerificationKey() != null, "no verification key");
            StagePendingVerificationKey((ByteString)PENDING_CLEAR_MARKER, null, true);
        }

        // One pending change at a time, so a proposal cannot be quietly replaced with a
        // different one after watchers have already seen and assessed it.
        private static void StagePendingVerificationKey(ByteString pending, ECPoint proposed, bool clearing)
        {
            ExecutionEngine.Assert(
                Storage.Get(Storage.CurrentContext, PREFIX_PENDING_VERIFICATION_KEY) == null,
                "verification key change already pending");

            BigInteger executeAfter = Runtime.Time + TIMELOCK_DELAY_MS;
            Storage.Put(Storage.CurrentContext, PREFIX_PENDING_VERIFICATION_KEY, pending);
            Storage.Put(Storage.CurrentContext, PREFIX_PENDING_VERIFICATION_KEY_TIME, executeAfter);
            OnVerificationKeyTimelockProposed(proposed, clearing, executeAfter);
        }

        /// <summary>Execute a matured verification-key change. Permissionless once proposed.</summary>
        public static void ExecuteOracleVerificationKeyChange()
        {
            ByteString pending = Storage.Get(Storage.CurrentContext, PREFIX_PENDING_VERIFICATION_KEY);
            ExecutionEngine.Assert(pending != null, "no pending verification key");
            BigInteger changeTime = (BigInteger)Storage.Get(Storage.CurrentContext, PREFIX_PENDING_VERIFICATION_KEY_TIME);
            ExecutionEngine.Assert(Runtime.Time >= changeTime, "timelock active");

            ECPoint oldKey = OracleVerificationKey();
            ECPoint newKey = null;
            if (pending.Length == 1)
            {
                Storage.Delete(Storage.CurrentContext, PREFIX_VERIFICATION_KEY);
            }
            else
            {
                newKey = (ECPoint)(byte[])pending;
                Storage.Put(Storage.CurrentContext, PREFIX_VERIFICATION_KEY, (byte[])newKey);
            }

            Storage.Delete(Storage.CurrentContext, PREFIX_PENDING_VERIFICATION_KEY);
            Storage.Delete(Storage.CurrentContext, PREFIX_PENDING_VERIFICATION_KEY_TIME);
            OnVerificationKeyChanged(oldKey, newKey);
        }

        /// <summary>Cancel a pending verification-key change. Admin only.</summary>
        public static void CancelOracleVerificationKeyChange()
        {
            ValidateAdmin();
            Storage.Delete(Storage.CurrentContext, PREFIX_PENDING_VERIFICATION_KEY);
            Storage.Delete(Storage.CurrentContext, PREFIX_PENDING_VERIFICATION_KEY_TIME);
        }
    }
}
