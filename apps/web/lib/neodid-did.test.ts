import assert from 'node:assert/strict';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

// `./neodid-did` reaches lib/config, which resolves the Morpheus network while
// the module is being evaluated — before any beforeAll hook could run. Set the
// network from a hoisted block so it is in place for the static import below,
// and pin both variables (NEXT_PUBLIC_* wins over MORPHEUS_NETWORK in
// lib/networks) so this file behaves the same with no env at all and with
// either variable exported to either value.
const originalNetworkEnv = vi.hoisted(() => {
  const original = {
    MORPHEUS_NETWORK: process.env.MORPHEUS_NETWORK,
    NEXT_PUBLIC_MORPHEUS_NETWORK: process.env.NEXT_PUBLIC_MORPHEUS_NETWORK,
  };
  process.env.MORPHEUS_NETWORK = 'testnet';
  process.env.NEXT_PUBLIC_MORPHEUS_NETWORK = 'testnet';
  return original;
});

import { resolveMorpheusDid } from './neodid-did';

describe('NeoDID resolution metadata', () => {
  afterAll(() => {
    for (const [key, value] of Object.entries(originalNetworkEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

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
    const didDocument = first.body.didDocument;
    assert(didDocument && typeof didDocument === 'object' && 'service' in didDocument);
    assert(Array.isArray(didDocument.service));
    const resolverService: unknown = didDocument.service[0];
    assert(
      resolverService && typeof resolverService === 'object' && 'serviceEndpoint' in resolverService
    );
    assert(typeof resolverService.serviceEndpoint === 'string');
    expect(resolverService.serviceEndpoint).not.toContain('attacker.example');
    expect(resolverService.serviceEndpoint).toContain('/api/neodid/resolve?did=');
  });
});
