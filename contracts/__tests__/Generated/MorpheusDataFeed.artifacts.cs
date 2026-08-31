using Neo.Cryptography.ECC;
using Neo.Extensions;
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Numerics;

#pragma warning disable CS0067

namespace Neo.SmartContract.Testing;

public abstract class MorpheusDataFeed(Neo.SmartContract.Testing.SmartContractInitialize initialize) : Neo.SmartContract.Testing.SmartContract(initialize), IContractInfo
{
    #region Compiled data

    public static Neo.SmartContract.Manifest.ContractManifest Manifest => Neo.SmartContract.Manifest.ContractManifest.Parse(@"{""name"":""MorpheusDataFeed"",""groups"":[],""features"":{},""supportedstandards"":[],""abi"":{""methods"":[{""name"":""_deploy"",""parameters"":[{""name"":""data"",""type"":""Any""},{""name"":""update"",""type"":""Boolean""}],""returntype"":""Void"",""offset"":0,""safe"":false},{""name"":""admin"",""parameters"":[],""returntype"":""Hash160"",""offset"":47,""safe"":true},{""name"":""updater"",""parameters"":[],""returntype"":""Hash160"",""offset"":76,""safe"":true},{""name"":""oracleVerificationKey"",""parameters"":[],""returntype"":""PublicKey"",""offset"":99,""safe"":true},{""name"":""proposeAdmin"",""parameters"":[{""name"":""newAdmin"",""type"":""Hash160""}],""returntype"":""Void"",""offset"":323,""safe"":false},{""name"":""executeAdminChange"",""parameters"":[],""returntype"":""Void"",""offset"":518,""safe"":false},{""name"":""cancelAdminChange"",""parameters"":[],""returntype"":""Void"",""offset"":700,""safe"":false},{""name"":""setUpdater"",""parameters"":[{""name"":""updater"",""type"":""Hash160""}],""returntype"":""Void"",""offset"":728,""safe"":false},{""name"":""setOracleVerificationKey"",""parameters"":[{""name"":""publicKey"",""type"":""PublicKey""}],""returntype"":""Void"",""offset"":822,""safe"":false},{""name"":""clearOracleVerificationKey"",""parameters"":[],""returntype"":""Void"",""offset"":950,""safe"":false},{""name"":""getPairCount"",""parameters"":[],""returntype"":""Integer"",""offset"":1030,""safe"":true},{""name"":""getPairByIndex"",""parameters"":[{""name"":""index"",""type"":""Integer""}],""returntype"":""String"",""offset"":2053,""safe"":true},{""name"":""getAllPairs"",""parameters"":[],""returntype"":""Array"",""offset"":2121,""safe"":true},{""name"":""updateFeed"",""parameters"":[{""name"":""pair"",""type"":""String""},{""name"":""roundId"",""type"":""Integer""},{""name"":""price"",""type"":""Integer""},{""name"":""timestamp"",""type"":""Integer""},{""name"":""attestationHash"",""type"":""ByteArray""},{""name"":""sourceSetId"",""type"":""Integer""}],""returntype"":""Void"",""offset"":2225,""safe"":false},{""name"":""updateFeedSigned"",""parameters"":[{""name"":""pair"",""type"":""String""},{""name"":""roundId"",""type"":""Integer""},{""name"":""price"",""type"":""Integer""},{""name"":""timestamp"",""type"":""Integer""},{""name"":""attestationHash"",""type"":""ByteArray""},{""name"":""sourceSetId"",""type"":""Integer""},{""name"":""signature"",""type"":""ByteArray""}],""returntype"":""Void"",""offset"":2246,""safe"":false},{""name"":""adminResetFeed"",""parameters"":[{""name"":""pair"",""type"":""String""},{""name"":""roundId"",""type"":""Integer""},{""name"":""price"",""type"":""Integer""},{""name"":""timestamp"",""type"":""Integer""},{""name"":""attestationHash"",""type"":""ByteArray""},{""name"":""sourceSetId"",""type"":""Integer""}],""returntype"":""Void"",""offset"":2267,""safe"":false},{""name"":""updateResource"",""parameters"":[{""name"":""resourceId"",""type"":""String""},{""name"":""version"",""type"":""Integer""},{""name"":""value"",""type"":""Integer""},{""name"":""timestamp"",""type"":""Integer""},{""name"":""attestationHash"",""type"":""ByteArray""},{""name"":""sourceSetId"",""type"":""Integer""}],""returntype"":""Void"",""offset"":2304,""safe"":false},{""name"":""updateFeeds"",""parameters"":[{""name"":""pairs"",""type"":""Array""},{""name"":""roundIds"",""type"":""Array""},{""name"":""prices"",""type"":""Array""},{""name"":""timestamps"",""type"":""Array""},{""name"":""attestationHashes"",""type"":""Array""},{""name"":""sourceSetIds"",""type"":""Array""}],""returntype"":""Void"",""offset"":2316,""safe"":false},{""name"":""updateResources"",""parameters"":[{""name"":""resourceIds"",""type"":""Array""},{""name"":""versions"",""type"":""Array""},{""name"":""values"",""type"":""Array""},{""name"":""timestamps"",""type"":""Array""},{""name"":""attestationHashes"",""type"":""Array""},{""name"":""sourceSetIds"",""type"":""Array""}],""returntype"":""Void"",""offset"":2664,""safe"":false},{""name"":""getLatest"",""parameters"":[{""name"":""pair"",""type"":""String""}],""returntype"":""Array"",""offset"":2679,""safe"":true},{""name"":""getResource"",""parameters"":[{""name"":""resourceId"",""type"":""String""}],""returntype"":""Array"",""offset"":2755,""safe"":true},{""name"":""getAllFeedRecords"",""parameters"":[],""returntype"":""Array"",""offset"":2764,""safe"":true},{""name"":""getAllResources"",""parameters"":[],""returntype"":""Array"",""offset"":2854,""safe"":true},{""name"":""update"",""parameters"":[{""name"":""nefFile"",""type"":""ByteArray""},{""name"":""manifest"",""type"":""String""}],""returntype"":""Void"",""offset"":2859,""safe"":false},{""name"":""_initialize"",""parameters"":[],""returntype"":""Void"",""offset"":2878,""safe"":false}],""events"":[{""name"":""FeedUpdated"",""parameters"":[{""name"":""pair"",""type"":""String""},{""name"":""roundId"",""type"":""Integer""},{""name"":""price"",""type"":""Integer""},{""name"":""timestamp"",""type"":""Integer""},{""name"":""attestationHash"",""type"":""ByteArray""},{""name"":""sourceSetId"",""type"":""Integer""}]},{""name"":""AdminChanged"",""parameters"":[{""name"":""oldAdmin"",""type"":""Hash160""},{""name"":""newAdmin"",""type"":""Hash160""}]},{""name"":""AdminTimelockProposed"",""parameters"":[{""name"":""proposed"",""type"":""Hash160""},{""name"":""executeAfter"",""type"":""Integer""}]},{""name"":""UpdaterChanged"",""parameters"":[{""name"":""oldUpdater"",""type"":""Hash160""},{""name"":""newUpdater"",""type"":""Hash160""}]},{""name"":""VerificationKeyChanged"",""parameters"":[{""name"":""oldKey"",""type"":""PublicKey""},{""name"":""newKey"",""type"":""PublicKey""}]}]},""permissions"":[{""contract"":""0x726cb6e0cd8628a1350a611384688911ab75f51b"",""methods"":[""verifyWithECDsa""]},{""contract"":""0xacce6fd80d44e1796aa0c2c625e9e4e0ce39efc0"",""methods"":[""deserialize"",""itoa"",""memorySearch"",""serialize""]},{""contract"":""0xfffdc93764dbaddd97c48f252a53ea4643faa3fd"",""methods"":[""update""]}],""trusts"":[],""extra"":{""Author"":""Morpheus Oracle"",""Version"":""2.0.0"",""Description"":""Shared numeric resource registry for the Morpheus MiniApp OS"",""nef"":{""optimization"":""Basic""}}}");

