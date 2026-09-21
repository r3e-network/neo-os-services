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

    public static Neo.SmartContract.Manifest.ContractManifest Manifest => Neo.SmartContract.Manifest.ContractManifest.Parse(@"{""name"":""MorpheusDataFeed"",""groups"":[],""features"":{},""supportedstandards"":[],""abi"":{""methods"":[{""name"":""_deploy"",""parameters"":[{""name"":""data"",""type"":""Any""},{""name"":""update"",""type"":""Boolean""}],""returntype"":""Void"",""offset"":0,""safe"":false},{""name"":""admin"",""parameters"":[],""returntype"":""Hash160"",""offset"":47,""safe"":true},{""name"":""updater"",""parameters"":[],""returntype"":""Hash160"",""offset"":76,""safe"":true},{""name"":""oracleVerificationKey"",""parameters"":[],""returntype"":""PublicKey"",""offset"":99,""safe"":true},{""name"":""proposeAdmin"",""parameters"":[{""name"":""newAdmin"",""type"":""Hash160""}],""returntype"":""Void"",""offset"":323,""safe"":false},{""name"":""executeAdminChange"",""parameters"":[],""returntype"":""Void"",""offset"":518,""safe"":false},{""name"":""cancelAdminChange"",""parameters"":[],""returntype"":""Void"",""offset"":700,""safe"":false},{""name"":""setUpdater"",""parameters"":[{""name"":""updater"",""type"":""Hash160""}],""returntype"":""Void"",""offset"":728,""safe"":false},{""name"":""getPairCount"",""parameters"":[],""returntype"":""Integer"",""offset"":843,""safe"":true},{""name"":""getPairByIndex"",""parameters"":[{""name"":""index"",""type"":""Integer""}],""returntype"":""String"",""offset"":1866,""safe"":true},{""name"":""getAllPairs"",""parameters"":[],""returntype"":""Array"",""offset"":1934,""safe"":true},{""name"":""updateFeed"",""parameters"":[{""name"":""pair"",""type"":""String""},{""name"":""roundId"",""type"":""Integer""},{""name"":""price"",""type"":""Integer""},{""name"":""timestamp"",""type"":""Integer""},{""name"":""attestationHash"",""type"":""ByteArray""},{""name"":""sourceSetId"",""type"":""Integer""}],""returntype"":""Void"",""offset"":2038,""safe"":false},{""name"":""updateFeedSigned"",""parameters"":[{""name"":""pair"",""type"":""String""},{""name"":""roundId"",""type"":""Integer""},{""name"":""price"",""type"":""Integer""},{""name"":""timestamp"",""type"":""Integer""},{""name"":""attestationHash"",""type"":""ByteArray""},{""name"":""sourceSetId"",""type"":""Integer""},{""name"":""signature"",""type"":""ByteArray""}],""returntype"":""Void"",""offset"":2059,""safe"":false},{""name"":""adminResetFeed"",""parameters"":[{""name"":""pair"",""type"":""String""},{""name"":""roundId"",""type"":""Integer""},{""name"":""price"",""type"":""Integer""},{""name"":""timestamp"",""type"":""Integer""},{""name"":""attestationHash"",""type"":""ByteArray""},{""name"":""sourceSetId"",""type"":""Integer""}],""returntype"":""Void"",""offset"":2080,""safe"":false},{""name"":""updateResource"",""parameters"":[{""name"":""resourceId"",""type"":""String""},{""name"":""version"",""type"":""Integer""},{""name"":""value"",""type"":""Integer""},{""name"":""timestamp"",""type"":""Integer""},{""name"":""attestationHash"",""type"":""ByteArray""},{""name"":""sourceSetId"",""type"":""Integer""}],""returntype"":""Void"",""offset"":2202,""safe"":false},{""name"":""updateFeeds"",""parameters"":[{""name"":""pairs"",""type"":""Array""},{""name"":""roundIds"",""type"":""Array""},{""name"":""prices"",""type"":""Array""},{""name"":""timestamps"",""type"":""Array""},{""name"":""attestationHashes"",""type"":""Array""},{""name"":""sourceSetIds"",""type"":""Array""}],""returntype"":""Void"",""offset"":2217,""safe"":false},{""name"":""updateResources"",""parameters"":[{""name"":""resourceIds"",""type"":""Array""},{""name"":""versions"",""type"":""Array""},{""name"":""values"",""type"":""Array""},{""name"":""timestamps"",""type"":""Array""},{""name"":""attestationHashes"",""type"":""Array""},{""name"":""sourceSetIds"",""type"":""Array""}],""returntype"":""Void"",""offset"":2565,""safe"":false},{""name"":""getLatest"",""parameters"":[{""name"":""pair"",""type"":""String""}],""returntype"":""Array"",""offset"":2580,""safe"":true},{""name"":""getResource"",""parameters"":[{""name"":""resourceId"",""type"":""String""}],""returntype"":""Array"",""offset"":2656,""safe"":true},{""name"":""getAllFeedRecords"",""parameters"":[],""returntype"":""Array"",""offset"":2665,""safe"":true},{""name"":""getAllResources"",""parameters"":[],""returntype"":""Array"",""offset"":2755,""safe"":true},{""name"":""update"",""parameters"":[{""name"":""nefFile"",""type"":""ByteArray""},{""name"":""manifest"",""type"":""String""}],""returntype"":""Void"",""offset"":2760,""safe"":false},{""name"":""pendingOracleVerificationKey"",""parameters"":[],""returntype"":""PublicKey"",""offset"":2779,""safe"":true},{""name"":""pendingOracleVerificationKeyIsClear"",""parameters"":[],""returntype"":""Boolean"",""offset"":2831,""safe"":true},{""name"":""pendingOracleVerificationKeyChangeTime"",""parameters"":[],""returntype"":""Integer"",""offset"":2862,""safe"":true},{""name"":""proposeOracleVerificationKey"",""parameters"":[{""name"":""publicKey"",""type"":""PublicKey""}],""returntype"":""Void"",""offset"":2900,""safe"":false},{""name"":""proposeClearOracleVerificationKey"",""parameters"":[],""returntype"":""Void"",""offset"":3198,""safe"":false},{""name"":""executeOracleVerificationKeyChange"",""parameters"":[],""returntype"":""Void"",""offset"":3246,""safe"":false},{""name"":""cancelOracleVerificationKeyChange"",""parameters"":[],""returntype"":""Void"",""offset"":3471,""safe"":false},{""name"":""_initialize"",""parameters"":[],""returntype"":""Void"",""offset"":3501,""safe"":false}],""events"":[{""name"":""FeedUpdated"",""parameters"":[{""name"":""pair"",""type"":""String""},{""name"":""roundId"",""type"":""Integer""},{""name"":""price"",""type"":""Integer""},{""name"":""timestamp"",""type"":""Integer""},{""name"":""attestationHash"",""type"":""ByteArray""},{""name"":""sourceSetId"",""type"":""Integer""}]},{""name"":""AdminChanged"",""parameters"":[{""name"":""oldAdmin"",""type"":""Hash160""},{""name"":""newAdmin"",""type"":""Hash160""}]},{""name"":""AdminTimelockProposed"",""parameters"":[{""name"":""proposed"",""type"":""Hash160""},{""name"":""executeAfter"",""type"":""Integer""}]},{""name"":""UpdaterChanged"",""parameters"":[{""name"":""oldUpdater"",""type"":""Hash160""},{""name"":""newUpdater"",""type"":""Hash160""}]},{""name"":""VerificationKeyChanged"",""parameters"":[{""name"":""oldKey"",""type"":""PublicKey""},{""name"":""newKey"",""type"":""PublicKey""}]},{""name"":""AdminFeedReset"",""parameters"":[{""name"":""pair"",""type"":""String""},{""name"":""roundId"",""type"":""Integer""},{""name"":""price"",""type"":""Integer""},{""name"":""timestamp"",""type"":""Integer""},{""name"":""sourceSetId"",""type"":""Integer""}]},{""name"":""VerificationKeyTimelockProposed"",""parameters"":[{""name"":""proposed"",""type"":""PublicKey""},{""name"":""clearing"",""type"":""Boolean""},{""name"":""executeAfter"",""type"":""Integer""}]}]},""permissions"":[{""contract"":""0x726cb6e0cd8628a1350a611384688911ab75f51b"",""methods"":[""verifyWithECDsa""]},{""contract"":""0xacce6fd80d44e1796aa0c2c625e9e4e0ce39efc0"",""methods"":[""deserialize"",""itoa"",""memorySearch"",""serialize""]},{""contract"":""0xfffdc93764dbaddd97c48f252a53ea4643faa3fd"",""methods"":[""update""]}],""trusts"":[],""extra"":{""Author"":""Morpheus Oracle"",""Version"":""2.0.0"",""Description"":""Shared numeric resource registry for the Morpheus MiniApp OS"",""nef"":{""optimization"":""Basic""}}}");

    /// <summary>
    /// Optimization: "Basic"
    /// </summary>
    public static Neo.SmartContract.NefFile Nef => Convert.FromBase64String(@"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").AsSerializable<Neo.SmartContract.NefFile>();

    #endregion

    #region Events

    public delegate void delAdminChanged(UInt160? oldAdmin, UInt160? newAdmin);

    [DisplayName("AdminChanged")]
    public event delAdminChanged? OnAdminChanged;

    public delegate void delAdminFeedReset(string? pair, BigInteger? roundId, BigInteger? price, BigInteger? timestamp, BigInteger? sourceSetId);

    [DisplayName("AdminFeedReset")]
    public event delAdminFeedReset? OnAdminFeedReset;

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

    public delegate void delVerificationKeyTimelockProposed(ECPoint? proposed, bool? clearing, BigInteger? executeAfter);

    [DisplayName("VerificationKeyTimelockProposed")]
    public event delVerificationKeyTimelockProposed? OnVerificationKeyTimelockProposed;

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
    public abstract ECPoint? PendingOracleVerificationKey { [DisplayName("pendingOracleVerificationKey")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract BigInteger? PendingOracleVerificationKeyChangeTime { [DisplayName("pendingOracleVerificationKeyChangeTime")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract bool? PendingOracleVerificationKeyIsClear { [DisplayName("pendingOracleVerificationKeyIsClear")] get; }

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
    [DisplayName("cancelOracleVerificationKeyChange")]
    public abstract void CancelOracleVerificationKeyChange();

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("executeAdminChange")]
    public abstract void ExecuteAdminChange();

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("executeOracleVerificationKeyChange")]
    public abstract void ExecuteOracleVerificationKeyChange();

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("proposeAdmin")]
    public abstract void ProposeAdmin(UInt160? newAdmin);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("proposeClearOracleVerificationKey")]
    public abstract void ProposeClearOracleVerificationKey();

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("proposeOracleVerificationKey")]
    public abstract void ProposeOracleVerificationKey(ECPoint? publicKey);

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
