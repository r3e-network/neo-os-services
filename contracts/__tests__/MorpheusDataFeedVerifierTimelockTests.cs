using System;
using System.Collections.Generic;
using System.Numerics;
using System.Reflection;
using Neo;
using Neo.Network.P2P.Payloads;
using Neo.SmartContract.Testing;
using Neo.Wallets;
using Xunit;
using DataFeed = Neo.SmartContract.Testing.MorpheusDataFeed;

namespace MorpheusOracle.Contracts.Tests
{
    /// <summary>
    /// VM-level coverage for SVC-E-3: the feed's verification key is the second
    /// factor that stops a leaked updater witness from anchoring a price, so the
    /// authority to re-point or remove it must not be exercisable inside a single
    /// admin transaction.
    ///
    /// Before this change <c>SetOracleVerificationKey</c> / <c>ClearOracleVerificationKey</c>
    /// were ValidateAdmin() + an immediate Storage.Put/Delete, so a stolen admin key
    /// could clear the key and publish an arbitrary price in the same transaction —
    /// while the sibling contracts already timelocked exactly this authority
    /// (MorpheusOracle.ProposeRuntimeVerificationPublicKey, NeoDIDRegistry.ProposeVerifier).
    /// The same 24h propose/wait/execute shape now guards it here.
    ///
    /// The second half covers <c>AdminResetFeed</c>. It stays immediate — that is its
    /// documented purpose, un-stalling a feed poisoned by a bad publish — but it may no
    /// longer look like an attested update: it cannot carry an attestationHash, the
    /// record it writes stores an empty one, and it announces itself with its own
    /// AdminFeedReset event beside FeedUpdated.
    ///
    /// The deployed contract is the generated artifact under Generated/ (produced by
    /// `nccs MorpheusDataFeed.csproj --generate-artifacts Source`). Regenerate it when
    /// the contract changes.
    /// </summary>
    public class MorpheusDataFeedVerifierTimelockTests
    {
        private const string Pair = "BTC-USD";
        private const int AttestationHashIndex = 4;

        private sealed record Harness(TestEngine Engine, DataFeed Contract, UInt160 Admin, UInt160 Updater, KeyPair Signer);

        private static Harness Deploy()
        {
            // ProtocolSettings.Default has no standby committee, which makes the genesis
            // un-mintable, so seed a 1-key committee (same pattern as the other engine
            // harnesses).
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

            byte[] signerPriv = new byte[32];
            signerPriv[31] = 7;
            return new Harness(engine, contract, admin, updater, new KeyPair(signerPriv));
        }

        private static void AssertReverts(Action action, string messageFragment)
        {
            Exception ex = Assert.ThrowsAny<Exception>(action);
            Assert.Contains(messageFragment, ex.ToString());
        }

        // PersistingBlock.Timestamp is read-only; the supported way to move Runtime.Time
        // forward is the underlying block header (same reflection as MorpheusOracleTimelockTests).
        private static void AdvanceTimeMs(TestEngine engine, ulong deltaMs)
        {
            object persistingBlock = engine.PersistingBlock;
            Block block = (Block)persistingBlock.GetType()
                .GetField("UnderlyingBlock", BindingFlags.NonPublic | BindingFlags.Instance)!
                .GetValue(persistingBlock)!;
            block.Header.Timestamp = (ulong)engine.PersistingBlock.Timestamp.TotalMilliseconds + deltaMs;
        }

        private static void AdvancePastTimelock(TestEngine engine) =>
            AdvanceTimeMs(engine, 86_400_000 + 1_000);

        private static void InstallKey(Harness h)
        {
            h.Engine.SetTransactionSigners(h.Admin);
            h.Contract.ProposeOracleVerificationKey(h.Signer.PublicKey);
            AdvancePastTimelock(h.Engine);
            h.Contract.ExecuteOracleVerificationKeyChange();
            Assert.Equal(h.Signer.PublicKey, h.Contract.OracleVerificationKey);
        }

        private static byte[] StoredAttestationHash(Harness h)
        {
            IList<object> record = h.Contract.GetLatest(Pair)!;
            return ((Neo.VM.Types.ByteString)record[AttestationHashIndex]).GetSpan().ToArray();
        }

