using System;
using System.Collections.Generic;
using System.Globalization;
using System.Numerics;
using System.Text;
using Neo;
using Neo.Cryptography.ECC;
using Neo.SmartContract.Testing;
using Neo.Wallets;
using Xunit;
using DataFeed = Neo.SmartContract.Testing.MorpheusDataFeed;

namespace MorpheusOracle.Contracts.Tests
{
    /// <summary>
    /// VM-level coverage for the on-chain price-signature check (C1). The feed keeps
    /// its original updater-witness gate; once an admin registers a verification key
    /// the signature becomes MANDATORY: every updater-witness write must carry a
    /// signature that verifies against the canonical v2 feed message (all stored
    /// fields plus deployment/network binding), and the unsigned paths (UpdateFeed/UpdateFeeds,
    /// or UpdateFeedSigned with an empty signature) REVERT. This is what closes the
    /// leaked-updater-witness bypass — verification is no longer caller-opt-in.
    ///
    /// The verification must stay inert until a key is registered: with no key the
    /// witness-only writes behave exactly as before, so existing publishers are not
    /// broken until the operator deliberately registers a key.
    ///
    /// Same harness pattern as <see cref="MorpheusDataFeedEngineTests"/> and
    /// <see cref="NeoDIDRegistryEngineTests"/>. The deployed contract is the
    /// generated artifact under Generated/ (produced by
    /// `nccs MorpheusDataFeed.csproj --generate-artifacts Source`). Regenerate it
    /// when the contract changes.
    /// </summary>
    public class MorpheusDataFeedSignatureTests
    {
        private const string Pair = "BTC-USD";

        private const int RoundIdIndex = 1;
        private const int PriceIndex = 2;
        private const int TimestampIndex = 3;
        private const int AttestationHashIndex = 4;
        private const int SourceSetIdIndex = 5;

        private sealed record Harness(TestEngine Engine, DataFeed Contract, UInt160 Admin, UInt160 Updater, KeyPair Signer);

        private static Harness Deploy()
        {
            // ProtocolSettings.Default has no standby committee, which makes the
            // genesis un-mintable, so seed a 1-key committee (same pattern as the
            // other engine harnesses).
            byte[] priv = new byte[32];
            priv[31] = 1;
            ProtocolSettings settings = ProtocolSettings.Default with
            {
                StandbyCommittee = new[] { new KeyPair(priv).PublicKey },
                ValidatorsCount = 1,
            };

            TestEngine engine = new(settings, true);
            engine.Fee = 1_000 * 100_000_000L;
            UInt160 admin = engine.Sender;
            engine.SetTransactionSigners(admin); // deployer => admin (set in _deploy)

            DataFeed contract = engine.Deploy<DataFeed>(DataFeed.Nef, DataFeed.Manifest, null);
            Assert.Equal(admin, contract.Admin);

            UInt160 updater = TestEngine.GetNewSigner().Account;
            contract.SetUpdater(updater);
            Assert.Equal(updater, contract.Updater);

            // Off-chain price signer. Distinct from admin and updater so the tests
            // prove the signature is an independent second factor.
            byte[] signerPriv = new byte[32];
            signerPriv[31] = 7;
            KeyPair signer = new KeyPair(signerPriv);

            return new Harness(engine, contract, admin, updater, signer);
        }

        private static void AssertReverts(Action action, string messageFragment)
        {
            Exception ex = Assert.ThrowsAny<Exception>(action);
            Assert.Contains(messageFragment, ex.ToString());
        }

        // Canonical v2 message replica. Keep this byte-for-byte identical to the
        // contract's BuildFeedMessage, including the VM little-endian script hash.
        private static byte[] FeedMessage(
            Harness h,
            string pair,
            BigInteger price,
            BigInteger timestamp,
            BigInteger roundId,
            byte[]? attestationHash = null,
            BigInteger? sourceSetId = null,
            byte[]? executingScriptHashLe = null,
            uint? network = null)
        {
            var payload = new List<byte>();
            payload.AddRange(Encoding.ASCII.GetBytes("morpheus-datafeed-v2"));
            payload.AddRange(executingScriptHashLe ?? h.Contract.Hash.GetSpan().ToArray());
            payload.AddRange(NetworkMagicLe4(network ?? ProtocolSettings.Default.Network));
            payload.AddRange(EncodeSegment(Encoding.UTF8.GetBytes(pair ?? "")));
            payload.AddRange(EncodeSegment(Encoding.ASCII.GetBytes(price.ToString(CultureInfo.InvariantCulture))));
            payload.AddRange(EncodeSegment(Encoding.ASCII.GetBytes(timestamp.ToString(CultureInfo.InvariantCulture))));
            payload.AddRange(EncodeSegment(Encoding.ASCII.GetBytes(roundId.ToString(CultureInfo.InvariantCulture))));
            payload.AddRange(EncodeSegment(attestationHash ?? Array.Empty<byte>()));
            payload.AddRange(EncodeSegment(Encoding.ASCII.GetBytes(
                (sourceSetId ?? 1).ToString(CultureInfo.InvariantCulture))));
            return payload.ToArray();
        }

