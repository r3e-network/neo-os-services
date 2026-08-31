# neo-signer

The Neo N3 signer service: key custody, per-key signing policy, caller
authentication and the audit trail.

Per `docs/SIGNER_SERVICE.md` (section 3), this repository owns the signer, and
`neo-nexus` is a consumer of it. This crate is that owner: the engine moved out
of `neo-nexus/src/signer/` plus its own SQLite store. It sits in `workers/`
beside the Node processes it is deployed with, and it is a plain cargo package on
purpose — **not** an npm workspace member. A `package.json` here would put it
back in the glob, and every aggregate `npm -ws` script would then treat a Rust
crate as a Node package. Nothing else keeps it out: `workers/*` matches this
directory, and npm skips it only because there is no manifest to read.

## What is here

| Module    | Role                                                                                  |
| --------- | ------------------------------------------------------------------------------------- |
| `crypto`  | P-256 signing, the `HASH160`/address derivations, AES-256-GCM sealing, NEP-2 import   |
| `tx`      | Decodes unsigned transactions and consensus payloads into policy-visible intents      |
| `policy`  | The pure decision function: does this boundary let this key sign this request         |
| `auth`    | Caller tokens, origin binding, constant-time digest comparison                        |
| `audit`   | Refusal vocabulary: what a caller may see vs. what the log keeps                      |
| `vault`   | Where the master key comes from (env credential or data-dir file)                     |
| `store`   | The five `signer_*` tables, their indexes, and the row mappers                        |
| `model`   | The stored types: keys, boundaries, callers, audit rows, and the `ScriptHash`         |
| `service` | `SignerService`: the signing path, the management surface, and the rows both write    |
| `network` | Chain identity and the network magic a key signs under                                |
| `api`     | The axum router: §5's caller routes, §5.1's management routes, and the refusal shapes |

`src/bin/signer_service.rs` is the process. Its configuration is environment-only
(`SIGNER_SERVICE_DATA_DIR` is required; host, port and the body ceiling have defaults), and
it has one argument besides `serve`: `provision-admin <label>`, which mints the first admin
credential against a data directory. That mode writes the token to stdout and everything
else to stderr, precisely so it can be piped into a secret manager — §5.1 keeps it off the
HTTP surface, where it would be a route that mints admins forever.

What is not done is the other side of the migration: `neo-nexus` still holds its own copy of
the engine until step 2 of §7 turns it into a client, and the `/sign/payload` consumers of
`nitro-signer-server.mjs` move to these routes one caller at a time.

## Build and test

From this directory, not from the repository root:

```sh
cargo build
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --all --check
```

The first build compiles `rusqlite` with the `bundled` feature, so it needs a C
compiler and takes a few minutes.

`Cargo.lock` is committed: a custody service has to be rebuildable byte for
byte. `target/` is not (`.gitignore`).

The tests live under `tests/unit/` but are not integration tests: each module in
`src/` pulls its own file in with `#[cfg(test)] #[path = "../tests/unit/x.rs"]
mod tests;`, so every test runs inside the library and can reach the module's
private items — which is how the store tests open a raw connection, how the
service tests reach `SignerService`'s guards, and how the api tests exercise the
router with `oneshot` instead of binding a port. There is no `tests/*.rs` target
and adding one would compile the same files twice.

## Reference

- `../../docs/SIGNER_SERVICE.md` — ownership matrix (§3), the HTTP contract `api`
  implements (§5), the management API it serves only to an `admin` caller (§5.1), and
  the migration order (§7).
