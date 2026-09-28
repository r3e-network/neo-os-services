using System.Numerics;
using Neo;
using Neo.Network.P2P.Payloads;
using Xunit;
using static MorpheusOracle.Contracts.Tests.KernelFeeHarness;

namespace MorpheusOracle.Contracts.Tests
{
    /// <summary>
    /// VM coverage for the integration-lane requester-consent hole (R-01 / business-rules F1),
    /// driven through a real deployed intermediate contract (<see cref="IntegrationHop"/>):
    /// entry script -> integration contract -> kernel.
    ///
    /// <c>SubmitMiniAppRequestFromIntegration</c> names an arbitrary <c>requester</c>. The kernel
    /// used to charge that account's prepaid credit whenever the app fee payer could not cover
    /// the request. <c>RegisterMiniApp</c> is permissionless and <c>GrantModuleToMiniApp</c>
    /// self-serviceable, so an attacker registers an app whose callback is a contract it
    /// controls and, signing only as itself, drains any prepaid account one fee at a time.
    ///
    /// The requester's own credit now pays only with its consent: its witness evaluated in
    /// the kernel (a signer scope that reaches the kernel — Global, or CustomContracts listing
    /// the kernel; CalledByEntry stops at the integration contract), or the requester being
    /// the app's own fee payer. Otherwise the app fee payer must sponsor it under the
    /// sponsorship cap, or the request reverts.
    ///
    /// The kernel is the generated artifact under Generated/ (nccs
    /// MorpheusOracle.csproj --generate-artifacts Source); regenerate it when the contract changes.
    /// </summary>
    public class MorpheusOracleIntegrationWitnessTests
    {
        private const string EvilApp = "evil.app";
        private static readonly byte[] Payload = { 1, 2, 3 };

        private sealed record Attack(KernelFeeHarness H, IntegrationHop Hop, UInt160 Victim, UInt160 Attacker);

        // The attacker registers an app it fully controls — admin and fee payer, holding no
        // credit — whose integration contract is the deployed hop. The victim holds credit.
        private static Attack SetUpAttack(BigInteger victimCredit)
        {
            KernelFeeHarness h = KernelFeeHarness.Deploy();
            IntegrationHop hop = h.DeployHop();
            UInt160 victim = NewAccount();
            UInt160 attacker = NewAccount();
            h.FundCredit(victim, victimCredit);
            h.RegisterApp(EvilApp, attacker, attacker, hop.Hash, OracleModule);
            Assert.Equal(BigInteger.Zero, h.CreditOf(attacker));
            return new Attack(h, hop, victim, attacker);
        }

        private static BigInteger SubmitViaHop(Attack a, UInt160 requester, string appId = EvilApp) =>
            a.Hop.Call(
                a.H.Kernel.Hash,
                "submitMiniAppRequestFromIntegration",
                new object[] { requester, appId, OracleModule, "fetch", Payload })!.Value;

        [Fact]
        public void ThroughARealHop_AnUnwitnessedVictimIsNotCharged()
        {
            // R-01 exploit: the attacker signs only as itself.
            Attack a = SetUpAttack(5 * Fee);
            a.H.Sign(Scoped(a.Attacker, WitnessScope.CalledByEntry));

            AssertReverts(() => SubmitViaHop(a, a.Victim), "requester witness required");

            Assert.Equal(5 * Fee, a.H.CreditOf(a.Victim));
            Assert.Equal(BigInteger.Zero, a.H.CreditOf(a.Attacker));
        }

        [Fact]
        public void ThroughARealHop_TheLegacyRequestFromCallbackAliasIsGuardedToo()
        {
            Attack a = SetUpAttack(5 * Fee);
            a.H.Sign(Scoped(a.Attacker, WitnessScope.CalledByEntry));

            AssertReverts(
                () => a.Hop.Call(
                    a.H.Kernel.Hash,
                    "requestFromCallback",
                    new object[] { a.Victim, "oracle", Payload, a.Hop.Hash, "onOracleResult" }),
                "requester witness required");

            Assert.Equal(5 * Fee, a.H.CreditOf(a.Victim));
        }

        [Fact]
        public void ACalledByEntrySignatureDoesNotReachTheKernel()
        {
            // The victim did sign this transaction — e.g. lured into calling the attacker's
            // contract — but with the default CalledByEntry scope. That witness is valid in
            // the hop (called by the entry script) and NOT in the kernel two frames down, so
            // it is not consent to spend the victim's kernel credit.
            Attack a = SetUpAttack(5 * Fee);
            a.H.Sign(
                Scoped(a.Attacker, WitnessScope.CalledByEntry),
                Scoped(a.Victim, WitnessScope.CalledByEntry));

            AssertReverts(() => SubmitViaHop(a, a.Victim), "requester witness required");

            Assert.Equal(5 * Fee, a.H.CreditOf(a.Victim));
        }