        private static byte[] EncodeSegment(byte[] value)
        {
            Assert.NotNull(value);
            Assert.True(value.Length <= 255, "segment too long for test replica");
            var segment = new byte[value.Length + 1];
            segment[0] = (byte)value.Length;
            Array.Copy(value, 0, segment, 1, value.Length);
            return segment;
        }

        private static byte[] NetworkMagicLe4(uint network) => new[]
        {
            (byte)(network & 0xFF),
            (byte)((network >> 8) & 0xFF),
            (byte)((network >> 16) & 0xFF),
            (byte)((network >> 24) & 0xFF),
        };

        // Crypto.Sign on this platform occasionally emits an invalid signature for
        // a given nonce; Neo's managed verifier (the same one CryptoLib.VerifyWithECDsa
        // uses in-VM) rejects those deterministically. Re-sign until the signature
        // round-trips locally so a locally verified signature is guaranteed to verify
        // in-contract and the suite stays deterministic. Same approach as the NeoDID
        // engine tests.
        private static byte[] Sign(KeyPair signer, byte[] message)
        {
            for (int attempt = 0; attempt < 16; attempt++)
            {
                byte[] signature = Neo.Cryptography.Crypto.Sign(
                    message, signer.PrivateKey, ECCurve.Secp256r1);
                if (Neo.Cryptography.Crypto.VerifySignature(message, signature, signer.PublicKey))
                    return signature;
            }
            throw new InvalidOperationException("could not produce a locally verifiable signature");
        }

        private static BigInteger Field(Harness h, int index)
        {
            IList<object> record = h.Contract.GetLatest(Pair)!;
            return (BigInteger)record[index];
        }

        private static void AssertLatest(Harness h, BigInteger roundId, BigInteger price, BigInteger timestamp)
        {
            Assert.Equal(roundId, Field(h, RoundIdIndex));
            Assert.Equal(price, Field(h, PriceIndex));
            Assert.Equal(timestamp, Field(h, TimestampIndex));
        }

        [Fact]
        public void VerificationKey_IsUnsetByDefault_AndWritesStayWitnessOnly()
        {
            Harness h = Deploy();

            // No key registered: the verification path is inert.
            Assert.Null(h.Contract.OracleVerificationKey);

            // The plain (unsigned) updater write succeeds exactly as before.
            h.Engine.SetTransactionSigners(h.Updater);
            h.Contract.UpdateFeed(Pair, 1, 50_000, 1_000, Array.Empty<byte>(), 1);
            AssertLatest(h, 1, 50_000, 1_000);

            // A signed write with no key registered also succeeds — the signature is
            // simply ignored (even a bogus one), preserving the original behavior.
            h.Contract.UpdateFeedSigned(Pair, 2, 51_000, 1_001, Array.Empty<byte>(), 1, new byte[] { 0xAA, 0xBB });
            AssertLatest(h, 2, 51_000, 1_001);
        }

        [Fact]
        public void SetOracleVerificationKey_IsAdminGated()
        {
            Harness h = Deploy();

            // The updater (a different role) cannot register the verification key.
            h.Engine.SetTransactionSigners(h.Updater);
            AssertReverts(() => h.Contract.SetOracleVerificationKey(h.Signer.PublicKey), "unauthorized");

            // The admin can, and it is then readable.
            h.Engine.SetTransactionSigners(h.Admin);
            h.Contract.SetOracleVerificationKey(h.Signer.PublicKey);
            Assert.Equal(h.Signer.PublicKey, h.Contract.OracleVerificationKey);
        }

        [Fact]
        public void UpdateFeedSigned_WithRegisteredKey_AcceptsAValidSignature()
        {
            Harness h = Deploy();

            h.Engine.SetTransactionSigners(h.Admin);
            h.Contract.SetOracleVerificationKey(h.Signer.PublicKey);

            BigInteger roundId = 1;
            BigInteger price = 50_000;
            BigInteger timestamp = 1_000;
            byte[] signature = Sign(h.Signer, FeedMessage(h, Pair, price, timestamp, roundId));

            h.Engine.SetTransactionSigners(h.Updater);
            h.Contract.UpdateFeedSigned(Pair, roundId, price, timestamp, Array.Empty<byte>(), 1, signature);
            AssertLatest(h, roundId, price, timestamp);
        }

