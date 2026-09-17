# N3 RPC response contract

## Purpose and interface

`NeoRpcClient::call(method, params) -> Result<Value, NeoRpcError>` must not treat an unrelated or incomplete JSON response as a successful RPC call. The public Rust API and request format remain unchanged.

For HTTP 200/201, the response must be an object with `jsonrpc: "2.0"`, numeric integer `id: 1` matching the current request, and exactly one of `result` or `error`. Any JSON value, including explicit null, is valid as a generic result; method-specific wrappers retain their own result validation. An error must be an object containing an integer `code` (a JSON integer token; float forms such as `-1.0` are rejected) and a string `message`; optional `data` is allowed.

Examples:

- `{"jsonrpc":"2.0","id":1,"result":null}` returns `Ok(Value::Null)`.
- `{"jsonrpc":"2.0","id":1}` fails with a response-contract error.
- `{"jsonrpc":"2.0","id":2,"result":123}` fails with a response-ID error.
- `{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}` fails with the node's error message.

## Failure and endpoint selection

Malformed envelopes, transport errors, unsuccessful HTTP responses and valid RPC errors follow the existing endpoint failover policy. Only a valid success envelope promotes an endpoint. If every endpoint fails, the last error is returned. Diagnostics identify the failing contract field without echoing the response body. HTTP error handling is unchanged.

## Security and performance

Validation prevents accepting missing results or mismatched response identifiers and prevents malformed responses from earning preferred endpoint status. It is not proof of network identity, chain finality or transaction confirmation. This change does not alter request IDs, transport limits, retry semantics or transaction submission policy. Validation uses constant-count field lookups on the already parsed response; result cloning is unchanged. No external I/O is added.

## Compatibility and deployment

Previously tolerated nonconforming responses now fail closed. Node/proxy implementations must return the documented envelope rather than requiring callers to disable validation. There is no database or configuration migration. Build and release downstream services through the existing pipeline; committing this source change is not a live deployment.

## Verification

Run `cargo test -p neo-os-chain-n3 --all-targets --locked` from the services repository. In-memory transport tests cover successful values, malformed success/error envelopes, legitimate RPC errors, failover and endpoint promotion. These tests do not contact a chain or broadcast a transaction.