        [Fact]
        public void AWitnessScopedToTheIntegrationContractOnlyDoesNotReachTheKernel()
        {
            Attack a = SetUpAttack(5 * Fee);
            a.H.Sign(Scoped(a.Victim, WitnessScope.CustomContracts, a.Hop.Hash));

            AssertReverts(() => SubmitViaHop(a, a.Victim), "requester witness required");

            Assert.Equal(5 * Fee, a.H.CreditOf(a.Victim));
        }

        [Fact]
        public void AGlobalWitnessIsConsentToSelfPay()
        {
            Attack a = SetUpAttack(5 * Fee);
            a.H.Sign(Scoped(a.Victim, WitnessScope.Global));

            BigInteger id = SubmitViaHop(a, a.Victim);

            Assert.Equal(a.Victim, a.H.SponsorOf(id));
            Assert.Equal(a.Victim, a.H.RequesterOf(id));
            Assert.Equal(4 * Fee, a.H.CreditOf(a.Victim));
        }

        [Fact]
        public void ACustomContractsWitnessListingTheKernelIsConsentToSelfPay()
        {
            Attack a = SetUpAttack(5 * Fee);
            a.H.Sign(Scoped(a.Victim, WitnessScope.CustomContracts, a.H.Kernel.Hash));

            BigInteger id = SubmitViaHop(a, a.Victim);

            Assert.Equal(a.Victim, a.H.SponsorOf(id));
            Assert.Equal(4 * Fee, a.H.CreditOf(a.Victim));
        }

        [Fact]
        public void ACustomContractsWitnessListingTheHopAndTheKernelIsConsentToSelfPay()
        {
            Attack a = SetUpAttack(5 * Fee);
            a.H.Sign(Scoped(a.Victim, WitnessScope.CustomContracts, a.Hop.Hash, a.H.Kernel.Hash));

            BigInteger id = SubmitViaHop(a, a.Victim);

            Assert.Equal(a.Victim, a.H.SponsorOf(id));
            Assert.Equal(4 * Fee, a.H.CreditOf(a.Victim));
        }

        [Fact]
        public void TheAppFeePayerStillSponsorsAnUnwitnessedRequester()
        {
            // The legitimate model: the app's own fee payer covers its users. Only the fee
            // payer is charged, never the named requester.
            Attack a = SetUpAttack(5 * Fee);
            a.H.FundCredit(a.Attacker, 5 * Fee); // the operator funds its own app fee payer
            a.H.Sign(Scoped(a.Attacker, WitnessScope.CalledByEntry));

            BigInteger id = SubmitViaHop(a, a.Victim);

            Assert.Equal(a.Attacker, a.H.SponsorOf(id));
            Assert.Equal(a.Victim, a.H.RequesterOf(id));
            Assert.Equal(4 * Fee, a.H.CreditOf(a.Attacker));
            Assert.Equal(5 * Fee, a.H.CreditOf(a.Victim));
        }

        [Fact]
        public void AnExhaustedSponsorshipCapDoesNotFallBackToTheNamedRequester()
        {
            // Sponsorship is bounded per requester (SVC-E-8). Once the cap is spent, the next
            // unwitnessed request must revert rather than land on the requester's credit.
            Attack a = SetUpAttack(5 * Fee);
            a.H.Sign(Scoped(a.H.Owner, WitnessScope.CalledByEntry));
            a.H.Kernel.SetDefaultSponsoredRequesterCap(Fee);
            a.H.FundCredit(a.Attacker, 5 * Fee);
            a.H.Sign(Scoped(a.Attacker, WitnessScope.CalledByEntry));

            BigInteger first = SubmitViaHop(a, a.Victim);
            Assert.Equal(a.Attacker, a.H.SponsorOf(first));

            AssertReverts(() => SubmitViaHop(a, a.Victim), "requester witness required");

            Assert.Equal(5 * Fee, a.H.CreditOf(a.Victim));
            Assert.Equal(4 * Fee, a.H.CreditOf(a.Attacker));
        }

        [Fact]
        public void TheAppFeePayerNamedAsRequesterPaysWithoutAFreshWitness()
        {
            // The fee payer consented to fund this app when it was registered, so the app's
            // integration contract may name it as the requester. Refusing it (the first R-01
            // patch did) broke a consenting sponsor for no gain.
            KernelFeeHarness h = KernelFeeHarness.Deploy();
            IntegrationHop hop = h.DeployHop();
            UInt160 appAdmin = NewAccount();
            UInt160 feePayer = NewAccount();
            h.FundCredit(feePayer, 3 * Fee);
            h.RegisterApp("sponsored.app", appAdmin, feePayer, hop.Hash, OracleModule);
            h.Sign(Scoped(appAdmin, WitnessScope.CalledByEntry));

            BigInteger id = hop.Call(
                h.Kernel.Hash,
                "submitMiniAppRequestFromIntegration",
                new object[] { feePayer, "sponsored.app", OracleModule, "fetch", Payload })!.Value;

            Assert.Equal(feePayer, h.SponsorOf(id));
            Assert.Equal(feePayer, h.RequesterOf(id));
            Assert.Equal(2 * Fee, h.CreditOf(feePayer));
        }
    }
}
