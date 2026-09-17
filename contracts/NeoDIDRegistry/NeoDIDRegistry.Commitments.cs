using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace MorpheusOracle.Contracts
{
    public partial class NeoDIDRegistry
    {
        private static readonly byte[] PREFIX_CLAIM_COMMITMENT = new byte[] { 0x0C };
        private static readonly byte[] COMMITMENT_DOMAIN = new byte[]
        {
            110, 101, 111, 100, 105, 100, 45, 99, 108, 97, 105, 109, 45, 99, 111, 109,
            109, 105, 116, 109, 101, 110, 116, 45, 118, 49
        };

        [DisplayName("BindingCommitmentRegistered")]
        public static event NeoDidBindingCommitmentRegisteredHandler OnBindingCommitmentRegistered;

        /// <summary>Legacy ABI retained only for empty-claim migration calls.</summary>
        public static void RegisterBinding(
            UInt160 vaultAccount,
            string provider,
            string claimType,
            string claimValue,
            ByteString masterNullifier,
            ByteString metadataHash,
            ByteString verificationSignature)
        {
            ValidateBindingArguments(vaultAccount, provider, claimType, claimValue, masterNullifier, metadataHash, verificationSignature);
            ExecutionEngine.Assert(claimValue == null || claimValue.Length == 0,
                "plaintext claim disabled; use commitment");
            ExecutionEngine.Assert(Runtime.CheckWitness(vaultAccount) || Runtime.CheckWitness(Admin()), "unauthorized");
            ExecutionEngine.Assert(!IsMasterNullifierUsed(masterNullifier), "master nullifier already used");
            BindingRecord existing = GetBinding(vaultAccount, provider, claimType);
            ExecutionEngine.Assert(!existing.Active, "binding already exists");
            ByteString digest = ComputeBindingDigest(vaultAccount, provider, claimType, claimValue, masterNullifier, metadataHash);
            VerifySignature(digest, verificationSignature);
            BindingRecord record = new BindingRecord
            {
                VaultAccount = vaultAccount,
                Provider = provider,
                ClaimType = claimType,
                ClaimValue = "",
                MasterNullifier = masterNullifier,
                MetadataHash = metadataHash,
                CreatedAt = Runtime.Time,
                RevokedAt = 0,
                Active = true,
            };
            BindingMap().Put(BuildBindingKey(vaultAccount, provider, claimType), StdLib.Serialize(record));
            MasterNullifierMap().Put((byte[])masterNullifier, 1);
            OnBindingRegistered(vaultAccount, provider, claimType, "", masterNullifier, metadataHash);
        }

        /// <summary>
        /// Registers a privacy-preserving binding. The worker signs a digest over
        /// the commitment, never over a plaintext claim that is written on-chain.
        /// </summary>
        public static void RegisterBindingCommitment(
            UInt160 vaultAccount,
            string provider,
            string claimType,
            ByteString claimCommitment,
            ByteString masterNullifier,
            ByteString metadataHash,
            ByteString verificationSignature)
        {
            ValidateBindingArguments(vaultAccount, provider, claimType, "", masterNullifier, metadataHash, verificationSignature);
            ValidateFixedHash(claimCommitment, "invalid claim commitment");
            ExecutionEngine.Assert(Runtime.CheckWitness(vaultAccount) || Runtime.CheckWitness(Admin()), "unauthorized");
            ExecutionEngine.Assert(!IsMasterNullifierUsed(masterNullifier), "master nullifier already used");

            BindingRecord existing = GetBinding(vaultAccount, provider, claimType);
            ExecutionEngine.Assert(!existing.Active, "binding already exists");

            ByteString digest = ComputeBindingCommitmentDigest(
                vaultAccount, provider, claimType, claimCommitment, masterNullifier, metadataHash);
            VerifySignature(digest, verificationSignature);

            BindingRecord record = new BindingRecord
            {
                VaultAccount = vaultAccount,
                Provider = provider,
                ClaimType = claimType,
                ClaimValue = "",
                MasterNullifier = masterNullifier,
                MetadataHash = metadataHash,
                CreatedAt = Runtime.Time,
                RevokedAt = 0,
                Active = true,
            };

            BindingMap().Put(BuildBindingKey(vaultAccount, provider, claimType), StdLib.Serialize(record));
            CommitmentMap().Put(BuildBindingKey(vaultAccount, provider, claimType), (byte[])claimCommitment);
            MasterNullifierMap().Put((byte[])masterNullifier, 1);
            OnBindingCommitmentRegistered(vaultAccount, provider, claimType, claimCommitment, masterNullifier, metadataHash);
        }

        [Safe]
        public static ByteString GetClaimCommitment(UInt160 vaultAccount, string provider, string claimType)
        {
            ExecutionEngine.Assert(vaultAccount != null && vaultAccount.IsValid, "invalid vault account");
            ByteString raw = CommitmentMap().Get(BuildBindingKey(vaultAccount, provider, claimType));
            return raw ?? (ByteString)"";
        }

        private static StorageMap CommitmentMap() => new StorageMap(Storage.CurrentContext, PREFIX_CLAIM_COMMITMENT);

        private static ByteString ComputeBindingCommitmentDigest(
            UInt160 vaultAccount,
            string provider,
            string claimType,
            ByteString claimCommitment,
            ByteString masterNullifier,
            ByteString metadataHash)
        {
            ByteString payload = (ByteString)COMMITMENT_DOMAIN;
            payload = Helper.Concat(payload, EncodeCanonicalHash160(vaultAccount));
            payload = Helper.Concat(payload, EncodeSegment(provider ?? ""));
            payload = Helper.Concat(payload, EncodeSegment(claimType ?? ""));
            payload = Helper.Concat(payload, claimCommitment);
            payload = Helper.Concat(payload, masterNullifier);
            payload = Helper.Concat(payload, metadataHash);
            payload = Helper.Concat(payload, (ByteString)NetworkMagicLe4());
            return CryptoLib.Sha256(payload);
        }
    }
}
