/**
 * Which committed Nitro measurement the server-side verifier accepts, and what
 * it says about every other measurement a document can carry.
 *
 * A PCR set is only worth pinning if somebody other than the build box can
 * re-derive it: check out the manifest's `git_commit`, run
 * deploy/nitro/build-enclave-eif.sh, compare. So the pin is derived, never
 * chosen by hand. For each network it is the newest morpheus-oracle manifest
 * whose `git_commit` is reachable, newest by release number compared
 * numerically (`.10` is newer than `.9`), and never a superseded one.
 *
 * Reachability cannot be decided at runtime, because a deployed server has no
 * git history. It is recorded in REPRODUCIBLE_NITRO_RELEASES instead, and
 * `npm run check:nitro-measurements` (CI job `measurements`, full history)
 * fails unless that list is exactly the committed morpheus-oracle manifests
 * whose `git_commit` HEAD descends from.
 *
 * Every committed manifest is a static import, never a directory scan or a
 * value from the request. Moving the pin is therefore a reviewed source change
 * and a new deployment, and the verifier can still name a document whose
 * measurement was recorded but cannot be rebuilt.
 */
import exec20260615 from '../../../deploy/nitro/measurements/oracle-enclave-exec-2026-06-15.json';
import exec20260615r2 from '../../../deploy/nitro/measurements/oracle-enclave-exec-2026-06-15.2.json';
import exec20260615r3 from '../../../deploy/nitro/measurements/oracle-enclave-exec-2026-06-15.3.json';
import exec20260615r4 from '../../../deploy/nitro/measurements/oracle-enclave-exec-2026-06-15.4.json';
import exec20260615r5 from '../../../deploy/nitro/measurements/oracle-enclave-exec-2026-06-15.5.json';
import exec20260615r9 from '../../../deploy/nitro/measurements/oracle-enclave-exec-2026-06-15.9.json';
import exec20260615r10 from '../../../deploy/nitro/measurements/oracle-enclave-exec-2026-06-15.10.json';
import testnet20260614r1 from '../../../deploy/nitro/measurements/oracle-enclave-testnet-2026-06-14.1.json';

/**
 * Committed morpheus-oracle manifests whose `git_commit` HEAD descends from.
 *
 * Empty since the measurements were first committed: none of the eight names a
 * commit that any branch or tag reaches, so none can be rebuilt and nothing is
 * pinned. The running mainnet enclave attests oracle-enclave-exec-2026-06-15.10
 * (1218f7c), which the verifier reports as measured-but-unreproducible. Do not
 * list it: the way out is a new EIF built from a pushed commit.
 */
export const REPRODUCIBLE_NITRO_RELEASES: readonly string[] = [];

export type NitroNetwork = 'mainnet' | 'testnet';

export interface NitroMeasurement {
  release: string;
  network: NitroNetwork;
  git_commit: string;
  built_at: string;
  superseded_by: string | null;
  pcr0: string;
  pcr1: string;
  pcr2: string;
}

export interface NitroMeasurementSet {
  measurements: readonly NitroMeasurement[];
  /** Releases whose `git_commit` a ref reaches. */
  reproducible: readonly string[];
}

export type NitroPins = Readonly<Record<NitroNetwork, NitroMeasurement | null>>;

/**
 * - `reproducible-match`: the PCRs equal the pin, so anybody can rebuild them.
 * - `measured-but-unreproducible`: the PCRs equal a committed manifest whose
 *   `git_commit` no ref reaches. The build box measured it; nobody else can.
 * - `mismatch`: anything else. No committed manifest carries the PCRs, the
 *   release is reproducible but is not the pin, or the document did not verify.
 */
export type NitroMeasurementVerdict =
  | 'reproducible-match'
  | 'measured-but-unreproducible'
  | 'mismatch';

export interface NitroMeasurementClassification {
  verdict: NitroMeasurementVerdict;
  /** The committed manifest whose PCR0, PCR1 and PCR2 all equal the document's. */
  release: string | null;
  network: NitroNetwork | null;
  git_commit: string | null;
  /** The pin for that manifest's network, or null when nothing there is reproducible. */
  pinned_release: string | null;
  detail: string;
}

export interface NitroPcrs {
  pcr0?: string | null;
  pcr1?: string | null;
  pcr2?: string | null;
}

