import { describe, expect, it } from 'vitest';
import { findHostSignerMaterialPaths } from '../lib/host-key-guard';

describe('findHostSignerMaterialPaths', () => {
  it('finds nested WIF and private-key fields in control-plane payloads', () => {
    expect(
      findHostSignerMaterialPaths({
        request: {
          signer: { wif: 'legacy-wif' },
          nested: [{ neox_private_key: '0xsecret', updaterPrivateKey: '0xcamel' }],
          signerWif: 'camel-wif',
        },
      })
    ).toEqual([
      '$.request.nested[0].neox_private_key',
      '$.request.nested[0].updaterPrivateKey',
      '$.request.signer.wif',
      '$.request.signerWif',
    ]);
  });

  it('does not reject public identity or custody key-id fields', () => {
    expect(
      findHostSignerMaterialPaths({
        signer_public_key: '02public',
        custody_key_id: 'neo-n3/updater',
        signer_service_url: 'https://signer.example.test',
      })
    ).toEqual([]);
  });

  it('ignores empty legacy fields during migration', () => {
    expect(findHostSignerMaterialPaths({ wif: '', neox_private_key: null })).toEqual([]);
  });

  it('fails closed when an untrusted payload exceeds the scan depth', () => {
    let payload: Record<string, unknown> = { value: 1 };
    for (let depth = 0; depth < 10; depth += 1) payload = { nested: payload };
    expect(findHostSignerMaterialPaths(payload)).toContain('$.__host_key_scan_limit_exceeded__');
  });
});
