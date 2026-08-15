// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IMorpheusOracleEVM} from "./IMorpheusOracleEVM.sol";
import {Owned} from "./Owned.sol";

/// @title MiniAppDiceGameEVM
/// @notice Neo X (EVM) dice game settled by Morpheus VRF. A player stakes GAS and
/// picks a face [1..6]; the contract requests verifiable randomness from the
/// MorpheusOracleEVM kernel and settles in onOracleResult: a win pays 5.7x the
/// stake (the house edge: fair 6x * 0.95) from the house bankroll, a loss keeps
/// the stake, and a VRF failure refunds the stake. Mirrors the Neo N3 dice flow.
contract MiniAppDiceGameEVM is Owned {
    address public oracle;

    // 5.7x payout on win = 57/10 (fair 6x for 1/6 odds, minus the 5% house edge).
    uint256 public constant PAYOUT_NUM = 57;
    uint256 public constant PAYOUT_DEN = 10;
    uint256 public minStake = 0.05 ether; // 0.05 GAS (18 decimals)
    uint256 public maxStake = 20 ether; //  20 GAS

    // Total max-payout reserved against still-pending bets, so the bankroll can
    // always cover every outstanding bet's win.
    uint256 public reserved;
    // Pull-payment fallback if a push transfer fails (never blocks settlement).
    mapping(address => uint256) public pendingWithdrawals;
    uint256 public totalPending; // sum of pendingWithdrawals, kept out of available bankroll

    enum Status { None, Pending, Won, Lost, Refunded }

    struct Bet {
        address player;
        uint256 stake;
        uint8 face;
        uint8 rolled;
        Status status;
        uint64 placedAt;
    }

    mapping(uint256 => Bet) public bets; // oracle requestId => bet
    uint256 public totalBets;
    uint256 public totalWon;

    event DiceBetPlaced(uint256 indexed requestId, address indexed player, uint8 face, uint256 stake);
    event DiceSettled(uint256 indexed requestId, address indexed player, uint8 face, uint8 rolled, bool won, uint256 payout);
    event BankrollFunded(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event OracleChanged(address indexed previous, address indexed next);

    error OnlyOracle();
    error BadFace();
    error BadStake();
    error InsufficientBankroll();
    error UnknownBet();

    constructor(address oracle_) {
        if (oracle_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        oracle = oracle_;
    }

    // ── house bankroll ───────────────────────────────────────────────────────
    receive() external payable { emit BankrollFunded(msg.sender, msg.value); }
    function fundBankroll() external payable { emit BankrollFunded(msg.sender, msg.value); }

    /// @notice Free bankroll = balance not reserved against pending bets / pending withdrawals.
    function availableBankroll() public view returns (uint256) {
        uint256 bal = address(this).balance;
        uint256 locked = reserved + totalPending; // pending bets + undelivered payouts
        return bal > locked ? bal - locked : 0;
    }

    // ── play ─────────────────────────────────────────────────────────────────
    function placeBet(uint8 face) external payable returns (uint256 requestId) {
        if (face < 1 || face > 6) revert BadFace();
        if (msg.value < minStake || msg.value > maxStake) revert BadStake();
        uint256 payout = (msg.value * PAYOUT_NUM) / PAYOUT_DEN;
        // balance already includes msg.value; ensure it covers all reservations + this payout.
        if (address(this).balance < reserved + payout) revert InsufficientBankroll();

        requestId = IMorpheusOracleEVM(oracle).requestFromCallback(
            msg.sender,
            "random.generate",
            abi.encode(face)
        );
        bets[requestId] = Bet({
            player: msg.sender, stake: msg.value, face: face, rolled: 0,
            status: Status.Pending, placedAt: uint64(block.timestamp)
        });
        reserved += payout;
        totalBets += 1;
        emit DiceBetPlaced(requestId, msg.sender, face, msg.value);
    }

    /// @notice Oracle callback. MUST NOT revert the oracle (the kernel calls it
    /// best-effort); failed transfers fall back to pendingWithdrawals.
    function onOracleResult(uint256 requestId, string calldata, bool success, bytes calldata result, string calldata)
        external
    {
        if (msg.sender != oracle) revert OnlyOracle();
        _settle(requestId, success, result);
    }

    /// @notice Permissionless recovery: if a bet's oracle callback failed to run
    /// (e.g. the kernel's best-effort `.call` ran out of gas) but the kernel
    /// request is fulfilled, anyone can finalize the bet from the kernel's stored
    /// result. Makes stuck bets self-healing and trustless.
    function settleFromKernel(uint256 requestId) external {
        IMorpheusOracleEVM.Request memory r = IMorpheusOracleEVM(oracle).getRequest(requestId);
        // Succeeded(2) or Failed(3) == terminal/fulfilled (Pending(1) and None(0) are not).
        require(
            r.status == IMorpheusOracleEVM.Status.Succeeded || r.status == IMorpheusOracleEVM.Status.Failed,
            "kernel request not fulfilled"
        );
        _settle(requestId, r.status == IMorpheusOracleEVM.Status.Succeeded, r.result);
    }

    function _settle(uint256 requestId, bool success, bytes memory result) internal {
        Bet storage b = bets[requestId];
        if (b.player == address(0) || b.status != Status.Pending) revert UnknownBet();

        uint256 payout = (b.stake * PAYOUT_NUM) / PAYOUT_DEN;
        reserved -= payout; // release the reservation

        if (!success) {
            b.status = Status.Refunded;
            _pay(b.player, b.stake);
            emit DiceSettled(requestId, b.player, b.face, 0, false, b.stake);
            return;
        }

        uint8 rolled = uint8(uint256(keccak256(result)) % 6) + 1;
        b.rolled = rolled;
        if (rolled == b.face) {
            b.status = Status.Won;
            totalWon += 1;
            _pay(b.player, payout);
            emit DiceSettled(requestId, b.player, b.face, rolled, true, payout);
        } else {
            b.status = Status.Lost; // house keeps the stake
            emit DiceSettled(requestId, b.player, b.face, rolled, false, 0);
        }
    }

    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) { pendingWithdrawals[to] += amount; totalPending += amount; } // pull fallback; never revert settlement
    }

    /// @notice Claim any payout that a push transfer couldn't deliver.
    function claim() external {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "nothing to claim");
        pendingWithdrawals[msg.sender] = 0;
        totalPending -= amount;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "claim transfer failed");
        emit Withdrawn(msg.sender, amount);
    }

    function getBet(uint256 requestId) external view returns (Bet memory) { return bets[requestId]; }

    // ── admin ──────────────────────────────────────────────────────────────
    function setOracle(address next) external onlyOwner { if (next == address(0)) revert ZeroAddress(); emit OracleChanged(oracle, next); oracle = next; }
    function setStakeLimits(uint256 min_, uint256 max_) external onlyOwner { require(min_ > 0 && max_ >= min_, "limits"); minStake = min_; maxStake = max_; }
    function withdrawBankroll(uint256 amount, address payable to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        require(amount <= availableBankroll(), "exceeds available");
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "withdraw failed");
        emit Withdrawn(to, amount);
    }
}
