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
    public partial class MorpheusOracle : SmartContract
    {
        private static StorageMap AppMap() => new StorageMap(Storage.CurrentContext, PREFIX_APP);
        private static StorageMap AppIndexMap() => new StorageMap(Storage.CurrentContext, PREFIX_APP_INDEX);
        private static StorageMap ModuleMap() => new StorageMap(Storage.CurrentContext, PREFIX_MODULE);
        private static StorageMap ModuleIndexMap() => new StorageMap(Storage.CurrentContext, PREFIX_MODULE_INDEX);
        private static StorageMap AppModuleGrantMap() => new StorageMap(Storage.CurrentContext, PREFIX_APP_MODULE_GRANT);
        private static StorageMap RequestMap() => new StorageMap(Storage.CurrentContext, PREFIX_REQUEST);
        private static StorageMap RequestCreditMap() => new StorageMap(Storage.CurrentContext, PREFIX_REQUEST_CREDIT);
        private static StorageMap AppRequestsMap() => new StorageMap(Storage.CurrentContext, PREFIX_APP_REQUESTS);
        private static StorageMap AppFulfilledMap() => new StorageMap(Storage.CurrentContext, PREFIX_APP_FULFILLED);
        private static StorageMap AppInboxMap() => new StorageMap(Storage.CurrentContext, PREFIX_APP_INBOX);
        private static StorageMap AppStateMap() => new StorageMap(Storage.CurrentContext, PREFIX_APP_STATE);

        private static void ValidateAdmin()
        {
            UInt160 admin = Admin();
            ExecutionEngine.Assert(admin != null && admin.IsValid, "admin not set");
            ExecutionEngine.Assert(Runtime.CheckWitness(admin), "unauthorized");
        }

        private static void ValidateUpdater()
        {
            UInt160 updater = Updater();
            ExecutionEngine.Assert(updater != null && updater.IsValid, "updater not set");
            ExecutionEngine.Assert(Runtime.CheckWitness(updater), "unauthorized");
        }

        private static void ValidateMiniAppAdmin(MiniAppRecord app)
        {
            UInt160 admin = Admin();
            bool isSystemAdmin = admin != null && admin.IsValid && Runtime.CheckWitness(admin);
            bool isMiniAppAdmin = app.Admin != null && app.Admin.IsValid && Runtime.CheckWitness(app.Admin);
            ExecutionEngine.Assert(isSystemAdmin || isMiniAppAdmin, "unauthorized");
        }

        private static void ValidateMiniAppAdminOrUpdater(MiniAppRecord app)
        {
            UInt160 admin = Admin();
            UInt160 updater = Updater();
            bool isSystemAdmin = admin != null && admin.IsValid && Runtime.CheckWitness(admin);
            bool isMiniAppAdmin = app.Admin != null && app.Admin.IsValid && Runtime.CheckWitness(app.Admin);
            bool isUpdater = updater != null && updater.IsValid && Runtime.CheckWitness(updater);
            ExecutionEngine.Assert(isSystemAdmin || isMiniAppAdmin || isUpdater, "unauthorized");
        }

        private static void ValidateIdentifier(string value, int maxLength, string error)
        {
            ExecutionEngine.Assert(value != null && value.Length > 0 && value.Length <= maxLength, error);
        }

        private static void ValidateMetadata(string metadataUri, string metadataHash)
        {
            ExecutionEngine.Assert(metadataUri == null || metadataUri.Length <= MAX_METADATA_URI_LENGTH, "metadata uri too long");
            ExecutionEngine.Assert(metadataHash == null || metadataHash.Length <= MAX_METADATA_HASH_LENGTH, "metadata hash too long");
        }

        private static void ValidateStateKey(ByteString stateKey)
        {
            ExecutionEngine.Assert(stateKey != null && stateKey.Length > 0 && stateKey.Length <= MAX_STATE_KEY_LENGTH, "invalid state key");
        }

        private static void ValidateModuleDefinition(string moduleId, string endpoint, string schemaHash)
        {
            ValidateIdentifier(moduleId, MAX_MODULE_ID_LENGTH, "invalid module id");
            ExecutionEngine.Assert(endpoint != null && endpoint.Length > 0 && endpoint.Length <= MAX_METADATA_URI_LENGTH, "invalid module endpoint");
            ExecutionEngine.Assert(schemaHash != null && schemaHash.Length > 0 && schemaHash.Length <= MAX_METADATA_HASH_LENGTH, "invalid schema hash");
        }

        private static void ValidateMiniAppDefinition(string appId, UInt160 appAdmin, UInt160 feePayer, UInt160 callbackContract, string metadataUri, string metadataHash)
        {
            ValidateIdentifier(appId, MAX_APP_ID_LENGTH, "invalid app id");
            ExecutionEngine.Assert(appAdmin != null && appAdmin.IsValid, "invalid miniapp admin");
            ExecutionEngine.Assert(feePayer != null && feePayer.IsValid, "invalid fee payer");
            if (callbackContract != null)
            {
                ExecutionEngine.Assert(callbackContract.IsValid, "invalid callback contract");
            }

            ValidateMetadata(metadataUri, metadataHash);
        }

        private static void ValidateFeePayerAuthorization(UInt160 appAdmin, UInt160 feePayer)
        {
            if (feePayer == UInt160.Zero) return;
            if (Runtime.CheckWitness(feePayer)) return;

            UInt160 admin = Admin();
            bool adminPaysSelf = admin != null && admin.IsValid && feePayer == admin && Runtime.CheckWitness(admin);
            bool appAdminPaysSelf = appAdmin != null && appAdmin.IsValid && feePayer == appAdmin && Runtime.CheckWitness(appAdmin);
            ExecutionEngine.Assert(adminPaysSelf || appAdminPaysSelf, "fee payer witness required");
        }

        // Returns the already-fetched active MiniAppRecord so the caller can reuse it
        // instead of reading + deserializing the record a second time. RequireActiveMiniApp
        // and RequireActiveModule already assert existence + Active (producing the same
        // "miniapp inactive" / "module inactive" reverts, and earlier), so the trailing
        // app.Active / module.Active asserts were unreachable duplicates and are dropped.
        private static MiniAppRecord ValidateRequestInputs(string appId, string moduleId, string operation, ByteString payload)
        {
            MiniAppRecord app = RequireActiveMiniApp(appId);
            RequireActiveModule(moduleId);
            ExecutionEngine.Assert(operation != null && operation.Length > 0 && operation.Length <= MAX_OPERATION_LENGTH, "invalid operation");
            ExecutionEngine.Assert(payload == null || payload.Length <= MAX_PAYLOAD_LENGTH, "payload too large");
            ExecutionEngine.Assert(IsModuleGrantedToMiniApp(appId, moduleId), "module not granted");
            return app;
        }

        private static MiniAppRecord EmptyMiniApp(string appId)
        {
            return new MiniAppRecord
            {
                AppId = appId ?? "",
                Admin = null,
                FeePayer = null,
                CallbackContract = null,
                MetadataUri = "",
                MetadataHash = "",
                Active = false,
                CreatedAt = 0,
                UpdatedAt = 0
            };
        }

        private static SystemModuleRecord EmptySystemModule(string moduleId)
        {
            return new SystemModuleRecord
            {
                ModuleId = moduleId ?? "",
                Endpoint = "",
                SchemaHash = "",
                Active = false,
                CreatedAt = 0,
                UpdatedAt = 0
            };
        }

        private static MiniAppRecord RequireMiniApp(string appId)
        {
            MiniAppRecord app = GetMiniApp(appId);
            ExecutionEngine.Assert(app.CreatedAt > 0, "miniapp not found");
            return app;
        }

        private static MiniAppRecord RequireActiveMiniApp(string appId)
        {
            MiniAppRecord app = RequireMiniApp(appId);
            ExecutionEngine.Assert(app.Active, "miniapp inactive");
            return app;
        }

        private static SystemModuleRecord RequireActiveModule(string moduleId)
        {
            SystemModuleRecord module = GetSystemModule(moduleId);
            ExecutionEngine.Assert(module.CreatedAt > 0, "module not found");
            ExecutionEngine.Assert(module.Active, "module inactive");
            return module;
        }

        private static void IndexMiniAppIfNeeded(string appId, BigInteger existingCreatedAt)
        {
            if (existingCreatedAt > 0) return;

            BigInteger count = GetMiniAppCount();
            AppIndexMap().Put(count.ToByteArray(), appId);
            Storage.Put(Storage.CurrentContext, PREFIX_APP_COUNT, count + 1);
        }

        private static void IndexSystemModuleIfNeeded(string moduleId, BigInteger existingCreatedAt)
        {
            if (existingCreatedAt > 0) return;

            BigInteger count = GetSystemModuleCount();
            ModuleIndexMap().Put(count.ToByteArray(), moduleId);
            Storage.Put(Storage.CurrentContext, PREFIX_MODULE_COUNT, count + 1);
        }

        private static StorageMap CallbackIndexMap() => new StorageMap(Storage.CurrentContext, PREFIX_CALLBACK_INDEX);
        private static StorageMap AccountRegisteredMap() => new StorageMap(Storage.CurrentContext, PREFIX_ACCOUNT_REGISTERED);
        private static StorageMap SponsorGatedMap() => new StorageMap(Storage.CurrentContext, PREFIX_SPONSOR_GATED);
        private static StorageMap SponsorAllowedMap() => new StorageMap(Storage.CurrentContext, PREFIX_SPONSOR_ALLOWED);
        private static StorageMap SponsorCapMap() => new StorageMap(Storage.CurrentContext, PREFIX_SPONSOR_CAP);
        private static StorageMap SponsorSpentMap() => new StorageMap(Storage.CurrentContext, PREFIX_SPONSOR_SPENT);

        // Flip the app into sponsorship-gated mode. Idempotent: once set, the app sponsors only
        // allowlisted/under-cap requesters. There is intentionally no way to clear the flag back
        // to sponsor-everyone — an admin disables sponsorship by clearing individual entries.
        private static void EnableSponsorshipGating(string appId)
        {
            SponsorGatedMap().Put(appId, 1);
        }

        // Accrue a sponsored fee against the requester's per-app spend ledger so a configured cap
        // is enforced cumulatively across requests.
        private static void RecordSponsoredSpend(string appId, UInt160 requester, BigInteger amount)
        {
            if (amount <= 0 || requester == null || !requester.IsValid) return;
            byte[] key = BuildRequesterKey(appId, requester);
            ByteString raw = SponsorSpentMap().Get(key);
            BigInteger spent = raw == null ? 0 : (BigInteger)raw;
            SponsorSpentMap().Put(key, spent + amount);
        }

        // Reverse a previously-recorded sponsored spend (clamped at 0) when the request
        // it was recorded for never resulted in delivered service — e.g. it expired
        // unfulfilled. Without this, a capped requester whose sponsored requests expire
        // permanently exhausts its per-app budget despite the fee refund and is forced
        // to self-pay. The cap is a budget ledger, independent of the GAS accrued pool,
        // so the full recorded amount is released here.
        private static void ReleaseSponsoredSpend(string appId, UInt160 requester, BigInteger amount)
        {
            if (amount <= 0 || requester == null || !requester.IsValid) return;
            byte[] key = BuildRequesterKey(appId, requester);
            ByteString raw = SponsorSpentMap().Get(key);
            BigInteger spent = raw == null ? 0 : (BigInteger)raw;
            BigInteger next = spent - amount;
            if (next < 0) next = 0;
            SponsorSpentMap().Put(key, next);
        }

        private static void MarkAccountRegistered(UInt160 account)
        {
            if (account != null && account.IsValid && account != UInt160.Zero)
            {
                AccountRegisteredMap().Put((byte[])account, 1);
            }
        }

        private static void PutMiniApp(string appId, UInt160 appAdmin, UInt160 feePayer, UInt160 callbackContract, string metadataUri, string metadataHash, bool active, BigInteger createdAt)
        {
            ExecutionEngine.Assert(!IsIndexRebuildRequired(), "index rebuild required");
            MiniAppRecord prior = GetMiniApp(appId);
            if (prior.CreatedAt == 0)
            {
                IndexMiniAppIfNeeded(appId, prior.CreatedAt);
            }

            // Maintain the callback->appId reverse index. Drop the stale mapping when the
            // callback is cleared or repointed (e.g. via ConfigureMiniApp); skip null callbacks.
            UInt160 priorCallback = prior.CallbackContract;
            if (priorCallback != null && priorCallback.IsValid && priorCallback != callbackContract)
            {
                // Only drop the entry when it actually points at THIS app. Legacy registries
                // (created before the reverse index existed) can hold several records naming
                // the same callback; after RebuildIndexes only the earliest-registered keeps
                // the mapping, and a later duplicate repointing away must not clear it.
                ByteString priorOwner = CallbackIndexMap().Get((byte[])priorCallback);
                if (priorOwner != null && (string)priorOwner == appId)
                {
                    CallbackIndexMap().Delete((byte[])priorCallback);
                }
            }
            if (callbackContract != null && callbackContract.IsValid)
            {
                // Uniqueness: a callback contract may route to at most one miniapp. Without
                // this check any account could register a fresh appId over an existing app's
                // callback and repoint its legacy request routing (last-write-wins takeover /
                // permissionless DoS). Re-registering or reconfiguring the SAME app is allowed.
                ByteString mappedAppId = CallbackIndexMap().Get((byte[])callbackContract);
                if (mappedAppId == null || (string)mappedAppId == appId)
                {
                    CallbackIndexMap().Put((byte[])callbackContract, appId);
                }
                else
                {
                    // Same-operator multi-tenant sharing (neo-miniapps-platform runs many
                    // appIds through ONE PlatformGame callback contract): the new appId may
                    // share the callback only when the app already holding the mapping has
                    // the SAME admin — an operator cannot hijack its own routing, and a
                    // DIFFERENT admin still faults (anti-hijack preserved).
                    MiniAppRecord existing = GetMiniApp((string)mappedAppId);
                    ExecutionEngine.Assert(
                        existing.CreatedAt > 0 && existing.Admin == appAdmin,
                        "callback already registered"
                    );
                    // First-wins: KEEP the existing index entry (do NOT overwrite), preserving
                    // the legacy-lane routing and the RebuildIndexes invariant that the
                    // earliest-registered record keeps the mapping. Per-tenant routing is
                    // unaffected: the rich 8-arg onMiniAppResult dispatch passes appId per
                    // request record, so each tenant's results still carry their own appId.
                }
            }

            // Record admin/fee-payer membership for O(1) directed-deposit authorization.
            MarkAccountRegistered(appAdmin);
            MarkAccountRegistered(feePayer);

            MiniAppRecord app = new MiniAppRecord
            {
                AppId = appId,
                Admin = appAdmin,
                FeePayer = feePayer,
                CallbackContract = callbackContract,
                MetadataUri = metadataUri ?? "",
                MetadataHash = metadataHash ?? "",
                Active = active,
                CreatedAt = createdAt,
                UpdatedAt = Runtime.Time
            };

            AppMap().Put(appId, StdLib.Serialize(app));
        }

        private static void PutSystemModule(string moduleId, string endpoint, string schemaHash, bool active, BigInteger createdAt)
        {
            SystemModuleRecord prior = GetSystemModule(moduleId);
            if (prior.CreatedAt == 0)
            {
                IndexSystemModuleIfNeeded(moduleId, prior.CreatedAt);
            }

            SystemModuleRecord module = new SystemModuleRecord
            {
                ModuleId = moduleId,
                Endpoint = endpoint,
                SchemaHash = schemaHash,
                Active = active,
                CreatedAt = createdAt,
                UpdatedAt = Runtime.Time
            };

            ModuleMap().Put(moduleId, StdLib.Serialize(module));
        }

        private static void SeedBuiltInModule(string moduleId, string endpoint, string schemaHash)
        {
            if (GetSystemModule(moduleId).CreatedAt > 0) return;
            PutSystemModule(moduleId, endpoint, schemaHash, true, Runtime.Time);
            OnSystemModuleRegistered(moduleId, endpoint, schemaHash);
        }

        private static BigInteger NextRequestId()
        {
            ByteString raw = Storage.Get(Storage.CurrentContext, PREFIX_COUNTER);
            BigInteger current = raw == null ? 0 : (BigInteger)raw;
            BigInteger next = current + 1;
            Storage.Put(Storage.CurrentContext, PREFIX_COUNTER, next);
            return next;
        }

        private static void IncrementTotalRequests()
        {
            ByteString raw = Storage.Get(Storage.CurrentContext, PREFIX_TOTAL_REQUESTS);
            BigInteger current = raw == null ? 0 : (BigInteger)raw;
            Storage.Put(Storage.CurrentContext, PREFIX_TOTAL_REQUESTS, current + 1);
        }

        private static void IncrementTotalFulfilled()
        {
            ByteString raw = Storage.Get(Storage.CurrentContext, PREFIX_TOTAL_FULFILLED);
            BigInteger current = raw == null ? 0 : (BigInteger)raw;
            Storage.Put(Storage.CurrentContext, PREFIX_TOTAL_FULFILLED, current + 1);
        }

        private static void IncrementMiniAppRequests(string appId)
        {
            ByteString raw = AppRequestsMap().Get(appId);
            BigInteger current = raw == null ? 0 : (BigInteger)raw;
            AppRequestsMap().Put(appId, current + 1);
        }

        private static void IncrementMiniAppFulfilled(string appId)
        {
            ByteString raw = AppFulfilledMap().Get(appId);
            BigInteger current = raw == null ? 0 : (BigInteger)raw;
            AppFulfilledMap().Put(appId, current + 1);
        }

        // O(1) reverse-index lookup (was an O(n) scan over every registered miniapp, which made
        // every integration-driven request cost more GAS as the registry grew -> DoS). The
        // returned app's callback is re-checked so a stale index entry can never misroute.
        private static MiniAppRecord FindMiniAppByCallback(UInt160 callbackContract)
        {
            if (callbackContract == null || !callbackContract.IsValid)
            {
                return EmptyMiniApp("");
            }

            ByteString appIdRaw = CallbackIndexMap().Get((byte[])callbackContract);
            if (appIdRaw == null)
            {
                return EmptyMiniApp("");
            }

            MiniAppRecord app = GetMiniApp((string)appIdRaw);
            if (app.CreatedAt != 0 && app.CallbackContract != null && app.CallbackContract == callbackContract)
            {
                return app;
            }

            return EmptyMiniApp("");
        }

        // Canonical callback ownership is registration order, matching the legacy
        // O(n) resolver. RebuildIndexes uses this scan to repair an index entry that
        // may have been poisoned before the upgrade migration lock existed.
        private static string FindEarliestMiniAppIdByCallback(UInt160 callbackContract)
        {
            if (callbackContract == null || !callbackContract.IsValid) return "";

            BigInteger total = GetMiniAppCount();
            for (BigInteger i = 0; i < total; i++)
            {
                string appId = GetMiniAppIdByIndex(i);
                MiniAppRecord app = GetMiniApp(appId);
                if (app.CreatedAt > 0
                    && app.CallbackContract != null
                    && app.CallbackContract == callbackContract)
                {
                    return appId;
                }
            }
            return "";
        }

        private static string ResolveLegacyModuleId(string requestType)
        {
            ValidateIdentifier(requestType, MAX_OPERATION_LENGTH, "invalid request type");

            if (requestType == "oracle" || requestType == "privacy_oracle") return "oracle.fetch";
            if (requestType == "compute") return "compute.run";
            if (requestType == "datafeed" || requestType == "pricefeed" || requestType == "feed") return "feed.read";
            if (requestType == "neodid_bind"
                || requestType == "neodid_action_ticket"
                || requestType == "neodid_recovery_ticket")
            {
                return "identity.verify";
            }

            if (requestType == "automation_register"
                || requestType == "automation_cancel"
                || requestType == "automation_execute")
            {
                return "automation.run";
            }

            return requestType;
        }

        private static byte[] BuildInboxKey(string appId, BigInteger requestId)
        {
            return (byte[])Helper.Concat(
                CryptoLib.Sha256((ByteString)(appId ?? "")),
                (ByteString)requestId.ToByteArray()
            );
        }

        private static byte[] BuildStateKey(string appId, ByteString stateKey)
        {
            return (byte[])Helper.Concat(
                CryptoLib.Sha256((ByteString)(appId ?? "")),
                stateKey ?? (ByteString)""
            );
        }

        // Composite key for per-(appId, requester) sponsorship records. Hashes the appId so a
        // fixed-width prefix is followed by the 20-byte account, avoiding any separator collision
        // between distinct (appId, requester) pairs.
        private static byte[] BuildRequesterKey(string appId, UInt160 requester)
        {
            return (byte[])Helper.Concat(
                CryptoLib.Sha256((ByteString)(appId ?? "")),
                (ByteString)requester
            );
        }
    }
}
