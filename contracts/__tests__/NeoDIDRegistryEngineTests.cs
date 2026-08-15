using System;
using System.Collections.Generic;
using System.Numerics;
using Neo;
using Neo.SmartContract.Testing;
using Neo.Wallets;
using Xunit;
using Registry = Neo.SmartContract.Testing.NeoDIDRegistry;

namespace MorpheusOracle.Contracts.Tests
{
    /// <summary>
    /// VM-level coverage for the NeoDID binding and action-ticket lifecycle.
    ///
    /// These tests deploy the compiled NEF into an emulated Neo VM (same harness
    /// pattern as <see cref="MorpheusOracleFeeAccountingTests"/>) and exercise the
    /// real secp256r1 signature path.  The C# digest replicas below pin the exact
    /// byte layout (domain tag, canonical big-endian Hash160, length-prefixed
    /// segments, raw 32-byte nullifier/metadata hashes, 4-byte little-endian
    /// network magic) that the off-chain NeoDID signer must reproduce; a divergence
    /// would mean every binding registration fails signature verification.
    ///
    /// The deployed contract is the generated artifact under Generated/ (produced
    /// by `nccs NeoDIDRegistry.csproj --generate-artifacts Source`).  Regenerate it
    /// when the contract changes.
    /// </summary>
    public class NeoDIDRegistryEngineTests
    {
        private const string Provider = "github";
        private const string ClaimType = "account";
        private const string ClaimValue = "octocat";

        // BindingRecord field indices in the serialized struct returned by GetBinding.
        private const int ClaimValueIndex = 3;
        private const int MasterNullifierIndex = 4;
        private const int CreatedAtIndex = 6;
        private const int RevokedAtIndex = 7;
        private const int ActiveIndex = 8;

        private sealed record Harness(TestEngine Engine, Registry Contract, UInt160 Admin, KeyPair Verifier);

        private static Harness Deploy()
        {
            // ProtocolSettings.Default has no standby committee, which makes the
            // genesis un-mintable, so seed a 1-key committee (same pattern as the
            // oracle fee-accounting harness).
            byte[] priv = new byte[32];
            priv[31] = 1;
            ProtocolSettings settings = ProtocolSettings.Default with
            {
                StandbyCommittee = new[] { new KeyPair(priv).PublicKey },
                ValidatorsCount = 1,
            };

            TestEngine engine = new(settings, true);
            engine.Fee = 1_000 * 100_000_000L; // generous per-invocation gas limit
            UInt160 admin = engine.Sender;
            engine.SetTransactionSigners(admin); // deployer => admin (set in _deploy)

            Registry contract = engine.Deploy<Registry>(Registry.Nef, Registry.Manifest, null);
            Assert.Equal(admin, contract.Admin);

            byte[] verifierPriv = new byte[32];
            verifierPriv[31] = 9;
            KeyPair verifier = new KeyPair(verifierPriv);
            contract.SetVerifier(verifier.PublicKey);
            Assert.Equal(verifier.PublicKey, contract.Verifier);

            return new Harness(engine, contract, admin, verifier);
        }

        private static byte[] FixedHash(byte fill)
        {
            byte[] hash = new byte[32];
            for (int i = 0; i < hash.Length; i++) hash[i] = fill;
            return hash;
        }

        // Crypto.Sign on this platform (observed on macOS/arm64) emits an invalid
        // signature for roughly 2% of nonces; Neo's own VerifySignature and pure
        // .NET ECDsa both reject those deterministically.  Re-sign until the
        // signature round-trips locally: the VM's CryptoLib.VerifyWithECDsa uses
        // the same managed verifier, so a locally verified signature is guaranteed
        // to verify in-contract and the suite stays deterministic.
        private static byte[] Sign(Harness h, byte[] digest)
        {
            for (int attempt = 0; attempt < 16; attempt++)
            {
                byte[] signature = Neo.Cryptography.Crypto.Sign(
                    digest, h.Verifier.PrivateKey, Neo.Cryptography.ECC.ECCurve.Secp256r1);
                if (Neo.Cryptography.Crypto.VerifySignature(digest, signature, h.Verifier.PublicKey))
                    return signature;
            }
            throw new InvalidOperationException("could not produce a locally verifiable signature");
        }

        private static object Field(Registry contract, UInt160 vault, int index)
        {
            IList<object> record = contract.GetBinding(vault, Provider, ClaimType)!;
            return record[index];
        }

