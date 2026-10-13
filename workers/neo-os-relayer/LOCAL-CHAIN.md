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

## Measured-contract override (tests only)

A kernel deployed fresh on a private chain has its own script hash, so the host's
compiled-in measured binding refuses every fulfilment against it. For tests, set
`MORPHEUS_TEST_MEASURED_ORACLE_CONTRACT_OVERRIDE` on the enclave host to that
kernel's 20-byte script hash, and point the relayer's `neo_n3.oracleContract` at the
same kernel:

```sh
MORPHEUS_TEST_MEASURED_ORACLE_CONTRACT_OVERRIDE=0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a
```

It is off unless set, and the host refuses it with 503 when `NODE_ENV` is
`production`, when the network is `mainnet`, or when the value is not a 20-byte hex
script hash. It replaces only which contract the host expects: the supplied contract
must still equal it and the network magic still comes from the reviewed identity
registry, so a request never chooses this value. It is image ENV only and is not in
the `/provision` allowlist, so an untrusted parent cannot set it at runtime. Remove
the variable to roll back; nothing is stored or migrated.

Run `python3 scripts/test-relayer-local-chain.py` from the repository root with
NeoGo 0.121.0 and Rust installed. The test creates and deletes a private chain,
a fresh disposable validator wallet and a signed transaction. The relayer resumes
that transaction from a journal, submits it, observes HALT and scans the chain.
Preparation of the signed journal is the SIGN/host stand-in; this is not the full
kernel/host/custody fulfillment harness. The test also supplies unusable proxy
settings to prove the local RPC path does not use them. Its nodes bind loopback,
have no seeds, and use temporary state. CI runs the same test explicitly; the
ordinary Rust suite reports this environment-dependent test as ignored.

For the host override's on-chain acceptance, install Neo Express 3.10.1, nccs
3.9.1, .NET 10 and Rust 1.98, then run `bash contracts/build.sh` followed by
`python3 scripts/test-host-private-chain.py`. The `host-private-chain` CI job
compiles the kernel with nccs and runs the same driver. The test deploys the unmodified kernel to a new
disposable private chain, queues a compute request, reads its fields from chain
storage, and feeds them to the real host fulfillment function with the override.
The compute bridge is disabled; hash computation runs in process. A fresh P-256
software signer substitutes for custody and a test document substitutes for NSM.
Neo Express's offline blocks and clock advancement mature the verifier timelock.
The kernel verifies the signature and stores the completed result; the harness
also checks corrupt-signature and duplicate-fulfillment rejection. Wallets and
chain data are deleted on exit. This does not exercise the relayer or production
custody/attestation transport.

## End-to-end: kernel, relayer, host and custody

`scripts/test-e2e-private-chain.mjs` is the composition of the two halves above,
with every stand-in removed. It runs one MiniApp request through the whole trust
path on a disposable private chain:

1. an unmodified `MorpheusOracle` kernel deploys to a fresh Neo Express chain;
2. a real `signer_service` custody vault is provisioned, the private-chain
   wallet is taken into it as the updater key, and the kernel's runtime
   verifier is pointed at the custody `oracle_verifier` key;
3. a request is queued on chain and a **corrupt signature is refused** while it
   is still pending — the verifier is live, not vacuous;
4. `neo-os-relayer once` discovers the request, delivers it to `enclave_host`,
   and the host signs its fulfillment digest through custody;
5. the relayer pins the returned key identity to the custody key it resolved and
   submits `fulfillRequest`, where the kernel **verifies the signature** and
   stores the result;
6. a second delivery of the settled request is **refused on chain** and leaves
   the stored request unchanged.

Run it from the repository root after building the kernel:

```sh
source scripts/dotnet_env.sh
node scripts/test-e2e-private-chain.mjs
```

It needs Rust 1.98, .NET 10, Neo Express 3.10.1 and nccs 3.9.1, and it builds
`signer_service`, `enclave_host` and `neo-os-relayer` itself. Every process
binds loopback; no public RPC, database, container or cloud account is used.
Chain state, wallet material and custody state live in a temporary directory
that is deleted on exit. The `e2e-private-chain` CI job runs the same command.

The measured-contract override above is what lets a freshly deployed kernel be
fulfilled at all, and the harness binds the same kernel hash into the host
override and the relayer's `neo_n3.oracleContract`, then reads the relayer's own
resolved configuration back and asserts the three agree. This proves the wiring
on a disposable chain; it says nothing about enclave measurement, KMS
provisioning or production topology.
