// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IMorpheusOracleEVM
/// @notice Shared ABI surface for the MorpheusOracleEVM kernel and its consumer
/// miniapps (dice game, message vault, …). The `Request` struct and `Status` enum
/// live here as the SINGLE source of truth.
///
/// @dev Solidity tuple ABI is positional: a consumer that hand-copies the request
/// layout decodes `getRequest()` by field *order*, so a field reorder/insert in the
/// kernel silently corrupts every consumer's decode. By defining the struct once
/// here and having the kernel `is IMorpheusOracleEVM` (and consumers tuple-decode
/// against this exact type), any drift becomes a compile error instead of a runtime
/// mis-decode. `Status` is an enum (ABI-encoded as uint8) so the on-chain tuple
/// layout is byte-identical to the previous hand-written `uint8 status` mirror.
interface IMorpheusOracleEVM {
    enum Status { None, Pending, Succeeded, Failed }

    struct Request {
        uint256 id;
        string appId;
        string moduleId;
        string operation;
        bytes payload;
        address requester;
        address callbackContract;
        Status status;
        uint64 createdAt;
        uint64 fulfilledAt;
        bool success;
        bytes result;
        string errorMessage;
        // Exact fee accrued+reserved for this request at submission, recorded so an
        // expiry refund returns precisely what was paid even if requestFee changed
        // in between. Mirrors N3 KernelRequest.FeePaid.
        uint256 feePaid;
        // Account the fee was charged from (the request submitter). On expiry the
        // refund is returned here. Mirrors N3 KernelRequest.Sponsor.
        address feePayer;
    }

    /// @notice Contract-mediated submission: a registered app's callback contract
    /// submits on behalf of a requester. The fee (if any) is charged from the
    /// callback contract's `msg.value` and refunded to it on expiry.
    function requestFromCallback(address requester, string calldata operation, bytes calldata payload)
        external
        payable
        returns (uint256);

    /// @notice Read the full stored request. Consumers tuple-decode this against the
    /// `Request` layout above.
    function getRequest(uint256 requestId) external view returns (Request memory);
}
