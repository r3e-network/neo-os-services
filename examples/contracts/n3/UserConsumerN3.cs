using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

[DisplayName("UserConsumerN3OracleExample")]
[ContractPermission("*", "request")]
[ContractPermission("0xd2a4cff31913016155e38e474a2c06d08be276cf", "transfer")]
public class UserConsumerN3 : SmartContract
{
    private static readonly byte[] PREFIX_ADMIN = new byte[] { 0x01 };
    private static readonly byte[] PREFIX_ORACLE = new byte[] { 0x02 };
    private static readonly byte[] PREFIX_CALLBACK = new byte[] { 0x10 };
    // Pending requests this consumer issued, keyed by requestId. Storing the
    // expected requestType lets OnOracleResult reject callbacks for requests we
    // never made (or that were already consumed), which is mandatory for any
    // value-bearing consumer.
    private static readonly byte[] PREFIX_PENDING = new byte[] { 0x11 };

    public static void _deploy(object data, bool update)
    {
        if (update) return;
        Storage.Put(Storage.CurrentContext, PREFIX_ADMIN, Runtime.Transaction.Sender);
    }

    [Safe]
    public static UInt160 Admin() => (UInt160)Storage.Get(Storage.CurrentContext, PREFIX_ADMIN);

    [Safe]
    public static UInt160 Oracle() => (UInt160)Storage.Get(Storage.CurrentContext, PREFIX_ORACLE);

    public static void SetAdmin(UInt160 newAdmin)
    {
        ValidateAdmin();
        ExecutionEngine.Assert(newAdmin != null && newAdmin.IsValid, "invalid admin");
        Storage.Put(Storage.CurrentContext, PREFIX_ADMIN, newAdmin);
    }

    public static void SetOracle(UInt160 oracle)
    {
        ValidateAdmin();
        ExecutionEngine.Assert(oracle != null && oracle.IsValid, "invalid oracle");
        Storage.Put(Storage.CurrentContext, PREFIX_ORACLE, oracle);
    }

    public static BigInteger RequestRaw(string requestType, ByteString payload)
    {
        ExecutionEngine.Assert(requestType != null && requestType.Length > 0, "invalid request type");
        UInt160 oracle = RequireOracle();
        BigInteger requestId = (BigInteger)Contract.Call(
            oracle,
            "request",
            CallFlags.All,
            requestType,
            payload,
            Runtime.ExecutingScriptHash,
            "onOracleResult"
        );
        RecordPendingRequest(requestId, requestType);
        return requestId;
    }

    public static BigInteger RequestBuiltinProviderPrice()
    {
        UInt160 oracle = RequireOracle();
        string payloadJson = "{\"provider\":\"twelvedata\",\"symbol\":\"NEO-USD\",\"json_path\":\"price\",\"target_chain\":\"neo_n3\"}";
        BigInteger requestId = (BigInteger)Contract.Call(
            oracle,
            "request",
            CallFlags.All,
            "privacy_oracle",
            (ByteString)payloadJson,
            Runtime.ExecutingScriptHash,
            "onOracleResult"
        );
        RecordPendingRequest(requestId, "privacy_oracle");
        return requestId;
    }

    public static BigInteger RequestBuiltinCompute(ByteString encryptedPayload)
    {
        UInt160 oracle = RequireOracle();
        // StdLib.JsonSerialize escapes the payload correctly; naive string
        // concatenation would corrupt the JSON on any quote or backslash.
        Map<string, object> payload = new Map<string, object>();
        payload["encrypted_payload"] = encryptedPayload;
        string payloadJson = StdLib.JsonSerialize(payload);
        BigInteger requestId = (BigInteger)Contract.Call(
            oracle,
            "request",
            CallFlags.All,
            "compute",
            (ByteString)payloadJson,
            Runtime.ExecutingScriptHash,
            "onOracleResult"
        );
        RecordPendingRequest(requestId, "compute");
        return requestId;
    }

    // NOTE: fee sponsorship is configured kernel-side (RegisterMiniApp feePayer
    // plus fee credits), not via consumer-side method aliases. The former
    // Request*Sponsored methods were identical aliases with no sponsorship
    // semantics and were removed to avoid teaching a misleading pattern.

