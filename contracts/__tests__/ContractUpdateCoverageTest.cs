using Xunit;

namespace MorpheusOracle.Contracts.Tests
{
    public class ContractUpdateCoverageTest
    {
        [Theory]
        [InlineData("MorpheusOracle", "MorpheusOracle.cs")]
        [InlineData("MorpheusDataFeed", "MorpheusDataFeed.cs")]
        [InlineData("NeoDIDRegistry", "NeoDIDRegistry.cs")]
        [InlineData("OracleCallbackConsumer", "OracleCallbackConsumer.cs")]
        public void ProductionContractsExposeAdminGatedUpdate(string directory, string fileName)
        {
            string code = ContractSourceAssertions.ReadSource("contracts", directory, fileName);

            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "Update");
            Assert.Contains("ValidateAdmin();", code);
            Assert.Contains("ContractManagement.Update", code);
        }
    }
}
