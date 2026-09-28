using System.Numerics;
using Neo;
using Neo.Network.P2P.Payloads;
using Xunit;
using static MorpheusOracle.Contracts.Tests.KernelFeeHarness;

namespace MorpheusOracle.Contracts.Tests
{
    /// <summary>
    /// VM coverage for the updater (relayer) lanes under R-01 and the requester spend approval
    /// that replaces automation self-pay (MorpheusOracle.Automation.cs).
    ///
    /// The relayer queues every automation execution naming the job owner. Naming an account
    /// is not consent to spend its credit, and an attacker's integration contract can register
    /// a job naming anyone, so the updater lanes never charge an unwitnessed requester. A job
    /// owner opts into paying from its own credit by signing an approval for that one job —
    /// keyed by the kernel request id of its automation_register request — with a total cap
    /// and an expiry. QueueAutomationExecution draws on it; nothing else can.
    /// </summary>
    public class MorpheusOracleAutomationSpendTests
    {
        private const string App = "auto.app";
        private const string EvilApp = "evil.app";
        private static readonly byte[] Payload = { 1, 2, 3 };
        private static readonly byte[] JobPayload = System.Text.Encoding.UTF8.GetBytes(
            "{\"trigger\":{\"type\":\"interval\",\"interval_ms\":600000},\"execution\":{\"request_type\":\"oracle\",\"payload\":{}}}");

        private sealed record Job(KernelFeeHarness H, UInt160 Operator, UInt160 Requester, BigInteger RegistrationId);

        // An app whose fee payer (the operator) holds no credit, with the automation and oracle
        // modules granted; the owner holds the updater role. The requester funds its credit
        // and registers one job through the direct lane, paying the registration fee itself.
        private static Job RegisterJob(BigInteger requesterCredit, BigInteger operatorCredit = default)
        {
            KernelFeeHarness h = KernelFeeHarness.Deploy();
            UInt160 op = NewAccount();
            UInt160 requester = NewAccount();
            if (operatorCredit > 0) h.FundCredit(op, operatorCredit);
            h.RegisterApp(App, op, op, NewAccount(), AutomationModule, OracleModule);
            h.OwnerIsUpdater();
            h.FundCredit(requester, requesterCredit);

            h.Sign(Scoped(requester, WitnessScope.CalledByEntry));
            BigInteger registrationId = h.Kernel.SubmitMiniAppRequest(
                App, AutomationModule, "automation_register", JobPayload)!.Value;
            return new Job(h, op, requester, registrationId);
        }

        private static void Approve(Job j, BigInteger cap, BigInteger expiresAt)
        {
            j.H.Sign(Scoped(j.Requester, WitnessScope.CalledByEntry));
            j.H.Kernel.ApproveAutomationSpend(j.RegistrationId, cap, expiresAt);
        }

        private static BigInteger Execute(Job j, string requestType = "oracle")
        {
            j.H.Sign(Scoped(j.H.Owner, WitnessScope.CalledByEntry)); // the updater
            return j.H.Kernel.QueueAutomationExecution(j.RegistrationId, j.Requester, requestType, Payload)!.Value;
        }

        private BigInteger OneHourFromNow(KernelFeeHarness h) => h.NowMs + 3_600_000;

        // ── updater lanes without a registration: unchanged ABI, no third-party self-pay ──

        [Fact]
        public void QueueSystemRequest_DoesNotChargeAnUnwitnessedRequester()
        {
            Job j = RegisterJob(5 * Fee);
            UInt160 victim = NewAccount();
            j.H.FundCredit(victim, 5 * Fee);
            j.H.Sign(Scoped(j.H.Owner, WitnessScope.CalledByEntry));

            AssertReverts(
                () => j.H.Kernel.QueueSystemRequest(victim, App, OracleModule, "fetch", Payload),
                "requester witness required");

            Assert.Equal(5 * Fee, j.H.CreditOf(victim));
        }

        [Fact]
        public void LegacyQueueAutomationRequest_DoesNotChargeAnUnwitnessedRequester()
        {
            KernelFeeHarness h = KernelFeeHarness.Deploy();
            UInt160 op = NewAccount();
            UInt160 callback = NewAccount();
            UInt160 victim = NewAccount();
            h.RegisterApp(App, op, op, callback, OracleModule);
            h.OwnerIsUpdater();
            h.FundCredit(victim, 5 * Fee);
            h.Sign(Scoped(h.Owner, WitnessScope.CalledByEntry));

            AssertReverts(
                () => h.Kernel.QueueAutomationRequest(victim, "oracle", Payload, callback, "onOracleResult"),
                "requester witness required");

            Assert.Equal(5 * Fee, h.CreditOf(victim));
        }

