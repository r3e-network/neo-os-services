using Neo.Cryptography.ECC;
using Neo.Extensions;
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Numerics;

#pragma warning disable CS0067

namespace Neo.SmartContract.Testing;

public abstract class NeoDIDRegistry(Neo.SmartContract.Testing.SmartContractInitialize initialize) : Neo.SmartContract.Testing.SmartContract(initialize), IContractInfo
{
    #region Compiled data

    public static Neo.SmartContract.Manifest.ContractManifest Manifest => Neo.SmartContract.Manifest.ContractManifest.Parse(@"{""name"":""NeoDIDRegistry"",""groups"":[],""features"":{},""supportedstandards"":[],""abi"":{""methods"":[{""name"":""_deploy"",""parameters"":[{""name"":""data"",""type"":""Any""},{""name"":""update"",""type"":""Boolean""}],""returntype"":""Void"",""offset"":0,""safe"":false},{""name"":""admin"",""parameters"":[],""returntype"":""Hash160"",""offset"":45,""safe"":true},{""name"":""verifier"",""parameters"":[],""returntype"":""PublicKey"",""offset"":76,""safe"":true},{""name"":""proposeAdmin"",""parameters"":[{""name"":""newAdmin"",""type"":""Hash160""}],""returntype"":""Void"",""offset"":135,""safe"":false},{""name"":""executeAdminChange"",""parameters"":[],""returntype"":""Void"",""offset"":423,""safe"":false},{""name"":""cancelAdminChange"",""parameters"":[],""returntype"":""Void"",""offset"":605,""safe"":false},{""name"":""setVerifier"",""parameters"":[{""name"":""publicKey"",""type"":""PublicKey""}],""returntype"":""Void"",""offset"":633,""safe"":false},{""name"":""scheduleUpdate"",""parameters"":[{""name"":""nefFile"",""type"":""ByteArray""},{""name"":""manifest"",""type"":""String""}],""returntype"":""Void"",""offset"":746,""safe"":false},{""name"":""update"",""parameters"":[{""name"":""nefFile"",""type"":""ByteArray""},{""name"":""manifest"",""type"":""String""}],""returntype"":""Void"",""offset"":989,""safe"":false},{""name"":""cancelUpdate"",""parameters"":[],""returntype"":""Void"",""offset"":1190,""safe"":false},{""name"":""registerBinding"",""parameters"":[{""name"":""vaultAccount"",""type"":""Hash160""},{""name"":""provider"",""type"":""String""},{""name"":""claimType"",""type"":""String""},{""name"":""claimValue"",""type"":""String""},{""name"":""masterNullifier"",""type"":""ByteArray""},{""name"":""metadataHash"",""type"":""ByteArray""},{""name"":""verificationSignature"",""type"":""ByteArray""}],""returntype"":""Void"",""offset"":1218,""safe"":false},{""name"":""revokeBinding"",""parameters"":[{""name"":""vaultAccount"",""type"":""Hash160""},{""name"":""provider"",""type"":""String""},{""name"":""claimType"",""type"":""String""}],""returntype"":""Void"",""offset"":2675,""safe"":false},{""name"":""getBinding"",""parameters"":[{""name"":""vaultAccount"",""type"":""Hash160""},{""name"":""provider"",""type"":""String""},{""name"":""claimType"",""type"":""String""}],""returntype"":""Array"",""offset"":1839,""safe"":true},{""name"":""isMasterNullifierUsed"",""parameters"":[{""name"":""masterNullifier"",""type"":""ByteArray""}],""returntype"":""Boolean"",""offset"":1775,""safe"":true},{""name"":""isActionNullifierUsed"",""parameters"":[{""name"":""actionNullifier"",""type"":""ByteArray""}],""returntype"":""Boolean"",""offset"":2928,""safe"":true},{""name"":""useActionTicket"",""parameters"":[{""name"":""disposableAccount"",""type"":""Hash160""},{""name"":""actionId"",""type"":""String""},{""name"":""actionNullifier"",""type"":""ByteArray""},{""name"":""verificationSignature"",""type"":""ByteArray""}],""returntype"":""Boolean"",""offset"":2979,""safe"":false},{""name"":""_initialize"",""parameters"":[],""returntype"":""Void"",""offset"":3303,""safe"":false}],""events"":[{""name"":""BindingRegistered"",""parameters"":[{""name"":""vaultAccount"",""type"":""Hash160""},{""name"":""provider"",""type"":""String""},{""name"":""claimType"",""type"":""String""},{""name"":""claimValue"",""type"":""String""},{""name"":""masterNullifier"",""type"":""ByteArray""},{""name"":""metadataHash"",""type"":""ByteArray""}]},{""name"":""BindingRevoked"",""parameters"":[{""name"":""vaultAccount"",""type"":""Hash160""},{""name"":""provider"",""type"":""String""},{""name"":""claimType"",""type"":""String""},{""name"":""masterNullifier"",""type"":""ByteArray""}]},{""name"":""ActionTicketUsed"",""parameters"":[{""name"":""disposableAccount"",""type"":""Hash160""},{""name"":""actionId"",""type"":""String""},{""name"":""actionNullifier"",""type"":""ByteArray""}]},{""name"":""AdminChanged"",""parameters"":[{""name"":""oldAdmin"",""type"":""Hash160""},{""name"":""newAdmin"",""type"":""Hash160""}]},{""name"":""AdminTimelockProposed"",""parameters"":[{""name"":""proposed"",""type"":""Hash160""},{""name"":""executeAfter"",""type"":""Integer""}]},{""name"":""UpgradeScheduled"",""parameters"":[{""name"":""executeAfter"",""type"":""Integer""}]},{""name"":""ContractUpgraded"",""parameters"":[{""name"":""nefHash"",""type"":""ByteArray""},{""name"":""manifestHash"",""type"":""ByteArray""}]},{""name"":""VerifierChanged"",""parameters"":[{""name"":""oldVerifier"",""type"":""PublicKey""},{""name"":""newVerifier"",""type"":""PublicKey""}]}]},""permissions"":[{""contract"":""0x726cb6e0cd8628a1350a611384688911ab75f51b"",""methods"":[""sha256"",""verifyWithECDsa""]},{""contract"":""0xacce6fd80d44e1796aa0c2c625e9e4e0ce39efc0"",""methods"":[""deserialize"",""serialize""]},{""contract"":""0xfffdc93764dbaddd97c48f252a53ea4643faa3fd"",""methods"":[""update""]}],""trusts"":[],""extra"":{""Author"":""Morpheus Oracle"",""Version"":""1.0.0"",""Description"":""Independent NeoDID binding and action-ticket registry"",""nef"":{""optimization"":""Basic""}}}");