        // Struct fields of ByteString type come back from the engine as VM stack
        // items rather than native CLR values; normalize before asserting.
        private static byte[] AsBytes(object value) => value switch
        {
            byte[] bytes => bytes,
            string text => System.Text.Encoding.UTF8.GetBytes(text),
            Neo.VM.Types.ByteString item => item.GetSpan().ToArray(),
            Neo.VM.Types.Buffer item => item.GetSpan().ToArray(),
            _ => throw new InvalidOperationException($"unexpected field type {value?.GetType()}"),
        };

        private static string AsUtf8(object value) =>
            System.Text.Encoding.UTF8.GetString(AsBytes(value));

        private static bool AsBool(object value) => value switch
        {
            bool flag => flag,
            Neo.VM.Types.StackItem item => item.GetBoolean(),
            _ => throw new InvalidOperationException($"unexpected field type {value?.GetType()}"),
        };

        private static void AssertReverts(Action action, string messageFragment)
        {
            Exception ex = Assert.ThrowsAny<Exception>(action);
            Assert.Contains(messageFragment, ex.ToString());
        }

        private static void Register(
            Harness h, UInt160 vault, byte[] nullifier, byte[] metadataHash, byte[] signature)
        {
            h.Contract.RegisterBinding(
                vault, Provider, ClaimType, ClaimValue, nullifier, metadataHash, signature);
        }

        [Fact]
        public void RegisterBinding_WithReplicatedDigest_RecordsBindingAndNullifier()
        {
            Harness h = Deploy();
            UInt160 vault = TestEngine.GetNewSigner().Account;
            byte[] nullifier = FixedHash(0x11);
            byte[] metadataHash = FixedHash(0x22);

            byte[] digest = ComputeBindingDigest(
                vault, Provider, ClaimType, ClaimValue, nullifier, metadataHash,
                ProtocolSettings.Default.Network);
            Register(h, vault, nullifier, metadataHash, Sign(h, digest));

            // The contract accepted a signature over the locally replicated digest,
            // proving the byte layouts are identical.
            Assert.True(AsBool(Field(h.Contract, vault, ActiveIndex)));
            Assert.Equal(ClaimValue, AsUtf8(Field(h.Contract, vault, ClaimValueIndex)));
            Assert.Equal(nullifier, AsBytes(Field(h.Contract, vault, MasterNullifierIndex)));
            Assert.True((BigInteger)Field(h.Contract, vault, CreatedAtIndex) > 0);
            Assert.Equal(BigInteger.Zero, (BigInteger)Field(h.Contract, vault, RevokedAtIndex));
            Assert.True(h.Contract.IsMasterNullifierUsed(nullifier));
        }

        [Fact]
        public void RegisterBinding_RejectsSignatureOverDifferentClaimValue()
        {
            Harness h = Deploy();
            UInt160 vault = TestEngine.GetNewSigner().Account;
            byte[] nullifier = FixedHash(0x11);
            byte[] metadataHash = FixedHash(0x22);

            // Valid signature, but over a digest binding a DIFFERENT claim value:
            // the signature must not transfer to the submitted arguments.
            byte[] digest = ComputeBindingDigest(
                vault, Provider, ClaimType, "impostor", nullifier, metadataHash,
                ProtocolSettings.Default.Network);
            AssertReverts(
                () => Register(h, vault, nullifier, metadataHash, Sign(h, digest)),
                "invalid verification signature");
            Assert.False(h.Contract.IsMasterNullifierUsed(nullifier));
        }

        [Fact]
        public void RegisterBinding_RequiresVaultOrAdminWitness()
        {
            Harness h = Deploy();
            UInt160 vault = TestEngine.GetNewSigner().Account;
            byte[] nullifier = FixedHash(0x11);
            byte[] metadataHash = FixedHash(0x22);
            byte[] signature = Sign(h, ComputeBindingDigest(
                vault, Provider, ClaimType, ClaimValue, nullifier, metadataHash,
                ProtocolSettings.Default.Network));

            // A valid worker-signed ticket is NOT sufficient: a third party who is
            // neither the vault owner nor the admin cannot register the binding.
            h.Engine.SetTransactionSigners(TestEngine.GetNewSigner().Account);
            AssertReverts(
                () => Register(h, vault, nullifier, metadataHash, signature),
                "unauthorized");
            // The witness check runs before the nullifier is consumed.
            Assert.False(h.Contract.IsMasterNullifierUsed(nullifier));

            // The vault owner can register their own binding.
            h.Engine.SetTransactionSigners(vault);
            Register(h, vault, nullifier, metadataHash, signature);
            Assert.True(AsBool(Field(h.Contract, vault, ActiveIndex)));
            Assert.True(h.Contract.IsMasterNullifierUsed(nullifier));
        }

