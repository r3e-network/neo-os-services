using Neo.Cryptography.ECC;
using Neo.Extensions;
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Numerics;

#pragma warning disable CS0067

namespace Neo.SmartContract.Testing;

public abstract class OracleCallbackConsumer(Neo.SmartContract.Testing.SmartContractInitialize initialize) : Neo.SmartContract.Testing.SmartContract(initialize), IContractInfo
{
    #region Compiled data

    public static Neo.SmartContract.Manifest.ContractManifest Manifest => Neo.SmartContract.Manifest.ContractManifest.Parse(@"{""name"":""OracleCallbackConsumer"",""groups"":[],""features"":{},""supportedstandards"":[],""abi"":{""methods"":[{""name"":""_deploy"",""parameters"":[{""name"":""data"",""type"":""Any""},{""name"":""update"",""type"":""Boolean""}],""returntype"":""Void"",""offset"":0,""safe"":false},{""name"":""admin"",""parameters"":[],""returntype"":""Hash160"",""offset"":45,""safe"":true},{""name"":""kernel"",""parameters"":[],""returntype"":""Hash160"",""offset"":76,""safe"":true},{""name"":""oracle"",""parameters"":[],""returntype"":""Hash160"",""offset"":101,""safe"":true},{""name"":""setAdmin"",""parameters"":[{""name"":""newAdmin"",""type"":""Hash160""}],""returntype"":""Void"",""offset"":104,""safe"":false},{""name"":""setKernel"",""parameters"":[{""name"":""kernel"",""type"":""Hash160""}],""returntype"":""Void"",""offset"":275,""safe"":false},{""name"":""setOracle"",""parameters"":[{""name"":""oracle"",""type"":""Hash160""}],""returntype"":""Void"",""offset"":357,""safe"":false},{""name"":""scheduleUpdate"",""parameters"":[{""name"":""nefFile"",""type"":""ByteArray""},{""name"":""manifest"",""type"":""String""}],""returntype"":""Void"",""offset"":364,""safe"":false},{""name"":""update"",""parameters"":[{""name"":""nefFile"",""type"":""ByteArray""},{""name"":""manifest"",""type"":""String""}],""returntype"":""Void"",""offset"":619,""safe"":false},{""name"":""cancelUpdate"",""parameters"":[],""returntype"":""Void"",""offset"":837,""safe"":false},{""name"":""onMiniAppResult"",""parameters"":[{""name"":""requestId"",""type"":""Integer""},{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""},{""name"":""operation"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""},{""name"":""success"",""type"":""Boolean""},{""name"":""result"",""type"":""ByteArray""},{""name"":""error"",""type"":""String""}],""returntype"":""Void"",""offset"":865,""safe"":false},{""name"":""onOracleResult"",""parameters"":[{""name"":""requestId"",""type"":""Integer""},{""name"":""requestType"",""type"":""String""},{""name"":""success"",""type"":""Boolean""},{""name"":""result"",""type"":""ByteArray""},{""name"":""error"",""type"":""String""}],""returntype"":""Void"",""offset"":1147,""safe"":false},{""name"":""getCallbackRecord"",""parameters"":[{""name"":""requestId"",""type"":""Integer""}],""returntype"":""Array"",""offset"":1204,""safe"":true},{""name"":""getCallback"",""parameters"":[{""name"":""requestId"",""type"":""Integer""}],""returntype"":""Array"",""offset"":1254,""safe"":true},{""name"":""_initialize"",""parameters"":[],""returntype"":""Void"",""offset"":1290,""safe"":false}],""events"":[{""name"":""MiniAppResultReceived"",""parameters"":[{""name"":""requestId"",""type"":""Integer""},{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""},{""name"":""operation"",""type"":""String""},{""name"":""success"",""type"":""Boolean""},{""name"":""error"",""type"":""String""}]},{""name"":""AdminChanged"",""parameters"":[{""name"":""oldAdmin"",""type"":""Hash160""},{""name"":""newAdmin"",""type"":""Hash160""}]},{""name"":""KernelChanged"",""parameters"":[{""name"":""oldKernel"",""type"":""Hash160""},{""name"":""newKernel"",""type"":""Hash160""}]},{""name"":""UpgradeScheduled"",""parameters"":[{""name"":""executeAfter"",""type"":""Integer""}]},{""name"":""ContractUpgraded"",""parameters"":[{""name"":""nefHash"",""type"":""ByteArray""},{""name"":""manifestHash"",""type"":""ByteArray""}]}]},""permissions"":[{""contract"":""*"",""methods"":""*""}],""trusts"":[],""extra"":{""Author"":""Morpheus Oracle"",""Version"":""2.0.0"",""Description"":""Optional external callback adapter for the Morpheus MiniApp OS"",""nef"":{""optimization"":""Basic""}}}");

    /// <summary>
    /// Optimization: "Basic"
    /// </summary>
    public static Neo.SmartContract.NefFile Nef => Convert.FromBase64String(@"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").AsSerializable<Neo.SmartContract.NefFile>();

    #endregion

    #region Events

    public delegate void delAdminChanged(UInt160? oldAdmin, UInt160? newAdmin);

    [DisplayName("AdminChanged")]
    public event delAdminChanged? OnAdminChanged;

    public delegate void delContractUpgraded(byte[]? nefHash, byte[]? manifestHash);

    [DisplayName("ContractUpgraded")]
    public event delContractUpgraded? OnContractUpgraded;

    public delegate void delKernelChanged(UInt160? oldKernel, UInt160? newKernel);

    [DisplayName("KernelChanged")]
    public event delKernelChanged? OnKernelChanged;

    public delegate void delMiniAppResultReceived(BigInteger? requestId, string? appId, string? moduleId, string? operation, bool? success, string? error);

    [DisplayName("MiniAppResultReceived")]
    public event delMiniAppResultReceived? OnMiniAppResultReceived;

    public delegate void delUpgradeScheduled(BigInteger? executeAfter);

    [DisplayName("UpgradeScheduled")]
    public event delUpgradeScheduled? OnUpgradeScheduled;

    #endregion

    #region Properties

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract UInt160? Admin { [DisplayName("admin")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract UInt160? Kernel { [DisplayName("kernel")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract UInt160? Oracle { [DisplayName("oracle")] get; }

    #endregion

    #region Safe methods

    /// <summary>
    /// Safe method
    /// </summary>
    [DisplayName("getCallback")]
    public abstract IList<object>? GetCallback(BigInteger? requestId);

    /// <summary>
    /// Safe method
    /// </summary>
    [DisplayName("getCallbackRecord")]
    public abstract IList<object>? GetCallbackRecord(BigInteger? requestId);

    #endregion

    #region Unsafe methods

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("cancelUpdate")]
    public abstract void CancelUpdate();

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("onMiniAppResult")]
    public abstract void OnMiniAppResult(BigInteger? requestId, string? appId, string? moduleId, string? operation, UInt160? requester, bool? success, byte[]? result, string? error);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("onOracleResult")]
    public abstract void OnOracleResult(BigInteger? requestId, string? requestType, bool? success, byte[]? result, string? error);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("scheduleUpdate")]
    public abstract void ScheduleUpdate(byte[]? nefFile, string? manifest);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("setAdmin")]
    public abstract void SetAdmin(UInt160? newAdmin);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("setKernel")]
    public abstract void SetKernel(UInt160? kernel);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("setOracle")]
    public abstract void SetOracle(UInt160? oracle);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("update")]
    public abstract void Update(byte[]? nefFile, string? manifest);

    #endregion
}
