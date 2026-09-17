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

    public static Neo.SmartContract.Manifest.ContractManifest Manifest => Neo.SmartContract.Manifest.ContractManifest.Parse(@"{""name"":""NeoDIDRegistry"",""groups"":[],""features"":{},""supportedstandards"":[],""abi"":{""methods"":[{""name"":""registerBinding"",""parameters"":[{""name"":""vaultAccount"",""type"":""Hash160""},{""name"":""provider"",""type"":""String""},{""name"":""claimType"",""type"":""String""},{""name"":""claimValue"",""type"":""String""},{""name"":""masterNullifier"",""type"":""ByteArray""},{""name"":""metadataHash"",""type"":""ByteArray""},{""name"":""verificationSignature"",""type"":""ByteArray""}],""returntype"":""Void"",""offset"":0,""safe"":false},{""name"":""registerBindingCommitment"",""parameters"":[{""name"":""vaultAccount"",""type"":""Hash160""},{""name"":""provider"",""type"":""String""},{""name"":""claimType"",""type"":""String""},{""name"":""claimCommitment"",""type"":""ByteArray""},{""name"":""masterNullifier"",""type"":""ByteArray""},{""name"":""metadataHash"",""type"":""ByteArray""},{""name"":""verificationSignature"",""type"":""ByteArray""}],""returntype"":""Void"",""offset"":1647,""safe"":false},{""name"":""getClaimCommitment"",""parameters"":[{""name"":""vaultAccount"",""type"":""Hash160""},{""name"":""provider"",""type"":""String""},{""name"":""claimType"",""type"":""String""}],""returntype"":""ByteArray"",""offset"":2090,""safe"":true},{""name"":""_deploy"",""parameters"":[{""name"":""data"",""type"":""Any""},{""name"":""update"",""type"":""Boolean""}],""returntype"":""Void"",""offset"":2173,""safe"":false},{""name"":""proposeAdmin"",""parameters"":[{""name"":""newAdmin"",""type"":""Hash160""}],""returntype"":""Void"",""offset"":2212,""safe"":false},{""name"":""executeAdminChange"",""parameters"":[],""returntype"":""Void"",""offset"":2476,""safe"":false},{""name"":""cancelAdminChange"",""parameters"":[],""returntype"":""Void"",""offset"":2662,""safe"":false},{""name"":""setVerifier"",""parameters"":[{""name"":""publicKey"",""type"":""PublicKey""}],""returntype"":""Void"",""offset"":2692,""safe"":false},{""name"":""scheduleUpdate"",""parameters"":[{""name"":""nefFile"",""type"":""ByteArray""},{""name"":""manifest"",""type"":""String""}],""returntype"":""Void"",""offset"":3047,""safe"":false},{""name"":""update"",""parameters"":[{""name"":""nefFile"",""type"":""ByteArray""},{""name"":""manifest"",""type"":""String""}],""returntype"":""Void"",""offset"":3281,""safe"":false},{""name"":""cancelUpdate"",""parameters"":[],""returntype"":""Void"",""offset"":3486,""safe"":false},{""name"":""revokeBinding"",""parameters"":[{""name"":""vaultAccount"",""type"":""Hash160""},{""name"":""provider"",""type"":""String""},{""name"":""claimType"",""type"":""String""}],""returntype"":""Void"",""offset"":3516,""safe"":false},{""name"":""getBinding"",""parameters"":[{""name"":""vaultAccount"",""type"":""Hash160""},{""name"":""provider"",""type"":""String""},{""name"":""claimType"",""type"":""String""}],""returntype"":""Array"",""offset"":735,""safe"":true},{""name"":""isMasterNullifierUsed"",""parameters"":[{""name"":""masterNullifier"",""type"":""ByteArray""}],""returntype"":""Boolean"",""offset"":668,""safe"":true},{""name"":""isActionNullifierUsed"",""parameters"":[{""name"":""actionNullifier"",""type"":""ByteArray""}],""returntype"":""Boolean"",""offset"":3769,""safe"":true},{""name"":""useActionTicket"",""parameters"":[{""name"":""disposableAccount"",""type"":""Hash160""},{""name"":""actionId"",""type"":""String""},{""name"":""actionNullifier"",""type"":""ByteArray""},{""name"":""verificationSignature"",""type"":""ByteArray""}],""returntype"":""Boolean"",""offset"":3820,""safe"":false},{""name"":""admin"",""parameters"":[],""returntype"":""Hash160"",""offset"":631,""safe"":true},{""name"":""verifier"",""parameters"":[],""returntype"":""PublicKey"",""offset"":1545,""safe"":true},{""name"":""pendingVerifier"",""parameters"":[],""returntype"":""PublicKey"",""offset"":4144,""safe"":true},{""name"":""pendingVerifierChangeTime"",""parameters"":[],""returntype"":""Integer"",""offset"":4187,""safe"":true},{""name"":""proposeVerifier"",""parameters"":[{""name"":""publicKey"",""type"":""PublicKey""}],""returntype"":""Void"",""offset"":2805,""safe"":false},{""name"":""executeVerifierChange"",""parameters"":[],""returntype"":""Void"",""offset"":4225,""safe"":false},{""name"":""cancelVerifierChange"",""parameters"":[],""returntype"":""Void"",""offset"":4406,""safe"":false},{""name"":""_initialize"",""parameters"":[],""returntype"":""Void"",""offset"":4436,""safe"":false}],""events"":[{""name"":""BindingCommitmentRegistered"",""parameters"":[{""name"":""vaultAccount"",""type"":""Hash160""},{""name"":""provider"",""type"":""String""},{""name"":""claimType"",""type"":""String""},{""name"":""claimCommitment"",""type"":""ByteArray""},{""name"":""masterNullifier"",""type"":""ByteArray""},{""name"":""metadataHash"",""type"":""ByteArray""}]},{""name"":""BindingRegistered"",""parameters"":[{""name"":""vaultAccount"",""type"":""Hash160""},{""name"":""provider"",""type"":""String""},{""name"":""claimType"",""type"":""String""},{""name"":""claimValue"",""type"":""String""},{""name"":""masterNullifier"",""type"":""ByteArray""},{""name"":""metadataHash"",""type"":""ByteArray""}]},{""name"":""BindingRevoked"",""parameters"":[{""name"":""vaultAccount"",""type"":""Hash160""},{""name"":""provider"",""type"":""String""},{""name"":""claimType"",""type"":""String""},{""name"":""masterNullifier"",""type"":""ByteArray""}]},{""name"":""ActionTicketUsed"",""parameters"":[{""name"":""disposableAccount"",""type"":""Hash160""},{""name"":""actionId"",""type"":""String""},{""name"":""actionNullifier"",""type"":""ByteArray""}]},{""name"":""AdminChanged"",""parameters"":[{""name"":""oldAdmin"",""type"":""Hash160""},{""name"":""newAdmin"",""type"":""Hash160""}]},{""name"":""AdminTimelockProposed"",""parameters"":[{""name"":""proposed"",""type"":""Hash160""},{""name"":""executeAfter"",""type"":""Integer""}]},{""name"":""UpgradeScheduled"",""parameters"":[{""name"":""executeAfter"",""type"":""Integer""}]},{""name"":""ContractUpgraded"",""parameters"":[{""name"":""nefHash"",""type"":""ByteArray""},{""name"":""manifestHash"",""type"":""ByteArray""}]},{""name"":""VerifierChanged"",""parameters"":[{""name"":""oldVerifier"",""type"":""PublicKey""},{""name"":""newVerifier"",""type"":""PublicKey""}]},{""name"":""VerifierTimelockProposed"",""parameters"":[{""name"":""proposed"",""type"":""PublicKey""},{""name"":""executeAfter"",""type"":""Integer""}]}]},""permissions"":[{""contract"":""0x726cb6e0cd8628a1350a611384688911ab75f51b"",""methods"":[""sha256"",""verifyWithECDsa""]},{""contract"":""0xacce6fd80d44e1796aa0c2c625e9e4e0ce39efc0"",""methods"":[""deserialize"",""serialize""]},{""contract"":""0xfffdc93764dbaddd97c48f252a53ea4643faa3fd"",""methods"":[""update""]}],""trusts"":[],""extra"":{""Author"":""Morpheus Oracle"",""Version"":""1.0.0"",""Description"":""Independent NeoDID binding and action-ticket registry"",""nef"":{""optimization"":""Basic""}}}");

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

    public delegate void delBindingCommitmentRegistered(UInt160? vaultAccount, string? provider, string? claimType, byte[]? claimCommitment, byte[]? masterNullifier, byte[]? metadataHash);

    [DisplayName("BindingCommitmentRegistered")]
    public event delBindingCommitmentRegistered? OnBindingCommitmentRegistered;

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

    public delegate void delVerifierTimelockProposed(ECPoint? proposed, BigInteger? executeAfter);

    [DisplayName("VerifierTimelockProposed")]
    public event delVerifierTimelockProposed? OnVerifierTimelockProposed;

    #endregion

    #region Properties

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract UInt160? Admin { [DisplayName("admin")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract ECPoint? PendingVerifier { [DisplayName("pendingVerifier")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract BigInteger? PendingVerifierChangeTime { [DisplayName("pendingVerifierChangeTime")] get; }

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
    [DisplayName("getClaimCommitment")]
    public abstract byte[]? GetClaimCommitment(UInt160? vaultAccount, string? provider, string? claimType);

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
    [DisplayName("cancelVerifierChange")]
    public abstract void CancelVerifierChange();

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("executeAdminChange")]
    public abstract void ExecuteAdminChange();

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("executeVerifierChange")]
    public abstract void ExecuteVerifierChange();

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("proposeAdmin")]
    public abstract void ProposeAdmin(UInt160? newAdmin);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("proposeVerifier")]
    public abstract void ProposeVerifier(ECPoint? publicKey);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("registerBinding")]
    public abstract void RegisterBinding(UInt160? vaultAccount, string? provider, string? claimType, string? claimValue, byte[]? masterNullifier, byte[]? metadataHash, byte[]? verificationSignature);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("registerBindingCommitment")]
    public abstract void RegisterBindingCommitment(UInt160? vaultAccount, string? provider, string? claimType, byte[]? claimCommitment, byte[]? masterNullifier, byte[]? metadataHash, byte[]? verificationSignature);

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
