/**
 * The Nitro verifier pin: which committed measurement the verifier accepts, and
 * what it says about every other one.
 *
 * The recorded document below is not synthetic. It is the body of a public GET
 * to the runtime attestation endpoint of the running mainnet oracle enclave,
 * recorded 2026-09-23, and it verifies against the production AWS Nitro
 * Enclaves Root G1 with no test root installed. It carries the PCRs of
 * oracle-enclave-exec-2026-06-15.10, built from 1218f7c, a commit no branch or
 * tag reaches, so nobody can rebuild that image.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import recorded from './attestation/recorded-mainnet-attestation-2026-09-23.json';
import {
  decodeNitroAttestationDocument,
  verifyNitroAttestationDocument,
} from './nitro-attestation';
import {
  COMMITTED_NITRO_MEASUREMENTS,
  REPRODUCIBLE_NITRO_RELEASES,
  classifyNitroMeasurement,
  compareNitroReleases,
  nitroMeasurementPins,
  selectNitroPins,
  __setNitroMeasurementSetForTest,
  type NitroMeasurement,
} from './nitro-measurements';
import { resetRateLimitMap } from './rate-limit';

const EXEC_10 = 'oracle-enclave-exec-2026-06-15.10';
const EXEC_9 = 'oracle-enclave-exec-2026-06-15.9';
const EXEC_10_COMMIT = '1218f7c2989f445dfadcfe8218d63865d2f2b423';

const document = recorded.response.attestation_document;
const decoded = decodeNitroAttestationDocument(document);
const documentPcrs = {
  pcr0: decoded.pcrs.get(0)?.toString('hex') ?? null,
  pcr1: decoded.pcrs.get(1)?.toString('hex') ?? null,
  pcr2: decoded.pcrs.get(2)?.toString('hex') ?? null,
};

function committed(release: string): NitroMeasurement {
  const found = COMMITTED_NITRO_MEASUREMENTS.find((entry) => entry.release === release);
  if (!found) throw new Error(`${release} is not a committed measurement`);
  return found;
}

function measurement(overrides: Partial<NitroMeasurement>): NitroMeasurement {
  return {
    release: 'oracle-fixture-2026-09-21.1',
    network: 'mainnet',
    git_commit: 'a'.repeat(40),
    built_at: '2026-09-21T00:00:00Z',
    superseded_by: null,
    pcr0: '1'.repeat(96),
    pcr1: '2'.repeat(96),
    pcr2: '3'.repeat(96),
    ...overrides,
  };
}

/**
 * The lane shape the verify route binds a document to: the enclave commits the
 * result's output_hash into the document nonce. The recorded document's nonce
 * is a 32-byte value, so it can stand in for an output hash and the request
 * below is refused or accepted on its measurement alone.
 */
function laneRequest() {
  const outputHash = recorded.response.nonce;
  return {
    verification: {
      output_hash: `0x${outputHash}`,
      attestation_hash: `0x${outputHash}`,
      tee_attestation: {
        runtime: 'aws-nitro',
        report_data: `0x${outputHash}`,
        quote: 'present',
        event_log: [],
      },
    },
    attestation_document: document,
    expected_output_hash: outputHash,
  };
}

