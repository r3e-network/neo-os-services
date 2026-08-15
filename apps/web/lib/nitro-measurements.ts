/**
 * Explicitly reviewed Nitro measurement pin used by the server-side verifier.
 *
 * This is intentionally a static import of one committed manifest rather than
 * a directory scan or a value supplied by the request. Rotating an EIF therefore
 * requires a reviewed source change and a new deployment.
 */
import manifest from '../../../deploy/nitro/measurements/oracle-enclave-exec-2026-06-15.9.json';

export interface PinnedNitroMeasurement {
  release: string;
  network: string;
  pcr0: string;
  pcr1: string;
  pcr2: string;
}

const HEX48 = /^[0-9a-f]{96}$/;

function requirePcr(value: unknown, name: string): string {
  const normalized = String(value ?? '')
    .trim()
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!HEX48.test(normalized)) {
    throw new Error(`pinned Nitro manifest has invalid ${name}`);
  }
  return normalized;
}

export const ACTIVE_NITRO_MEASUREMENT: PinnedNitroMeasurement = Object.freeze({
  release: String(manifest.release),
  network: String(manifest.network),
  pcr0: requirePcr(manifest.pcr0, 'pcr0'),
  pcr1: requirePcr(manifest.pcr1, 'pcr1'),
  pcr2: requirePcr(manifest.pcr2, 'pcr2'),
});