        [Fact]
        public void RegisteringTheVerificationKey_RequiresTheTimelock()
        {
            Harness h = Deploy();
            Assert.Null(h.Contract.OracleVerificationKey);

            h.Engine.SetTransactionSigners(h.Admin);
            h.Contract.ProposeOracleVerificationKey(h.Signer.PublicKey);

            // Proposing publishes the intent and the ETA, and changes nothing else.
            Assert.Equal(h.Signer.PublicKey, h.Contract.PendingOracleVerificationKey);
            Assert.False(h.Contract.PendingOracleVerificationKeyIsClear);
            Assert.True(h.Contract.PendingOracleVerificationKeyChangeTime > 0);
            Assert.Null(h.Contract.OracleVerificationKey);

            AssertReverts(() => h.Contract.ExecuteOracleVerificationKeyChange(), "timelock active");

            AdvancePastTimelock(h.Engine);
            h.Contract.ExecuteOracleVerificationKeyChange();
            Assert.Equal(h.Signer.PublicKey, h.Contract.OracleVerificationKey);

            // The pending slot is consumed; a second execute has nothing to apply.
            Assert.Null(h.Contract.PendingOracleVerificationKey);
            Assert.Equal(BigInteger.Zero, h.Contract.PendingOracleVerificationKeyChangeTime);
            AssertReverts(() => h.Contract.ExecuteOracleVerificationKeyChange(), "no pending verification key");
        }

        [Fact]
        public void StolenAdmin_CannotDisarmTheFeedAndForgeAPriceInOneTransaction()
        {
            // The finding's failure scenario: clear the verification key and anchor an
            // arbitrary price with the leaked updater witness, atomically. With the
            // timelock the disarm cannot take effect for 24h, so the unsigned write
            // stays rejected for the whole notice window.
            Harness h = Deploy();
            InstallKey(h);

            h.Engine.SetTransactionSigners(h.Admin);
            h.Contract.ProposeClearOracleVerificationKey();
            Assert.True(h.Contract.PendingOracleVerificationKeyIsClear);
            Assert.Null(h.Contract.PendingOracleVerificationKey);

            // The key is still in force the moment the clear is proposed.
            Assert.Equal(h.Signer.PublicKey, h.Contract.OracleVerificationKey);
            h.Engine.SetTransactionSigners(h.Updater);
            AssertReverts(
                () => h.Contract.UpdateFeed(Pair, 1, 50_000, 1_000, Array.Empty<byte>(), 1),
                "feed signature required");
            Assert.Equal(BigInteger.Zero, h.Contract.PairCount);

            // And it cannot be forced through early.
            h.Engine.SetTransactionSigners(h.Admin);
            AssertReverts(() => h.Contract.ExecuteOracleVerificationKeyChange(), "timelock active");

            // Only after the full delay does the escape hatch actually open.
            AdvancePastTimelock(h.Engine);
            h.Contract.ExecuteOracleVerificationKeyChange();
            Assert.Null(h.Contract.OracleVerificationKey);
            h.Engine.SetTransactionSigners(h.Updater);
            h.Contract.UpdateFeed(Pair, 1, 50_000, 1_000, Array.Empty<byte>(), 1);
            Assert.Equal(BigInteger.One, h.Contract.PairCount);
        }

        [Fact]
        public void PendingVerificationKeyChange_IsSingleSlotted_AndAdminCancellable()
        {
            Harness h = Deploy();
            byte[] otherPriv = new byte[32];
            otherPriv[31] = 8;
            KeyPair other = new KeyPair(otherPriv);

            h.Engine.SetTransactionSigners(h.Admin);
            h.Contract.ProposeOracleVerificationKey(h.Signer.PublicKey);

            // A watcher that has already assessed the pending change must not have it
            // swapped underneath them.
            AssertReverts(
                () => h.Contract.ProposeOracleVerificationKey(other.PublicKey),
                "verification key change already pending");
            AssertReverts(
                () => h.Contract.ProposeClearOracleVerificationKey(),
                "no verification key");

            // Cancel is admin-only.
            h.Engine.SetTransactionSigners(h.Updater);
            AssertReverts(() => h.Contract.CancelOracleVerificationKeyChange(), "unauthorized");

            h.Engine.SetTransactionSigners(h.Admin);
            h.Contract.CancelOracleVerificationKeyChange();
            AdvancePastTimelock(h.Engine);
            AssertReverts(() => h.Contract.ExecuteOracleVerificationKeyChange(), "no pending verification key");
            Assert.Null(h.Contract.OracleVerificationKey);

            // The slot is free again, and a re-proposal of the key already in force is
            // rejected as a no-op once one is installed.
            h.Contract.ProposeOracleVerificationKey(other.PublicKey);
            AdvancePastTimelock(h.Engine);
            h.Contract.ExecuteOracleVerificationKeyChange();
            Assert.Equal(other.PublicKey, h.Contract.OracleVerificationKey);
            AssertReverts(
                () => h.Contract.ProposeOracleVerificationKey(other.PublicKey),
                "same verification key");
        }

