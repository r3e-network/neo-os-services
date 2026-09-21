using System;
using System.Collections.Generic;
using System.Numerics;
using System.Reflection;
using Neo;
using Neo.Network.P2P.Payloads;
using Neo.SmartContract.Testing;
using Neo.Wallets;
using Xunit;
using Kernel = Neo.SmartContract.Testing.MorpheusOracle;

namespace MorpheusOracle.Contracts.Tests
{
    /// <summary>
    /// VM-level coverage for SVC-E-8: MiniApp fee sponsorship used to be default-open.
    ///
    /// IsRequesterSponsorable opened with "no gate flag configured => sponsor anyone",
    /// and the only caller-side gate was a witness from Runtime.Transaction.Sender. So
    /// until an app admin configured an allowlist entry or a spend cap, any account on
    /// the network could spam SubmitMiniAppRequest against a funded app and move its
    /// whole GAS fee credit into the reserved pool, one DEFAULT_REQUEST_FEE at a time,
    /// with no per-requester, per-block or per-app limit anywhere in the contract.
    ///
    /// The fix keeps the app sponsoring real users — deployed apps' users hold no credit
    /// of their own, so flipping the default to "sponsor nobody" would fail every one of
    /// them with "request fee not paid" — but bounds what a single requester can take
    /// out of an unconfigured app to DefaultSponsoredRequesterCap(). The bound is
    /// platform-admin tunable, and 0 IS the inverted, fully-closed default.
    ///
    /// These tests also pin the properties the sponsorship design already had, so the
    /// new default path cannot quietly erode them: an explicitly gated app still refuses
    /// requesters with no entry, the allowlist still bypasses caps, and the expiry-side
    /// ReleaseSponsoredSpend reversal still frees budget.
    ///
    /// Same harness pattern as <see cref="MorpheusOracleSponsorshipTests"/>. The deployed
    /// contract is the generated artifact under Generated/ (produced by
    /// `nccs MorpheusOracle.csproj --generate-artifacts Source`); regenerate it when the
    /// contract changes.
    /// </summary>
    public class MorpheusOracleSponsorshipDefaultCapTests
    {
        private const string AppId = "sponsor.app";
        private const string ModuleId = "oracle.fetch"; // seeded as an active built-in module at deploy
        private const long DefaultFee = 1_000_000;      // DEFAULT_REQUEST_FEE
        private const long ShippedDefaultCap = 100_000_000; // DEFAULT_SPONSORED_REQUESTER_CAP

        private const int SponsorIndex = 6; // UInt160 Sponsor (the account actually charged)

        private sealed record Harness(
            TestEngine Engine, Kernel Contract, UInt160 Owner, UInt160 Attacker, UInt160 Other);

        private static Harness Deploy()
        {
            byte[] priv = new byte[32];
            priv[31] = 1;
            ProtocolSettings settings = ProtocolSettings.Default with
            {
                StandbyCommittee = new[] { new KeyPair(priv).PublicKey },
                ValidatorsCount = 1,
            };

            TestEngine engine = new(settings, true);
            engine.Fee = 10_000 * 100_000_000L; // 10,000 GAS
            UInt160 owner = engine.Sender;       // genesis GAS holder
            engine.SetTransactionSigners(owner); // deployer => admin (set in _deploy)

            Kernel contract = engine.Deploy<Kernel>(Kernel.Nef, Kernel.Manifest, null);
            Assert.Equal(owner, contract.Admin);

            return new Harness(
                engine, contract, owner,
                TestEngine.GetNewSigner().Account,
                TestEngine.GetNewSigner().Account);
        }

        // Registers an app whose fee payer (sponsor) is the owner, prepaid with real GAS.
        // The app admin configures NO sponsorship control, which is the vulnerable posture.
        private static void Bootstrap(Harness h, BigInteger deposit)
        {
            h.Engine.SetTransactionSigners(h.Owner);
            bool? funded = h.Engine.Native.GAS.Transfer(h.Owner, h.Contract.Hash, deposit, null);
            Assert.True(funded == true);
            h.Contract.RegisterMiniApp(AppId, h.Owner, h.Owner, null, "ipfs://meta", "deadbeef");
            h.Contract.GrantModuleToMiniApp(AppId, ModuleId);
            Assert.False(h.Contract.IsSponsorshipGated(AppId)!.Value);
            Assert.False(h.Contract.IsSponsorshipOpen(AppId)!.Value);
        }

        private static BigInteger SubmitAs(Harness h, UInt160 requester)
        {
            h.Engine.SetTransactionSigners(requester);
            return h.Contract.SubmitMiniAppRequest(AppId, ModuleId, "fetch", new byte[] { 1, 2, 3 })!.Value;
        }