        [Fact]
        public void RegisterBinding_RejectsCrossNetworkReplay()
        {
            Harness h = Deploy();
            UInt160 vault = TestEngine.GetNewSigner().Account;
            byte[] nullifier = FixedHash(0x11);
            byte[] metadataHash = FixedHash(0x22);

            // A signature minted for another network magic must be rejected here.
            byte[] foreignDigest = ComputeBindingDigest(
                vault, Provider, ClaimType, ClaimValue, nullifier, metadataHash,
                ProtocolSettings.Default.Network + 1);
            AssertReverts(
                () => Register(h, vault, nullifier, metadataHash, Sign(h, foreignDigest)),
                "invalid verification signature");
        }

        [Fact]
        public void RegisterBinding_RejectsMasterNullifierReuse_AndDuplicateBinding()
        {
            Harness h = Deploy();
            UInt160 vault = TestEngine.GetNewSigner().Account;
            UInt160 otherVault = TestEngine.GetNewSigner().Account;
            byte[] nullifier = FixedHash(0x11);
            byte[] metadataHash = FixedHash(0x22);
            uint network = ProtocolSettings.Default.Network;

            Register(h, vault, nullifier, metadataHash, Sign(h, ComputeBindingDigest(
                vault, Provider, ClaimType, ClaimValue, nullifier, metadataHash, network)));

            // Replaying the SAME nullifier under a different vault must fail even
            // with a perfectly valid signature for that vault.
            AssertReverts(
                () => Register(h, otherVault, nullifier, metadataHash, Sign(h, ComputeBindingDigest(
                    otherVault, Provider, ClaimType, ClaimValue, nullifier, metadataHash, network))),
                "master nullifier already used");

            // And re-registering the same (vault, provider, claimType) key with a
            // FRESH nullifier must fail while the binding is still active.
            byte[] freshNullifier = FixedHash(0x33);
            AssertReverts(
                () => Register(h, vault, freshNullifier, metadataHash, Sign(h, ComputeBindingDigest(
                    vault, Provider, ClaimType, ClaimValue, freshNullifier, metadataHash, network))),
                "binding already exists");
        }

        [Fact]
        public void RevokeBinding_RequiresVaultOrAdminWitness_AndAllowsReRegistration()
        {
            Harness h = Deploy();
            UInt160 vault = TestEngine.GetNewSigner().Account;
            byte[] nullifier = FixedHash(0x11);
            byte[] metadataHash = FixedHash(0x22);
            uint network = ProtocolSettings.Default.Network;

            Register(h, vault, nullifier, metadataHash, Sign(h, ComputeBindingDigest(
                vault, Provider, ClaimType, ClaimValue, nullifier, metadataHash, network)));

            // A stranger (neither the vault nor the admin) cannot revoke.
            h.Engine.SetTransactionSigners(TestEngine.GetNewSigner().Account);
            AssertReverts(
                () => h.Contract.RevokeBinding(vault, Provider, ClaimType),
                "unauthorized");

            // The vault owner can.
            h.Engine.SetTransactionSigners(vault);
            h.Contract.RevokeBinding(vault, Provider, ClaimType);
            Assert.False(AsBool(Field(h.Contract, vault, ActiveIndex)));
            Assert.True((BigInteger)Field(h.Contract, vault, RevokedAtIndex) > 0);

            // Revoking an already-revoked binding fails.
            AssertReverts(
                () => h.Contract.RevokeBinding(vault, Provider, ClaimType),
                "binding not active");

            // The consumed master nullifier stays burned, but the binding key is
            // free again: re-registration with a FRESH nullifier succeeds.
            Assert.True(h.Contract.IsMasterNullifierUsed(nullifier));
            byte[] freshNullifier = FixedHash(0x33);
            Register(h, vault, freshNullifier, metadataHash, Sign(h, ComputeBindingDigest(
                vault, Provider, ClaimType, ClaimValue, freshNullifier, metadataHash, network)));
            Assert.True(AsBool(Field(h.Contract, vault, ActiveIndex)));
        }

