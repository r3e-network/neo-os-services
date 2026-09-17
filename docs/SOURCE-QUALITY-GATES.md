# Source quality gates

## Authority and purpose

Source lint must check authored code, not stale local build output. TypeScript service sources under `services/**/src` remain lint inputs; generated `dist` directories at any depth are excluded. This matches the existing Git build-output boundary and does not remove any source rules.

The regression test uses ESLint's real `isPathIgnored` API on root and nested paths, including source paths that must remain visible. Run `node --test scripts/source-quality-gates.test.mjs`, then `npm run lint`. An unsuccessful lint must retain its nonzero exit status; piped presentation must not replace that status with the status of the display command.

No runtime interfaces, stored data, credentials or deployment settings change. There is no migration or live deployment step. Ignoring build output is not evidence that a service is functional, tested or ready for production.

## Existing incomplete verification

The historical `tests/cypress/e2e/neoswap-v2.cy.js` references missing custom commands and has no installed Cypress runner/configuration in this repository. It is not executable end-to-end evidence. Its unsupported performance and security claims must not be counted as passing tests. No high-load or attack simulations are part of source-quality validation.

The original Cypress draft is preserved byte-for-byte at `docs/legacy-unverified/neoswap-v2.cy.js.txt`, outside executable test discovery. Its removal from discovery is not a repaired E2E suite: actual swap-flow, stress and security coverage remains missing. The archive regression pins its digest and ensures the executable path does not exist. Do not supply fake command implementations or blanket-ignore authored JavaScript to turn this draft green.

Unused imports and callback arguments are removed without changing behavior. The private history query's unused bucket argument is explicitly named `_bucketSize` for compatibility; this does not implement time bucketing or validate the existing volume-weighted algorithm as a true TWAP. That functional limitation remains open.

The OpenAPI `allow_raw` warning contains a colon and must be quoted as a YAML scalar. Its parsed content is unchanged; malformed YAML was rejected before the repair.
