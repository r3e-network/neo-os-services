// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal forge cheatcode interface + assertion base, declared locally so
/// the suite runs fully offline (no forge-std fetch). The vm address is the standard
/// forge cheatcode precompile, available to any forge test without dependencies.
interface Vm {
    function warp(uint256) external;
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function deal(address, uint256) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function expectEmit(bool, bool, bool, bool) external;
    function expectEmit(bool, bool, bool, bool, address) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

struct Log {
    bytes32[] topics;
    bytes data;
    address emitter;
}

/// @notice Tiny assertion harness. A test fails if it reverts; helpers revert with a
/// descriptive reason so `forge test -vv` shows the failure cause.
contract TestBase {
    Vm internal constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    function assertTrue(bool cond, string memory reason) internal pure {
        if (!cond) revert(reason);
    }

    function assertEq(uint256 a, uint256 b, string memory reason) internal pure {
        if (a != b) revert(reason);
    }

    function assertEq(address a, address b, string memory reason) internal pure {
        if (a != b) revert(reason);
    }

    function assertEq(bytes32 a, bytes32 b, string memory reason) internal pure {
        if (a != b) revert(reason);
    }
}
