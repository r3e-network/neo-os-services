# Action-v4 callback compatibility

This slice adds callback encoding and deployment-network assertions only. It does not issue action-v4 tickets, install a trusted authorization reader, advance the DID vendor pin, or enable production measurement gates.

The compact callback is UTF-8 `4|base64(master32)|epoch|base64(action32)|base64(signature64)`. Its four fields must be strings: exact unpadded 32-byte hexadecimal master/action and 64-byte hexadecimal signature (an optional 0x prefix is accepted), plus a canonical positive decimal epoch within the Neo signed 256-bit integer range. Invalid fields fail instead of falling back to JSON. Existing v1/v2/v3 encoders and generic routes retain their byte behavior.

For action-v4 only, the AA network is opaque signed text. It does not select a deployment or storage namespace. The already-selected mainnet/testnet context controls the read; every supplied deployment alias must agree. This does not enable encrypted-ref claims in the native host, whose existing 503 remains.

The owning JavaScript pure-function checks are `node --test scripts/neodid-action-v4-compatibility.test.mjs`; corresponding native codec/network tests require a later allocated Rust qualification. Real issuance still requires a server-owned same-state core/verifier reader and independently verified deployment/enrollment state.