const HEX48 = /^[0-9a-f]{96}$/;

function normalizePcr(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/^0x/i, '')
    .toLowerCase();
}

function requirePcr(value: unknown, release: string, name: string): string {
  const normalized = normalizePcr(value);
  if (!HEX48.test(normalized)) {
    throw new Error(`committed Nitro manifest ${release} has an invalid ${name}`);
  }
  return normalized;
}

function toMeasurement(raw: Record<string, unknown>): NitroMeasurement {
  const release = String(raw.release ?? '');
  if (raw.app_id !== 'morpheus-oracle') {
    throw new Error(`${release} is not a morpheus-oracle manifest`);
  }
  if (raw.network !== 'mainnet' && raw.network !== 'testnet') {
    throw new Error(`committed Nitro manifest ${release} names no known network`);
  }
  return Object.freeze({
    release,
    network: raw.network,
    git_commit: String(raw.git_commit ?? ''),
    built_at: String(raw.built_at ?? ''),
    superseded_by: typeof raw.superseded_by === 'string' ? raw.superseded_by : null,
    pcr0: requirePcr(raw.pcr0, release, 'pcr0'),
    pcr1: requirePcr(raw.pcr1, release, 'pcr1'),
    pcr2: requirePcr(raw.pcr2, release, 'pcr2'),
  });
}

/** Every committed morpheus-oracle manifest, in the order the files are named. */
export const COMMITTED_NITRO_MEASUREMENTS: readonly NitroMeasurement[] = Object.freeze(
  (
    [
      exec20260615,
      exec20260615r2,
      exec20260615r3,
      exec20260615r4,
      exec20260615r5,
      exec20260615r9,
      exec20260615r10,
      testnet20260614r1,
    ] as readonly Record<string, unknown>[]
  ).map(toMeasurement)
);

/** The trailing `YYYY-MM-DD[.N]` of a release id, as numbers. */
const RELEASE_DATE_SEQUENCE = /(\d{4})-(\d{2})-(\d{2})(?:\.(\d+))?$/;

function releaseOrdinal(release: string): number[] | null {
  const match = RELEASE_DATE_SEQUENCE.exec(release);
  if (!match) return null;
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    match[4] === undefined ? 0 : Number(match[4]),
  ];
}

/** Compares runs of digits as numbers, so `v10` sorts after `v9`. */
function compareNatural(left: string, right: string): number {
  const a = left.match(/\d+|\D+/g) ?? [];
  const b = right.match(/\d+|\D+/g) ?? [];
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] === b[index]) continue;
    if (/^\d/.test(a[index]) && /^\d/.test(b[index])) {
      const difference = Number(a[index]) - Number(b[index]);
      if (difference !== 0) return difference;
    }
    return a[index] < b[index] ? -1 : 1;
  }
  return a.length - b.length;
}

/**
 * Negative when `a` is the older release. The release date and sequence number
 * decide first, as numbers (`.10` after `.9`), whatever the id's prefix; then
 * the build time; then the id itself, digits compared as numbers.
 */
export function compareNitroReleases(a: NitroMeasurement, b: NitroMeasurement): number {
  const left = releaseOrdinal(a.release);
  const right = releaseOrdinal(b.release);
  if (left && right) {
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return left[index] - right[index];
    }
  }
  const built = Date.parse(a.built_at) - Date.parse(b.built_at);
  if (Number.isFinite(built) && built !== 0) return built;
  return compareNatural(a.release, b.release);
}

/**
 * The pin for each network: its newest reproducible, unsuperseded release.
 * Throws on a reproducible entry with no committed manifest, so a pin pointed
 * at a missing manifest fails at import rather than verifying against nothing.
 */
export function selectNitroPins(set: NitroMeasurementSet): NitroPins {
  const byRelease = new Map(set.measurements.map((entry) => [entry.release, entry]));
  const pins: Record<NitroNetwork, NitroMeasurement | null> = { mainnet: null, testnet: null };
  const seen = new Set<string>();
  for (const release of set.reproducible) {
    if (seen.has(release)) {
      throw new Error(`REPRODUCIBLE_NITRO_RELEASES lists ${release} twice`);
    }
    seen.add(release);
    const entry = byRelease.get(release);
    if (!entry) {
      throw new Error(
        `REPRODUCIBLE_NITRO_RELEASES names ${release}, which has no committed manifest under deploy/nitro/measurements/`
      );
    }
    // A verifier must not pin a superseded release (manifest.schema.json).
    if (entry.superseded_by) continue;
    const current = pins[entry.network];
    if (!current || compareNitroReleases(entry, current) > 0) pins[entry.network] = entry;
  }
  return Object.freeze(pins);
}

