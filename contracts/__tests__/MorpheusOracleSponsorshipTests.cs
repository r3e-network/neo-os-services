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
    /// VM-level coverage for the optional per-app sponsorship controls (C3) and the expiry
    /// inbox item (L1).
    ///
    /// C3 (sponsored fee drain): ResolveFeePayer used to charge the app fee payer for EVERY
    /// requester, so anyone could spam a sponsored app to drain the sponsor's prepaid credit.
    /// The app admin can now opt into gating via an allowlist
    /// (<see cref="Kernel.SetSponsoredRequesterAllowed"/>) and/or a per-requester spend cap
    /// (<see cref="Kernel.SetSponsoredRequesterCap"/>). Once any control is configured the fee
    /// payer covers only allowlisted or under-cap requesters; everyone else pays their own fee.
    /// Apps that configure nothing keep the legacy sponsor-everyone behavior (backward
    /// compatible), which is also pinned here.
    ///
    /// L1 (expiry leaves no inbox item): ExpireStaleRequest now stores a canonical InboxItem
    /// (Success=false, the documented expiry error) exactly like FulfillRequest, so inbox-only
    /// consumers observe the terminal state instead of waiting forever.
    ///
    /// Like <see cref="MorpheusOracleFeeAccountingTests"/> these deploy the compiled NEF into an
    /// emulated Neo VM and exercise real storage, GAS transfers, witness checks and Runtime.Time.
    /// The deployed contract is the generated artifact under Generated/ (produced by
    /// `nccs MorpheusOracle.csproj --generate-artifacts Source`); regenerate it when the contract
    /// changes.
    /// </summary>
    public class MorpheusOracleSponsorshipTests
    {
        private const string AppId = "sponsor.app";
        private const string ModuleId = "oracle.fetch"; // seeded as an active built-in module at deploy
        private const long DefaultFee = 1_000_000;       // DEFAULT_REQUEST_FEE

        // KernelRequest field indices in the serialized struct returned by GetRequest.
        private const int SponsorIndex = 6;  // UInt160 Sponsor (the account actually charged)
        private const int StatusIndex = 8;   // KernelRequestStatus { Pending=0, Succeeded=1, Failed=2 }
        private const int FeePaidIndex = 14; // BigInteger FeePaid (recorded at submission)

        // InboxItem field indices in the serialized struct returned by GetInboxItem.
        private const int InboxRequestIdIndex = 1;
        private const int InboxRequesterIndex = 4;
        private const int InboxSuccessIndex = 5;
        private const int InboxErrorIndex = 7;
        private const int InboxDeliveredAtIndex = 8;

        // Must match the contract's expiry error string verbatim.
        private const string ExpiryError = "request expired: TTL exceeded";

        private sealed record Harness(
            TestEngine Engine, Kernel Contract, UInt160 Owner, UInt160 Requester, UInt160 OtherRequester);

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
            UInt160 owner = engine.Sender;          // genesis GAS holder
            engine.SetTransactionSigners(owner);    // deployer => admin (set in _deploy)

            Kernel contract = engine.Deploy<Kernel>(Kernel.Nef, Kernel.Manifest, null);
            Assert.Equal(owner, contract.Admin);

            return new Harness(
                engine, contract, owner,
                TestEngine.GetNewSigner().Account,
                TestEngine.GetNewSigner().Account);
        }

        private static ulong BlockTimeMs(TestEngine engine) =>
            (ulong)engine.PersistingBlock.Timestamp.TotalMilliseconds;

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
            SetBlockTimeMs(h.Engine, BlockTimeMs(h.Engine) + ttl + 1_000);
        }

        // Registers an app whose fee payer (sponsor) is the owner and grants the seeded module,
        // after prepaying the owner's fee credit with real GAS.
        private static void Bootstrap(Harness h, BigInteger deposit)
        {
            h.Engine.SetTransactionSigners(h.Owner);

            bool? funded = h.Engine.Native.GAS.Transfer(h.Owner, h.Contract.Hash, deposit, null);
            Assert.True(funded == true);
            Assert.Equal(deposit, h.Contract.FeeCreditOf(h.Owner)!.Value);

            h.Contract.RegisterMiniApp(AppId, h.Owner, h.Owner, null, "ipfs://meta", "deadbeef");
            h.Contract.GrantModuleToMiniApp(AppId, ModuleId);
        }

        // Submits as the given requester so the fee is drawn from whichever account
        // ResolveFeePayer selects (the sponsor when sponsorable, else the requester itself).
        private static BigInteger SubmitAs(Harness h, UInt160 requester)
        {
            h.Engine.SetTransactionSigners(requester);
            return h.Contract.SubmitMiniAppRequest(AppId, ModuleId, "fetch", new byte[] { 1, 2, 3 })!.Value;
        }

        private static void Expire(Harness h, BigInteger requestId)
        {
            h.Engine.SetTransactionSigners(h.Owner);
            h.Contract.ExpireStaleRequest(requestId);
        }

        private static object RequestField(Harness h, BigInteger requestId, int index)
        {
            IList<object> req = h.Contract.GetRequest(requestId)!;
            return req[index];
        }

        private static object InboxField(Harness h, BigInteger requestId, int index)
        {
            IList<object> inbox = h.Contract.GetInboxItem(AppId, requestId)!;
            return inbox[index];
        }

        // Struct members come back from the typed Array binding without per-field type info, so a
        // Hash160 surfaces as the raw 20-byte value (or, depending on framework version, as a
        // UInt160). Normalize both to UInt160 for comparison.
        private static UInt160 AsUInt160(object value) => value switch
        {
            UInt160 u => u,
            byte[] b => new UInt160(b),
            Neo.VM.Types.ByteString bs => new UInt160(bs.GetSpan().ToArray()),
            Neo.VM.Types.Buffer buf => new UInt160(buf.GetSpan().ToArray()),
            _ => throw new InvalidCastException($"cannot convert {value?.GetType()} to UInt160"),
        };

        // Likewise a struct bool may surface as bool or as an integer 0/1.
        private static bool AsBool(object value) => value switch
        {
            bool b => b,
            BigInteger i => i != 0,
            Neo.VM.Types.Integer i => i.GetInteger() != 0,
            Neo.VM.Types.Boolean b => b.GetBoolean(),
            _ => throw new InvalidCastException($"cannot convert {value?.GetType()} to bool"),
        };

        // And a struct string may surface as string or as a UTF-8 byte string.
        private static string AsString(object value) => value switch
        {
            string s => s,
            byte[] b => System.Text.Encoding.UTF8.GetString(b),
            Neo.VM.Types.ByteString bs => System.Text.Encoding.UTF8.GetString(bs.GetSpan().ToArray()),
            Neo.VM.Types.Buffer buf => System.Text.Encoding.UTF8.GetString(buf.GetSpan().ToArray()),
            _ => throw new InvalidCastException($"cannot convert {value?.GetType()} to string"),
        };

        // The testing engine surfaces a VM FAULT as a thrown exception whose text includes the
        // contract's assert message.
        private static void AssertReverts(Action action, string messageFragment)
        {
            Exception ex = Assert.ThrowsAny<Exception>(action);
            Assert.Contains(messageFragment, ex.ToString());
        }

        // --- C3: backward-compatible default (no controls configured) -------------------------

        [Fact]
        public void NoControlsConfigured_SponsorsEveryRequester_UnchangedBehavior()
        {
            Harness h = Deploy();
            BigInteger deposit = 10 * DefaultFee;
            Bootstrap(h, deposit);

            // The app has configured no sponsorship controls, so the fee payer (owner) covers any
            // requester exactly as before. Two different requesters both draw on the sponsor.
            Assert.False(h.Contract.IsSponsorshipGated(AppId)!.Value);

            BigInteger id1 = SubmitAs(h, h.Requester);
            BigInteger id2 = SubmitAs(h, h.OtherRequester);

            // Both fees came out of the sponsor's credit; neither requester paid.
            Assert.Equal(deposit - 2 * DefaultFee, h.Contract.FeeCreditOf(h.Owner)!.Value);
            Assert.Equal(BigInteger.Zero, h.Contract.FeeCreditOf(h.Requester)!.Value);
            Assert.Equal(BigInteger.Zero, h.Contract.FeeCreditOf(h.OtherRequester)!.Value);
            Assert.Equal(h.Owner, AsUInt160(RequestField(h, id1, SponsorIndex)));
            Assert.Equal(h.Owner, AsUInt160(RequestField(h, id2, SponsorIndex)));
        }

        // --- C3: gating blocks the drain -------------------------------------------------------

        [Fact]
        public void Gated_NonAllowlistedRequester_CannotDrainSponsor_AndPaysItself()
        {
            Harness h = Deploy();
            BigInteger deposit = 10 * DefaultFee;
            Bootstrap(h, deposit);

            // Owner allowlists ONLY the trusted requester; this flips the app into gated mode.
            h.Engine.SetTransactionSigners(h.Owner);
            h.Contract.SetSponsoredRequesterAllowed(AppId, h.Requester, true);
            Assert.True(h.Contract.IsSponsorshipGated(AppId)!.Value);
            Assert.True(h.Contract.IsSponsoredRequesterAllowed(AppId, h.Requester)!.Value);
            Assert.False(h.Contract.IsSponsoredRequesterAllowed(AppId, h.OtherRequester)!.Value);

            // A non-allowlisted requester with NO credit of its own can no longer spend the
            // sponsor's credit: ResolveFeePayer falls back to the requester, which has not paid,
            // so the request reverts. The sponsor's credit is untouched.
            AssertReverts(() => SubmitAs(h, h.OtherRequester), "request fee not paid");
            Assert.Equal(deposit, h.Contract.FeeCreditOf(h.Owner)!.Value);

            // The allowlisted requester is still sponsored: its request succeeds, charged to the
            // fee payer (owner), and the requester pays nothing.
            BigInteger allowedId = SubmitAs(h, h.Requester);
            Assert.Equal(h.Owner, AsUInt160(RequestField(h, allowedId, SponsorIndex)));
            Assert.Equal(deposit - DefaultFee, h.Contract.FeeCreditOf(h.Owner)!.Value);
            Assert.Equal(BigInteger.Zero, h.Contract.FeeCreditOf(h.Requester)!.Value);
        }

        [Fact]
        public void Gated_NonAllowlistedRequester_WithOwnCredit_PaysItself_NotSponsor()
        {
            Harness h = Deploy();
            BigInteger deposit = 10 * DefaultFee;
            Bootstrap(h, deposit);

            // Gate the app by allowlisting the trusted requester only.
            h.Engine.SetTransactionSigners(h.Owner);
            h.Contract.SetSponsoredRequesterAllowed(AppId, h.Requester, true);

            // Fund the other requester (a fresh signer holds no GAS) so it can deposit its own credit.
            h.Engine.SetTransactionSigners(h.Owner);
            Assert.True(h.Engine.Native.GAS.Transfer(h.Owner, h.OtherRequester, 5 * DefaultFee, null) == true);

            // Give the other requester its own prepaid credit.
            h.Engine.SetTransactionSigners(h.OtherRequester);
            Assert.True(h.Engine.Native.GAS.Transfer(h.OtherRequester, h.Contract.Hash, DefaultFee, null) == true);
            Assert.Equal(new BigInteger(DefaultFee), h.Contract.FeeCreditOf(h.OtherRequester)!.Value);

            // It submits and is charged FROM ITS OWN credit, never the sponsor's.
            BigInteger id = SubmitAs(h, h.OtherRequester);
            Assert.Equal(h.OtherRequester, AsUInt160(RequestField(h, id, SponsorIndex)));
            Assert.Equal(BigInteger.Zero, h.Contract.FeeCreditOf(h.OtherRequester)!.Value);
            Assert.Equal(deposit, h.Contract.FeeCreditOf(h.Owner)!.Value); // sponsor untouched
        }

        // --- C3: spend cap path ----------------------------------------------------------------

        [Fact]
        public void Gated_PerRequesterCap_SponsorsUpToCap_ThenRequesterPays()
        {
            Harness h = Deploy();
            BigInteger deposit = 10 * DefaultFee;
            Bootstrap(h, deposit);

            // Owner caps the other requester at a single fee's worth of sponsorship (no
            // allowlisting). Setting a non-zero cap enables gating.
            h.Engine.SetTransactionSigners(h.Owner);
            h.Contract.SetSponsoredRequesterCap(AppId, h.OtherRequester, DefaultFee);
            Assert.True(h.Contract.IsSponsorshipGated(AppId)!.Value);
            Assert.Equal(new BigInteger(DefaultFee), h.Contract.GetSponsoredRequesterCap(AppId, h.OtherRequester)!.Value);

            // First request is within budget => sponsored by the fee payer.
            BigInteger id1 = SubmitAs(h, h.OtherRequester);
            Assert.Equal(h.Owner, AsUInt160(RequestField(h, id1, SponsorIndex)));
            Assert.Equal(deposit - DefaultFee, h.Contract.FeeCreditOf(h.Owner)!.Value);
            Assert.Equal(new BigInteger(DefaultFee), h.Contract.GetSponsoredRequesterSpent(AppId, h.OtherRequester)!.Value);

            // Cap now exhausted: a second sponsored request would exceed it, so the fee payer is
            // no longer charged. With no credit of its own the requester's request reverts and
            // the sponsor's credit holds steady (it cannot be drained past the cap).
            AssertReverts(() => SubmitAs(h, h.OtherRequester), "request fee not paid");
            Assert.Equal(deposit - DefaultFee, h.Contract.FeeCreditOf(h.Owner)!.Value);
            Assert.Equal(new BigInteger(DefaultFee), h.Contract.GetSponsoredRequesterSpent(AppId, h.OtherRequester)!.Value);
        }

        [Fact]
        public void ExpireStaleRequest_ReleasesSponsoredSpend_RequesterSponsorableAgain()
        {
            Harness h = Deploy();
            BigInteger deposit = 10 * DefaultFee;
            Bootstrap(h, deposit);

            // Cap the requester at exactly one fee's worth of sponsorship (enables gating).
            h.Engine.SetTransactionSigners(h.Owner);
            h.Contract.SetSponsoredRequesterCap(AppId, h.OtherRequester, DefaultFee);

            // A sponsored request consumes the full cap.
            BigInteger id = SubmitAs(h, h.OtherRequester);
            Assert.Equal(h.Owner, AsUInt160(RequestField(h, id, SponsorIndex)));
            Assert.Equal(new BigInteger(DefaultFee), h.Contract.GetSponsoredRequesterSpent(AppId, h.OtherRequester)!.Value);

            // It expires unfulfilled. The recorded spend is reversed so the requester's
            // per-app sponsorship budget is freed — previously it stayed exhausted forever
            // despite the fee refund, silently denying configured sponsorship.
            AdvancePastTtl(h);
            Expire(h, id);
            Assert.Equal(BigInteger.Zero, h.Contract.GetSponsoredRequesterSpent(AppId, h.OtherRequester)!.Value);

            // A fresh request is sponsored again (charged to the fee payer, not the
            // requester), proving the cap is genuinely available — not merely the counter
            // reset. Pre-fix this reverted with "request fee not paid".
            BigInteger id2 = SubmitAs(h, h.OtherRequester);
            Assert.Equal(h.Owner, AsUInt160(RequestField(h, id2, SponsorIndex)));
            Assert.Equal(new BigInteger(DefaultFee), h.Contract.GetSponsoredRequesterSpent(AppId, h.OtherRequester)!.Value);
        }

        [Fact]
        public void SponsorshipControls_AreAdminGated()
        {
            Harness h = Deploy();
            Bootstrap(h, 10 * DefaultFee);

            // A non-admin (the requester) cannot configure sponsorship controls.
            h.Engine.SetTransactionSigners(h.Requester);
            AssertReverts(
                () => h.Contract.SetSponsoredRequesterAllowed(AppId, h.Requester, true),
                "unauthorized");
            AssertReverts(
                () => h.Contract.SetSponsoredRequesterCap(AppId, h.Requester, DefaultFee),
                "unauthorized");

            // The app stays ungated after the failed attempts.
            Assert.False(h.Contract.IsSponsorshipGated(AppId)!.Value);
        }

        // --- L1: expiry stores a readable inbox item -------------------------------------------

        [Fact]
        public void ExpireStaleRequest_StoresCanonicalInboxItem()
        {
            Harness h = Deploy();
            Bootstrap(h, 10 * DefaultFee);

            BigInteger id = SubmitAs(h, h.Requester);

            // Before expiry the inbox slot is empty (GetInboxItem returns the zero-valued
            // placeholder: DeliveredAt == 0).
            Assert.Equal(BigInteger.Zero, (BigInteger)InboxField(h, id, InboxDeliveredAtIndex));

            AdvancePastTtl(h);
            Expire(h, id);

            // The request itself is Failed with the expiry error.
            Assert.Equal(new BigInteger(2), (BigInteger)RequestField(h, id, StatusIndex)); // Failed

            // And an inbox item is now persisted exactly like a failed fulfillment: terminal,
            // Success=false, carrying the documented expiry error and the original requester, so
            // an inbox-only poller observes the terminal state instead of waiting forever.
            Assert.Equal(id, (BigInteger)InboxField(h, id, InboxRequestIdIndex));
            Assert.Equal(h.Requester, AsUInt160(InboxField(h, id, InboxRequesterIndex)));
            Assert.False(AsBool(InboxField(h, id, InboxSuccessIndex)));
            Assert.Equal(ExpiryError, AsString(InboxField(h, id, InboxErrorIndex)));
            Assert.True((BigInteger)InboxField(h, id, InboxDeliveredAtIndex) > 0);
        }
    }
}
