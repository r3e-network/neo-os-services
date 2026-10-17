import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  selectNitroPins,
  classifyNitroMeasurement,
  __setNitroMeasurementSetForTest,
  type NitroMeasurement,
  type NitroMeasurementSet,
} from './nitro-measurements';

// Synthetic selection fixtures only. Never registered as production measurements.
function dual(sequence = 9, overrides = {}) {
  return {
    schema: 'neoos/dual-nitro-measurement/v1',
    release: `dual-2026-10-17.${sequence}`,
    network: null,
    networks: ['mainnet', 'testnet'],
    app_ids: ['morpheus-oracle', 'morpheus-custody'],
    git_commit: 'a'.repeat(40),
    built_at: '2026-10-17T00:00:00Z',
    manifest_sha256: 'b'.repeat(64),
    eif_sha256: 'c'.repeat(64),
    contexts: {
      mainnet: { profile_sha256: 'd'.repeat(64) },
      testnet: { profile_sha256: 'e'.repeat(64) },
    },
    supersedes: [] as string[],
    pcr0: sequence.toString(16).padStart(2, '0').repeat(48),
    pcr1: '2'.repeat(96),
    pcr2: '3'.repeat(96),
    ...overrides,
  };
}
function legacy(overrides = {}): NitroMeasurement {
  return {
    release: 'legacy-2026-10-17.11',
    network: 'mainnet',
    git_commit: 'f'.repeat(40),
    built_at: '2026-10-17T00:00:00Z',
    superseded_by: null,
    pcr0: '4'.repeat(96),
    pcr1: '5'.repeat(96),
    pcr2: '6'.repeat(96),
    ...overrides,
  };
}
function set(
  duals = [dual()],
  measurements: NitroMeasurement[] = [],
  reproducible?: string[]
): NitroMeasurementSet {
  return {
    measurements,
    dual_measurements: duals,
    reproducible: reproducible ?? [...duals, ...measurements].map((x) => x.release),
  } as NitroMeasurementSet;
}
afterEach(() => {
  vi.unstubAllEnvs();
  __setNitroMeasurementSetForTest(null);
});

