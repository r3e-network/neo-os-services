// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MiniAppCreditsV2
/// @notice Fresh-state, Neo X MainNet-only GAS-backed Credits ledger.
/// @dev The pause blocks new purchases only. Settlement remains available so
/// accepted off-chain work can always advance to an on-chain checkpoint.
contract MiniAppCreditsV2 {
    uint256 public constant NEO_X_MAINNET_CHAIN_ID = 47_763;
    uint256 public constant CREDITS_PER_GAS = 100;
    uint256 public constant GAS_WEI_PER_CREDIT = 10 ** 16;
    uint256 public constant MAX_SETTLEMENT_BATCH = 500;
    uint256 public constant STATE_VERSION = 2;
    bool public constant IMPORTS_V1_BALANCES = false;

    string public constant BATCH_DOMAIN = "MiniAppCreditsV2:settlement:v1";

    address public owner;
    address public pendingOwner;
    address public settler;
    bool public paused;

    uint256 public currentEpoch;
    uint256 public lastSettlementAt;
    uint256 public lastSettledEventId;
    bytes32 public currentBatchRoot;
    uint256 public totalGasCollected;
    uint256 public totalSettledCredits;

    mapping(address => uint256) private _settledBalances;
    mapping(bytes32 => uint256) private _batchEpochByRoot;

    uint256 private _reentrancyStatus = 1;

    event CreditsPurchased(address indexed user, uint256 gasAmount, uint256 credits);
    event SettlementPosted(
        uint256 indexed epoch,
        bytes32 indexed batchRoot,
        uint256 windowStartExclusive,
        uint256 windowEndInclusive,
        uint256 userCount,
        uint256 totalRequested,
        uint256 totalDebited
    );
    event OwnerTransferStarted(address indexed previousOwner, address indexed pendingOwner);
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);
    event SettlerChanged(address indexed previousSettler, address indexed newSettler);
    event PausedChanged(bool paused);
    event SurplusGasRescued(address indexed recipient, uint256 amount);

    error WrongChain(uint256 actualChainId);
    error NotOwner();
    error NotPendingOwner();
    error NotOperator();
    error ZeroAddress();
    error ContractPaused();
    error Reentrancy();
    error InvalidAmount();
    error NonIntegralPayment();
    error InvalidEpoch();
    error InvalidWindow();
    error InvalidBatchSize();
    error LengthMismatch();
    error InvalidUser();
    error UsersNotStrictlySorted();
    error InvalidDelta();
    error BatchRootMismatch();
    error BatchRootAlreadyUsed();
    error InsufficientBacking();
    error NativeTransferFailed();

    modifier onlyMainnet() {
        if (block.chainid != NEO_X_MAINNET_CHAIN_ID) {
            revert WrongChain(block.chainid);
        }
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != settler && msg.sender != owner) revert NotOperator();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    modifier nonReentrant() {
        if (_reentrancyStatus != 1) revert Reentrancy();
        _reentrancyStatus = 2;
        _;
        _reentrancyStatus = 1;
    }

    constructor(address initialSettler) onlyMainnet {
        if (initialSettler == address(0)) revert ZeroAddress();
        owner = msg.sender;
        settler = initialSettler;
        emit OwnerChanged(address(0), msg.sender);
        emit SettlerChanged(address(0), initialSettler);
    }

    /// @notice Purchase Credits with Neo X native GAS.
    /// @dev Exact multiples prevent ambiguous dust accounting across the
    /// contract event, off-chain indexer, and backing liability.
    function buyCredits() external payable onlyMainnet whenNotPaused returns (uint256 credits) {
        if (msg.value < GAS_WEI_PER_CREDIT) revert InvalidAmount();
        if (msg.value % GAS_WEI_PER_CREDIT != 0) revert NonIntegralPayment();

        credits = msg.value / GAS_WEI_PER_CREDIT;
        _settledBalances[msg.sender] += credits;
        totalSettledCredits += credits;
        totalGasCollected += msg.value;
        emit CreditsPurchased(msg.sender, msg.value, credits);
    }

    function settledBalanceOf(address user) external view returns (uint256) {
        return _settledBalances[user];
    }

    function heldGas() external view returns (uint256) {
        return address(this).balance;
    }

    function backingLiabilityGas() public view returns (uint256) {
        return totalSettledCredits * GAS_WEI_PER_CREDIT;
    }

    function surplusGas() public view returns (uint256) {
        uint256 liability = backingLiabilityGas();
        uint256 held = address(this).balance;
        return held > liability ? held - liability : 0;
    }

    function creditsForGas(uint256 gasAmount) external pure returns (uint256) {
        return gasAmount / GAS_WEI_PER_CREDIT;
    }

    function creditsPerGas() external pure returns (uint256) {
        return CREDITS_PER_GAS;
    }

    function gasPerCredit() external pure returns (uint256) {
        return GAS_WEI_PER_CREDIT;
    }

    function stateVersion() external pure returns (uint256) {
        return STATE_VERSION;
    }

    function importsV1Balances() external pure returns (bool) {
        return IMPORTS_V1_BALANCES;
    }

    function chainId() external pure returns (uint256) {
        return NEO_X_MAINNET_CHAIN_ID;
    }

    function isBatchRootUsed(bytes32 batchRoot) external view returns (bool) {
        return _batchEpochByRoot[batchRoot] != 0;
    }

    function batchEpochForRoot(bytes32 batchRoot) external view returns (uint256) {
        return _batchEpochByRoot[batchRoot];
    }

    /// @notice Canonical Neo X settlement commitment. The field order matches
    /// the N3 V2 batch domain even though each VM has its own ABI encoding.
    function computeBatchRoot(
        uint256 epoch,
        uint256 windowStartExclusive,
        uint256 windowEndInclusive,
        address[] calldata users,
        int256[] calldata deltas
    ) public view onlyMainnet returns (bytes32) {
        _validateBatchDefinition(epoch, windowStartExclusive, windowEndInclusive, users, deltas);
        return sha256(
            abi.encode(
                BATCH_DOMAIN,
                NEO_X_MAINNET_CHAIN_ID,
                address(this),
                epoch,
                windowStartExclusive,
                windowEndInclusive,
                users,
                deltas
            )
        );
    }

    function postSettlement(
        uint256 epoch,
        uint256 windowStartExclusive,
        uint256 windowEndInclusive,
        address[] calldata users,
        int256[] calldata deltas,
        bytes32 batchRoot
    ) external onlyMainnet onlyOperator returns (uint256 totalDebited) {
        if (batchRoot == bytes32(0)) revert BatchRootMismatch();
        if (_batchEpochByRoot[batchRoot] != 0) revert BatchRootAlreadyUsed();
        if (epoch != currentEpoch + 1) revert InvalidEpoch();
        if (windowStartExclusive != lastSettledEventId) revert InvalidWindow();

        bytes32 expected = computeBatchRoot(epoch, windowStartExclusive, windowEndInclusive, users, deltas);
        if (expected != batchRoot) revert BatchRootMismatch();

        uint256 totalRequested;
        for (uint256 i = 0; i < users.length; ++i) {
            uint256 spend = uint256(-deltas[i]);
            totalRequested += spend;

            uint256 balance = _settledBalances[users[i]];
            uint256 debit = balance < spend ? balance : spend;
            if (debit == 0) continue;
            _settledBalances[users[i]] = balance - debit;
            totalDebited += debit;
        }

        totalSettledCredits -= totalDebited;
        currentEpoch = epoch;
        lastSettledEventId = windowEndInclusive;
        lastSettlementAt = block.timestamp;
        currentBatchRoot = batchRoot;
        _batchEpochByRoot[batchRoot] = epoch;

        emit SettlementPosted(
            epoch, batchRoot, windowStartExclusive, windowEndInclusive, users.length, totalRequested, totalDebited
        );
    }

    function proposeOwner(address nextOwner) external onlyMainnet onlyOwner {
        if (nextOwner == address(0)) revert ZeroAddress();
        pendingOwner = nextOwner;
        emit OwnerTransferStarted(owner, nextOwner);
    }

    function acceptOwner() external onlyMainnet {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address previous = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnerChanged(previous, msg.sender);
    }

    function setSettler(address nextSettler) external onlyMainnet onlyOwner {
        if (nextSettler == address(0)) revert ZeroAddress();
        address previous = settler;
        settler = nextSettler;
        emit SettlerChanged(previous, nextSettler);
    }

    function setPaused(bool nextPaused) external onlyMainnet onlyOwner {
        paused = nextPaused;
        emit PausedChanged(nextPaused);
    }

    /// @notice Rescue only GAS above the full backing required by all unsettled
    /// Credits. V2 deliberately exposes no user redemption or refund route.
    function rescueSurplusGas(address payable recipient, uint256 amount) external onlyMainnet onlyOwner nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidAmount();
        if (amount > surplusGas()) revert InsufficientBacking();

        (bool sent,) = recipient.call{value: amount}("");
        if (!sent) revert NativeTransferFailed();
        emit SurplusGasRescued(recipient, amount);
    }

    function _validateBatchDefinition(
        uint256 epoch,
        uint256 windowStartExclusive,
        uint256 windowEndInclusive,
        address[] calldata users,
        int256[] calldata deltas
    ) private pure {
        if (epoch == 0) revert InvalidEpoch();
        if (windowEndInclusive <= windowStartExclusive) revert InvalidWindow();
        if (users.length == 0 || users.length > MAX_SETTLEMENT_BATCH) {
            revert InvalidBatchSize();
        }
        if (users.length != deltas.length) revert LengthMismatch();

        address previous;
        for (uint256 i = 0; i < users.length; ++i) {
            address user = users[i];
            if (user == address(0)) revert InvalidUser();
            if (i != 0 && uint160(user) <= uint160(previous)) {
                revert UsersNotStrictlySorted();
            }
            if (deltas[i] >= 0 || deltas[i] == type(int256).min) {
                revert InvalidDelta();
            }
            previous = user;
        }
    }
}