        [Fact]
        public void UpdateFeedSigned_BindsMetadataDeploymentAndNetwork()
        {
            Harness h = Deploy();

            h.Engine.SetTransactionSigners(h.Admin);
            h.Contract.SetOracleVerificationKey(h.Signer.PublicKey);
            h.Engine.SetTransactionSigners(h.Updater);

            BigInteger roundId = 7;
            BigInteger price = 50_123;
            BigInteger timestamp = 1_700_000_000;
            BigInteger sourceSetId = 9;
            byte[] attestationHash = new byte[] { 0x10, 0x20, 0x30, 0x40 };
            byte[] signature = Sign(
                h.Signer,
                FeedMessage(h, Pair, price, timestamp, roundId, attestationHash, sourceSetId));

            // A valid price tuple may not be paired with substituted provenance.
            AssertReverts(
                () => h.Contract.UpdateFeedSigned(
                    Pair,
                    roundId,
                    price,
                    timestamp,
                    new byte[] { 0x10, 0x20, 0x30, 0x41 },
                    sourceSetId,
                    signature),
                "invalid feed signature");
            AssertReverts(
                () => h.Contract.UpdateFeedSigned(
                    Pair,
                    roundId,
                    price,
                    timestamp,
                    attestationHash,
                    sourceSetId + 1,
                    signature),
                "invalid feed signature");

            // The same tuple signed for another deployment or network is not reusable.
            byte[] otherScriptHash = h.Contract.Hash.GetSpan().ToArray();
            otherScriptHash[0] ^= 0x01;
            byte[] otherDeploymentSignature = Sign(
                h.Signer,
                FeedMessage(
                    h,
                    Pair,
                    price,
                    timestamp,
                    roundId,
                    attestationHash,
                    sourceSetId,
                    otherScriptHash));
            AssertReverts(
                () => h.Contract.UpdateFeedSigned(
                    Pair, roundId, price, timestamp, attestationHash, sourceSetId, otherDeploymentSignature),
                "invalid feed signature");

            byte[] otherNetworkSignature = Sign(
                h.Signer,
                FeedMessage(
                    h,
                    Pair,
                    price,
                    timestamp,
                    roundId,
                    attestationHash,
                    sourceSetId,
                    network: ProtocolSettings.Default.Network + 1));
            AssertReverts(
                () => h.Contract.UpdateFeedSigned(
                    Pair, roundId, price, timestamp, attestationHash, sourceSetId, otherNetworkSignature),
                "invalid feed signature");

            Assert.Equal(BigInteger.Zero, h.Contract.PairCount);

            h.Contract.UpdateFeedSigned(
                Pair, roundId, price, timestamp, attestationHash, sourceSetId, signature);
            IList<object> stored = h.Contract.GetLatest(Pair)!;
            Assert.Equal(
                attestationHash,
                ((Neo.VM.Types.ByteString)stored[AttestationHashIndex]).GetSpan().ToArray());
            Assert.Equal(sourceSetId, (BigInteger)stored[SourceSetIdIndex]);
        }

        [Fact]
        public void UpdateFeedSigned_WithRegisteredKey_RejectsAMismatchedSignature()
        {
            Harness h = Deploy();

            h.Engine.SetTransactionSigners(h.Admin);
            h.Contract.SetOracleVerificationKey(h.Signer.PublicKey);

            // A signature over a DIFFERENT price must not transfer to the submitted
            // arguments: a leaked updater witness alone can no longer anchor an
            // arbitrary value.
            byte[] signatureOverOtherPrice = Sign(h.Signer, FeedMessage(h, Pair, 99_999, 1_000, 1));

            h.Engine.SetTransactionSigners(h.Updater);
            AssertReverts(
                () => h.Contract.UpdateFeedSigned(Pair, 1, 50_000, 1_000, Array.Empty<byte>(), 1, signatureOverOtherPrice),
                "invalid feed signature");

            // A signature from a DIFFERENT key is also rejected.
            byte[] otherPriv = new byte[32];
            otherPriv[31] = 8;
            KeyPair otherSigner = new KeyPair(otherPriv);
            byte[] foreignSignature = Sign(otherSigner, FeedMessage(h, Pair, 50_000, 1_000, 1));
            AssertReverts(
                () => h.Contract.UpdateFeedSigned(Pair, 1, 50_000, 1_000, Array.Empty<byte>(), 1, foreignSignature),
                "invalid feed signature");

            // The feed was never written by the rejected attempts.
            Assert.Equal(BigInteger.Zero, h.Contract.PairCount);
        }

