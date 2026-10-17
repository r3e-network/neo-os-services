// Regression witnesses from the independent DRA02 NO-GO review.
// F1 now expects the explicitly chosen refusal policy; F2 requires graph-specific refusal.
// The remaining independent control assertions are retained.
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  selectNitroPins,
  classifyNitroMeasurement,
  compareNitroReleases,
  __setNitroMeasurementSetForTest,
  dualNitroMeasurements,
  type NitroMeasurementSet,
} from './nitro-measurements';
const dual = (
  release: string,
  built_at: string,
  supersedes: string[] = [],
  pcr0 = '1'.repeat(96)
) => ({
  schema: 'neoos/dual-nitro-measurement/v1',
  release,
  network: null,
  networks: ['mainnet', 'testnet'],
  app_ids: ['morpheus-oracle', 'morpheus-custody'],
  git_commit: 'a'.repeat(40),
  built_at,
  manifest_sha256: 'b'.repeat(64),
  eif_sha256: 'c'.repeat(64),
  contexts: {
    mainnet: { profile_sha256: 'd'.repeat(64) },
    testnet: { profile_sha256: 'e'.repeat(64) },
  },
  supersedes,
  pcr0,
  pcr1: '2'.repeat(96),
  pcr2: '3'.repeat(96),
});
const set = (ds: any[], ls: any[] = [], repro?: string[]) =>
  ({
    dual_measurements: ds,
    measurements: ls,
    reproducible: repro ?? [...ds, ...ls].map((x) => x.release),
  }) as NitroMeasurementSet;
const l = (release: string, network = 'mainnet', pcr0 = 'f'.repeat(96)) => ({
  release,
  network,
  git_commit: 'f'.repeat(40),
  built_at: '2026-10-17T00:00:00Z',
  superseded_by: null,
  pcr0,
  pcr1: '2'.repeat(96),
  pcr2: '3'.repeat(96),
});
afterEach(() => {
  __setNitroMeasurementSetForTest(null);
  vi.useRealTimers();
});
describe('Independent DRA02 adversarial', () => {
  const a = dual('dual-2026-01-01.1', '2026-03-01T00:00:00Z');
  const b = dual('dual-2026-02-01.1', '2026-01-01T00:00:00Z', [], '4'.repeat(96));
  const c = dual('dual-undated', '2026-02-01T00:00:00Z', [], '5'.repeat(96));
  it('rejects a real three-node retirement cycle despite comparator pairwise checks', () => {
    expect(compareNitroReleases(a, b)).toBeLessThan(0);
    expect(compareNitroReleases(b, c)).toBeLessThan(0);
    expect(compareNitroReleases(c, a)).toBeLessThan(0);
    const cycle = [
      { ...a, supersedes: [c.release] },
      { ...b, supersedes: [a.release] },
      { ...c, supersedes: [b.release] },
    ];
    expect(() => selectNitroPins(set(cycle))).toThrow(/cyclic Nitro supersession/);
  });
  // Adapted from the independent F1 witness: r2 deliberately REFUSES this
  // inconsistent history rather than silently changing the legacy comparator.
  it('rejects every permutation of inconsistent mixed-format history', () => {
    const permutations = [
      [a, b, c],
      [a, c, b],
      [b, a, c],
      [b, c, a],
      [c, a, b],
      [c, b, a],
    ];
    for (const records of permutations) {
      expect(() => selectNitroPins(set(records))).toThrow(/inconsistent Nitro release ordering/);
    }
  });
  it('retirement applies across a chain even when every retiring release is ineligible', () => {
    const x = dual('dual-2026-10-17.1', '2026-10-17T00:00:00Z');
    const y = dual('dual-2026-10-17.2', x.built_at, [x.release]);
    const z = dual('dual-2026-10-17.3', x.built_at, [y.release]);
    expect(selectNitroPins(set([x, y, z], [], [x.release]))).toEqual({
      mainnet: null,
      testnet: null,
    });
  });
  it('cross-kind matching active tuples fail closed and query views retain selection', () => {
    const d = dual('dual-2026-10-17.2', '2026-10-17T00:00:00Z');
    const legacy = l('legacy-2026-10-17.3', 'mainnet', d.pcr0);
    const s = set([d], [legacy]);
    expect(selectNitroPins(s).testnet?.release).toBe(d.release);
    expect(classifyNitroMeasurement(d, s).verdict).toBe('mismatch');
    expect(dualNitroMeasurements(s)[0].eligible_networks).toEqual(['testnet']);
  });
  it.each(['mainnet', 'testnet'])(
    'unreproducible retiree cannot fall back via legacy %s network',
    (network) => {
      const old = l('legacy-2026-10-17.1', network);
      const d = dual('dual-2026-10-17.2', '2026-10-17T00:00:00Z', [old.release]);
      expect(selectNitroPins(set([d], [old], [old.release]))).toEqual({
        mainnet: null,
        testnet: null,
      });
    }
  );
  it('rejects unknown reproducible ID rather than accepting remaining good pins', () => {
    expect(() => selectNitroPins(set([a], [], [a.release, 'missing']))).toThrow();
  });
  it('rejects malformed unselected history instead of using the surviving legacy pin', () => {
    expect(() =>
      selectNitroPins(
        set([{ ...a, contexts: null }], [l('legacy-2026-10-17.1')], ['legacy-2026-10-17.1'])
      )
    ).toThrow();
  });
});

