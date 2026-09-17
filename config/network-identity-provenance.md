# N3 identity provenance

The authority remains `config/networks/mainnet.json` and `testnet.json`. The
generated identity projection contains no endpoints, credentials, or contracts.
It must not be populated by asking the RPC endpoint that is being validated.

Both genesis values were independently calculated offline from NeoGo v0.122.0,
commit `6d7bd0c7d612c1e9eeaf08efbb8788efef5a449b`, on 2026-09-09. Mainnet also
matches that upstream's explicit genesis assertion. These are Neo RPC display
hashes (`0x` + `Hash().StringLE()`), not internal byte-order encodings.

| Network | Magic | Genesis |
|---|---:|---|
| mainnet | 860833102 | `0x1f4d1defa46faa5e7b9b8d3f79a06bec777d7c26c4aa5f6f5899a291daa87c15` |
| testnet | 894710606 | `0x9d3276785e7306daf59a3f3b9e31912c095598bbfb8a4476b821b0e59be4c57a` |

Primary sources:

- [Upstream mainnet genesis assertion](https://github.com/nspcc-dev/neo-go/blob/6d7bd0c7d612c1e9eeaf08efbb8788efef5a449b/pkg/core/util_test.go)
- [Genesis construction](https://github.com/nspcc-dev/neo-go/blob/6d7bd0c7d612c1e9eeaf08efbb8788efef5a449b/pkg/core/util.go)
- [Mainnet protocol configuration](https://github.com/nspcc-dev/neo-go/blob/6d7bd0c7d612c1e9eeaf08efbb8788efef5a449b/config/protocol.mainnet.yml)
- [Testnet protocol configuration](https://github.com/nspcc-dev/neo-go/blob/6d7bd0c7d612c1e9eeaf08efbb8788efef5a449b/config/protocol.testnet.yml)

Reproduce from an independently reviewed checkout of that exact commit:

```sh
git rev-parse HEAD
git diff --exit-code -- pkg/core/util.go config/protocol.mainnet.yml config/protocol.testnet.yml
GOTOOLCHAIN=go1.25.13 go run /absolute/path/to/neo-os-services/scripts/network-identity/derive-genesis.go
```

Audited file SHA-256:

```text
24d4a703a87c140897c0381a7b0e6e41cbbf488a52d5bc361e3a537f1064722d pkg/core/util.go
f3108d4ab2d4e9a789e3eaada38b57aef5228979187b9732f1c1b016f7d8cd1c pkg/core/util_test.go
dec4945d0b313b16662b02fc5cb472af79915afeeeee312fb8fcdce7044fa453 config/protocol.mainnet.yml
a7bb5cb1ded13c3294dde6ebee1e2e4a6ff819f61fcfbf1b37ef691dc5e2a70d config/protocol.testnet.yml
```

After reviewing a registry change, run `node scripts/export-network-identities.mjs
--write` from Services. `--check` verifies the Services generated JSON, Fura
embedded copy, and DevPack Shared JSON against the selected registry fields.
It also renders the fixed `NeoOS.Networks.NeoN3NetworkIdentity` C# constants in
Services and Native, and checks Native's `ProtocolConfiguration.Network` token.
All other Native protocol bytes remain Native-owned; duplicate/ambiguous keys
refuse every write before generation starts. The generator requires the declared
consumer repositories in the local composition. The workspace artifact
validator checks downstream copies. A testnet reset requires a newly reviewed
genesis source, deployment coordination and explicit historical-index handling;
do not automatically approve the new hash returned by an endpoint.

The exporter and Rust identity reader reject an all-zero genesis, matching
Fura's nonzero identity requirement. All declared consumer roots must already
exist as directories. The exporter checks all output paths and the Native
protocol input before its first write, rejects symbolic links along those
paths, and may create missing generated-file directories only inside an
existing repository. It never creates a missing sibling checkout. These local
checks do not require Git metadata, so isolated composition fixtures remain
valid. The invocation continues to use the declared sibling layout; external
Explorer/MCP copies are checked through the workspace artifact resolver.

This revision covers Neo N3 identity. NeoX chain ID checks remain in their
existing custody guard; NeoX genesis and chain identity are not newly attested.
