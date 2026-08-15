// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Owned
/// @notice Minimal single-owner admin base shared by the EVM (Neo X) mirror
/// contracts (MorpheusOracleEVM, MorpheusPriceFeed, MiniAppMessageEVM,
/// MiniAppDiceGameEVM). `owner` is declared first so it occupies storage slot 0
/// in every deriving contract, matching the pre-extraction layout. The owner is
/// set in each contract's constructor (the base intentionally has no constructor).
abstract contract Owned {
    address public owner;

    event OwnerChanged(address indexed previous, address indexed next);

    error NotOwner();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function setOwner(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnerChanged(owner, next);
        owner = next;
    }
}
