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

    public static Neo.SmartContract.Manifest.ContractManifest Manifest => Neo.SmartContract.Manifest.ContractManifest.Parse(@"{""name"":""MorpheusOracle"",""groups"":[],""features"":{},""supportedstandards"":[],""abi"":{""methods"":[{""name"":""getAutomationSpendApproval"",""parameters"":[{""name"":""registrationRequestId"",""type"":""Integer""}],""returntype"":""Array"",""offset"":27,""safe"":true},{""name"":""submitAutomationRegistration"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""payload"",""type"":""ByteArray""},{""name"":""cap"",""type"":""Integer""},{""name"":""expiresAt"",""type"":""Integer""}],""returntype"":""Integer"",""offset"":85,""safe"":false},{""name"":""approveAutomationSpend"",""parameters"":[{""name"":""registrationRequestId"",""type"":""Integer""},{""name"":""cap"",""type"":""Integer""},{""name"":""expiresAt"",""type"":""Integer""}],""returntype"":""Void"",""offset"":2620,""safe"":false},{""name"":""queueAutomationExecution"",""parameters"":[{""name"":""registrationRequestId"",""type"":""Integer""},{""name"":""requester"",""type"":""Hash160""},{""name"":""requestType"",""type"":""String""},{""name"":""payload"",""type"":""ByteArray""}],""returntype"":""Integer"",""offset"":3060,""safe"":false},{""name"":""_deploy"",""parameters"":[{""name"":""data"",""type"":""Any""},{""name"":""update"",""type"":""Boolean""}],""returntype"":""Void"",""offset"":4089,""safe"":false},{""name"":""admin"",""parameters"":[],""returntype"":""Hash160"",""offset"":4875,""safe"":true},{""name"":""updater"",""parameters"":[],""returntype"":""Hash160"",""offset"":3320,""safe"":true},{""name"":""runtimeEncryptionAlgorithm"",""parameters"":[],""returntype"":""String"",""offset"":4901,""safe"":true},{""name"":""runtimeEncryptionPublicKey"",""parameters"":[],""returntype"":""String"",""offset"":4917,""safe"":true},{""name"":""runtimeEncryptionKeyVersion"",""parameters"":[],""returntype"":""Integer"",""offset"":4932,""safe"":true},{""name"":""runtimeVerificationPublicKey"",""parameters"":[],""returntype"":""PublicKey"",""offset"":4970,""safe"":true},{""name"":""oracleEncryptionAlgorithm"",""parameters"":[],""returntype"":""String"",""offset"":5027,""safe"":true},{""name"":""oracleEncryptionPublicKey"",""parameters"":[],""returntype"":""String"",""offset"":5030,""safe"":true},{""name"":""oracleEncryptionKeyVersion"",""parameters"":[],""returntype"":""Integer"",""offset"":5033,""safe"":true},{""name"":""oracleVerificationPublicKey"",""parameters"":[],""returntype"":""PublicKey"",""offset"":5036,""safe"":true},{""name"":""systemRequestFee"",""parameters"":[],""returntype"":""Integer"",""offset"":1315,""safe"":true},{""name"":""requestFee"",""parameters"":[],""returntype"":""Integer"",""offset"":5039,""safe"":true},{""name"":""requestTTL"",""parameters"":[],""returntype"":""Integer"",""offset"":5045,""safe"":true},{""name"":""feeCreditOf"",""parameters"":[{""name"":""requester"",""type"":""Hash160""}],""returntype"":""Integer"",""offset"":1373,""safe"":true},{""name"":""accruedRequestFees"",""parameters"":[],""returntype"":""Integer"",""offset"":2104,""safe"":true},{""name"":""reservedRequestFees"",""parameters"":[],""returntype"":""Integer"",""offset"":2169,""safe"":true},{""name"":""withdrawableFees"",""parameters"":[],""returntype"":""Integer"",""offset"":5087,""safe"":true},{""name"":""getMiniAppCount"",""parameters"":[],""returntype"":""Integer"",""offset"":4601,""safe"":true},{""name"":""getSystemModuleCount"",""parameters"":[],""returntype"":""Integer"",""offset"":4816,""safe"":true},{""name"":""getMiniAppIdByIndex"",""parameters"":[{""name"":""index"",""type"":""Integer""}],""returntype"":""String"",""offset"":5156,""safe"":true},{""name"":""getSystemModuleIdByIndex"",""parameters"":[{""name"":""index"",""type"":""Integer""}],""returntype"":""String"",""offset"":5219,""safe"":true},{""name"":""getAllMiniAppIds"",""parameters"":[],""returntype"":""Array"",""offset"":5275,""safe"":true},{""name"":""getAllSystemModuleIds"",""parameters"":[],""returntype"":""Array"",""offset"":5382,""safe"":true},{""name"":""getMiniApp"",""parameters"":[{""name"":""appId"",""type"":""String""}],""returntype"":""Array"",""offset"":683,""safe"":true},{""name"":""getSystemModule"",""parameters"":[{""name"":""moduleId"",""type"":""String""}],""returntype"":""Array"",""offset"":874,""safe"":true},{""name"":""isModuleGrantedToMiniApp"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""}],""returntype"":""Boolean"",""offset"":970,""safe"":true},{""name"":""getMiniAppRequestCount"",""parameters"":[{""name"":""appId"",""type"":""String""}],""returntype"":""Integer"",""offset"":5489,""safe"":true},{""name"":""getMiniAppFulfilledCount"",""parameters"":[{""name"":""appId"",""type"":""String""}],""returntype"":""Integer"",""offset"":5555,""safe"":true},{""name"":""getTotalRequests"",""parameters"":[],""returntype"":""Integer"",""offset"":5628,""safe"":true},{""name"":""getTotalFulfilled"",""parameters"":[],""returntype"":""Integer"",""offset"":5666,""safe"":true},{""name"":""isIndexRebuildRequired"",""parameters"":[],""returntype"":""Boolean"",""offset"":5704,""safe"":true},{""name"":""indexRebuildCursor"",""parameters"":[],""returntype"":""Integer"",""offset"":5721,""safe"":true},{""name"":""getRequest"",""parameters"":[{""name"":""requestId"",""type"":""Integer""}],""returntype"":""Array"",""offset"":3001,""safe"":true},{""name"":""getInboxItem"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requestId"",""type"":""Integer""}],""returntype"":""Array"",""offset"":5759,""safe"":true},{""name"":""getMiniAppState"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""stateKey"",""type"":""ByteArray""}],""returntype"":""ByteArray"",""offset"":5870,""safe"":true},{""name"":""isSponsorshipGated"",""parameters"":[{""name"":""appId"",""type"":""String""}],""returntype"":""Boolean"",""offset"":6019,""safe"":true},{""name"":""isSponsoredRequesterAllowed"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""}],""returntype"":""Boolean"",""offset"":6057,""safe"":true},{""name"":""getSponsoredRequesterCap"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""}],""returntype"":""Integer"",""offset"":6139,""safe"":true},{""name"":""getSponsoredRequesterSpent"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""}],""returntype"":""Integer"",""offset"":6239,""safe"":true},{""name"":""proposeAdmin"",""parameters"":[{""name"":""newAdmin"",""type"":""Hash160""}],""returntype"":""Void"",""offset"":6339,""safe"":false},{""name"":""executeAdminChange"",""parameters"":[],""returntype"":""Void"",""offset"":6597,""safe"":false},{""name"":""cancelAdminChange"",""parameters"":[],""returntype"":""Void"",""offset"":6767,""safe"":false},{""name"":""setUpdater"",""parameters"":[{""name"":""updater"",""type"":""Hash160""}],""returntype"":""Void"",""offset"":6797,""safe"":false},{""name"":""proposeRuntimeEncryptionKey"",""parameters"":[{""name"":""algorithm"",""type"":""String""},{""name"":""publicKey"",""type"":""String""}],""returntype"":""Void"",""offset"":6892,""safe"":false},{""name"":""executeRuntimeEncryptionKey"",""parameters"":[],""returntype"":""Void"",""offset"":7168,""safe"":false},{""name"":""cancelRuntimeEncryptionKey"",""parameters"":[],""returntype"":""Void"",""offset"":7354,""safe"":false},{""name"":""pendingRuntimeEncryptionKeyEta"",""parameters"":[],""returntype"":""Integer"",""offset"":7372,""safe"":true},{""name"":""proposeRuntimeVerificationPublicKey"",""parameters"":[{""name"":""publicKey"",""type"":""PublicKey""}],""returntype"":""Void"",""offset"":7405,""safe"":false},{""name"":""executeRuntimeVerificationPublicKey"",""parameters"":[],""returntype"":""Void"",""offset"":7602,""safe"":false},{""name"":""cancelRuntimeVerificationPublicKey"",""parameters"":[],""returntype"":""Void"",""offset"":7768,""safe"":false},{""name"":""pendingRuntimeVerificationKeyEta"",""parameters"":[],""returntype"":""Integer"",""offset"":7786,""safe"":true},{""name"":""setOracleEncryptionKey"",""parameters"":[{""name"":""algorithm"",""type"":""String""},{""name"":""publicKey"",""type"":""String""}],""returntype"":""Void"",""offset"":7819,""safe"":false},{""name"":""setOracleVerificationPublicKey"",""parameters"":[{""name"":""publicKey"",""type"":""PublicKey""}],""returntype"":""Void"",""offset"":7830,""safe"":false},{""name"":""setRequestFee"",""parameters"":[{""name"":""amount"",""type"":""Integer""}],""returntype"":""Void"",""offset"":7840,""safe"":false},{""name"":""withdrawAccruedFees"",""parameters"":[{""name"":""to"",""type"":""Hash160""},{""name"":""amount"",""type"":""Integer""}],""returntype"":""Void"",""offset"":7922,""safe"":false},{""name"":""setRequestTTL"",""parameters"":[{""name"":""ttlMs"",""type"":""Integer""}],""returntype"":""Void"",""offset"":8157,""safe"":false},{""name"":""expireStaleRequest"",""parameters"":[{""name"":""requestId"",""type"":""Integer""}],""returntype"":""Void"",""offset"":8241,""safe"":false},{""name"":""registerSystemModule"",""parameters"":[{""name"":""moduleId"",""type"":""String""},{""name"":""endpoint"",""type"":""String""},{""name"":""schemaHash"",""type"":""String""}],""returntype"":""Void"",""offset"":9061,""safe"":false},{""name"":""configureSystemModule"",""parameters"":[{""name"":""moduleId"",""type"":""String""},{""name"":""endpoint"",""type"":""String""},{""name"":""schemaHash"",""type"":""String""},{""name"":""active"",""type"":""Boolean""}],""returntype"":""Void"",""offset"":9290,""safe"":false},{""name"":""registerMiniApp"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""appAdmin"",""type"":""Hash160""},{""name"":""feePayer"",""type"":""Hash160""},{""name"":""callbackContract"",""type"":""Hash160""},{""name"":""metadataUri"",""type"":""String""},{""name"":""metadataHash"",""type"":""String""}],""returntype"":""Void"",""offset"":9384,""safe"":false},{""name"":""configureMiniApp"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""feePayer"",""type"":""Hash160""},{""name"":""callbackContract"",""type"":""Hash160""},{""name"":""metadataUri"",""type"":""String""},{""name"":""metadataHash"",""type"":""String""},{""name"":""active"",""type"":""Boolean""}],""returntype"":""Void"",""offset"":10442,""safe"":false},{""name"":""setSponsoredRequesterAllowed"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""},{""name"":""allowed"",""type"":""Boolean""}],""returntype"":""Void"",""offset"":10633,""safe"":false},{""name"":""setSponsoredRequesterCap"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""},{""name"":""cap"",""type"":""Integer""}],""returntype"":""Void"",""offset"":10798,""safe"":false},{""name"":""grantModuleToMiniApp"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""}],""returntype"":""Void"",""offset"":10972,""safe"":false},{""name"":""revokeModuleFromMiniApp"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""}],""returntype"":""Void"",""offset"":11058,""safe"":false},{""name"":""putMiniAppState"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""stateKey"",""type"":""ByteArray""},{""name"":""value"",""type"":""ByteArray""}],""returntype"":""Void"",""offset"":11159,""safe"":false},{""name"":""putMiniAppStateBatch"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""stateKeys"",""type"":""Array""},{""name"":""values"",""type"":""Array""}],""returntype"":""Void"",""offset"":11426,""safe"":false},{""name"":""deleteMiniAppState"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""stateKey"",""type"":""ByteArray""}],""returntype"":""Void"",""offset"":11698,""safe"":false},{""name"":""submitMiniAppRequest"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""},{""name"":""operation"",""type"":""String""},{""name"":""payload"",""type"":""ByteArray""}],""returntype"":""Integer"",""offset"":11774,""safe"":false},{""name"":""submitMiniAppRequestFromIntegration"",""parameters"":[{""name"":""requester"",""type"":""Hash160""},{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""},{""name"":""operation"",""type"":""String""},{""name"":""payload"",""type"":""ByteArray""}],""returntype"":""Integer"",""offset"":11878,""safe"":false},{""name"":""requestFromCallback"",""parameters"":[{""name"":""requester"",""type"":""Hash160""},{""name"":""requestType"",""type"":""String""},{""name"":""payload"",""type"":""ByteArray""},{""name"":""callbackContract"",""type"":""Hash160""},{""name"":""callbackMethod"",""type"":""String""}],""returntype"":""Integer"",""offset"":12059,""safe"":false},{""name"":""queueSystemRequest"",""parameters"":[{""name"":""requester"",""type"":""Hash160""},{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""},{""name"":""operation"",""type"":""String""},{""name"":""payload"",""type"":""ByteArray""}],""returntype"":""Integer"",""offset"":12319,""safe"":false},{""name"":""queueAutomationRequest"",""parameters"":[{""name"":""requester"",""type"":""Hash160""},{""name"":""requestType"",""type"":""String""},{""name"":""payload"",""type"":""ByteArray""},{""name"":""callbackContract"",""type"":""Hash160""},{""name"":""callbackMethod"",""type"":""String""}],""returntype"":""Integer"",""offset"":12394,""safe"":false},{""name"":""request"",""parameters"":[{""name"":""requestType"",""type"":""String""},{""name"":""payload"",""type"":""ByteArray""},{""name"":""callbackContract"",""type"":""Hash160""},{""name"":""callbackMethod"",""type"":""String""}],""returntype"":""Integer"",""offset"":12540,""safe"":false},{""name"":""onNEP17Payment"",""parameters"":[{""name"":""from"",""type"":""Hash160""},{""name"":""amount"",""type"":""Integer""},{""name"":""data"",""type"":""Any""}],""returntype"":""Void"",""offset"":12685,""safe"":false},{""name"":""fulfillRequest"",""parameters"":[{""name"":""requestId"",""type"":""Integer""},{""name"":""success"",""type"":""Boolean""},{""name"":""result"",""type"":""ByteArray""},{""name"":""error"",""type"":""String""},{""name"":""verificationSignature"",""type"":""ByteArray""}],""returntype"":""Void"",""offset"":13165,""safe"":false},{""name"":""scheduleUpdate"",""parameters"":[{""name"":""nefFile"",""type"":""ByteArray""},{""name"":""manifest"",""type"":""String""}],""returntype"":""Void"",""offset"":14336,""safe"":false},{""name"":""update"",""parameters"":[{""name"":""nefFile"",""type"":""ByteArray""},{""name"":""manifest"",""type"":""String""}],""returntype"":""Void"",""offset"":14518,""safe"":false},{""name"":""cancelUpdate"",""parameters"":[],""returntype"":""Void"",""offset"":14723,""safe"":false},{""name"":""rebuildIndexes"",""parameters"":[{""name"":""startIndex"",""type"":""Integer""},{""name"":""count"",""type"":""Integer""}],""returntype"":""Void"",""offset"":14753,""safe"":false},{""name"":""defaultSponsoredRequesterCap"",""parameters"":[],""returntype"":""Integer"",""offset"":1705,""safe"":true},{""name"":""setDefaultSponsoredRequesterCap"",""parameters"":[{""name"":""cap"",""type"":""Integer""}],""returntype"":""Void"",""offset"":15192,""safe"":false},{""name"":""isSponsorshipOpen"",""parameters"":[{""name"":""appId"",""type"":""String""}],""returntype"":""Boolean"",""offset"":15274,""safe"":true},{""name"":""setSponsorshipOpen"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""open"",""type"":""Boolean""}],""returntype"":""Void"",""offset"":15312,""safe"":false},{""name"":""_initialize"",""parameters"":[],""returntype"":""Void"",""offset"":15387,""safe"":false}],""events"":[{""name"":""AutomationSpendApproved"",""parameters"":[{""name"":""registrationRequestId"",""type"":""Integer""},{""name"":""requester"",""type"":""Hash160""},{""name"":""appId"",""type"":""String""},{""name"":""cap"",""type"":""Integer""},{""name"":""expiresAt"",""type"":""Integer""}]},{""name"":""AutomationSpendCharged"",""parameters"":[{""name"":""registrationRequestId"",""type"":""Integer""},{""name"":""requestId"",""type"":""Integer""},{""name"":""amount"",""type"":""Integer""},{""name"":""spent"",""type"":""Integer""}]},{""name"":""MiniAppRegistered"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""admin"",""type"":""Hash160""},{""name"":""feePayer"",""type"":""Hash160""},{""name"":""callbackContract"",""type"":""Hash160""}]},{""name"":""MiniAppUpdated"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""admin"",""type"":""Hash160""},{""name"":""feePayer"",""type"":""Hash160""},{""name"":""callbackContract"",""type"":""Hash160""},{""name"":""active"",""type"":""Boolean""}]},{""name"":""SystemModuleRegistered"",""parameters"":[{""name"":""moduleId"",""type"":""String""},{""name"":""endpoint"",""type"":""String""},{""name"":""schemaHash"",""type"":""String""}]},{""name"":""SystemModuleUpdated"",""parameters"":[{""name"":""moduleId"",""type"":""String""},{""name"":""endpoint"",""type"":""String""},{""name"":""schemaHash"",""type"":""String""},{""name"":""active"",""type"":""Boolean""}]},{""name"":""MiniAppCapabilityGranted"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""}]},{""name"":""MiniAppCapabilityRevoked"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""}]},{""name"":""MiniAppRequestQueued"",""parameters"":[{""name"":""requestId"",""type"":""Integer""},{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""},{""name"":""operation"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""},{""name"":""sponsor"",""type"":""Hash160""},{""name"":""payload"",""type"":""ByteArray""}]},{""name"":""MiniAppRequestCompleted"",""parameters"":[{""name"":""requestId"",""type"":""Integer""},{""name"":""appId"",""type"":""String""},{""name"":""moduleId"",""type"":""String""},{""name"":""operation"",""type"":""String""},{""name"":""success"",""type"":""Boolean""},{""name"":""resultHash"",""type"":""ByteArray""},{""name"":""resultSize"",""type"":""Integer""},{""name"":""error"",""type"":""String""}]},{""name"":""MiniAppInboxStored"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requestId"",""type"":""Integer""},{""name"":""requester"",""type"":""Hash160""},{""name"":""success"",""type"":""Boolean""}]},{""name"":""MiniAppStateChanged"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""stateKey"",""type"":""ByteArray""},{""name"":""valueSize"",""type"":""Integer""}]},{""name"":""AdminChanged"",""parameters"":[{""name"":""oldAdmin"",""type"":""Hash160""},{""name"":""newAdmin"",""type"":""Hash160""}]},{""name"":""UpdaterChanged"",""parameters"":[{""name"":""oldUpdater"",""type"":""Hash160""},{""name"":""newUpdater"",""type"":""Hash160""}]},{""name"":""RuntimeEncryptionKeyUpdated"",""parameters"":[{""name"":""version"",""type"":""Integer""},{""name"":""algorithm"",""type"":""String""},{""name"":""publicKey"",""type"":""String""}]},{""name"":""RuntimeVerifierUpdated"",""parameters"":[{""name"":""oldVerifier"",""type"":""PublicKey""},{""name"":""newVerifier"",""type"":""PublicKey""}]},{""name"":""RequestFeeUpdated"",""parameters"":[{""name"":""oldFee"",""type"":""Integer""},{""name"":""newFee"",""type"":""Integer""}]},{""name"":""RequestFeeDeposited"",""parameters"":[{""name"":""from"",""type"":""Hash160""},{""name"":""amount"",""type"":""Integer""},{""name"":""creditBalance"",""type"":""Integer""}]},{""name"":""AccruedFeesWithdrawn"",""parameters"":[{""name"":""to"",""type"":""Hash160""},{""name"":""amount"",""type"":""Integer""}]},{""name"":""RequestExpired"",""parameters"":[{""name"":""requestId"",""type"":""Integer""},{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""},{""name"":""sponsor"",""type"":""Hash160""},{""name"":""refundAmount"",""type"":""Integer""}]},{""name"":""RequestTTLUpdated"",""parameters"":[{""name"":""oldTTL"",""type"":""Integer""},{""name"":""newTTL"",""type"":""Integer""}]},{""name"":""SponsoredRequesterAllowed"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""},{""name"":""allowed"",""type"":""Boolean""}]},{""name"":""SponsoredRequesterCapUpdated"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""requester"",""type"":""Hash160""},{""name"":""cap"",""type"":""Integer""}]},{""name"":""AdminTimelockProposed"",""parameters"":[{""name"":""proposed"",""type"":""Hash160""},{""name"":""executeAfter"",""type"":""Integer""}]},{""name"":""UpgradeScheduled"",""parameters"":[{""name"":""executeAfter"",""type"":""Integer""}]},{""name"":""ContractUpgraded"",""parameters"":[{""name"":""nefHash"",""type"":""ByteArray""},{""name"":""manifestHash"",""type"":""ByteArray""}]},{""name"":""SecurityKeyChangeProposed"",""parameters"":[{""name"":""kind"",""type"":""String""},{""name"":""executeAfter"",""type"":""Integer""}]},{""name"":""SponsorshipModeChanged"",""parameters"":[{""name"":""appId"",""type"":""String""},{""name"":""mode"",""type"":""Integer""}]},{""name"":""SponsorDefaultCapUpdated"",""parameters"":[{""name"":""oldCap"",""type"":""Integer""},{""name"":""newCap"",""type"":""Integer""}]}]},""permissions"":[{""contract"":""0x726cb6e0cd8628a1350a611384688911ab75f51b"",""methods"":[""sha256"",""verifyWithECDsa""]},{""contract"":""0xacce6fd80d44e1796aa0c2c625e9e4e0ce39efc0"",""methods"":[""deserialize"",""serialize""]},{""contract"":""0xd2a4cff31913016155e38e474a2c06d08be276cf"",""methods"":[""transfer""]},{""contract"":""0xfffdc93764dbaddd97c48f252a53ea4643faa3fd"",""methods"":[""hasMethod"",""update""]},{""contract"":""*"",""methods"":[""onMiniAppResult"",""onOracleResult""]}],""trusts"":[],""extra"":{""Author"":""Morpheus Oracle"",""Version"":""2.0.0"",""Description"":""MiniApp OS kernel with shared IO, registration, and callback orchestration"",""nef"":{""optimization"":""Basic""}}}");

    /// <summary>
    /// Optimization: "Basic"
    /// </summary>
    public static Neo.SmartContract.NefFile Nef => Convert.FromBase64String(@"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").AsSerializable<Neo.SmartContract.NefFile>();

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

    public delegate void delAutomationSpendApproved(BigInteger? registrationRequestId, UInt160? requester, string? appId, BigInteger? cap, BigInteger? expiresAt);

    [DisplayName("AutomationSpendApproved")]
    public event delAutomationSpendApproved? OnAutomationSpendApproved;

    public delegate void delAutomationSpendCharged(BigInteger? registrationRequestId, BigInteger? requestId, BigInteger? amount, BigInteger? spent);

    [DisplayName("AutomationSpendCharged")]
    public event delAutomationSpendCharged? OnAutomationSpendCharged;

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
    [DisplayName("getAutomationSpendApproval")]
    public abstract IList<object>? GetAutomationSpendApproval(BigInteger? registrationRequestId);

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
    [DisplayName("approveAutomationSpend")]
    public abstract void ApproveAutomationSpend(BigInteger? registrationRequestId, BigInteger? cap, BigInteger? expiresAt);

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
    [DisplayName("queueAutomationExecution")]
    public abstract BigInteger? QueueAutomationExecution(BigInteger? registrationRequestId, UInt160? requester, string? requestType, byte[]? payload);

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
    [DisplayName("submitAutomationRegistration")]
    public abstract BigInteger? SubmitAutomationRegistration(string? appId, byte[]? payload, BigInteger? cap, BigInteger? expiresAt);

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
