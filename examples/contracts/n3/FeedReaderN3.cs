using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Services;

[DisplayName("FeedReaderN3Example")]
[ContractPermission("*", "getLatest")]
[ContractPermission("*", "getAllPairs")]
public class FeedReaderN3 : SmartContract
{
    [Safe]
    public static object[] GetNeoUsd(UInt160 dataFeedHash)
    {
        return (object[])Contract.Call(
            dataFeedHash,
            "getLatest",
            CallFlags.ReadOnly,
            "TWELVEDATA:NEO-USD"
        );
    }

    [Safe]
    public static string[] GetAllPairs(UInt160 dataFeedHash)
    {
        return (string[])Contract.Call(
            dataFeedHash,
            "getAllPairs",
            CallFlags.ReadOnly
        );
    }
}
