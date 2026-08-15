// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase, Vm, Log} from "./TestBase.sol";
import {MorpheusOracleEVM} from "../MorpheusOracleEVM.sol";
import {Owned} from "../Owned.sol";
import {Updatable} from "../Updatable.sol";

/// @title MorpheusOracleEVMFulfillmentTest
/// @notice Covers signature verification, request submission validation,
/// double-fulfillment prevention, updater authorization, fulfillment digest
/// binding, RequestTTL configuration, and module lifecycle.
contract MorpheusOracleEVMFulfillmentTest is TestBase {
    MorpheusOracleEVM oracle;

    uint256 constant VERIFIER_KEY = 0xA11CE;
    uint256 constant WRONG_KEY = 0xB0B;
    address verifier;
    address updater = address(uint160(0xDEAD01));
    address stranger = address(uint160(0x99999));

    string constant APP = "dice";
    string constant MODULE = "random.generate";

    function setUp() public {
        verifier = vm.addr(VERIFIER_KEY);
        oracle = new MorpheusOracleEVM(updater, verifier);
        oracle.registerModule(MODULE);
        _registerApp(APP, address(this), address(0));
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _registerApp(string memory appId, address admin, address cb) internal {
        oracle.registerMiniApp(appId, admin, cb);
        oracle.grantModule(appId, MODULE);
    }

    function _sign(uint256 requestId, bool success, bytes memory result, string memory err)
        internal
        returns (bytes memory)
    {
        bytes32 digest = oracle.fulfillmentDigest(requestId, success, result, err);
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(VERIFIER_KEY, ethSigned);
        return abi.encodePacked(r, s, v);
    }

    function _signWithKey(uint256 key, uint256 requestId, bool success, bytes memory result, string memory err)
        internal
        returns (bytes memory)
    {
        bytes32 digest = oracle.fulfillmentDigest(requestId, success, result, err);
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, ethSigned);
        return abi.encodePacked(r, s, v);
    }

    function _submitDefault() internal returns (uint256) {
        return oracle.submitRequest(APP, MODULE, "op", hex"");
    }

    function _submitAndFulfill() internal returns (uint256) {
        uint256 id = _submitDefault();
        bytes memory sig = _sign(id, true, hex"01", "");
        vm.prank(updater);
        oracle.fulfillRequest(id, true, hex"01", "", sig);
        return id;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // 1. SIGNATURE VERIFICATION
    // ══════════════════════════════════════════════════════════════════════════

    function test_fulfill_badSignature_wrongKey_reverts() public {
        uint256 id = _submitDefault();
        // Sign with the WRONG key
        bytes memory badSig = _signWithKey(WRONG_KEY, id, true, hex"01", "");
        vm.prank(updater);
        vm.expectRevert(MorpheusOracleEVM.BadSignature.selector);
        oracle.fulfillRequest(id, true, hex"01", "", badSig);
    }

    function test_fulfill_emptySignature_reverts() public {
        uint256 id = _submitDefault();
        vm.prank(updater);
        vm.expectRevert(MorpheusOracleEVM.BadSignature.selector);
        oracle.fulfillRequest(id, true, hex"01", "", hex"");
    }

    function test_fulfill_shortSignature_reverts() public {
        uint256 id = _submitDefault();
        // 32 bytes is too short (needs exactly 65)
        bytes memory shortSig = abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)));
        vm.prank(updater);
        vm.expectRevert(MorpheusOracleEVM.BadSignature.selector);
        oracle.fulfillRequest(id, true, hex"01", "", shortSig);
    }

    function test_fulfill_correctSignature_succeeds() public {
        uint256 id = _submitDefault();
        bytes memory sig = _sign(id, true, hex"CAFE", "");
        vm.prank(updater);
        oracle.fulfillRequest(id, true, hex"CAFE", "", sig);

        MorpheusOracleEVM.Request memory r = oracle.getRequest(id);
        assertEq(uint256(uint8(r.status)), 2, "status must be Succeeded"); // Status.Succeeded == 2
        assertTrue(r.success, "success flag must be true");
        assertEq(keccak256(r.result), keccak256(hex"CAFE"), "result mismatch");
    }

    function test_fulfill_tamperedResult_reverts() public {
        uint256 id = _submitDefault();
        // Sign over the CORRECT result
        bytes memory sig = _sign(id, true, hex"AAAA", "");
        // Attempt to fulfill with a DIFFERENT (tampered) result
        vm.prank(updater);
        vm.expectRevert(MorpheusOracleEVM.BadSignature.selector);
        oracle.fulfillRequest(id, true, hex"BBBB", "", sig);
    }

    function test_fulfill_tamperedErrorString_reverts() public {
        uint256 id = _submitDefault();
        bytes memory sig = _sign(id, false, hex"", "original error");
        // Tamper with the error string
        vm.prank(updater);
        vm.expectRevert(MorpheusOracleEVM.BadSignature.selector);
        oracle.fulfillRequest(id, false, hex"", "tampered error", sig);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // 2. REQUEST SUBMISSION VALIDATION
    // ══════════════════════════════════════════════════════════════════════════

    function test_submit_unknownApp_reverts() public {
        vm.expectRevert(MorpheusOracleEVM.AppNotFound.selector);
        oracle.submitRequest("nonexistent-app", MODULE, "op", hex"");
    }

    function test_submit_inactiveApp_reverts() public {
        // Deactivate the app
        oracle.setAppActive(APP, false);
        vm.expectRevert(MorpheusOracleEVM.AppInactive.selector);
        oracle.submitRequest(APP, MODULE, "op", hex"");
    }

    function test_submit_unknownModule_reverts() public {
        vm.expectRevert(MorpheusOracleEVM.UnknownModule.selector);
        oracle.submitRequest(APP, "unregistered.module", "op", hex"");
    }

    function test_submit_ungrantedModule_reverts() public {
        // Register a second module but do NOT grant it to the app
        oracle.registerModule("other.module");
        vm.expectRevert(MorpheusOracleEVM.ModuleNotGranted.selector);
        oracle.submitRequest(APP, "other.module", "op", hex"");
    }

    function test_submit_emitsRequestQueued() public {
        uint256 expectedId = oracle.totalRequests() + 1;
        vm.expectEmit(true, false, false, true);
        emit MorpheusOracleEVM.RequestQueued(
            expectedId, APP, MODULE, "myOp", address(this), address(0), hex"BEEF"
        );
        uint256 id = oracle.submitRequest(APP, MODULE, "myOp", hex"BEEF");
        assertEq(id, expectedId, "request id mismatch");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // 3. DOUBLE-FULFILLMENT PREVENTION
    // ══════════════════════════════════════════════════════════════════════════

    function test_fulfill_twice_reverts() public {
        uint256 id = _submitDefault();
        bytes memory sig = _sign(id, true, hex"01", "");

        vm.prank(updater);
        oracle.fulfillRequest(id, true, hex"01", "", sig);

        // Second fulfillment must revert
        vm.prank(updater);
        vm.expectRevert(MorpheusOracleEVM.RequestNotPending.selector);
        oracle.fulfillRequest(id, true, hex"01", "", sig);
    }

    function test_fulfill_afterExpiry_reverts() public {
        uint256 id = _submitDefault();
        bytes memory sig = _sign(id, true, hex"01", "");

        // Expire the request first
        vm.warp(block.timestamp + oracle.requestTTL() + 1);
        vm.prank(updater);
        oracle.expireStaleRequest(id);

        // Fulfillment after expiry must revert
        vm.prank(updater);
        vm.expectRevert(MorpheusOracleEVM.RequestNotPending.selector);
        oracle.fulfillRequest(id, true, hex"01", "", sig);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // 4. UPDATER AUTHORIZATION
    // ══════════════════════════════════════════════════════════════════════════

    function test_fulfill_nonUpdater_reverts() public {
        uint256 id = _submitDefault();
        bytes memory sig = _sign(id, true, hex"01", "");

        vm.prank(stranger);
        vm.expectRevert(Updatable.NotUpdater.selector);
        oracle.fulfillRequest(id, true, hex"01", "", sig);
    }

    function test_fulfill_ownerAllowed() public {
        uint256 id = _submitDefault();
        bytes memory sig = _sign(id, true, hex"02", "");

        // address(this) is the owner (deployer) — onlyUpdater allows owner
        oracle.fulfillRequest(id, true, hex"02", "", sig);

        MorpheusOracleEVM.Request memory r = oracle.getRequest(id);
        assertEq(uint256(uint8(r.status)), 2, "owner fulfill must succeed");
    }

    function test_fulfill_updaterAllowed() public {
        uint256 id = _submitDefault();
        bytes memory sig = _sign(id, true, hex"03", "");

        vm.prank(updater);
        oracle.fulfillRequest(id, true, hex"03", "", sig);

        MorpheusOracleEVM.Request memory r = oracle.getRequest(id);
        assertEq(uint256(uint8(r.status)), 2, "updater fulfill must succeed");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // 5. FULFILLMENT DIGEST BINDING
    // ══════════════════════════════════════════════════════════════════════════

    function test_digest_changesWithRequestId() public {
        uint256 id1 = _submitDefault();
        uint256 id2 = _submitDefault();

        bytes32 d1 = oracle.fulfillmentDigest(id1, true, hex"AA", "");
        bytes32 d2 = oracle.fulfillmentDigest(id2, true, hex"AA", "");
        assertTrue(d1 != d2, "digest must differ for different requestIds");
    }

    function test_digest_changesWithResult() public {
        uint256 id = _submitDefault();

        bytes32 d1 = oracle.fulfillmentDigest(id, true, hex"AA", "");
        bytes32 d2 = oracle.fulfillmentDigest(id, true, hex"BB", "");
        assertTrue(d1 != d2, "digest must differ for different results");
    }

    function test_digest_changesWithSuccessFlag() public {
        uint256 id = _submitDefault();

        bytes32 d1 = oracle.fulfillmentDigest(id, true, hex"AA", "");
        bytes32 d2 = oracle.fulfillmentDigest(id, false, hex"AA", "");
        assertTrue(d1 != d2, "digest must differ for different success flags");
    }

    function test_digest_changesWithErrorString() public {
        uint256 id = _submitDefault();

        bytes32 d1 = oracle.fulfillmentDigest(id, false, hex"", "err1");
        bytes32 d2 = oracle.fulfillmentDigest(id, false, hex"", "err2");
        assertTrue(d1 != d2, "digest must differ for different error strings");
    }

    function test_digest_stableForSameInputs() public {
        uint256 id = _submitDefault();

        bytes32 d1 = oracle.fulfillmentDigest(id, true, hex"CC", "e");
        bytes32 d2 = oracle.fulfillmentDigest(id, true, hex"CC", "e");
        assertEq(d1, d2, "same inputs must produce same digest");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // 6. REQUEST TTL CONFIGURATION
    // ══════════════════════════════════════════════════════════════════════════

    function test_setRequestTTL_changesValue() public {
        uint256 newTTL = 2 hours;
        oracle.setRequestTTL(newTTL);
        assertEq(oracle.requestTTL(), newTTL, "TTL not updated");
    }

    function test_setRequestTTL_emitsEvent() public {
        uint256 prev = oracle.requestTTL();
        uint256 next = 30 minutes;
        vm.expectEmit(false, false, false, true);
        emit MorpheusOracleEVM.RequestTTLChanged(prev, next);
        oracle.setRequestTTL(next);
    }

    function test_setRequestTTL_zero_reverts() public {
        vm.expectRevert(MorpheusOracleEVM.InvalidTTL.selector);
        oracle.setRequestTTL(0);
    }

    function test_setRequestTTL_nonOwner_reverts() public {
        vm.prank(stranger);
        vm.expectRevert(Owned.NotOwner.selector);
        oracle.setRequestTTL(999);
    }

    function test_setRequestTTL_affectsExpiry() public {
        // Set a very short TTL
        oracle.setRequestTTL(60);
        uint256 id = _submitDefault();

        // Not yet expired at 59 seconds
        vm.warp(block.timestamp + 59);
        vm.prank(updater);
        vm.expectRevert(MorpheusOracleEVM.NotExpired.selector);
        oracle.expireStaleRequest(id);

        // Expired at 61 seconds
        vm.warp(block.timestamp + 2);
        vm.prank(updater);
        oracle.expireStaleRequest(id);

        MorpheusOracleEVM.Request memory r = oracle.getRequest(id);
        assertEq(uint256(uint8(r.status)), 3, "status must be Failed after expiry");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // 7. MODULE LIFECYCLE
    // ══════════════════════════════════════════════════════════════════════════

    function test_moduleDeactivated_blocksRequests() public {
        // Module is active from setUp — deactivate it
        oracle.setModuleActive(MODULE, false);

        vm.expectRevert(MorpheusOracleEVM.UnknownModule.selector);
        oracle.submitRequest(APP, MODULE, "op", hex"");
    }

    function test_moduleReactivated_allowsRequests() public {
        // Deactivate then re-activate
        oracle.setModuleActive(MODULE, false);
        oracle.setModuleActive(MODULE, true);

        // Should succeed now
        uint256 id = oracle.submitRequest(APP, MODULE, "op", hex"");
        assertTrue(id > 0, "request must succeed after reactivation");
    }

    function test_moduleLifecycle_fullCycle() public {
        string memory mod = "lifecycle.module";
        oracle.registerModule(mod);

        // Grant to a fresh app
        oracle.registerMiniApp("lifecycle-app", address(this), address(0));
        oracle.grantModule("lifecycle-app", mod);

        // Works while active
        uint256 id1 = oracle.submitRequest("lifecycle-app", mod, "op", hex"");
        assertTrue(id1 > 0, "initial submit must work");

        // Deactivate blocks
        oracle.setModuleActive(mod, false);
        vm.expectRevert(MorpheusOracleEVM.UnknownModule.selector);
        oracle.submitRequest("lifecycle-app", mod, "op", hex"");

        // Re-activate unblocks
        oracle.setModuleActive(mod, true);
        uint256 id2 = oracle.submitRequest("lifecycle-app", mod, "op", hex"");
        assertTrue(id2 > id1, "reactivated submit must work");
    }

    function test_registerModule_nonOwner_reverts() public {
        vm.prank(stranger);
        vm.expectRevert(Owned.NotOwner.selector);
        oracle.registerModule("hacker.module");
    }

    function test_setModuleActive_nonOwner_reverts() public {
        vm.prank(stranger);
        vm.expectRevert(Owned.NotOwner.selector);
        oracle.setModuleActive(MODULE, false);
    }

    receive() external payable {}
}