        [Fact]
        public void UnsignedWrites_AreRejected_OnceKeyIsRegistered()
        {
            // THE core proof that the leaked-updater-witness bypass is closed: once a
            // verification key is registered, neither the witness-only UpdateFeed nor a
            // UpdateFeedSigned carrying an empty signature can anchor a value. A leaked
            // updater witness alone is no longer sufficient.
            Harness h = Deploy();

            h.Engine.SetTransactionSigners(h.Admin);
            h.Contract.SetOracleVerificationKey(h.Signer.PublicKey);

            h.Engine.SetTransactionSigners(h.Updater);

            // The original 6-parameter (unsigned) UpdateFeed now REVERTS — there is no
            // signature to verify against the registered key.
            AssertReverts(
                () => h.Contract.UpdateFeed(Pair, 1, 50_000, 1_000, Array.Empty<byte>(), 1),
                "feed signature required");

            // UpdateFeedSigned with an empty signature is the same unsigned path and is
            // likewise rejected.
            AssertReverts(
                () => h.Contract.UpdateFeedSigned(Pair, 1, 50_000, 1_000, Array.Empty<byte>(), 1, Array.Empty<byte>()),
                "feed signature required");

            // Nothing was written by either rejected attempt.
            Assert.Equal(BigInteger.Zero, h.Contract.PairCount);

            // For completeness: a correctly-signed write over the SAME arguments still
            // succeeds, so the feed is not bricked — only the unsigned bypass is closed.
            BigInteger roundId = 1;
            BigInteger price = 50_000;
            BigInteger timestamp = 1_000;
            byte[] signature = Sign(h.Signer, FeedMessage(h, Pair, price, timestamp, roundId));
            h.Contract.UpdateFeedSigned(Pair, roundId, price, timestamp, Array.Empty<byte>(), 1, signature);
            AssertLatest(h, roundId, price, timestamp);
        }

        [Fact]
        public void UpdateFeeds_BatchUnsignedWrites_AreRejected_OnceKeyIsRegistered()
        {
            // The batch witness-only path is gated by the same mandatory check, so a
            // leaked updater witness cannot batch-anchor arbitrary prices either.
            Harness h = Deploy();

            h.Engine.SetTransactionSigners(h.Admin);
            h.Contract.SetOracleVerificationKey(h.Signer.PublicKey);

            h.Engine.SetTransactionSigners(h.Updater);
            AssertReverts(
                () => h.Contract.UpdateFeeds(
                    new object[] { Pair },
                    new object[] { 1 },
                    new object[] { 50_000 },
                    new object[] { 1_000 },
                    new object[] { Array.Empty<byte>() },
                    new object[] { 1 }),
                "feed signature required");
            Assert.Equal(BigInteger.Zero, h.Contract.PairCount);
        }

        [Fact]
        public void UnsignedWrites_StillWork_WhileNoKeyIsRegistered()
        {
            // Backward compatibility: with NO verification key the witness-only path is
            // unchanged — existing publishers keep working exactly as before.
            Harness h = Deploy();
            Assert.Null(h.Contract.OracleVerificationKey);

            h.Engine.SetTransactionSigners(h.Updater);
            h.Contract.UpdateFeed(Pair, 1, 50_000, 1_000, Array.Empty<byte>(), 1);
            AssertLatest(h, 1, 50_000, 1_000);

            h.Contract.UpdateFeeds(
                new object[] { Pair },
                new object[] { 2 },
                new object[] { 51_000 },
                new object[] { 1_001 },
                new object[] { Array.Empty<byte>() },
                new object[] { 1 });
            AssertLatest(h, 2, 51_000, 1_001);
        }

        [Fact]
        public void ClearOracleVerificationKey_RevertsToWitnessOnly()
        {
            Harness h = Deploy();

            h.Engine.SetTransactionSigners(h.Admin);
            h.Contract.SetOracleVerificationKey(h.Signer.PublicKey);
            Assert.Equal(h.Signer.PublicKey, h.Contract.OracleVerificationKey);

            // While the key is registered, a signed write with a mismatched signature
            // is rejected.
            h.Engine.SetTransactionSigners(h.Updater);
            byte[] badSignature = Sign(h.Signer, FeedMessage(h, Pair, 1, 1, 1));
            AssertReverts(
                () => h.Contract.UpdateFeedSigned(Pair, 1, 50_000, 1_000, Array.Empty<byte>(), 1, badSignature),
                "invalid feed signature");

            // Clearing the key (admin-only) reverts to witness-only behavior.
            h.Engine.SetTransactionSigners(h.Updater);
            AssertReverts(() => h.Contract.ClearOracleVerificationKey(), "unauthorized");

            h.Engine.SetTransactionSigners(h.Admin);
            h.Contract.ClearOracleVerificationKey();
            Assert.Null(h.Contract.OracleVerificationKey);

            // The same previously-rejected signed write now succeeds: verification is
            // inert again.
            h.Engine.SetTransactionSigners(h.Updater);
            h.Contract.UpdateFeedSigned(Pair, 1, 50_000, 1_000, Array.Empty<byte>(), 1, badSignature);
            AssertLatest(h, 1, 50_000, 1_000);
        }
    }
}