        private static UInt160 AsUInt160(object value) => value switch
        {
            UInt160 u => u,
            byte[] b => new UInt160(b),
            Neo.VM.Types.ByteString bs => new UInt160(bs.GetSpan().ToArray()),
            Neo.VM.Types.Buffer buf => new UInt160(buf.GetSpan().ToArray()),
            _ => throw new InvalidCastException($"cannot convert {value?.GetType()} to UInt160"),
        };

        private static UInt160 SponsorOf(Harness h, BigInteger requestId)
        {
            IList<object> req = h.Contract.GetRequest(requestId)!;
            return AsUInt160(req[SponsorIndex]);
        }

        private static void AssertReverts(Action action, string messageFragment)
        {
            Exception ex = Assert.ThrowsAny<Exception>(action);
            Assert.Contains(messageFragment, ex.ToString());
        }

        private static void SetBlockTimeMs(TestEngine engine, ulong ms)
        {
            object persistingBlock = engine.PersistingBlock;
            Block block = (Block)persistingBlock.GetType()
                .GetField("UnderlyingBlock", BindingFlags.NonPublic | BindingFlags.Instance)!
                .GetValue(persistingBlock)!;
            block.Header.Timestamp = ms;
        }

        private static void AdvancePastTtl(Harness h)
        {
            ulong ttl = (ulong)h.Contract.RequestTTL!.Value;
            SetBlockTimeMs(
                h.Engine, (ulong)h.Engine.PersistingBlock.Timestamp.TotalMilliseconds + ttl + 1_000);
        }

        [Fact]
        public void UnconfiguredApp_BoundsASingleRequestersDrain_AtTheShippedDefault()
        {
            // The shipped default must be a real, finite bound — not effectively unlimited.
            Harness h = Deploy();
            Assert.Equal(new BigInteger(ShippedDefaultCap), h.Contract.DefaultSponsoredRequesterCap!.Value);

            // Fund the app with far more than one requester is allowed to take, so a failure
            // here means the attacker walked past the bound rather than merely emptying a
            // thinly-funded app.
            BigInteger deposit = 3 * ShippedDefaultCap;
            Bootstrap(h, deposit);

            int sponsoredRequests = (int)(ShippedDefaultCap / DefaultFee);
            for (int i = 0; i < sponsoredRequests; i++)
            {
                BigInteger id = SubmitAs(h, h.Attacker);
                Assert.Equal(h.Owner, SponsorOf(h, id));
            }

            // Exactly the cap was moved, and the next request is refused: the attacker holds
            // no credit, so ResolveFeePayer falls back to it and ConsumeRequestFeeFromPayer
            // reverts. The rest of the app's credit is out of reach of this account.
            Assert.Equal(
                new BigInteger(ShippedDefaultCap),
                h.Contract.GetSponsoredRequesterSpent(AppId, h.Attacker)!.Value);
            AssertReverts(() => SubmitAs(h, h.Attacker), "request fee not paid");
            Assert.Equal(deposit - ShippedDefaultCap, h.Contract.FeeCreditOf(h.Owner)!.Value);

            // The bound is per requester, not per app: an unrelated user of the same app is
            // unaffected, which is the property that lets the default stay open at all.
            BigInteger otherId = SubmitAs(h, h.Other);
            Assert.Equal(h.Owner, SponsorOf(h, otherId));
        }

        [Fact]
        public void UnconfiguredApp_DefaultCapIsPlatformAdminTunable()
        {
            Harness h = Deploy();
            Bootstrap(h, 100 * DefaultFee);

            // Only the platform admin may retune the bound.
            h.Engine.SetTransactionSigners(h.Attacker);
            AssertReverts(() => h.Contract.SetDefaultSponsoredRequesterCap(2 * DefaultFee), "unauthorized");

            h.Engine.SetTransactionSigners(h.Owner);
            h.Contract.SetDefaultSponsoredRequesterCap(2 * DefaultFee);
            Assert.Equal(new BigInteger(2 * DefaultFee), h.Contract.DefaultSponsoredRequesterCap!.Value);

            Assert.Equal(h.Owner, SponsorOf(h, SubmitAs(h, h.Attacker)));
            Assert.Equal(h.Owner, SponsorOf(h, SubmitAs(h, h.Attacker)));
            AssertReverts(() => SubmitAs(h, h.Attacker), "request fee not paid");
        }

        [Fact]
        public void DefaultCapOfZero_ClosesSponsorshipForUnconfiguredApps()
        {
            // The fully-inverted posture ("an unconfigured app sponsors nobody") is reachable
            // by configuration, with no contract upgrade.
            Harness h = Deploy();
            BigInteger deposit = 100 * DefaultFee;
            Bootstrap(h, deposit);

            h.Engine.SetTransactionSigners(h.Owner);
            h.Contract.SetDefaultSponsoredRequesterCap(0);

            AssertReverts(() => SubmitAs(h, h.Attacker), "request fee not paid");
            Assert.Equal(deposit, h.Contract.FeeCreditOf(h.Owner)!.Value);
        }