    /// <summary>
    /// Optimization: "Basic"
    /// </summary>
    public static Neo.SmartContract.NefFile Nef => Convert.FromBase64String(@"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").AsSerializable<Neo.SmartContract.NefFile>();

    #endregion

    #region Events

    public delegate void delActionTicketUsed(UInt160? disposableAccount, string? actionId, byte[]? actionNullifier);

    [DisplayName("ActionTicketUsed")]
    public event delActionTicketUsed? OnActionTicketUsed;

    public delegate void delAdminChanged(UInt160? oldAdmin, UInt160? newAdmin);

    [DisplayName("AdminChanged")]
    public event delAdminChanged? OnAdminChanged;

    public delegate void delAdminTimelockProposed(UInt160? proposed, BigInteger? executeAfter);

    [DisplayName("AdminTimelockProposed")]
    public event delAdminTimelockProposed? OnAdminTimelockProposed;

    public delegate void delBindingRegistered(UInt160? vaultAccount, string? provider, string? claimType, string? claimValue, byte[]? masterNullifier, byte[]? metadataHash);

    [DisplayName("BindingRegistered")]
    public event delBindingRegistered? OnBindingRegistered;

    public delegate void delBindingRevoked(UInt160? vaultAccount, string? provider, string? claimType, byte[]? masterNullifier);

    [DisplayName("BindingRevoked")]
    public event delBindingRevoked? OnBindingRevoked;

    public delegate void delContractUpgraded(byte[]? nefHash, byte[]? manifestHash);

    [DisplayName("ContractUpgraded")]
    public event delContractUpgraded? OnContractUpgraded;

    public delegate void delUpgradeScheduled(BigInteger? executeAfter);

    [DisplayName("UpgradeScheduled")]
    public event delUpgradeScheduled? OnUpgradeScheduled;

    public delegate void delVerifierChanged(ECPoint? oldVerifier, ECPoint? newVerifier);

    [DisplayName("VerifierChanged")]
    public event delVerifierChanged? OnVerifierChanged;

    #endregion

    #region Properties

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract UInt160? Admin { [DisplayName("admin")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract ECPoint? Verifier { [DisplayName("verifier")] get; }

    #endregion

    #region Safe methods

    /// <summary>
    /// Safe method
    /// </summary>
    [DisplayName("getBinding")]
    public abstract IList<object>? GetBinding(UInt160? vaultAccount, string? provider, string? claimType);

    /// <summary>
    /// Safe method
    /// </summary>
    [DisplayName("isActionNullifierUsed")]
    public abstract bool? IsActionNullifierUsed(byte[]? actionNullifier);

    /// <summary>
    /// Safe method
    /// </summary>
    [DisplayName("isMasterNullifierUsed")]
    public abstract bool? IsMasterNullifierUsed(byte[]? masterNullifier);

    #endregion

    #region Unsafe methods

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("cancelAdminChange")]
    public abstract void CancelAdminChange();

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("cancelUpdate")]
    public abstract void CancelUpdate();

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
    [DisplayName("registerBinding")]
    public abstract void RegisterBinding(UInt160? vaultAccount, string? provider, string? claimType, string? claimValue, byte[]? masterNullifier, byte[]? metadataHash, byte[]? verificationSignature);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("revokeBinding")]
    public abstract void RevokeBinding(UInt160? vaultAccount, string? provider, string? claimType);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("scheduleUpdate")]
    public abstract void ScheduleUpdate(byte[]? nefFile, string? manifest);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("setVerifier")]
    public abstract void SetVerifier(ECPoint? publicKey);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("update")]
    public abstract void Update(byte[]? nefFile, string? manifest);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("useActionTicket")]
    public abstract bool? UseActionTicket(UInt160? disposableAccount, string? actionId, byte[]? actionNullifier, byte[]? verificationSignature);

    #endregion
}