    /// <summary>
    /// Optimization: "Basic"
    /// </summary>
    public static Neo.SmartContract.NefFile Nef => Convert.FromBase64String(@"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").AsSerializable<Neo.SmartContract.NefFile>();

    #endregion

    #region Events

    public delegate void delAdminChanged(UInt160? oldAdmin, UInt160? newAdmin);

    [DisplayName("AdminChanged")]
    public event delAdminChanged? OnAdminChanged;

    public delegate void delAdminTimelockProposed(UInt160? proposed, BigInteger? executeAfter);

    [DisplayName("AdminTimelockProposed")]
    public event delAdminTimelockProposed? OnAdminTimelockProposed;

    public delegate void delFeedUpdated(string? pair, BigInteger? roundId, BigInteger? price, BigInteger? timestamp, byte[]? attestationHash, BigInteger? sourceSetId);

    [DisplayName("FeedUpdated")]
    public event delFeedUpdated? OnFeedUpdated;

    public delegate void delUpdaterChanged(UInt160? oldUpdater, UInt160? newUpdater);

    [DisplayName("UpdaterChanged")]
    public event delUpdaterChanged? OnUpdaterChanged;

    public delegate void delVerificationKeyChanged(ECPoint? oldKey, ECPoint? newKey);

    [DisplayName("VerificationKeyChanged")]
    public event delVerificationKeyChanged? OnVerificationKeyChanged;

