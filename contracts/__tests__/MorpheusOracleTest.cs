using Xunit;

namespace MorpheusOracle.Contracts.Tests
{
    public class MorpheusOracleTest
    {
        [Fact]
        public void MorpheusOracleExposesMiniAppKernelApi()
        {
            string code = ContractSourceAssertions.ReadSource(
                "contracts",
                "MorpheusOracle",
                "MorpheusOracle.cs");

            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "string", "RuntimeEncryptionAlgorithm");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "string", "RuntimeEncryptionPublicKey");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "BigInteger", "RuntimeEncryptionKeyVersion");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "ECPoint", "RuntimeVerificationPublicKey");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "BigInteger", "SystemRequestFee");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "BigInteger", "RequestFee");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "BigInteger", "FeeCreditOf");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "BigInteger", "AccruedRequestFees");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "BigInteger", "GetMiniAppCount");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "BigInteger", "GetSystemModuleCount");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "string", "GetMiniAppIdByIndex");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "string", "GetSystemModuleIdByIndex");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "string[]", "GetAllMiniAppIds");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "string[]", "GetAllSystemModuleIds");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "MiniAppRecord", "GetMiniApp");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "SystemModuleRecord", "GetSystemModule");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "bool", "IsModuleGrantedToMiniApp");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "KernelRequest", "GetRequest");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "InboxItem", "GetInboxItem");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "ByteString", "GetMiniAppState");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "SetRuntimeEncryptionKey");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "SetRuntimeVerificationPublicKey");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "SetRequestFee");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "WithdrawAccruedFees");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "RegisterSystemModule");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "ConfigureSystemModule");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "RegisterMiniApp");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "ConfigureMiniApp");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "GrantModuleToMiniApp");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "RevokeModuleFromMiniApp");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "PutMiniAppState");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "PutMiniAppStateBatch");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "DeleteMiniAppState");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "OnNEP17Payment");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "BigInteger", "SubmitMiniAppRequest");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "BigInteger", "SubmitMiniAppRequestFromIntegration");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "BigInteger", "QueueSystemRequest");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "FulfillRequest");

            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "string", "OracleEncryptionAlgorithm");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "string", "OracleEncryptionPublicKey");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "BigInteger", "OracleEncryptionKeyVersion");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "ECPoint", "OracleVerificationPublicKey");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "SetOracleEncryptionKey");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "SetOracleVerificationPublicKey");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "BigInteger", "Request");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "BigInteger", "RequestFromCallback");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "BigInteger", "QueueAutomationRequest");
        }

        [Fact]
        public void MorpheusOracleDefinesMiniAppKernelEvents()
        {
            string code = ContractSourceAssertions.ReadSource(
                "contracts",
                "MorpheusOracle",
                "MorpheusOracle.cs");

            Assert.Contains("MiniAppRegisteredHandler", code);
            Assert.Contains("SystemModuleRegisteredHandler", code);
            Assert.Contains("MiniAppRequestQueuedHandler", code);
            Assert.Contains("MiniAppRequestCompletedHandler", code);
            Assert.Contains("[DisplayName(\"MorpheusOracle\")]", code);
            Assert.Contains("[DisplayName(\"RuntimeEncryptionKeyUpdated\")]", code);
            Assert.Contains("[DisplayName(\"RuntimeVerifierUpdated\")]", code);
            Assert.Contains("RequestFeeUpdated", code);
            Assert.Contains("RequestFeeDeposited", code);
            Assert.Contains("AccruedFeesWithdrawn", code);
            Assert.Contains("MiniAppInboxStored", code);
            Assert.Contains("MiniAppStateChanged", code);
            Assert.Contains("GAS.Transfer", code);
            Assert.Contains("[ContractPermission(\"*\", \"onOracleResult\")]", code);
            Assert.Contains("FULFILLMENT_SIGNATURE_DOMAIN", code);
            Assert.Contains("ComputeFulfillmentDigest", code);
            Assert.Contains("SeedBuiltInModule", code);
            Assert.Contains("ResolveLegacyModuleId", code);
            Assert.Contains("LEGACY_CALLBACK_METHOD", code);
        }

        [Fact]
        public void MorpheusOracleGrantKeyFitsNeoStorageLimit()
        {
            string code = ContractSourceAssertions.ReadSource(
                "contracts",
                "MorpheusOracle",
                "MorpheusOracle.cs");

            Assert.Contains("byte[] grantMaterial = (byte[])Helper.Concat", code);
            Assert.Contains("return (byte[])CryptoLib.Sha256((ByteString)grantMaterial);", code);
        }
    }
}
