// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Owned} from "./Owned.sol";

/// @title Updatable
/// @notice Owner + updater admin base. `updater` lands in storage slot 1 (after
/// the inherited `owner` at slot 0), matching the pre-extraction layout. Used by
/// MorpheusOracleEVM and MorpheusPriceFeed; reuses Owned's ZeroAddress error.
abstract contract Updatable is Owned {
    address public updater;

    event UpdaterChanged(address indexed previous, address indexed next);

    error NotUpdater();

    modifier onlyUpdater() {
        if (msg.sender != updater && msg.sender != owner) revert NotUpdater();
        _;
    }

    function setUpdater(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit UpdaterChanged(updater, next);
        updater = next;
    }
}