    public static void DepositOracleCredits(BigInteger amount)
    {
        UInt160 oracle = RequireOracle();
        ExecutionEngine.Assert(amount > 0, "invalid amount");
        ExecutionEngine.Assert(
            GAS.Transfer(Runtime.ExecutingScriptHash, oracle, amount, Runtime.ExecutingScriptHash),
            "gas transfer failed"
        );
    }

    public static void OnNEP17Payment(UInt160 from, BigInteger amount, object data)
    {
        ExecutionEngine.Assert(Runtime.CallingScriptHash == GAS.Hash, "only GAS accepted");
        ExecutionEngine.Assert(amount >= 0, "invalid amount");
    }

    [Safe]
    public static BigInteger ContractGasBalance()
    {
        return GAS.BalanceOf(Runtime.ExecutingScriptHash);
    }

    public static void OnOracleResult(BigInteger requestId, string requestType, bool success, ByteString result, string error)
    {
        ValidateOracle();

        // Only accept callbacks for requests this consumer actually issued.
        // Looking up the pending record reverts on an unknown or forged
        // requestId, and (because it is deleted below) on a replay of a
        // requestId we already settled. A value-bearing consumer that skips
        // this check would credit/pay out on attacker-chosen callbacks.
        ByteString pendingKey = Helper.Concat(PREFIX_PENDING, (ByteString)requestId.ToByteArray());
        ByteString expectedType = Storage.Get(Storage.CurrentContext, pendingKey);
        ExecutionEngine.Assert(expectedType != null, "unknown request id");

        // Bind the callback to the operation we requested. The kernel echoes the
        // requestType back; a mismatch means the result is not for the request
        // we issued under this id.
        ExecutionEngine.Assert(requestType == (string)expectedType, "request type mismatch");

        Storage.Put(
            Storage.CurrentContext,
            Helper.Concat(PREFIX_CALLBACK, (ByteString)requestId.ToByteArray()),
            StdLib.Serialize(new object[] { requestType, success, result, error })
        );

        // Consume the pending record so a replayed callback for the same id
        // fails the "unknown request id" assert above instead of overwriting
        // the stored result.
        Storage.Delete(Storage.CurrentContext, pendingKey);
    }

    /// <summary>
    /// Returns the requestType this consumer recorded for an outstanding
    /// request, or the empty string once the request has been settled (or if it
    /// was never issued by this consumer).
    /// </summary>
    [Safe]
    public static string GetPendingRequestType(BigInteger requestId)
    {
        ByteString raw = Storage.Get(Storage.CurrentContext, Helper.Concat(PREFIX_PENDING, (ByteString)requestId.ToByteArray()));
        if (raw == null) return "";
        return (string)raw;
    }

    [Safe]
    public static object[] GetCallback(BigInteger requestId)
    {
        ByteString raw = Storage.Get(Storage.CurrentContext, Helper.Concat(PREFIX_CALLBACK, (ByteString)requestId.ToByteArray()));
        if (raw == null) return new object[] { };
        return (object[])StdLib.Deserialize(raw);
    }

    private static void RecordPendingRequest(BigInteger requestId, string requestType)
    {
        ExecutionEngine.Assert(requestId > 0, "invalid request id");
        ByteString pendingKey = Helper.Concat(PREFIX_PENDING, (ByteString)requestId.ToByteArray());
        // Request ids are unique per kernel, so a collision here means either a
        // misbehaving oracle or a logic error; refuse rather than clobber.
        ExecutionEngine.Assert(Storage.Get(Storage.CurrentContext, pendingKey) == null, "request id already pending");
        Storage.Put(Storage.CurrentContext, pendingKey, requestType);
    }

    private static void ValidateAdmin()
    {
        UInt160 admin = Admin();
        ExecutionEngine.Assert(admin != null && admin.IsValid, "admin not set");
        ExecutionEngine.Assert(Runtime.CheckWitness(admin), "unauthorized");
    }

    private static UInt160 RequireOracle()
    {
        UInt160 oracle = Oracle();
        ExecutionEngine.Assert(oracle != null && oracle.IsValid, "oracle not set");
        return oracle;
    }

    private static void ValidateOracle()
    {
        ExecutionEngine.Assert(Runtime.CallingScriptHash == RequireOracle(), "unauthorized caller");
    }
}
