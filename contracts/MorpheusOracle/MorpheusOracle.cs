using System;
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
    public enum KernelRequestStatus : byte
    {
        Pending = 0,
        Succeeded = 1,
        Failed = 2
    }

    public delegate void MiniAppRegisteredHandler(string appId, UInt160 admin, UInt160 feePayer, UInt160 callbackContract);
    public delegate void MiniAppUpdatedHandler(string appId, UInt160 admin, UInt160 feePayer, UInt160 callbackContract, bool active);
    public delegate void SystemModuleRegisteredHandler(string moduleId, string endpoint, string schemaHash);
    public delegate void SystemModuleUpdatedHandler(string moduleId, string endpoint, string schemaHash, bool active);
    public delegate void MiniAppCapabilityGrantedHandler(string appId, string moduleId);
    public delegate void MiniAppCapabilityRevokedHandler(string appId, string moduleId);
    public delegate void MiniAppRequestQueuedHandler(BigInteger requestId, string appId, string moduleId, string operation, UInt160 requester, UInt160 sponsor, ByteString payload, ByteString payloadHash);
    public delegate void MiniAppRequestCompletedHandler(BigInteger requestId, string appId, string moduleId, string operation, bool success, ByteString resultHash, BigInteger resultSize, string error);
    public delegate void MiniAppInboxStoredHandler(string appId, BigInteger requestId, UInt160 requester, bool success);
    public delegate void MiniAppStateChangedHandler(string appId, ByteString stateKey, BigInteger valueSize);
    public delegate void AdminChangedHandler(UInt160 oldAdmin, UInt160 newAdmin);
    public delegate void UpdaterChangedHandler(UInt160 oldUpdater, UInt160 newUpdater);
    public delegate void RuntimeEncryptionKeyUpdatedHandler(BigInteger version, string algorithm, string publicKey);
    public delegate void RuntimeVerifierUpdatedHandler(ECPoint oldVerifier, ECPoint newVerifier);
    public delegate void RequestFeeUpdatedHandler(BigInteger oldFee, BigInteger newFee);
    public delegate void RequestFeeDepositedHandler(UInt160 from, BigInteger amount, BigInteger creditBalance);
    public delegate void AccruedFeesWithdrawnHandler(UInt160 to, BigInteger amount);
    public delegate void RequestExpiredHandler(BigInteger requestId, string appId, UInt160 requester, UInt160 sponsor, BigInteger refundAmount);
    public delegate void RequestTTLUpdatedHandler(BigInteger oldTTL, BigInteger newTTL);
    public delegate void SponsoredRequesterAllowedHandler(string appId, UInt160 requester, bool allowed);
    public delegate void SponsoredRequesterCapUpdatedHandler(string appId, UInt160 requester, BigInteger cap);
    public delegate void AdminTimelockProposedHandler(UInt160 proposed, BigInteger executeAfter);
    public delegate void UpgradeScheduledHandler(BigInteger executeAfter);
    public delegate void ContractUpgradedHandler(ByteString nefHash, ByteString manifestHash);
    public delegate void SecurityKeyChangeProposedHandler(string kind, BigInteger executeAfter);

    // Pending-change records for the governance timelocks (PlatformRegistry
    // PendingAddress pattern): serialized with StdLib.Serialize into a single
    // storage slot per pending change.
    public class PendingRuntimeKeyChange { public string Algorithm; public string Key; public BigInteger Eta; }
    public class PendingRuntimeVerifierChange { public ByteString Verifier; public BigInteger Eta; }

    /// <summary>
    /// Legacy deployment name retained for compatibility, now acting as the shared MiniApp OS kernel.
    /// </summary>
    /// <remarks>
    /// The contract centralizes generic platform concerns:
    /// - miniapp registration and discovery
    /// - module registry and capability grants
    /// - unified async request queue / inbox delivery
    /// - prepaid fee credits and runtime verification keys
    /// - generic namespaced app state for registration-only miniapps
    ///
    /// Miniapps are expected to keep only their business semantics off-chain or in optional
    /// extension contracts, while the kernel owns IO, callback delivery, and state plumbing.
    /// </remarks>
    [DisplayName("MorpheusOracle")]
    [ManifestExtra("Author", "Morpheus Oracle")]
    [ManifestExtra("Version", "2.0.0")]
    [ManifestExtra("Description", "MiniApp OS kernel with shared IO, registration, and callback orchestration")]
    [ContractPermission("*", "onMiniAppResult")]
    [ContractPermission("*", "onOracleResult")]
    public partial class MorpheusOracle : SmartContract
    {
        // ── Storage-key prefix allocation map (READ BEFORE ADDING A PREFIX) ──────────
        //
        // FOOTGUN: the values below are HEXADECIMAL literals, but the original author
        // advanced them as if counting in DECIMAL — so the sequence jumps 0x09 -> 0x10
        // and 0x19 -> 0x20 (and 0x29 -> 0x2A is where genuine hex counting resumes).
        // Those jumps are NOT reservations: the byte values 0x0A-0x0F and 0x1A-0x1F
        // were simply skipped and are FREE. Do not read the gaps as "taken".
        //
        // These bytes are the on-chain storage layout and are FROZEN for the deployed
        // contracts (testnet + mainnet). NEVER renumber an existing prefix — doing so
        // orphans every key already written under the old byte. Only ever APPEND a new
        // prefix using one of the free bytes listed below.
        //
        //   USED (do not reuse):
        //     0x01-0x09  ADMIN, UPDATER, REQUEST, COUNTER, APP, APP_INDEX, APP_COUNT,
        //                MODULE, MODULE_INDEX
        //     0x10-0x19  MODULE_COUNT, APP_MODULE_GRANT, RUNTIME_KEY, RUNTIME_KEY_ALGO,
        //                RUNTIME_KEY_VERSION, RUNTIME_VERIFIER, TOTAL_REQUESTS,
        //                TOTAL_FULFILLED, REQUEST_FEE, REQUEST_CREDIT
        //     0x20-0x29  ACCRUED_REQUEST_FEES, APP_REQUESTS, APP_FULFILLED, APP_INBOX,
        //                APP_STATE, REQUEST_TTL, RESERVED_REQUEST_FEES, CALLBACK_INDEX,
        //                ACCOUNT_REGISTERED, SPONSOR_GATED
        //     0x2A-0x2E  SPONSOR_ALLOWED, SPONSOR_CAP, SPONSOR_SPENT,
        //                INDEX_REBUILD_REQUIRED, INDEX_REBUILD_CURSOR
        //     0x2F-0x34  PENDING_ADMIN, PENDING_ADMIN_TIME, UPGRADE_TIME,
        //                UPGRADE_HASH, PENDING_RUNTIME_KEY, PENDING_RUNTIME_VERIFIER
        //
        //   FREE (safe to claim next, in this order):
        //     0x35, then 0x36+ … (and the skipped 0x0A-0x0F, 0x1A-0x1F).
        //
        //   NOTE: FULFILLMENT_SIGNATURE_DOMAIN below is a multi-byte ASCII signing-domain
        //   constant, NOT a storage prefix — it does not consume a prefix byte.
        // ─────────────────────────────────────────────────────────────────────────────
        private static readonly byte[] PREFIX_ADMIN = new byte[] { 0x01 };
        private static readonly byte[] PREFIX_UPDATER = new byte[] { 0x02 };
        private static readonly byte[] PREFIX_REQUEST = new byte[] { 0x03 };
        private static readonly byte[] PREFIX_COUNTER = new byte[] { 0x04 };
        private static readonly byte[] PREFIX_APP = new byte[] { 0x05 };
        private static readonly byte[] PREFIX_APP_INDEX = new byte[] { 0x06 };
        private static readonly byte[] PREFIX_APP_COUNT = new byte[] { 0x07 };
        private static readonly byte[] PREFIX_MODULE = new byte[] { 0x08 };
        private static readonly byte[] PREFIX_MODULE_INDEX = new byte[] { 0x09 };
        private static readonly byte[] PREFIX_MODULE_COUNT = new byte[] { 0x10 };
        private static readonly byte[] PREFIX_APP_MODULE_GRANT = new byte[] { 0x11 };
        private static readonly byte[] PREFIX_RUNTIME_KEY = new byte[] { 0x12 };
        private static readonly byte[] PREFIX_RUNTIME_KEY_ALGO = new byte[] { 0x13 };
        private static readonly byte[] PREFIX_RUNTIME_KEY_VERSION = new byte[] { 0x14 };
        private static readonly byte[] PREFIX_RUNTIME_VERIFIER = new byte[] { 0x15 };
        private static readonly byte[] PREFIX_TOTAL_REQUESTS = new byte[] { 0x16 };
        private static readonly byte[] PREFIX_TOTAL_FULFILLED = new byte[] { 0x17 };
        private static readonly byte[] PREFIX_REQUEST_FEE = new byte[] { 0x18 };
        private static readonly byte[] PREFIX_REQUEST_CREDIT = new byte[] { 0x19 };
        private static readonly byte[] PREFIX_ACCRUED_REQUEST_FEES = new byte[] { 0x20 };
        private static readonly byte[] PREFIX_APP_REQUESTS = new byte[] { 0x21 };
        private static readonly byte[] PREFIX_APP_FULFILLED = new byte[] { 0x22 };
        private static readonly byte[] PREFIX_APP_INBOX = new byte[] { 0x23 };
        private static readonly byte[] PREFIX_APP_STATE = new byte[] { 0x24 };
        private static readonly byte[] PREFIX_REQUEST_TTL = new byte[] { 0x25 };
        // Subset of PREFIX_ACCRUED_REQUEST_FEES that backs still-pending (refundable) requests.
        // Invariant: AccruedRequestFees() >= ReservedRequestFees() at all times. Only the free
        // surplus (accrued - reserved) is withdrawable by the admin; the reserved portion is
        // held to guarantee every pending request's expiry refund can be paid in full.
        private static readonly byte[] PREFIX_RESERVED_REQUEST_FEES = new byte[] { 0x26 };
        // Reverse index callbackContract(UInt160) -> appId(string) so request submission can
        // resolve the owning miniapp in O(1) instead of scanning every registered app (DoS).
        private static readonly byte[] PREFIX_CALLBACK_INDEX = new byte[] { 0x27 };
        // Monotonic membership set: account(UInt160) -> 1 if it is (or ever was) a registered
        // miniapp admin or fee-payer. Replaces the O(n) registry scan for directed-deposit auth.
        // Idempotent by design so the post-upgrade backfill (RebuildIndexes) cannot drift.
        private static readonly byte[] PREFIX_ACCOUNT_REGISTERED = new byte[] { 0x28 };
        // Per-app opt-in flag (appId -> 1) recording that the app's admin has configured at least
        // one sponsorship control (allowlist entry or spend cap). Until this flag is set the app
        // sponsors EVERY requester exactly as before (backward compatible); once set, only
        // allowlisted or under-cap requesters draw on the sponsor's credit.
        private static readonly byte[] PREFIX_SPONSOR_GATED = new byte[] { 0x29 };
        // Per-(appId, requester) allowlist bit ((appId,requester) -> 1) of requesters whose
        // requests the app's fee payer is willing to sponsor unconditionally.
        private static readonly byte[] PREFIX_SPONSOR_ALLOWED = new byte[] { 0x2A };
        // Per-(appId, requester) sponsored spend cap ((appId,requester) -> cap) limiting the total
        // fees the sponsor will cover for that requester. 0/absent means no cap configured.
        private static readonly byte[] PREFIX_SPONSOR_CAP = new byte[] { 0x2B };
        // Per-(appId, requester) cumulative sponsored spend ((appId,requester) -> spent), compared
        // against the cap above so a capped requester can be sponsored only while under budget.
        private static readonly byte[] PREFIX_SPONSOR_SPENT = new byte[] { 0x2C };
        // Upgrade migration lock. ContractManagement.Update invokes _deploy(update=true),
        // which snapshots a required sequential callback/account-index rebuild before
        // miniapp mutations may resume. This closes the empty-index callback squatting window.
        private static readonly byte[] PREFIX_INDEX_REBUILD_REQUIRED = new byte[] { 0x2D };
        private static readonly byte[] PREFIX_INDEX_REBUILD_CURSOR = new byte[] { 0x2E };
        // Governance timelocks (PlatformRegistry pattern): pending platform-admin
        // rotation, hash-pinned self-upgrade, and verification/encryption key
        // re-pointing. Claimed from the documented free slots 0x2F+.
        private static readonly byte[] PREFIX_PENDING_ADMIN = new byte[] { 0x2F };
        private static readonly byte[] PREFIX_PENDING_ADMIN_TIME = new byte[] { 0x30 };
        private static readonly byte[] PREFIX_UPGRADE_TIME = new byte[] { 0x31 };
        private static readonly byte[] PREFIX_UPGRADE_HASH = new byte[] { 0x32 };
        private static readonly byte[] PREFIX_PENDING_RUNTIME_KEY = new byte[] { 0x33 };
        private static readonly byte[] PREFIX_PENDING_RUNTIME_VERIFIER = new byte[] { 0x34 };
        private static readonly byte[] FULFILLMENT_SIGNATURE_DOMAIN = new byte[] { 109, 105, 110, 105, 97, 112, 112, 45, 111, 115, 45, 102, 117, 108, 102, 105, 108, 108, 109, 101, 110, 116, 45, 118, 49 };

        // 24 hours in milliseconds — same delay as the PlatformRegistry spine.
        // A compromised admin EOA can no longer repoint verification keys, swap
        // the contract, or hand over admin in the same transaction it is stolen in.
        private const long TIMELOCK_DELAY_MS = 86400000;

        private const int MAX_APP_ID_LENGTH = 64;
        private const int MAX_MODULE_ID_LENGTH = 64;
        private const int MAX_OPERATION_LENGTH = 64;
        private const int MAX_PAYLOAD_LENGTH = 4096;
        private const int MAX_RESULT_LENGTH = 4096;
        private const int MAX_ERROR_LENGTH = 256;
        private const int MAX_RUNTIME_KEY_ALGO_LENGTH = 64;
        private const int MAX_RUNTIME_KEY_LENGTH = 2048;
        private const int MAX_METADATA_URI_LENGTH = 256;
        private const int MAX_METADATA_HASH_LENGTH = 128;
        private const int MAX_STATE_KEY_LENGTH = 128;
        private const int MAX_STATE_VALUE_LENGTH = 4096;
        private const string CALLBACK_METHOD = "onMiniAppResult";
        private const string LEGACY_CALLBACK_METHOD = "onOracleResult";
        private const long DEFAULT_REQUEST_FEE = 1_000_000;
        /// <summary>
        /// Default request TTL in milliseconds (1 hour = 3,600,000 ms).
        /// Stale requests older than this can be expired to refund the fee credit.
        /// Runtime.Time on Neo N3 is in milliseconds since epoch.
        /// </summary>
        private const long DEFAULT_REQUEST_TTL = 3_600_000;

        public struct MiniAppRecord
        {
            public string AppId;
            public UInt160 Admin;
            public UInt160 FeePayer;
            public UInt160 CallbackContract;
            public string MetadataUri;
            public string MetadataHash;
            public bool Active;
            public BigInteger CreatedAt;
            public BigInteger UpdatedAt;
        }

        public struct SystemModuleRecord
        {
            public string ModuleId;
            public string Endpoint;
            public string SchemaHash;
            public bool Active;
            public BigInteger CreatedAt;
            public BigInteger UpdatedAt;
        }

        public struct KernelRequest
        {
            public BigInteger Id;
            public string AppId;
            public string ModuleId;
            public string Operation;
            public ByteString Payload;
            public UInt160 Requester;
            public UInt160 Sponsor;
            public UInt160 CallbackContract;
            public KernelRequestStatus Status;
            public BigInteger CreatedAt;
            public BigInteger FulfilledAt;
            public bool Success;
            public ByteString Result;
            public string Error;
            // Exact request fee debited from the sponsor at submission time.
            // Stored so that an expiry refund returns precisely what was paid
            // even if the admin changes the fee via SetRequestFee in between.
            public BigInteger FeePaid;
        }

        public struct InboxItem
        {
            public string AppId;
            public BigInteger RequestId;
            public string ModuleId;
            public string Operation;
            public UInt160 Requester;
            public bool Success;
            public ByteString Result;
            public string Error;
            public BigInteger DeliveredAt;
        }

        [DisplayName("MiniAppRegistered")]
        public static event MiniAppRegisteredHandler OnMiniAppRegistered;

        [DisplayName("MiniAppUpdated")]
        public static event MiniAppUpdatedHandler OnMiniAppUpdated;

        [DisplayName("SystemModuleRegistered")]
        public static event SystemModuleRegisteredHandler OnSystemModuleRegistered;

        [DisplayName("SystemModuleUpdated")]
        public static event SystemModuleUpdatedHandler OnSystemModuleUpdated;

        [DisplayName("MiniAppCapabilityGranted")]
        public static event MiniAppCapabilityGrantedHandler OnMiniAppCapabilityGranted;

        [DisplayName("MiniAppCapabilityRevoked")]
        public static event MiniAppCapabilityRevokedHandler OnMiniAppCapabilityRevoked;

        [DisplayName("MiniAppRequestQueued")]
        public static event MiniAppRequestQueuedHandler OnMiniAppRequestQueued;

        [DisplayName("MiniAppRequestCompleted")]
        public static event MiniAppRequestCompletedHandler OnMiniAppRequestCompleted;

        [DisplayName("MiniAppInboxStored")]
        public static event MiniAppInboxStoredHandler OnMiniAppInboxStored;

        [DisplayName("MiniAppStateChanged")]
        public static event MiniAppStateChangedHandler OnMiniAppStateChanged;

        [DisplayName("AdminChanged")]
        public static event AdminChangedHandler OnAdminChanged;

        [DisplayName("UpdaterChanged")]
        public static event UpdaterChangedHandler OnUpdaterChanged;

        [DisplayName("RuntimeEncryptionKeyUpdated")]
        public static event RuntimeEncryptionKeyUpdatedHandler OnRuntimeEncryptionKeyUpdated;

        [DisplayName("RuntimeVerifierUpdated")]
        public static event RuntimeVerifierUpdatedHandler OnRuntimeVerifierUpdated;

        [DisplayName("RequestFeeUpdated")]
        public static event RequestFeeUpdatedHandler OnRequestFeeUpdated;

        [DisplayName("RequestFeeDeposited")]
        public static event RequestFeeDepositedHandler OnRequestFeeDeposited;

        [DisplayName("AccruedFeesWithdrawn")]
        public static event AccruedFeesWithdrawnHandler OnAccruedFeesWithdrawn;

        [DisplayName("RequestExpired")]
        public static event RequestExpiredHandler OnRequestExpired;

        [DisplayName("RequestTTLUpdated")]
        public static event RequestTTLUpdatedHandler OnRequestTTLUpdated;

        [DisplayName("SponsoredRequesterAllowed")]
        public static event SponsoredRequesterAllowedHandler OnSponsoredRequesterAllowed;

        [DisplayName("SponsoredRequesterCapUpdated")]
        public static event SponsoredRequesterCapUpdatedHandler OnSponsoredRequesterCapUpdated;

        [DisplayName("AdminTimelockProposed")]
        public static event AdminTimelockProposedHandler OnAdminTimelockProposed;

        [DisplayName("UpgradeScheduled")]
        public static event UpgradeScheduledHandler OnUpgradeScheduled;

        [DisplayName("ContractUpgraded")]
        public static event ContractUpgradedHandler OnContractUpgraded;

        [DisplayName("SecurityKeyChangeProposed")]
        public static event SecurityKeyChangeProposedHandler OnSecurityKeyChangeProposed;

        public static void _deploy(object data, bool update)
        {
            if (update)
            {
                if (GetMiniAppCount() > 0)
                {
                    Storage.Put(Storage.CurrentContext, PREFIX_INDEX_REBUILD_REQUIRED, 1);
                    Storage.Delete(Storage.CurrentContext, PREFIX_INDEX_REBUILD_CURSOR);
                }
                return;
            }

            Transaction tx = Runtime.Transaction;
            Storage.Put(Storage.CurrentContext, PREFIX_ADMIN, tx.Sender);
            Storage.Put(Storage.CurrentContext, PREFIX_COUNTER, 0);
            Storage.Put(Storage.CurrentContext, PREFIX_REQUEST_FEE, DEFAULT_REQUEST_FEE);

            SeedBuiltInModule("oracle.fetch", "/oracle/smart-fetch", "morpheus.module.oracle.fetch.v1");
            SeedBuiltInModule("compute.run", "/compute/execute", "morpheus.module.compute.run.v1");
            SeedBuiltInModule("feed.read", "/oracle/feed", "morpheus.module.feed.read.v1");
            SeedBuiltInModule("feed.publish", "/oracle/feed", "morpheus.module.feed.publish.v1");
            SeedBuiltInModule("identity.verify", "/neodid/resolve", "morpheus.module.identity.verify.v1");
            SeedBuiltInModule("automation.run", "/automation/execute", "morpheus.module.automation.run.v1");
        }

        [Safe]
        public static UInt160 Admin()
        {
            return (UInt160)Storage.Get(Storage.CurrentContext, PREFIX_ADMIN);
        }

        [Safe]
        public static UInt160 Updater()
        {
            return (UInt160)Storage.Get(Storage.CurrentContext, PREFIX_UPDATER);
        }

        [Safe]
        public static string RuntimeEncryptionAlgorithm()
        {
            return (string)Storage.Get(Storage.CurrentContext, PREFIX_RUNTIME_KEY_ALGO);
        }

        [Safe]
        public static string RuntimeEncryptionPublicKey()
        {
            return (string)Storage.Get(Storage.CurrentContext, PREFIX_RUNTIME_KEY);
        }

        [Safe]
        public static BigInteger RuntimeEncryptionKeyVersion()
        {
            ByteString raw = Storage.Get(Storage.CurrentContext, PREFIX_RUNTIME_KEY_VERSION);
            return raw == null ? 0 : (BigInteger)raw;
        }

        [Safe]
        public static ECPoint RuntimeVerificationPublicKey()
        {
            ByteString raw = Storage.Get(Storage.CurrentContext, PREFIX_RUNTIME_VERIFIER);
            return raw == null ? null : (ECPoint)(byte[])raw;
        }

        // Legacy aliases kept so existing clients can migrate incrementally.
        [Safe]
        public static string OracleEncryptionAlgorithm() => RuntimeEncryptionAlgorithm();

        [Safe]
        public static string OracleEncryptionPublicKey() => RuntimeEncryptionPublicKey();

        [Safe]
        public static BigInteger OracleEncryptionKeyVersion() => RuntimeEncryptionKeyVersion();

        [Safe]
        public static ECPoint OracleVerificationPublicKey() => RuntimeVerificationPublicKey();

        [Safe]
        public static BigInteger SystemRequestFee()
        {
            ByteString raw = Storage.Get(Storage.CurrentContext, PREFIX_REQUEST_FEE);
            return raw == null ? DEFAULT_REQUEST_FEE : (BigInteger)raw;
        }

        [Safe]
        public static BigInteger RequestFee() => SystemRequestFee();

        /// <summary>
        /// Returns the configured request TTL in milliseconds.
        /// Requests older than this TTL can be expired via ExpireStaleRequest.
        /// </summary>
        [Safe]
        public static BigInteger RequestTTL()
        {
            ByteString raw = Storage.Get(Storage.CurrentContext, PREFIX_REQUEST_TTL);
            return raw == null ? DEFAULT_REQUEST_TTL : (BigInteger)raw;
        }

        [Safe]
        public static BigInteger FeeCreditOf(UInt160 requester)
        {
            if (requester == null || !requester.IsValid) return 0;
            ByteString raw = RequestCreditMap().Get((byte[])requester);
            return raw == null ? 0 : (BigInteger)raw;
        }

        [Safe]
        public static BigInteger AccruedRequestFees()
        {
            ByteString raw = Storage.Get(Storage.CurrentContext, PREFIX_ACCRUED_REQUEST_FEES);
            return raw == null ? 0 : (BigInteger)raw;
        }

        // Fees currently reserved against pending (refundable) requests.
        [Safe]
        public static BigInteger ReservedRequestFees()
        {
            ByteString raw = Storage.Get(Storage.CurrentContext, PREFIX_RESERVED_REQUEST_FEES);
            return raw == null ? 0 : (BigInteger)raw;
        }

        // Free surplus the admin may withdraw without touching pending-request backing.
        [Safe]
        public static BigInteger WithdrawableFees()
        {
            BigInteger free = AccruedRequestFees() - ReservedRequestFees();
            return free > 0 ? free : 0;
        }

        private static void ReserveRequestFee(BigInteger amount)
        {
            if (amount <= 0) return;
            Storage.Put(Storage.CurrentContext, PREFIX_RESERVED_REQUEST_FEES, ReservedRequestFees() + amount);
        }

        // Releases a pending request's reserved fee once it leaves the pending state (fulfilled =
        // earned, expired = refunded). Clamped so the reserved ledger can never underflow.
        private static void ReleaseReservedFee(BigInteger amount)
        {
            if (amount <= 0) return;
            BigInteger reserved = ReservedRequestFees();
            BigInteger next = reserved > amount ? reserved - amount : 0;
            Storage.Put(Storage.CurrentContext, PREFIX_RESERVED_REQUEST_FEES, next);
        }

        [Safe]
        public static BigInteger GetMiniAppCount()
        {
            ByteString raw = Storage.Get(Storage.CurrentContext, PREFIX_APP_COUNT);
            return raw == null ? 0 : (BigInteger)raw;
        }

        [Safe]
        public static BigInteger GetSystemModuleCount()
        {
            ByteString raw = Storage.Get(Storage.CurrentContext, PREFIX_MODULE_COUNT);
            return raw == null ? 0 : (BigInteger)raw;
        }

        [Safe]
        public static string GetMiniAppIdByIndex(BigInteger index)
        {
            ExecutionEngine.Assert(index >= 0, "invalid index");
            ByteString raw = AppIndexMap().Get(index.ToByteArray());
            return raw == null ? "" : (string)raw;
        }

        [Safe]
        public static string GetSystemModuleIdByIndex(BigInteger index)
        {
            ExecutionEngine.Assert(index >= 0, "invalid index");
            ByteString raw = ModuleIndexMap().Get(index.ToByteArray());
            return raw == null ? "" : (string)raw;
        }

        [Safe]
        public static string[] GetAllMiniAppIds()
        {
            int count = (int)GetMiniAppCount();
            string[] appIds = new string[count];
            for (int index = 0; index < count; index++)
            {
                appIds[index] = GetMiniAppIdByIndex(index);
            }
            return appIds;
        }

        [Safe]
        public static string[] GetAllSystemModuleIds()
        {
            int count = (int)GetSystemModuleCount();
            string[] moduleIds = new string[count];
            for (int index = 0; index < count; index++)
            {
                moduleIds[index] = GetSystemModuleIdByIndex(index);
            }
            return moduleIds;
        }

        [Safe]
        public static MiniAppRecord GetMiniApp(string appId)
        {
            ValidateIdentifier(appId, MAX_APP_ID_LENGTH, "invalid app id");
            ByteString raw = AppMap().Get(appId);
            if (raw == null)
            {
                return EmptyMiniApp(appId);
            }

            return (MiniAppRecord)StdLib.Deserialize(raw);
        }

        [Safe]
        public static SystemModuleRecord GetSystemModule(string moduleId)
        {
            ValidateIdentifier(moduleId, MAX_MODULE_ID_LENGTH, "invalid module id");
            ByteString raw = ModuleMap().Get(moduleId);
            if (raw == null)
            {
                return EmptySystemModule(moduleId);
            }

            return (SystemModuleRecord)StdLib.Deserialize(raw);
        }

        [Safe]
        public static bool IsModuleGrantedToMiniApp(string appId, string moduleId)
        {
            ValidateIdentifier(appId, MAX_APP_ID_LENGTH, "invalid app id");
            ValidateIdentifier(moduleId, MAX_MODULE_ID_LENGTH, "invalid module id");
            return AppModuleGrantMap().Get(BuildGrantKey(appId, moduleId)) != null;
        }

        [Safe]
        public static BigInteger GetMiniAppRequestCount(string appId)
        {
            ValidateIdentifier(appId, MAX_APP_ID_LENGTH, "invalid app id");
            ByteString raw = AppRequestsMap().Get(appId);
            return raw == null ? 0 : (BigInteger)raw;
        }

        [Safe]
        public static BigInteger GetMiniAppFulfilledCount(string appId)
        {
            ValidateIdentifier(appId, MAX_APP_ID_LENGTH, "invalid app id");
            ByteString raw = AppFulfilledMap().Get(appId);
            return raw == null ? 0 : (BigInteger)raw;
        }

        [Safe]
        public static BigInteger GetTotalRequests()
        {
            ByteString raw = Storage.Get(Storage.CurrentContext, PREFIX_TOTAL_REQUESTS);
            return raw == null ? 0 : (BigInteger)raw;
        }

        [Safe]
        public static BigInteger GetTotalFulfilled()
        {
            ByteString raw = Storage.Get(Storage.CurrentContext, PREFIX_TOTAL_FULFILLED);
            return raw == null ? 0 : (BigInteger)raw;
        }

        [Safe]
        public static bool IsIndexRebuildRequired()
        {
            return Storage.Get(Storage.CurrentContext, PREFIX_INDEX_REBUILD_REQUIRED) != null;
        }

        [Safe]
        public static BigInteger IndexRebuildCursor()
        {
            ByteString raw = Storage.Get(Storage.CurrentContext, PREFIX_INDEX_REBUILD_CURSOR);
            return raw == null ? 0 : (BigInteger)raw;
        }

        [Safe]
        public static KernelRequest GetRequest(BigInteger requestId)
        {
            ByteString raw = RequestMap().Get(requestId.ToByteArray());
            if (raw == null)
            {
                return new KernelRequest
                {
                    Id = 0,
                    AppId = "",
                    ModuleId = "",
                    Operation = "",
                    Payload = (ByteString)"",
                    Requester = null,
                    Sponsor = null,
                    CallbackContract = null,
                    Status = KernelRequestStatus.Pending,
                    CreatedAt = 0,
                    FulfilledAt = 0,
                    Success = false,
                    Result = (ByteString)"",
                    Error = "",
                    FeePaid = 0
                };
            }

            return (KernelRequest)StdLib.Deserialize(raw);
        }

        [Safe]
        public static InboxItem GetInboxItem(string appId, BigInteger requestId)
        {
            ValidateIdentifier(appId, MAX_APP_ID_LENGTH, "invalid app id");
            ByteString raw = AppInboxMap().Get(BuildInboxKey(appId, requestId));
            if (raw == null)
            {
                return new InboxItem
                {
                    AppId = appId,
                    RequestId = requestId,
                    ModuleId = "",
                    Operation = "",
                    Requester = null,
                    Success = false,
                    Result = (ByteString)"",
                    Error = "",
                    DeliveredAt = 0
                };
            }

            return (InboxItem)StdLib.Deserialize(raw);
        }

        [Safe]
        public static ByteString GetMiniAppState(string appId, ByteString stateKey)
        {
            ValidateIdentifier(appId, MAX_APP_ID_LENGTH, "invalid app id");
            ValidateStateKey(stateKey);
            ByteString raw = AppStateMap().Get(BuildStateKey(appId, stateKey));
            return raw == null ? (ByteString)"" : raw;
        }

        /// <summary>
        /// True once the app admin gated sponsorship (any allowlist entry or spend cap, or
        /// SetSponsorshipOpen(appId, false)). See IsSponsorshipOpen / DefaultSponsoredRequesterCap.
        /// </summary>
        [Safe]
        public static bool IsSponsorshipGated(string appId)
        {
            ValidateIdentifier(appId, MAX_APP_ID_LENGTH, "invalid app id");
            return SponsorshipMode(appId) == SPONSOR_MODE_GATED;
        }

        /// <summary>
        /// True when the given requester is on the app's sponsorship allowlist (its requests are
        /// charged to the app fee payer unconditionally while gating is enabled).
        /// </summary>
        [Safe]
        public static bool IsSponsoredRequesterAllowed(string appId, UInt160 requester)
        {
            ValidateIdentifier(appId, MAX_APP_ID_LENGTH, "invalid app id");
            if (requester == null || !requester.IsValid) return false;
            return SponsorAllowedMap().Get(BuildRequesterKey(appId, requester)) != null;
        }

        /// <summary>
        /// The per-app per-requester sponsored spend cap. 0 means no cap is configured.
        /// </summary>
        [Safe]
        public static BigInteger GetSponsoredRequesterCap(string appId, UInt160 requester)
        {
            ValidateIdentifier(appId, MAX_APP_ID_LENGTH, "invalid app id");
            if (requester == null || !requester.IsValid) return 0;
            ByteString raw = SponsorCapMap().Get(BuildRequesterKey(appId, requester));
            return raw == null ? 0 : (BigInteger)raw;
        }

        /// <summary>
        /// The cumulative fees the app fee payer has already sponsored for the given requester.
        /// </summary>
        [Safe]
        public static BigInteger GetSponsoredRequesterSpent(string appId, UInt160 requester)
        {
            ValidateIdentifier(appId, MAX_APP_ID_LENGTH, "invalid app id");
            if (requester == null || !requester.IsValid) return 0;
            ByteString raw = SponsorSpentMap().Get(BuildRequesterKey(appId, requester));
            return raw == null ? 0 : (BigInteger)raw;
        }

        // ---- platform admin rotation (24h timelock, PlatformRegistry pattern) ----

        /// <summary>
        /// Propose a new platform admin. The change becomes executable
        /// after TIMELOCK_DELAY_MS. Only the current admin may propose.
        /// </summary>
        public static void ProposeAdmin(UInt160 newAdmin)
        {
            ValidateAdmin();
            ExecutionEngine.Assert(newAdmin != null && newAdmin.IsValid, "invalid admin");
            ExecutionEngine.Assert(newAdmin != Admin(), "same admin");

            BigInteger executeAfter = Runtime.Time + TIMELOCK_DELAY_MS;
            Storage.Put(Storage.CurrentContext, PREFIX_PENDING_ADMIN, newAdmin);
            Storage.Put(Storage.CurrentContext, PREFIX_PENDING_ADMIN_TIME, executeAfter);
            OnAdminTimelockProposed(newAdmin, executeAfter);
        }

        /// <summary>
        /// Execute a pending admin change after the timelock expires.
        /// Permissionless by design: the proposal itself is admin-signed, so
        /// anyone may finalize it once mature.
        /// </summary>
        public static void ExecuteAdminChange()
        {
            ByteString pending = Storage.Get(Storage.CurrentContext, PREFIX_PENDING_ADMIN);
            ExecutionEngine.Assert(pending != null, "no pending admin");

            BigInteger changeTime = (BigInteger)Storage.Get(Storage.CurrentContext, PREFIX_PENDING_ADMIN_TIME);
            ExecutionEngine.Assert(Runtime.Time >= changeTime, "timelock active");

            UInt160 oldAdmin = Admin();
            UInt160 newAdmin = (UInt160)pending;
            Storage.Put(Storage.CurrentContext, PREFIX_ADMIN, newAdmin);
            Storage.Delete(Storage.CurrentContext, PREFIX_PENDING_ADMIN);
            Storage.Delete(Storage.CurrentContext, PREFIX_PENDING_ADMIN_TIME);

            OnAdminChanged(oldAdmin, newAdmin);
        }

        /// <summary>Cancel a pending admin change. Only the current admin may cancel.</summary>
        public static void CancelAdminChange()
        {
            ValidateAdmin();
            Storage.Delete(Storage.CurrentContext, PREFIX_PENDING_ADMIN);
            Storage.Delete(Storage.CurrentContext, PREFIX_PENDING_ADMIN_TIME);
        }

        public static void SetUpdater(UInt160 updater)
        {
            ValidateAdmin();
            ExecutionEngine.Assert(updater != null && updater.IsValid, "invalid updater");

            UInt160 oldUpdater = Updater();
            Storage.Put(Storage.CurrentContext, PREFIX_UPDATER, updater);
            OnUpdaterChanged(oldUpdater, updater);
        }

        // ---- verification/encryption key re-pointing (24h timelock) ----
        // A stolen or malicious admin key must not be able to redirect oracle
        // request verification to its own key in one transaction: the change is
        // proposed now and only becomes executable after TIMELOCK_DELAY_MS,
        // giving watchers a window to pause off-chain consumers or rotate.

        /// <summary>Propose re-pointing the runtime encryption key.</summary>
        public static void ProposeRuntimeEncryptionKey(string algorithm, string publicKey)
        {
            ValidateAdmin();
            ExecutionEngine.Assert(algorithm != null && algorithm.Length > 0, "algorithm required");
            ExecutionEngine.Assert(publicKey != null && publicKey.Length > 0, "public key required");
            ExecutionEngine.Assert(algorithm.Length <= MAX_RUNTIME_KEY_ALGO_LENGTH, "algorithm too long");
            ExecutionEngine.Assert(publicKey.Length <= MAX_RUNTIME_KEY_LENGTH, "public key too long");

            PendingRuntimeKeyChange pending = new PendingRuntimeKeyChange
            {
                Algorithm = algorithm,
                Key = publicKey,
                Eta = Runtime.Time + TIMELOCK_DELAY_MS
            };
            Storage.Put(Storage.CurrentContext, PREFIX_PENDING_RUNTIME_KEY, StdLib.Serialize(pending));
            OnSecurityKeyChangeProposed("runtime-encryption-key", pending.Eta);
        }

        /// <summary>Execute a matured runtime encryption key re-pointing.</summary>
        public static void ExecuteRuntimeEncryptionKey()
        {
            ByteString raw = Storage.Get(Storage.CurrentContext, PREFIX_PENDING_RUNTIME_KEY);
            ExecutionEngine.Assert(raw != null, "no pending key change");
            PendingRuntimeKeyChange pending = (PendingRuntimeKeyChange)StdLib.Deserialize(raw);
            ExecutionEngine.Assert(Runtime.Time >= pending.Eta, "timelock active");

            BigInteger version = RuntimeEncryptionKeyVersion() + 1;
            Storage.Put(Storage.CurrentContext, PREFIX_RUNTIME_KEY_ALGO, pending.Algorithm);
            Storage.Put(Storage.CurrentContext, PREFIX_RUNTIME_KEY, pending.Key);
            Storage.Put(Storage.CurrentContext, PREFIX_RUNTIME_KEY_VERSION, version);
            Storage.Delete(Storage.CurrentContext, PREFIX_PENDING_RUNTIME_KEY);
            OnRuntimeEncryptionKeyUpdated(version, pending.Algorithm, pending.Key);
        }

        public static void CancelRuntimeEncryptionKey()
        {
            ValidateAdmin();
            Storage.Delete(Storage.CurrentContext, PREFIX_PENDING_RUNTIME_KEY);
        }

        [Safe]
        public static BigInteger PendingRuntimeEncryptionKeyEta()
        {
            ByteString raw = Storage.Get(Storage.CurrentContext, PREFIX_PENDING_RUNTIME_KEY);
            if (raw == null) return 0;
            return ((PendingRuntimeKeyChange)StdLib.Deserialize(raw)).Eta;
        }

        /// <summary>Propose re-pointing the runtime verification (verifier) key.</summary>
        public static void ProposeRuntimeVerificationPublicKey(ECPoint publicKey)
        {
            ValidateAdmin();
            ExecutionEngine.Assert(publicKey != null && publicKey.IsValid, "invalid verifier");

            PendingRuntimeVerifierChange pending = new PendingRuntimeVerifierChange
            {
                Verifier = publicKey,
                Eta = Runtime.Time + TIMELOCK_DELAY_MS
            };
            Storage.Put(Storage.CurrentContext, PREFIX_PENDING_RUNTIME_VERIFIER, StdLib.Serialize(pending));
            OnSecurityKeyChangeProposed("runtime-verification-key", pending.Eta);
        }

        /// <summary>Execute a matured runtime verification key re-pointing.</summary>
        public static void ExecuteRuntimeVerificationPublicKey()
        {
            ByteString raw = Storage.Get(Storage.CurrentContext, PREFIX_PENDING_RUNTIME_VERIFIER);
            ExecutionEngine.Assert(raw != null, "no pending verifier change");
            PendingRuntimeVerifierChange pending = (PendingRuntimeVerifierChange)StdLib.Deserialize(raw);
            ExecutionEngine.Assert(Runtime.Time >= pending.Eta, "timelock active");

            ECPoint oldVerifier = RuntimeVerificationPublicKey();
            ECPoint newVerifier = (ECPoint)pending.Verifier;
            Storage.Put(Storage.CurrentContext, PREFIX_RUNTIME_VERIFIER, pending.Verifier);
            Storage.Delete(Storage.CurrentContext, PREFIX_PENDING_RUNTIME_VERIFIER);
            OnRuntimeVerifierUpdated(oldVerifier, newVerifier);
        }

        public static void CancelRuntimeVerificationPublicKey()
        {
            ValidateAdmin();
            Storage.Delete(Storage.CurrentContext, PREFIX_PENDING_RUNTIME_VERIFIER);
        }

        [Safe]
        public static BigInteger PendingRuntimeVerificationKeyEta()
        {
            ByteString raw = Storage.Get(Storage.CurrentContext, PREFIX_PENDING_RUNTIME_VERIFIER);
            if (raw == null) return 0;
            return ((PendingRuntimeVerifierChange)StdLib.Deserialize(raw)).Eta;
        }

        /// <summary>Alias kept for deploy tooling: propose (not set) the oracle encryption key.</summary>
        public static void SetOracleEncryptionKey(string algorithm, string publicKey)
        {
            ProposeRuntimeEncryptionKey(algorithm, publicKey);
        }

        /// <summary>Alias kept for deploy tooling: propose (not set) the oracle verification key.</summary>
        public static void SetOracleVerificationPublicKey(ECPoint publicKey)
        {
            ProposeRuntimeVerificationPublicKey(publicKey);
        }

        public static void SetRequestFee(BigInteger amount)
        {
            ValidateAdmin();
            ExecutionEngine.Assert(amount > 0, "invalid request fee");

            BigInteger oldFee = SystemRequestFee();
            Storage.Put(Storage.CurrentContext, PREFIX_REQUEST_FEE, amount);
            OnRequestFeeUpdated(oldFee, amount);
        }

        public static void WithdrawAccruedFees(UInt160 to, BigInteger amount)
        {
            ValidateAdmin();
            ExecutionEngine.Assert(to != null && to.IsValid, "invalid recipient");
            ExecutionEngine.Assert(amount > 0, "invalid amount");

            BigInteger accrued = AccruedRequestFees();
            // Audit fix: only the surplus over the reserved (pending-request-backing) pool is
            // withdrawable. This prevents the admin from draining fees that back pending requests,
            // which would otherwise shrink their expiry refunds (the old clamp). Reserved fees
            // become withdrawable automatically once their requests are fulfilled.
            BigInteger reserved = ReservedRequestFees();
            BigInteger free = accrued - reserved;
            ExecutionEngine.Assert(free >= amount, "amount exceeds withdrawable (unreserved) fees");
            ExecutionEngine.Assert(
                GAS.Transfer(Runtime.ExecutingScriptHash, to, amount, null),
                "fee transfer failed"
            );

            Storage.Put(Storage.CurrentContext, PREFIX_ACCRUED_REQUEST_FEES, accrued - amount);
            OnAccruedFeesWithdrawn(to, amount);
        }

        /// <summary>
        /// Configure the request TTL (in milliseconds).  Only the admin can change this.
        /// </summary>
        public static void SetRequestTTL(BigInteger ttlMs)
        {
            ValidateAdmin();
            ExecutionEngine.Assert(ttlMs > 0, "TTL must be positive");

            BigInteger oldTTL = RequestTTL();
            Storage.Put(Storage.CurrentContext, PREFIX_REQUEST_TTL, ttlMs);
            OnRequestTTLUpdated(oldTTL, ttlMs);
        }

        /// <summary>
        /// Expire a stale pending request that has exceeded the configurable TTL.
        /// When a request is expired:
        ///   1. Its status is set to Failed with an expiry error message
        ///   2. The fee credit that was consumed at submission time is refunded
        ///      to the original sponsor (the account that paid)
        ///   3. A RequestExpired event is emitted for off-chain tracking
        ///
        /// Security rationale: prevents fee credits from being locked forever if
        /// the TEE worker or relayer fails to fulfill a request.  The admin,
        /// updater, or an automation service can call this periodically.
        /// </summary>
        public static void ExpireStaleRequest(BigInteger requestId)
        {
            // Only admin or updater may expire requests to prevent griefing
            UInt160 admin = Admin();
            UInt160 updater = Updater();
            bool isAdmin = admin != null && admin.IsValid && Runtime.CheckWitness(admin);
            bool isUpdater = updater != null && updater.IsValid && Runtime.CheckWitness(updater);
            ExecutionEngine.Assert(isAdmin || isUpdater, "unauthorized");

            KernelRequest req = GetRequest(requestId);
            ExecutionEngine.Assert(req.Id > 0, "request not found");
            ExecutionEngine.Assert(req.Status == KernelRequestStatus.Pending, "request not pending");

            // Check that the request has exceeded the configured TTL
            BigInteger ttl = RequestTTL();
            BigInteger age = Runtime.Time - req.CreatedAt;
            ExecutionEngine.Assert(age > ttl, "request has not expired");

            // Mark the request as failed with an expiry error
            req.Status = KernelRequestStatus.Failed;
            req.FulfilledAt = Runtime.Time;
            req.Success = false;
            req.Error = "request expired: TTL exceeded";
            RequestMap().Put(requestId.ToByteArray(), StdLib.Serialize(req));

            // NOTE: expiry is NOT a fulfillment.  We deliberately do not call
            // IncrementTotalFulfilled()/IncrementMiniAppFulfilled() here so the
            // fulfillment SLA metrics are not inflated by stale, never-answered
            // requests.  The RequestExpired event below provides off-chain
            // accounting for expiries.

            // Refund the exact fee that was debited from the sponsor at
            // submission time.  Using the live SystemRequestFee() here would be
            // incorrect: the admin may have changed the fee via SetRequestFee
            // between submission and expiry, so the current fee can differ from
            // what was actually paid and charged into the accrued pool.
            BigInteger refund = 0;
            if (req.Sponsor != null && req.Sponsor.IsValid && req.FeePaid > 0)
            {
                // Clamp the refund to the fees still held in the accrued pool and
                // adjust the sponsor credit and the accrued pool by the SAME
                // amount.  This keeps the two ledgers symmetric so outstanding
                // fee-credit liabilities can never exceed the GAS the contract
                // actually holds.  In normal operation this request's fee is
                // still accrued (accrued >= FeePaid) and the sponsor is made
                // whole; the clamp only reduces the refund when the accrued pool
                // was already drained via WithdrawAccruedFees.
                BigInteger accrued = AccruedRequestFees();
                refund = accrued < req.FeePaid ? accrued : req.FeePaid;

                if (refund > 0)
                {
                    BigInteger currentCredit = FeeCreditOf(req.Sponsor);
                    RequestCreditMap().Put((byte[])req.Sponsor, currentCredit + refund);
                    Storage.Put(Storage.CurrentContext, PREFIX_ACCRUED_REQUEST_FEES, accrued - refund);
                }
            }

            // Reverse the sponsored spend recorded against the requester's per-app cap at
            // submission time. The request expired unfulfilled, so the sponsor never
            // actually spent this budget; leaving it recorded would silently exhaust a
            // capped requester's sponsorship (IsRequesterSponsorable) despite the refund
            // above, forcing it to self-pay. Mirrors the submit-side condition
            // (sponsor != requester) and releases the full recorded FeePaid — the cap is a
            // budget ledger, independent of the GAS accrued-pool clamp used for the refund.
            if (req.Sponsor != null && req.Sponsor.IsValid && req.Sponsor != req.Requester && req.FeePaid > 0)
            {
                ReleaseSponsoredSpend(req.AppId, req.Requester, req.FeePaid);
            }

            // The request has left the pending state, so release its reserved fee regardless of
            // whether a refund was paid (no valid sponsor => the fee simply becomes earned surplus).
            // With the reserve invariant (accrued >= reserved) the refund above is always the full
            // FeePaid, so accrued and reserved stay symmetric after both decrements.
            ReleaseReservedFee(req.FeePaid);

            // Store a canonical InboxItem exactly as FulfillRequest does so inbox-only consumers
            // (which never watch events) observe this terminal state. Without it an expired
            // request leaves the inbox empty forever and an inbox poller waits indefinitely.
            // The item carries Success=false and the same documented expiry error recorded on the
            // request, with an empty result, mirroring the failed-fulfillment shape.
            InboxItem inbox = new InboxItem
            {
                AppId = req.AppId,
                RequestId = requestId,
                ModuleId = req.ModuleId,
                Operation = req.Operation,
                Requester = req.Requester,
                Success = false,
                Result = (ByteString)"",
                Error = req.Error,
                DeliveredAt = Runtime.Time
            };

            AppInboxMap().Put(BuildInboxKey(req.AppId, requestId), StdLib.Serialize(inbox));
            OnMiniAppInboxStored(req.AppId, requestId, req.Requester, false);

            OnRequestExpired(requestId, req.AppId, req.Requester, req.Sponsor, refund);
            OnMiniAppRequestCompleted(
                requestId,
                req.AppId,
                req.ModuleId,
                req.Operation,
                false,
                ComputeResultHash((ByteString)""),
                0,
                req.Error
            );
        }

        public static void RegisterSystemModule(string moduleId, string endpoint, string schemaHash)
        {
            ValidateAdmin();
            ValidateModuleDefinition(moduleId, endpoint, schemaHash);

            SystemModuleRecord existing = GetSystemModule(moduleId);
            ExecutionEngine.Assert(existing.CreatedAt == 0, "module already exists");
            PutSystemModule(moduleId, endpoint, schemaHash, true, Runtime.Time);
            OnSystemModuleRegistered(moduleId, endpoint, schemaHash);
        }

        public static void ConfigureSystemModule(string moduleId, string endpoint, string schemaHash, bool active)
        {
            ValidateAdmin();
            ValidateModuleDefinition(moduleId, endpoint, schemaHash);

            SystemModuleRecord existing = GetSystemModule(moduleId);
            ExecutionEngine.Assert(existing.CreatedAt > 0, "module not found");
            PutSystemModule(moduleId, endpoint, schemaHash, active, existing.CreatedAt);
            OnSystemModuleUpdated(moduleId, endpoint, schemaHash, active);
        }

        public static void RegisterMiniApp(string appId, UInt160 appAdmin, UInt160 feePayer, UInt160 callbackContract, string metadataUri, string metadataHash)
        {
            ValidateMiniAppDefinition(appId, appAdmin, feePayer, callbackContract, metadataUri, metadataHash);
            ExecutionEngine.Assert(Runtime.CheckWitness(appAdmin) || Runtime.CheckWitness(Admin()), "unauthorized");
            ValidateFeePayerAuthorization(appAdmin, feePayer);

            MiniAppRecord existing = GetMiniApp(appId);
            ExecutionEngine.Assert(existing.CreatedAt == 0, "miniapp already exists");

            PutMiniApp(appId, appAdmin, feePayer, callbackContract, metadataUri, metadataHash, true, Runtime.Time);
            OnMiniAppRegistered(appId, appAdmin, feePayer, callbackContract);
        }

        public static void ConfigureMiniApp(string appId, UInt160 feePayer, UInt160 callbackContract, string metadataUri, string metadataHash, bool active)
        {
            MiniAppRecord app = RequireMiniApp(appId);
            ValidateMiniAppAdmin(app);
            ValidateMiniAppDefinition(appId, app.Admin, feePayer, callbackContract, metadataUri, metadataHash);
            ValidateFeePayerAuthorization(app.Admin, feePayer);

            PutMiniApp(appId, app.Admin, feePayer, callbackContract, metadataUri, metadataHash, active, app.CreatedAt);
            OnMiniAppUpdated(appId, app.Admin, feePayer, callbackContract, active);
        }

        /// <summary>
        /// Allow or disallow an individual requester from drawing on the app fee payer's prepaid
        /// credit. Gated by the app admin (or the system admin). The FIRST time any sponsorship
        /// control is configured for an app (an allowlist entry set to true, or a non-zero spend
        /// cap) the app flips into "gated" mode: from then on the fee payer sponsors ONLY
        /// allowlisted or under-cap requesters and everyone else pays their own fee. This closes
        /// the sponsored-fee drain where any requester could spam a sponsored app to burn the
        /// sponsor's credit. Apps that never configure a control keep the legacy
        /// sponsor-everyone behavior, so this change is backward compatible.
        /// </summary>
        public static void SetSponsoredRequesterAllowed(string appId, UInt160 requester, bool allowed)
        {
            MiniAppRecord app = RequireMiniApp(appId);
            ValidateMiniAppAdmin(app);
            ExecutionEngine.Assert(requester != null && requester.IsValid, "invalid requester");

            byte[] key = BuildRequesterKey(appId, requester);
            if (allowed)
            {
                SponsorAllowedMap().Put(key, 1);
                EnableSponsorshipGating(appId);
            }
            else
            {
                SponsorAllowedMap().Delete(key);
            }

            OnSponsoredRequesterAllowed(appId, requester, allowed);
        }

        /// <summary>
        /// Configure (or clear, with cap == 0) the total fees the app fee payer will sponsor for a
        /// single requester. While gating is enabled a non-allowlisted requester is sponsored only
        /// while its cumulative sponsored spend stays at or below this cap; once exhausted it pays
        /// its own fee. Setting a non-zero cap enables gating for the app. Gated by the app admin.
        /// </summary>
        public static void SetSponsoredRequesterCap(string appId, UInt160 requester, BigInteger cap)
        {
            MiniAppRecord app = RequireMiniApp(appId);
            ValidateMiniAppAdmin(app);
            ExecutionEngine.Assert(requester != null && requester.IsValid, "invalid requester");
            ExecutionEngine.Assert(cap >= 0, "invalid cap");

            byte[] key = BuildRequesterKey(appId, requester);
            if (cap > 0)
            {
                SponsorCapMap().Put(key, cap);
                EnableSponsorshipGating(appId);
            }
            else
            {
                SponsorCapMap().Delete(key);
            }

            OnSponsoredRequesterCapUpdated(appId, requester, cap);
        }

        public static void GrantModuleToMiniApp(string appId, string moduleId)
        {
            MiniAppRecord app = RequireMiniApp(appId);
            SystemModuleRecord module = RequireActiveModule(moduleId);
            ValidateMiniAppAdmin(app);

            AppModuleGrantMap().Put(BuildGrantKey(appId, module.ModuleId), 1);
            OnMiniAppCapabilityGranted(appId, module.ModuleId);
        }

        public static void RevokeModuleFromMiniApp(string appId, string moduleId)
        {
            MiniAppRecord app = RequireMiniApp(appId);
            ValidateIdentifier(moduleId, MAX_MODULE_ID_LENGTH, "invalid module id");
            ValidateMiniAppAdmin(app);

            AppModuleGrantMap().Delete(BuildGrantKey(appId, moduleId));
            OnMiniAppCapabilityRevoked(appId, moduleId);
        }

        public static void PutMiniAppState(string appId, ByteString stateKey, ByteString value)
        {
            MiniAppRecord app = RequireMiniApp(appId);
            ValidateMiniAppAdminOrUpdater(app);
            ValidateStateKey(stateKey);
            ExecutionEngine.Assert(value != null && value.Length <= MAX_STATE_VALUE_LENGTH, "invalid state value");

            AppStateMap().Put(BuildStateKey(appId, stateKey), value);
            OnMiniAppStateChanged(appId, stateKey, value.Length);
        }

        public static void PutMiniAppStateBatch(string appId, ByteString[] stateKeys, ByteString[] values)
        {
            MiniAppRecord app = RequireMiniApp(appId);
            ValidateMiniAppAdminOrUpdater(app);
            ExecutionEngine.Assert(stateKeys != null && stateKeys.Length > 0, "state keys required");
            ExecutionEngine.Assert(values != null && values.Length == stateKeys.Length, "state length mismatch");

            for (int index = 0; index < stateKeys.Length; index++)
            {
                ValidateStateKey(stateKeys[index]);
                ExecutionEngine.Assert(values[index] != null && values[index].Length <= MAX_STATE_VALUE_LENGTH, "invalid state value");
                AppStateMap().Put(BuildStateKey(appId, stateKeys[index]), values[index]);
                OnMiniAppStateChanged(appId, stateKeys[index], values[index].Length);
            }
        }

        public static void DeleteMiniAppState(string appId, ByteString stateKey)
        {
            MiniAppRecord app = RequireMiniApp(appId);
            ValidateMiniAppAdminOrUpdater(app);
            ValidateStateKey(stateKey);

            AppStateMap().Delete(BuildStateKey(appId, stateKey));
            OnMiniAppStateChanged(appId, stateKey, 0);
        }

        public static BigInteger SubmitMiniAppRequest(string appId, string moduleId, string operation, ByteString payload)
        {
            UInt160 requester = Runtime.Transaction.Sender;
            ExecutionEngine.Assert(requester != null && requester.IsValid, "requester required");
            ExecutionEngine.Assert(Runtime.CheckWitness(requester), "unauthorized requester");

            return SubmitMiniAppRequestInternal(requester, appId, moduleId, operation, payload);
        }

        public static BigInteger SubmitMiniAppRequestFromIntegration(UInt160 requester, string appId, string moduleId, string operation, ByteString payload)
        {
            ExecutionEngine.Assert(requester != null && requester.IsValid, "requester required");

            MiniAppRecord app = RequireActiveMiniApp(appId);
            ExecutionEngine.Assert(app.CallbackContract != null && app.CallbackContract.IsValid, "integration contract not set");
            ExecutionEngine.Assert(Runtime.CallingScriptHash == app.CallbackContract, "only integration contract");

            return SubmitMiniAppRequestInternal(requester, appId, moduleId, operation, payload);
        }

        // Legacy alias kept for compatibility with callback-contract mediated flows.
        public static BigInteger RequestFromCallback(UInt160 requester, string requestType, ByteString payload, UInt160 callbackContract, string callbackMethod)
        {
            ExecutionEngine.Assert(callbackMethod == CALLBACK_METHOD || callbackMethod == LEGACY_CALLBACK_METHOD, "unsupported callback method");

            MiniAppRecord app = FindMiniAppByCallback(callbackContract);
            ExecutionEngine.Assert(app.CreatedAt > 0, "miniapp not found for callback");
            string moduleId = ResolveLegacyModuleId(requestType);
            return SubmitMiniAppRequestFromIntegration(requester, app.AppId, moduleId, requestType, payload);
        }

        public static BigInteger QueueSystemRequest(UInt160 requester, string appId, string moduleId, string operation, ByteString payload)
        {
            ValidateUpdater();
            ExecutionEngine.Assert(requester != null && requester.IsValid, "requester required");
            return SubmitMiniAppRequestInternal(requester, appId, moduleId, operation, payload);
        }

        // Legacy alias kept for automation pipelines that still target the old method name.
        public static BigInteger QueueAutomationRequest(UInt160 requester, string requestType, ByteString payload, UInt160 callbackContract, string callbackMethod)
        {
            ExecutionEngine.Assert(callbackMethod == CALLBACK_METHOD || callbackMethod == LEGACY_CALLBACK_METHOD, "unsupported callback method");

            MiniAppRecord app = FindMiniAppByCallback(callbackContract);
            ExecutionEngine.Assert(app.CreatedAt > 0, "miniapp not found for callback");
            string moduleId = ResolveLegacyModuleId(requestType);
            return QueueSystemRequest(requester, app.AppId, moduleId, requestType, payload);
        }

        // Legacy alias kept so existing direct request scripts keep working during migration.
        public static BigInteger Request(string requestType, ByteString payload, UInt160 callbackContract, string callbackMethod)
        {
            ExecutionEngine.Assert(callbackMethod == CALLBACK_METHOD || callbackMethod == LEGACY_CALLBACK_METHOD, "unsupported callback method");

            MiniAppRecord app = FindMiniAppByCallback(callbackContract);
            ExecutionEngine.Assert(app.CreatedAt > 0, "miniapp not found for callback");
            string moduleId = ResolveLegacyModuleId(requestType);
            return SubmitMiniAppRequest(app.AppId, moduleId, requestType, payload);
        }

        public static void OnNEP17Payment(UInt160 from, BigInteger amount, object data)
        {
            ExecutionEngine.Assert(Runtime.CallingScriptHash == GAS.Hash, "only GAS accepted");
            ExecutionEngine.Assert(from != null && from.IsValid, "invalid sender");
            ExecutionEngine.Assert(amount > 0, "invalid amount");

            UInt160 beneficiary = ResolveCreditBeneficiary(from, data);
            BigInteger nextCredit = FeeCreditOf(beneficiary) + amount;
            RequestCreditMap().Put((byte[])beneficiary, nextCredit);
            OnRequestFeeDeposited(beneficiary, amount, nextCredit);
        }

        public static void FulfillRequest(BigInteger requestId, bool success, ByteString result, string error, ByteString verificationSignature)
        {
            ValidateUpdater();

            KernelRequest req = GetRequest(requestId);
            ExecutionEngine.Assert(req.Id > 0, "request not found");
            ExecutionEngine.Assert(req.Status == KernelRequestStatus.Pending, "request already fulfilled");
            ExecutionEngine.Assert(result == null || result.Length <= MAX_RESULT_LENGTH, "result too large");
            ExecutionEngine.Assert(error == null || error.Length <= MAX_ERROR_LENGTH, "error too long");

            ECPoint verifier = RuntimeVerificationPublicKey();
            ExecutionEngine.Assert(verifier != null && verifier.IsValid, "runtime verifier not set");
            ExecutionEngine.Assert(verificationSignature != null && verificationSignature.Length == 64, "invalid verification signature");

            ByteString digest = ComputeFulfillmentDigest(
                requestId,
                req.AppId,
                req.ModuleId,
                req.Operation,
                success,
                result ?? (ByteString)"",
                error ?? ""
            );

            ExecutionEngine.Assert(
                CryptoLib.VerifyWithECDsa(digest, verifier, verificationSignature, NamedCurveHash.secp256r1SHA256),
                "invalid verification signature"
            );

            req.Status = success ? KernelRequestStatus.Succeeded : KernelRequestStatus.Failed;
            req.FulfilledAt = Runtime.Time;
            req.Success = success;
            req.Result = result ?? (ByteString)"";
            req.Error = error ?? "";
            RequestMap().Put(requestId.ToByteArray(), StdLib.Serialize(req));

            // The request is no longer pending/refundable: the oracle has earned the fee, so
            // release it from the reserved pool into the withdrawable surplus.
            ReleaseReservedFee(req.FeePaid);

            IncrementTotalFulfilled();
            IncrementMiniAppFulfilled(req.AppId);

            InboxItem inbox = new InboxItem
            {
                AppId = req.AppId,
                RequestId = requestId,
                ModuleId = req.ModuleId,
                Operation = req.Operation,
                Requester = req.Requester,
                Success = req.Success,
                Result = req.Result,
                Error = req.Error,
                DeliveredAt = Runtime.Time
            };

            AppInboxMap().Put(BuildInboxKey(req.AppId, requestId), StdLib.Serialize(inbox));
            OnMiniAppInboxStored(req.AppId, requestId, req.Requester, req.Success);

            DispatchCallback(requestId, req);

            OnMiniAppRequestCompleted(
                requestId,
                req.AppId,
                req.ModuleId,
                req.Operation,
                req.Success,
                ComputeResultHash(req.Result),
                ComputeResultSize(req.Result),
                req.Error
            );
        }

        // ---- timelocked, hash-pinned self-upgrade (PlatformRegistry pattern) ----

        /// <summary>
        /// Schedule a contract upgrade. The upgrade becomes executable
        /// after TIMELOCK_DELAY_MS and is pinned to sha256(nef ++ manifest),
        /// so the deployed kernel cannot be hot-swapped.
        /// </summary>
        public static void ScheduleUpdate(ByteString nefFile, string manifest)
        {
            ValidateAdmin();
            ExecutionEngine.Assert(
                nefFile != null && nefFile.Length > 0 && manifest != null && manifest.Length > 0,
                "invalid upgrade artifact");
            BigInteger executeAfter = Runtime.Time + TIMELOCK_DELAY_MS;
            Storage.Put(Storage.CurrentContext, PREFIX_UPGRADE_TIME, executeAfter);
            Storage.Put(Storage.CurrentContext, PREFIX_UPGRADE_HASH,
                CryptoLib.Sha256(Helper.Concat(nefFile, (ByteString)manifest)));
            OnUpgradeScheduled(executeAfter);
        }

        /// <summary>
        /// Execute a scheduled upgrade after the timelock expires. The artifact
        /// must match the scheduled sha256(nef ++ manifest) exactly.
        /// </summary>
        public static void Update(ByteString nefFile, string manifest)
        {
            ValidateAdmin();
            ByteString rawTime = Storage.Get(Storage.CurrentContext, PREFIX_UPGRADE_TIME);
            ExecutionEngine.Assert(rawTime != null, "no upgrade scheduled");
            ExecutionEngine.Assert(Runtime.Time >= (BigInteger)rawTime, "timelock active");
            ByteString expected = Storage.Get(Storage.CurrentContext, PREFIX_UPGRADE_HASH);
            ByteString actual = CryptoLib.Sha256(Helper.Concat(nefFile, (ByteString)manifest));
            ExecutionEngine.Assert(expected == actual, "upgrade data mismatch");
            Storage.Delete(Storage.CurrentContext, PREFIX_UPGRADE_TIME);
            Storage.Delete(Storage.CurrentContext, PREFIX_UPGRADE_HASH);
            ContractManagement.Update(nefFile, manifest, null);
            OnContractUpgraded(CryptoLib.Sha256(nefFile), CryptoLib.Sha256((ByteString)manifest));
        }

        /// <summary>Cancel a scheduled upgrade. Only the current admin may cancel.</summary>
        public static void CancelUpdate()
        {
            ValidateAdmin();
            Storage.Delete(Storage.CurrentContext, PREFIX_UPGRADE_TIME);
            Storage.Delete(Storage.CurrentContext, PREFIX_UPGRADE_HASH);
        }

        private static byte[] BuildGrantKey(string appId, string moduleId)
        {
            byte[] grantMaterial = (byte[])Helper.Concat(
                CryptoLib.Sha256((ByteString)(appId ?? "")),
                CryptoLib.Sha256((ByteString)(moduleId ?? ""))
            );
            return (byte[])CryptoLib.Sha256((ByteString)grantMaterial);
        }
    }
}
