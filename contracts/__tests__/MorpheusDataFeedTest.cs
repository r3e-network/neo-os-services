using Xunit;

namespace MorpheusOracle.Contracts.Tests
{
    public class MorpheusDataFeedTest
    {
        [Fact]
        public void MorpheusDataFeedExposesExpectedApi()
        {
            string code = ContractSourceAssertions.ReadSource(
                "contracts",
                "MorpheusDataFeed",
                "MorpheusDataFeed.cs");

            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "UpdateFeed");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "UpdateFeeds");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "UpdateResource");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "UpdateResources");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "FeedRecord", "GetLatest");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "FeedRecord", "GetResource");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "BigInteger", "GetPairCount");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "string", "GetPairByIndex");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "string[]", "GetAllPairs");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "FeedRecord[]", "GetAllFeedRecords");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "FeedRecord[]", "GetAllResources");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "SetUpdater");
            Assert.Contains("FeedUpdated", code);
            Assert.Contains("shared numeric resources", code);
        }
    }
}