        [Fact]
        public void QueueSystemRequest_ChargesARequesterThatSignedTheTransaction()
        {
            // The requester co-signs the updater's transaction, which calls the kernel directly,
            // so its witness holds in the kernel: consent to self-pay.
            KernelFeeHarness h = KernelFeeHarness.Deploy();
            UInt160 op = NewAccount();
            UInt160 requester = NewAccount();
            h.RegisterApp(App, op, op, null, OracleModule);
            h.OwnerIsUpdater();
            h.FundCredit(requester, 3 * Fee);
            h.Sign(Scoped(h.Owner, WitnessScope.CalledByEntry), Scoped(requester, WitnessScope.CalledByEntry));

            BigInteger id = h.Kernel.QueueSystemRequest(requester, App, OracleModule, "fetch", Payload)!.Value;

            Assert.Equal(requester, h.SponsorOf(id));
            Assert.Equal(2 * Fee, h.CreditOf(requester));
        }

        [Fact]
        public void QueueSystemRequest_ChargesTheAppFeePayerNamedAsRequester()
        {
            KernelFeeHarness h = KernelFeeHarness.Deploy();
            UInt160 op = NewAccount();
            UInt160 feePayer = NewAccount();
            h.FundCredit(feePayer, 3 * Fee);
            h.RegisterApp(App, op, feePayer, null, OracleModule);
            h.OwnerIsUpdater();

            BigInteger id = h.Kernel.QueueSystemRequest(feePayer, App, OracleModule, "fetch", Payload)!.Value;

            Assert.Equal(feePayer, h.SponsorOf(id));
            Assert.Equal(2 * Fee, h.CreditOf(feePayer));
        }

        // ── the approval lane ──────────────────────────────────────────────────────────

        [Fact]
        public void WithoutAnApproval_AnExecutionDoesNotChargeTheRequester()
        {
            Job j = RegisterJob(5 * Fee);
            Assert.Equal(4 * Fee, j.H.CreditOf(j.Requester)); // it paid its own registration

            AssertReverts(() => Execute(j), "automation spend not approved");

            Assert.Equal(4 * Fee, j.H.CreditOf(j.Requester));
            Assert.False(j.H.HasApproval(j.RegistrationId));
        }

        [Fact]
        public void AJobAnAttackerRegisteredForAVictimCannotDrainTheVictim()
        {
            // The attacker's integration contract registers a job naming the victim; its own
            // fee payer pays that one registration. Later executions would fall back to the
            // victim — and the victim never approved anything.
            KernelFeeHarness h = KernelFeeHarness.Deploy();
            IntegrationHop hop = h.DeployHop();
            UInt160 attacker = NewAccount();
            UInt160 victim = NewAccount();
            h.FundCredit(victim, 5 * Fee);
            h.FundCredit(attacker, Fee);
            h.RegisterApp(EvilApp, attacker, attacker, hop.Hash, AutomationModule, OracleModule);
            h.OwnerIsUpdater();

            h.Sign(Scoped(attacker, WitnessScope.CalledByEntry));
            BigInteger registrationId = hop.Call(
                h.Kernel.Hash,
                "submitMiniAppRequestFromIntegration",
                new object[] { victim, EvilApp, AutomationModule, "automation_register", JobPayload })!.Value;
            Assert.Equal(victim, h.RequesterOf(registrationId));
            Assert.Equal(attacker, h.SponsorOf(registrationId));

            // The attacker cannot approve on the victim's behalf.
            AssertReverts(
                () => h.Kernel.ApproveAutomationSpend(registrationId, 5 * Fee, h.NowMs + 3_600_000),
                "unauthorized");

            h.Sign(Scoped(h.Owner, WitnessScope.CalledByEntry));
            AssertReverts(
                () => h.Kernel.QueueAutomationExecution(registrationId, victim, "oracle", Payload),
                "automation spend not approved");

            Assert.Equal(5 * Fee, h.CreditOf(victim));
        }

        [Fact]
        public void OnlyTheRequesterCanApprove()
        {
            Job j = RegisterJob(5 * Fee);
            UInt160 stranger = NewAccount();
            j.H.Sign(Scoped(stranger, WitnessScope.Global));

            AssertReverts(
                () => j.H.Kernel.ApproveAutomationSpend(j.RegistrationId, 5 * Fee, OneHourFromNow(j.H)),
                "unauthorized");

            Assert.False(j.H.HasApproval(j.RegistrationId));
        }

