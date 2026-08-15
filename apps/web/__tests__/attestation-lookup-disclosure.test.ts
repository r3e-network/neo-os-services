import { describe, expect, it } from 'vitest';

import { buildVerifierInput, extractEnvelopeByAttestationHash } from '../lib/attestation-lookup';

describe('attestation lookup disclosure boundary', () => {
  it('rejects lookup responses and hash-only objects as signed-result evidence', () => {
    const hash = '00'.repeat(32);
    const priorLookupResponse = {
      ok: true,
      network: 'testnet',
      attestation_hash: `0x${hash}`,
      found: false,
      verifier_input: null,
      operation_log_matches: [],
      onchain_feed_matches: [],
      error: null,
    };
    const unsignedEnvelope = {
      verification: {
        output_hash: `0x${hash}`,
        attestation_hash: `0x${hash}`,
      },
    };

    expect(extractEnvelopeByAttestationHash(priorLookupResponse, hash)).toBeNull();
    expect(extractEnvelopeByAttestationHash(unsignedEnvelope, hash)).toBeNull();
  });

  it('accepts a canonical signed-result envelope and prefers verification evidence', () => {
    const hash = '12'.repeat(32);
    const directOnlyEnvelope = {
      output_hash: `0x${hash}`,
      attestation_hash: `0x${hash}`,
      signature: 'ab'.repeat(64),
      public_key: `02${'cd'.repeat(32)}`,
    };
    const signedEnvelope = {
      output_hash: `0x${hash}`,
      attestation_hash: `0x${hash}`,
      signature: '34'.repeat(64),
      public_key: `02${'56'.repeat(32)}`,
      verification: {
        output_hash: `0x${hash}`,
        attestation_hash: `0x${hash}`,
        signature: '78'.repeat(64),
        public_key: `03${'9a'.repeat(32)}`,
      },
    };

    expect(extractEnvelopeByAttestationHash({ directOnlyEnvelope, signedEnvelope }, hash)).toBe(
      signedEnvelope
    );
  });

  it('requires both hashes, a 64-byte signature, and a compressed Neo public key', () => {
    const hash = 'ef'.repeat(32);
    const base = {
      output_hash: `0x${hash}`,
      attestation_hash: `0x${hash}`,
      signature: '01'.repeat(64),
      public_key: `03${'23'.repeat(32)}`,
    };

    expect(extractEnvelopeByAttestationHash(base, hash)).toBe(base);
    expect(
      extractEnvelopeByAttestationHash({ ...base, output_hash: `0x${'ff'.repeat(32)}` }, hash)
    ).toBeNull();
    expect(
      extractEnvelopeByAttestationHash({ ...base, signature: '01'.repeat(63) }, hash)
    ).toBeNull();
    expect(
      extractEnvelopeByAttestationHash({ ...base, public_key: `04${'23'.repeat(32)}` }, hash)
    ).toBeNull();
  });

  it('returns only verifier evidence, not operation result bodies', () => {
    const hash = 'ab'.repeat(32);
    const input = buildVerifierInput(
      {
        verification: {
          output_hash: `0x${hash}`,
          attestation_hash: `0x${hash}`,
          tee_attestation: {
            report_data: `0x${hash}`,
            app_id: 'test-app',
            private_result: 'must-not-leak',
          },
        },
        body: { access_token: 'secret-token', upstream_response: 'must-not-leak' },
        data: { plaintext: 'must-not-leak' },
        result: 'must-not-leak',
      },
      hash
    );

    const serialized = JSON.stringify(input);
    expect(serialized).toContain(`0x${hash}`);
    expect(serialized).toContain('test-app');
    expect(serialized).not.toContain('must-not-leak');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('private_result');
  });

  it('bounds recursive scans of stored operation payloads', () => {
    let value: unknown = { attestation_hash: `0x${'cd'.repeat(32)}` };
    for (let index = 0; index < 20; index += 1) value = { nested: value };

    expect(extractEnvelopeByAttestationHash(value, 'cd'.repeat(32))).toBeNull();
  });
});
