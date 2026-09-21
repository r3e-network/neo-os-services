using Neo.Cryptography.ECC;
using Neo.Extensions;
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Numerics;

#pragma warning disable CS0067

namespace Neo.SmartContract.Testing;

public abstract class MorpheusOracle(Neo.SmartContract.Testing.SmartContractInitialize initialize) : Neo.SmartContract.Testing.SmartContract(initialize), IContractInfo
{
    #region Compiled data

    public static Neo.SmartContract.Manifest.ContractManifest Manifest => Neo.SmartContract.Manifest.ContractManifest.Parse(@"{""name"":""MorpheusOracle"",""groups"":[],""features"":{},""supportedstandards"":[],""abi"":{""methods"":[{""name"":""_deploy"",""parameters"":[{""name"":""data"",""type"":""Any""},{""name"":""update"",""type"":""Boolean""}],""returntype"":""Void"",""offset"":0,""safe"":false},{""name"":""admin"",""parameters"":[],""returntype"":""Hash160"",""offset"":972,""safe"":true},{""name"":""updater"",""parameters"":[],""returntype"":""Hash160"",""offset"":997,""safe"":true},{""name"":""runtimeEncryptionAlgorithm"",""parameters"":[],""returntype"":""String"",""offset"":1023,""safe"":true},{""name"":""runtimeEncryptionPublicKey"",""parameters"":[],""returntype"":""String"",""offset"":1039,""safe"":true},{""name"":""runtimeEncryptionKeyVersion"",""parameters"":[],""returntype"":""Integer"",""offset"":1054,""safe"":true},{""name"":""runtimeVerificationPublicKey"",""parameters"":[],""returntype"":""PublicKey"",""offset"":1092,""safe"":true},{""name"":""oracleEncryptionAlgorithm"",""parameters"":[],""returntype"":""String"",""offset"":1152,""safe"":true},{""name"":""oracleEncryptionPublicKey"",""parameters"":[],""returntype"":""String"",""offset"":1158,""safe"":true},{""name"":""oracleEncryptionKeyVersion"",""parameters"":[],""returntype"":""Integer"",""offset"":1161,""safe"":true},{""name"":""oracleVerificationPublicKey"",""parameters"":[],""returntype"":""PublicKey"",""offset"":1164,""safe"":true},{""name"":""systemRequestFee"",""parameters"":[],""returntype"":""Integer"",""offset"":1167,""safe"":true},{""name"":""requestFee"",""parameters"":[],""returntype"":""Integer"",""offset"":1208,""safe"":true},{""name"":""requestTTL"",""parameters"":[],""returntype"":""Integer"",""offset"":1211,""safe"":true},{""name"":""feeCreditOf"",""parameters"":[{""name"":""requester"",""type"":""Hash160""}],""returntype"":""Integer"",""offset"":1253,""safe"":true},{""name"":""accruedRequestFees"",""parameters"":[],""returntype"":""Integer"",""offset"":1360,""safe"":true},{""name"":""reservedRequestFees"",""parameters"":[],""returntype"":""Integer"",""offset"":1398,""safe"":true},{""name"":""withdrawableFees"",""parameters"":[],""returntype"":""Integer"",""offset"":1436,""safe"":true},{""name"":""getMiniAppCount"",""parameters"":[],""returntype"":""Integer"",""offset"":508,""safe"":true},{""name"":""getSystemModuleCount"",""parameters"":[],""returntype"":""Integer"",""offset"":892,""safe"":true},{""name"":""getMiniAppIdByIndex"",""parameters"":[{""name"":""index"",""type"":""Integer""}],""returntype"":""String"",""offset"":1523,""safe"":true},{""name"":""getSystemModuleIdByIndex"",""parameters"":[{""name"":""index"",""type"":""Integer""}],""returntype"":""String"",""offset"":1586,""safe"":true},{""name"":""getAllMiniAppIds"",""parameters"":[],""returntype"":""Array"",""offset"":1642,""safe"":true},{""name"":""getAllSystemModuleIds"",""parameters"":[],""returntype"":""Array"",""offset"":1749,""safe"":true},{""name"":""getMiniApp"",""parameters"":[{""name"":""appId"",""type"":""String""}],""returntype"":""Array"",""offset"":1856,""safe"":true},{""name"":""getSystemModule"",""parameters"":[{""name"":""moduleId"",""type"":""String""}],""returntype"":""Array"",""offset"":655,""safe"":true},{""name"":""isModuleGrantedToMiniApp"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""}],""returntype"":""Boolean"",""offset"":1951,""safe"":true},{""name"":""getMiniAppRequestCount"",""parameters"":[{""name"":""appId"",""type"":""String""}],""returntype"":""Integer"",""offset"":2090,""safe"":true},{""name"":""getMiniAppFulfilledCount"",""parameters"":[{""name"":""appId"",""type"":""String""}],""returntype"":""Integer"",""offset"":2163,""safe"":true},{""name"":""getTotalRequests"",""parameters"":[],""returntype"":""Integer"",""offset"":2236,""safe"":true},{""name"":""getTotalFulfilled"",""parameters"":[],""returntype"":""Integer"",""offset"":2274,""safe"":true},{""name"":""isIndexRebuildRequired"",""parameters"":[],""returntype"":""Boolean"",""offset"":2312,""safe"":true},{""name"":""indexRebuildCursor"",""parameters"":[],""returntype"":""Integer"",""offset"":2328,""safe"":true},{""name"":""getRequest"",""parameters"":[{""name"":""requestId"",""type"":""Integer""}],""returntype"":""Array"",""offset"":2365,""safe"":true},{""name"":""getInboxItem"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requestId"",""type"":""Integer""}],""returntype"":""Array"",""offset"":2432,""safe"":true},{""name"":""getMiniAppState"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""stateKey"",""type"":""ByteArray""}],""returntype"":""ByteArray"",""offset"":2543,""safe"":true},{""name"":""isSponsorshipGated"",""parameters"":[{""name"":""appId"",""type"":""String""}],""returntype"":""Boolean"",""offset"":2694,""safe"":true},{""name"":""isSponsoredRequesterAllowed"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""}],""returntype"":""Boolean"",""offset"":2778,""safe"":true},{""name"":""getSponsoredRequesterCap"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""}],""returntype"":""Integer"",""offset"":2887,""safe"":true},{""name"":""getSponsoredRequesterSpent"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""}],""returntype"":""Integer"",""offset"":2991,""safe"":true},{""name"":""proposeAdmin"",""parameters"":[{""name"":""newAdmin"",""type"":""Hash160""}],""returntype"":""Void"",""offset"":3098,""safe"":false},{""name"":""executeAdminChange"",""parameters"":[],""returntype"":""Void"",""offset"":3362,""safe"":false},{""name"":""cancelAdminChange"",""parameters"":[],""returntype"":""Void"",""offset"":3531,""safe"":false},{""name"":""setUpdater"",""parameters"":[{""name"":""updater"",""type"":""Hash160""}],""returntype"":""Void"",""offset"":3561,""safe"":false},{""name"":""proposeRuntimeEncryptionKey"",""parameters"":[{""name"":""algorithm"",""type"":""String""},{""name"":""publicKey"",""type"":""String""}],""returntype"":""Void"",""offset"":3656,""safe"":false},{""name"":""executeRuntimeEncryptionKey"",""parameters"":[],""returntype"":""Void"",""offset"":3932,""safe"":false},{""name"":""cancelRuntimeEncryptionKey"",""parameters"":[],""returntype"":""Void"",""offset"":4118,""safe"":false},{""name"":""pendingRuntimeEncryptionKeyEta"",""parameters"":[],""returntype"":""Integer"",""offset"":4136,""safe"":true},{""name"":""proposeRuntimeVerificationPublicKey"",""parameters"":[{""name"":""publicKey"",""type"":""PublicKey""}],""returntype"":""Void"",""offset"":4169,""safe"":false},{""name"":""executeRuntimeVerificationPublicKey"",""parameters"":[],""returntype"":""Void"",""offset"":4366,""safe"":false},{""name"":""cancelRuntimeVerificationPublicKey"",""parameters"":[],""returntype"":""Void"",""offset"":4532,""safe"":false},{""name"":""pendingRuntimeVerificationKeyEta"",""parameters"":[],""returntype"":""Integer"",""offset"":4550,""safe"":true},{""name"":""setOracleEncryptionKey"",""parameters"":[{""name"":""algorithm"",""type"":""String""},{""name"":""publicKey"",""type"":""String""}],""returntype"":""Void"",""offset"":4583,""safe"":false},{""name"":""setOracleVerificationPublicKey"",""parameters"":[{""name"":""publicKey"",""type"":""PublicKey""}],""returntype"":""Void"",""offset"":4594,""safe"":false},{""name"":""setRequestFee"",""parameters"":[{""name"":""amount"",""type"":""Integer""}],""returntype"":""Void"",""offset"":4604,""safe"":false},{""name"":""withdrawAccruedFees"",""parameters"":[{""name"":""to"",""type"":""Hash160""},{""name"":""amount"",""type"":""Integer""}],""returntype"":""Void"",""offset"":4686,""safe"":false},{""name"":""setRequestTTL"",""parameters"":[{""name"":""ttlMs"",""type"":""Integer""}],""returntype"":""Void"",""offset"":4921,""safe"":false},{""name"":""expireStaleRequest"",""parameters"":[{""name"":""requestId"",""type"":""Integer""}],""returntype"":""Void"",""offset"":5005,""safe"":false},{""name"":""registerSystemModule"",""parameters"":[{""name"":""moduleId"",""type"":""String""},{""name"":""endpoint"",""type"":""String""},{""name"":""schemaHash"",""type"":""String""}],""returntype"":""Void"",""offset"":5827,""safe"":false},{""name"":""configureSystemModule"",""parameters"":[{""name"":""moduleId"",""type"":""String""},{""name"":""endpoint"",""type"":""String""},{""name"":""schemaHash"",""type"":""String""},{""name"":""active"",""type"":""Boolean""}],""returntype"":""Void"",""offset"":6056,""safe"":false},{""name"":""registerMiniApp"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""appAdmin"",""type"":""Hash160""},{""name"":""feePayer"",""type"":""Hash160""},{""name"":""callbackContract"",""type"":""Hash160""},{""name"":""metadataUri"",""type"":""String""},{""name"":""metadataHash"",""type"":""String""}],""returntype"":""Void"",""offset"":6150,""safe"":false},{""name"":""configureMiniApp"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""feePayer"",""type"":""Hash160""},{""name"":""callbackContract"",""type"":""Hash160""},{""name"":""metadataUri"",""type"":""String""},{""name"":""metadataHash"",""type"":""String""},{""name"":""active"",""type"":""Boolean""}],""returntype"":""Void"",""offset"":7247,""safe"":false},{""name"":""setSponsoredRequesterAllowed"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""},{""name"":""allowed"",""type"":""Boolean""}],""returntype"":""Void"",""offset"":7476,""safe"":false},{""name"":""setSponsoredRequesterCap"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""},{""name"":""cap"",""type"":""Integer""}],""returntype"":""Void"",""offset"":7652,""safe"":false},{""name"":""grantModuleToMiniApp"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""}],""returntype"":""Void"",""offset"":7826,""safe"":false},{""name"":""revokeModuleFromMiniApp"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""}],""returntype"":""Void"",""offset"":7972,""safe"":false},{""name"":""putMiniAppState"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""stateKey"",""type"":""ByteArray""},{""name"":""value"",""type"":""ByteArray""}],""returntype"":""Void"",""offset"":8073,""safe"":false},{""name"":""putMiniAppStateBatch"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""stateKeys"",""type"":""Array""},{""name"":""values"",""type"":""Array""}],""returntype"":""Void"",""offset"":8340,""safe"":false},{""name"":""deleteMiniAppState"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""stateKey"",""type"":""ByteArray""}],""returntype"":""Void"",""offset"":8612,""safe"":false},{""name"":""submitMiniAppRequest"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""},{""name"":""operation"",""type"":""String""},{""name"":""payload"",""type"":""ByteArray""}],""returntype"":""Integer"",""offset"":8688,""safe"":false},{""name"":""submitMiniAppRequestFromIntegration"",""parameters"":[{""name"":""requester"",""type"":""Hash160""},{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""},{""name"":""operation"",""type"":""String""},{""name"":""payload"",""type"":""ByteArray""}],""returntype"":""Integer"",""offset"":9813,""safe"":false},{""name"":""requestFromCallback"",""parameters"":[{""name"":""requester"",""type"":""Hash160""},{""name"":""requestType"",""type"":""String""},{""name"":""payload"",""type"":""ByteArray""},{""name"":""callbackContract"",""type"":""Hash160""},{""name"":""callbackMethod"",""type"":""String""}],""returntype"":""Integer"",""offset"":9985,""safe"":false},{""name"":""queueSystemRequest"",""parameters"":[{""name"":""requester"",""type"":""Hash160""},{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""},{""name"":""operation"",""type"":""String""},{""name"":""payload"",""type"":""ByteArray""}],""returntype"":""Integer"",""offset"":10620,""safe"":false},{""name"":""queueAutomationRequest"",""parameters"":[{""name"":""requester"",""type"":""Hash160""},{""name"":""requestType"",""type"":""String""},{""name"":""payload"",""type"":""ByteArray""},{""name"":""callbackContract"",""type"":""Hash160""},{""name"":""callbackMethod"",""type"":""String""}],""returntype"":""Integer"",""offset"":10758,""safe"":false},{""name"":""request"",""parameters"":[{""name"":""requestType"",""type"":""String""},{""name"":""payload"",""type"":""ByteArray""},{""name"":""callbackContract"",""type"":""Hash160""},{""name"":""callbackMethod"",""type"":""String""}],""returntype"":""Integer"",""offset"":10904,""safe"":false},{""name"":""onNEP17Payment"",""parameters"":[{""name"":""from"",""type"":""Hash160""},{""name"":""amount"",""type"":""Integer""},{""name"":""data"",""type"":""Any""}],""returntype"":""Void"",""offset"":11049,""safe"":false},{""name"":""fulfillRequest"",""parameters"":[{""name"":""requestId"",""type"":""Integer""},{""name"":""success"",""type"":""Boolean""},{""name"":""result"",""type"":""ByteArray""},{""name"":""error"",""type"":""String""},{""name"":""verificationSignature"",""type"":""ByteArray""}],""returntype"":""Void"",""offset"":11529,""safe"":false},{""name"":""scheduleUpdate"",""parameters"":[{""name"":""nefFile"",""type"":""ByteArray""},{""name"":""manifest"",""type"":""String""}],""returntype"":""Void"",""offset"":12835,""safe"":false},{""name"":""update"",""parameters"":[{""name"":""nefFile"",""type"":""ByteArray""},{""name"":""manifest"",""type"":""String""}],""returntype"":""Void"",""offset"":13017,""safe"":false},{""name"":""cancelUpdate"",""parameters"":[],""returntype"":""Void"",""offset"":13222,""safe"":false},{""name"":""rebuildIndexes"",""parameters"":[{""name"":""startIndex"",""type"":""Integer""},{""name"":""count"",""type"":""Integer""}],""returntype"":""Void"",""offset"":13252,""safe"":false},{""name"":""defaultSponsoredRequesterCap"",""parameters"":[],""returntype"":""Integer"",""offset"":9354,""safe"":true},{""name"":""setDefaultSponsoredRequesterCap"",""parameters"":[{""name"":""cap"",""type"":""Integer""}],""returntype"":""Void"",""offset"":13688,""safe"":false},{""name"":""isSponsorshipOpen"",""parameters"":[{""name"":""appId"",""type"":""String""}],""returntype"":""Boolean"",""offset"":13770,""safe"":true},{""name"":""setSponsorshipOpen"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""open"",""type"":""Boolean""}],""returntype"":""Void"",""offset"":13808,""safe"":false},{""name"":""_initialize"",""parameters"":[],""returntype"":""Void"",""offset"":13883,""safe"":false}],""events"":[{""name"":""MiniAppRegistered"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""admin"",""type"":""Hash160""},{""name"":""feePayer"",""type"":""Hash160""},{""name"":""callbackContract"",""type"":""Hash160""}]},{""name"":""MiniAppUpdated"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""admin"",""type"":""Hash160""},{""name"":""feePayer"",""type"":""Hash160""},{""name"":""callbackContract"",""type"":""Hash160""},{""name"":""active"",""type"":""Boolean""}]},{""name"":""SystemModuleRegistered"",""parameters"":[{""name"":""moduleId"",""type"":""String""},{""name"":""endpoint"",""type"":""String""},{""name"":""schemaHash"",""type"":""String""}]},{""name"":""SystemModuleUpdated"",""parameters"":[{""name"":""moduleId"",""type"":""String""},{""name"":""endpoint"",""type"":""String""},{""name"":""schemaHash"",""type"":""String""},{""name"":""active"",""type"":""Boolean""}]},{""name"":""MiniAppCapabilityGranted"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""}]},{""name"":""MiniAppCapabilityRevoked"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""}]},{""name"":""MiniAppRequestQueued"",""parameters"":[{""name"":""requestId"",""type"":""Integer""},{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""},{""name"":""operation"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""},{""name"":""sponsor"",""type"":""Hash160""},{""name"":""payload"",""type"":""ByteArray""}]},{""name"":""MiniAppRequestCompleted"",""parameters"":[{""name"":""requestId"",""type"":""Integer""},{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""},{""name"":""operation"",""type"":""String""},{""name"":""success"",""type"":""Boolean""},{""name"":""resultHash"",""type"":""ByteArray""},{""name"":""resultSize"",""type"":""Integer""},{""name"":""error"",""type"":""String""}]},{""name"":""MiniAppInboxStored"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requestId"",""type"":""Integer""},{""name"":""requester"",""type"":""Hash160""},{""name"":""success"",""type"":""Boolean""}]},{""name"":""MiniAppStateChanged"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""stateKey"",""type"":""ByteArray""},{""name"":""valueSize"",""type"":""Integer""}]},{""name"":""AdminChanged"",""parameters"":[{""name"":""oldAdmin"",""type"":""Hash160""},{""name"":""newAdmin"",""type"":""Hash160""}]},{""name"":""UpdaterChanged"",""parameters"":[{""name"":""oldUpdater"",""type"":""Hash160""},{""name"":""newUpdater"",""type"":""Hash160""}]},{""name"":""RuntimeEncryptionKeyUpdated"",""parameters"":[{""name"":""version"",""type"":""Integer""},{""name"":""algorithm"",""type"":""String""},{""name"":""publicKey"",""type"":""String""}]},{""name"":""RuntimeVerifierUpdated"",""parameters"":[{""name"":""oldVerifier"",""type"":""PublicKey""},{""name"":""newVerifier"",""type"":""PublicKey""}]},{""name"":""RequestFeeUpdated"",""parameters"":[{""name"":""oldFee"",""type"":""Integer""},{""name"":""newFee"",""type"":""Integer""}]},{""name"":""RequestFeeDeposited"",""parameters"":[{""name"":""from"",""type"":""Hash160""},{""name"":""amount"",""type"":""Integer""},{""name"":""creditBalance"",""type"":""Integer""}]},{""name"":""AccruedFeesWithdrawn"",""parameters"":[{""name"":""to"",""type"":""Hash160""},{""name"":""amount"",""type"":""Integer""}]},{""name"":""RequestExpired"",""parameters"":[{""name"":""requestId"",""type"":""Integer""},{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""},{""name"":""sponsor"",""type"":""Hash160""},{""name"":""refundAmount"",""type"":""Integer""}]},{""name"":""RequestTTLUpdated"",""parameters"":[{""name"":""oldTTL"",""type"":""Integer""},{""name"":""newTTL"",""type"":""Integer""}]},{""name"":""SponsoredRequesterAllowed"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""},{""name"":""allowed"",""type"":""Boolean""}]},{""name"":""SponsoredRequesterCapUpdated"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""},{""name"":""cap"",""type"":""Integer""}]},{""name"":""AdminTimelockProposed"",""parameters"":[{""name"":""proposed"",""type"":""Hash160""},{""name"":""executeAfter"",""type"":""Integer""}]},{""name"":""UpgradeScheduled"",""parameters"":[{""name"":""executeAfter"",""type"":""Integer""}]},{""name"":""ContractUpgraded"",""parameters"":[{""name"":""nefHash"",""type"":""ByteArray""},{""name"":""manifestHash"",""type"":""ByteArray""}]},{""name"":""SecurityKeyChangeProposed"",""parameters"":[{""name"":""kind"",""type"":""String""},{""name"":""executeAfter"",""type"":""Integer""}]},{""name"":""SponsorshipModeChanged"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""mode"",""type"":""Integer""}]},{""name"":""SponsorDefaultCapUpdated"",""parameters"":[{""name"":""oldCap"",""type"":""Integer""},{""name"":""newCap"",""type"":""Integer""}]}]},""permissions"":[{""contract"":""0x726cb6e0cd8628a1350a611384688911ab75f51b"",""methods"":[""sha256"",""verifyWithECDsa""]},{""contract"":""0xacce6fd80d44e1796aa0c2c625e9e4e0ce39efc0"",""methods"":[""deserialize"",""serialize""]},{""contract"":""0xd2a4cff31913016155e38e474a2c06d08be276cf"",""methods"":[""transfer""]},{""contract"":""0xfffdc93764dbaddd97c48f252a53ea4643faa3fd"",""methods"":[""update""]},{""contract"":""*"",""methods"":[""onMiniAppResult"",""onOracleResult""]}],""trusts"":[],""extra"":{""Author"":""Morpheus Oracle"",""Version"":""2.0.0"",""Description"":""MiniApp OS kernel with shared IO, registration, and callback orchestration"",""nef"":{""optimization"":""Basic""}}}");

    /// <summary>
    /// Optimization: "Basic"
    /// </summary>
    public static Neo.SmartContract.NefFile Nef => Convert.FromBase64String(@"TkVGM05lby5Db21waWxlci5DU2hhcnAgMy45LjErNWZhOTU2NmU1MTY1ZWRlMjE2NWE5YmUxZjRhMDEyMGMxNzYuLi4AAAbA7znO4OTpJcbCoGp54UQN2G/OrAtkZXNlcmlhbGl6ZQEAAQ/A7znO4OTpJcbCoGp54UQN2G/OrAlzZXJpYWxpemUBAAEPG/V1qxGJaIQTYQo1oSiGzeC2bHIGc2hhMjU2AQABD8924ovQBixKR47jVWEBExnzz6TSCHRyYW5zZmVyBAABDxv1dasRiWiEE2EKNaEohs3gtmxyD3ZlcmlmeVdpdGhFQ0RzYQQAAQ/9o/pDRupTKiWPxJfdrdtkN8n9/wZ1cGRhdGUDAAAPAAD9dTdXAQJ5Jic19gEAABC3JhkRWUGb9mfOQeY/GIRaQZv2Z85BL1jF7SPVAQAAQS1RCDBwaBPOW0Gb9mfOQeY/GIQQXEGb9mfOQeY/GIQCQEIPAF1Bm/ZnzkHmPxiEDB9tb3JwaGV1cy5tb2R1bGUub3JhY2xlLmZldGNoLnYxDBMvb3JhY2xlL3NtYXJ0LWZldGNoDAxvcmFjbGUuZmV0Y2g1sQEAAAwebW9ycGhldXMubW9kdWxlLmNvbXB1dGUucnVuLnYxDBAvY29tcHV0ZS9leGVjdXRlDAtjb21wdXRlLnJ1bjVtAQAADBxtb3JwaGV1cy5tb2R1bGUuZmVlZC5yZWFkLnYxDAwvb3JhY2xlL2ZlZWQMCWZlZWQucmVhZDUxAQAADB9tb3JwaGV1cy5tb2R1bGUuZmVlZC5wdWJsaXNoLnYxDAwvb3JhY2xlL2ZlZWQMDGZlZWQucHVibGlzaDXvAAAADCJtb3JwaGV1cy5tb2R1bGUuaWRlbnRpdHkudmVyaWZ5LnYxDA8vbmVvZGlkL3Jlc29sdmUMD2lkZW50aXR5LnZlcmlmeTWkAAAADCFtb3JwaGV1cy5tb2R1bGUuYXV0b21hdGlvbi5ydW4udjEMEy9hdXRvbWF0aW9uL2V4ZWN1dGUMDmF1dG9tYXRpb24ucnVuNFdAVwEAWEGb9mfOQZJd6DFwaAuXJgUQIg1oStgmBkUQIgTbISICQEGSXegxQEGb9mfOQErYJgZFECIE2yFAQeY/GIRAQS9Yxe1AQS1RCDBAQeY/GIRAVwADeDQ7FM4QtyYEIjJBt8OIAwh6eXg1sgAA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").AsSerializable<Neo.SmartContract.NefFile>();

    #endregion

    #region Events

    public delegate void delAccruedFeesWithdrawn(UInt160? to, BigInteger? amount);

    [DisplayName("AccruedFeesWithdrawn")]
    public event delAccruedFeesWithdrawn? OnAccruedFeesWithdrawn;

    public delegate void delAdminChanged(UInt160? oldAdmin, UInt160? newAdmin);

    [DisplayName("AdminChanged")]
    public event delAdminChanged? OnAdminChanged;

    public delegate void delAdminTimelockProposed(UInt160? proposed, BigInteger? executeAfter);

    [DisplayName("AdminTimelockProposed")]
    public event delAdminTimelockProposed? OnAdminTimelockProposed;

    public delegate void delContractUpgraded(byte[]? nefHash, byte[]? manifestHash);

    [DisplayName("ContractUpgraded")]
    public event delContractUpgraded? OnContractUpgraded;

    public delegate void delMiniAppCapabilityGranted(string? appId, string? moduleId);

    [DisplayName("MiniAppCapabilityGranted")]
    public event delMiniAppCapabilityGranted? OnMiniAppCapabilityGranted;

    public delegate void delMiniAppCapabilityRevoked(string? appId, string? moduleId);

    [DisplayName("MiniAppCapabilityRevoked")]
    public event delMiniAppCapabilityRevoked? OnMiniAppCapabilityRevoked;

    public delegate void delMiniAppInboxStored(string? appId, BigInteger? requestId, UInt160? requester, bool? success);

    [DisplayName("MiniAppInboxStored")]
    public event delMiniAppInboxStored? OnMiniAppInboxStored;

    public delegate void delMiniAppRegistered(string? appId, UInt160? admin, UInt160? feePayer, UInt160? callbackContract);

    [DisplayName("MiniAppRegistered")]
    public event delMiniAppRegistered? OnMiniAppRegistered;

    public delegate void delMiniAppRequestCompleted(BigInteger? requestId, string? appId, string? moduleId, string? operation, bool? success, byte[]? resultHash, BigInteger? resultSize, string? error);

    [DisplayName("MiniAppRequestCompleted")]
    public event delMiniAppRequestCompleted? OnMiniAppRequestCompleted;

    public delegate void delMiniAppRequestQueued(BigInteger? requestId, string? appId, string? moduleId, string? operation, UInt160? requester, UInt160? sponsor, byte[]? payload);

    [DisplayName("MiniAppRequestQueued")]
    public event delMiniAppRequestQueued? OnMiniAppRequestQueued;

    public delegate void delMiniAppStateChanged(string? appId, byte[]? stateKey, BigInteger? valueSize);

    [DisplayName("MiniAppStateChanged")]
    public event delMiniAppStateChanged? OnMiniAppStateChanged;

    public delegate void delMiniAppUpdated(string? appId, UInt160? admin, UInt160? feePayer, UInt160? callbackContract, bool? active);

    [DisplayName("MiniAppUpdated")]
    public event delMiniAppUpdated? OnMiniAppUpdated;

    public delegate void delRequestExpired(BigInteger? requestId, string? appId, UInt160? requester, UInt160? sponsor, BigInteger? refundAmount);

    [DisplayName("RequestExpired")]
    public event delRequestExpired? OnRequestExpired;

    public delegate void delRequestFeeDeposited(UInt160? from, BigInteger? amount, BigInteger? creditBalance);

    [DisplayName("RequestFeeDeposited")]
    public event delRequestFeeDeposited? OnRequestFeeDeposited;

    public delegate void delRequestFeeUpdated(BigInteger? oldFee, BigInteger? newFee);

    [DisplayName("RequestFeeUpdated")]
    public event delRequestFeeUpdated? OnRequestFeeUpdated;

    public delegate void delRequestTTLUpdated(BigInteger? oldTTL, BigInteger? newTTL);

    [DisplayName("RequestTTLUpdated")]
    public event delRequestTTLUpdated? OnRequestTTLUpdated;

    public delegate void delRuntimeEncryptionKeyUpdated(BigInteger? version, string? algorithm, string? publicKey);

    [DisplayName("RuntimeEncryptionKeyUpdated")]
    public event delRuntimeEncryptionKeyUpdated? OnRuntimeEncryptionKeyUpdated;

    public delegate void delRuntimeVerifierUpdated(ECPoint? oldVerifier, ECPoint? newVerifier);

    [DisplayName("RuntimeVerifierUpdated")]
    public event delRuntimeVerifierUpdated? OnRuntimeVerifierUpdated;

    public delegate void delSecurityKeyChangeProposed(string? kind, BigInteger? executeAfter);

    [DisplayName("SecurityKeyChangeProposed")]
    public event delSecurityKeyChangeProposed? OnSecurityKeyChangeProposed;

    public delegate void delSponsorDefaultCapUpdated(BigInteger? oldCap, BigInteger? newCap);

    [DisplayName("SponsorDefaultCapUpdated")]
    public event delSponsorDefaultCapUpdated? OnSponsorDefaultCapUpdated;

    public delegate void delSponsoredRequesterAllowed(string? appId, UInt160? requester, bool? allowed);

    [DisplayName("SponsoredRequesterAllowed")]
    public event delSponsoredRequesterAllowed? OnSponsoredRequesterAllowed;

    public delegate void delSponsoredRequesterCapUpdated(string? appId, UInt160? requester, BigInteger? cap);

    [DisplayName("SponsoredRequesterCapUpdated")]
    public event delSponsoredRequesterCapUpdated? OnSponsoredRequesterCapUpdated;

    public delegate void delSponsorshipModeChanged(string? appId, BigInteger? mode);

    [DisplayName("SponsorshipModeChanged")]
    public event delSponsorshipModeChanged? OnSponsorshipModeChanged;

    public delegate void delSystemModuleRegistered(string? moduleId, string? endpoint, string? schemaHash);

    [DisplayName("SystemModuleRegistered")]
    public event delSystemModuleRegistered? OnSystemModuleRegistered;

    public delegate void delSystemModuleUpdated(string? moduleId, string? endpoint, string? schemaHash, bool? active);

    [DisplayName("SystemModuleUpdated")]
    public event delSystemModuleUpdated? OnSystemModuleUpdated;

    public delegate void delUpdaterChanged(UInt160? oldUpdater, UInt160? newUpdater);

    [DisplayName("UpdaterChanged")]
    public event delUpdaterChanged? OnUpdaterChanged;

    public delegate void delUpgradeScheduled(BigInteger? executeAfter);

    [DisplayName("UpgradeScheduled")]
    public event delUpgradeScheduled? OnUpgradeScheduled;

    #endregion

    #region Properties

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract BigInteger? AccruedRequestFees { [DisplayName("accruedRequestFees")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract UInt160? Admin { [DisplayName("admin")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract BigInteger? DefaultSponsoredRequesterCap { [DisplayName("defaultSponsoredRequesterCap")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract IList<object>? AllMiniAppIds { [DisplayName("getAllMiniAppIds")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract IList<object>? AllSystemModuleIds { [DisplayName("getAllSystemModuleIds")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract BigInteger? MiniAppCount { [DisplayName("getMiniAppCount")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract BigInteger? SystemModuleCount { [DisplayName("getSystemModuleCount")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract BigInteger? TotalFulfilled { [DisplayName("getTotalFulfilled")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract BigInteger? TotalRequests { [DisplayName("getTotalRequests")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract BigInteger? IndexRebuildCursor { [DisplayName("indexRebuildCursor")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract bool? IsIndexRebuildRequired { [DisplayName("isIndexRebuildRequired")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract string? OracleEncryptionAlgorithm { [DisplayName("oracleEncryptionAlgorithm")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract BigInteger? OracleEncryptionKeyVersion { [DisplayName("oracleEncryptionKeyVersion")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract string? OracleEncryptionPublicKey { [DisplayName("oracleEncryptionPublicKey")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract ECPoint? OracleVerificationPublicKey { [DisplayName("oracleVerificationPublicKey")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract BigInteger? PendingRuntimeEncryptionKeyEta { [DisplayName("pendingRuntimeEncryptionKeyEta")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract BigInteger? PendingRuntimeVerificationKeyEta { [DisplayName("pendingRuntimeVerificationKeyEta")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract BigInteger? RequestFee { [DisplayName("requestFee")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract BigInteger? RequestTTL { [DisplayName("requestTTL")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract BigInteger? ReservedRequestFees { [DisplayName("reservedRequestFees")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract string? RuntimeEncryptionAlgorithm { [DisplayName("runtimeEncryptionAlgorithm")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract BigInteger? RuntimeEncryptionKeyVersion { [DisplayName("runtimeEncryptionKeyVersion")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract string? RuntimeEncryptionPublicKey { [DisplayName("runtimeEncryptionPublicKey")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract ECPoint? RuntimeVerificationPublicKey { [DisplayName("runtimeVerificationPublicKey")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract BigInteger? SystemRequestFee { [DisplayName("systemRequestFee")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract UInt160? Updater { [DisplayName("updater")] get; }

    /// <summary>
    /// Safe property
    /// </summary>
    public abstract BigInteger? WithdrawableFees { [DisplayName("withdrawableFees")] get; }

    #endregion

    #region Safe methods

    /// <summary>
    /// Safe method
    /// </summary>
    [DisplayName("feeCreditOf")]
    public abstract BigInteger? FeeCreditOf(UInt160? requester);

    /// <summary>
    /// Safe method
    /// </summary>
    [DisplayName("getInboxItem")]
    public abstract IList<object>? GetInboxItem(string? appId, BigInteger? requestId);

    /// <summary>
    /// Safe method
    /// </summary>
    [DisplayName("getMiniApp")]
    public abstract IList<object>? GetMiniApp(string? appId);

    /// <summary>
    /// Safe method
    /// </summary>
    [DisplayName("getMiniAppFulfilledCount")]
    public abstract BigInteger? GetMiniAppFulfilledCount(string? appId);

    /// <summary>
    /// Safe method
    /// </summary>
    [DisplayName("getMiniAppIdByIndex")]
    public abstract string? GetMiniAppIdByIndex(BigInteger? index);

    /// <summary>
    /// Safe method
    /// </summary>
    [DisplayName("getMiniAppRequestCount")]
    public abstract BigInteger? GetMiniAppRequestCount(string? appId);

    /// <summary>
    /// Safe method
    /// </summary>
    [DisplayName("getMiniAppState")]
    public abstract byte[]? GetMiniAppState(string? appId, byte[]? stateKey);

    /// <summary>
    /// Safe method
    /// </summary>
    [DisplayName("getRequest")]
    public abstract IList<object>? GetRequest(BigInteger? requestId);

    /// <summary>
    /// Safe method
    /// </summary>
    [DisplayName("getSponsoredRequesterCap")]
    public abstract BigInteger? GetSponsoredRequesterCap(string? appId, UInt160? requester);

    /// <summary>
    /// Safe method
    /// </summary>
    [DisplayName("getSponsoredRequesterSpent")]
    public abstract BigInteger? GetSponsoredRequesterSpent(string? appId, UInt160? requester);

    /// <summary>
    /// Safe method
    /// </summary>
    [DisplayName("getSystemModule")]
    public abstract IList<object>? GetSystemModule(string? moduleId);

    /// <summary>
    /// Safe method
    /// </summary>
    [DisplayName("getSystemModuleIdByIndex")]
    public abstract string? GetSystemModuleIdByIndex(BigInteger? index);

    /// <summary>
    /// Safe method
    /// </summary>
    [DisplayName("isModuleGrantedToMiniApp")]
    public abstract bool? IsModuleGrantedToMiniApp(string? appId, string? moduleId);

    /// <summary>
    /// Safe method
    /// </summary>
    [DisplayName("isSponsoredRequesterAllowed")]
    public abstract bool? IsSponsoredRequesterAllowed(string? appId, UInt160? requester);

    /// <summary>
    /// Safe method
    /// </summary>
    [DisplayName("isSponsorshipGated")]
    public abstract bool? IsSponsorshipGated(string? appId);

    /// <summary>
    /// Safe method
    /// </summary>
    [DisplayName("isSponsorshipOpen")]
    public abstract bool? IsSponsorshipOpen(string? appId);

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
    [DisplayName("cancelRuntimeEncryptionKey")]
    public abstract void CancelRuntimeEncryptionKey();

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("cancelRuntimeVerificationPublicKey")]
    public abstract void CancelRuntimeVerificationPublicKey();

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("cancelUpdate")]
    public abstract void CancelUpdate();

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("configureMiniApp")]
    public abstract void ConfigureMiniApp(string? appId, UInt160? feePayer, UInt160? callbackContract, string? metadataUri, string? metadataHash, bool? active);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("configureSystemModule")]
    public abstract void ConfigureSystemModule(string? moduleId, string? endpoint, string? schemaHash, bool? active);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("deleteMiniAppState")]
    public abstract void DeleteMiniAppState(string? appId, byte[]? stateKey);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("executeAdminChange")]
    public abstract void ExecuteAdminChange();

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("executeRuntimeEncryptionKey")]
    public abstract void ExecuteRuntimeEncryptionKey();

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("executeRuntimeVerificationPublicKey")]
    public abstract void ExecuteRuntimeVerificationPublicKey();

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("expireStaleRequest")]
    public abstract void ExpireStaleRequest(BigInteger? requestId);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("fulfillRequest")]
    public abstract void FulfillRequest(BigInteger? requestId, bool? success, byte[]? result, string? error, byte[]? verificationSignature);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("grantModuleToMiniApp")]
    public abstract void GrantModuleToMiniApp(string? appId, string? moduleId);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("onNEP17Payment")]
    public abstract void OnNEP17Payment(UInt160? from, BigInteger? amount, object? data = null);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("proposeAdmin")]
    public abstract void ProposeAdmin(UInt160? newAdmin);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("proposeRuntimeEncryptionKey")]
    public abstract void ProposeRuntimeEncryptionKey(string? algorithm, string? publicKey);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("proposeRuntimeVerificationPublicKey")]
    public abstract void ProposeRuntimeVerificationPublicKey(ECPoint? publicKey);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("putMiniAppState")]
    public abstract void PutMiniAppState(string? appId, byte[]? stateKey, byte[]? value);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("putMiniAppStateBatch")]
    public abstract void PutMiniAppStateBatch(string? appId, IList<object>? stateKeys, IList<object>? values);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("queueAutomationRequest")]
    public abstract BigInteger? QueueAutomationRequest(UInt160? requester, string? requestType, byte[]? payload, UInt160? callbackContract, string? callbackMethod);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("queueSystemRequest")]
    public abstract BigInteger? QueueSystemRequest(UInt160? requester, string? appId, string? moduleId, string? operation, byte[]? payload);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("rebuildIndexes")]
    public abstract void RebuildIndexes(BigInteger? startIndex, BigInteger? count);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("registerMiniApp")]
    public abstract void RegisterMiniApp(string? appId, UInt160? appAdmin, UInt160? feePayer, UInt160? callbackContract, string? metadataUri, string? metadataHash);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("registerSystemModule")]
    public abstract void RegisterSystemModule(string? moduleId, string? endpoint, string? schemaHash);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("request")]
    public abstract BigInteger? Request(string? requestType, byte[]? payload, UInt160? callbackContract, string? callbackMethod);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("requestFromCallback")]
    public abstract BigInteger? RequestFromCallback(UInt160? requester, string? requestType, byte[]? payload, UInt160? callbackContract, string? callbackMethod);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("revokeModuleFromMiniApp")]
    public abstract void RevokeModuleFromMiniApp(string? appId, string? moduleId);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("scheduleUpdate")]
    public abstract void ScheduleUpdate(byte[]? nefFile, string? manifest);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("setDefaultSponsoredRequesterCap")]
    public abstract void SetDefaultSponsoredRequesterCap(BigInteger? cap);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("setOracleEncryptionKey")]
    public abstract void SetOracleEncryptionKey(string? algorithm, string? publicKey);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("setOracleVerificationPublicKey")]
    public abstract void SetOracleVerificationPublicKey(ECPoint? publicKey);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("setRequestFee")]
    public abstract void SetRequestFee(BigInteger? amount);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("setRequestTTL")]
    public abstract void SetRequestTTL(BigInteger? ttlMs);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("setSponsoredRequesterAllowed")]
    public abstract void SetSponsoredRequesterAllowed(string? appId, UInt160? requester, bool? allowed);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("setSponsoredRequesterCap")]
    public abstract void SetSponsoredRequesterCap(string? appId, UInt160? requester, BigInteger? cap);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("setSponsorshipOpen")]
    public abstract void SetSponsorshipOpen(string? appId, bool? open);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("setUpdater")]
    public abstract void SetUpdater(UInt160? updater);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("submitMiniAppRequest")]
    public abstract BigInteger? SubmitMiniAppRequest(string? appId, string? moduleId, string? operation, byte[]? payload);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("submitMiniAppRequestFromIntegration")]
    public abstract BigInteger? SubmitMiniAppRequestFromIntegration(UInt160? requester, string? appId, string? moduleId, string? operation, byte[]? payload);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("update")]
    public abstract void Update(byte[]? nefFile, string? manifest);

    /// <summary>
    /// Unsafe method
    /// </summary>
    [DisplayName("withdrawAccruedFees")]
    public abstract void WithdrawAccruedFees(UInt160? to, BigInteger? amount);

    #endregion
}
