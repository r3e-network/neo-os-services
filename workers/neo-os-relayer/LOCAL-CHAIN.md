# Local-chain development seam

The Rust relayer supports a private N3 chain only when `MORPHEUS_LOCAL_CHAIN`
is exactly `true`. It is disabled by default. Production mode and non-testnet
profiles are refused before I/O. The chain must use testnet magic `894710606`.

Set these environment variables for a local request-delivery process:

```sh
NODE_ENV=test
MORPHEUS_NETWORK=testnet
MORPHEUS_LOCAL_CHAIN=true
MORPHEUS_LOCAL_CHAIN_RPC_URLS=http://127.0.0.1:23456
MORPHEUS_RELAYER_MODE=requests_only
MORPHEUS_RELAYER_NEO_N3_SCAN_MODE=block_cursor
MORPHEUS_RELAYER_ALLOW_RUNTIME_FALLBACKS=false
MORPHEUS_RUNTIME_URL=http://127.0.0.1:23457
SIGNER_SERVICE_URL=http://127.0.0.1:23458
```

RPC URLs replace the public defaults completely. All configured RPC and service
URLs must use literal loopback IPs; DNS names, remote hosts, mixed fallback lists,
URL credentials and fragments are refused. Local RPC calls do not follow redirects
or use proxies. Only N3 request mode with block scanning is supported. Existing
custody and fulfillment requirements still apply; this flag does not override the
measured contract or enable a private-key signer.

Run `python3 scripts/test-relayer-local-chain.py` from the repository root with
NeoGo 0.121.0 and Rust installed. The test creates and deletes a private chain,
a fresh disposable validator wallet and a signed transaction. The relayer resumes
that transaction from a journal, submits it, observes HALT and scans the chain.
Preparation of the signed journal is the SIGN/host stand-in; this is not the full
kernel/host/custody fulfillment harness. The test also supplies unusable proxy
settings to prove the local RPC path does not use them. Its nodes bind loopback,
have no seeds, and use temporary state. CI runs the same test explicitly; the
ordinary Rust suite reports this environment-dependent test as ignored.