        [Fact]
        public void OnlyAnAutomationRegistrationCanBeApproved()
        {
            Job j = RegisterJob(5 * Fee);
            j.H.Sign(Scoped(j.Requester, WitnessScope.CalledByEntry));
            BigInteger plainRequest = j.H.Kernel.SubmitMiniAppRequest(App, OracleModule, "fetch", Payload)!.Value;

            AssertReverts(
                () => j.H.Kernel.ApproveAutomationSpend(plainRequest, 5 * Fee, OneHourFromNow(j.H)),
                "not an automation registration");
            AssertReverts(
                () => j.H.Kernel.ApproveAutomationSpend(plainRequest + 1_000, 5 * Fee, OneHourFromNow(j.H)),
                "registration not found");

            Assert.False(j.H.HasApproval(plainRequest));
        }

        [Fact]
        public void AnApprovalThroughAnIntegrationContractNeedsAKernelScopedWitness()
        {
            Job j = RegisterJob(5 * Fee);
            IntegrationHop hop = j.H.DeployHop();
            object[] args = { j.RegistrationId, 5 * Fee, OneHourFromNow(j.H) };

            j.H.Sign(Scoped(j.Requester, WitnessScope.CalledByEntry));
            AssertReverts(() => hop.Call(j.H.Kernel.Hash, "approveAutomationSpend", args), "unauthorized");
            Assert.False(j.H.HasApproval(j.RegistrationId));

            j.H.Sign(Scoped(j.Requester, WitnessScope.CustomContracts, j.H.Kernel.Hash));
            hop.Call(j.H.Kernel.Hash, "approveAutomationSpend", args);
            Assert.Equal(5 * Fee, j.H.ApprovalCap(j.RegistrationId));
        }

        [Fact]
        public void AnApprovedJobChargesTheRequesterUpToTheCapAndNoFurther()
        {
            Job j = RegisterJob(5 * Fee);
            Approve(j, 2 * Fee, OneHourFromNow(j.H));
            var charged = new System.Collections.Generic.List<BigInteger>();
            j.H.Kernel.OnAutomationSpendCharged += (registration, request, amount, spent) =>
            {
                Assert.Equal(j.RegistrationId, registration!.Value);
                Assert.Equal(Fee, amount!.Value);
                charged.Add(spent!.Value);
            };

            BigInteger first = Execute(j);
            BigInteger second = Execute(j);

            Assert.Equal(j.Requester, j.H.SponsorOf(first));
            Assert.Equal(j.Requester, j.H.SponsorOf(second));
            Assert.Equal(2 * Fee, j.H.CreditOf(j.Requester));
            Assert.Equal(2 * Fee, j.H.ApprovalSpent(j.RegistrationId));
            Assert.Equal(new[] { (BigInteger)Fee, 2 * Fee }, charged);

            AssertReverts(() => Execute(j), "automation spend cap exceeded");

            Assert.Equal(2 * Fee, j.H.CreditOf(j.Requester));
            Assert.Equal(2 * Fee, j.H.ApprovalSpent(j.RegistrationId));
        }

        [Fact]
        public void AnApprovalStopsAtItsExpiry()
        {
            Job j = RegisterJob(5 * Fee);
            Approve(j, 5 * Fee, j.H.NowMs + 600_000);
            Execute(j);
            Assert.Equal(3 * Fee, j.H.CreditOf(j.Requester));

            j.H.AdvanceMs(600_000);

            AssertReverts(() => Execute(j), "automation spend approval expired");
            Assert.Equal(3 * Fee, j.H.CreditOf(j.Requester));
        }

        [Fact]
        public void ARevokedApprovalChargesNothingAndKeepsItsRecordedSpend()
        {
            Job j = RegisterJob(5 * Fee);
            Approve(j, 5 * Fee, OneHourFromNow(j.H));
            Execute(j);

            Approve(j, 0, 0);

            Assert.Equal(BigInteger.Zero, j.H.ApprovalCap(j.RegistrationId));
            Assert.Equal(BigInteger.Zero, j.H.ApprovalExpiresAt(j.RegistrationId));
            Assert.Equal(Fee, j.H.ApprovalSpent(j.RegistrationId));
            AssertReverts(() => Execute(j), "automation spend not approved");
            Assert.Equal(3 * Fee, j.H.CreditOf(j.Requester));
        }

        [Fact]
        public void TheAppFeePayerSponsorsFirstAndTheApprovalIsLeftUntouched()
        {
            Job j = RegisterJob(5 * Fee, operatorCredit: 5 * Fee);
            Approve(j, 5 * Fee, OneHourFromNow(j.H));
            BigInteger requesterCredit = j.H.CreditOf(j.Requester);

            BigInteger id = Execute(j);

            Assert.Equal(j.Operator, j.H.SponsorOf(id));
            Assert.Equal(requesterCredit, j.H.CreditOf(j.Requester));
            Assert.Equal(BigInteger.Zero, j.H.ApprovalSpent(j.RegistrationId));
        }