describe('DRA02 active dual history', () => {
  it('merges a shared dual image into both network pins without inventing legacy records', () => {
    const d = dual();
    const pins = selectNitroPins(set([d]));
    expect(pins.mainnet?.release).toBe(d.release);
    expect(pins.testnet?.release).toBe(d.release);
    expect(pins.mainnet?.network).toBeNull();
    expect(classifyNitroMeasurement(d, set([d]))).toMatchObject({
      verdict: 'reproducible-match',
      network: null,
      networks: ['mainnet', 'testnet'],
      eligible_networks: ['mainnet', 'testnet'],
      release: d.release,
    });
  });
  it.each([false, true])(
    'D2 replaces D1 with supersession=%s, regardless of registry order',
    (supersede) => {
      const d1 = dual(9);
      const d2 = dual(10, { supersedes: supersede ? [d1.release] : [] });
      for (const ds of [
        [d1, d2],
        [d2, d1],
      ]) {
        const s = set(ds);
        expect(selectNitroPins(s).mainnet?.release).toBe(d2.release);
        expect(classifyNitroMeasurement(d1, s).verdict).toBe('mismatch');
        expect(classifyNitroMeasurement(d2, s).verdict).toBe('reproducible-match');
      }
    }
  );
  it('uses the same comparator for legacy-to-dual and dual-to-legacy crossover', () => {
    const old = legacy({ release: 'legacy-2026-10-17.8' });
    const d = dual(9);
    const newer = legacy();
    expect(selectNitroPins(set([d], [old])).mainnet?.release).toBe(d.release);
    const s = set([d], [old, newer]);
    expect(selectNitroPins(s).mainnet?.release).toBe(newer.release);
    expect(selectNitroPins(s).testnet?.release).toBe(d.release);
    expect(classifyNitroMeasurement(d, s)).toMatchObject({
      network: null,
      eligible_networks: ['testnet'],
    });
  });
  it('keeps retirement even when the superseding release is not reproducible', () => {
    const d1 = dual();
    const d2 = dual(10, { supersedes: [d1.release] });
    const s = set([d1, d2], [], [d1.release]);
    expect(selectNitroPins(s)).toEqual({ mainnet: null, testnet: null });
    expect(classifyNitroMeasurement(d1, s).verdict).toBe('mismatch');
    expect(classifyNitroMeasurement(d2, s).verdict).toBe('measured-but-unreproducible');
  });
  it('never revives explicitly retired legacy pins', () => {
    const l = legacy({ release: 'legacy-2026-10-17.8' });
    const d = dual(9, { supersedes: [l.release] });
    expect(selectNitroPins(set([d], [l], [l.release]))).toEqual({ mainnet: null, testnet: null });
    expect(classifyNitroMeasurement(l, set([d], [l], [l.release])).verdict).toBe('mismatch');
  });
  it('names only the selected identity when older records share its tuple', () => {
    const d1 = dual();
    const d2 = dual(10, { pcr0: d1.pcr0 });
    for (const ds of [
      [d1, d2],
      [d2, d1],
    ]) {
      expect(classifyNitroMeasurement(d1, set(ds))).toMatchObject({
        verdict: 'reproducible-match',
        release: d2.release,
      });
    }
  });
  it('refuses distinct active image identities sharing a tuple involving dual', () => {
    const d = dual();
    const l = legacy({ pcr0: d.pcr0, pcr1: d.pcr1, pcr2: d.pcr2 });
    expect(classifyNitroMeasurement(d, set([d], [l]))).toMatchObject({
      verdict: 'mismatch',
      release: null,
      network: null,
    });
  });
  it('displays unselected history deterministically, never as an allowlist', () => {
    const d1 = dual();
    const d2 = dual(10, { pcr0: d1.pcr0 });
    const d3 = dual(11);
    for (const ds of [
      [d1, d2, d3],
      [d3, d2, d1],
    ]) {
      expect(classifyNitroMeasurement(d1, set(ds))).toMatchObject({
        verdict: 'mismatch',
        release: d2.release,
      });
      expect(classifyNitroMeasurement(d1, set(ds, [], []))).toMatchObject({
        verdict: 'measured-but-unreproducible',
        release: d2.release,
      });
    }
  });
  it.each([
    ['missing', { supersedes: ['gone'] }],
    ['self', { supersedes: ['dual-2026-10-17.9'] }],
    ['duplicate edge', { supersedes: ['dual-2026-10-17.8', 'dual-2026-10-17.8'] }],
    ['missing context', { contexts: { mainnet: { profile_sha256: 'd'.repeat(64) } } }],
    ['unknown field', { candidate: true }],
    ['zero PCR', { pcr0: '0'.repeat(96) }],
    ['malformed PCR', { pcr0: 'xyz' }],
    ['invalid commit', { git_commit: 'abc' }],
    ['missing supersedes', { supersedes: undefined }],
    ['invalid timestamp', { built_at: 'bad' }],
  ])('refuses malformed registered history even when unselected: %s', (_name, patch) => {
    expect(() => selectNitroPins(set([dual(8), dual(9, patch)], [], []))).toThrow();
  });
  it('rejects newer targets and cycles', () => {
    const d1 = dual(9, { supersedes: ['dual-2026-10-17.10'] });
    const d2 = dual(10);
    expect(() => selectNitroPins(set([d1, d2]))).toThrow();
    expect(() => selectNitroPins(set([d1, { ...d2, supersedes: [d1.release] }]))).toThrow();
  });
  it('rejects globally ambiguous IDs, including legacy/dual collisions', () => {
    const d = dual();
    expect(() => selectNitroPins(set([d, d]))).toThrow();
    expect(() => selectNitroPins(set([d], [legacy({ release: d.release })], []))).toThrow();
    expect(() => selectNitroPins(set([], [legacy(), legacy()], []))).toThrow();
  });
  it('retains build-time then natural-ID fallback ordering', () => {
    const a = dual(9, { release: 'dual-v9' });
    const b = dual(10, { release: 'dual-v10' });
    expect(selectNitroPins(set([b, a])).mainnet?.release).toBe(b.release);
    const later = { ...a, built_at: '2026-10-18T00:00:00Z' };
    expect(selectNitroPins(set([b, later])).mainnet?.release).toBe(a.release);
  });
  it('requires every PCR and rejects unknown nested context keys', () => {
    const d = dual();
    expect(classifyNitroMeasurement({ ...d, pcr2: 'f'.repeat(96) }, set([d])).verdict).toBe(
      'mismatch'
    );
    expect(() =>
      selectNitroPins(
        set([
          dual(9, {
            contexts: {
              ...d.contexts,
              mainnet: { ...d.contexts.mainnet, candidate: true },
            },
          }),
        ])
      )
    ).toThrow();
  });
  it('does not allow replacing the registry in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => __setNitroMeasurementSetForTest(set())).toThrow();
  });
});

