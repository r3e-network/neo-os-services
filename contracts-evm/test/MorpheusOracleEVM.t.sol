// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase, Vm, Log} from "./TestBase.sol";
import {MorpheusOracleEVM} from "../MorpheusOracleEVM.sol";
import {Owned} from "../Owned.sol";

/// @notice Records the last onOracleResult call so callback dispatch can be asserted.
contract MockCallback {
    uint256 public lastRequestId;
    bool public called;
    address public oracle;
    address public owner;

    constructor(address oracle_) { oracle = oracle_; owner = msg.sender; }

    function approveAdmin(address admin) external {
        require(msg.sender == owner, "only callback owner");
        MorpheusOracleEVM(oracle).approveCallbackAdmin(admin);
    }

    function submit(string calldata operation, bytes calldata payload) external payable returns (uint256) {
        return MorpheusOracleEVM(oracle).requestFromCallback{value: msg.value}(msg.sender, operation, payload);
    }

    function onOracleResult(uint256 requestId, string calldata, bool, bytes calldata, string calldata) external {
        lastRequestId = requestId;
        called = true;
    }

    receive() external payable {}
}

contract MorpheusOracleEVMTest is TestBase {
    MorpheusOracleEVM oracle;

    // verifier key/address (vm.addr derives the address from the key)
    uint256 constant VERIFIER_KEY = 0xA11CE;
    address verifier;
    address updater = address(uint160(0xDEAD01));
    address requester = address(uint160(0x12345678));

    string constant APP = "dice";
    string constant MODULE = "random.generate";

    function setUp() public {
        verifier = vm.addr(VERIFIER_KEY);
        oracle = new MorpheusOracleEVM(updater, verifier);
        oracle.registerModule(MODULE);
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

    // ── 1. callback uniqueness (OR-D-03) ───────────────────────────────────────
    function test_callbackUniqueness_rejectsHijack() public {
        address cb = address(0xCB);
        _registerApp("appA", address(this), cb);

        // A different appId trying to bind the SAME callback must revert.
        vm.expectRevert(MorpheusOracleEVM.CallbackAlreadyRegistered.selector);
        oracle.registerMiniApp("appB", address(this), cb);

        // The original mapping is intact.
        assertEq(
            keccak256(bytes(oracle.appIdByCallback(cb))),
            keccak256(bytes("appA")),
            "callback mapping hijacked"
        );
    }

    function test_callbackUniqueness_distinctCallbacksOk() public {
        _registerApp("appA", address(this), address(0xCB1));
        _registerApp("appB", address(this), address(0xCB2)); // distinct cb -> allowed
        assertEq(keccak256(bytes(oracle.appIdByCallback(address(0xCB2)))), keccak256(bytes("appB")), "distinct cb failed");
    }

    function test_zeroCallbackAllowedMultipleTimes() public {
        // appId with no callback never touches the reverse index.
        _registerApp("appA", address(this), address(0));
        _registerApp("appB", address(this), address(0));
        assertTrue(true, "zero callback should not conflict");
    }

    function test_emptyAppIdRejected() public {
        vm.expectRevert(MorpheusOracleEVM.InvalidAppId.selector);
        oracle.registerMiniApp("", address(this), address(0xCB));
    }

    function test_nonOwnerCannotBindUnapprovedCallback() public {
        MockCallback callback = new MockCallback(address(oracle));
        address attacker = address(0xBAD);
        vm.prank(attacker);
        vm.expectRevert(MorpheusOracleEVM.CallbackNotApproved.selector);
        oracle.registerMiniApp("squatted", attacker, address(callback));
    }

    function test_callbackCanApproveItsAdmin() public {
        MockCallback callback = new MockCallback(address(oracle));
        address appAdmin = address(0xA11CE);
        callback.approveAdmin(appAdmin);

        vm.prank(appAdmin);
        oracle.registerMiniApp("approved", appAdmin, address(callback));
        assertEq(
            keccak256(bytes(oracle.appIdByCallback(address(callback)))),
            keccak256(bytes("approved")),
            "approved callback registration failed"
        );
    }

    // ── 2. exact fee / no strand ────────────────────────────────────────────────
    function test_feeZero_refundsAllValue_noStrand() public {
        _registerApp(APP, address(this), address(0));
        vm.deal(address(this), 5 ether);
        uint256 balBefore = address(this).balance;

        // fee is 0; sending value must NOT strand — it is fully refunded.
        oracle.submitRequest{value: 1 ether}(APP, MODULE, MODULE, hex"");

        assertEq(oracle.accruedFees(), 0, "fee==0 must not accrue");
        assertEq(address(oracle).balance, 0, "no value may be stranded in oracle");
        assertEq(address(this).balance, balBefore, "full value must be refunded");
    }

    function test_overpayment_refunded_onlyFeeAccrued() public {
        _registerApp(APP, address(this), address(0));
        oracle.setRequestFee(0.1 ether);
        vm.deal(address(this), 5 ether);
        uint256 balBefore = address(this).balance;

        oracle.submitRequest{value: 1 ether}(APP, MODULE, MODULE, hex"");

        assertEq(oracle.accruedFees(), 0.1 ether, "only the fee should accrue");
        assertEq(oracle.reservedFees(), 0.1 ether, "fee must be reserved while pending");
        assertEq(address(oracle).balance, 0.1 ether, "only the fee should remain");
        assertEq(address(this).balance, balBefore - 0.1 ether, "overpayment must be refunded");
    }

    function test_underpayment_reverts() public {
        _registerApp(APP, address(this), address(0));
        oracle.setRequestFee(0.1 ether);
        vm.deal(address(this), 5 ether);
        vm.expectRevert(MorpheusOracleEVM.FeeNotPaid.selector);
        oracle.submitRequest{value: 0.05 ether}(APP, MODULE, MODULE, hex"");
    }

    function test_exactFee_noRefund() public {
        _registerApp(APP, address(this), address(0));
        oracle.setRequestFee(0.1 ether);
        vm.deal(address(this), 5 ether);
        uint256 balBefore = address(this).balance;
        oracle.submitRequest{value: 0.1 ether}(APP, MODULE, MODULE, hex"");
        assertEq(address(this).balance, balBefore - 0.1 ether, "exact fee should debit exactly the fee");
        assertEq(address(oracle).balance, 0.1 ether, "exact fee retained");
    }

    // ── 3. TTL expiry + refund ──────────────────────────────────────────────────
    function test_expiry_refundsFeePayer_releasesReserved() public {
        _registerApp(APP, address(this), address(0));
        oracle.setRequestFee(0.2 ether);
        vm.deal(address(this), 5 ether);

        uint256 id = oracle.submitRequest{value: 0.2 ether}(APP, MODULE, MODULE, hex"");
        assertEq(oracle.reservedFees(), 0.2 ether, "reserved after submit");

        uint256 balBefore = address(this).balance;
        // not yet expired
        vm.prank(updater);
        vm.expectRevert(MorpheusOracleEVM.NotExpired.selector);
        oracle.expireStaleRequest(id);

        // warp past TTL, then expire
        vm.warp(block.timestamp + oracle.requestTTL() + 1);
        vm.prank(updater);
        oracle.expireStaleRequest(id);

        assertEq(address(this).balance, balBefore + 0.2 ether, "fee must be refunded to payer");
        assertEq(oracle.reservedFees(), 0, "reservation must be released on expiry");
        assertEq(oracle.accruedFees(), 0, "accrued must drop by the refund");
        assertEq(address(oracle).balance, 0, "no funds left after full refund");

        MorpheusOracleEVM.Request memory r = oracle.getRequest(id);
        assertEq(uint256(uint8(r.status)), 3, "status must be Failed after expiry");
    }

    function test_expiry_unauthorizedReverts() public {
        _registerApp(APP, address(this), address(0));
        oracle.setRequestFee(0.1 ether);
        vm.deal(address(this), 5 ether);
        uint256 id = oracle.submitRequest{value: 0.1 ether}(APP, MODULE, MODULE, hex"");
        vm.warp(block.timestamp + oracle.requestTTL() + 1);
        vm.prank(requester); // neither owner nor updater
        vm.expectRevert(MorpheusOracleEVM.NotAuthorized.selector);
        oracle.expireStaleRequest(id);
    }

    function test_cannotExpireFulfilled() public {
        _registerApp(APP, address(this), address(0));
        oracle.setRequestFee(0.1 ether);
        vm.deal(address(this), 5 ether);
        uint256 id = oracle.submitRequest{value: 0.1 ether}(APP, MODULE, MODULE, hex"");

        bytes memory sig = _sign(id, true, hex"01", "");
        vm.prank(updater);
        oracle.fulfillRequest(id, true, hex"01", "", sig);

        vm.warp(block.timestamp + oracle.requestTTL() + 1);
        vm.prank(updater);
        vm.expectRevert(MorpheusOracleEVM.RequestNotPending.selector);
        oracle.expireStaleRequest(id);
    }

    // ── 4. reserved-fee invariant ───────────────────────────────────────────────
    function test_ownerCannotWithdrawReserved() public {
        _registerApp(APP, address(this), address(0));
        oracle.setRequestFee(0.3 ether);
        vm.deal(address(this), 5 ether);

        oracle.submitRequest{value: 0.3 ether}(APP, MODULE, MODULE, hex"");
        // accrued == reserved == 0.3 -> withdrawable == 0
        assertEq(oracle.withdrawableFees(), 0, "reserved fees must not be withdrawable");
        vm.expectRevert(MorpheusOracleEVM.ExceedsWithdrawable.selector);
        oracle.withdrawFees(payable(address(this)), 0.3 ether);
    }

    function test_fulfillReleasesReserved_thenWithdrawable() public {
        _registerApp(APP, address(this), address(0));
        oracle.setRequestFee(0.3 ether);
        vm.deal(address(this), 5 ether);

        uint256 id = oracle.submitRequest{value: 0.3 ether}(APP, MODULE, MODULE, hex"");
        bytes memory sig = _sign(id, true, hex"02", "");
        vm.prank(updater);
        oracle.fulfillRequest(id, true, hex"02", "", sig);

        // fee earned -> reservation released -> fully withdrawable
        assertEq(oracle.reservedFees(), 0, "reserved must be released on fulfill");
        assertEq(oracle.withdrawableFees(), 0.3 ether, "earned fee must be withdrawable");

        address payable sink = payable(address(0x5151));
        oracle.withdrawFees(sink, 0.3 ether);
        assertEq(sink.balance, 0.3 ether, "owner withdrew earned fee");
        assertEq(oracle.accruedFees(), 0, "accrued cleared after withdraw");
    }

    function test_invariant_accruedGteReserved_acrossMixedRequests() public {
        _registerApp(APP, address(this), address(0));
        oracle.setRequestFee(0.1 ether);
        vm.deal(address(this), 10 ether);

        uint256 a = oracle.submitRequest{value: 0.1 ether}(APP, MODULE, MODULE, hex"");
        uint256 b = oracle.submitRequest{value: 0.1 ether}(APP, MODULE, MODULE, hex"");
        oracle.submitRequest{value: 0.1 ether}(APP, MODULE, MODULE, hex""); // c left pending

        // fulfill a, expire b (after TTL)
        bytes memory sig = _sign(a, true, hex"", "");
        vm.prank(updater);
        oracle.fulfillRequest(a, true, hex"", "", sig);

        vm.warp(block.timestamp + oracle.requestTTL() + 1);
        vm.prank(updater);
        oracle.expireStaleRequest(b);

        // a earned (0.1), b refunded (-0.1 accrued, -0.1 reserved), c still reserved (0.1)
        assertTrue(oracle.accruedFees() >= oracle.reservedFees(), "invariant accrued >= reserved broken");
        assertEq(oracle.reservedFees(), 0.1 ether, "only c remains reserved");
        assertEq(oracle.withdrawableFees(), 0.1 ether, "only a's fee withdrawable");
    }

    // ── 5. owner-change event ───────────────────────────────────────────────────
    function test_setOwner_emitsOwnerChanged() public {
        vm.expectEmit(true, true, false, false);
        emit Owned.OwnerChanged(address(this), address(0x9999));
        oracle.setOwner(address(0x9999));
        assertEq(oracle.owner(), address(0x9999), "owner not updated");
    }

    // ── callback dispatch + fee-charged-to-callback parity ──────────────────────
    function test_requestFromCallback_chargesCallback_andDispatches() public {
        MockCallback cb = new MockCallback(address(oracle));
        _registerApp(APP, address(this), address(cb));
        oracle.setRequestFee(0.1 ether);
        vm.deal(address(this), 1 ether);

        // callback submits with the fee; overage refunded to the callback contract.
        // The 0.5 value comes from the test; net effect on cb = +0.5 in, -0.1 fee, +0.4 refund = +0.4.
        uint256 id = cb.submit{value: 0.5 ether}(MODULE, abi.encode(uint8(3)));
        assertEq(address(cb).balance, 0.4 ether, "callback should net the overage refund (0.5 - 0.1)");

        MorpheusOracleEVM.Request memory r = oracle.getRequest(id);
        assertEq(r.feePayer, address(cb), "feePayer must be the callback contract");
        assertEq(r.feePaid, 0.1 ether, "feePaid recorded");

        bytes memory sig = _sign(id, true, hex"04", "");
        vm.prank(updater);
        oracle.fulfillRequest(id, true, hex"04", "", sig);
        assertTrue(cb.called(), "callback not dispatched");
        assertEq(cb.lastRequestId(), id, "callback got wrong requestId");
    }

    function test_expiry_refundsCallbackContract() public {
        MockCallback cb = new MockCallback(address(oracle));
        _registerApp(APP, address(this), address(cb));
        oracle.setRequestFee(0.1 ether);
        vm.deal(address(this), 1 ether);

        // cb starts at 0; submitting 0.1 (exact fee) leaves cb at 0 (all forwarded).
        uint256 id = cb.submit{value: 0.1 ether}(MODULE, hex"");
        assertEq(address(cb).balance, 0, "exact fee fully forwarded from callback");

        vm.warp(block.timestamp + oracle.requestTTL() + 1);
        vm.prank(updater);
        oracle.expireStaleRequest(id);
        assertEq(address(cb).balance, 0.1 ether, "expiry must refund the fee to the callback contract");
    }

    receive() external payable {}
}
