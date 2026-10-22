// Historical exception only; never imported by the production gate.
export const HISTORICAL_REVIEWED_TOPOLOGY_EXCEPTIONS = Object.freeze([
  // Renewed once (CU-21, DEC-CU-3): first dated 2026-10-07, now 2026-10-21. A further renewal
  // needs a new recorded decision. The owner and the condition are in `reason`, which is printed.
  Object.freeze({
    key: 'boot-enabled-chain-writer:morpheus-public-feed-writer',
    reason:
      'renewed once, for 14 days, from 2026-10-07 to 2026-10-21 (DEC-CU-3, which supersedes ' +
      'DEC-P19; first reviewed in round-9 audit 3a): boot-enabled every 60 s, runs ' +
      'workers/nitro-worker/.neoos-live-feed-write.mjs --execute (in no repository) with ' +
      'the frontier signer env, outside the Rust relayer authority and absent from its ' +
      'Conflicts=; kept running, not deleted or disabled. Owner: NeoOS program lead ' +
      '(delegated by the owner). Condition: the owner caps the writer cadence and funds the ' +
      'updater to at least 30 days (OP-02) and the runway and stale alerts exist (CU-11); ' +
      'the key-free writer replaces this unit in the 2026-10-21 enclave rebuild window; ' +
      'no second renewal',
    expiresOn: '2026-10-21',
  }),
]);
