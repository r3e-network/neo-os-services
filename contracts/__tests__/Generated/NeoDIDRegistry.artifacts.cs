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

    public static Neo.SmartContract.Manifest.ContractManifest Manifest => Neo.SmartContract.Manifest.ContractManifest.Parse(@"{""name"":""NeoDIDRegistry"",""groups"":[],""features"":{},""supportedstandards"":[],""abi"":{""methods"":[{""name"":""_deploy"",""parameters"":[{""name"":""data"",""type"":""Any""},{""name"":""update"",""type"":""Boolean""}],""returntype"":""Void"",""offset"":0,""safe"":false},{""name"":""admin"",""parameters"":[],""returntype"":""Hash160"",""offset"":45,""safe"":true},{""name"":""verifier"",""parameters"":[],""returntype"":""PublicKey"",""offset"":76,""safe"":true},{""name"":""setAdmin"",""parameters"":[{""name"":""newAdmin"",""type"":""Hash160""}],""returntype"":""Void"",""offset"":135,""safe"":false},{""name"":""setVerifier"",""parameters"":[{""name"":""publicKey"",""type"":""PublicKey""}],""returntype"":""Void"",""offset"":315,""safe"":false},{""name"":""update"",""parameters"":[{""name"":""nefFile"",""type"":""ByteArray""},{""name"":""manifest"",""type"":""String""}],""returntype"":""Void"",""offset"":425,""safe"":false},{""name"":""registerBinding"",""parameters"":[{""name"":""vaultAccount"",""type"":""Hash160""},{""name"":""provider"",""type"":""String""},{""name"":""claimType"",""type"":""String""},{""name"":""claimValue"",""type"":""String""},{""name"":""masterNullifier"",""type"":""ByteArray""},{""name"":""metadataHash"",""type"":""ByteArray""},{""name"":""verificationSignature"",""type"":""ByteArray""}],""returntype"":""Void"",""offset"":444,""safe"":false},{""name"":""revokeBinding"",""parameters"":[{""name"":""vaultAccount"",""type"":""Hash160""},{""name"":""provider"",""type"":""String""},{""name"":""claimType"",""type"":""String""}],""returntype"":""Void"",""offset"":1916,""safe"":false},{""name"":""getBinding"",""parameters"":[{""name"":""vaultAccount"",""type"":""Hash160""},{""name"":""provider"",""type"":""String""},{""name"":""claimType"",""type"":""String""}],""returntype"":""Array"",""offset"":1067,""safe"":true},{""name"":""isMasterNullifierUsed"",""parameters"":[{""name"":""masterNullifier"",""type"":""ByteArray""}],""returntype"":""Boolean"",""offset"":1003,""safe"":true},{""name"":""isActionNullifierUsed"",""parameters"":[{""name"":""actionNullifier"",""type"":""ByteArray""}],""returntype"":""Boolean"",""offset"":2169,""safe"":true},{""name"":""useActionTicket"",""parameters"":[{""name"":""disposableAccount"",""type"":""Hash160""},{""name"":""actionId"",""type"":""String""},{""name"":""actionNullifier"",""type"":""ByteArray""},{""name"":""verificationSignature"",""type"":""ByteArray""}],""returntype"":""Boolean"",""offset"":2219,""safe"":false},{""name"":""_initialize"",""parameters"":[],""returntype"":""Void"",""offset"":2542,""safe"":false}],""events"":[{""name"":""BindingRegistered"",""parameters"":[{""name"":""vaultAccount"",""type"":""Hash160""},{""name"":""provider"",""type"":""String""},{""name"":""claimType"",""type"":""String""},{""name"":""claimValue"",""type"":""String""},{""name"":""masterNullifier"",""type"":""ByteArray""},{""name"":""metadataHash"",""type"":""ByteArray""}]},{""name"":""BindingRevoked"",""parameters"":[{""name"":""vaultAccount"",""type"":""Hash160""},{""name"":""provider"",""type"":""String""},{""name"":""claimType"",""type"":""String""},{""name"":""masterNullifier"",""type"":""ByteArray""}]},{""name"":""ActionTicketUsed"",""parameters"":[{""name"":""disposableAccount"",""type"":""Hash160""},{""name"":""actionId"",""type"":""String""},{""name"":""actionNullifier"",""type"":""ByteArray""}]},{""name"":""AdminChanged"",""parameters"":[{""name"":""oldAdmin"",""type"":""Hash160""},{""name"":""newAdmin"",""type"":""Hash160""}]},{""name"":""VerifierChanged"",""parameters"":[{""name"":""oldVerifier"",""type"":""PublicKey""},{""name"":""newVerifier"",""type"":""PublicKey""}]}]},""permissions"":[{""contract"":""0x726cb6e0cd8628a1350a611384688911ab75f51b"",""methods"":[""sha256"",""verifyWithECDsa""]},{""contract"":""0xacce6fd80d44e1796aa0c2c625e9e4e0ce39efc0"",""methods"":[""deserialize"",""serialize""]},{""contract"":""0xfffdc93764dbaddd97c48f252a53ea4643faa3fd"",""methods"":[""update""]}],""trusts"":[],""extra"":{""Author"":""Morpheus Oracle"",""Version"":""1.0.0"",""Description"":""Independent NeoDID binding and action-ticket registry"",""nef"":{""optimization"":""Basic""}}}");

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

    public delegate void delBindingRegistered(UInt160? vaultAccount, string? provider, string? claimType, string? claimValue, byte[]? masterNullifier, byte[]? metadataHash);

    [DisplayName("BindingRegistered")]
    public event delBindingRegistered? OnBindingRegistered;

    public delegate void delBindingRevoked(UInt160? vaultAccount, string? provider, string? claimType, byte[]? masterNullifier);

    [DisplayName("BindingRevoked")]
    public event delBindingRevoked? OnBindingRevoked;

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
    [DisplayName("setAdmin")]
    public abstract void SetAdmin(UInt160? newAdmin);

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
