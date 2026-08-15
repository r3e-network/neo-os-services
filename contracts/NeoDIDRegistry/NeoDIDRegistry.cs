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
    public delegate void NeoDidBindingRegisteredHandler(UInt160 vaultAccount, string provider, string claimType, string claimValue, ByteString masterNullifier, ByteString metadataHash);
    public delegate void NeoDidBindingRevokedHandler(UInt160 vaultAccount, string provider, string claimType, ByteString masterNullifier);
    public delegate void NeoDidActionTicketUsedHandler(UInt160 disposableAccount, string actionId, ByteString actionNullifier);
    public delegate void NeoDidAdminChangedHandler(UInt160 oldAdmin, UInt160 newAdmin);
    public delegate void NeoDidVerifierChangedHandler(ECPoint oldVerifier, ECPoint newVerifier);

    /// <summary>
    /// Independent on-chain registry for NeoDID bindings and single-use action tickets.
    /// </summary>
    /// <remarks>
    /// Morpheus or NeoDID off-chain flows produce signed binding and action-ticket payloads; this
    /// contract verifies those signatures, records master nullifiers, and enforces one-time action
    /// nullifier consumption. It intentionally stays separate from both the Oracle gateway and the
    /// AA core.
    /// </remarks>
    [DisplayName("NeoDIDRegistry")]
    [ManifestExtra("Author", "Morpheus Oracle")]
    [ManifestExtra("Version", "1.0.0")]
    [ManifestExtra("Description", "Independent NeoDID binding and action-ticket registry")]
    public class NeoDIDRegistry : SmartContract
    {
        private static readonly byte[] PREFIX_ADMIN = new byte[] { 0x01 };
        private static readonly byte[] PREFIX_VERIFIER = new byte[] { 0x02 };
        private static readonly byte[] PREFIX_BINDING = new byte[] { 0x03 };
        private static readonly byte[] PREFIX_MASTER_NULLIFIER = new byte[] { 0x04 };
        private static readonly byte[] PREFIX_ACTION_NULLIFIER = new byte[] { 0x05 };
        private static readonly byte[] BINDING_DOMAIN = new byte[] { 110, 101, 111, 100, 105, 100, 45, 98, 105, 110, 100, 105, 110, 103, 45, 118, 49 };
        private static readonly byte[] ACTION_DOMAIN = new byte[] { 110, 101, 111, 100, 105, 100, 45, 97, 99, 116, 105, 111, 110, 45, 118, 49 };

        private const int MAX_PROVIDER_LENGTH = 32;
        private const int MAX_CLAIM_TYPE_LENGTH = 64;
        private const int MAX_CLAIM_VALUE_LENGTH = 128;
        private const int MAX_ACTION_ID_LENGTH = 128;
        private const int FIXED_HASH_LENGTH = 32;
        private const int FIXED_SIGNATURE_LENGTH = 64;

        public struct BindingRecord
        {
            public UInt160 VaultAccount;
            public string Provider;
            public string ClaimType;
            public string ClaimValue;
            public ByteString MasterNullifier;
            public ByteString MetadataHash;
            public BigInteger CreatedAt;
            public BigInteger RevokedAt;
            public bool Active;
        }

        [DisplayName("BindingRegistered")]
        public static event NeoDidBindingRegisteredHandler OnBindingRegistered;

        [DisplayName("BindingRevoked")]
        public static event NeoDidBindingRevokedHandler OnBindingRevoked;

        [DisplayName("ActionTicketUsed")]
        public static event NeoDidActionTicketUsedHandler OnActionTicketUsed;

        [DisplayName("AdminChanged")]
        public static event NeoDidAdminChangedHandler OnAdminChanged;

        [DisplayName("VerifierChanged")]
        public static event NeoDidVerifierChangedHandler OnVerifierChanged;

        public static void _deploy(object data, bool update)
        {
            if (update) return;
            Storage.Put(Storage.CurrentContext, PREFIX_ADMIN, Runtime.Transaction.Sender);
        }

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

        public static void SetAdmin(UInt160 newAdmin)
        {
            ValidateAdmin();
            ExecutionEngine.Assert(newAdmin != null && newAdmin.IsValid, "invalid admin");
            UInt160 oldAdmin = Admin();
            Storage.Put(Storage.CurrentContext, PREFIX_ADMIN, newAdmin);
            OnAdminChanged(oldAdmin, newAdmin);
        }

        /// <summary>
        /// Sets the public verifier key used to authenticate NeoDID signatures.
        /// </summary>
        public static void SetVerifier(ECPoint publicKey)
        {
            ValidateAdmin();
            ExecutionEngine.Assert(publicKey != null && publicKey.IsValid, "invalid verifier");
            ECPoint oldVerifier = Verifier();
            Storage.Put(Storage.CurrentContext, PREFIX_VERIFIER, (byte[])publicKey);
            OnVerifierChanged(oldVerifier, publicKey);
        }

        public static void Update(ByteString nefFile, string manifest)
        {
            ValidateAdmin();
            ContractManagement.Update(nefFile, manifest, null);
        }

        /// <summary>
        /// Registers a new identity binding after verifying the signed binding digest.
        /// </summary>
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
            // The worker's verification signature proves the identity claim was
            // TEE-verified, but NOT that the caller owns the vault. Without this
            // gate anyone holding a worker-signed ticket could bind (or preempt) a
            // binding for a victim's vault. Require the vault owner's witness (or
            // admin), matching RevokeBinding / UseActionTicket.
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
                ClaimValue = claimValue ?? "",
                MasterNullifier = masterNullifier,
                MetadataHash = metadataHash,
                CreatedAt = Runtime.Time,
                RevokedAt = 0,
                Active = true,
            };

            BindingMap().Put(BuildBindingKey(vaultAccount, provider, claimType), StdLib.Serialize(record));
            MasterNullifierMap().Put((byte[])masterNullifier, 1);
            OnBindingRegistered(vaultAccount, provider, claimType, claimValue, masterNullifier, metadataHash);
        }

        public static void RevokeBinding(UInt160 vaultAccount, string provider, string claimType)
        {
            ExecutionEngine.Assert(vaultAccount != null && vaultAccount.IsValid, "invalid vault account");
            ValidateShortText(provider, MAX_PROVIDER_LENGTH, "invalid provider");
            ValidateShortText(claimType, MAX_CLAIM_TYPE_LENGTH, "invalid claim type");
            ExecutionEngine.Assert(Runtime.CheckWitness(vaultAccount) || Runtime.CheckWitness(Admin()), "unauthorized");

            BindingRecord record = GetBinding(vaultAccount, provider, claimType);
            ExecutionEngine.Assert(record.Active, "binding not active");
            record.Active = false;
            record.RevokedAt = Runtime.Time;
            BindingMap().Put(BuildBindingKey(vaultAccount, provider, claimType), StdLib.Serialize(record));
            OnBindingRevoked(vaultAccount, provider, claimType, record.MasterNullifier);
        }

        [Safe]
        public static BindingRecord GetBinding(UInt160 vaultAccount, string provider, string claimType)
        {
            ExecutionEngine.Assert(vaultAccount != null && vaultAccount.IsValid, "invalid vault account");
            ByteString raw = BindingMap().Get(BuildBindingKey(vaultAccount, provider, claimType));
            if (raw == null)
            {
                return new BindingRecord
                {
                    VaultAccount = vaultAccount,
                    Provider = provider ?? "",
                    ClaimType = claimType ?? "",
                    ClaimValue = "",
                    MasterNullifier = (ByteString)"",
                    MetadataHash = (ByteString)"",
                    CreatedAt = 0,
                    RevokedAt = 0,
                    Active = false,
                };
            }
            return (BindingRecord)StdLib.Deserialize(raw);
        }

        [Safe]
        public static bool IsMasterNullifierUsed(ByteString masterNullifier)
        {
            if (masterNullifier == null || masterNullifier.Length != FIXED_HASH_LENGTH) return false;
            return MasterNullifierMap().Get((byte[])masterNullifier) != null;
        }

        [Safe]
        public static bool IsActionNullifierUsed(ByteString actionNullifier)
        {
            if (actionNullifier == null || actionNullifier.Length != FIXED_HASH_LENGTH) return false;
            return ActionNullifierMap().Get((byte[])actionNullifier) != null;
        }

        /// <summary>
        /// Consumes a one-time action ticket and records its action nullifier.
        /// </summary>
        public static bool UseActionTicket(UInt160 disposableAccount, string actionId, ByteString actionNullifier, ByteString verificationSignature)
        {
            ExecutionEngine.Assert(disposableAccount != null && disposableAccount.IsValid, "invalid disposable account");
            ValidateShortText(actionId, MAX_ACTION_ID_LENGTH, "invalid action id");
            ValidateFixedHash(actionNullifier, "invalid action nullifier");
            ValidateSignature(verificationSignature);
            ExecutionEngine.Assert(Runtime.CheckWitness(disposableAccount), "unauthorized");
            ExecutionEngine.Assert(!IsActionNullifierUsed(actionNullifier), "action nullifier already used");

            ByteString digest = ComputeActionDigest(disposableAccount, actionId, actionNullifier);
            VerifySignature(digest, verificationSignature);

            ActionNullifierMap().Put((byte[])actionNullifier, Runtime.Time);
            OnActionTicketUsed(disposableAccount, actionId, actionNullifier);
            return true;
        }

        private static StorageMap BindingMap() => new StorageMap(Storage.CurrentContext, PREFIX_BINDING);
        private static StorageMap MasterNullifierMap() => new StorageMap(Storage.CurrentContext, PREFIX_MASTER_NULLIFIER);
        private static StorageMap ActionNullifierMap() => new StorageMap(Storage.CurrentContext, PREFIX_ACTION_NULLIFIER);

        private static void ValidateAdmin()
        {
            UInt160 admin = Admin();
            ExecutionEngine.Assert(admin != null && admin.IsValid, "admin not set");
            ExecutionEngine.Assert(Runtime.CheckWitness(admin), "unauthorized");
        }

        private static void ValidateBindingArguments(UInt160 vaultAccount, string provider, string claimType, string claimValue, ByteString masterNullifier, ByteString metadataHash, ByteString verificationSignature)
        {
            ExecutionEngine.Assert(vaultAccount != null && vaultAccount.IsValid, "invalid vault account");
            ValidateShortText(provider, MAX_PROVIDER_LENGTH, "invalid provider");
            ValidateShortText(claimType, MAX_CLAIM_TYPE_LENGTH, "invalid claim type");
            ExecutionEngine.Assert(claimValue == null || claimValue.Length <= MAX_CLAIM_VALUE_LENGTH, "claim value too long");
            ValidateFixedHash(masterNullifier, "invalid master nullifier");
            ValidateFixedHash(metadataHash, "invalid metadata hash");
            ValidateSignature(verificationSignature);
        }

        private static void ValidateShortText(string value, int maxLength, string message)
        {
            ExecutionEngine.Assert(value != null && value.Length > 0 && value.Length <= maxLength, message);
        }

        private static void ValidateFixedHash(ByteString value, string message)
        {
            ExecutionEngine.Assert(value != null && value.Length == FIXED_HASH_LENGTH, message);
        }

        private static void ValidateSignature(ByteString signature)
        {
            ExecutionEngine.Assert(signature != null && signature.Length == FIXED_SIGNATURE_LENGTH, "invalid verification signature");
        }

        private static ByteString BuildBindingKey(UInt160 vaultAccount, string provider, string claimType)
        {
            ByteString key = (ByteString)(byte[])vaultAccount;
            key = Helper.Concat(key, EncodeSegment(provider ?? ""));
            key = Helper.Concat(key, EncodeSegment(claimType ?? ""));
            return key;
        }

        private static ByteString ComputeBindingDigest(UInt160 vaultAccount, string provider, string claimType, string claimValue, ByteString masterNullifier, ByteString metadataHash)
        {
            ByteString payload = (ByteString)BINDING_DOMAIN;
            payload = Helper.Concat(payload, EncodeCanonicalHash160(vaultAccount));
            payload = Helper.Concat(payload, EncodeSegment(provider ?? ""));
            payload = Helper.Concat(payload, EncodeSegment(claimType ?? ""));
            payload = Helper.Concat(payload, EncodeSegment(claimValue ?? ""));
            payload = Helper.Concat(payload, masterNullifier);
            payload = Helper.Concat(payload, metadataHash);
            // Audit fix (cross-network replay): bind the signature to this network so it cannot
            // be replayed against another deployment/network that shares the verifier key.
            payload = Helper.Concat(payload, (ByteString)NetworkMagicLe4());
            return CryptoLib.Sha256(payload);
        }

        private static ByteString ComputeActionDigest(UInt160 disposableAccount, string actionId, ByteString actionNullifier)
        {
            ByteString payload = (ByteString)ACTION_DOMAIN;
            payload = Helper.Concat(payload, EncodeCanonicalHash160(disposableAccount));
            payload = Helper.Concat(payload, EncodeSegment(actionId ?? ""));
            payload = Helper.Concat(payload, actionNullifier);
            // Audit fix (cross-network replay): bind the action ticket signature to this network.
            payload = Helper.Concat(payload, (ByteString)NetworkMagicLe4());
            return CryptoLib.Sha256(payload);
        }

        // 4-byte little-endian network magic (Runtime.GetNetwork). The off-chain NeoDID signer
        // must reproduce these exact bytes when signing binding/action digests.
        private static byte[] NetworkMagicLe4()
        {
            BigInteger net = (BigInteger)Runtime.GetNetwork();
            return new byte[]
            {
                (byte)(net & 0xFF),
                (byte)((net / 256) & 0xFF),
                (byte)((net / 65536) & 0xFF),
                (byte)((net / 16777216) & 0xFF),
            };
        }

        private static ByteString EncodeSegment(string value)
        {
            string safe = value ?? "";
            ExecutionEngine.Assert(safe.Length <= 255, "segment too long");
            byte[] prefix = new byte[] { (byte)safe.Length };
            return Helper.Concat((ByteString)prefix, (ByteString)safe);
        }

        private static ByteString EncodeCanonicalHash160(UInt160 value)
        {
            ExecutionEngine.Assert(value != null && value.IsValid, "invalid hash160");
            byte[] raw = (byte[])value;
            byte[] canonical = new byte[raw.Length];
            for (int i = 0; i < raw.Length; i++)
            {
                canonical[i] = raw[raw.Length - 1 - i];
            }
            return (ByteString)canonical;
        }

        private static void VerifySignature(ByteString digest, ByteString verificationSignature)
        {
            ECPoint verifier = Verifier();
            ExecutionEngine.Assert(verifier != null && verifier.IsValid, "verifier not set");
            ExecutionEngine.Assert(
                CryptoLib.VerifyWithECDsa(digest, verifier, verificationSignature, NamedCurveHash.secp256r1SHA256),
                "invalid verification signature"
            );
        }
    }
}
