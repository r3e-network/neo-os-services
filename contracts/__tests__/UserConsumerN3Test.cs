using System.Text.RegularExpressions;
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
        public void PendingKeyIsDerivedIdenticallyByTheWriterAndTheReader()
        {
            string code = ReadConsumerSource();

            // The unknown-request / replay guard holds only while
            // RecordPendingRequest (the writer) and OnOracleResult (the reader)
            // address the SAME storage key. Helper.Concat returns byte[], so this
            // line needs a ByteString conversion to compile; a fix that instead
            // changed the key expression on one side — a different prefix, a
            // different requestId encoding, or inlining away the shared
            // pendingKey variable — would retire the guard while still building.
            MatchCollection derivations = Regex.Matches(
                code,
                @"ByteString pendingKey = (?:\(ByteString\))?Helper\.Concat\(PREFIX_PENDING, \(ByteString\)requestId\.ToByteArray\(\)\);");
            Assert.Equal(2, derivations.Count);

            // Both sides use that variable rather than re-deriving a key inline.
            Assert.Contains("Storage.Get(Storage.CurrentContext, pendingKey)", code);
            Assert.Contains("Storage.Delete(Storage.CurrentContext, pendingKey)", code);
            Assert.Contains("Storage.Put(Storage.CurrentContext, pendingKey, requestType)", code);
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
