using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Services;

namespace MorpheusOracle.Contracts
{
    public partial class NeoDIDRegistry
    {
        private static readonly byte[] PREFIX_PENDING_VERIFIER = new byte[] { 0x0A };
        private static readonly byte[] PREFIX_PENDING_VERIFIER_TIME = new byte[] { 0x0B };

        [Safe]
        public static UInt160 Admin()
        {
            return (UInt160)Storage.Get(Storage.CurrentContext, PREFIX_ADMIN);
        }

        [Safe]
        public static ECPoint Verifier()
        {
            ByteString raw = Storage.Get(Storage.CurrentContext, PREFIX_VERIFIER);
            return raw == null ? null : (ECPoint)(byte[])raw;
        }

        [DisplayName("VerifierTimelockProposed")]
        public static event NeoDidVerifierTimelockProposedHandler OnVerifierTimelockProposed;

        [Safe]
        public static ECPoint PendingVerifier()
        {
            ByteString raw = Storage.Get(Storage.CurrentContext, PREFIX_PENDING_VERIFIER);
            return raw == null ? null : (ECPoint)(byte[])raw;
        }

        [Safe]
        public static BigInteger PendingVerifierChangeTime()
        {
            ByteString raw = Storage.Get(Storage.CurrentContext, PREFIX_PENDING_VERIFIER_TIME);
            return raw == null ? 0 : (BigInteger)raw;
        }

        /// <summary>Stage a verifier rotation for execution after the 24h timelock.</summary>
        public static void ProposeVerifier(ECPoint publicKey)
        {
            ValidateAdmin();
            ExecutionEngine.Assert(publicKey != null && publicKey.IsValid, "invalid verifier");
            ExecutionEngine.Assert(publicKey != Verifier(), "same verifier");
            ExecutionEngine.Assert(Storage.Get(Storage.CurrentContext, PREFIX_PENDING_VERIFIER) == null,
                "verifier change already pending");
            BigInteger executeAfter = Runtime.Time + 86_400_000;
            Storage.Put(Storage.CurrentContext, PREFIX_PENDING_VERIFIER, (byte[])publicKey);
            Storage.Put(Storage.CurrentContext, PREFIX_PENDING_VERIFIER_TIME, executeAfter);
            OnVerifierTimelockProposed(publicKey, executeAfter);
        }

        /// <summary>Execute a matured verifier rotation. Permissionless once proposed.</summary>
        public static void ExecuteVerifierChange()
        {
            ByteString pending = Storage.Get(Storage.CurrentContext, PREFIX_PENDING_VERIFIER);
            ExecutionEngine.Assert(pending != null, "no pending verifier");
            BigInteger changeTime = (BigInteger)Storage.Get(Storage.CurrentContext, PREFIX_PENDING_VERIFIER_TIME);
            ExecutionEngine.Assert(Runtime.Time >= changeTime, "timelock active");
            ECPoint oldVerifier = Verifier();
            ECPoint newVerifier = (ECPoint)(byte[])pending;
            Storage.Put(Storage.CurrentContext, PREFIX_VERIFIER, (byte[])newVerifier);
            Storage.Delete(Storage.CurrentContext, PREFIX_PENDING_VERIFIER);
            Storage.Delete(Storage.CurrentContext, PREFIX_PENDING_VERIFIER_TIME);
            OnVerifierChanged(oldVerifier, newVerifier);
        }

        /// <summary>Cancel a pending verifier rotation. Admin only.</summary>
        public static void CancelVerifierChange()
        {
            ValidateAdmin();
            Storage.Delete(Storage.CurrentContext, PREFIX_PENDING_VERIFIER);
            Storage.Delete(Storage.CurrentContext, PREFIX_PENDING_VERIFIER_TIME);
        }
    }
}