        [Fact]
        public void AnExpiryRefundGivesTheSpendBackToTheJobsCap()
        {
            Job j = RegisterJob(5 * Fee);
            Approve(j, Fee, OneHourFromNow(j.H) + 7_200_000);
            BigInteger id = Execute(j);
            Assert.Equal(Fee, j.H.ApprovalSpent(j.RegistrationId));
            AssertReverts(() => Execute(j), "automation spend cap exceeded");

            j.H.AdvancePastTtl();
            j.H.Sign(Scoped(j.H.Owner, WitnessScope.CalledByEntry));
            j.H.Kernel.ExpireStaleRequest(id);

            Assert.Equal(4 * Fee, j.H.CreditOf(j.Requester)); // refunded to the requester
            Assert.Equal(BigInteger.Zero, j.H.ApprovalSpent(j.RegistrationId));
            Execute(j); // the unfulfilled execution no longer counts against the cap
            Assert.Equal(Fee, j.H.ApprovalSpent(j.RegistrationId));
        }

        [Fact]
        public void AFailedRegistrationCannotBeExecuted()
        {
            Job j = RegisterJob(5 * Fee);
            Approve(j, 5 * Fee, OneHourFromNow(j.H) + 7_200_000);
            j.H.AdvancePastTtl();
            j.H.Sign(Scoped(j.H.Owner, WitnessScope.CalledByEntry));
            j.H.Kernel.ExpireStaleRequest(j.RegistrationId); // registration -> Failed

            AssertReverts(() => Execute(j), "automation registration failed");
            Assert.Equal(5 * Fee, j.H.CreditOf(j.Requester)); // registration fee refunded, nothing charged
        }

        [Fact]
        public void AnExecutionCannotBeAnotherAutomationControlRequest()
        {
            Job j = RegisterJob(5 * Fee);
            Approve(j, 5 * Fee, OneHourFromNow(j.H));

            AssertReverts(() => Execute(j, "automation_register"), "invalid automation execution");
            Assert.Equal(4 * Fee, j.H.CreditOf(j.Requester));
        }

        [Fact]
        public void OnlyTheUpdaterQueuesExecutions()
        {
            Job j = RegisterJob(5 * Fee);
            Approve(j, 5 * Fee, OneHourFromNow(j.H));
            j.H.Sign(Scoped(j.Requester, WitnessScope.Global));

            AssertReverts(
                () => j.H.Kernel.QueueAutomationExecution(j.RegistrationId, j.Requester, "oracle", Payload),
                "unauthorized");
            Assert.Equal(4 * Fee, j.H.CreditOf(j.Requester));
        }

        [Fact]
        public void AJobRecordNamingAnotherOwnerIsRefused()
        {
            // The relayer names the job owner from its own job record. If that record points
            // at a registration some other account made and approved (stale or mis-keyed),
            // the kernel refuses instead of billing the other account's approval.
            Job j = RegisterJob(5 * Fee);
            Approve(j, 5 * Fee, OneHourFromNow(j.H));
            UInt160 someoneElse = NewAccount();
            j.H.Sign(Scoped(j.H.Owner, WitnessScope.CalledByEntry));

            AssertReverts(
                () => j.H.Kernel.QueueAutomationExecution(j.RegistrationId, someoneElse, "oracle", Payload),
                "automation requester mismatch");

            Assert.Equal(4 * Fee, j.H.CreditOf(j.Requester));
            Assert.Equal(BigInteger.Zero, j.H.ApprovalSpent(j.RegistrationId));
        }

        [Fact]
        public void SubmitAutomationRegistrationRecordsTheApprovalInTheSameTransaction()
        {
            KernelFeeHarness h = KernelFeeHarness.Deploy();
            UInt160 op = NewAccount();
            UInt160 requester = NewAccount();
            h.RegisterApp(App, op, op, null, AutomationModule, OracleModule);
            h.OwnerIsUpdater();
            h.FundCredit(requester, 5 * Fee);
            BigInteger expiresAt = h.NowMs + 3_600_000;

            h.Sign(Scoped(requester, WitnessScope.CalledByEntry));
            BigInteger registrationId = h.Kernel.SubmitAutomationRegistration(App, JobPayload, 3 * Fee, expiresAt)!.Value;

            Assert.Equal(requester, h.RequesterOf(registrationId));
            Assert.Equal(requester, h.SponsorOf(registrationId)); // witnessed self-pay
            Assert.Equal(3 * Fee, h.ApprovalCap(registrationId));
            Assert.Equal(expiresAt, h.ApprovalExpiresAt(registrationId));

            h.Sign(Scoped(h.Owner, WitnessScope.CalledByEntry));
            BigInteger id = h.Kernel.QueueAutomationExecution(registrationId, requester, "oracle", Payload)!.Value;
            Assert.Equal(requester, h.SponsorOf(id));
            Assert.Equal(3 * Fee, h.CreditOf(requester));
        }
    }
}
