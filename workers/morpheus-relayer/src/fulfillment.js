// Compatibility barrel: the original fulfillment.js implementation has moved
// into focused sub-modules under ./fulfillment/. This file preserves existing
// imports from './fulfillment.js' by re-exporting the full public API.
export * from './fulfillment/index.js';
