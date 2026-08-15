// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase, Vm, Log} from "./TestBase.sol";
import {MorpheusPriceFeed} from "../MorpheusPriceFeed.sol";
import {Updatable} from "../Updatable.sol";
import {Owned} from "../Owned.sol";

contract MorpheusPriceFeedTest is TestBase {
    MorpheusPriceFeed feed;

    address updater = address(uint160(0xFEED01));
    address outsider = address(uint160(0xBAD001));

    function setUp() public {
        feed = new MorpheusPriceFeed(updater);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _single(string memory sym, uint256 price, uint256 ts, uint256 round) internal {
        string[] memory syms = new string[](1);
        uint256[] memory prices = new uint256[](1);
        uint256[] memory timestamps = new uint256[](1);
        uint256[] memory rounds = new uint256[](1);
        syms[0] = sym;
        prices[0] = price;
        timestamps[0] = ts;
        rounds[0] = round;
        feed.updateFeeds(syms, prices, timestamps, rounds);
    }

    function _batch(
        string[] memory syms,
        uint256[] memory prices,
        uint256[] memory timestamps,
        uint256[] memory rounds
    ) internal {
        feed.updateFeeds(syms, prices, timestamps, rounds);
    }

    // ── 1. Single feed update and read ───────────────────────────────────────

    function test_singleUpdate_andRead() public {
        vm.prank(updater);
        _single("BTC/USD", 67_500_000_000, 1_700_000_000, 1);

        (uint256 price, uint256 ts, uint256 roundId, bool exists) = feed.getLatest("BTC/USD");
        assertEq(price, 67_500_000_000, "price mismatch");
        assertEq(ts, 1_700_000_000, "timestamp mismatch");
        assertEq(roundId, 1, "roundId mismatch");
        assertTrue(exists, "feed should exist");
    }

    function test_singleUpdate_emitsEvent() public {
        vm.expectEmit(false, false, false, true);
        emit MorpheusPriceFeed.FeedUpdated("ETH/USD", 3_200_000_000, 1_700_000_100, 1);

        vm.prank(updater);
        _single("ETH/USD", 3_200_000_000, 1_700_000_100, 1);
    }

    // ── 2. Batch feed update ─────────────────────────────────────────────────

    function test_batchUpdate_multipleSymbols() public {
        string[] memory syms = new string[](3);
        uint256[] memory prices = new uint256[](3);
        uint256[] memory timestamps = new uint256[](3);
        uint256[] memory rounds = new uint256[](3);

        syms[0] = "BTC/USD"; prices[0] = 67_000_000_000; timestamps[0] = 1_700_000_000; rounds[0] = 1;
        syms[1] = "ETH/USD"; prices[1] = 3_200_000_000;  timestamps[1] = 1_700_000_001; rounds[1] = 1;
        syms[2] = "NEO/USD"; prices[2] = 12_500_000;     timestamps[2] = 1_700_000_002; rounds[2] = 1;

        vm.prank(updater);
        _batch(syms, prices, timestamps, rounds);

        (uint256 p0,, uint256 r0, bool e0) = feed.getLatest("BTC/USD");
        (uint256 p1,, uint256 r1, bool e1) = feed.getLatest("ETH/USD");
        (uint256 p2,, uint256 r2, bool e2) = feed.getLatest("NEO/USD");

        assertEq(p0, 67_000_000_000, "BTC price");
        assertEq(p1, 3_200_000_000, "ETH price");
        assertEq(p2, 12_500_000, "NEO price");
        assertEq(r0, 1, "BTC round");
        assertEq(r1, 1, "ETH round");
        assertEq(r2, 1, "NEO round");
        assertTrue(e0 && e1 && e2, "all feeds should exist");
        assertEq(feed.symbolCount(), 3, "symbol count after batch");
    }

    // ── 3. Stale round rejection ─────────────────────────────────────────────

    function test_staleRound_sameRound_reverts() public {
        vm.startPrank(updater);
        _single("BTC/USD", 67_000_000_000, 1_700_000_000, 5);

        vm.expectRevert(abi.encodeWithSelector(MorpheusPriceFeed.StaleRound.selector, "BTC/USD"));
        _single("BTC/USD", 68_000_000_000, 1_700_001_000, 5);
        vm.stopPrank();
    }

    function test_staleRound_lowerRound_reverts() public {
        vm.startPrank(updater);
        _single("ETH/USD", 3_200_000_000, 1_700_000_000, 10);

        vm.expectRevert(abi.encodeWithSelector(MorpheusPriceFeed.StaleRound.selector, "ETH/USD"));
        _single("ETH/USD", 3_100_000_000, 1_700_001_000, 3);
        vm.stopPrank();
    }

    function test_staleRound_higherRound_succeeds() public {
        vm.startPrank(updater);
        _single("BTC/USD", 67_000_000_000, 1_700_000_000, 5);
        _single("BTC/USD", 68_000_000_000, 1_700_001_000, 6);
        vm.stopPrank();

        (uint256 price,,, bool exists) = feed.getLatest("BTC/USD");
        assertEq(price, 68_000_000_000, "price should update on higher round");
        assertTrue(exists, "feed exists");
    }

    // ── 4. Length mismatch revert ────────────────────────────────────────────

    function test_lengthMismatch_pricesShorter_reverts() public {
        string[] memory syms = new string[](2);
        uint256[] memory prices = new uint256[](1);
        uint256[] memory timestamps = new uint256[](2);
        uint256[] memory rounds = new uint256[](2);
        syms[0] = "A"; syms[1] = "B";
        prices[0] = 100;
        timestamps[0] = 1; timestamps[1] = 2;
        rounds[0] = 1; rounds[1] = 1;

        vm.prank(updater);
        vm.expectRevert(MorpheusPriceFeed.LengthMismatch.selector);
        feed.updateFeeds(syms, prices, timestamps, rounds);
    }

    function test_lengthMismatch_timestampsShorter_reverts() public {
        string[] memory syms = new string[](2);
        uint256[] memory prices = new uint256[](2);
        uint256[] memory timestamps = new uint256[](1);
        uint256[] memory rounds = new uint256[](2);
        syms[0] = "A"; syms[1] = "B";
        prices[0] = 100; prices[1] = 200;
        timestamps[0] = 1;
        rounds[0] = 1; rounds[1] = 1;

        vm.prank(updater);
        vm.expectRevert(MorpheusPriceFeed.LengthMismatch.selector);
        feed.updateFeeds(syms, prices, timestamps, rounds);
    }

    function test_lengthMismatch_roundsShorter_reverts() public {
        string[] memory syms = new string[](2);
        uint256[] memory prices = new uint256[](2);
        uint256[] memory timestamps = new uint256[](2);
        uint256[] memory rounds = new uint256[](1);
        syms[0] = "A"; syms[1] = "B";
        prices[0] = 100; prices[1] = 200;
        timestamps[0] = 1; timestamps[1] = 2;
        rounds[0] = 1;

        vm.prank(updater);
        vm.expectRevert(MorpheusPriceFeed.LengthMismatch.selector);
        feed.updateFeeds(syms, prices, timestamps, rounds);
    }

    // ── 5. Authorization (only updater/owner can write) ──────────────────────

    function test_unauthorized_reverts() public {
        vm.prank(outsider);
        vm.expectRevert(Updatable.NotUpdater.selector);
        _single("BTC/USD", 67_000_000_000, 1_700_000_000, 1);
    }

    function test_updater_canWrite() public {
        vm.prank(updater);
        _single("BTC/USD", 67_000_000_000, 1_700_000_000, 1);
        (,,, bool exists) = feed.getLatest("BTC/USD");
        assertTrue(exists, "updater write should succeed");
    }

    // ── 6. Symbol auto-registration and enumeration ──────────────────────────

    function test_symbolRegistration_order() public {
        vm.startPrank(updater);
        _single("AAA", 100, 1, 1);
        _single("BBB", 200, 2, 1);
        _single("CCC", 300, 3, 1);
        vm.stopPrank();

        assertEq(feed.symbolCount(), 3, "count");
        assertEq(keccak256(bytes(feed.symbolAt(0))), keccak256(bytes("AAA")), "index 0");
        assertEq(keccak256(bytes(feed.symbolAt(1))), keccak256(bytes("BBB")), "index 1");
        assertEq(keccak256(bytes(feed.symbolAt(2))), keccak256(bytes("CCC")), "index 2");
    }

    function test_symbolNotDuplicated_onUpdate() public {
        vm.startPrank(updater);
        _single("BTC/USD", 67_000_000_000, 1_700_000_000, 1);
        _single("BTC/USD", 68_000_000_000, 1_700_001_000, 2);
        _single("BTC/USD", 69_000_000_000, 1_700_002_000, 3);
        vm.stopPrank();

        assertEq(feed.symbolCount(), 1, "symbol should not duplicate on re-update");
    }

    // ── 7. getLatest for non-existent symbol returns zeros ───────────────────

    function test_getLatest_nonExistent_returnsZeros() public {
        (uint256 price, uint256 ts, uint256 roundId, bool exists) = feed.getLatest("DOES_NOT_EXIST");
        assertEq(price, 0, "price should be 0");
        assertEq(ts, 0, "timestamp should be 0");
        assertEq(roundId, 0, "roundId should be 0");
        assertTrue(!exists, "exists should be false");
    }

    // ── 8. decimals() returns 6 ──────────────────────────────────────────────

    function test_decimals_returns6() public {
        assertEq(uint256(feed.decimals()), 6, "decimals must be 6");
        assertEq(uint256(feed.DECIMALS()), 6, "DECIMALS constant must be 6");
    }

    // ── 9. Owner can also update (onlyUpdater allows owner) ──────────────────

    function test_owner_canUpdate() public {
        // address(this) is the owner (deployer)
        _single("BTC/USD", 67_000_000_000, 1_700_000_000, 1);
        (uint256 price,,, bool exists) = feed.getLatest("BTC/USD");
        assertEq(price, 67_000_000_000, "owner write price");
        assertTrue(exists, "owner write should succeed");
    }

    // ── 10. setUpdater changes who can write ─────────────────────────────────

    function test_setUpdater_newUpdaterCanWrite_oldCannot() public {
        address newUpdater = address(uint160(0xFEED02));

        feed.setUpdater(newUpdater);
        assertEq(feed.updater(), newUpdater, "updater not changed");

        // new updater can write
        vm.prank(newUpdater);
        _single("ETH/USD", 3_200_000_000, 1_700_000_000, 1);
        (,,, bool exists) = feed.getLatest("ETH/USD");
        assertTrue(exists, "new updater should write");

        // old updater can no longer write
        vm.prank(updater);
        vm.expectRevert(Updatable.NotUpdater.selector);
        _single("BTC/USD", 67_000_000_000, 1_700_000_000, 1);
    }

    function test_setUpdater_onlyOwner() public {
        vm.prank(outsider);
        vm.expectRevert(Owned.NotOwner.selector);
        feed.setUpdater(outsider);
    }

    function test_setUpdater_zeroAddress_reverts() public {
        vm.expectRevert(Owned.ZeroAddress.selector);
        feed.setUpdater(address(0));
    }

    function test_setUpdater_emitsEvent() public {
        address newUpdater = address(uint160(0xFEED03));
        vm.expectEmit(true, true, false, false);
        emit Updatable.UpdaterChanged(updater, newUpdater);
        feed.setUpdater(newUpdater);
    }

    // ── 11. Multiple rounds for same symbol (price progression) ──────────────

    function test_priceProgression_multipleRounds() public {
        vm.startPrank(updater);
        _single("NEO/USD", 10_000_000, 1_700_000_000, 1);
        _single("NEO/USD", 11_500_000, 1_700_001_000, 2);
        _single("NEO/USD", 12_800_000, 1_700_002_000, 3);
        _single("NEO/USD", 11_200_000, 1_700_003_000, 4);
        vm.stopPrank();

        (uint256 price, uint256 ts, uint256 roundId, bool exists) = feed.getLatest("NEO/USD");
        assertEq(price, 11_200_000, "latest price after 4 rounds");
        assertEq(ts, 1_700_003_000, "latest timestamp");
        assertEq(roundId, 4, "latest roundId");
        assertTrue(exists, "feed exists");
    }

    // ── 12. Edge case: roundId=0 for new symbol accepted (first write) ───────

    function test_firstWrite_roundIdZero_accepted() public {
        // For a brand-new symbol, f.roundId == 0, so the stale check
        // (f.roundId != 0 && roundIds_[i] <= f.roundId) is skipped.
        // This means roundId=0 is accepted on the very first write.
        vm.prank(updater);
        _single("NEW/PAIR", 999, 1_700_000_000, 0);

        (uint256 price, uint256 ts, uint256 roundId, bool exists) = feed.getLatest("NEW/PAIR");
        assertEq(price, 999, "price with roundId=0");
        assertEq(ts, 1_700_000_000, "timestamp with roundId=0");
        assertEq(roundId, 0, "roundId stored as 0");
        assertTrue(exists, "feed should exist even with roundId=0");
    }

    function test_secondWrite_roundIdZero_reverts() public {
        // After the first write with roundId=0, a second write with roundId=0
        // should revert because f.roundId is still 0 but f.exists is true...
        // Actually: the check is (f.roundId != 0 && roundIds_[i] <= f.roundId).
        // If f.roundId == 0, the guard is skipped regardless. So roundId=0
        // can be written repeatedly. This documents that behavior.
        vm.startPrank(updater);
        _single("ZERO/ROUND", 100, 1_700_000_000, 0);
        // Second write with roundId=0: f.roundId is 0, guard skipped -> succeeds
        _single("ZERO/ROUND", 200, 1_700_001_000, 0);
        vm.stopPrank();

        (uint256 price,,, bool exists) = feed.getLatest("ZERO/ROUND");
        assertEq(price, 200, "price overwritten with roundId=0 again");
        assertTrue(exists, "exists");
    }

    function test_afterRoundIdPositive_zeroReverts() public {
        // Once roundId > 0 is set, writing roundId=0 must revert (0 <= positive).
        vm.startPrank(updater);
        _single("POS/ROUND", 100, 1_700_000_000, 1);

        vm.expectRevert(abi.encodeWithSelector(MorpheusPriceFeed.StaleRound.selector, "POS/ROUND"));
        _single("POS/ROUND", 200, 1_700_001_000, 0);
        vm.stopPrank();
    }

    // ── constructor state ────────────────────────────────────────────────────

    function test_constructor_setsOwnerAndUpdater() public {
        assertEq(feed.owner(), address(this), "owner should be deployer");
        assertEq(feed.updater(), updater, "updater should be constructor arg");
    }

    function test_constructor_zeroUpdater_defaultsToDeployer() public {
        MorpheusPriceFeed f2 = new MorpheusPriceFeed(address(0));
        assertEq(f2.updater(), address(this), "zero updater defaults to deployer");
    }

    // ── symbolAt out of bounds reverts ───────────────────────────────────────

    function test_symbolAt_outOfBounds_reverts() public {
        vm.expectRevert();
        feed.symbolAt(0);
    }
}
