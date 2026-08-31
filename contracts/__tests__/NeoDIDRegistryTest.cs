using Xunit;

namespace MorpheusOracle.Contracts.Tests
{
    public class NeoDIDRegistryTest
    {
        [Fact]
        public void NeoDIDRegistryExposesExpectedApi()
        {
            string code = ContractSourceAssertions.ReadSource(
                "contracts",
                "NeoDIDRegistry",
                "NeoDIDRegistry.cs");

            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "UInt160", "Admin");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "ECPoint", "Verifier");
            // P0-07: admin rotation and upgrade are propose/execute timelock
            // pairs, not instant setters.
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "ProposeAdmin");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "ExecuteAdminChange");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "CancelAdminChange");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "ScheduleUpdate");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "CancelUpdate");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "SetVerifier");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "RegisterBinding");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "void", "RevokeBinding");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "BindingRecord", "GetBinding");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "bool", "IsMasterNullifierUsed");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "bool", "IsActionNullifierUsed");
            ContractSourceAssertions.AssertHasPublicStaticMethod(code, "bool", "UseActionTicket");
        }

        [Fact]
        public void NeoDIDRegistryDefinesExpectedEventsAndStructs()
        {
            string code = ContractSourceAssertions.ReadSource(
                "contracts",
                "NeoDIDRegistry",
                "NeoDIDRegistry.cs");

            ContractSourceAssertions.AssertHasPublicStruct(code, "BindingRecord");
            Assert.Contains("BindingRegistered", code);
            Assert.Contains("BindingRevoked", code);
            Assert.Contains("ActionTicketUsed", code);
            Assert.Contains("ComputeBindingDigest", code);
            Assert.Contains("ComputeActionDigest", code);
            Assert.Contains("EncodeCanonicalHash160", code);
            Assert.Contains("Helper.Concat(payload, EncodeCanonicalHash160(vaultAccount))", code);
            Assert.Contains("Helper.Concat(payload, EncodeCanonicalHash160(disposableAccount))", code);
            Assert.Contains("[DisplayName(\"NeoDIDRegistry\")]", code);
        }
    }
}
