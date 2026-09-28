# neo-os-services

NeoOS confidential services stack.

## What this repository contains today

- `workers/`: the Rust services built by the root Cargo workspace (`neo-signer` custody service,
  `nitro-enclave-host`, `neo-os-relayer`) and the Node compatibility workers (`nitro-worker`,
  `morpheus-relayer`). `morpheus-relater-rs` and `redis-cache` are retired and outside the
  workspace.
- `crates/`: Rust libraries used by those services.
- `packages/shared`: JavaScript shared by the workers and the web app.
- `apps/web`: the operator web application, built and deployed to Vercel from this repository
  (`.github/workflows/deploy-web.yml`).
- `contracts/`: Neo N3 sources for MorpheusOracle, MorpheusDataFeed and OracleCallbackConsumer,
  built and tested by the `contracts` CI job.
- `contracts-evm/`: Neo X (EVM) contracts, built and tested by the `contracts-evm` CI job.
- `db/services/migrations/`: PostgreSQL migrations for the durable state (Supabase), moved from the
  former top-level Supabase directory in 7f430ab. `tests/relayer-delivery-*.sql` is the real
  PostgreSQL acceptance suite that `scripts/test-relayer-delivery-v2.sh` runs against them.
- `deploy/`: Cloudflare edge gateway and control plane, Nitro enclave images and measurements,
  systemd units, Neo X operator tools.
- `config/networks/`: the reviewed network registry. Network identities are projected from it and
  never restated as literals.
- `vendor/neo-os-did/`: pinned NeoDID consumer copies from neo-os-did, checked by
  `npm run check:neodid-vendor`.

Component ownership (v2 layer L3 gateway) is recorded in `ARCHITECTURE.md`.

## Boundaries

- Service keys and custody live here. User keys stay in neo-os-app; this repository never holds
  user wallets.
- Review `docs/SIGNER_SERVICE.md` §7 before adding a signing call site.
- The NeoDID registry protocol is owned by neo-os-did; this repository runs pinned consumer copies.
- MiniApp and MiniGame sources belong to neo-os-miniapps and neo-os-minigames; wallet and session UI
  belongs to neo-os-web.

## Planned moves (not done)

`docs/ORGANIZATION.md` lists them: the contract sources to neo-os-contracts, `apps/web` to
neo-os-admin and `config/networks` to neo-os-workspace. Until a move lands, the copy here is the
live one: build, test and review it as such, and do not add new contract sources.

## Checks

`.github/workflows/ci.yml` is the gate. `lint-and-format` runs on every push to `main` and every pull
request, with no path filter. The other jobs run on every push to `main` and, on a pull request,
when their path filter matches: code, migrations and tests for most of them, `contracts-evm/**` for
the EVM job.
