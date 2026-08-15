# Validation

## Canonical Validation Sequence

Run these checks after any meaningful change to runtime logic, deployment config, or public docs/frontend behavior.

```bash
npm run test:worker
npm run test:relayer
npm run test:control-plane
npm run build:web
npm run smoke:control-plane
npm run smoke:n3
npm run check:signers
MORPHEUS_NETWORK=testnet npm run verify:n3
```

## Workspace Validation Layers

The workspace now exposes validation at two levels:

### Repo-local layers

- `neo-os-services`
  - `npm run test:testnet:local-gates`
  - `npm run test:testnet:live`
  - `npm run test:testnet:full`
- `neo-abstract-account`
  - `bash scripts/run_local_validation_gates.sh`
  - `bash scripts/run_live_testnet_validation.sh`
  - `bash scripts/run_full_testnet_validation.sh`
- `neo-os-web`
  - `npm run test:testnet:local-gates`
  - `npm run test:testnet:live`
  - `npm run test:testnet:full-stack`

### Workspace-level layers

From `neo-os-services`:

```bash
npm run test:workspace:local
npm run test:workspace:live
npm run test:workspace:full
```

These orchestrators call the repo-local layers across:

- `neo-os-services`
- `neo-abstract-account`
- `neo-os-web`

Recommended usage:

- use `workspace:local` for code and config changes
- use `workspace:live` for testnet smoke and cross-repo integration
- use `workspace:full` only when you intentionally want the full local + live stack

## Targeted Neo N3 Regression Paths

```bash
npm run examples:test:n3:callback-boundary
npm run examples:test:n3:neodid-registry-boundary
npm run examples:test:n3:neodid-registry-v1
npm run examples:test:n3:encrypted-ref-boundary
npm run examples:test:n3:fulfillment-replay
npm run examples:test:n3:aa-session-oracle-boundary
npm run examples:test:n3:attack-regression
```

These cover:

- callback injection rejection
- NeoDID registry and ticket boundary behavior
- encrypted ref requester/callback binding
- fulfillment replay rejection
- AA session-key downstream Oracle boundaries
- integrated attack regression

## Environment Validation

```bash
npm run check:env
npm run check:control-plane
npm run check:control-plane:strict
npm run check:nitro-env
npm run check:signers
```

## SaaS Validation

```bash
npm run check:checkly
npm run check:betterstack
npm run check:betterstack:monitors
npm run check:betterstack:sources
npm run export:saas
```

## What “Healthy” Means

- the web app builds successfully
- control plane tests pass
- worker and relayer tests pass
- Oracle key publication matches the runtime
- pinned signer identities match expected addresses
- testnet smoke and verify flows pass end to end
- no documentation pages or explorer pages reference removed topology or stale routes
- workspace validation can be run in layered `local / live / full` mode without reintroducing manual cross-repo sequencing
