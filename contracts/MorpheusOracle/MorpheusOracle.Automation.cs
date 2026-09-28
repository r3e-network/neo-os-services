using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace MorpheusOracle.Contracts
{
    public delegate void AutomationSpendApprovedHandler(BigInteger registrationRequestId, UInt160 requester, string appId, BigInteger cap, BigInteger expiresAt);
    public delegate void AutomationSpendChargedHandler(BigInteger registrationRequestId, BigInteger requestId, BigInteger amount, BigInteger spent);

    /// <summary>
    /// Requester consent for automation self-pay (R-01).
    /// </summary>
    /// <remarks>
    /// The relayer (updater role) queues every automation execution under the job owner's
    /// name. Naming an account is not consent to spend its credit, so the updater lanes
    /// (QueueSystemRequest / QueueAutomationRequest) can no longer charge an unwitnessed
    /// requester. A job owner who wants its executions paid from its own credit signs an
    /// approval for exactly one job — keyed by the kernel request id of the job's
    /// automation_register request — with a total spend cap and an expiry. Only
    /// QueueAutomationExecution, which names that registration, may draw on it; every
    /// debit is recorded against the cap and emitted as AutomationSpendCharged. When the
    /// app fee payer sponsors the requester (the sponsorship policy), the approval is not
    /// touched. The approval is written with the requester's witness checked in this
    /// contract, either at registration (SubmitAutomationRegistration) or later
    /// (ApproveAutomationSpend), and cap 0 revokes it. Cancelling a job off-chain does not
    /// touch the approval; the owner revokes it with cap 0.
    /// </remarks>
    public partial class MorpheusOracle : SmartContract
    {
        private const string AUTOMATION_MODULE_ID = "automation.run";
        private const string AUTOMATION_REGISTER_OPERATION = "automation_register";

        // registrationRequestId -> AutomationSpendApproval.
        private static readonly byte[] PREFIX_AUTOMATION_SPEND = new byte[] { 0x36 };
        // requestId of an execution paid under an approval -> its registrationRequestId, so
        // an expiry refund can give the spend back to the job's cap.
        private static readonly byte[] PREFIX_AUTOMATION_CHARGE = new byte[] { 0x37 };

        public struct AutomationSpendApproval
        {
            public BigInteger RegistrationRequestId;
            public UInt160 Requester;
            public string AppId;
            public BigInteger Cap;
            public BigInteger Spent;
            // Runtime.Time (ms). The approval covers a debit only while Runtime.Time < ExpiresAt.
            public BigInteger ExpiresAt;
        }

        [DisplayName("AutomationSpendApproved")]
        public static event AutomationSpendApprovedHandler OnAutomationSpendApproved;

        [DisplayName("AutomationSpendCharged")]
        public static event AutomationSpendChargedHandler OnAutomationSpendCharged;

        private static StorageMap AutomationSpendMap() => new StorageMap(Storage.CurrentContext, PREFIX_AUTOMATION_SPEND);
        private static StorageMap AutomationChargeMap() => new StorageMap(Storage.CurrentContext, PREFIX_AUTOMATION_CHARGE);

        /// <summary>
        /// The spend approval recorded for the job registered by registrationRequestId, or an
        /// empty record (Requester null, Cap 0) when the requester never approved one.
        /// </summary>
        [Safe]
        public static AutomationSpendApproval GetAutomationSpendApproval(BigInteger registrationRequestId)
        {
            ByteString raw = AutomationSpendMap().Get(registrationRequestId.ToByteArray());
            if (raw == null)
            {
                return new AutomationSpendApproval
                {
                    RegistrationRequestId = registrationRequestId,
                    Requester = null,
                    AppId = "",
                    Cap = 0,
                    Spent = 0,
                    ExpiresAt = 0
                };
            }
            return (AutomationSpendApproval)StdLib.Deserialize(raw);
        }

        /// <summary>
        /// Direct-lane automation registration that records the requester's spend approval in
        /// the same transaction. The requester is the witnessed transaction sender, exactly as
        /// in SubmitMiniAppRequest. cap 0 registers without an approval (the executions must
        /// then be sponsored by the app fee payer).
        /// </summary>
        public static BigInteger SubmitAutomationRegistration(string appId, ByteString payload, BigInteger cap, BigInteger expiresAt)
        {
            UInt160 requester = Runtime.Transaction.Sender;
            ExecutionEngine.Assert(requester != null && requester.IsValid, "requester required");
            ExecutionEngine.Assert(Runtime.CheckWitness(requester), "unauthorized requester");
            ExecutionEngine.Assert(cap >= 0, "invalid cap");

            BigInteger registrationRequestId = SubmitMiniAppRequestInternal(
                requester, appId, AUTOMATION_MODULE_ID, AUTOMATION_REGISTER_OPERATION, payload, true, 0);
            if (cap > 0)
            {
                ApproveAutomationSpend(registrationRequestId, cap, expiresAt);
            }
            return registrationRequestId;
        }

        /// <summary>
        /// Set, raise, lower or revoke (cap 0) the approval for one automation job. Only the
        /// job's requester may sign it, and its witness must reach this contract (entry call,
        /// Global, or CustomContracts listing the kernel). The recorded spend is kept across
        /// changes, so the cap always bounds the job's total draw.
        /// </summary>
        public static void ApproveAutomationSpend(BigInteger registrationRequestId, BigInteger cap, BigInteger expiresAt)
        {
            KernelRequest registration = RequireAutomationRegistration(registrationRequestId);
            ExecutionEngine.Assert(Runtime.CheckWitness(registration.Requester), "unauthorized");
            ExecutionEngine.Assert(cap >= 0, "invalid cap");
            ExecutionEngine.Assert(cap == 0 || expiresAt > Runtime.Time, "invalid expiry");

            AutomationSpendApproval approval = GetAutomationSpendApproval(registrationRequestId);
            approval.Requester = registration.Requester;
            approval.AppId = registration.AppId;
            approval.Cap = cap;
            approval.ExpiresAt = cap == 0 ? 0 : expiresAt;
            AutomationSpendMap().Put(registrationRequestId.ToByteArray(), StdLib.Serialize(approval));
            OnAutomationSpendApproved(registrationRequestId, registration.Requester, registration.AppId, cap, approval.ExpiresAt);
        }

        /// <summary>
        /// Updater lane for one execution of an automation job. The requester and app come from
        /// the job's on-chain registration, never from the caller; <paramref name="requester"/>
        /// is only the job owner the caller believes it is queuing for, and a mismatch reverts,
        /// so a stale or mis-keyed job record cannot be billed to another account's approval.
        /// The fee is paid by the app fee payer when it sponsors the requester, otherwise by the
        /// requester only under its spend approval for this job (within the cap, before the
        /// expiry); otherwise it reverts.
        /// </summary>
        public static BigInteger QueueAutomationExecution(BigInteger registrationRequestId, UInt160 requester, string requestType, ByteString payload)
        {
            ValidateUpdater();
            KernelRequest registration = RequireAutomationRegistration(registrationRequestId);
            ExecutionEngine.Assert(registration.Status != KernelRequestStatus.Failed, "automation registration failed");
            ExecutionEngine.Assert(requester != null && requester == registration.Requester, "automation requester mismatch");

            string moduleId = ResolveLegacyModuleId(requestType);
            // An execution must not be another automation control request made in the
            // requester's name (e.g. a registration that would spawn further jobs).
            ExecutionEngine.Assert(moduleId != AUTOMATION_MODULE_ID, "invalid automation execution");

            bool requesterWitnessed = Runtime.CheckWitness(registration.Requester);
            return SubmitMiniAppRequestInternal(
                registration.Requester, registration.AppId, moduleId, requestType, payload,
                requesterWitnessed, registrationRequestId);
        }

        private static KernelRequest RequireAutomationRegistration(BigInteger registrationRequestId)
        {
            KernelRequest registration = GetRequest(registrationRequestId);
            ExecutionEngine.Assert(registration.Id > 0, "registration not found");
            ExecutionEngine.Assert(
                registration.ModuleId == AUTOMATION_MODULE_ID && registration.Operation == AUTOMATION_REGISTER_OPERATION,
                "not an automation registration");
            ExecutionEngine.Assert(registration.Requester != null && registration.Requester.IsValid, "requester required");
            return registration;
        }

        // Called by ResolveFeeBasis before any debit, with the fee about to be charged.
        private static void AssertAutomationSpendAllowed(BigInteger registrationRequestId, string appId, UInt160 requester, BigInteger fee)
        {
            AutomationSpendApproval approval = GetAutomationSpendApproval(registrationRequestId);
            ExecutionEngine.Assert(
                approval.Cap > 0 && approval.Requester == requester && approval.AppId == appId,
                "automation spend not approved");
            ExecutionEngine.Assert(Runtime.Time < approval.ExpiresAt, "automation spend approval expired");
            ExecutionEngine.Assert(approval.Spent + fee <= approval.Cap, "automation spend cap exceeded");
        }

        private static void RecordAutomationSpend(BigInteger registrationRequestId, BigInteger requestId, BigInteger amount)
        {
            AutomationSpendApproval approval = GetAutomationSpendApproval(registrationRequestId);
            approval.Spent = approval.Spent + amount;
            AutomationSpendMap().Put(registrationRequestId.ToByteArray(), StdLib.Serialize(approval));
            AutomationChargeMap().Put(requestId.ToByteArray(), registrationRequestId);
            OnAutomationSpendCharged(registrationRequestId, requestId, amount, approval.Spent);
        }

        // ExpireStaleRequest refunded this execution's fee to the requester, so it no longer
        // counts against the job's cap (mirrors ReleaseSponsoredSpend; clamped at 0). A request
        // that was not paid under an approval has no charge record and is left untouched.
        private static void ReleaseAutomationSpend(BigInteger requestId, BigInteger amount)
        {
            if (amount <= 0) return;
            ByteString rawRegistration = AutomationChargeMap().Get(requestId.ToByteArray());
            if (rawRegistration == null) return;
            AutomationChargeMap().Delete(requestId.ToByteArray());

            BigInteger registrationRequestId = (BigInteger)rawRegistration;
            ByteString raw = AutomationSpendMap().Get(registrationRequestId.ToByteArray());
            if (raw == null) return;
            AutomationSpendApproval approval = (AutomationSpendApproval)StdLib.Deserialize(raw);
            approval.Spent = approval.Spent > amount ? approval.Spent - amount : 0;
            AutomationSpendMap().Put(registrationRequestId.ToByteArray(), StdLib.Serialize(approval));
        }
    }
}