async function postVerify(body: unknown) {
  const { POST } = await import('@/app/api/attestation/verify/route');
  const response = await POST(
    new Request('http://x/api/attestation/verify', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe('the committed Nitro measurement set', () => {
  it('lists no reproducible release, because no committed manifest names a reachable commit', () => {
    expect(REPRODUCIBLE_NITRO_RELEASES).toEqual([]);
  });

  it('therefore pins nothing on either network', () => {
    expect(nitroMeasurementPins()).toEqual({ mainnet: null, testnet: null });
  });

  it('imports every committed morpheus-oracle manifest, and nothing else', () => {
    const dir = fileURLToPath(new URL('../../../deploy/nitro/measurements/', import.meta.url));
    const onDisk = readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .filter((file) => file !== 'manifest.schema.json' && file !== 'example.json')
      .map((file) => JSON.parse(readFileSync(`${dir}${file}`, 'utf8')))
      .filter((manifest) => manifest.app_id === 'morpheus-oracle')
      .map((manifest) => manifest.release)
      .sort();
    expect(COMMITTED_NITRO_MEASUREMENTS.map((entry) => entry.release).sort()).toEqual(onDisk);
    expect(onDisk).toHaveLength(8);
  });

  it('reports every committed measurement as measured-but-unreproducible', () => {
    for (const entry of COMMITTED_NITRO_MEASUREMENTS) {
      const result = classifyNitroMeasurement(entry);
      expect(result.verdict, entry.release).toBe('measured-but-unreproducible');
      expect(result.release).toBe(entry.release);
      expect(result.git_commit).toBe(entry.git_commit);
      expect(result.pinned_release).toBeNull();
    }
  });

  it('reports PCRs that no committed manifest carries as a mismatch', () => {
    expect(
      classifyNitroMeasurement({
        pcr0: 'ab'.repeat(48),
        pcr1: 'cd'.repeat(48),
        pcr2: 'ef'.repeat(48),
      })
    ).toMatchObject({ verdict: 'mismatch', release: null, pinned_release: null });
  });

  it('matches all three PCRs, not PCR0 alone', () => {
    const exec10 = committed(EXEC_10);
    const exec9 = committed(EXEC_9);
    expect(
      classifyNitroMeasurement({ pcr0: exec10.pcr0, pcr1: exec10.pcr1, pcr2: exec9.pcr2 }).verdict
    ).toBe('mismatch');
    expect(classifyNitroMeasurement({ pcr0: exec10.pcr0, pcr1: null, pcr2: null }).verdict).toBe(
      'mismatch'
    );
  });
});

describe('the recorded live mainnet document', () => {
  it('is genuine: it verifies against the production AWS root and the .10 manifest', async () => {
    const exec10 = committed(EXEC_10);
    const result = await verifyNitroAttestationDocument(document, {
      expectedPcrs: { pcr0: exec10.pcr0, pcr1: exec10.pcr1, pcr2: exec10.pcr2 },
      nonce: recorded.response.nonce,
      expectedSignerPublicKey: recorded.response.public_key,
      now: decoded.timestamp,
    });
    expect(result.errors).toEqual([]);
    expect(result.root_pinned_ok).toBe(true);
    expect(result.measurement_chain_verified).toBe(true);
  });

  it('carries the .10 measurement, which nobody can rebuild', () => {
    expect(classifyNitroMeasurement(documentPcrs)).toEqual({
      verdict: 'measured-but-unreproducible',
      release: EXEC_10,
      network: 'mainnet',
      git_commit: EXEC_10_COMMIT,
      pinned_release: null,
      detail: expect.stringContaining('the published history does not reach'),
    });
  });
});

describe('the verify route on the recorded live mainnet document', () => {
  beforeEach(() => {
    resetRateLimitMap();
    // Fresh as of the moment it was recorded, so freshness cannot be the reason.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(decoded.timestamp + 1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    __setNitroMeasurementSetForTest(null);
  });

  it('reports measured-but-unreproducible and refuses it, instead of a PCR mismatch', async () => {
    const { status, json } = await postVerify(laneRequest());

    expect(json.measurement_verdict).toBe('measured-but-unreproducible');
    expect(json.measurement).toMatchObject({
      verdict: 'measured-but-unreproducible',
      release: EXEC_10,
      network: 'mainnet',
      git_commit: EXEC_10_COMMIT,
      pinned_release: null,
    });
    expect(json.pinned_nitro_release).toBeNull();
    expect(json.pinned_nitro_releases).toEqual({ mainnet: null, testnet: null });

    const nitro = json.nitro_attestation as Record<string, unknown>;
    expect(nitro.cose_signature_ok).toBe(true);
    expect(nitro.cert_chain_ok).toBe(true);
    expect(nitro.root_pinned_ok).toBe(true);
    expect(nitro.timestamp_fresh).toBe(true);
    expect(nitro.nonce_match).toBe(true);
    expect(nitro.errors).not.toContain('PCR0 mismatch');
    expect(nitro.errors).not.toContain('PCR2 mismatch');

    // Not accepted: the enclave that is running cannot be rebuilt.
    expect(nitro.measurement_chain_verified).toBe(false);
    expect(json.full_attestation_ok).toBe(false);
    expect(status).toBe(400);
  });

  it('would be a reproducible-match only if .10 were listed as reproducible', async () => {
    // Counterfactual set: the same eight manifests, with .10's commit treated as
    // reachable. The request is byte-identical to the one refused above, so the
    // reproducibility record is the only thing between this document and
    // acceptance.
    __setNitroMeasurementSetForTest({
      measurements: COMMITTED_NITRO_MEASUREMENTS,
      reproducible: [EXEC_10],
    });
    const { status, json } = await postVerify(laneRequest());

    expect(json.measurement_verdict).toBe('reproducible-match');
    expect(json.pinned_nitro_release).toBe(EXEC_10);
    expect((json.nitro_attestation as Record<string, unknown>).measurement_chain_verified).toBe(
      true
    );
    expect(json.full_attestation_ok).toBe(true);
    expect(status).toBe(200);
  });

  it('calls a reproducible release that is not the newest one a mismatch', async () => {
    const newer = measurement({ release: 'oracle-enclave-exec-2026-06-15.11' });
    __setNitroMeasurementSetForTest({
      measurements: [...COMMITTED_NITRO_MEASUREMENTS, newer],
      reproducible: [EXEC_10, newer.release],
    });
    const { status, json } = await postVerify(laneRequest());

    expect(json.measurement_verdict).toBe('mismatch');
    expect(json.measurement).toMatchObject({ release: EXEC_10, pinned_release: newer.release });
    expect(json.full_attestation_ok).toBe(false);
    expect(status).toBe(400);
  });

  it('never classifies a document that does not verify', async () => {
    const tampered = Buffer.from(document, 'base64');
    tampered[tampered.length - 1] ^= 0x01; // flip one bit of the COSE signature
    const { json } = await postVerify({
      ...laneRequest(),
      attestation_document: tampered.toString('base64'),
    });

    expect((json.nitro_attestation as Record<string, unknown>).cose_signature_ok).toBe(false);
    expect(json.measurement_verdict).toBe('mismatch');
    expect(json.measurement).toMatchObject({ release: null });
    expect(json.full_attestation_ok).toBe(false);
  });

  it('reports no verdict when there is no document to measure', async () => {
    const { json } = await postVerify({ verification: { output_hash: '0x' + 'ab'.repeat(32) } });
    expect(json.measurement_verdict).toBeNull();
    expect(json.measurement).toBeNull();
  });
});

describe('choosing the pin', () => {
  it('orders release numbers numerically, so .10 is newer than .9 and .2', () => {
    const release = (id: string) => measurement({ release: id });
    const ordered = ['.10', '.9', '.2', ''].map((suffix) =>
      release(`oracle-enclave-exec-2026-06-15${suffix}`)
    );
    const sorted = [...ordered].sort(compareNitroReleases).map((entry) => entry.release);
    expect(sorted).toEqual([
      'oracle-enclave-exec-2026-06-15',
      'oracle-enclave-exec-2026-06-15.2',
      'oracle-enclave-exec-2026-06-15.9',
      'oracle-enclave-exec-2026-06-15.10',
    ]);
  });

  it('orders by release date before naming prefix', () => {
    const older = measurement({ release: 'oracle-enclave-testnet-2026-06-14.1' });
    const newer = measurement({ release: 'oracle-enclave-exec-2026-06-15.3' });
    expect(compareNitroReleases(older, newer)).toBeLessThan(0);
    expect(compareNitroReleases(newer, older)).toBeGreaterThan(0);
  });

  it('pins the newest reproducible release, sorted numerically', () => {
    const pins = selectNitroPins({
      measurements: COMMITTED_NITRO_MEASUREMENTS,
      reproducible: [EXEC_9, EXEC_10],
    });
    expect(pins.mainnet?.release).toBe(EXEC_10);
    expect(pins.testnet).toBeNull();
  });

  it('skips a newer release whose commit is not reachable', () => {
    const pins = selectNitroPins({
      measurements: COMMITTED_NITRO_MEASUREMENTS,
      reproducible: [EXEC_9],
    });
    expect(pins.mainnet?.release).toBe(EXEC_9);
  });

  it('pins each network separately', () => {
    const pins = selectNitroPins({
      measurements: COMMITTED_NITRO_MEASUREMENTS,
      reproducible: [EXEC_10, 'oracle-enclave-exec-2026-06-15.3'],
    });
    expect(pins.mainnet?.release).toBe(EXEC_10);
    expect(pins.testnet?.release).toBe('oracle-enclave-exec-2026-06-15.3');
  });

  it('never pins a superseded release', () => {
    const pins = selectNitroPins({
      measurements: COMMITTED_NITRO_MEASUREMENTS,
      reproducible: ['oracle-enclave-testnet-2026-06-14.1'],
    });
    expect(pins.testnet).toBeNull();
  });

  it('refuses a reproducible entry with no committed manifest', () => {
    expect(() =>
      selectNitroPins({ measurements: COMMITTED_NITRO_MEASUREMENTS, reproducible: ['oracle-gone'] })
    ).toThrow(/oracle-gone/);
  });

  it('refuses the same release listed twice', () => {
    expect(() =>
      selectNitroPins({
        measurements: COMMITTED_NITRO_MEASUREMENTS,
        reproducible: [EXEC_9, EXEC_9],
      })
    ).toThrow(/twice/);
  });
});
