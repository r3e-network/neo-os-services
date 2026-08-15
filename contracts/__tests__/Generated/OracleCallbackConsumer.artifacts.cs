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

    public static Neo.SmartContract.Manifest.ContractManifest Manifest => Neo.SmartContract.Manifest.ContractManifest.Parse(@"{""name"":""OracleCallbackConsumer"",""groups"":[],""features"":{},""supportedstandards"":[],""abi"":{""methods"":[{""name"":""_deploy"",""parameters"":[{""name"":""data"",""type"":""Any""},{""name"":""update"",""type"":""Boolean""}],""returntype"":""Void"",""offset"":0,""safe"":false},{""name"":""admin"",""parameters"":[],""returntype"":""Hash160"",""offset"":45,""safe"":true},{""name"":""kernel"",""parameters"":[],""returntype"":""Hash160"",""offset"":76,""safe"":true},{""name"":""oracle"",""parameters"":[],""returntype"":""Hash160"",""offset"":101,""safe"":true},{""name"":""setAdmin"",""parameters"":[{""name"":""newAdmin"",""type"":""Hash160""}],""returntype"":""Void"",""offset"":104,""safe"":false},{""name"":""setKernel"",""parameters"":[{""name"":""kernel"",""type"":""Hash160""}],""returntype"":""Void"",""offset"":275,""safe"":false},{""name"":""setOracle"",""parameters"":[{""name"":""oracle"",""type"":""Hash160""}],""returntype"":""Void"",""offset"":357,""safe"":false},{""name"":""update"",""parameters"":[{""name"":""nefFile"",""type"":""ByteArray""},{""name"":""manifest"",""type"":""String""}],""returntype"":""Void"",""offset"":364,""safe"":false},{""name"":""onMiniAppResult"",""parameters"":[{""name"":""requestId"",""type"":""Integer""},{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""},{""name"":""operation"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""},{""name"":""success"",""type"":""Boolean""},{""name"":""result"",""type"":""ByteArray""},{""name"":""error"",""type"":""String""}],""returntype"":""Void"",""offset"":383,""safe"":false},{""name"":""onOracleResult"",""parameters"":[{""name"":""requestId"",""type"":""Integer""},{""name"":""requestType"",""type"":""String""},{""name"":""success"",""type"":""Boolean""},{""name"":""result"",""type"":""ByteArray""},{""name"":""error"",""type"":""String""}],""returntype"":""Void"",""offset"":672,""safe"":false},{""name"":""getCallbackRecord"",""parameters"":[{""name"":""requestId"",""type"":""Integer""}],""returntype"":""Array"",""offset"":729,""safe"":true},{""name"":""getCallback"",""parameters"":[{""name"":""requestId"",""type"":""Integer""}],""returntype"":""Array"",""offset"":779,""safe"":true},{""name"":""_initialize"",""parameters"":[],""returntype"":""Void"",""offset"":815,""safe"":false}],""events"":[{""name"":""MiniAppResultReceived"",""parameters"":[{""name"":""requestId"",""type"":""Integer""},{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""},{""name"":""operation"",""type"":""String""},{""name"":""success"",""type"":""Boolean""},{""name"":""error"",""type"":""String""}]},{""name"":""AdminChanged"",""parameters"":[{""name"":""oldAdmin"",""type"":""Hash160""},{""name"":""newAdmin"",""type"":""Hash160""}]},{""name"":""KernelChanged"",""parameters"":[{""name"":""oldKernel"",""type"":""Hash160""},{""name"":""newKernel"",""type"":""Hash160""}]}]},""permissions"":[{""contract"":""*"",""methods"":""*""}],""trusts"":[],""extra"":{""Author"":""Morpheus Oracle"",""Version"":""2.0.0"",""Description"":""Optional external callback adapter for the Morpheus MiniApp OS"",""nef"":{""optimization"":""Basic""}}}");

    /// <summary>
    /// Optimization: "Basic"
    /// </summary>
    public static Neo.SmartContract.NefFile Nef => Convert.FromBase64String(@"TkVGM05lby5Db21waWxlci5DU2hhcnAgMy45LjErNWZhOTU2NmU1MTY1ZWRlMjE2NWE5YmUxZjRhMDEyMGMxNzYuLi4AAAP9o/pDRupTKiWPxJfdrdtkN8n9/wZ1cGRhdGUDAAAPwO85zuDk6SXGwqBqeeFEDdhvzqwJc2VyaWFsaXplAQABD8DvOc7g5OklxsKgannhRA3Yb86sC2Rlc2VyaWFsaXplAQABDwAA/UQDVwACeSYEIhRBLVEIMBPOWEGb9mfOQeY/GIRAQeY/GIRAQS1RCDBAQZv2Z85AWEGb9mfOQZJd6DFK2CQJSsoAFCgDOiICQEGSXegxQFlBm/ZnzkGSXegxStgkCUrKABQoAzoiAkA050BXAQE0S3gLmCQFCSIQeErZKCQGRQkiBsoAFLMkDAwHaW52YWxpZOA0nnB4WEGb9mfOQeY/GIR4aBLADAxBZG1pbkNoYW5nZWRBlQFvYUBXAQA1dP///3BoC5gkBQkiEGhK2SgkBkUJIgbKABSzJBIMDWFkbWluIG5vdCBzZXTgaEH4J+yMJBEMDHVuYXV0aG9yaXplZOBAStkoJAZFCSIGygAUs0BB+CfsjEBXAQE0oHgLmCQFCSIQeErZKCQGRQkiBsoAFLMkDAwHaW52YWxpZOA1Ev///3B4WUGb9mfOQeY/GIR4aBLADA1LZXJuZWxDaGFuZ2VkQZUBb2FAVwABeDSqQFcAAjVH////C3l4NwAAQDcAAEBXAAg0MX8HStgmBUUMAH5K2CYFRQwAfXx7StgmBUUMAHpK2CYFRQwAeUrYJgVFDAB4NFtAVwEANZb+//9waAuYJAUJIhBoStkoJAZFCSIGygAUsyQTDA5rZXJuZWwgbm90IHNldOBBOVNuPGiXJBgME3VuYXV0aG9yaXplZCBjYWxsZXLgQEE5U248QFcBCHg0c0Gb9mfOQZJd6DELlyQeDBljYWxsYmFjayBhbHJlYWR5IHJlY29yZGVk4EG3w4gDfwd+fXx7enkYv3BoNwEAeDQyQZv2Z85B5j8YhH8HfXt6eXgWwAwVTWluaUFwcFJlc3VsdFJlY2VpdmVkQZUBb2FAVwABWnjbMNsoiyICQItA2yhAQEG3w4gDQDcBAEBAVwAFNRD///98StgmBUUMAHtK2CYFRQwAegt5StgmBUUMAHlK2CYFRQwADAZsZWdhY3l4NTj///9AVwEBeDSlQZv2Z85Bkl3oMXBoC5cmExAMAAwACQsMAAwADAAYvyIIaDcCACICQDcCAEBXAQF4NMpwaBfOaBbOaBXOaBTOaBPOaBLOaBHOaBDOGMAiAkBWAwwBAdswYAwBAtswYQwBENswYkBOrb8s").AsSerializable<Neo.SmartContract.NefFile>();

    #endregion

    #region Events

    public delegate void delAdminChanged(UInt160? oldAdmin, UInt160? newAdmin);

    [DisplayName("AdminChanged")]
    public event delAdminChanged? OnAdminChanged;

    public delegate void delKernelChanged(UInt160? oldKernel, UInt160? newKernel);

    [DisplayName("KernelChanged")]
    public event delKernelChanged? OnKernelChanged;

    public delegate void delMiniAppResultReceived(BigInteger? requestId, string? appId, string? moduleId, string? operation, bool? success, string? error);

    [DisplayName("MiniAppResultReceived")]
    public event delMiniAppResultReceived? OnMiniAppResultReceived;

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