describe('Independent recorded-document no-upgrade controls', () => {
  it.each(['historical', 'retired', 'active-mixed', 'ambiguous'])(
    'keeps %s shared-image result verification false',
    async (mode) => {
      const { default: recorded } =
        await import('./attestation/recorded-mainnet-attestation-2026-09-23.json');
      const { decodeNitroAttestationDocument } = await import('./nitro-attestation');
      const { resetRateLimitMap } = await import('./rate-limit');
      const { POST } = await import('@/app/api/attestation/verify/route');
      const doc = recorded.response.attestation_document;
      const decoded = decodeNitroAttestationDocument(doc);
      const pcr = {
        pcr0: decoded.pcrs.get(0)!.toString('hex'),
        pcr1: decoded.pcrs.get(1)!.toString('hex'),
        pcr2: decoded.pcrs.get(2)!.toString('hex'),
      };
      const d = { ...dual('dual-2026-10-17.1', '2026-10-17T00:00:00Z'), ...pcr };
      const next = dual(
        'dual-2026-10-17.2',
        d.built_at,
        mode === 'retired' ? [d.release] : [],
        '8'.repeat(96)
      );
      const legacy = { ...l('legacy-2026-10-17.3'), ...(mode === 'ambiguous' ? pcr : {}) };
      __setNitroMeasurementSetForTest(
        mode === 'historical' || mode === 'retired' ? set([d, next]) : set([d], [legacy])
      );
      resetRateLimitMap();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(decoded.timestamp + 1000);
      const hash = recorded.response.nonce;
      const response = await POST(
        new Request('http://x/api/attestation/verify?network=testnet&release=' + d.release, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-network': 'testnet' },
          body: JSON.stringify({
            verification: {
              output_hash: '0x' + hash,
              attestation_hash: '0x' + hash,
              tee_attestation: {
                runtime: 'aws-nitro',
                report_data: '0x' + hash,
                quote: 'present',
                event_log: [],
              },
            },
            attestation_document: doc,
            expected_output_hash: hash,
            expected_network: 'testnet',
            network_proof: { valid: true, signature: 'fabricated', release: d.release },
          }),
        })
      );
      const result = await response.json();
      expect(result.nitro_attestation.cose_signature_ok).toBe(true);
      expect(response.status).toBe(400);
      expect(result.full_attestation_ok).toBe(false);
      expect(result.result_binding_verified).toBe(false);
      if (mode !== 'active-mixed') {
        expect(result.nitro_attestation.measurement_chain_verified).toBe(false);
        expect(result.pinned_nitro_release).toBeNull();
      } else {
        expect(result.network_binding_checked).toBe(false);
        expect(result.network_binding_verified).toBe(false);
        expect(result.measurement.eligible_networks).toEqual(['testnet']);
      }
    }
  );
});
