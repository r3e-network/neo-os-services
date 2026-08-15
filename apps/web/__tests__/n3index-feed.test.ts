import { describe, expect, it } from 'vitest';

import { buildN3IndexFeedNotificationUrl } from '../lib/n3index-feed';

// Guards the n3index query shape used by app/api/attestation/lookup/route.ts:
// the broad event_name-only filter is intentional — the contract_hash+event
// combination is a slow query path on n3index.
describe('on-chain feed event lookup', () => {
  it('avoids the slow n3index contract_hash plus event_name query shape', () => {
    const url = buildN3IndexFeedNotificationUrl('mainnet', '0xfeed', 100);

    expect(url).toContain('network=eq.mainnet');
    expect(url).toContain('event_name=eq.FeedUpdated');
    expect(url).not.toContain('contract_hash=eq.');
  });

  it('supports the higher attestation lookup limit with the same broad n3index query shape', () => {
    const url = buildN3IndexFeedNotificationUrl('mainnet', '0xfeed', 200);

    expect(url).toContain('network=eq.mainnet');
    expect(url).toContain('event_name=eq.FeedUpdated');
    expect(url).toContain('limit=200');
    expect(url).not.toContain('contract_hash=eq.');
  });
});
