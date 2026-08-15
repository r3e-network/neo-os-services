// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./TestBase.sol";
import {MiniAppCreditsV2} from "../MiniAppCreditsV2.sol";

interface VmChainId {
    function chainId(uint256 newChainId) external;
    function etch(address target, bytes calldata newRuntimeBytecode) external;
}

contract MiniAppCreditsV2Test is TestBase {
    VmChainId private constant chainVm = VmChainId(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    uint256 private constant NEO_X_MAINNET = 47_763;
    uint256 private constant WEI_PER_CREDIT = 10 ** 16;

    address private constant SETTLER = address(uint160(0x5000));
    address private constant USER_A = address(uint160(0x1000));
    address private constant USER_B = address(uint160(0x2000));
    address private constant OUTSIDER = address(uint160(0xBAD0));

    MiniAppCreditsV2 private credits;

    receive() external payable {}

    function setUp() public {
        chainVm.chainId(NEO_X_MAINNET);
        credits = new MiniAppCreditsV2(SETTLER);
        vm.deal(USER_A, 100 ether);
        vm.deal(USER_B, 100 ether);
    }

    function _buy(address user, uint256 count) private {
        vm.prank(user);
        credits.buyCredits{value: count * WEI_PER_CREDIT}();
    }

    function _oneUserBatch(address user, int256 delta)
        private
        pure
        returns (address[] memory users, int256[] memory deltas)
    {
        users = new address[](1);
        deltas = new int256[](1);
        users[0] = user;
        deltas[0] = delta;
    }

    function _post(
        uint256 epoch,
        uint256 windowStart,
        uint256 windowEnd,
        address[] memory users,
        int256[] memory deltas
    ) private returns (bytes32 root, uint256 debited) {
        root = credits.computeBatchRoot(epoch, windowStart, windowEnd, users, deltas);
        vm.prank(SETTLER);
        debited = credits.postSettlement(epoch, windowStart, windowEnd, users, deltas, root);
    }

    function test_constructorIsMainnetOnlyAndFreshV2() public {
        assertEq(credits.NEO_X_MAINNET_CHAIN_ID(), NEO_X_MAINNET, "chain id");
        assertEq(credits.CREDITS_PER_GAS(), 100, "credits per GAS");
        assertEq(credits.GAS_WEI_PER_CREDIT(), WEI_PER_CREDIT, "base-unit rate");
        assertEq(credits.STATE_VERSION(), 2, "state version");
        assertTrue(!credits.IMPORTS_V1_BALANCES(), "must not import V1");
        assertEq(credits.currentEpoch(), 0, "fresh epoch");
        assertEq(credits.lastSettledEventId(), 0, "fresh window");
        assertEq(credits.totalSettledCredits(), 0, "fresh liability");
        assertEq(credits.owner(), address(this), "owner");
        assertEq(credits.settler(), SETTLER, "settler");

        chainVm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(MiniAppCreditsV2.WrongChain.selector, uint256(1)));
        new MiniAppCreditsV2(SETTLER);
    }

    function test_constructorRejectsZeroSettler() public {
        vm.expectRevert(MiniAppCreditsV2.ZeroAddress.selector);
        new MiniAppCreditsV2(address(0));
    }

    function test_buyUsesExactOneHundredCreditsPerGas() public {
        vm.prank(USER_A);
        uint256 bought = credits.buyCredits{value: 1 ether}();

        assertEq(bought, 100, "one GAS must buy 100 credits");
        assertEq(credits.settledBalanceOf(USER_A), 100, "user balance");
        assertEq(credits.totalSettledCredits(), 100, "credit liability");
        assertEq(credits.totalGasCollected(), 1 ether, "collected GAS");
        assertEq(credits.heldGas(), 1 ether, "held GAS");
        assertEq(credits.backingLiabilityGas(), 1 ether, "backing liability");
        assertEq(credits.surplusGas(), 0, "no purchase surplus");
    }

    function testFuzz_purchaseAlwaysMaintainsExactBacking(uint16 rawCredits) public {
        uint256 count = uint256(rawCredits) + 1;
        uint256 gasAmount = count * WEI_PER_CREDIT;
        vm.deal(USER_A, gasAmount);
        _buy(USER_A, count);

        assertEq(credits.settledBalanceOf(USER_A), count, "fuzz balance");
        assertEq(credits.backingLiabilityGas(), gasAmount, "fuzz liability");
        assertEq(credits.heldGas(), gasAmount, "fuzz backing");
    }

    function test_buyRejectsZeroSubCreditDustAndWrongChain() public {
        vm.startPrank(USER_A);
        vm.expectRevert(MiniAppCreditsV2.InvalidAmount.selector);
        credits.buyCredits{value: 0}();
        vm.expectRevert(MiniAppCreditsV2.InvalidAmount.selector);
        credits.buyCredits{value: WEI_PER_CREDIT - 1}();
        vm.expectRevert(MiniAppCreditsV2.NonIntegralPayment.selector);
        credits.buyCredits{value: WEI_PER_CREDIT + 1}();
        vm.stopPrank();

        chainVm.chainId(894_710_606);
        vm.prank(USER_A);
        vm.expectRevert(abi.encodeWithSelector(MiniAppCreditsV2.WrongChain.selector, uint256(894_710_606)));
        credits.buyCredits{value: WEI_PER_CREDIT}();
    }

    function test_pauseBlocksBuyButNotSettlement() public {
        _buy(USER_A, 10);
        credits.setPaused(true);

        vm.prank(USER_B);
        vm.expectRevert(MiniAppCreditsV2.ContractPaused.selector);
        credits.buyCredits{value: WEI_PER_CREDIT}();

        (address[] memory users, int256[] memory deltas) = _oneUserBatch(USER_A, -1);
        _post(1, 0, 1, users, deltas);
        assertEq(credits.settledBalanceOf(USER_A), 9, "settlement while paused");
    }

    function test_settlementRequiresOperatorAndCanonicalRoot() public {
        _buy(USER_A, 10);
        (address[] memory users, int256[] memory deltas) = _oneUserBatch(USER_A, -3);
        bytes32 root = credits.computeBatchRoot(1, 0, 9, users, deltas);

        vm.prank(OUTSIDER);
        vm.expectRevert(MiniAppCreditsV2.NotOperator.selector);
        credits.postSettlement(1, 0, 9, users, deltas, root);

        vm.prank(SETTLER);
        vm.expectRevert(MiniAppCreditsV2.BatchRootMismatch.selector);
        credits.postSettlement(1, 0, 9, users, deltas, bytes32(uint256(1)));
    }

    function test_settlementAdvancesContinuousEpochAndWindowAndClamps() public {
        _buy(USER_A, 4);
        _buy(USER_B, 10);

        address[] memory users = new address[](2);
        int256[] memory deltas = new int256[](2);
        users[0] = USER_A;
        users[1] = USER_B;
        deltas[0] = -7;
        deltas[1] = -3;

        (bytes32 root, uint256 debited) = _post(1, 0, 17, users, deltas);
        assertEq(debited, 7, "actual debit must be clamped");
        assertEq(credits.currentEpoch(), 1, "epoch");
        assertEq(credits.lastSettledEventId(), 17, "window end");
        assertEq(credits.currentBatchRoot(), root, "current root");
        assertEq(credits.batchEpochForRoot(root), 1, "root epoch");
        assertEq(credits.settledBalanceOf(USER_A), 0, "clamped user");
        assertEq(credits.settledBalanceOf(USER_B), 7, "normal user");
        assertEq(credits.totalSettledCredits(), 7, "remaining liability");

        (address[] memory nextUsers, int256[] memory nextDeltas) = _oneUserBatch(USER_B, -1);
        bytes32 wrongEpoch = credits.computeBatchRoot(3, 17, 18, nextUsers, nextDeltas);
        vm.prank(SETTLER);
        vm.expectRevert(MiniAppCreditsV2.InvalidEpoch.selector);
        credits.postSettlement(3, 17, 18, nextUsers, nextDeltas, wrongEpoch);

        bytes32 wrongWindow = credits.computeBatchRoot(2, 16, 18, nextUsers, nextDeltas);
        vm.prank(SETTLER);
        vm.expectRevert(MiniAppCreditsV2.InvalidWindow.selector);
        credits.postSettlement(2, 16, 18, nextUsers, nextDeltas, wrongWindow);
    }

    function testFuzz_settlementClampCannotExceedPurchasedLiability(uint16 rawPurchased, uint16 rawSpend) public {
        uint256 purchased = uint256(rawPurchased) + 1;
        uint256 spend = uint256(rawSpend) + 1;
        vm.deal(USER_A, purchased * WEI_PER_CREDIT);
        _buy(USER_A, purchased);

        // `spend` is derived from uint16 and is therefore safely within int256.
        // forge-lint: disable-next-line(unsafe-typecast)
        (address[] memory users, int256[] memory deltas) = _oneUserBatch(USER_A, -int256(spend));
        (, uint256 debited) = _post(1, 0, 1, users, deltas);

        uint256 expectedDebit = spend < purchased ? spend : purchased;
        assertEq(debited, expectedDebit, "fuzz clamp");
        assertEq(credits.totalSettledCredits(), purchased - expectedDebit, "fuzz remaining liability");
        assertTrue(credits.heldGas() >= credits.backingLiabilityGas(), "fuzz backing invariant");
    }

    function test_settlementEmitsStrictProofFields() public {
        _buy(USER_A, 2);
        (address[] memory users, int256[] memory deltas) = _oneUserBatch(USER_A, -5);
        bytes32 root = credits.computeBatchRoot(1, 0, 42, users, deltas);

        vm.expectEmit(true, true, false, true, address(credits));
        emit MiniAppCreditsV2.SettlementPosted(1, root, 0, 42, 1, 5, 2);
        vm.prank(SETTLER);
        credits.postSettlement(1, 0, 42, users, deltas, root);
    }

    function test_batchRootMatchesSharedFixedVector() public {
        address vectorContract = 0x1111111111111111111111111111111111111111;
        chainVm.etch(vectorContract, address(credits).code);
        MiniAppCreditsV2 vectorCredits = MiniAppCreditsV2(vectorContract);

        address[] memory users = new address[](2);
        int256[] memory deltas = new int256[](2);
        users[0] = address(uint160(0x1000));
        users[1] = address(uint160(0x2000));
        deltas[0] = -3;
        deltas[1] = -125;

        bytes32 root = vectorCredits.computeBatchRoot(7, 42, 99, users, deltas);
        assertEq(root, 0x921e831a353e0d441155568584e4b7c97523308dfeffd1c95fd89bdb2e63f9e1, "shared batch root vector");
    }

    function test_duplicateRootIsRejected() public {
        _buy(USER_A, 10);
        (address[] memory users, int256[] memory deltas) = _oneUserBatch(USER_A, -1);
        (bytes32 root,) = _post(1, 0, 1, users, deltas);

        vm.prank(SETTLER);
        vm.expectRevert(MiniAppCreditsV2.BatchRootAlreadyUsed.selector);
        credits.postSettlement(1, 0, 1, users, deltas, root);
    }

    function test_batchRequiresSortedUniqueUsersAndNegativeDeltas() public {
        address[] memory users = new address[](2);
        int256[] memory deltas = new int256[](2);
        users[0] = USER_B;
        users[1] = USER_A;
        deltas[0] = -1;
        deltas[1] = -1;
        vm.expectRevert(MiniAppCreditsV2.UsersNotStrictlySorted.selector);
        credits.computeBatchRoot(1, 0, 1, users, deltas);

        users[0] = USER_A;
        users[1] = USER_A;
        vm.expectRevert(MiniAppCreditsV2.UsersNotStrictlySorted.selector);
        credits.computeBatchRoot(1, 0, 1, users, deltas);

        users[1] = USER_B;
        deltas[1] = 0;
        vm.expectRevert(MiniAppCreditsV2.InvalidDelta.selector);
        credits.computeBatchRoot(1, 0, 1, users, deltas);

        deltas[1] = 1;
        vm.expectRevert(MiniAppCreditsV2.InvalidDelta.selector);
        credits.computeBatchRoot(1, 0, 1, users, deltas);

        deltas[1] = type(int256).min;
        vm.expectRevert(MiniAppCreditsV2.InvalidDelta.selector);
        credits.computeBatchRoot(1, 0, 1, users, deltas);
    }

    function test_batchSizeIsBoundedAtFiveHundred() public {
        address[] memory users = new address[](501);
        int256[] memory deltas = new int256[](501);
        for (uint256 i = 0; i < users.length; ++i) {
            // The loop is capped at 501, far below uint160's maximum.
            // forge-lint: disable-next-line(unsafe-typecast)
            users[i] = address(uint160(i + 1));
            deltas[i] = -1;
        }
        vm.expectRevert(MiniAppCreditsV2.InvalidBatchSize.selector);
        credits.computeBatchRoot(1, 0, 1, users, deltas);
    }

    function test_rescueIsOwnerOnlyAndStrictlySurplusOnly() public {
        _buy(USER_A, 10);
        (address[] memory users, int256[] memory deltas) = _oneUserBatch(USER_A, -4);
        _post(1, 0, 1, users, deltas);
        assertEq(credits.surplusGas(), 4 * WEI_PER_CREDIT, "settled debit creates surplus");

        vm.prank(SETTLER);
        vm.expectRevert(MiniAppCreditsV2.NotOwner.selector);
        credits.rescueSurplusGas(payable(SETTLER), 1);

        uint256 ownerBefore = address(this).balance;
        credits.rescueSurplusGas(payable(address(this)), 4 * WEI_PER_CREDIT);
        assertEq(address(this).balance, ownerBefore + 4 * WEI_PER_CREDIT, "surplus");
        assertEq(credits.heldGas(), 6 * WEI_PER_CREDIT, "backing remains");
        assertEq(credits.backingLiabilityGas(), 6 * WEI_PER_CREDIT, "full backing remains");
        assertEq(credits.surplusGas(), 0, "surplus exhausted");

        vm.expectRevert(MiniAppCreditsV2.InsufficientBacking.selector);
        credits.rescueSurplusGas(payable(address(this)), 1);
    }

    function test_ownerTransferIsTwoStepAndSettlerRotationIsOwnerOnly() public {
        address nextOwner = address(uint160(0xA11CE));
        address nextSettler = address(uint160(0x6000));

        vm.prank(OUTSIDER);
        vm.expectRevert(MiniAppCreditsV2.NotOwner.selector);
        credits.proposeOwner(nextOwner);

        credits.proposeOwner(nextOwner);
        vm.prank(OUTSIDER);
        vm.expectRevert(MiniAppCreditsV2.NotPendingOwner.selector);
        credits.acceptOwner();
        vm.prank(nextOwner);
        credits.acceptOwner();
        assertEq(credits.owner(), nextOwner, "new owner");

        vm.prank(OUTSIDER);
        vm.expectRevert(MiniAppCreditsV2.NotOwner.selector);
        credits.setSettler(nextSettler);
        vm.prank(nextOwner);
        credits.setSettler(nextSettler);
        assertEq(credits.settler(), nextSettler, "new settler");
    }
}