        [Fact]
        public void UseActionTicket_ConsumesNullifierOnce_AndRequiresAccountWitness()
        {
            Harness h = Deploy();
            UInt160 disposable = TestEngine.GetNewSigner().Account;
            const string actionId = "transfer:gas:once";
            byte[] actionNullifier = FixedHash(0x44);
            byte[] digest = ComputeActionDigest(
                disposable, actionId, actionNullifier, ProtocolSettings.Default.Network);
            byte[] signature = Sign(h, digest);

            // The ticket is bound to the disposable account's witness: a different
            // signer cannot spend it even with the valid oracle signature.
            h.Engine.SetTransactionSigners(TestEngine.GetNewSigner().Account);
            AssertReverts(
                () => h.Contract.UseActionTicket(disposable, actionId, actionNullifier, signature),
                "unauthorized");
            Assert.False(h.Contract.IsActionNullifierUsed(actionNullifier));

            h.Engine.SetTransactionSigners(disposable);
            Assert.True(h.Contract.UseActionTicket(disposable, actionId, actionNullifier, signature));
            Assert.True(h.Contract.IsActionNullifierUsed(actionNullifier));

            // Single-use: replaying the identical, once-valid ticket must fail.
            AssertReverts(
                () => h.Contract.UseActionTicket(disposable, actionId, actionNullifier, signature),
                "action nullifier already used");
        }

        [Fact]
        public void UseActionTicket_RejectsSignatureOverDifferentActionId()
        {
            Harness h = Deploy();
            UInt160 disposable = TestEngine.GetNewSigner().Account;
            byte[] actionNullifier = FixedHash(0x44);

            byte[] digest = ComputeActionDigest(
                disposable, "action:granted", actionNullifier, ProtocolSettings.Default.Network);
            byte[] signature = Sign(h, digest);

            h.Engine.SetTransactionSigners(disposable);
            AssertReverts(
                () => h.Contract.UseActionTicket(disposable, "action:escalated", actionNullifier, signature),
                "invalid verification signature");
            Assert.False(h.Contract.IsActionNullifierUsed(actionNullifier));
        }

        // ---------------------------------------------------------------------
        // C# replicas of the contract's digest builders (and the off-chain NeoDID
        // signer).  If the registrations above verify, the contract computes the
        // identical bytes.
        // ---------------------------------------------------------------------

        private static byte[] ComputeBindingDigest(
            UInt160 vaultAccount, string provider, string claimType, string claimValue,
            byte[] masterNullifier, byte[] metadataHash, uint network)
        {
            var payload = new List<byte>();
            payload.AddRange(System.Text.Encoding.ASCII.GetBytes("neodid-binding-v1"));
            payload.AddRange(CanonicalHash160(vaultAccount));
            payload.AddRange(EncodeSegment(provider));
            payload.AddRange(EncodeSegment(claimType));
            payload.AddRange(EncodeSegment(claimValue));
            payload.AddRange(masterNullifier);
            payload.AddRange(metadataHash);
            payload.AddRange(NetworkMagicLe4(network));
            return Sha256(payload.ToArray());
        }

        private static byte[] ComputeActionDigest(
            UInt160 disposableAccount, string actionId, byte[] actionNullifier, uint network)
        {
            var payload = new List<byte>();
            payload.AddRange(System.Text.Encoding.ASCII.GetBytes("neodid-action-v1"));
            payload.AddRange(CanonicalHash160(disposableAccount));
            payload.AddRange(EncodeSegment(actionId));
            payload.AddRange(actionNullifier);
            payload.AddRange(NetworkMagicLe4(network));
            return Sha256(payload.ToArray());
        }

        // Mirrors EncodeCanonicalHash160: the little-endian script hash reversed
        // into canonical big-endian byte order.
        private static byte[] CanonicalHash160(UInt160 value)
        {
            byte[] le = value.GetSpan().ToArray();
            byte[] be = new byte[le.Length];
            for (int i = 0; i < le.Length; i++) be[i] = le[le.Length - 1 - i];
            return be;
        }

        // Mirrors EncodeSegment: single length byte followed by the UTF-8 bytes.
        private static byte[] EncodeSegment(string value)
        {
            byte[] bytes = System.Text.Encoding.UTF8.GetBytes(value ?? "");
            Assert.True(bytes.Length <= 255, "segment too long for test replica");
            byte[] segment = new byte[bytes.Length + 1];
            segment[0] = (byte)bytes.Length;
            Array.Copy(bytes, 0, segment, 1, bytes.Length);
            return segment;
        }

        private static byte[] NetworkMagicLe4(uint network) => new[]
        {
            (byte)(network & 0xFF),
            (byte)((network >> 8) & 0xFF),
            (byte)((network >> 16) & 0xFF),
            (byte)((network >> 24) & 0xFF),
        };

        private static byte[] Sha256(byte[] data)
        {
            using var sha = System.Security.Cryptography.SHA256.Create();
            return sha.ComputeHash(data);
        }
    }
}
