using Xunit;

namespace MorpheusOracle.Contracts.Tests
{
    public class UserConsumerN3Test
    {
        private static string ReadConsumerSource()
        {
            return ContractSourceAssertions.ReadSource(
                "examples",
                "contracts",
                "n3",
                "UserConsumerN3.cs");
        }

        [Fact]
        public void ConsumerExposesExpectedRequestAndCallbackApi()
        {
            string code = ReadConsumerSource();

            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "BigInteger", "RequestRaw");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "BigInteger", "RequestBuiltinProviderPrice");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "BigInteger", "RequestBuiltinCompute");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "OnOracleResult");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "object[]", "GetCallback");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "string", "GetPendingRequestType");
        }

        [Fact]
        public void RequestMethodsRecordTheIssuedRequestId()
        {
            string code = ReadConsumerSource();

            // Each request flow must capture the requestId returned by the kernel
            // together with the requestType it expects back, so the callback can
            // be validated against requests this consumer actually issued.
            Assert.Contains("RecordPendingRequest(requestId, requestType)", code);
            Assert.Contains("RecordPendingRequest(requestId, \"privacy_oracle\")", code);
            Assert.Contains("RecordPendingRequest(requestId, \"compute\")", code);

            // The recorder refuses to clobber an existing pending entry for the
            // same id.
            Assert.Matches(
                @"RecordPendingRequest\([^)]*\)\s*\{[\s\S]*?ExecutionEngine\.Assert\(\s*Storage\.Get\([^)]*pendingKey\)\s*==\s*null",
                code);
        }

        [Fact]
        public void OnOracleResultRejectsUnknownForgedAndReplayedCallbacks()
        {
            string code = ReadConsumerSource();

            // Authenticate the kernel as the only allowed caller.
            Assert.Contains("ValidateOracle()", code);

            // Reject callbacks for requestIds this consumer never issued
            // (unknown/forged) ...
            Assert.Matches(
                @"OnOracleResult\([^)]*\)\s*\{[\s\S]*?ExecutionEngine\.Assert\(\s*expectedType\s*!=\s*null",
                code);
            Assert.Contains("unknown request id", code);

            // ... bind the callback to the operation that was requested ...
            Assert.Matches(
                @"ExecutionEngine\.Assert\(\s*requestType\s*==\s*\(string\)expectedType",
                code);
            Assert.Contains("request type mismatch", code);

            // ... and consume the pending record so a replay of the same id
            // fails the unknown-id assert above.
            Assert.Matches(
                @"OnOracleResult\([^)]*\)\s*\{[\s\S]*?Storage\.Delete\(\s*Storage\.CurrentContext,\s*pendingKey\)",
                code);
        }
    }
}
