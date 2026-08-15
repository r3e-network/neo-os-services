// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Updatable} from "./Updatable.sol";

/// @title MorpheusPriceFeed
/// @notice EVM (Neo X) price feed mirroring the Neo N3 MorpheusDataFeed: an
/// updater pushes batched prices that consumers read on-chain. Prices are scaled
/// by 1e6 (DECIMALS=6) to match the Neo N3 feed so a single off-chain pusher can
/// write the same integer value to both chains. roundId must strictly increase.
contract MorpheusPriceFeed is Updatable {
    uint8 public constant DECIMALS = 6;

    struct Feed {
        uint256 price;     // scaled by 1e6
        uint256 timestamp; // unix seconds (source time)
        uint256 roundId;   // strictly increasing
        bool exists;
    }

    mapping(bytes32 => Feed) private _feeds;
    string[] private _symbols;

    event FeedUpdated(string symbol, uint256 price, uint256 timestamp, uint256 roundId);

    error LengthMismatch();
    error StaleRound(string symbol);

    constructor(address initialUpdater) {
        owner = msg.sender;
        updater = initialUpdater == address(0) ? msg.sender : initialUpdater;
        emit OwnerChanged(address(0), msg.sender);
        emit UpdaterChanged(address(0), updater);
    }

    /// @notice Batch-update feeds. roundId per symbol must be > the stored roundId
    /// (or the symbol is new). Symbols are auto-registered on first write.
    function updateFeeds(
        string[] calldata symbols_,
        uint256[] calldata prices_,
        uint256[] calldata timestamps_,
        uint256[] calldata roundIds_
    ) external onlyUpdater {
        uint256 n = symbols_.length;
        if (prices_.length != n || timestamps_.length != n || roundIds_.length != n) revert LengthMismatch();
        for (uint256 i = 0; i < n; i++) {
            bytes32 k = keccak256(bytes(symbols_[i]));
            Feed storage f = _feeds[k];
            if (f.roundId != 0 && roundIds_[i] <= f.roundId) revert StaleRound(symbols_[i]);
            f.price = prices_[i];
            f.timestamp = timestamps_[i];
            f.roundId = roundIds_[i];
            if (!f.exists) {
                f.exists = true;
                _symbols.push(symbols_[i]);
            }
            emit FeedUpdated(symbols_[i], prices_[i], timestamps_[i], roundIds_[i]);
        }
    }

    function getLatest(string calldata symbol)
        external
        view
        returns (uint256 price, uint256 timestamp, uint256 roundId, bool exists)
    {
        Feed storage f = _feeds[keccak256(bytes(symbol))];
        return (f.price, f.timestamp, f.roundId, f.exists);
    }

    function decimals() external pure returns (uint8) {
        return DECIMALS;
    }

    function symbolCount() external view returns (uint256) {
        return _symbols.length;
    }

    function symbolAt(uint256 index) external view returns (string memory) {
        return _symbols[index];
    }
}