const COMMITTED_SET: NitroMeasurementSet = Object.freeze({
  measurements: COMMITTED_NITRO_MEASUREMENTS,
  reproducible: REPRODUCIBLE_NITRO_RELEASES,
});
// Validate at import: a broken pin must stop the verifier, not weaken it.
selectNitroPins(COMMITTED_SET);

let activeSet: NitroMeasurementSet = COMMITTED_SET;

/**
 * Replace the measurement set the verifier uses (TEST ONLY); pass `null` to
 * restore the committed one. Refused in production builds.
 */
export function __setNitroMeasurementSetForTest(set: NitroMeasurementSet | null): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('the Nitro measurement set cannot be replaced in production');
  }
  if (set) selectNitroPins(set);
  activeSet = set ?? COMMITTED_SET;
}

/** The pins the verifier compares documents against. */
export function nitroMeasurementPins(): NitroPins {
  return selectNitroPins(activeSet);
}

function shortCommit(commit: string): string {
  return commit.slice(0, 12);
}

/**
 * Name the committed measurement a document's PCRs equal, and say whether the
 * verifier can accept it. Only meaningful for a document whose signature and
 * certificate chain verified; the caller decides that.
 */
export function classifyNitroMeasurement(
  pcrs: NitroPcrs,
  set: NitroMeasurementSet = activeSet
): NitroMeasurementClassification {
  const pins = selectNitroPins(set);
  const reproducible = new Set(set.reproducible);
  const [pcr0, pcr1, pcr2] = [pcrs.pcr0, pcrs.pcr1, pcrs.pcr2].map(normalizePcr);
  const matches = set.measurements.filter(
    (entry) => entry.pcr0 === pcr0 && entry.pcr1 === pcr1 && entry.pcr2 === pcr2
  );
  const pinOf = (entry: NitroMeasurement) => pins[entry.network]?.release ?? null;
  const report = (
    verdict: NitroMeasurementVerdict,
    entry: NitroMeasurement | null,
    detail: string
  ): NitroMeasurementClassification => ({
    verdict,
    release: entry?.release ?? null,
    network: entry?.network ?? null,
    git_commit: entry?.git_commit ?? null,
    pinned_release: entry ? pinOf(entry) : null,
    detail,
  });

  const pinned = matches.find((entry) => pinOf(entry) === entry.release);
  if (pinned) {
    return report(
      'reproducible-match',
      pinned,
      `PCR0/1/2 equal ${pinned.release} (${pinned.network}), the newest release built from a commit the published history reaches (${shortCommit(pinned.git_commit)}); anybody can rebuild it and re-derive them.`
    );
  }
  const retired = matches.find((entry) => reproducible.has(entry.release));
  if (retired) {
    return report(
      'mismatch',
      retired,
      `PCR0/1/2 equal ${retired.release} (${retired.network}), which can be rebuilt but is not the ${retired.network} pin (${pinOf(retired) ?? 'none'}).`
    );
  }
  const unreproducible = matches[0];
  if (unreproducible) {
    return report(
      'measured-but-unreproducible',
      unreproducible,
      `PCR0/1/2 equal ${unreproducible.release} (${unreproducible.network}), which build-enclave-eif.sh measured from ${shortCommit(unreproducible.git_commit)}, a commit the published history does not reach, so nobody can rebuild the image and re-derive them. The ${unreproducible.network} pin is ${pinOf(unreproducible) ?? 'empty'}.`
    );
  }
  return report('mismatch', null, 'PCR0/1/2 match no committed measurement manifest.');
}

/** The verdict for a document whose signature or certificate chain did not verify. */
export const UNVERIFIED_NITRO_MEASUREMENT: NitroMeasurementClassification = Object.freeze({
  verdict: 'mismatch',
  release: null,
  network: null,
  git_commit: null,
  pinned_release: null,
  detail:
    'The document did not verify against the pinned AWS Nitro root, so its PCRs prove nothing.',
});
