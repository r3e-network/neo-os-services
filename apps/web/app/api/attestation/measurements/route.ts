/**
 * GET /api/attestation/measurements
 *
 * Serves the PUBLISHED, committed PCR manifest(s) for the Nitro Oracle EIF so a
 * consumer can fetch the expected PCR0/1/2 the attestation verifier compares
 * against. The manifests are produced on the build box by Phase 1's
 * `build-enclave-eif.sh` and committed under `deploy/nitro/measurements/<release>.json`;
 * this route only reads + returns them. It NEVER fabricates measurements — if
 * no manifest is committed yet, it returns an empty list (so the verifier has
 * nothing to trust rather than something fake).
 *
 * The committed in-repo copy is the source of truth (reviewable in git); this
 * endpoint is a convenience surface. The offline verifier should prefer the
 * committed manifest shipped as a static asset.
 *
 * Query params:
 *   ?network=mainnet|testnet  filter by manifest.network
 *   ?release=<id>             filter by manifest.release (returns one)
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { normalizeNetworkKey } from '@/lib/networks';

// Resolve `deploy/nitro/measurements` at RUNTIME (never as a bundler module
// import). The Next.js app runs from the repo's `apps/web` dir, so the manifest
// dir is two levels up; we walk up from process.cwd() to be robust to where the
// process is launched (and tolerate the directory not existing yet).
const MEASUREMENTS_REL = join('deploy', 'nitro', 'measurements');

function resolveMeasurementsDir(): string {
  let cur = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(cur, MEASUREMENTS_REL);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  // Fall back to repo-root relative to apps/web (cwd at runtime).
  return join(process.cwd(), '..', '..', MEASUREMENTS_REL);
}

const HEX48 = /^[0-9a-f]{96}$/;

interface MeasurementManifest {
  release: string;
  app_id: string;
  network: string;
  git_commit?: string;
  eif_sha256?: string;
  hash_algorithm: string;
  pcr0: string;
  pcr1: string;
  pcr2: string;
  pcr8?: string;
  built_at?: string;
}

function normalizePcr(value: unknown): string | null {
  const hex = String(value ?? '')
    .trim()
    .replace(/^0x/i, '')
    .toLowerCase();
  return HEX48.test(hex) ? hex : null;
}

/**
 * Validate a parsed JSON object is a well-formed measurement manifest. A
 * malformed/partial manifest is dropped (it would otherwise let the verifier
 * compare PCRs against garbage and silently fail closed for the wrong reason).
 */
function toManifest(raw: unknown): MeasurementManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const pcr0 = normalizePcr(record.pcr0);
  const pcr1 = normalizePcr(record.pcr1);
  const pcr2 = normalizePcr(record.pcr2);
  const release = String(record.release ?? '').trim();
  const network = String(record.network ?? '').trim();
  if (!pcr0 || !pcr1 || !pcr2 || !release || !network) return null;
  const pcr8 = normalizePcr(record.pcr8);
  return {
    release,
    app_id: String(record.app_id ?? 'morpheus-oracle').trim(),
    network,
    git_commit: record.git_commit ? String(record.git_commit).trim() : undefined,
    eif_sha256: record.eif_sha256 ? String(record.eif_sha256).trim() : undefined,
    hash_algorithm: String(record.hash_algorithm ?? 'SHA384').trim(),
    pcr0,
    pcr1,
    pcr2,
    pcr8: pcr8 ?? undefined,
    built_at: record.built_at ? String(record.built_at).trim() : undefined,
  };
}

function loadManifests(): MeasurementManifest[] {
  const dir = resolveMeasurementsDir();
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const manifests: MeasurementManifest[] = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      const manifest = toManifest(raw);
      if (manifest) manifests.push(manifest);
    } catch {
      // Skip unreadable/invalid manifest files.
    }
  }
  return manifests;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const networkFilter = normalizeNetworkKey(url.searchParams.get('network'));
  const releaseFilter = String(url.searchParams.get('release') ?? '').trim();

  let manifests = loadManifests();
  if (networkFilter) manifests = manifests.filter((m) => m.network === networkFilter);
  if (releaseFilter) manifests = manifests.filter((m) => m.release === releaseFilter);

  // Stable order: newest built_at first, then release id.
  manifests.sort((a, b) => {
    const at = Date.parse(b.built_at ?? '') - Date.parse(a.built_at ?? '');
    if (!Number.isNaN(at) && at !== 0) return at;
    return b.release.localeCompare(a.release);
  });

  return Response.json(
    {
      ok: true,
      count: manifests.length,
      hash_algorithm: 'SHA384',
      pinned_root_fingerprints_sha256: [
        // Mirror of AWS_NITRO_ROOT_FINGERPRINTS_SHA256 (kept inline so this
        // route has no import cycle with the verifier lib); the verifier asserts
        // the committed PEM against this value at load.
        '641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b',
      ],
      measurements: manifests,
      note:
        manifests.length === 0
          ? 'No PCR manifest committed yet. Manifests are produced by deploy/nitro/build-enclave-eif.sh on the build box and committed under deploy/nitro/measurements/.'
          : undefined,
    },
    { status: 200 }
  );
}
