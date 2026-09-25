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

    public static Neo.SmartContract.Manifest.ContractManifest Manifest => Neo.SmartContract.Manifest.ContractManifest.Parse(@"{""name"":""MorpheusOracle"",""groups"":[],""features"":{},""supportedstandards"":[],""abi"":{""methods"":[{""name"":""_deploy"",""parameters"":[{""name"":""data"",""type"":""Any""},{""name"":""update"",""type"":""Boolean""}],""returntype"":""Void"",""offset"":227,""safe"":false},{""name"":""admin"",""parameters"":[],""returntype"":""Hash160"",""offset"":1199,""safe"":true},{""name"":""updater"",""parameters"":[],""returntype"":""Hash160"",""offset"":1224,""safe"":true},{""name"":""runtimeEncryptionAlgorithm"",""parameters"":[],""returntype"":""String"",""offset"":1250,""safe"":true},{""name"":""runtimeEncryptionPublicKey"",""parameters"":[],""returntype"":""String"",""offset"":1266,""safe"":true},{""name"":""runtimeEncryptionKeyVersion"",""parameters"":[],""returntype"":""Integer"",""offset"":1281,""safe"":true},{""name"":""runtimeVerificationPublicKey"",""parameters"":[],""returntype"":""PublicKey"",""offset"":1319,""safe"":true},{""name"":""oracleEncryptionAlgorithm"",""parameters"":[],""returntype"":""String"",""offset"":1379,""safe"":true},{""name"":""oracleEncryptionPublicKey"",""parameters"":[],""returntype"":""String"",""offset"":1385,""safe"":true},{""name"":""oracleEncryptionKeyVersion"",""parameters"":[],""returntype"":""Integer"",""offset"":1388,""safe"":true},{""name"":""oracleVerificationPublicKey"",""parameters"":[],""returntype"":""PublicKey"",""offset"":1391,""safe"":true},{""name"":""systemRequestFee"",""parameters"":[],""returntype"":""Integer"",""offset"":1394,""safe"":true},{""name"":""requestFee"",""parameters"":[],""returntype"":""Integer"",""offset"":1435,""safe"":true},{""name"":""requestTTL"",""parameters"":[],""returntype"":""Integer"",""offset"":1438,""safe"":true},{""name"":""feeCreditOf"",""parameters"":[{""name"":""requester"",""type"":""Hash160""}],""returntype"":""Integer"",""offset"":1480,""safe"":true},{""name"":""accruedRequestFees"",""parameters"":[],""returntype"":""Integer"",""offset"":1573,""safe"":true},{""name"":""reservedRequestFees"",""parameters"":[],""returntype"":""Integer"",""offset"":1611,""safe"":true},{""name"":""withdrawableFees"",""parameters"":[],""returntype"":""Integer"",""offset"":1649,""safe"":true},{""name"":""getMiniAppCount"",""parameters"":[],""returntype"":""Integer"",""offset"":735,""safe"":true},{""name"":""getSystemModuleCount"",""parameters"":[],""returntype"":""Integer"",""offset"":1119,""safe"":true},{""name"":""getMiniAppIdByIndex"",""parameters"":[{""name"":""index"",""type"":""Integer""}],""returntype"":""String"",""offset"":1736,""safe"":true},{""name"":""getSystemModuleIdByIndex"",""parameters"":[{""name"":""index"",""type"":""Integer""}],""returntype"":""String"",""offset"":1799,""safe"":true},{""name"":""getAllMiniAppIds"",""parameters"":[],""returntype"":""Array"",""offset"":1855,""safe"":true},{""name"":""getAllSystemModuleIds"",""parameters"":[],""returntype"":""Array"",""offset"":1962,""safe"":true},{""name"":""getMiniApp"",""parameters"":[{""name"":""appId"",""type"":""String""}],""returntype"":""Array"",""offset"":2069,""safe"":true},{""name"":""getSystemModule"",""parameters"":[{""name"":""moduleId"",""type"":""String""}],""returntype"":""Array"",""offset"":882,""safe"":true},{""name"":""isModuleGrantedToMiniApp"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""}],""returntype"":""Boolean"",""offset"":2164,""safe"":true},{""name"":""getMiniAppRequestCount"",""parameters"":[{""name"":""appId"",""type"":""String""}],""returntype"":""Integer"",""offset"":2303,""safe"":true},{""name"":""getMiniAppFulfilledCount"",""parameters"":[{""name"":""appId"",""type"":""String""}],""returntype"":""Integer"",""offset"":2376,""safe"":true},{""name"":""getTotalRequests"",""parameters"":[],""returntype"":""Integer"",""offset"":2449,""safe"":true},{""name"":""getTotalFulfilled"",""parameters"":[],""returntype"":""Integer"",""offset"":2487,""safe"":true},{""name"":""isIndexRebuildRequired"",""parameters"":[],""returntype"":""Boolean"",""offset"":2525,""safe"":true},{""name"":""indexRebuildCursor"",""parameters"":[],""returntype"":""Integer"",""offset"":2541,""safe"":true},{""name"":""getRequest"",""parameters"":[{""name"":""requestId"",""type"":""Integer""}],""returntype"":""Array"",""offset"":2578,""safe"":true},{""name"":""getInboxItem"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requestId"",""type"":""Integer""}],""returntype"":""Array"",""offset"":2645,""safe"":true},{""name"":""getMiniAppState"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""stateKey"",""type"":""ByteArray""}],""returntype"":""ByteArray"",""offset"":2756,""safe"":true},{""name"":""isSponsorshipGated"",""parameters"":[{""name"":""appId"",""type"":""String""}],""returntype"":""Boolean"",""offset"":2907,""safe"":true},{""name"":""isSponsoredRequesterAllowed"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""}],""returntype"":""Boolean"",""offset"":2991,""safe"":true},{""name"":""getSponsoredRequesterCap"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""}],""returntype"":""Integer"",""offset"":3100,""safe"":true},{""name"":""getSponsoredRequesterSpent"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""}],""returntype"":""Integer"",""offset"":3204,""safe"":true},{""name"":""proposeAdmin"",""parameters"":[{""name"":""newAdmin"",""type"":""Hash160""}],""returntype"":""Void"",""offset"":3311,""safe"":false},{""name"":""executeAdminChange"",""parameters"":[],""returntype"":""Void"",""offset"":3575,""safe"":false},{""name"":""cancelAdminChange"",""parameters"":[],""returntype"":""Void"",""offset"":3744,""safe"":false},{""name"":""setUpdater"",""parameters"":[{""name"":""updater"",""type"":""Hash160""}],""returntype"":""Void"",""offset"":3774,""safe"":false},{""name"":""proposeRuntimeEncryptionKey"",""parameters"":[{""name"":""algorithm"",""type"":""String""},{""name"":""publicKey"",""type"":""String""}],""returntype"":""Void"",""offset"":3869,""safe"":false},{""name"":""executeRuntimeEncryptionKey"",""parameters"":[],""returntype"":""Void"",""offset"":4145,""safe"":false},{""name"":""cancelRuntimeEncryptionKey"",""parameters"":[],""returntype"":""Void"",""offset"":4331,""safe"":false},{""name"":""pendingRuntimeEncryptionKeyEta"",""parameters"":[],""returntype"":""Integer"",""offset"":4349,""safe"":true},{""name"":""proposeRuntimeVerificationPublicKey"",""parameters"":[{""name"":""publicKey"",""type"":""PublicKey""}],""returntype"":""Void"",""offset"":4382,""safe"":false},{""name"":""executeRuntimeVerificationPublicKey"",""parameters"":[],""returntype"":""Void"",""offset"":4579,""safe"":false},{""name"":""cancelRuntimeVerificationPublicKey"",""parameters"":[],""returntype"":""Void"",""offset"":4745,""safe"":false},{""name"":""pendingRuntimeVerificationKeyEta"",""parameters"":[],""returntype"":""Integer"",""offset"":4763,""safe"":true},{""name"":""setOracleEncryptionKey"",""parameters"":[{""name"":""algorithm"",""type"":""String""},{""name"":""publicKey"",""type"":""String""}],""returntype"":""Void"",""offset"":4796,""safe"":false},{""name"":""setOracleVerificationPublicKey"",""parameters"":[{""name"":""publicKey"",""type"":""PublicKey""}],""returntype"":""Void"",""offset"":4807,""safe"":false},{""name"":""setRequestFee"",""parameters"":[{""name"":""amount"",""type"":""Integer""}],""returntype"":""Void"",""offset"":4817,""safe"":false},{""name"":""withdrawAccruedFees"",""parameters"":[{""name"":""to"",""type"":""Hash160""},{""name"":""amount"",""type"":""Integer""}],""returntype"":""Void"",""offset"":4899,""safe"":false},{""name"":""setRequestTTL"",""parameters"":[{""name"":""ttlMs"",""type"":""Integer""}],""returntype"":""Void"",""offset"":5134,""safe"":false},{""name"":""expireStaleRequest"",""parameters"":[{""name"":""requestId"",""type"":""Integer""}],""returntype"":""Void"",""offset"":5218,""safe"":false},{""name"":""registerSystemModule"",""parameters"":[{""name"":""moduleId"",""type"":""String""},{""name"":""endpoint"",""type"":""String""},{""name"":""schemaHash"",""type"":""String""}],""returntype"":""Void"",""offset"":6040,""safe"":false},{""name"":""configureSystemModule"",""parameters"":[{""name"":""moduleId"",""type"":""String""},{""name"":""endpoint"",""type"":""String""},{""name"":""schemaHash"",""type"":""String""},{""name"":""active"",""type"":""Boolean""}],""returntype"":""Void"",""offset"":6269,""safe"":false},{""name"":""registerMiniApp"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""appAdmin"",""type"":""Hash160""},{""name"":""feePayer"",""type"":""Hash160""},{""name"":""callbackContract"",""type"":""Hash160""},{""name"":""metadataUri"",""type"":""String""},{""name"":""metadataHash"",""type"":""String""}],""returntype"":""Void"",""offset"":6363,""safe"":false},{""name"":""configureMiniApp"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""feePayer"",""type"":""Hash160""},{""name"":""callbackContract"",""type"":""Hash160""},{""name"":""metadataUri"",""type"":""String""},{""name"":""metadataHash"",""type"":""String""},{""name"":""active"",""type"":""Boolean""}],""returntype"":""Void"",""offset"":7460,""safe"":false},{""name"":""setSponsoredRequesterAllowed"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""},{""name"":""allowed"",""type"":""Boolean""}],""returntype"":""Void"",""offset"":7689,""safe"":false},{""name"":""setSponsoredRequesterCap"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""},{""name"":""cap"",""type"":""Integer""}],""returntype"":""Void"",""offset"":7865,""safe"":false},{""name"":""grantModuleToMiniApp"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""}],""returntype"":""Void"",""offset"":8039,""safe"":false},{""name"":""revokeModuleFromMiniApp"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""}],""returntype"":""Void"",""offset"":8185,""safe"":false},{""name"":""putMiniAppState"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""stateKey"",""type"":""ByteArray""},{""name"":""value"",""type"":""ByteArray""}],""returntype"":""Void"",""offset"":8286,""safe"":false},{""name"":""putMiniAppStateBatch"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""stateKeys"",""type"":""Array""},{""name"":""values"",""type"":""Array""}],""returntype"":""Void"",""offset"":8553,""safe"":false},{""name"":""deleteMiniAppState"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""stateKey"",""type"":""ByteArray""}],""returntype"":""Void"",""offset"":8825,""safe"":false},{""name"":""submitMiniAppRequest"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""},{""name"":""operation"",""type"":""String""},{""name"":""payload"",""type"":""ByteArray""}],""returntype"":""Integer"",""offset"":8901,""safe"":false},{""name"":""submitMiniAppRequestFromIntegration"",""parameters"":[{""name"":""requester"",""type"":""Hash160""},{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""},{""name"":""operation"",""type"":""String""},{""name"":""payload"",""type"":""ByteArray""}],""returntype"":""Integer"",""offset"":10034,""safe"":false},{""name"":""requestFromCallback"",""parameters"":[{""name"":""requester"",""type"":""Hash160""},{""name"":""requestType"",""type"":""String""},{""name"":""payload"",""type"":""ByteArray""},{""name"":""callbackContract"",""type"":""Hash160""},{""name"":""callbackMethod"",""type"":""String""}],""returntype"":""Integer"",""offset"":10206,""safe"":false},{""name"":""queueSystemRequest"",""parameters"":[{""name"":""requester"",""type"":""Hash160""},{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""},{""name"":""operation"",""type"":""String""},{""name"":""payload"",""type"":""ByteArray""}],""returntype"":""Integer"",""offset"":10841,""safe"":false},{""name"":""queueAutomationRequest"",""parameters"":[{""name"":""requester"",""type"":""Hash160""},{""name"":""requestType"",""type"":""String""},{""name"":""payload"",""type"":""ByteArray""},{""name"":""callbackContract"",""type"":""Hash160""},{""name"":""callbackMethod"",""type"":""String""}],""returntype"":""Integer"",""offset"":10979,""safe"":false},{""name"":""request"",""parameters"":[{""name"":""requestType"",""type"":""String""},{""name"":""payload"",""type"":""ByteArray""},{""name"":""callbackContract"",""type"":""Hash160""},{""name"":""callbackMethod"",""type"":""String""}],""returntype"":""Integer"",""offset"":11125,""safe"":false},{""name"":""onNEP17Payment"",""parameters"":[{""name"":""from"",""type"":""Hash160""},{""name"":""amount"",""type"":""Integer""},{""name"":""data"",""type"":""Any""}],""returntype"":""Void"",""offset"":11270,""safe"":false},{""name"":""fulfillRequest"",""parameters"":[{""name"":""requestId"",""type"":""Integer""},{""name"":""success"",""type"":""Boolean""},{""name"":""result"",""type"":""ByteArray""},{""name"":""error"",""type"":""String""},{""name"":""verificationSignature"",""type"":""ByteArray""}],""returntype"":""Void"",""offset"":11750,""safe"":false},{""name"":""scheduleUpdate"",""parameters"":[{""name"":""nefFile"",""type"":""ByteArray""},{""name"":""manifest"",""type"":""String""}],""returntype"":""Void"",""offset"":12921,""safe"":false},{""name"":""update"",""parameters"":[{""name"":""nefFile"",""type"":""ByteArray""},{""name"":""manifest"",""type"":""String""}],""returntype"":""Void"",""offset"":13103,""safe"":false},{""name"":""cancelUpdate"",""parameters"":[],""returntype"":""Void"",""offset"":13308,""safe"":false},{""name"":""rebuildIndexes"",""parameters"":[{""name"":""startIndex"",""type"":""Integer""},{""name"":""count"",""type"":""Integer""}],""returntype"":""Void"",""offset"":13338,""safe"":false},{""name"":""defaultSponsoredRequesterCap"",""parameters"":[],""returntype"":""Integer"",""offset"":9575,""safe"":true},{""name"":""setDefaultSponsoredRequesterCap"",""parameters"":[{""name"":""cap"",""type"":""Integer""}],""returntype"":""Void"",""offset"":13774,""safe"":false},{""name"":""isSponsorshipOpen"",""parameters"":[{""name"":""appId"",""type"":""String""}],""returntype"":""Boolean"",""offset"":13856,""safe"":true},{""name"":""setSponsorshipOpen"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""open"",""type"":""Boolean""}],""returntype"":""Void"",""offset"":13894,""safe"":false},{""name"":""_initialize"",""parameters"":[],""returntype"":""Void"",""offset"":13969,""safe"":false}],""events"":[{""name"":""MiniAppRegistered"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""admin"",""type"":""Hash160""},{""name"":""feePayer"",""type"":""Hash160""},{""name"":""callbackContract"",""type"":""Hash160""}]},{""name"":""MiniAppUpdated"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""admin"",""type"":""Hash160""},{""name"":""feePayer"",""type"":""Hash160""},{""name"":""callbackContract"",""type"":""Hash160""},{""name"":""active"",""type"":""Boolean""}]},{""name"":""SystemModuleRegistered"",""parameters"":[{""name"":""moduleId"",""type"":""String""},{""name"":""endpoint"",""type"":""String""},{""name"":""schemaHash"",""type"":""String""}]},{""name"":""SystemModuleUpdated"",""parameters"":[{""name"":""moduleId"",""type"":""String""},{""name"":""endpoint"",""type"":""String""},{""name"":""schemaHash"",""type"":""String""},{""name"":""active"",""type"":""Boolean""}]},{""name"":""MiniAppCapabilityGranted"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""}]},{""name"":""MiniAppCapabilityRevoked"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""}]},{""name"":""MiniAppRequestQueued"",""parameters"":[{""name"":""requestId"",""type"":""Integer""},{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""},{""name"":""operation"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""},{""name"":""sponsor"",""type"":""Hash160""},{""name"":""payload"",""type"":""ByteArray""},{""name"":""payloadHash"",""type"":""ByteArray""}]},{""name"":""MiniAppRequestCompleted"",""parameters"":[{""name"":""requestId"",""type"":""Integer""},{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""},{""name"":""operation"",""type"":""String""},{""name"":""success"",""type"":""Boolean""},{""name"":""resultHash"",""type"":""ByteArray""},{""name"":""resultSize"",""type"":""Integer""},{""name"":""error"",""type"":""String""}]},{""name"":""MiniAppInboxStored"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requestId"",""type"":""Integer""},{""name"":""requester"",""type"":""Hash160""},{""name"":""success"",""type"":""Boolean""}]},{""name"":""MiniAppStateChanged"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""stateKey"",""type"":""ByteArray""},{""name"":""valueSize"",""type"":""Integer""}]},{""name"":""AdminChanged"",""parameters"":[{""name"":""oldAdmin"",""type"":""Hash160""},{""name"":""newAdmin"",""type"":""Hash160""}]},{""name"":""UpdaterChanged"",""parameters"":[{""name"":""oldUpdater"",""type"":""Hash160""},{""name"":""newUpdater"",""type"":""Hash160""}]},{""name"":""RuntimeEncryptionKeyUpdated"",""parameters"":[{""name"":""version"",""type"":""Integer""},{""name"":""algorithm"",""type"":""String""},{""name"":""publicKey"",""type"":""String""}]},{""name"":""RuntimeVerifierUpdated"",""parameters"":[{""name"":""oldVerifier"",""type"":""PublicKey""},{""name"":""newVerifier"",""type"":""PublicKey""}]},{""name"":""RequestFeeUpdated"",""parameters"":[{""name"":""oldFee"",""type"":""Integer""},{""name"":""newFee"",""type"":""Integer""}]},{""name"":""RequestFeeDeposited"",""parameters"":[{""name"":""from"",""type"":""Hash160""},{""name"":""amount"",""type"":""Integer""},{""name"":""creditBalance"",""type"":""Integer""}]},{""name"":""AccruedFeesWithdrawn"",""parameters"":[{""name"":""to"",""type"":""Hash160""},{""name"":""amount"",""type"":""Integer""}]},{""name"":""RequestExpired"",""parameters"":[{""name"":""requestId"",""type"":""Integer""},{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""},{""name"":""sponsor"",""type"":""Hash160""},{""name"":""refundAmount"",""type"":""Integer""}]},{""name"":""RequestTTLUpdated"",""parameters"":[{""name"":""oldTTL"",""type"":""Integer""},{""name"":""newTTL"",""type"":""Integer""}]},{""name"":""SponsoredRequesterAllowed"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""},{""name"":""allowed"",""type"":""Boolean""}]},{""name"":""SponsoredRequesterCapUpdated"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""},{""name"":""cap"",""type"":""Integer""}]},{""name"":""AdminTimelockProposed"",""parameters"":[{""name"":""proposed"",""type"":""Hash160""},{""name"":""executeAfter"",""type"":""Integer""}]},{""name"":""UpgradeScheduled"",""parameters"":[{""name"":""executeAfter"",""type"":""Integer""}]},{""name"":""ContractUpgraded"",""parameters"":[{""name"":""nefHash"",""type"":""ByteArray""},{""name"":""manifestHash"",""type"":""ByteArray""}]},{""name"":""SecurityKeyChangeProposed"",""parameters"":[{""name"":""kind"",""type"":""String""},{""name"":""executeAfter"",""type"":""Integer""}]},{""name"":""SponsorshipModeChanged"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""mode"",""type"":""Integer""}]},{""name"":""SponsorDefaultCapUpdated"",""parameters"":[{""name"":""oldCap"",""type"":""Integer""},{""name"":""newCap"",""type"":""Integer""}]}]},""permissions"":[{""contract"":""0x726cb6e0cd8628a1350a611384688911ab75f51b"",""methods"":[""sha256"",""verifyWithECDsa""]},{""contract"":""0xacce6fd80d44e1796aa0c2c625e9e4e0ce39efc0"",""methods"":[""deserialize"",""serialize""]},{""contract"":""0xd2a4cff31913016155e38e474a2c06d08be276cf"",""methods"":[""transfer""]},{""contract"":""0xfffdc93764dbaddd97c48f252a53ea4643faa3fd"",""methods"":[""hasMethod"",""update""]},{""contract"":""*"",""methods"":[""onMiniAppResult"",""onOracleResult""]}],""trusts"":[],""extra"":{""Author"":""Morpheus Oracle"",""Version"":""2.0.0"",""Description"":""MiniApp OS kernel with shared IO, registration, and callback orchestration"",""nef"":{""optimization"":""Basic""}}}");

    /// <summary>
    /// Optimization: "Basic"
    /// </summary>
    public static Neo.SmartContract.NefFile Nef => Convert.FromBase64String(@"TkVGM05lby5Db21waWxlci5DU2hhcnAgMy45LjErNWZhOTU2NmU1MTY1ZWRlMjE2NWE5YmUxZjRhMDEyMGMxNzYuLi4AAAf9o/pDRupTKiWPxJfdrdtkN8n9/wloYXNNZXRob2QDAAEPwO85zuDk6SXGwqBqeeFEDdhvzqwLZGVzZXJpYWxpemUBAAEPwO85zuDk6SXGwqBqeeFEDdhvzqwJc2VyaWFsaXplAQABDxv1dasRiWiEE2EKNaEohs3gtmxyBnNoYTI1NgEAAQ/PduKL0AYsSkeO41VhARMZ88+k0gh0cmFuc2ZlcgQAAQ8b9XWrEYlohBNhCjWhKIbN4LZscg92ZXJpZnlXaXRoRUNEc2EEAAEP/aP6Q0bqUyolj8SX3a3bZDfJ/f8GdXBkYXRlAwAADwAA/cs3VwMCeRfOC5cmBQgiE3kXzkrZKCQGRQkiBsoAFLOqJgcjqgAAABgMD29uTWluaUFwcFJlc3VsdHkXzjcAAHAVDA5vbk9yYWNsZVJlc3VsdHkXzjcAAHFoJj87OAB5Hc55HM55G855Fc55E855Es55Ec54GMAfDA9vbk1pbmlBcHBSZXN1bHR5F85BYn1bUkU9BXI9AiI2aSYzOy4AeR3OeRzOeRvOeRPOeBXAHwwOb25PcmFjbGVSZXN1bHR5F85BYn1bUkU9BXI9AkBK2SgkBkUJIgbKABSzQDcAAEBBYn1bUkBXAQJ5Jic19gEAABC3JhkRWUGb9mfOQeY/GIRaQZv2Z85BL1jF7SPVAQAAQS1RCDBwaBPOW0Gb9mfOQeY/GIQQXEGb9mfOQeY/GIQCQEIPAF1Bm/ZnzkHmPxiEDB9tb3JwaGV1cy5tb2R1bGUub3JhY2xlLmZldGNoLnYxDBMvb3JhY2xlL3NtYXJ0LWZldGNoDAxvcmFjbGUuZmV0Y2g1sQEAAAwebW9ycGhldXMubW9kdWxlLmNvbXB1dGUucnVuLnYxDBAvY29tcHV0ZS9leGVjdXRlDAtjb21wdXRlLnJ1bjVtAQAADBxtb3JwaGV1cy5tb2R1bGUuZmVlZC5yZWFkLnYxDAwvb3JhY2xlL2ZlZWQMCWZlZWQucmVhZDUxAQAADB9tb3JwaGV1cy5tb2R1bGUuZmVlZC5wdWJsaXNoLnYxDAwvb3JhY2xlL2ZlZWQMDGZlZWQucHVibGlzaDXvAAAADCJtb3JwaGV1cy5tb2R1bGUuaWRlbnRpdHkudmVyaWZ5LnYxDA8vbmVvZGlkL3Jlc29sdmUMD2lkZW50aXR5LnZlcmlmeTWkAAAADCFtb3JwaGV1cy5tb2R1bGUuYXV0b21hdGlvbi5ydW4udjEMEy9hdXRvbWF0aW9uL2V4ZWN1dGUMDmF1dG9tYXRpb24ucnVuNFdAVwEAWEGb9mfOQZJd6DFwaAuXJgUQIg1oStgmBkUQIgTbISICQEGSXegxQEGb9mfOQErYJgZFECIE2yFAQeY/GIRAQS9Yxe1AQS1RCDBAQeY/GIRAVwADeDQ7FM4QtyYEIjJBt8OIAwh6eXg1sgAAAHp5eBPADBZTeXN0ZW1Nb2R1bGVSZWdpc3RlcmVkQZUBb2FAVwEBDBFpbnZhbGlkIG1vZHVsZSBpZABAeDQheDRGwUVTi1BBkl3oMXBoC5cmB3g0PyIIaDcBACICQFcAA3gLmCQFCSIGeMoQtyQFCSIGeMp5tiQEeuBAwUVTi1BBkl3oMUBeQZv2Z84SwEASwEBXAAEQEAkMAAwAeErYJgVFDAAWvyICQEA3AQBAVwIFeDVy////cGgUzhCXJghoFM54NCFBt8OIA3x7enl4Fr9xaTcCAHg0r8FFU4tQQeY/GIRAVwECeRC3JgQiJDQjcHho2zA0TcFFU4tQQeY/GIRoEZ5fB0Gb9mfOQeY/GIRAVwEAXwdBm/ZnzkGSXegxcGgLlyYFECINaErYJgZFECIE2yEiAkDBRVOLUEHmPxiEQF8IQZv2Z84SwEBBt8OIA0DBRVOLUEHmPxiEQDcCAEBbQZv2Z85Bkl3oMUrYJAlKygAUKAM6IgJAXwlBm/ZnzkGSXegxStgkCUrKABQoAzoiAkBfCkGb9mfOQZJd6DEiAkBAXwtBm/ZnzkGSXegxIgJAVwEAXwxBm/ZnzkGSXegxcGgLlyYFECINaErYJgZFECIE2yEiAkBXAQBfDUGb9mfOQZJd6DFwaAuXJgULIhJo2zDbKErYJAlKygAhKAM6IgJA2yhK2CQJSsoAISgDOkDbMEA1f////0A0iUA0lUA0uEBXAQBdQZv2Z85Bkl3oMXBoC5cmCQJAQg8AIg1oStgmBkUQIgTbISICQDTXQFcBAF8OQZv2Z85Bkl3oMXBoC5cmCQKA7jYAIg1oStgmBkUQIgTbISICQFcBAXgLlyYFCCIReErZKCQGRQkiBsoAFLOqJgUQIid42zA0McFFU4tQQZJd6DFwaAuXJgUQIg1oStgmBkUQIgTbISICQMFFU4tQQZJd6DFA2zBAXw9Bm/ZnzhLAQFcBAF8QQZv2Z85Bkl3oMXBoC5cmBRAiDWhK2CYGRRAiBNshIgJAVwEAXxFBm/ZnzkGSXegxcGgLlyYFECINaErYJgZFECIE2yEiAkBXAQA0sTTVn3BoELcmBWgiAxAiAkBXAAF4ELYmBCISNLt4nl8RQZv2Z85B5j8YhEBXAgF4ELYmBCIeNKBwaHi3JgdoeJ8iAxBxaV8RQZv2Z85B5j8YhEBXAQF4ELgkEgwNaW52YWxpZCBpbmRleOB42zA0GsFFU4tQQZJd6DFwaAuXJgYMACIDaCICQF8SQZv2Z84SwEBXAQF4ELgkEgwNaW52YWxpZCBpbmRleOB42zA1bv3//8FFU4tQQZJd6DFwaAuXJgYMACIDaCICQFcDADWd+///SgIAAACAAwAAAIAAAAAAuyQDOnBow3EQciJBajVl////SmlqUdBFakqcSgIAAACALgQiCkoC////fzIeA/////8AAAAAkUoC////fzIMAwAAAAABAAAAn3JFami1JL5pIgJAVwMANbL8//9KAgAAAIADAAAAgAAAAAC7JAM6cGjDcRByIkFqNTn///9KaWpR0EVqSpxKAgAAAIAuBCIKSgL///9/Mh4D/////wAAAACRSgL///9/MgwDAAAAAAEAAACfckVqaLUkvmkiAkBXAQEMDmludmFsaWQgYXBwIGlkAEB4NYH7//94NB7BRVOLUEGSXegxcGgLlyYHeDQVIghoNwEAIgJAXxNBm/ZnzhLAQFcAARAQCQwADAALCwt4StgmBUUMABm/IgJAQFcAAgwOaW52YWxpZCBhcHAgaWQAQHg1Ivv//wwRaW52YWxpZCBtb2R1bGUgaWQAQHk1B/v//3l4NBM0R8FFU4tQQZJd6DELmCICQFcBAnhK2CYFRQwANwMAeUrYJgVFDAA3AwCL2yjbMHBo2yg3AwDbMCICQIvbKEA3AwBAQNsoQF8UQZv2Z84SwEBXAQEMDmludmFsaWQgYXBwIGlkAEB4NZf6//94NCPBRVOLUEGSXegxcGgLlyYFECINaErYJgZFECIE2yEiAkBfFUGb9mfOEsBAVwEBDA5pbnZhbGlkIGFwcCBpZABAeDVO+v//eDQjwUVTi1BBkl3oMXBoC5cmBRAiDWhK2CYGRRAiBNshIgJAXxZBm/ZnzhLAQFcBAF8XQZv2Z85Bkl3oMXBoC5cmBRAiDWhK2CYGRRAiBNshIgJAVwEAXxhBm/ZnzkGSXegxcGgLlyYFECINaErYJgZFECIE2yEiAkBZQZv2Z85Bkl3oMQuYIgJAVwEAWkGb9mfOQZJd6DFwaAuXJgUQIg1oStgmBkUQIgTbISICQFcBAXjbMDQywUVTi1BBkl3oMXBoC5cmGxAMAAwACRAQEAsLCwwADAAMAAwAEB+/IghoNwEAIgJAXxlBm/ZnzhLAQEBXAQIMDmludmFsaWQgYXBwIGlkAEB4NUH5//95eDQsNEXBRVOLUEGSXegxcGgLlyYTEAwADAAJCwwADAB5eBm/IghoNwEAIgJAVwACeErYJgVFDAA3AwB52zDbKIvbKNswIgJAXxpBm/ZnzhLAQEBXAQIMDmludmFsaWQgYXBwIGlkAEB4NdL4//95NCB5eDRPNGvBRVOLUEGSXegxcGgLlyYGDAAiA2giAkBXAAF4C5gkBQkiBnjKELckBQkiCHjKAYAAtiQWDBFpbnZhbGlkIHN0YXRlIGtleeBAykBXAAJ4StgmBUUMADcDAHlK2CYFRQwAi9so2zAiAkBfG0Gb9mfOEsBAVwABDA5pbnZhbGlkIGFwcCBpZABAeDU7+P//eDQHEZciAkBXAQF4NCPBRVOLUEGSXegxcGgLlyYFECINaErYJgZFECIE2yEiAkBfHEGb9mfOEsBAVwACDA5pbnZhbGlkIGFwcCBpZABAeDXn9///eQuXJgUIIhF5StkoJAZFCSIGygAUs6omBQkiFnl4NBM0KMFFU4tQQZJd6DELmCICQFcAAnhK2CYFRQwANwMAeYvbKNswIgJAXx1Bm/ZnzhLAQFcBAgwOaW52YWxpZCBhcHAgaWQAQHg1evf//3kLlyYFCCIReUrZKCQGRQkiBsoAFLOqJgUQIih5eDSmNCPBRVOLUEGSXegxcGgLlyYFECINaErYJgZFECIE2yEiAkBfHkGb9mfOEsBAVwECDA5pbnZhbGlkIGFwcCBpZABAeDUS9///eQuXJgUIIhF5StkoJAZFCSIGygAUs6omBRAiK3l4NT7///80I8FFU4tQQZJd6DFwaAuXJgUQIg1oStgmBkUQIgTbISICQF8fQZv2Z84SwEBXAQE1tgAAAHgLmCQFCSIQeErZKCQGRQkiBsoAFLMkEgwNaW52YWxpZCBhZG1pbuB4NY/3//+YJA8MCnNhbWUgYWRtaW7gQbfDiAMCAFwmBZ5KEC4EIhZKBP//////////AAAAAAAAAAAyFAT//////////wAAAAAAAAAAkXB4XyBBm/ZnzkHmPxiEaF8hQZv2Z85B5j8YhGh4EsAMFUFkbWluVGltZWxvY2tQcm9wb3NlZEGVAW9hQFcBADUE9///cGgLmCQFCSIQaErZKCQGRQkiBsoAFLMkEgwNYWRtaW4gbm90IHNldOBoQfgn7IwkEQwMdW5hdXRob3JpemVk4EBB+CfsjEBXBABfIEGb9mfOQZJd6DFwaAuYJBUMEG5vIHBlbmRpbmcgYWRtaW7gXyFBm/ZnzkGSXegxStgmBkUQIgTbIXFBt8OIA2m4JBQMD3RpbWVsb2NrIGFjdGl2ZeA1Xvb//3JoStgkCUrKABQoAzpza1tBm/ZnzkHmPxiEXyBBm/ZnzkEvWMXtXyFBm/ZnzkEvWMXta2oSwAwMQWRtaW5DaGFuZ2VkQZUBb2FANQj///9fIEGb9mfOQS9Yxe1fIUGb9mfOQS9Yxe1AVwEBNef+//94C5gkBQkiEHhK2SgkBkUJIgbKABSzJBQMD2ludmFsaWQgdXBkYXRlcuA12PX//3B4XwlBm/ZnzkHmPxiEeGgSwAwOVXBkYXRlckNoYW5nZWRBlQFvYUBXAQI1iP7//3gLmCQFCSIGeMoQtyQXDBJhbGdvcml0aG0gcmVxdWlyZWTgeQuYJAUJIgZ5yhC3JBgME3B1YmxpYyBrZXkgcmVxdWlyZWTgeMoAQLYkFwwSYWxnb3JpdGhtIHRvbyBsb25n4HnKAQAItiQYDBNwdWJsaWMga2V5IHRvbyBsb25n4EG3w4gDAgBcJgWeShAuBCIWSgT//////////wAAAAAAAAAAMhQE//////////8AAAAAAAAAAJF5eBPAcGg3AgBfIkGb9mfOQeY/GIRoEs4MFnJ1bnRpbWUtZW5jcnlwdGlvbi1rZXkSwAwZU2VjdXJpdHlLZXlDaGFuZ2VQcm9wb3NlZEGVAW9hQEBXAwBfIkGb9mfOQZJd6DFwaAuYJBoMFW5vIHBlbmRpbmcga2V5IGNoYW5nZeBoNwEAcUG3w4gDaRLOuCQUDA90aW1lbG9jayBhY3RpdmXgNYH0//8RnnJpEM5fCkGb9mfOQeY/GIRpEc5fC0Gb9mfOQeY/GIRqXwxBm/ZnzkHmPxiEXyJBm/ZnzkEvWMXtaRHOaRDOahPADBtSdW50aW1lRW5jcnlwdGlvbktleVVwZGF0ZWRBlQFvYUA1vfz//18iQZv2Z85BL1jF7UBXAQBfIkGb9mfOQZJd6DFwaAuXJgUQIgpoNwEAEs4iAkBXAQE1h/z//3gLmCQFCSIMeErZKFDKACGzqyQVDBBpbnZhbGlkIHZlcmlmaWVy4EG3w4gDAgBcJgWeShAuBCIWSgT//////////wAAAAAAAAAAMhQE//////////8AAAAAAAAAAJF4EsBwaDcCAF8jQZv2Z85B5j8YhGgRzgwYcnVudGltZS12ZXJpZmljYXRpb24ta2V5EsAMGVNlY3VyaXR5S2V5Q2hhbmdlUHJvcG9zZWRBlQFvYUBK2ShQygAhs6tAQFcEAF8jQZv2Z85Bkl3oMXBoC5gkHwwabm8gcGVuZGluZyB2ZXJpZmllciBjaGFuZ2XgaDcBAHFBt8OIA2kRzrgkFAwPdGltZWxvY2sgYWN0aXZl4DXw8v//cmkQzkrYJAlKygAhKAM6c2kQzl8NQZv2Z85B5j8YhF8jQZv2Z85BL1jF7WtqEsAMFlJ1bnRpbWVWZXJpZmllclVwZGF0ZWRBlQFvYUA1H/v//18jQZv2Z85BL1jF7UBXAQBfI0Gb9mfOQZJd6DFwaAuXJgUQIgpoNwEAEc4iAkBXAAJ5eDVc/P//QFcAAXg1U/7//0BXAQE11Pr//3gQtyQYDBNpbnZhbGlkIHJlcXVlc3QgZmVl4DV+8v//cHhdQZv2Z85B5j8YhHhoEsAMEVJlcXVlc3RGZWVVcGRhdGVkQZUBb2FAVwMCNYL6//94C5gkBQkiEHhK2SgkBkUJIgbKABSzJBYMEWludmFsaWQgcmVjaXBpZW504HkQtyQTDA5pbnZhbGlkIGFtb3VudOA1uPL//3A12PL//3FoaZ9yanm4JDIMLWFtb3VudCBleGNlZWRzIHdpdGhkcmF3YWJsZSAodW5yZXNlcnZlZCkgZmVlc+ALeXhB2/6odDcEACQYDBNmZWUgdHJhbnNmZXIgZmFpbGVk4Gh5n18QQZv2Z85B5j8YhHl4EsAMFEFjY3J1ZWRGZWVzV2l0aGRyYXduQZUBb2FANwQAQEHb/qh0QFcBATWX+f//eBC3JBkMFFRUTCBtdXN0IGJlIHBvc2l0aXZl4DVs8f//cHhfDkGb9mfOQeY/GIR4aBLADBFSZXF1ZXN0VFRMVXBkYXRlZEGVAW9hQFcKATVK8P//cDVd8P//cWgLmCQFCSIQaErZKCQGRQkiBsoAFLMkBQkiCGhB+CfsjHJpC5gkBQkiEGlK2SgkBkUJIgbKABSzJAUJIghpQfgn7IxzaiYFCCIDayQRDAx1bmF1dGhvcml6ZWTgeDVE9f//dGwQzhC3JBYMEXJlcXVlc3Qgbm90IGZvdW5k4GwYzhCXJBgME3JlcXVlc3Qgbm90IHBlbmRpbmfgNZLw//91QbfDiANsGc6fdm5ttyQcDBdyZXF1ZXN0IGhhcyBub3QgZXhwaXJlZOASSmwYUdBFQbfDiANKbBpR0EUJSmwbUdBFDB1yZXF1ZXN0IGV4cGlyZWQ6IFRUTCBleGNlZWRlZEpsHVHQRWw3AgB42zA1yvT//8FFU4tQQeY/GIQQdwdsFs4LmCQFCSISbBbOStkoJAZFCSIGygAUsyQFCSIHbB7OELcmVjVt8P//dwhvCGwezrUmBm8IIgVsHs5KdwdFbwcQtyY2bBbONe3v//93CW8JbweebBbO2zA1L/D//8FFU4tQQeY/GIRvCG8Hn18QQZv2Z85B5j8YhGwWzguYJAUJIhJsFs5K2SgkBkUJIgbKABSzJAUJIglsFs5sFc6YJAUJIgdsHs4QtyYQbB7ObBXObBHONc4AAABsHs41UvD//0G3w4gDbB3ODAAJbBXObBPObBLOeGwRzhm/dwhvCDcCAHhsEc41JfT//zU79P//wUVTi1BB5j8YhAlsFc54bBHOFMAMEk1pbmlBcHBJbmJveFN0b3JlZEGVAW9hbwdsFs5sFc5sEc54FcAMDlJlcXVlc3RFeHBpcmVkQZUBb2FsHc4QDAA1rgAAAAlsE85sEs5sEc54GMAMF01pbmlBcHBSZXF1ZXN0Q29tcGxldGVkQZUBb2FAwUVTi1BB5j8YhEBXBAN6ELYmBQgiBXkLlyYFCCIReUrZKCQGRQkiBsoAFLOqJgQiTXl4Nb70//9waDWh9f//wUVTi1BBkl3oMXFpC5cmBRAiDWlK2CYGRRAiBNshcmp6n3NrELUmBhBKc0VraDVu9f//wUVTi1BB5j8YhEBXAAF4StgmBUUMADcDACICQFcBAzUN9v//enl4NFl4Nczr//9waBTOEJckGgwVbW9kdWxlIGFscmVhZHkgZXhpc3Rz4EG3w4gDCHp5eDUo7P//enl4E8AMFlN5c3RlbU1vZHVsZVJlZ2lzdGVyZWRBlQFvYUBXAAMMEWludmFsaWQgbW9kdWxlIGlkAEB4NZfr//95C5gkBQkiBnnKELckBQkiCHnKAQABtiQcDBdpbnZhbGlkIG1vZHVsZSBlbmRwb2ludOB6C5gkBQkiBnrKELckBQkiCHrKAYAAtiQYDBNpbnZhbGlkIHNjaGVtYSBoYXNo4EBXAQQ1KPX//3p5eDV0////eDXk6v//cGgUzhC3JBUMEG1vZHVsZSBub3QgZm91bmTgaBTOe3p5eDVH6///e3p5eBTADBNTeXN0ZW1Nb2R1bGVVcGRhdGVkQZUBb2FAVwEGfXx7enl4NYkAAAB5Qfgn7IwmBQgiDDW76///Qfgn7IwkEQwMdW5hdXRob3JpemVk4Hp5NV4BAAB4Nf7u//9waBfOEJckGwwWbWluaWFwcCBhbHJlYWR5IGV4aXN0c+BBt8OIAwh9fHt6eXg17QEAAHt6eXgUwAwRTWluaUFwcFJlZ2lzdGVyZWRBlQFvYUBXAAYMDmludmFsaWQgYXBwIGlkAEB4NSnq//95C5gkBQkiEHlK2SgkBkUJIgbKABSzJBoMFWludmFsaWQgbWluaWFwcCBhZG1pbuB6C5gkBQkiEHpK2SgkBkUJIgbKABSzJBYMEWludmFsaWQgZmVlIHBheWVy4HsLmCYue0rZKCQGRQkiBsoAFLMkHgwZaW52YWxpZCBjYWxsYmFjayBjb250cmFjdOB9fDQDQFcAAngLlyYFCCIIeMoBAAG2JBoMFW1ldGFkYXRhIHVyaSB0b28gbG9uZ+B5C5cmBQgiCHnKAYAAtiQbDBZtZXRhZGF0YSBoYXNoIHRvbyBsb25n4EBXAwJ5DBQAAAAAAAAAAAAAAAAAAAAAAAAAAJcmByOSAAAAeUH4J+yMJgcjhQAAADUR6v//cGgLmCQFCSIQaErZKCQGRQkiBsoAFLMkBQkiBXlolyQFCSIIaEH4J+yMcXgLmCQFCSIQeErZKCQGRQkiBsoAFLMkBQkiBXl4lyQFCSIIeEH4J+yMcmkmBQgiA2okHwwaZmVlIHBheWVyIHdpdG5lc3MgcmVxdWlyZWTgQAwUAAAAAAAAAAAAAAAAAAAAAAAAAABAVwQINaTu//+qJBsMFmluZGV4IHJlYnVpbGQgcmVxdWlyZWTgeDW67P//cGgXzhCXJgtoF854NR4BAABoE85xaQuYJAUJIhBpStkoJAZFCSIGygAUsyQFCSIFaXuYJjRp2zA1JAEAAMFFU4tQQZJd6DFyaguYJAUJIgVqeJcmFGnbMDUEAQAAwUVTi1BBL1jF7XsLmCQFCSIQe0rZKCQGRQkiBsoAFLMmbXvbMDXaAAAAwUVTi1BBkl3oMXJqC5cmBQgiBWp4lyYXeHvbMDW5AAAAwUVTi1BB5j8YhCI4ajUA7P//c2sXzhC3JAUJIgdrEc55lyQgDBtjYWxsYmFjayBhbHJlYWR5IHJlZ2lzdGVyZWTgeTWGAAAAejWAAAAAQbfDiAN/B359StgmBUUMAHxK2CYFRQwAe3p5eBm/cmo3AgB4NdXr///BRVOLUEHmPxiEQFcBAnkQtyYEIik1S+b//3B4aNswNV/q///BRVOLUEHmPxiEaBGeWEGb9mfOQeY/GIRAXyRBm/ZnzhLAQMFFU4tQQS9Yxe1AVwABeAuYJAUJIhB4StkoJAZFCSIGygAUsyQFCSIaeAwUAAAAAAAAAAAAAAAAAAAAAAAAAACYJhIReNswNA3BRVOLUEHmPxiEQF8lQZv2Z84SwEBXAQZ4NExwaDRxfHt6eWgRzng1N/z//3loEc41MP3//2gXzn18e3p5aBHOeDXm/f//fXp5aBHOeBXADA5NaW5pQXBwVXBkYXRlZEGVAW9hQFcBAXg1ner//3BoF84QtyQWDBFtaW5pYXBwIG5vdCBmb3VuZOBoIgJAVwMBNQ/n//9waAuYJAUJIhBoStkoJAZFCSIGygAUsyQFCSIIaEH4J+yMcXgRzguYJAUJIhJ4Ec5K2SgkBkUJIgbKABSzJAUJIgp4Ec5B+CfsjHJpJgUIIgNqJBEMDHVuYXV0aG9yaXplZOBAVwIDeDVn////cGg0iXkLmCQFCSIQeUrZKCQGRQkiBsoAFLMkFgwRaW52YWxpZCByZXF1ZXN0ZXLgeXg1t+3//3F6JhgRaTXD7f//wUVTi1BB5j8YhHg0OiISaTWu7f//wUVTi1BBL1jF7Xp5eBPADBlTcG9uc29yZWRSZXF1ZXN0ZXJBbGxvd2VkQZUBb2FAVwABEXg1B+3//8FFU4tQQeY/GIRAwUVTi1BB5j8YhEBXAgN4Nbf+//9waDXZ/v//eQuYJAUJIhB5StkoJAZFCSIGygAUsyQWDBFpbnZhbGlkIHJlcXVlc3RlcuB6ELgkEAwLaW52YWxpZCBjYXDgeXg18ez//3F6ELcmG3ppNWPt///BRVOLUEHmPxiEeDVy////IhJpNUvt///BRVOLUEEvWMXtenl4E8AMHFNwb25zb3JlZFJlcXVlc3RlckNhcFVwZGF0ZWRBlQFvYUBXAgJ4NQn+//9weTRIcWg1J/7//xFpEM54NT/p//81cOn//8FFU4tQQeY/GIRpEM54EsAMGE1pbmlBcHBDYXBhYmlsaXR5R3JhbnRlZEGVAW9hQFcBAXg1tOP//3BoFM4QtyQVDBBtb2R1bGUgbm90IGZvdW5k4GgTziQUDA9tb2R1bGUgaW5hY3RpdmXgaCICQFcBAng1d/3//3AMEWludmFsaWQgbW9kdWxlIGlkAEB5NZPj//9oNX79//95eDWZ6P//Ncro///BRVOLUEEvWMXteXgSwAwYTWluaUFwcENhcGFiaWxpdHlSZXZva2VkQZUBb2FAVwEDeDUS/f//cGg0Znk1lOr//3oLmCQFCSIIesoBABC2JBgME2ludmFsaWQgc3RhdGUgdmFsdWXgenl4NZnq//81sur//8FFU4tQQeY/GIR6ynl4E8AME01pbmlBcHBTdGF0ZUNoYW5nZWRBlQFvYUBXBQE13eP//3A18OP//3FoC5gkBQkiEGhK2SgkBkUJIgbKABSzJAUJIghoQfgn7IxyeBHOC5gkBQkiEngRzkrZKCQGRQkiBsoAFLMkBQkiCngRzkH4J+yMc2kLmCQFCSIQaUrZKCQGRQkiBsoAFLMkBQkiCGlB+CfsjHRqJgUIIgNrJgUIIgNsJBEMDHVuYXV0aG9yaXplZOBAVwIDeDUH/P//cGg1W////3kLmCQFCSIGecoQtyQYDBNzdGF0ZSBrZXlzIHJlcXVpcmVk4HoLmCQFCSIHesp5ypckGgwVc3RhdGUgbGVuZ3RoIG1pc21hdGNo4BBxI6kAAAB5ac41Mun//3ppzguYJAUJIgp6ac7KAQAQtiQYDBNpbnZhbGlkIHN0YXRlIHZhbHVl4Hppznlpzng1L+n//zVI6f//wUVTi1BB5j8YhHppzsp5ac54E8AME01pbmlBcHBTdGF0ZUNoYW5nZWRBlQFvYWlKnEoCAAAAgC4EIgpKAv///38yHgP/////AAAAAJFKAv///38yDAMAAAAAAQAAAJ9xRWl5yrUlWP///0BXAQJ4Nff6//9waDVL/v//eTV26P//eXg1ouj//zW76P//wUVTi1BBL1jF7RB5eBPADBNNaW5pQXBwU3RhdGVDaGFuZ2VkQZUBb2FAVwEEQS1RCDATznBoC5gkBQkiEGhK2SgkBkUJIgbKABSzJBcMEnJlcXVlc3RlciByZXF1aXJlZOBoQfgn7IwkGwwWdW5hdXRob3JpemVkIHJlcXVlc3RlcuB7enl4aDQFIgJAVwYFfHt6eTWnAAAAcGgSznh5NUIBAABxaTVQAgAAcmoQtyQFCSIFaXiYJgpqeHk1zQIAADUvAwAAc2oMAAwACRBBt8OIAxBoE85peHxK2CYFRQwAe3p5ax+/dGw3AgBr2zA1wOb//8FFU4tQQeY/GIQ1KQMAAHk1VwMAAGwUzjcDAHVtbBTOaXh7enlrGMAMFE1pbmlBcHBSZXF1ZXN0UXVldWVkQZUBb2FrIgJAVwEEeDR8cHk13Pv//0V6C5gkBQkiBnrKELckBQkiB3rKAEC2JBYMEWludmFsaWQgb3BlcmF0aW9u4HsLlyYFCCIIe8oBABC2JBYMEXBheWxvYWQgdG9vIGxhcmdl4Hl4NT7k//8kFwwSbW9kdWxlIG5vdCBncmFudGVk4GgiAkBXAQF4NRr5//9waBbOJBUMEG1pbmlhcHAgaW5hY3RpdmXgaCICQFcBAzXz4P//cGgQtiYFeSI/eguYJAUJIhB6StkoJAZFCSIGygAUsyQFCSIFenmYJAUJIgp6NRfh//9ouCQFCSIHaHl4NAsmBXoiBXkiAkBXBgN4Na/m//9waBKXJggII4sAAAB5eDUZ5///cWk1Kef//8FFU4tQQZJd6DELmCYFCCJpaTV65///wUVTi1BBkl3oMXNrC5gmEmtK2CYGRRAiBNshSnJFIg9oEZcmBQkiOzQ6SnJFahC2JgUJIi5pNarn///BRVOLUEGSXegxdGwLlyYFECINbErYJgZFECIE2yF1bXqearYiAkBXAQBfJkGb9mfOQZJd6DFwaAuXJgkCAOH1BSINaErYJgZFECIE2yEiAkBXAgF4C5gkBQkiEHhK2SgkBkUJIgbKABSzJBcMEmZlZSBwYXllciByZXF1aXJlZOA1sd///3BoELYmBRAiVng1+N///3FpaLgkGQwUcmVxdWVzdCBmZWUgbm90IHBhaWTgaWifeNswNSPg///BRVOLUEHmPxiENR7g//9onl8QQZv2Z85B5j8YhGg1a+D//2giAkBXAwN6ELYmBQgiBXkLlyYFCCIReUrZKCQGRQkiBsoAFLOqJgQiQnl4Na/l//9waDWS5v//wUVTi1BBkl3oMXFpC5cmBRAiDWlK2CYGRRAiBNshcmp6nmg1aub//8FFU4tQQeY/GIRAVwMAXEGb9mfOQZJd6DFwaAuXJgUQIg1oStgmBkUQIgTbIXFpEZ5yalxBm/ZnzkHmPxiEaiICQFcCAF8XQZv2Z85Bkl3oMXBoC5cmBRAiDWhK2CYGRRAiBNshcWkRnl8XQZv2Z85B5j8YhEBXAgF4NUTi///BRVOLUEGSXegxcGgLlyYFECINaErYJgZFECIE2yFxaRGeeDUc4v//wUVTi1BB5j8YhEBXAQV4C5gkBQkiEHhK2SgkBkUJIgbKABSzJBcMEnJlcXVlc3RlciByZXF1aXJlZOB5NfP8//9waBPOC5gkBQkiEmgTzkrZKCQGRQkiBsoAFLMkIQwcaW50ZWdyYXRpb24gY29udHJhY3Qgbm90IHNldOBBOVNuPGgTzpckHgwZb25seSBpbnRlZ3JhdGlvbiBjb250cmFjdOB8e3p5eDVY+///IgJAQTlTbjxAVwIFfAwPb25NaW5pQXBwUmVzdWx0lyYFCCIUfAwOb25PcmFjbGVSZXN1bHSXJCAMG3Vuc3VwcG9ydGVkIGNhbGxiYWNrIG1ldGhvZOB7NEFwaBfOELckIwwebWluaWFwcCBub3QgZm91bmQgZm9yIGNhbGxiYWNr4Hk1igAAAHF6eWloEM54Nc3+//8iAkBXAgF4C5cmBQgiEXhK2SgkBkUJIgbKABSzqiYLDAA1zt///yJReNswNSf0///BRVOLUEGSXegxcGgLlyYLDAA1rd///yIwaDVh3///cWkXzhCYJAUJIgdpE84LmCQFCSIHaRPOeJcmBWkiCwwANX/f//8iAkBXAAEMFGludmFsaWQgcmVxdWVzdCB0eXBlAEB4Na7a//94DAZvcmFjbGWXJgUIIhR4DA5wcml2YWN5X29yYWNsZZcmFQwMb3JhY2xlLmZldGNoIyQBAAB4DAdjb21wdXRllyYUDAtjb21wdXRlLnJ1biMFAQAAeAwIZGF0YWZlZWSXJgUIIg94DAlwcmljZWZlZWSXJgUIIgp4DARmZWVklyYSDAlmZWVkLnJlYWQjyAAAAHgMC25lb2RpZF9iaW5klyYFCCIaeAwUbmVvZGlkX2FjdGlvbl90aWNrZXSXJgUIIhx4DBZuZW9kaWRfcmVjb3ZlcnlfdGlja2V0lyYVDA9pZGVudGl0eS52ZXJpZnkiZXgME2F1dG9tYXRpb25fcmVnaXN0ZXKXJgUIIhd4DBFhdXRvbWF0aW9uX2NhbmNlbJcmBQgiGHgMEmF1dG9tYXRpb25fZXhlY3V0ZZcmFAwOYXV0b21hdGlvbi5ydW4iBXgiAkBXAAU0PHgLmCQFCSIQeErZKCQGRQkiBsoAFLMkFwwScmVxdWVzdGVyIHJlcXVpcmVk4Hx7enl4NZj4//8iAkBXAQA1Ldr//3BoC5gkBQkiEGhK2SgkBkUJIgbKABSzJBQMD3VwZGF0ZXIgbm90IHNldOBoQfgn7IwkEQwMdW5hdXRob3JpemVk4EBXAgV8DA9vbk1pbmlBcHBSZXN1bHSXJgUIIhR8DA5vbk9yYWNsZVJlc3VsdJckIAwbdW5zdXBwb3J0ZWQgY2FsbGJhY2sgbWV0aG9k4Hs1PP3//3BoF84QtyQjDB5taW5pYXBwIG5vdCBmb3VuZCBmb3IgY2FsbGJhY2vgeTWC/f//cXp5aWgQzng17P7//yICQFcCBHsMD29uTWluaUFwcFJlc3VsdJcmBQgiFHsMDm9uT3JhY2xlUmVzdWx0lyQgDBt1bnN1cHBvcnRlZCBjYWxsYmFjayBtZXRob2TgejWq/P//cGgXzhC3JCMMHm1pbmlhcHAgbm90IGZvdW5kIGZvciBjYWxsYmFja+B4NfD8//9xeXhpaBDONcf2//8iAkBXAgNBOVNuPAwUz3bii9AGLEpHjuNVYQETGfPPpNKXJBYMEW9ubHkgR0FTIGFjY2VwdGVk4HgLmCQFCSIQeErZKCQGRQkiBsoAFLMkEwwOaW52YWxpZCBzZW5kZXLgeRC3JBMMDmludmFsaWQgYW1vdW504Hp4NFZwaDVI2f//eZ5xaWjbMDWP2f//wUVTi1BB5j8YhGl5aBPADBNSZXF1ZXN0RmVlRGVwb3NpdGVkQZUBb2FADBTPduKL0AYsSkeO41VhARMZ88+k0kBXAwJ5cGjZKGhxJAUJIgVpC5gkBQkiB2nKABSXJ5MAAABp2zDbKErYJAlKygAUKAM6cWlK2SgkBkUJIgbKABSzJAUJIhppDBQAAAAAAAAAAAAAAAAAAAAAAAAAAJgkGAwTaW52YWxpZCBiZW5lZmljaWFyeeBpeJcmBQgiCGlB+CfsjCYFCCIFaTQ4cmokHwwaYmVuZWZpY2lhcnkgbm90IGF1dGhvcml6ZWTgaSIFeCICQNsoStgkCUrKABQoAzpAVwABeAuXJgUIIhF4StkoJAZFCSIGygAUs6omBQgiGngMFAAAAAAAAAAAAAAAAAAAAAAAAAAAlyYFCSIYeNswNUjv///BRVOLUEGSXegxC5giAkBXBAU1r/z//3g1I9z//3BoEM4QtyQWDBFyZXF1ZXN0IG5vdCBmb3VuZOBoGM4QlyQeDBlyZXF1ZXN0IGFscmVhZHkgZnVsZmlsbGVk4HoLlyYFCCIIesoBABC2JBUMEHJlc3VsdCB0b28gbGFyZ2XgewuXJgUIIgh7ygEAAbYkEwwOZXJyb3IgdG9vIGxvbmfgNbDW//9xaQuYJAUJIgxpStkoUMoAIbOrJB0MGHJ1bnRpbWUgdmVyaWZpZXIgbm90IHNldOB8C5gkBQkiB3zKAECXJCMMHmludmFsaWQgdmVyaWZpY2F0aW9uIHNpZ25hdHVyZeB7StgmBUUMAHpK2CYFRQwAeWgTzmgSzmgRzng1PgEAAHIAF3xpajcFACQjDB5pbnZhbGlkIHZlcmlmaWNhdGlvbiBzaWduYXR1cmXgeSYFESIDEkpoGFHQRUG3w4gDSmgaUdBFeUpoG1HQRXpK2CYFRQwASmgcUdBFe0rYJgVFDABKaB1R0EVoNwIAeNswNeDa///BRVOLUEHmPxiEaB7ONSXX//81eAIAAGgRzjWkAgAAQbfDiANoHc5oHM5oG85oFc5oE85oEs54aBHOGb9zazcCAHhoEc416tr//zUA2///wUVTi1BB5j8YhGgbzmgVznhoEc4UwAwSTWluaUFwcEluYm94U3RvcmVkQZUBb2FoeDUR0P//aB3OaBzONW8CAABoHM41hef//2gbzmgTzmgSzmgRzngYwAwXTWluaUFwcFJlcXVlc3RDb21wbGV0ZWRBlQFvYUBXAQdfJ3g1ggAAAItwaHlK2CYFRQwANwMAi0pwRWh6StgmBUUMADcDAItKcEVoe0rYJgVFDAA3AwCLSnBFaBGIShB8JgURIgMQ0ItKcEVofTUC5///i0pwRWh+StgmBUUMADcDAItKcEVoQdv+qHSLSnBFaDXkAAAAi0pwRWjbKDcDACICQItAVwQBeBC4JBQMD2ludmFsaWQgdWludDI1NuB42zBwaMpxaQAgtyYraQAhlyQFCSIIaAAgzhCXJBUMEHVpbnQyNTYgb3ZlcmZsb3fgACBKcUUAIIhyEHMib2hrzkpqAB9rn0oCAAAAgC4EIgpKAv///38yHgP/////AAAAAJFKAv///38yDAMAAAAAAQAAAJ9R0EVrSpxKAgAAAIAuBCIKSgL///9/Mh4D/////wAAAACRSgL///9/MgwDAAAAAAEAAACfc0VrabUkkGoiAkCLQFcBAEHF+6DgcBSIShBoAf8AkUoQAQABuyQDOtBKEWgBAAGhAf8AkUoQAQABuyQDOtBKEmgCAAABAKEB/wCRShABAAG7JAM60EoTaAIAAAABoQH/AJFKEAEAAbskAzrQIgJAQcX7oOBANwUAQFcCAF8YQZv2Z85Bkl3oMXBoC5cmBRAiDWhK2CYGRRAiBNshcWkRnl8YQZv2Z85B5j8YhEBXAgF4NVbX///BRVOLUEGSXegxcGgLlyYFECINaErYJgZFECIE2yFxaRGeeDUu1///wUVTi1BB5j8YhEBXAAF4C5cmBRAiBHjKIgJAVwECNSzb//94C5gkBQkiBnjKELckBQkiBXkLmCQFCSIGecoQtyQdDBhpbnZhbGlkIHVwZ3JhZGUgYXJ0aWZhY3TgQbfDiAMCAFwmBZ5KEC4EIhZKBP//////////AAAAAAAAAAAyFAT//////////wAAAAAAAAAAkXBoXyhBm/ZnzkHmPxiEeHmL2yg3AwBfKUGb9mfOQeY/GIRoEcAMEFVwZ3JhZGVTY2hlZHVsZWRBlQFvYUBXAwI1dtr//18oQZv2Z85Bkl3oMXBoC5gkGQwUbm8gdXBncmFkZSBzY2hlZHVsZWTgQbfDiANoStgmBkUQIgTbIbgkFAwPdGltZWxvY2sgYWN0aXZl4F8pQZv2Z85Bkl3oMXF4eYvbKDcDAHJpapckGgwVdXBncmFkZSBkYXRhIG1pc21hdGNo4F8oQZv2Z85BL1jF7V8pQZv2Z85BL1jF7Qt5eDcGAHk3AwB4NwMAEsAMEENvbnRyYWN0VXBncmFkZWRBlQFvYUA3BgBANazZ//9fKEGb9mfOQS9Yxe1fKUGb9mfOQS9Yxe1AVwgCNYvZ//94ELgkBQkiBXkQtyQSDA1pbnZhbGlkIHJhbmdl4DWe1f//cGgmJng1pNX//5ckHQwYdW5leHBlY3RlZCByZWJ1aWxkIHN0YXJ04DVzzv//cXh5nnJqabcmBmlKckV4cyOzAAAAazVB0v//dGw1h9P//3VtF84QlyYHI5QAAABtE84LmCQFCSISbRPOStkoJAZFCSIGygAUsyZlbRPO2zA1++f//8FFU4tQQZJd6DF2bguXJhlsbRPO2zA14Of//8FFU4tQQeY/GIQiNG5smCYvbRPONHR3B28HC5gkBQkiB28HyhC3JhhvB20TztswNazn///BRVOLUEHmPxiEbRHONa/n//9tEs41p+f//2tKnHNFa2q1JU////9oJitqabgmGllBm/ZnzkEvWMXtWkGb9mfOQS9Yxe0iDmpaQZv2Z85B5j8YhEBXBAF4C5cmBQgiEXhK2SgkBkUJIgbKABSzqiYGDAAiRjVWzf//cBBxIjNpNTTR//9yajV60v//c2sXzhC3JAUJIgdrE84LmCQFCSIHaxPOeJcmBWoiEGlKnHFFaWi1JMwMACICQFcBATXX1///eBC4JBAMC2ludmFsaWQgY2Fw4DV+7///cHhfJkGb9mfOQeY/GIR4aBLADBhTcG9uc29yRGVmYXVsdENhcFVwZGF0ZWRBlQFvYUBXAAEMDmludmFsaWQgYXBwIGlkAEB4NXbN//94NULV//8SlyICQFcCAng1Kuf//3BoNUzn//95JgUSIgMRcWl4NUXV///BRVOLUEHmPxiEaXgSwAwWU3BvbnNvcnNoaXBNb2RlQ2hhbmdlZEGVAW9hQFYqDAEB2zBjDAEC2zBnCQwBA9swZxkMAQTbMGQMAQXbMGcTDAEG2zBnEgwBB9swYAwBCNswZgwBCdswZwgMARDbMGcHDAER2zBnFAwBEtswZwsMARPbMGcKDAEU2zBnDAwBFdswZw0MARbbMGcXDAEX2zBnGAwBGNswZQwBGdswZw8MASDbMGcQDAEh2zBnFQwBItswZxYMASPbMGcaDAEk2zBnGwwBJdswZw4MASbbMGcRDAEn2zBnJAwBKNswZyUMASnbMGccDAEq2zBnHQwBK9swZx4MASzbMGcfDAEt2zBhDAEu2zBiDAEv2zBnIAwBMNswZyEMATHbMGcoDAEy2zBnKQwBM9swZyIMATTbMGcjDBltaW5pYXBwLW9zLWZ1bGZpbGxtZW50LXYx2zBnJwwBNdswZyZAgd50EA==").AsSerializable<Neo.SmartContract.NefFile>();

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

    public delegate void delMiniAppRequestQueued(BigInteger? requestId, string? appId, string? moduleId, string? operation, UInt160? requester, UInt160? sponsor, byte[]? payload, byte[]? payloadHash);

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
