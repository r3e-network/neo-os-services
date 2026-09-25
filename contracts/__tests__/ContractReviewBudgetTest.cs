using Xunit;

namespace MorpheusOracle.Contracts.Tests
{
    /// <summary>
    /// Per-file security-review budget for this contract estate.
    ///
    /// The same assertion runs in neo-os-contracts, neo-os-miniapps and
    /// neo-os-minigames against one shared implementation of
    /// <see cref="ContractSourceAssertions.AssertContractFilesStayReviewable"/>.
    /// It used to exist only in neo-os-contracts - the tidiest repo - while this
    /// estate holds the largest single files in the platform.
    /// </summary>
    public class ContractReviewBudgetTest
    {
        [Fact]
        public void ContractPartialFilesStayReviewable()
        {
            // Legacy debt, frozen and only allowed to shrink.
            //
            // MorpheusOracle.cs is the worst case in the whole platform: the OS
            // kernel holds the oracle request-fee pool and mixes request routing,
            // sponsorship, callbacks, runtime-verification keys and the P0-04
            // timelock lane in 1461 lines. It is the first file that should be
            // split into partials along those seams, and this ratchet prevents it
            // growing further while that work waits its turn.
            ContractSourceAssertions.AssertContractFilesStayReviewable(
                300,
                "contracts/MorpheusOracle/MorpheusOracle.cs=1461",
                "contracts/MorpheusDataFeed/MorpheusDataFeed.cs=518",
                "contracts/MorpheusOracle/MorpheusOracle.Storage.cs=479");
        }
    }
}
