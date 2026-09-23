using System.Numerics;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace MorpheusOracle.Contracts
{
    public partial class MorpheusOracle : SmartContract
    {
        private static void DispatchCallback(BigInteger requestId, KernelRequest req)
        {
            if (req.CallbackContract == null || !req.CallbackContract.IsValid) return;

            bool hasRichCallback = ContractManagement.HasMethod(
                req.CallbackContract,
                CALLBACK_METHOD,
                8
            );
            bool hasLegacyCallback = ContractManagement.HasMethod(
                req.CallbackContract,
                LEGACY_CALLBACK_METHOD,
                5
            );

            if (hasRichCallback)
            {
                try
                {
                    // Prefer the rich callback when the deployed ABI declares it.
                    Contract.Call(
                        req.CallbackContract,
                        CALLBACK_METHOD,
                        CallFlags.All,
                        requestId,
                        req.AppId,
                        req.ModuleId,
                        req.Operation,
                        req.Requester,
                        req.Success,
                        req.Result,
                        req.Error
                    );
                }
                catch
                {
                    // Inbox persistence is canonical. Do not invoke a second callback
                    // after a declared rich method faults, which could duplicate effects.
                }
            }
            else if (hasLegacyCallback)
            {
                try
                {
                    // Legacy consumers are called only when the deployed ABI lacks the
                    // rich method. An absent method is therefore never used as control flow.
                    Contract.Call(
                        req.CallbackContract,
                        LEGACY_CALLBACK_METHOD,
                        CallFlags.All,
                        requestId,
                        req.Operation,
                        req.Success,
                        req.Result,
                        req.Error
                    );
                }
                catch
                {
                    // Inbox persistence is canonical. External callbacks are best-effort extensions only.
                }
            }
        }
    }
}
