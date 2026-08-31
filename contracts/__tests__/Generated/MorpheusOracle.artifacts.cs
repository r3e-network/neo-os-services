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

    public static Neo.SmartContract.Manifest.ContractManifest Manifest => Neo.SmartContract.Manifest.ContractManifest.Parse(@"{""name"":""MorpheusOracle"",""groups"":[],""features"":{},""supportedstandards"":[],""abi"":{""methods"":[{""name"":""_deploy"",""parameters"":[{""name"":""data"",""type"":""Any""},{""name"":""update"",""type"":""Boolean""}],""returntype"":""Void"",""offset"":0,""safe"":false},{""name"":""admin"",""parameters"":[],""returntype"":""Hash160"",""offset"":972,""safe"":true},{""name"":""updater"",""parameters"":[],""returntype"":""Hash160"",""offset"":997,""safe"":true},{""name"":""runtimeEncryptionAlgorithm"",""parameters"":[],""returntype"":""String"",""offset"":1023,""safe"":true},{""name"":""runtimeEncryptionPublicKey"",""parameters"":[],""returntype"":""String"",""offset"":1039,""safe"":true},{""name"":""runtimeEncryptionKeyVersion"",""parameters"":[],""returntype"":""Integer"",""offset"":1054,""safe"":true},{""name"":""runtimeVerificationPublicKey"",""parameters"":[],""returntype"":""PublicKey"",""offset"":1092,""safe"":true},{""name"":""oracleEncryptionAlgorithm"",""parameters"":[],""returntype"":""String"",""offset"":1152,""safe"":true},{""name"":""oracleEncryptionPublicKey"",""parameters"":[],""returntype"":""String"",""offset"":1158,""safe"":true},{""name"":""oracleEncryptionKeyVersion"",""parameters"":[],""returntype"":""Integer"",""offset"":1161,""safe"":true},{""name"":""oracleVerificationPublicKey"",""parameters"":[],""returntype"":""PublicKey"",""offset"":1164,""safe"":true},{""name"":""systemRequestFee"",""parameters"":[],""returntype"":""Integer"",""offset"":1167,""safe"":true},{""name"":""requestFee"",""parameters"":[],""returntype"":""Integer"",""offset"":1208,""safe"":true},{""name"":""requestTTL"",""parameters"":[],""returntype"":""Integer"",""offset"":1211,""safe"":true},{""name"":""feeCreditOf"",""parameters"":[{""name"":""requester"",""type"":""Hash160""}],""returntype"":""Integer"",""offset"":1253,""safe"":true},{""name"":""accruedRequestFees"",""parameters"":[],""returntype"":""Integer"",""offset"":1360,""safe"":true},{""name"":""reservedRequestFees"",""parameters"":[],""returntype"":""Integer"",""offset"":1398,""safe"":true},{""name"":""withdrawableFees"",""parameters"":[],""returntype"":""Integer"",""offset"":1436,""safe"":true},{""name"":""getMiniAppCount"",""parameters"":[],""returntype"":""Integer"",""offset"":508,""safe"":true},{""name"":""getSystemModuleCount"",""parameters"":[],""returntype"":""Integer"",""offset"":892,""safe"":true},{""name"":""getMiniAppIdByIndex"",""parameters"":[{""name"":""index"",""type"":""Integer""}],""returntype"":""String"",""offset"":1523,""safe"":true},{""name"":""getSystemModuleIdByIndex"",""parameters"":[{""name"":""index"",""type"":""Integer""}],""returntype"":""String"",""offset"":1586,""safe"":true},{""name"":""getAllMiniAppIds"",""parameters"":[],""returntype"":""Array"",""offset"":1642,""safe"":true},{""name"":""getAllSystemModuleIds"",""parameters"":[],""returntype"":""Array"",""offset"":1749,""safe"":true},{""name"":""getMiniApp"",""parameters"":[{""name"":""appId"",""type"":""String""}],""returntype"":""Array"",""offset"":1856,""safe"":true},{""name"":""getSystemModule"",""parameters"":[{""name"":""moduleId"",""type"":""String""}],""returntype"":""Array"",""offset"":655,""safe"":true},{""name"":""isModuleGrantedToMiniApp"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""}],""returntype"":""Boolean"",""offset"":1951,""safe"":true},{""name"":""getMiniAppRequestCount"",""parameters"":[{""name"":""appId"",""type"":""String""}],""returntype"":""Integer"",""offset"":2090,""safe"":true},{""name"":""getMiniAppFulfilledCount"",""parameters"":[{""name"":""appId"",""type"":""String""}],""returntype"":""Integer"",""offset"":2163,""safe"":true},{""name"":""getTotalRequests"",""parameters"":[],""returntype"":""Integer"",""offset"":2236,""safe"":true},{""name"":""getTotalFulfilled"",""parameters"":[],""returntype"":""Integer"",""offset"":2274,""safe"":true},{""name"":""isIndexRebuildRequired"",""parameters"":[],""returntype"":""Boolean"",""offset"":2312,""safe"":true},{""name"":""indexRebuildCursor"",""parameters"":[],""returntype"":""Integer"",""offset"":2328,""safe"":true},{""name"":""getRequest"",""parameters"":[{""name"":""requestId"",""type"":""Integer""}],""returntype"":""Array"",""offset"":2365,""safe"":true},{""name"":""getInboxItem"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requestId"",""type"":""Integer""}],""returntype"":""Array"",""offset"":2432,""safe"":true},{""name"":""getMiniAppState"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""stateKey"",""type"":""ByteArray""}],""returntype"":""ByteArray"",""offset"":2543,""safe"":true},{""name"":""isSponsorshipGated"",""parameters"":[{""name"":""appId"",""type"":""String""}],""returntype"":""Boolean"",""offset"":2694,""safe"":true},{""name"":""isSponsoredRequesterAllowed"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""}],""returntype"":""Boolean"",""offset"":2749,""safe"":true},{""name"":""getSponsoredRequesterCap"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""}],""returntype"":""Integer"",""offset"":2858,""safe"":true},{""name"":""getSponsoredRequesterSpent"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""}],""returntype"":""Integer"",""offset"":2962,""safe"":true},{""name"":""proposeAdmin"",""parameters"":[{""name"":""newAdmin"",""type"":""Hash160""}],""returntype"":""Void"",""offset"":3069,""safe"":false},{""name"":""executeAdminChange"",""parameters"":[],""returntype"":""Void"",""offset"":3333,""safe"":false},{""name"":""cancelAdminChange"",""parameters"":[],""returntype"":""Void"",""offset"":3502,""safe"":false},{""name"":""setUpdater"",""parameters"":[{""name"":""updater"",""type"":""Hash160""}],""returntype"":""Void"",""offset"":3532,""safe"":false},{""name"":""proposeRuntimeEncryptionKey"",""parameters"":[{""name"":""algorithm"",""type"":""String""},{""name"":""publicKey"",""type"":""String""}],""returntype"":""Void"",""offset"":3627,""safe"":false},{""name"":""executeRuntimeEncryptionKey"",""parameters"":[],""returntype"":""Void"",""offset"":3903,""safe"":false},{""name"":""cancelRuntimeEncryptionKey"",""parameters"":[],""returntype"":""Void"",""offset"":4089,""safe"":false},{""name"":""pendingRuntimeEncryptionKeyEta"",""parameters"":[],""returntype"":""Integer"",""offset"":4107,""safe"":true},{""name"":""proposeRuntimeVerificationPublicKey"",""parameters"":[{""name"":""publicKey"",""type"":""PublicKey""}],""returntype"":""Void"",""offset"":4140,""safe"":false},{""name"":""executeRuntimeVerificationPublicKey"",""parameters"":[],""returntype"":""Void"",""offset"":4337,""safe"":false},{""name"":""cancelRuntimeVerificationPublicKey"",""parameters"":[],""returntype"":""Void"",""offset"":4503,""safe"":false},{""name"":""pendingRuntimeVerificationKeyEta"",""parameters"":[],""returntype"":""Integer"",""offset"":4521,""safe"":true},{""name"":""setOracleEncryptionKey"",""parameters"":[{""name"":""algorithm"",""type"":""String""},{""name"":""publicKey"",""type"":""String""}],""returntype"":""Void"",""offset"":4554,""safe"":false},{""name"":""setOracleVerificationPublicKey"",""parameters"":[{""name"":""publicKey"",""type"":""PublicKey""}],""returntype"":""Void"",""offset"":4565,""safe"":false},{""name"":""setRequestFee"",""parameters"":[{""name"":""amount"",""type"":""Integer""}],""returntype"":""Void"",""offset"":4575,""safe"":false},{""name"":""withdrawAccruedFees"",""parameters"":[{""name"":""to"",""type"":""Hash160""},{""name"":""amount"",""type"":""Integer""}],""returntype"":""Void"",""offset"":4657,""safe"":false},{""name"":""setRequestTTL"",""parameters"":[{""name"":""ttlMs"",""type"":""Integer""}],""returntype"":""Void"",""offset"":4892,""safe"":false},{""name"":""expireStaleRequest"",""parameters"":[{""name"":""requestId"",""type"":""Integer""}],""returntype"":""Void"",""offset"":4976,""safe"":false},{""name"":""registerSystemModule"",""parameters"":[{""name"":""moduleId"",""type"":""String""},{""name"":""endpoint"",""type"":""String""},{""name"":""schemaHash"",""type"":""String""}],""returntype"":""Void"",""offset"":5798,""safe"":false},{""name"":""configureSystemModule"",""parameters"":[{""name"":""moduleId"",""type"":""String""},{""name"":""endpoint"",""type"":""String""},{""name"":""schemaHash"",""type"":""String""},{""name"":""active"",""type"":""Boolean""}],""returntype"":""Void"",""offset"":6027,""safe"":false},{""name"":""registerMiniApp"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""appAdmin"",""type"":""Hash160""},{""name"":""feePayer"",""type"":""Hash160""},{""name"":""callbackContract"",""type"":""Hash160""},{""name"":""metadataUri"",""type"":""String""},{""name"":""metadataHash"",""type"":""String""}],""returntype"":""Void"",""offset"":6121,""safe"":false},{""name"":""configureMiniApp"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""feePayer"",""type"":""Hash160""},{""name"":""callbackContract"",""type"":""Hash160""},{""name"":""metadataUri"",""type"":""String""},{""name"":""metadataHash"",""type"":""String""},{""name"":""active"",""type"":""Boolean""}],""returntype"":""Void"",""offset"":7218,""safe"":false},{""name"":""setSponsoredRequesterAllowed"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""},{""name"":""allowed"",""type"":""Boolean""}],""returntype"":""Void"",""offset"":7447,""safe"":false},{""name"":""setSponsoredRequesterCap"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""},{""name"":""cap"",""type"":""Integer""}],""returntype"":""Void"",""offset"":7623,""safe"":false},{""name"":""grantModuleToMiniApp"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""}],""returntype"":""Void"",""offset"":7797,""safe"":false},{""name"":""revokeModuleFromMiniApp"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""}],""returntype"":""Void"",""offset"":7943,""safe"":false},{""name"":""putMiniAppState"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""stateKey"",""type"":""ByteArray""},{""name"":""value"",""type"":""ByteArray""}],""returntype"":""Void"",""offset"":8044,""safe"":false},{""name"":""putMiniAppStateBatch"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""stateKeys"",""type"":""Array""},{""name"":""values"",""type"":""Array""}],""returntype"":""Void"",""offset"":8311,""safe"":false},{""name"":""deleteMiniAppState"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""stateKey"",""type"":""ByteArray""}],""returntype"":""Void"",""offset"":8583,""safe"":false},{""name"":""submitMiniAppRequest"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""},{""name"":""operation"",""type"":""String""},{""name"":""payload"",""type"":""ByteArray""}],""returntype"":""Integer"",""offset"":8659,""safe"":false},{""name"":""submitMiniAppRequestFromIntegration"",""parameters"":[{""name"":""requester"",""type"":""Hash160""},{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""},{""name"":""operation"",""type"":""String""},{""name"":""payload"",""type"":""ByteArray""}],""returntype"":""Integer"",""offset"":9733,""safe"":false},{""name"":""requestFromCallback"",""parameters"":[{""name"":""requester"",""type"":""Hash160""},{""name"":""requestType"",""type"":""String""},{""name"":""payload"",""type"":""ByteArray""},{""name"":""callbackContract"",""type"":""Hash160""},{""name"":""callbackMethod"",""type"":""String""}],""returntype"":""Integer"",""offset"":9905,""safe"":false},{""name"":""queueSystemRequest"",""parameters"":[{""name"":""requester"",""type"":""Hash160""},{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""},{""name"":""operation"",""type"":""String""},{""name"":""payload"",""type"":""ByteArray""}],""returntype"":""Integer"",""offset"":10540,""safe"":false},{""name"":""queueAutomationRequest"",""parameters"":[{""name"":""requester"",""type"":""Hash160""},{""name"":""requestType"",""type"":""String""},{""name"":""payload"",""type"":""ByteArray""},{""name"":""callbackContract"",""type"":""Hash160""},{""name"":""callbackMethod"",""type"":""String""}],""returntype"":""Integer"",""offset"":10678,""safe"":false},{""name"":""request"",""parameters"":[{""name"":""requestType"",""type"":""String""},{""name"":""payload"",""type"":""ByteArray""},{""name"":""callbackContract"",""type"":""Hash160""},{""name"":""callbackMethod"",""type"":""String""}],""returntype"":""Integer"",""offset"":10824,""safe"":false},{""name"":""onNEP17Payment"",""parameters"":[{""name"":""from"",""type"":""Hash160""},{""name"":""amount"",""type"":""Integer""},{""name"":""data"",""type"":""Any""}],""returntype"":""Void"",""offset"":10969,""safe"":false},{""name"":""fulfillRequest"",""parameters"":[{""name"":""requestId"",""type"":""Integer""},{""name"":""success"",""type"":""Boolean""},{""name"":""result"",""type"":""ByteArray""},{""name"":""error"",""type"":""String""},{""name"":""verificationSignature"",""type"":""ByteArray""}],""returntype"":""Void"",""offset"":11449,""safe"":false},{""name"":""scheduleUpdate"",""parameters"":[{""name"":""nefFile"",""type"":""ByteArray""},{""name"":""manifest"",""type"":""String""}],""returntype"":""Void"",""offset"":12755,""safe"":false},{""name"":""update"",""parameters"":[{""name"":""nefFile"",""type"":""ByteArray""},{""name"":""manifest"",""type"":""String""}],""returntype"":""Void"",""offset"":12937,""safe"":false},{""name"":""cancelUpdate"",""parameters"":[],""returntype"":""Void"",""offset"":13142,""safe"":false},{""name"":""rebuildIndexes"",""parameters"":[{""name"":""startIndex"",""type"":""Integer""},{""name"":""count"",""type"":""Integer""}],""returntype"":""Void"",""offset"":13172,""safe"":false},{""name"":""_initialize"",""parameters"":[],""returntype"":""Void"",""offset"":13608,""safe"":false}],""events"":[{""name"":""MiniAppRegistered"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""admin"",""type"":""Hash160""},{""name"":""feePayer"",""type"":""Hash160""},{""name"":""callbackContract"",""type"":""Hash160""}]},{""name"":""MiniAppUpdated"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""admin"",""type"":""Hash160""},{""name"":""feePayer"",""type"":""Hash160""},{""name"":""callbackContract"",""type"":""Hash160""},{""name"":""active"",""type"":""Boolean""}]},{""name"":""SystemModuleRegistered"",""parameters"":[{""name"":""moduleId"",""type"":""String""},{""name"":""endpoint"",""type"":""String""},{""name"":""schemaHash"",""type"":""String""}]},{""name"":""SystemModuleUpdated"",""parameters"":[{""name"":""moduleId"",""type"":""String""},{""name"":""endpoint"",""type"":""String""},{""name"":""schemaHash"",""type"":""String""},{""name"":""active"",""type"":""Boolean""}]},{""name"":""MiniAppCapabilityGranted"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""}]},{""name"":""MiniAppCapabilityRevoked"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""}]},{""name"":""MiniAppRequestQueued"",""parameters"":[{""name"":""requestId"",""type"":""Integer""},{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""},{""name"":""operation"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""},{""name"":""sponsor"",""type"":""Hash160""},{""name"":""payload"",""type"":""ByteArray""}]},{""name"":""MiniAppRequestCompleted"",""parameters"":[{""name"":""requestId"",""type"":""Integer""},{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""},{""name"":""operation"",""type"":""String""},{""name"":""success"",""type"":""Boolean""},{""name"":""resultHash"",""type"":""ByteArray""},{""name"":""resultSize"",""type"":""Integer""},{""name"":""error"",""type"":""String""}]},{""name"":""MiniAppInboxStored"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requestId"",""type"":""Integer""},{""name"":""requester"",""type"":""Hash160""},{""name"":""success"",""type"":""Boolean""}]},{""name"":""MiniAppStateChanged"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""stateKey"",""type"":""ByteArray""},{""name"":""valueSize"",""type"":""Integer""}]},{""name"":""AdminChanged"",""parameters"":[{""name"":""oldAdmin"",""type"":""Hash160""},{""name"":""newAdmin"",""type"":""Hash160""}]},{""name"":""UpdaterChanged"",""parameters"":[{""name"":""oldUpdater"",""type"":""Hash160""},{""name"":""newUpdater"",""type"":""Hash160""}]},{""name"":""RuntimeEncryptionKeyUpdated"",""parameters"":[{""name"":""version"",""type"":""Integer""},{""name"":""algorithm"",""type"":""String""},{""name"":""publicKey"",""type"":""String""}]},{""name"":""RuntimeVerifierUpdated"",""parameters"":[{""name"":""oldVerifier"",""type"":""PublicKey""},{""name"":""newVerifier"",""type"":""PublicKey""}]},{""name"":""RequestFeeUpdated"",""parameters"":[{""name"":""oldFee"",""type"":""Integer""},{""name"":""newFee"",""type"":""Integer""}]},{""name"":""RequestFeeDeposited"",""parameters"":[{""name"":""from"",""type"":""Hash160""},{""name"":""amount"",""type"":""Integer""},{""name"":""creditBalance"",""type"":""Integer""}]},{""name"":""AccruedFeesWithdrawn"",""parameters"":[{""name"":""to"",""type"":""Hash160""},{""name"":""amount"",""type"":""Integer""}]},{""name"":""RequestExpired"",""parameters"":[{""name"":""requestId"",""type"":""Integer""},{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""},{""name"":""sponsor"",""type"":""Hash160""},{""name"":""refundAmount"",""type"":""Integer""}]},{""name"":""RequestTTLUpdated"",""parameters"":[{""name"":""oldTTL"",""type"":""Integer""},{""name"":""newTTL"",""type"":""Integer""}]},{""name"":""SponsoredRequesterAllowed"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""},{""name"":""allowed"",""type"":""Boolean""}]},{""name"":""SponsoredRequesterCapUpdated"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""},{""name"":""cap"",""type"":""Integer""}]},{""name"":""AdminTimelockProposed"",""parameters"":[{""name"":""proposed"",""type"":""Hash160""},{""name"":""executeAfter"",""type"":""Integer""}]},{""name"":""UpgradeScheduled"",""parameters"":[{""name"":""executeAfter"",""type"":""Integer""}]},{""name"":""ContractUpgraded"",""parameters"":[{""name"":""nefHash"",""type"":""ByteArray""},{""name"":""manifestHash"",""type"":""ByteArray""}]},{""name"":""SecurityKeyChangeProposed"",""parameters"":[{""name"":""kind"",""type"":""String""},{""name"":""executeAfter"",""type"":""Integer""}]}]},""permissions"":[{""contract"":""0x726cb6e0cd8628a1350a611384688911ab75f51b"",""methods"":[""sha256"",""verifyWithECDsa""]},{""contract"":""0xacce6fd80d44e1796aa0c2c625e9e4e0ce39efc0"",""methods"":[""deserialize"",""serialize""]},{""contract"":""0xd2a4cff31913016155e38e474a2c06d08be276cf"",""methods"":[""transfer""]},{""contract"":""0xfffdc93764dbaddd97c48f252a53ea4643faa3fd"",""methods"":[""update""]},{""contract"":""*"",""methods"":[""onMiniAppResult"",""onOracleResult""]}],""trusts"":[],""extra"":{""Author"":""Morpheus Oracle"",""Version"":""2.0.0"",""Description"":""MiniApp OS kernel with shared IO, registration, and callback orchestration"",""nef"":{""optimization"":""Basic""}}}");

    /// <summary>
    /// Optimization: "Basic"
    /// </summary>
    public static Neo.SmartContract.NefFile Nef => Convert.FromBase64String(@"TkVGM05lby5Db21waWxlci5DU2hhcnAgMy45LjErNWZhOTU2NmU1MTY1ZWRlMjE2NWE5YmUxZjRhMDEyMGMxNzYuLi4AAAbA7znO4OTpJcbCoGp54UQN2G/OrAtkZXNlcmlhbGl6ZQEAAQ/A7znO4OTpJcbCoGp54UQN2G/OrAlzZXJpYWxpemUBAAEPG/V1qxGJaIQTYQo1oSiGzeC2bHIGc2hhMjU2AQABD8924ovQBixKR47jVWEBExnzz6TSCHRyYW5zZmVyBAABDxv1dasRiWiEE2EKNaEohs3gtmxyD3ZlcmlmeVdpdGhFQ0RzYQQAAQ/9o/pDRupTKiWPxJfdrdtkN8n9/wZ1cGRhdGUDAAAPAAD9WzZXAQJ5Jic19gEAABC3JhkRWUGb9mfOQeY/GIRaQZv2Z85BL1jF7SPVAQAAQS1RCDBwaBPOW0Gb9mfOQeY/GIQQXEGb9mfOQeY/GIQCQEIPAF1Bm/ZnzkHmPxiEDB9tb3JwaGV1cy5tb2R1bGUub3JhY2xlLmZldGNoLnYxDBMvb3JhY2xlL3NtYXJ0LWZldGNoDAxvcmFjbGUuZmV0Y2g1sQEAAAwebW9ycGhldXMubW9kdWxlLmNvbXB1dGUucnVuLnYxDBAvY29tcHV0ZS9leGVjdXRlDAtjb21wdXRlLnJ1bjVtAQAADBxtb3JwaGV1cy5tb2R1bGUuZmVlZC5yZWFkLnYxDAwvb3JhY2xlL2ZlZWQMCWZlZWQucmVhZDUxAQAADB9tb3JwaGV1cy5tb2R1bGUuZmVlZC5wdWJsaXNoLnYxDAwvb3JhY2xlL2ZlZWQMDGZlZWQucHVibGlzaDXvAAAADCJtb3JwaGV1cy5tb2R1bGUuaWRlbnRpdHkudmVyaWZ5LnYxDA8vbmVvZGlkL3Jlc29sdmUMD2lkZW50aXR5LnZlcmlmeTWkAAAADCFtb3JwaGV1cy5tb2R1bGUuYXV0b21hdGlvbi5ydW4udjEMEy9hdXRvbWF0aW9uL2V4ZWN1dGUMDmF1dG9tYXRpb24ucnVuNFdAVwEAWEGb9mfOQZJd6DFwaAuXJgUQIg1oStgmBkUQIgTbISICQEGSXegxQEGb9mfOQErYJgZFECIE2yFAQeY/GIRAQS9Yxe1AQS1RCDBAQeY/GIRAVwADeDQ7FM4QtyYEIjJBt8OIAwh6eXg1sgAA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").AsSerializable<Neo.SmartContract.NefFile>();

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

    public delegate void delSponsoredRequesterAllowed(string? appId, UInt160? requester, bool? allowed);

    [DisplayName("SponsoredRequesterAllowed")]
    public event delSponsoredRequesterAllowed? OnSponsoredRequesterAllowed;

    public delegate void delSponsoredRequesterCapUpdated(string? appId, UInt160? requester, BigInteger? cap);

    [DisplayName("SponsoredRequesterCapUpdated")]
    public event delSponsoredRequesterCapUpdated? OnSponsoredRequesterCapUpdated;

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
