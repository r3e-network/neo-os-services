import { describe, expect, it } from 'vitest';
import {
  selectNitroPins,
  classifyNitroMeasurement,
  dualNitroMeasurements,
  compareNitroReleases,
  type NitroMeasurement,
  type NitroMeasurementSet,
} from './nitro-measurements';

function dual(release: string, built_at: string, supersedes: string[] = []) {
  return {
    schema: 'neoos/dual-nitro-measurement/v1',
    release,
    built_at,
    supersedes,
    network: null,
    networks: ['mainnet', 'testnet'],
    app_ids: ['morpheus-oracle', 'morpheus-custody'],
    git_commit: 'a'.repeat(40),
    manifest_sha256: 'b'.repeat(64),
    eif_sha256: 'c'.repeat(64),
    contexts: {
      mainnet: { profile_sha256: 'd'.repeat(64) },
      testnet: { profile_sha256: 'e'.repeat(64) },
    },
    pcr0: '1'.repeat(96),
    pcr1: '2'.repeat(96),
    pcr2: '3'.repeat(96),
  };
}
const a = dual('dual-2026-01-01.1', '2026-03-01T00:00:00Z');
const b = dual('dual-2026-02-01.1', '2026-01-01T00:00:00Z');
const c = dual('dual-undated', '2026-02-01T00:00:00Z');
function permutations<T>([a, b, c]: T[]) {
  return [
    [a, b, c],
    [a, c, b],
    [b, a, c],
    [b, c, a],
    [c, a, b],
    [c, b, a],
  ];
}
function legacy(entry: typeof a): NitroMeasurement {
  return {
    release: entry.release,
    built_at: entry.built_at,
    network: 'mainnet',
    git_commit: entry.git_commit,
    superseded_by: null,
    pcr0: entry.pcr0,
    pcr1: entry.pcr1,
    pcr2: entry.pcr2,
  };
}
function set(
  entries: (typeof a)[],
  reproducible = entries.map((x) => x.release),
  measurements: NitroMeasurement[] = []
): NitroMeasurementSet {
  return { dual_measurements: entries, measurements, reproducible };
}

describe('mixed/dual ordering admission without changing the legacy comparator', () => {
  it('keeps the inherited pairwise comparator and all six legacy-only selection results', () => {
    expect(compareNitroReleases(a, b)).toBeLessThan(0);
    expect(compareNitroReleases(b, c)).toBeLessThan(0);
    expect(compareNitroReleases(c, a)).toBeLessThan(0);
    const entries = [a, b, c].map(legacy);
    for (const history of permutations(entries)) {
      const pins = permutations(entries).map(
        (order) =>
          selectNitroPins({
            measurements: history,
            reproducible: order.map((x) => x.release),
          }).mainnet?.release
      );
      expect(pins).toEqual([c.release, b.release, c.release, a.release, b.release, a.release]);
    }
  });
  it('rejects inconsistent history regardless of history order, reproducible order or eligibility', () => {
    for (const history of permutations([a, b, c])) {
      for (const order of permutations([a, b, c])) {
        for (const ids of [order.map((x) => x.release), [a.release], []]) {
          const s = set(history, ids);
          expect(() => selectNitroPins(s)).toThrow(/inconsistent Nitro release ordering/);
          expect(() => classifyNitroMeasurement(a, s)).toThrow(
            /inconsistent Nitro release ordering/
          );
          expect(() => dualNitroMeasurements(s)).toThrow(/inconsistent Nitro release ordering/);
        }
      }
    }
  });
  it('also validates legacy participants when even one dual record is registered', () => {
    for (const d of [a, b, c]) {
      const others = [a, b, c].filter((x) => x !== d).map(legacy);
      expect(() => selectNitroPins(set([d], [], others))).toThrow(
        /inconsistent Nitro release ordering/
      );
    }
  });
  it('detects the full graph cycle independently of eligibility and before ordering', () => {
    const cycle = [
      { ...a, supersedes: [c.release] },
      { ...b, supersedes: [a.release] },
      { ...c, supersedes: [b.release] },
    ];
    for (const history of permutations(cycle)) {
      for (const ids of [[], [a.release], history.map((x) => x.release)]) {
        expect(() => selectNitroPins(set(history, ids))).toThrow(/cyclic Nitro supersession/);
      }
    }
  });
  it('rejects self-links, two-node cycles and missing targets even when no releases are eligible', () => {
    expect(() => selectNitroPins(set([{ ...a, supersedes: [a.release] }], []))).toThrow(/cyclic/);
    expect(() =>
      selectNitroPins(
        set(
          [
            { ...a, supersedes: [b.release] },
            { ...b, supersedes: [a.release] },
          ],
          []
        )
      )
    ).toThrow(/cyclic/);
    expect(() => selectNitroPins(set([{ ...a, supersedes: ['missing'] }], []))).toThrow(
      /invalid Nitro supersession/
    );
  });
  it('accepts consistently ordered mixed-format history and selects/displays identically in all permutations', () => {
    const x = dual('dual-2026-01-01.1', '2026-01-01T00:00:00Z');
    const y = dual('dual-undated', '2026-02-01T00:00:00Z');
    const z = dual('dual-2026-03-01.1', '2026-03-01T00:00:00Z');
    for (const history of permutations([x, y, z])) {
      for (const order of permutations([x, y, z])) {
        const s = set(
          history,
          order.map((x) => x.release)
        );
        expect(selectNitroPins(s).mainnet?.release).toBe(z.release);
        expect(selectNitroPins(s).testnet?.release).toBe(z.release);
        expect(classifyNitroMeasurement(z, s).release).toBe(z.release);
        expect(dualNitroMeasurements(s).map((x) => x.release)).toEqual([
          z.release,
          y.release,
          x.release,
        ]);
      }
    }
  });
  it('accepts date priority with inverted timestamps when the complete relation is consistent', () => {
    expect(selectNitroPins(set([a, b])).mainnet?.release).toBe(b.release);
  });
  it('rejects unorderable numeric suffixes without changing finite legacy comparator behavior', () => {
    const huge = '9'.repeat(400);
    const broken = legacy(a);
    broken.release = `legacy-2026-01-01.${huge}`;
    const broken2 = { ...broken, release: 'other-2026-01-01.1' };
    expect(() => selectNitroPins(set([c], [], [broken, broken2]))).toThrow(
      /inconsistent Nitro release ordering/
    );
  });
});