    #endregion

    #region Properties

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract UInt160? Admin { [DisplayName("admin")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract IList<object>? AllFeedRecords { [DisplayName("getAllFeedRecords")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract IList<object>? AllPairs { [DisplayName("getAllPairs")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract IList<object>? AllResources { [DisplayName("getAllResources")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract BigInteger? PairCount { [DisplayName("getPairCount")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract ECPoint? OracleVerificationKey { [DisplayName("oracleVerificationKey")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract UInt160? Updater { [DisplayName("updater")] get; }

    #endregion

    #region Safe methods

    /// <summary>
    /// Safe method
    /// </summary>
    [DisplayName("getLatest")]
    public abstract IList<object>? GetLatest(string? pair);

    /// <summary>
    /// Safe method
    /// </summary>
    [DisplayName("getPairByIndex")]
    public abstract string? GetPairByIndex(BigInteger? index);

    /// <summary>
    /// Safe method
    /// </summary>
    [DisplayName("getResource")]
    public abstract IList<object>? GetResource(string? resourceId);

    #endregion

    #region Unsafe methods

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("adminResetFeed")]
    public abstract void AdminResetFeed(string? pair, BigInteger? roundId, BigInteger? price, BigInteger? timestamp, byte[]? attestationHash, BigInteger? sourceSetId);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("cancelAdminChange")]
    public abstract void CancelAdminChange();

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("clearOracleVerificationKey")]
    public abstract void ClearOracleVerificationKey();

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("executeAdminChange")]
    public abstract void ExecuteAdminChange();

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("proposeAdmin")]
    public abstract void ProposeAdmin(UInt160? newAdmin);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("setOracleVerificationKey")]
    public abstract void SetOracleVerificationKey(ECPoint? publicKey);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("setUpdater")]
    public abstract void SetUpdater(UInt160? updater);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("update")]
    public abstract void Update(byte[]? nefFile, string? manifest);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("updateFeed")]
    public abstract void UpdateFeed(string? pair, BigInteger? roundId, BigInteger? price, BigInteger? timestamp, byte[]? attestationHash, BigInteger? sourceSetId);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("updateFeeds")]
    public abstract void UpdateFeeds(IList<object>? pairs, IList<object>? roundIds, IList<object>? prices, IList<object>? timestamps, IList<object>? attestationHashes, IList<object>? sourceSetIds);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("updateFeedSigned")]
    public abstract void UpdateFeedSigned(string? pair, BigInteger? roundId, BigInteger? price, BigInteger? timestamp, byte[]? attestationHash, BigInteger? sourceSetId, byte[]? signature);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("updateResource")]
    public abstract void UpdateResource(string? resourceId, BigInteger? version, BigInteger? value, BigInteger? timestamp, byte[]? attestationHash, BigInteger? sourceSetId);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("updateResources")]
    public abstract void UpdateResources(IList<object>? resourceIds, IList<object>? versions, IList<object>? values, IList<object>? timestamps, IList<object>? attestationHashes, IList<object>? sourceSetIds);

    #endregion
}