        [Fact]
        public void ExplicitlyOpenApp_RestoresUnboundedSponsorEveryone()
        {
            // An app that genuinely wants the legacy posture can still have it — but now as a
            // recorded, separately auditable decision rather than the silent default.
            Harness h = Deploy();
            BigInteger deposit = 3 * ShippedDefaultCap;
            Bootstrap(h, deposit);

            h.Engine.SetTransactionSigners(h.Owner);
            h.Contract.SetDefaultSponsoredRequesterCap(DefaultFee); // one request's worth
            h.Contract.SetSponsorshipOpen(AppId, true);
            Assert.True(h.Contract.IsSponsorshipOpen(AppId)!.Value);
            Assert.False(h.Contract.IsSponsorshipGated(AppId)!.Value);

            // Past the (deliberately tiny) default bound, because the app opted out of it.
            for (int i = 0; i < 5; i++)
            {
                Assert.Equal(h.Owner, SponsorOf(h, SubmitAs(h, h.Attacker)));
            }
            Assert.Equal(deposit - 5 * DefaultFee, h.Contract.FeeCreditOf(h.Owner)!.Value);
        }

        [Fact]
        public void SetSponsorshipOpen_IsAppAdminGated_AndCanGateTheAppDirectly()
        {
            Harness h = Deploy();
            BigInteger deposit = 100 * DefaultFee;
            Bootstrap(h, deposit);

            h.Engine.SetTransactionSigners(h.Attacker);
            AssertReverts(() => h.Contract.SetSponsorshipOpen(AppId, true), "unauthorized");
            Assert.False(h.Contract.IsSponsorshipOpen(AppId)!.Value);

            // Gating no longer requires inventing an allowlist entry or a cap just to turn the
            // sponsorship off.
            h.Engine.SetTransactionSigners(h.Owner);
            h.Contract.SetSponsorshipOpen(AppId, false);
            Assert.True(h.Contract.IsSponsorshipGated(AppId)!.Value);
            AssertReverts(() => SubmitAs(h, h.Attacker), "request fee not paid");
            Assert.Equal(deposit, h.Contract.FeeCreditOf(h.Owner)!.Value);
        }

        [Fact]
        public void GatedApp_IgnoresTheDefaultCap_ForRequestersWithNoEntry()
        {
            // Pre-existing property that must not erode: once an app is gated, a requester with
            // neither an allowlist entry nor an explicit cap is NOT sponsored — the bounded
            // default must not leak in as a back door.
            Harness h = Deploy();
            BigInteger deposit = 100 * DefaultFee;
            Bootstrap(h, deposit);

            h.Engine.SetTransactionSigners(h.Owner);
            h.Contract.SetSponsoredRequesterAllowed(AppId, h.Other, true);
            Assert.True(h.Contract.IsSponsorshipGated(AppId)!.Value);

            AssertReverts(() => SubmitAs(h, h.Attacker), "request fee not paid");
            Assert.Equal(deposit, h.Contract.FeeCreditOf(h.Owner)!.Value);

            // The allowlisted requester is still sponsored without any cap bookkeeping.
            Assert.Equal(h.Owner, SponsorOf(h, SubmitAs(h, h.Other)));
        }

        [Fact]
        public void ExpiredSponsoredRequest_ReleasesDefaultCapBudget()
        {
            // The expiry-side ReleaseSponsoredSpend reversal is what keeps a cap a budget
            // rather than a one-way ratchet. It has to apply to the default cap too, or an
            // unconfigured app's user is permanently locked out by requests that never got
            // served.
            Harness h = Deploy();
            BigInteger deposit = 100 * DefaultFee;
            Bootstrap(h, deposit);

            h.Engine.SetTransactionSigners(h.Owner);
            h.Contract.SetDefaultSponsoredRequesterCap(DefaultFee); // exactly one request

            BigInteger id = SubmitAs(h, h.Other);
            Assert.Equal(h.Owner, SponsorOf(h, id));
            Assert.Equal(
                new BigInteger(DefaultFee), h.Contract.GetSponsoredRequesterSpent(AppId, h.Other)!.Value);
            AssertReverts(() => SubmitAs(h, h.Other), "request fee not paid");

            AdvancePastTtl(h);
            h.Engine.SetTransactionSigners(h.Owner);
            h.Contract.ExpireStaleRequest(id);
            Assert.Equal(BigInteger.Zero, h.Contract.GetSponsoredRequesterSpent(AppId, h.Other)!.Value);

            // Budget freed: the requester is sponsored again.
            Assert.Equal(h.Owner, SponsorOf(h, SubmitAs(h, h.Other)));
        }
    }
}
