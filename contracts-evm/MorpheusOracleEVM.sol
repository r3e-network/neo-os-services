// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IMorpheusOracleEVM} from "./IMorpheusOracleEVM.sol";
import {Updatable} from "./Updatable.sol";

/// @title MorpheusOracleEVM
/// @notice EVM (Neo X) oracle kernel mirroring the Neo N3 MorpheusOracle request
/// lifecycle: miniapps (or their callback contracts) submit requests; an off-chain
/// relayer does the work and fulfils them. The fulfilment result is bound to the
/// request + this deployment by an oracle_verifier secp256k1 signature (ecrecover),
/// and the relayer's `updater` address sends the fulfil tx (gas + witness).
///
/// @dev Parity hardening for the next (bytecode-frozen) deployment — see README
/// "Next-deployment notes". This revision closes the gaps with the N3 kernel:
///  - Callback uniqueness (OR-D-03): a callback contract maps to at most one app.
///  - Exact-fee / no-strand: `_submit` accrues exactly `requestFee` and refunds the
///    remainder of `msg.value` to the requester (checks-effects-interactions).
///  - Request TTL + expiry + refund: `expireStaleRequest` mirrors N3
///    `ExpireStaleRequest` — after TTL on an un-fulfilled request it marks the
///    request Failed, refunds the exact fee paid to the original fee payer, and
///    emits `RequestExpired`.
///  - Reserved-fee invariant: fees backing still-pending requests are reserved and
///    excluded from the owner withdraw path (`withdrawableFees() = accrued - reserved`),
///    mirroring N3 `WithdrawableFees` / `ReservedRequestFees`.
///  - Owner-change events: `setOwner` emits `OwnerChanged`.
///
/// @dev Sponsorship gating (N3 `IsSponsorshipGated` / allowlist / per-requester cap)
/// is intentionally NOT mirrored here. N3 sponsorship gates which *prepaid credit
/// balance* (sponsor vs requester) is debited; the EVM kernel has no prepaid-credit /
/// fee-payer model — the payer is always whoever sends `msg.value` on the request tx.
/// Mirroring it would require importing the entire N3 credit/sponsor accounting model,
/// a separate initiative. Documented as a follow-up rather than half-implemented.
contract MorpheusOracleEVM is IMorpheusOracleEVM, Updatable {
    address public oracleVerifier; // ecrecover target for the result signature

    uint256 public requestFee;     // wei charged per request (0 = free)
    uint256 public accruedFees;    // total fees accrued (earned + still-reserved)
    /// @notice Portion of accruedFees backing still-pending requests, held as
    /// potential expiry refunds. Invariant: accruedFees >= reservedFees always.
    /// Only the surplus (accrued - reserved) is owner-withdrawable.
    uint256 public reservedFees;
    uint256 private _nextRequestId = 1;

    /// @notice Default request TTL in seconds (1 hour). After it elapses on an
    /// un-fulfilled request, anyone-authorized can expire it and refund the fee.
    /// Mirrors N3 DEFAULT_REQUEST_TTL (expressed there in milliseconds).
    uint256 public constant DEFAULT_REQUEST_TTL = 1 hours;
    uint256 public requestTTL = DEFAULT_REQUEST_TTL; // seconds; owner-settable

    // `Status` enum and `Request` struct are inherited from IMorpheusOracleEVM so the
    // kernel and every consumer share one positional layout (drift = compile error).

    struct MiniApp { address admin; address callbackContract; bool active; bool exists; }

    mapping(uint256 => Request) private _requests;
    mapping(bytes32 => bool) private _modules;            // keccak(moduleId) => registered+active
    mapping(string => MiniApp) private _apps;             // appId => app
    mapping(address => string) private _appByCallback;    // callback contract => appId
    mapping(address => address) public approvedCallbackAdmin; // callback => approved app admin
    mapping(bytes32 => bool) private _grant;              // keccak(appId|moduleId) => granted

    event ModuleRegistered(string moduleId);
    event ModuleActiveChanged(string moduleId, bool active);
    event MiniAppRegistered(string appId, address admin, address callbackContract);
    event CallbackAdminApproved(address indexed callbackContract, address indexed admin);
    event AppActiveChanged(string appId, bool active);
    event ModuleGranted(string appId, string moduleId);
    event RequestQueued(uint256 indexed requestId, string appId, string moduleId, string operation, address requester, address callbackContract, bytes payload);
    event RequestFulfilled(uint256 indexed requestId, bool success, bytes result, string errorMessage);
    event RequestExpired(uint256 indexed requestId, string appId, address requester, address feePayer, uint256 refundAmount);
    event RequestTTLChanged(uint256 previous, uint256 next);
    event FeeRefunded(uint256 indexed requestId, address indexed to, uint256 amount);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event RequestFeeChanged(uint256 previous, uint256 next);
    event OracleVerifierChanged(address indexed previous, address indexed next);

    error NotAppAdmin();
    error UnknownModule();
    error ModuleNotGranted();
    error AppInactive();
    error AppExists();
    error AppNotFound();
    error RequestNotPending();
    error RequestNotFound();
    error NotExpired();
    error NotAuthorized();
    error BadSignature();
    error FeeNotPaid();
    error OnlyCallbackContract();
    error CallbackAlreadyRegistered();
    error CallbackNotApproved();
    error InvalidAppId();
    error RefundFailed();
    error ExceedsWithdrawable();
    error InvalidTTL();

    constructor(address updater_, address oracleVerifier_) {
        owner = msg.sender;
        updater = updater_ == address(0) ? msg.sender : updater_;
        oracleVerifier = oracleVerifier_ == address(0) ? msg.sender : oracleVerifier_;
        emit OwnerChanged(address(0), msg.sender);
        emit UpdaterChanged(address(0), updater);
        emit OracleVerifierChanged(address(0), oracleVerifier);
    }

    // ── admin ──────────────────────────────────────────────────────────────
    function setOracleVerifier(address next) external onlyOwner { if (next == address(0)) revert ZeroAddress(); emit OracleVerifierChanged(oracleVerifier, next); oracleVerifier = next; }
    function setRequestFee(uint256 amount) external onlyOwner { emit RequestFeeChanged(requestFee, amount); requestFee = amount; }

    /// @notice Set the request TTL (seconds). Mirrors N3 SetRequestTTL.
    function setRequestTTL(uint256 ttlSeconds) external onlyOwner {
        if (ttlSeconds == 0) revert InvalidTTL();
        emit RequestTTLChanged(requestTTL, ttlSeconds);
        requestTTL = ttlSeconds;
    }

    /// @notice Free surplus the owner may withdraw — accrued fees minus the portion
    /// reserved as expiry refunds for still-pending requests. Mirrors N3 WithdrawableFees.
    function withdrawableFees() public view returns (uint256) {
        return accruedFees > reservedFees ? accruedFees - reservedFees : 0;
    }

    /// @notice Withdraw earned (unreserved) fees. Capped at withdrawableFees so the
    /// owner can never take fees still owed as pending-request refunds (N3 invariant).
    function withdrawFees(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount > withdrawableFees()) revert ExceedsWithdrawable();
        accruedFees -= amount; // effects before interaction
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert RefundFailed();
        emit FeesWithdrawn(to, amount);
    }

    function registerModule(string calldata moduleId) external onlyOwner { _modules[keccak256(bytes(moduleId))] = true; emit ModuleRegistered(moduleId); }

    /// @notice Activate or deactivate a registered module. Deactivated modules
    /// block new request submissions (revert UnknownModule) until re-activated.
    function setModuleActive(string calldata moduleId, bool active) external onlyOwner {
        _modules[keccak256(bytes(moduleId))] = active;
        emit ModuleActiveChanged(moduleId, active);
    }

    /// @notice Activate or deactivate a registered miniapp. Inactive apps block
    /// new request submissions (revert AppInactive) until re-activated. Mirrors
    /// N3 ConfigureMiniApp's `active` flag.
    function setAppActive(string calldata appId, bool active) external onlyOwner {
        if (!_apps[appId].exists) revert AppNotFound();
        _apps[appId].active = active;
        emit AppActiveChanged(appId, active);
    }

    /// @notice Bind this callback contract to the admin allowed to register it.
    /// The callback itself is msg.sender, so an unrelated account cannot reserve
    /// a deployed callback address. Passing address(0) revokes the approval.
    function approveCallbackAdmin(address admin) external {
        approvedCallbackAdmin[msg.sender] = admin;
        emit CallbackAdminApproved(msg.sender, admin);
    }

    /// @notice Register a miniapp. A callback contract may route to AT MOST ONE app:
    /// re-binding an already-mapped callback to a fresh appId is rejected so nobody
    /// can hijack an existing app's `requestFromCallback` path (OR-D-03 / N3 parity).
    function registerMiniApp(string calldata appId, address admin, address callbackContract) external {
        if (bytes(appId).length == 0) revert InvalidAppId();
        if (admin == address(0)) revert ZeroAddress();
        if (msg.sender != owner && msg.sender != admin) revert NotAppAdmin();
        if (_apps[appId].exists) revert AppExists();
        if (callbackContract != address(0)) {
            if (msg.sender != owner && approvedCallbackAdmin[callbackContract] != admin) {
                revert CallbackNotApproved();
            }
            // Uniqueness: reject if this callback already routes to a different app.
            // Allowing only the empty mapping (string-empty) blocks the last-write-wins takeover.
            if (bytes(_appByCallback[callbackContract]).length != 0) revert CallbackAlreadyRegistered();
            _appByCallback[callbackContract] = appId;
        }
        _apps[appId] = MiniApp({ admin: admin, callbackContract: callbackContract, active: true, exists: true });
        emit MiniAppRegistered(appId, admin, callbackContract);
    }

    function grantModule(string calldata appId, string calldata moduleId) external {
        MiniApp storage a = _apps[appId];
        if (!a.exists) revert AppNotFound();
        if (msg.sender != owner && msg.sender != a.admin) revert NotAppAdmin();
        if (!_modules[keccak256(bytes(moduleId))]) revert UnknownModule();
        _grant[_grantKey(appId, moduleId)] = true;
        emit ModuleGranted(appId, moduleId);
    }

    /// @dev Single source of truth for the (appId, moduleId) grant key. The literal
    /// "|" separator and argument order are consensus-critical — existing on-chain
    /// grants only resolve if this derivation stays byte-identical across the write
    /// (grantModule), check (_submit) and read (isModuleGranted) paths.
    function _grantKey(string memory appId, string memory moduleId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(appId, "|", moduleId));
    }

    // ── request ────────────────────────────────────────────────────────────
    function submitRequest(string calldata appId, string calldata moduleId, string calldata operation, bytes calldata payload)
        external payable returns (uint256)
    {
        return _submit(msg.sender, appId, moduleId, operation, payload);
    }

    /// @notice Contract-mediated submission: a registered app's callback contract
    /// submits on behalf of a requester (the dice-game pattern). The fee (if any) is
    /// charged from the callback contract's `msg.value` and refunded to it on expiry.
    function requestFromCallback(address requester, string calldata operation, bytes calldata payload)
        external payable override returns (uint256)
    {
        string memory appId = _appByCallback[msg.sender];
        MiniApp storage a = _apps[appId];
        if (!a.exists || a.callbackContract != msg.sender) revert OnlyCallbackContract();
        // moduleId == operation for the legacy callback path (relayer routes by operation)
        return _submit(requester, appId, operation, operation, payload);
    }

    function _submit(address requester, string memory appId, string memory moduleId, string memory operation, bytes memory payload)
        internal returns (uint256)
    {
        MiniApp storage a = _apps[appId];
        if (!a.exists) revert AppNotFound();
        if (!a.active) revert AppInactive();
        if (!_modules[keccak256(bytes(moduleId))]) revert UnknownModule();
        if (!_grant[_grantKey(appId, moduleId)]) revert ModuleNotGranted();

        uint256 fee = requestFee;
        if (msg.value < fee) revert FeeNotPaid();

        // No-strand: accrue + reserve exactly the fee; the remainder of msg.value
        // (overpayment, or all value while fee==0) is returned to msg.sender. State
        // is fully updated before the external refund (checks-effects-interactions),
        // and the refund recipient is msg.sender (the request submitter / callback
        // contract), not an attacker-chosen address.
        uint256 id = _nextRequestId++;
        if (fee > 0) {
            accruedFees += fee;
            reservedFees += fee; // backs this pending request's potential expiry refund
        }

        _requests[id] = Request({
            id: id, appId: appId, moduleId: moduleId, operation: operation, payload: payload,
            requester: requester, callbackContract: a.callbackContract, status: Status.Pending,
            createdAt: uint64(block.timestamp), fulfilledAt: 0, success: false, result: "", errorMessage: "",
            feePaid: fee, feePayer: msg.sender
        });
        emit RequestQueued(id, appId, moduleId, operation, requester, a.callbackContract, payload);

        uint256 overage = msg.value - fee;
        if (overage > 0) {
            (bool ok,) = payable(msg.sender).call{value: overage}("");
            if (!ok) revert RefundFailed();
        }
        return id;
    }

    /// @notice Digest the relayer's oracle_verifier signs (bound to this contract + chain).
    function fulfillmentDigest(uint256 requestId, bool success, bytes memory result, string memory error_) public view returns (bytes32) {
        return _fulfillmentDigest(_requests[requestId], requestId, success, result, error_);
    }

    /// @dev Internal overload that takes the already-bound storage pointer so the
    /// fulfillment hot path does not re-SLOAD appId/moduleId/operation it just read.
    /// The public view fn above (used by the relayer for off-chain pre-computation)
    /// delegates here, so both produce identical digests.
    function _fulfillmentDigest(Request storage r, uint256 requestId, bool success, bytes memory result, string memory error_) internal view returns (bytes32) {
        return keccak256(abi.encode(
            "morpheus-evm-fulfillment-v1", block.chainid, address(this),
            requestId, keccak256(bytes(r.appId)), keccak256(bytes(r.moduleId)), keccak256(bytes(r.operation)),
            success, keccak256(result), keccak256(bytes(error_))
        ));
    }

    function fulfillRequest(uint256 requestId, bool success, bytes calldata result, string calldata error_, bytes calldata signature)
        external onlyUpdater
    {
        Request storage r = _requests[requestId];
        if (r.status != Status.Pending) revert RequestNotPending();
        // verify the result is signed by the oracle verifier (ecrecover over the EIP-191 personal digest)
        bytes32 digest = _fulfillmentDigest(r, requestId, success, result, error_);
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        if (_recover(ethSigned, signature) != oracleVerifier) revert BadSignature();

        r.status = success ? Status.Succeeded : Status.Failed;
        r.fulfilledAt = uint64(block.timestamp);
        r.success = success;
        r.result = result;
        r.errorMessage = error_;

        // The request is no longer pending/refundable: the oracle earned the fee, so
        // release it from the reserved pool into the withdrawable surplus (N3 parity).
        _releaseReserved(r.feePaid);

        emit RequestFulfilled(requestId, success, result, error_);

        // best-effort callback (never reverts the fulfilment)
        if (r.callbackContract != address(0)) {
            bytes memory cd = abi.encodeWithSignature(
                "onOracleResult(uint256,string,bool,bytes,string)",
                requestId, r.operation, success, result, error_
            );
            (bool ok, ) = r.callbackContract.call(cd);
            ok; // ignored — inbox/result storage is canonical
        }
    }

    /// @notice Expire a stale pending request that has exceeded `requestTTL`. Marks it
    /// Failed, releases its reserved fee, refunds the exact fee paid to the original
    /// fee payer, and emits RequestExpired. Mirrors N3 ExpireStaleRequest.
    /// Authorization: owner or updater only (prevents griefing), matching N3.
    function expireStaleRequest(uint256 requestId) external {
        if (msg.sender != owner && msg.sender != updater) revert NotAuthorized();

        Request storage r = _requests[requestId];
        if (r.id == 0) revert RequestNotFound();
        if (r.status != Status.Pending) revert RequestNotPending();
        if (block.timestamp <= uint256(r.createdAt) + requestTTL) revert NotExpired();

        // effects: terminal state + ledger updates BEFORE the external refund
        r.status = Status.Failed;
        r.fulfilledAt = uint64(block.timestamp);
        r.success = false;
        r.errorMessage = "request expired: TTL exceeded";

        uint256 refund = r.feePaid;
        address payable to = payable(r.feePayer);

        // Release the reservation regardless of refund (request left the pending state).
        _releaseReserved(refund);
        // Clamp the refund to the fees still held, then debit accrued by the same amount
        // so the accrued/reserved ledgers stay symmetric (N3 keeps accrued >= reserved,
        // so refund == feePaid in normal operation; the clamp is purely defensive).
        if (refund > accruedFees) refund = accruedFees;
        if (refund > 0) {
            accruedFees -= refund;
        }

        emit RequestExpired(requestId, r.appId, r.requester, to, refund);

        // interaction last
        if (refund > 0 && to != address(0)) {
            (bool ok,) = to.call{value: refund}("");
            if (!ok) revert RefundFailed();
            emit FeeRefunded(requestId, to, refund);
        }
    }

    function _releaseReserved(uint256 amount) internal {
        if (amount == 0) return;
        reservedFees = reservedFees > amount ? reservedFees - amount : 0;
    }

    // ── reads ──────────────────────────────────────────────────────────────
    function getRequest(uint256 requestId) external view override returns (Request memory) { return _requests[requestId]; }
    function totalRequests() external view returns (uint256) { return _nextRequestId - 1; }
    function isModuleGranted(string calldata appId, string calldata moduleId) external view returns (bool) { return _grant[_grantKey(appId, moduleId)]; }
    function getMiniApp(string calldata appId) external view returns (MiniApp memory) { return _apps[appId]; }
    function appIdByCallback(address callbackContract) external view returns (string memory) { return _appByCallback[callbackContract]; }

    function _recover(bytes32 hash, bytes memory sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r; bytes32 s; uint8 v;
        assembly { r := mload(add(sig, 32)) s := mload(add(sig, 64)) v := byte(0, mload(add(sig, 96))) }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        return ecrecover(hash, v, r, s);
    }
}
