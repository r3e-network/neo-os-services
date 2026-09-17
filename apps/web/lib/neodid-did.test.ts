import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { resolveMorpheusDid } from './neodid-did';

describe('NeoDID resolution metadata', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not claim deactivation or emit a volatile update timestamp without authoritative state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 }))
    );

    const did = 'did:morpheus:neo_n3:vault:6d0656f6dd91469db1c90cc1e574380613f43738';
    const first = await resolveMorpheusDid(did, {
      origin: 'https://attacker.example',
      accept: 'application/ld+json',
    });
    const second = await resolveMorpheusDid(did, {
      origin: 'https://attacker.example',
      accept: 'application/ld+json',
    });

    expect(first.status).toBe(200);
    expect(first.body.didDocumentMetadata).toEqual(second.body.didDocumentMetadata);
    expect(first.body.didDocumentMetadata).not.toHaveProperty('deactivated');
    expect(first.body.didDocumentMetadata).not.toHaveProperty('updated');
    expect(first.body.didDocument.service[0].serviceEndpoint).not.toContain('attacker.example');
    expect(first.body.didDocument.service[0].serviceEndpoint).toContain('/api/neodid/resolve?did=');
  });
});