describe('DRA02 API integration and unsupported network proof', () => {
  it('keeps an empty committed dual registry and both actual pins empty', async () => {
    const { COMMITTED_DUAL_NITRO_MEASUREMENTS } = await import('./nitro-dual-release-registry');
    const { nitroMeasurementPins } = await import('./nitro-measurements');
    expect(COMMITTED_DUAL_NITRO_MEASUREMENTS).toEqual([]);
    expect(nitroMeasurementPins()).toEqual({ mainnet: null, testnet: null });
  });
  it('displays dual membership separately from current eligibility without changing legacy wire data', async () => {
    const { GET } = await import('@/app/api/attestation/measurements/route');
    const baseline = await (await GET(new Request('http://x/api/attestation/measurements'))).json();
    const d1 = dual();
    const d2 = dual(10);
    __setNitroMeasurementSetForTest(set([d1, d2], [legacy()]));
    const all = await (await GET(new Request('http://x/api/attestation/measurements'))).json();
    expect(all.measurements).toEqual(baseline.measurements);
    expect(all.count).toBe(baseline.count);
    expect(all.dual_count).toBe(2);
    expect(all.dual_measurements_version).toBe(1);
    expect(all.dual_measurements.map((x: { release: string }) => x.release)).toEqual([
      d2.release,
      d1.release,
    ]);
    const filtered = await (
      await GET(
        new Request(`http://x/api/attestation/measurements?network=mainnet&release=${d2.release}`)
      )
    ).json();
    expect(filtered.dual_count).toBe(1);
    expect(filtered.dual_measurements[0]).toMatchObject({
      network: null,
      networks: ['mainnet', 'testnet'],
      eligible_networks: ['testnet'],
    });
    const old = await (
      await GET(new Request(`http://x/api/attestation/measurements?release=${d1.release}`))
    ).json();
    expect(old.dual_measurements[0].eligible_networks).toEqual([]);
  });
  it.each([
    {},
    { expected_network: 'mainnet' },
    { expected_network: 'testnet', network_proof: { valid: true } },
    { network: 'mainnet', network_proof: 'malformed' },
    { expected_network: 'other' },
  ])(
    'never upgrades a genuine signed shared-image document using outer metadata: %j',
    async (metadata) => {
      const { default: recorded } =
        await import('./attestation/recorded-mainnet-attestation-2026-09-23.json');
      const { decodeNitroAttestationDocument } = await import('./nitro-attestation');
      const { resetRateLimitMap } = await import('./rate-limit');
      const { POST } = await import('@/app/api/attestation/verify/route');
      const doc = recorded.response.attestation_document;
      const decoded = decodeNitroAttestationDocument(doc);
      const d = dual(9, {
        pcr0: decoded.pcrs.get(0)!.toString('hex'),
        pcr1: decoded.pcrs.get(1)!.toString('hex'),
        pcr2: decoded.pcrs.get(2)!.toString('hex'),
      });
      // Counterfactual TEST ONLY: this does not register/admit the recorded legacy image.
      __setNitroMeasurementSetForTest(set([d], [legacy()]));
      resetRateLimitMap();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(decoded.timestamp + 1000);
      try {
        const hash = recorded.response.nonce;
        const response = await POST(
          new Request('http://x/api/attestation/verify?network=mainnet', {
            method: 'POST',
            headers: { 'x-network': 'mainnet' },
            body: JSON.stringify({
              verification: {
                output_hash: `0x${hash}`,
                attestation_hash: `0x${hash}`,
                tee_attestation: {
                  runtime: 'aws-nitro',
                  report_data: `0x${hash}`,
                  quote: 'present',
                  event_log: [],
                },
              },
              attestation_document: doc,
              expected_output_hash: hash,
              ...metadata,
            }),
          })
        );
        const result = await response.json();
        expect(result.nitro_attestation.cose_signature_ok).toBe(true);
        expect(result.nitro_attestation.measurement_chain_verified).toBe(true);
        expect(result.measurement).toMatchObject({
          verdict: 'reproducible-match',
          network: null,
          eligible_networks: ['testnet'],
        });
        expect(result.network_binding_checked).toBe(false);
        expect(result.network_binding_verified).toBe(false);
        expect(result.full_attestation_ok).toBe(false);
        expect(result.result_binding_verified).toBe(false);
        expect(response.status).toBe(400);
      } finally {
        vi.useRealTimers();
      }
    }
  );
});
