using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace MorpheusOracle.Contracts
{
    public delegate void MiniAppResultReceivedHandler(BigInteger requestId, string appId, string moduleId, string operation, bool success, string error);
    public delegate void AdminChangedHandler(UInt160 oldAdmin, UInt160 newAdmin);
    public delegate void KernelChangedHandler(UInt160 oldKernel, UInt160 newKernel);

    /// <summary>
    /// Optional external adapter for advanced integrations that still want a dedicated callback contract.
    /// </summary>
    /// <remarks>
    /// The MiniApp OS inbox is now the canonical callback surface. This contract remains available as
    /// a thin bridge for apps that still need contract-local storage or custom follow-up logic.
    /// </remarks>
    [DisplayName("OracleCallbackConsumer")]
    [ManifestExtra("Author", "Morpheus Oracle")]
    [ManifestExtra("Version", "2.0.0")]
    [ManifestExtra("Description", "Optional external callback adapter for the Morpheus MiniApp OS")]
    [ContractPermission("*", "*")]
    public partial class OracleCallbackConsumer : SmartContract
    {
        private static readonly byte[] PREFIX_ADMIN = new byte[] { 0x01 };
        private static readonly byte[] PREFIX_KERNEL = new byte[] { 0x02 };
        private static readonly byte[] PREFIX_CALLBACK = new byte[] { 0x10 };

        public struct CallbackRecord
        {
            public string AppId;
            public string ModuleId;
            public string Operation;
            public UInt160 Requester;
            public bool Success;
            public ByteString Result;
            public string Error;
            public BigInteger ReceivedAt;
        }

        [DisplayName("MiniAppResultReceived")]
        public static event MiniAppResultReceivedHandler OnMiniAppResultReceived;

        [DisplayName("AdminChanged")]
        public static event AdminChangedHandler OnAdminChanged;

        [DisplayName("KernelChanged")]
        public static event KernelChangedHandler OnKernelChanged;

        public static void _deploy(object data, bool update)
        {
            if (update) return;
            Storage.Put(Storage.CurrentContext, PREFIX_ADMIN, Runtime.Transaction.Sender);
        }

        [Safe]
        public static UInt160 Admin()
        {
            return (UInt160)Storage.Get(Storage.CurrentContext, PREFIX_ADMIN);
        }

        [Safe]
        public static UInt160 Kernel()
        {
            return (UInt160)Storage.Get(Storage.CurrentContext, PREFIX_KERNEL);
        }

        // Legacy alias kept for migration.
        [Safe]
        public static UInt160 Oracle() => Kernel();

        public static void SetAdmin(UInt160 newAdmin)
        {
            ValidateAdmin();
            ExecutionEngine.Assert(newAdmin != null && newAdmin.IsValid, "invalid");

            UInt160 oldAdmin = Admin();
            Storage.Put(Storage.CurrentContext, PREFIX_ADMIN, newAdmin);
            OnAdminChanged(oldAdmin, newAdmin);
        }

        public static void SetKernel(UInt160 kernel)
        {
            ValidateAdmin();
            ExecutionEngine.Assert(kernel != null && kernel.IsValid, "invalid");

            UInt160 oldKernel = Kernel();
            Storage.Put(Storage.CurrentContext, PREFIX_KERNEL, kernel);
            OnKernelChanged(oldKernel, kernel);
        }

        // Legacy alias kept for migration.
        public static void SetOracle(UInt160 oracle)
        {
            SetKernel(oracle);
        }

        public static void Update(ByteString nefFile, string manifest)
        {
            ValidateAdmin();
            ContractManagement.Update(nefFile, manifest, null);
        }

        public static void OnMiniAppResult(BigInteger requestId, string appId, string moduleId, string operation, UInt160 requester, bool success, ByteString result, string error)
        {
            ValidateKernel();
            StoreCallback(
                requestId,
                appId ?? "",
                moduleId ?? "",
                operation ?? "",
                requester,
                success,
                result ?? (ByteString)"",
                error ?? ""
            );
        }

        // Legacy adapter so old integrations keep working while they move to onMiniAppResult.
        public static void OnOracleResult(BigInteger requestId, string requestType, bool success, ByteString result, string error)
        {
            ValidateKernel();
            StoreCallback(
                requestId,
                "legacy",
                requestType ?? "",
                requestType ?? "",
                null,
                success,
                result ?? (ByteString)"",
                error ?? ""
            );
        }

        [Safe]
        public static CallbackRecord GetCallbackRecord(BigInteger requestId)
        {
            ByteString data = Storage.Get(Storage.CurrentContext, BuildCallbackKey(requestId));
            if (data == null)
            {
                return new CallbackRecord
                {
                    AppId = "",
                    ModuleId = "",
                    Operation = "",
                    Requester = null,
                    Success = false,
                    Result = (ByteString)"",
                    Error = "",
                    ReceivedAt = 0
                };
            }

            return (CallbackRecord)StdLib.Deserialize(data);
        }

        [Safe]
        public static object[] GetCallback(BigInteger requestId)
        {
            CallbackRecord record = GetCallbackRecord(requestId);
            return new object[]
            {
                record.AppId,
                record.ModuleId,
                record.Operation,
                record.Requester,
                record.Success,
                record.Result,
                record.Error,
                record.ReceivedAt
            };
        }

        private static void StoreCallback(BigInteger requestId, string appId, string moduleId, string operation, UInt160 requester, bool success, ByteString result, string error)
        {
            // Replay guard: a given requestId is fulfilled exactly once, so the
            // first callback for an id is authoritative and any later callback
            // for the same id is a replay/forgery. Value-bearing consumers MUST
            // reject duplicates here instead of overwriting an already-recorded
            // result (e.g. flipping a success to a failure, or vice versa).
            ExecutionEngine.Assert(
                Storage.Get(Storage.CurrentContext, BuildCallbackKey(requestId)) == null,
                "callback already recorded");

            CallbackRecord record = new CallbackRecord
            {
                AppId = appId,
                ModuleId = moduleId,
                Operation = operation,
                Requester = requester,
                Success = success,
                Result = result,
                Error = error,
                ReceivedAt = Runtime.Time
            };

            Storage.Put(Storage.CurrentContext, BuildCallbackKey(requestId), StdLib.Serialize(record));
            OnMiniAppResultReceived(requestId, appId, moduleId, operation, success, error);
        }

        private static byte[] BuildCallbackKey(BigInteger requestId)
        {
            return Helper.Concat(PREFIX_CALLBACK, (ByteString)requestId.ToByteArray());
        }

        private static void ValidateAdmin()
        {
            UInt160 admin = Admin();
            ExecutionEngine.Assert(admin != null && admin.IsValid, "admin not set");
            ExecutionEngine.Assert(Runtime.CheckWitness(admin), "unauthorized");
        }

        private static void ValidateKernel()
        {
            UInt160 kernel = Kernel();
            ExecutionEngine.Assert(kernel != null && kernel.IsValid, "kernel not set");
            ExecutionEngine.Assert(Runtime.CallingScriptHash == kernel, "unauthorized caller");
        }
    }
}
