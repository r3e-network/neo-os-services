# Examples Directory

This directory contains copy-pasteable examples for the most common Morpheus workflows.

The architectural default is now `miniapp-os + miniapps`:

- the shared system kernel owns generic request plumbing
- built-in modules expose common capabilities
- miniapps should focus on business logic and configuration

Some examples still exercise legacy oracle-shaped compatibility shims such as
`Request(...)` and `onOracleResult`. Treat those as migration examples rather than the
preferred long-term integration surface.

Structure:

- `browser-encryption/` — browser-side encryption helpers
- `node-encryption/` — Node-side encryption helpers
- `payloads/` — ready-to-edit request payload templates
  - includes automation templates for one-shot, interval, and price-threshold jobs
- `contracts/n3/` — Neo N3 user contract examples
- `wasm/` — minimal WASM modules and build notes

Suggested usage:

1. Read the matching payload template under `payloads/`.
2. Encrypt any secret fields with the helpers under `browser-encryption/` or `node-encryption/`.
3. Use the matching contract example under `contracts/` to issue the request from chain or to
   integrate with the shared kernel using a thin adapter.
4. Use the modules under `wasm/` when you want stronger isolation than custom JS.

Live deploy/test:

- `npm run examples:deploy:n3`
- `npm run examples:test:n3`
- `npm run examples:test:n3:builtins`
- `npm run examples:test:n3:automation`
- `npm run examples:test:feed-source`
- `npm run examples:all`
- `examples:all` runs `examples/scripts/deploy-and-test-all.mjs`, which validates the active Neo N3 example contracts and live oracle / encrypted compute / custom URL oracle / on-chain feed read flows.
- Deployment addresses are recorded under `examples/deployments/testnet.json`.
- The per-chain `examples:test:*` scripts rerun the live checks against the latest recorded deployment addresses without redeploying.

Network-aware validation:

- `examples:test:n3:privacy` now writes:
  - `examples/deployments/n3-privacy-validation.<network>.latest.json`
  - optional local markdown summary (not kept in git)
- pricefeed synchronization is operator-managed and automatic; end-user contracts should read the on-chain shared resource registry directly instead of trying to trigger feed publication.

Per-script report outputs:

- `examples:test:n3` now writes:
  - `examples/deployments/n3-examples-validation.<network>.latest.json`
  - optional local markdown summary (not kept in git)
- `examples:test:n3:builtins` now writes:
  - `examples/deployments/n3-builtins-validation.<network>.latest.json`
  - optional local markdown summary (not kept in git)
- `examples:test:n3:automation` now writes:
  - `examples/deployments/n3-automation-validation.<network>.latest.json`
  - optional local markdown summary (not kept in git)
- `examples:test:feed-source` now writes:
  - `examples/deployments/feed-source-validation.<network>.latest.json`
  - optional local markdown summary (not kept in git)
