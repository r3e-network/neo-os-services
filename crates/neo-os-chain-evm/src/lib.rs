//! neo-os-chain-evm — NeoX EVM chain adapter.
//!
//! Ported from `workers/morpheus-relayer/src/neox.js`:
//! - [`abi`] — minimal ABI codec (uint256/address/bool/bytes32/bytes/string +
//!   tuple decode), vector-locked against ethers goldens
//! - [`rpc`] — EVM JSON-RPC failover with transport-vs-deterministic error
//!   classification
//! - [`fulfill`] — the vector-locked fulfillment digest and verifier recovery,
//!   confidential-envelope decoders, revert normalization, and the getRequest
//!   event shape
//! - [`custody`] / [`tx`] — authenticated custody calls plus strict EIP-1559
//!   construction, decoding, sender recovery, and transaction hashing
//!
//! Private-key signing is deliberately absent: production signatures are
//! custody/enclave-only, while this crate independently rebuilds and verifies
//! every digest and signed transaction returned across that boundary.

pub mod abi;
pub mod custody;
pub mod fulfill;
pub mod rpc;
pub mod scan;
pub mod tx;

/// The one wire primitive the RPC and indexer adapters share: a blocking
/// JSON-over-HTTP request/response pair. Errors are transport failures as
/// strings — status codes and bodies travel in the reply.
pub trait HttpTransport: Send + Sync {
    fn post(&self, url: &str, body: &str) -> Result<(u16, String), String>;
    fn get(&self, url: &str) -> Result<(u16, String), String>;

    fn post_with_bearer(
        &self,
        _url: &str,
        _token: &str,
        _timeout_ms: u64,
        _body: &str,
    ) -> Result<(u16, String), String> {
        Err("HTTP transport does not support authenticated requests".to_string())
    }

    fn get_with_bearer(
        &self,
        _url: &str,
        _token: &str,
        _timeout_ms: u64,
    ) -> Result<(u16, String), String> {
        Err("HTTP transport does not support authenticated requests".to_string())
    }
}

/// Shared references are transports too, so tests can borrow a scripted
/// transport while production owns one.
impl<T: HttpTransport + ?Sized> HttpTransport for &T {
    fn post(&self, url: &str, body: &str) -> Result<(u16, String), String> {
        (**self).post(url, body)
    }
    fn get(&self, url: &str) -> Result<(u16, String), String> {
        (**self).get(url)
    }

    fn post_with_bearer(
        &self,
        url: &str,
        token: &str,
        timeout_ms: u64,
        body: &str,
    ) -> Result<(u16, String), String> {
        (**self).post_with_bearer(url, token, timeout_ms, body)
    }

    fn get_with_bearer(
        &self,
        url: &str,
        token: &str,
        timeout_ms: u64,
    ) -> Result<(u16, String), String> {
        (**self).get_with_bearer(url, token, timeout_ms)
    }
}

pub use abi::{abi_decode_uint256_bytes, abi_encode, AbiError, AbiValue};
pub use custody::{EvmCustodyClient, EvmCustodyIdentity, EvmCustodySettings, EvmSignedTransaction};
pub use fulfill::{
    build_neox_digest, decode_confidential_envelope, decode_confidential_message_id,
    decode_payload, eip191_message_hash, encode_fulfill_request_calldata,
    is_confidential_decrypt_operation, keccak256, normalize_neox_revert, recover_eip191_address,
    resolve_result_bytes_hex, Fulfillment, FulfillmentSigner, STATUS_PENDING,
};
pub use rpc::{
    parse_hex_quantity, EvmReceipt, EvmRpcClient, EvmWaiter, NeoXCallError, SystemEvmWaiter,
};
pub use scan::{build_event_from_request, NeoXEvent};
pub use tx::{decode_signed_eip1559, SignedEip1559, UnsignedEip1559};
