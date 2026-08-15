using System;
using System.Collections.Generic;
using System.Numerics;
using Neo;
using Neo.SmartContract.Testing;
using Neo.Wallets;
using Xunit;
using DataFeed = Neo.SmartContract.Testing.MorpheusDataFeed;

namespace MorpheusOracle.Contracts.Tests
{
    /// <summary>
    /// VM-level coverage for the shared numeric resource registry: updater-gated
    /// writes, round/timestamp monotonicity (stale-round rejection), and the
    /// admin-only AdminResetFeed escape hatch that un-stalls a feed poisoned by a
    /// bad publish (oversized roundId or far-future timestamp).
    ///
    /// Same harness pattern as <see cref="MorpheusOracleFeeAccountingTests"/>. The
    /// deployed contract is the generated artifact under Generated/ (produced by
    /// `nccs MorpheusDataFeed.csproj --generate-artifacts Source`).  Regenerate it
    /// when the contract changes.
    /// </summary>
    public class MorpheusDataFeedEngineTests
    {
        private const string Pair = "BTC-USD";

        // FeedRecord field indices in the serialized struct returned by GetLatest.
        private const int RoundIdIndex = 1;
        private const int PriceIndex = 2;
        private const int TimestampIndex = 3;

        private sealed record Harness(TestEngine Engine, DataFeed Contract, UInt160 Admin, UInt160 Updater);

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

            DataFeed contract = engine.Deploy<DataFeed>(DataFeed.Nef, DataFeed.Manifest, null);
            Assert.Equal(admin, contract.Admin);

            // The updater is a distinct role from the admin so the tests can prove
            // the gates do not bleed into each other.
            UInt160 updater = TestEngine.GetNewSigner().Account;
            contract.SetUpdater(updater);
            Assert.Equal(updater, contract.Updater);

            return new Harness(engine, contract, admin, updater);
        }

        private static void AssertReverts(Action action, string messageFragment)
        {
            Exception ex = Assert.ThrowsAny<Exception>(action);
            Assert.Contains(messageFragment, ex.ToString());
        }

        private static void Update(Harness h, BigInteger roundId, BigInteger price, BigInteger timestamp)
        {
            h.Contract.UpdateFeed(Pair, roundId, price, timestamp, Array.Empty<byte>(), 1);
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
        public void UpdateFeed_RequiresUpdaterWitness()
        {
            Harness h = Deploy();

            // The admin holds a different role and may not publish feed data.
            h.Engine.SetTransactionSigners(h.Admin);
            AssertReverts(() => Update(h, 1, 50_000, 1_000), "unauthorized");

            h.Engine.SetTransactionSigners(h.Updater);
            Update(h, 1, 50_000, 1_000);
            AssertLatest(h, 1, 50_000, 1_000);
            Assert.Equal(BigInteger.One, h.Contract.PairCount);
        }

        [Fact]
        public void UpdateFeed_RejectsStaleRound_AndStaleTimestamp()
        {
            Harness h = Deploy();
            h.Engine.SetTransactionSigners(h.Updater);
            Update(h, 5, 50_000, 1_000);

            // Replayed and rewound rounds are both stale.
            AssertReverts(() => Update(h, 5, 51_000, 1_001), "stale round");
            AssertReverts(() => Update(h, 4, 51_000, 1_001), "stale round");

            // A fresh round may not rewind the clock.
            AssertReverts(() => Update(h, 6, 51_000, 999), "stale timestamp");

            // The rejected writes left the record untouched, and a well-formed
            // successor still lands.
            AssertLatest(h, 5, 50_000, 1_000);
            Update(h, 6, 51_000, 1_000); // equal timestamp is allowed (>=)
            AssertLatest(h, 6, 51_000, 1_000);
            Assert.Equal(BigInteger.One, h.Contract.PairCount); // updates do not re-index
        }

        [Fact]
        public void FeedKeys_RespectStorageMapKeyLimit()
        {
            Harness h = Deploy();
            string maximumPair = new('a', 63);
            string oversizedPair = new('a', 64);

            IList<object> maximumRecord = h.Contract.GetLatest(maximumPair)!;
            Assert.Equal(BigInteger.Zero, (BigInteger)maximumRecord[RoundIdIndex]);

            IList<object> oversizedRecord = h.Contract.GetLatest(oversizedPair)!;
            Assert.Equal(BigInteger.Zero, (BigInteger)oversizedRecord[RoundIdIndex]);
            Assert.Equal(BigInteger.Zero, (BigInteger)oversizedRecord[PriceIndex]);
            Assert.Equal(BigInteger.Zero, (BigInteger)oversizedRecord[TimestampIndex]);

            h.Engine.SetTransactionSigners(h.Updater);
            AssertReverts(
                () => h.Contract.UpdateFeed(oversizedPair, 1, 50_000, 1_000, Array.Empty<byte>(), 1),
                "pair too long");
        }

        [Fact]
        public void AdminResetFeed_IsAdminGated_AndUnstallsAPoisonedFeed()
        {
            Harness h = Deploy();
            h.Engine.SetTransactionSigners(h.Updater);

            // A bad publish poisons the feed with a far-future round/timestamp:
            // every legitimate successor is now rejected as stale.
            BigInteger poisonedRound = 1_000_000;
            BigInteger poisonedTimestamp = 9_999_999_999;
            Update(h, poisonedRound, 50_000, poisonedTimestamp);
            AssertReverts(() => Update(h, 6, 51_000, 1_001), "stale round");

            // The updater cannot use the escape hatch (producers must not be able
            // to rewind/replay prices).
            AssertReverts(
                () => h.Contract.AdminResetFeed(Pair, 5, 50_500, 1_000, Array.Empty<byte>(), 1),
                "unauthorized");

            // The admin can: the reset bypasses monotonicity and rewinds the feed.
            h.Engine.SetTransactionSigners(h.Admin);
            h.Contract.AdminResetFeed(Pair, 5, 50_500, 1_000, Array.Empty<byte>(), 1);
            AssertLatest(h, 5, 50_500, 1_000);
            Assert.Equal(BigInteger.One, h.Contract.PairCount); // reset does not re-index

            // Normal monotonic publishing resumes from the reset point.
            h.Engine.SetTransactionSigners(h.Updater);
            Update(h, 6, 51_000, 1_001);
            AssertLatest(h, 6, 51_000, 1_001);
            AssertReverts(() => Update(h, 6, 52_000, 1_002), "stale round");
        }
    }
}
