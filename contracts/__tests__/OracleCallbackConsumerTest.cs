using Xunit;

namespace MorpheusOracle.Contracts.Tests
{
    public class OracleCallbackConsumerTest
    {
        [Fact]
        public void ConsumerExposesExpectedCallbackApi()
        {
            string code = ContractSourceAssertions.ReadSource(
                "contracts",
                "OracleCallbackConsumer",
                "OracleCallbackConsumer.cs");

            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "UInt160", "Kernel");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "UInt160", "Oracle");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "SetKernel");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "SetOracle");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "OnMiniAppResult");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "OnOracleResult");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "CallbackRecord", "GetCallbackRecord");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "object[]", "GetCallback");
            Assert.Contains("MiniAppResultReceived", code);
            Assert.Contains("KernelChanged", code);
        }

        [Fact]
        public void StoreCallbackRejectsDuplicateRequestIds()
        {
            string code = ContractSourceAssertions.ReadSource(
                "contracts",
                "OracleCallbackConsumer",
                "OracleCallbackConsumer.cs");

            // A requestId is fulfilled exactly once; recording a second callback
            // for the same id is a replay/forgery and must revert rather than
            // overwrite the authoritative first result.
            Assert.Matches(
                @"StoreCallback\([^)]*\)\s*\{[\s\S]*?ExecutionEngine\.Assert\(\s*Storage\.Get\([^)]*BuildCallbackKey\(requestId\)\)\s*==\s*null",
                code);
            Assert.Contains("callback already recorded", code);
        }
    }
}
