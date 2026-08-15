// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IMorpheusOracleEVM} from "./IMorpheusOracleEVM.sol";
import {Owned} from "./Owned.sol";

/// @title MiniAppMessageEVM
/// @notice Encrypted + optionally time-locked messages on Neo X, settled by the
/// Morpheus confidential-compute (TEE) oracle.
///
/// Both modes store an X25519-HKDF-SHA256-AES-256-GCM envelope (sealed to the
/// oracle's public key) on-chain:
///  - Recipient-only (unlockTime == 0): the bound recipient reads the plaintext
///    off-chain by authenticating to the oracle (the enclave decrypts and only
///    releases to a wallet that proves it is the recipient). The chain holds only
///    ciphertext + the recipient binding for inbox discovery.
///  - Time-locked (unlockTime > 0): the plaintext is NOT revealable before
///    unlockTime. After it, anyone may call requestReveal(); the oracle decrypts
///    the envelope in the enclave and posts the plaintext on-chain via
///    onOracleResult, making it public from that moment on.
contract MiniAppMessageEVM is Owned {
    address public oracle;
    uint256 public maxEnvelopeBytes = 8192;

    struct Message {
        address sender;
        address recipient; // bound recipient (recipient-only); may be 0 for public time-locked drops
        bytes envelope; // sealed ciphertext (to the oracle X25519 key)
        uint64 unlockTime; // 0 = recipient-only; >0 = time-locked reveal allowed after this ts
        uint64 sentAt;
        bool revealed; // time-locked plaintext posted on-chain
        string plaintext; // populated only on time-locked reveal
    }

    mapping(uint256 => Message) private messages;
    uint256 public totalMessages;
    mapping(address => uint256[]) private inbox; // recipient => message ids
    mapping(address => uint256[]) private outbox; // sender => message ids
    mapping(uint256 => uint256) public revealRequestId; // messageId => in-flight oracle requestId
    mapping(uint256 => uint256) private revealReqToMsg; // oracle requestId => messageId

    event MessageSent(uint256 indexed id, address indexed sender, address indexed recipient, uint64 unlockTime, bool timeLocked);
    event RevealRequested(uint256 indexed id, uint256 indexed requestId, address indexed by);
    event MessageRevealed(uint256 indexed id, string plaintext);
    event OracleChanged(address indexed previous, address indexed next);

    error OnlyOracle();
    error BadEnvelope();
    error UnknownMessage();
    error NotTimeLocked();
    error StillLocked();
    error AlreadyRevealed();
    error RevealPending();

    constructor(address oracle_) {
        if (oracle_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        oracle = oracle_;
    }

    /// @notice Store a sealed message. `unlockTime == 0` = recipient-only (read via
    /// the oracle off-chain). `unlockTime > 0` = time-locked public reveal.
    function sendMessage(address recipient, bytes calldata envelope, uint64 unlockTime) external returns (uint256 id) {
        if (envelope.length == 0 || envelope.length > maxEnvelopeBytes) revert BadEnvelope();
        id = ++totalMessages;
        Message storage m = messages[id];
        m.sender = msg.sender;
        m.recipient = recipient;
        m.envelope = envelope;
        m.unlockTime = unlockTime;
        m.sentAt = uint64(block.timestamp);
        if (recipient != address(0)) inbox[recipient].push(id);
        outbox[msg.sender].push(id);
        emit MessageSent(id, msg.sender, recipient, unlockTime, unlockTime > 0);
    }

    /// @notice Permissionless: after unlockTime, ask the oracle to decrypt + reveal a
    /// time-locked message's plaintext on-chain. Cannot reveal before unlockTime.
    function requestReveal(uint256 id) external returns (uint256 reqId) {
        Message storage m = messages[id];
        if (m.sender == address(0)) revert UnknownMessage();
        if (m.unlockTime == 0) revert NotTimeLocked();
        if (block.timestamp < m.unlockTime) revert StillLocked();
        if (m.revealed) revert AlreadyRevealed();
        if (revealRequestId[id] != 0) revert RevealPending();
        reqId = IMorpheusOracleEVM(oracle).requestFromCallback(msg.sender, "decrypt", abi.encode(id, m.envelope));
        revealRequestId[id] = reqId;
        revealReqToMsg[reqId] = id;
        emit RevealRequested(id, reqId, msg.sender);
    }

    /// @notice Oracle callback (best-effort; must not revert the oracle): stores the
    /// decrypted plaintext for a time-locked reveal.
    function onOracleResult(uint256 requestId, string calldata, bool success, bytes calldata result, string calldata)
        external
    {
        if (msg.sender != oracle) revert OnlyOracle();
        uint256 id = revealReqToMsg[requestId];
        if (id == 0) return; // unknown / already cleared — never revert the oracle
        Message storage m = messages[id];
        delete revealRequestId[id];
        delete revealReqToMsg[requestId];
        if (m.revealed || !success) return;
        m.revealed = true;
        m.plaintext = string(result);
        emit MessageRevealed(id, m.plaintext);
    }

    // ── reads ────────────────────────────────────────────────────────────────
    function getMessage(uint256 id) external view returns (Message memory) { return messages[id]; }
    function inboxOf(address who) external view returns (uint256[] memory) { return inbox[who]; }
    function outboxOf(address who) external view returns (uint256[] memory) { return outbox[who]; }
    function inboxCount(address who) external view returns (uint256) { return inbox[who].length; }

    // ── admin ──────────────────────────────────────────────────────────────
    function setOracle(address next) external onlyOwner { if (next == address(0)) revert ZeroAddress(); emit OracleChanged(oracle, next); oracle = next; }
    function setMaxEnvelopeBytes(uint256 n) external onlyOwner { require(n >= 256 && n <= 65536, "range"); maxEnvelopeBytes = n; }
}
