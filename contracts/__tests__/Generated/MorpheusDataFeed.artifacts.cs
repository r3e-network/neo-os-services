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

    public static Neo.SmartContract.Manifest.ContractManifest Manifest => Neo.SmartContract.Manifest.ContractManifest.Parse(@"{""name"":""MorpheusDataFeed"",""groups"":[],""features"":{},""supportedstandards"":[],""abi"":{""methods"":[{""name"":""_deploy"",""parameters"":[{""name"":""data"",""type"":""Any""},{""name"":""update"",""type"":""Boolean""}],""returntype"":""Void"",""offset"":0,""safe"":false},{""name"":""admin"",""parameters"":[],""returntype"":""Hash160"",""offset"":47,""safe"":true},{""name"":""updater"",""parameters"":[],""returntype"":""Hash160"",""offset"":76,""safe"":true},{""name"":""oracleVerificationKey"",""parameters"":[],""returntype"":""PublicKey"",""offset"":99,""safe"":true},{""name"":""setAdmin"",""parameters"":[{""name"":""newAdmin"",""type"":""Hash160""}],""returntype"":""Void"",""offset"":323,""safe"":false},{""name"":""setUpdater"",""parameters"":[{""name"":""updater"",""type"":""Hash160""}],""returntype"":""Void"",""offset"":413,""safe"":false},{""name"":""setOracleVerificationKey"",""parameters"":[{""name"":""publicKey"",""type"":""PublicKey""}],""returntype"":""Void"",""offset"":507,""safe"":false},{""name"":""clearOracleVerificationKey"",""parameters"":[],""returntype"":""Void"",""offset"":635,""safe"":false},{""name"":""getPairCount"",""parameters"":[],""returntype"":""Integer"",""offset"":721,""safe"":true},{""name"":""getPairByIndex"",""parameters"":[{""name"":""index"",""type"":""Integer""}],""returntype"":""String"",""offset"":1758,""safe"":true},{""name"":""getAllPairs"",""parameters"":[],""returntype"":""Array"",""offset"":1826,""safe"":true},{""name"":""updateFeed"",""parameters"":[{""name"":""pair"",""type"":""String""},{""name"":""roundId"",""type"":""Integer""},{""name"":""price"",""type"":""Integer""},{""name"":""timestamp"",""type"":""Integer""},{""name"":""attestationHash"",""type"":""ByteArray""},{""name"":""sourceSetId"",""type"":""Integer""}],""returntype"":""Void"",""offset"":1930,""safe"":false},{""name"":""updateFeedSigned"",""parameters"":[{""name"":""pair"",""type"":""String""},{""name"":""roundId"",""type"":""Integer""},{""name"":""price"",""type"":""Integer""},{""name"":""timestamp"",""type"":""Integer""},{""name"":""attestationHash"",""type"":""ByteArray""},{""name"":""sourceSetId"",""type"":""Integer""},{""name"":""signature"",""type"":""ByteArray""}],""returntype"":""Void"",""offset"":1951,""safe"":false},{""name"":""adminResetFeed"",""parameters"":[{""name"":""pair"",""type"":""String""},{""name"":""roundId"",""type"":""Integer""},{""name"":""price"",""type"":""Integer""},{""name"":""timestamp"",""type"":""Integer""},{""name"":""attestationHash"",""type"":""ByteArray""},{""name"":""sourceSetId"",""type"":""Integer""}],""returntype"":""Void"",""offset"":1972,""safe"":false},{""name"":""updateResource"",""parameters"":[{""name"":""resourceId"",""type"":""String""},{""name"":""version"",""type"":""Integer""},{""name"":""value"",""type"":""Integer""},{""name"":""timestamp"",""type"":""Integer""},{""name"":""attestationHash"",""type"":""ByteArray""},{""name"":""sourceSetId"",""type"":""Integer""}],""returntype"":""Void"",""offset"":2009,""safe"":false},{""name"":""updateFeeds"",""parameters"":[{""name"":""pairs"",""type"":""Array""},{""name"":""roundIds"",""type"":""Array""},{""name"":""prices"",""type"":""Array""},{""name"":""timestamps"",""type"":""Array""},{""name"":""attestationHashes"",""type"":""Array""},{""name"":""sourceSetIds"",""type"":""Array""}],""returntype"":""Void"",""offset"":2021,""safe"":false},{""name"":""updateResources"",""parameters"":[{""name"":""resourceIds"",""type"":""Array""},{""name"":""versions"",""type"":""Array""},{""name"":""values"",""type"":""Array""},{""name"":""timestamps"",""type"":""Array""},{""name"":""attestationHashes"",""type"":""Array""},{""name"":""sourceSetIds"",""type"":""Array""}],""returntype"":""Void"",""offset"":2369,""safe"":false},{""name"":""getLatest"",""parameters"":[{""name"":""pair"",""type"":""String""}],""returntype"":""Array"",""offset"":2384,""safe"":true},{""name"":""getResource"",""parameters"":[{""name"":""resourceId"",""type"":""String""}],""returntype"":""Array"",""offset"":2460,""safe"":true},{""name"":""getAllFeedRecords"",""parameters"":[],""returntype"":""Array"",""offset"":2469,""safe"":true},{""name"":""getAllResources"",""parameters"":[],""returntype"":""Array"",""offset"":2559,""safe"":true},{""name"":""update"",""parameters"":[{""name"":""nefFile"",""type"":""ByteArray""},{""name"":""manifest"",""type"":""String""}],""returntype"":""Void"",""offset"":2564,""safe"":false},{""name"":""_initialize"",""parameters"":[],""returntype"":""Void"",""offset"":2583,""safe"":false}],""events"":[{""name"":""FeedUpdated"",""parameters"":[{""name"":""pair"",""type"":""String""},{""name"":""roundId"",""type"":""Integer""},{""name"":""price"",""type"":""Integer""},{""name"":""timestamp"",""type"":""Integer""},{""name"":""attestationHash"",""type"":""ByteArray""},{""name"":""sourceSetId"",""type"":""Integer""}]},{""name"":""AdminChanged"",""parameters"":[{""name"":""oldAdmin"",""type"":""Hash160""},{""name"":""newAdmin"",""type"":""Hash160""}]},{""name"":""UpdaterChanged"",""parameters"":[{""name"":""oldUpdater"",""type"":""Hash160""},{""name"":""newUpdater"",""type"":""Hash160""}]},{""name"":""VerificationKeyChanged"",""parameters"":[{""name"":""oldKey"",""type"":""PublicKey""},{""name"":""newKey"",""type"":""PublicKey""}]}]},""permissions"":[{""contract"":""0x726cb6e0cd8628a1350a611384688911ab75f51b"",""methods"":[""verifyWithECDsa""]},{""contract"":""0xacce6fd80d44e1796aa0c2c625e9e4e0ce39efc0"",""methods"":[""deserialize"",""itoa"",""memorySearch"",""serialize""]},{""contract"":""0xfffdc93764dbaddd97c48f252a53ea4643faa3fd"",""methods"":[""update""]}],""trusts"":[],""extra"":{""Author"":""Morpheus Oracle"",""Version"":""2.0.0"",""Description"":""Shared numeric resource registry for the Morpheus MiniApp OS"",""nef"":{""optimization"":""Basic""}}}");

    /// <summary>
    /// Optimization: "Basic"
    /// </summary>
    public static Neo.SmartContract.NefFile Nef => Convert.FromBase64String(@"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").AsSerializable<Neo.SmartContract.NefFile>();

    #endregion

    #region Events

    public delegate void delAdminChanged(UInt160? oldAdmin, UInt160? newAdmin);

    [DisplayName("AdminChanged")]
    public event delAdminChanged? OnAdminChanged;

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
    [DisplayName("clearOracleVerificationKey")]
    public abstract void ClearOracleVerificationKey();

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("setAdmin")]
    public abstract void SetAdmin(UInt160? newAdmin);

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