        [Fact]
        public void ExecutingAMaturedChange_IsPermissionless()
        {
            // The delay is the control, not the executor — matching ExecuteAdminChange.
            // A watcher or keeper can land an already-announced change.
            Harness h = Deploy();

            h.Engine.SetTransactionSigners(h.Admin);
            h.Contract.ProposeOracleVerificationKey(h.Signer.PublicKey);
            AdvancePastTimelock(h.Engine);

            UInt160 stranger = TestEngine.GetNewSigner().Account;
            h.Engine.SetTransactionSigners(stranger);
            h.Contract.ExecuteOracleVerificationKeyChange();
            Assert.Equal(h.Signer.PublicKey, h.Contract.OracleVerificationKey);
        }

        [Fact]
        public void AdminResetFeed_CannotForgeAnAttestationHash()
        {
            // The forced write used to accept — and store, and emit — any attestationHash
            // the admin chose, making it byte-indistinguishable from an attested update.
            Harness h = Deploy();

            byte[] realHash = new byte[] { 0x10, 0x20, 0x30, 0x40 };
            h.Engine.SetTransactionSigners(h.Updater);
            h.Contract.UpdateFeed(Pair, 5, 50_000, 1_000, realHash, 1);
            Assert.Equal(realHash, StoredAttestationHash(h));

            h.Engine.SetTransactionSigners(h.Admin);
            AssertReverts(
                () => h.Contract.AdminResetFeed(Pair, 1, 99_999, 500, new byte[] { 0xDE, 0xAD, 0xBE, 0xEF }, 1),
                "admin reset may not carry an attestation");

            // The rejected attempt left the attested record untouched.
            Assert.Equal(realHash, StoredAttestationHash(h));

            // The recovery path itself still works and stores an empty hash, so the
            // record does not inherit the previous round's attestation either.
            h.Contract.AdminResetFeed(Pair, 1, 99_999, 500, Array.Empty<byte>(), 1);
            Assert.Empty(StoredAttestationHash(h));
        }

        [Fact]
        public void AdminResetFeed_AnnouncesItselfSeparatelyFromAnAttestedUpdate()
        {
            Harness h = Deploy();

            List<byte[]> feedUpdatedHashes = new();
            List<BigInteger> resetPrices = new();
            h.Contract.OnFeedUpdated += (pair, roundId, price, timestamp, attestationHash, sourceSetId) =>
                feedUpdatedHashes.Add(attestationHash ?? Array.Empty<byte>());
            h.Contract.OnAdminFeedReset += (pair, roundId, price, timestamp, sourceSetId) =>
                resetPrices.Add(price!.Value);

            // An ordinary publisher write emits FeedUpdated only.
            h.Engine.SetTransactionSigners(h.Updater);
            h.Contract.UpdateFeed(Pair, 5, 50_000, 1_000, new byte[] { 0x10, 0x20 }, 1);
            Assert.Single(feedUpdatedHashes);
            Assert.Empty(resetPrices);

            // The admin's forced write is separately identifiable by an indexer.
            h.Engine.SetTransactionSigners(h.Admin);
            h.Contract.AdminResetFeed(Pair, 1, 99_999, 500, Array.Empty<byte>(), 1);
            Assert.Equal(2, feedUpdatedHashes.Count);
            Assert.Empty(feedUpdatedHashes[1]);
            Assert.Equal(new BigInteger[] { 99_999 }, resetPrices);
        }

        [Fact]
        public void AdminResetFeed_StaysImmediate_ForStallRecovery()
        {
            // The documented purpose must not regress: a far-future timestamp stalls the
            // monotonic guard, and the admin must be able to un-stall it now, not in 24h.
            Harness h = Deploy();

            h.Engine.SetTransactionSigners(h.Updater);
            h.Contract.UpdateFeed(Pair, 1_000_000, 50_000, 4_000_000_000, Array.Empty<byte>(), 1);
            AssertReverts(
                () => h.Contract.UpdateFeed(Pair, 2, 51_000, 1_001, Array.Empty<byte>(), 1),
                "stale round");

            h.Engine.SetTransactionSigners(h.Admin);
            h.Contract.AdminResetFeed(Pair, 1, 51_000, 1_000, Array.Empty<byte>(), 1);

            h.Engine.SetTransactionSigners(h.Updater);
            h.Contract.UpdateFeed(Pair, 2, 52_000, 1_001, Array.Empty<byte>(), 1);
            IList<object> record = h.Contract.GetLatest(Pair)!;
            Assert.Equal(new BigInteger(2), (BigInteger)record[1]);
            Assert.Equal(new BigInteger(52_000), (BigInteger)record[2]);
        }
    }
}
