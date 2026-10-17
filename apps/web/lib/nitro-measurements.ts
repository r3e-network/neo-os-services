import { parseDualNitroMeasurement, type DualNitroMeasurement } from './nitro-dual-measurement';
import { COMMITTED_DUAL_NITRO_MEASUREMENTS } from './nitro-dual-release-registry';

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

export type NitroImageMeasurement = NitroMeasurement | DualNitroMeasurement;

export interface NitroMeasurementSet {
  /** Complete registered dual history, not a current-pin allowlist. */
  dual_measurements?: readonly unknown[];
  measurements: readonly NitroMeasurement[];
  /** Releases whose `git_commit` a ref reaches. */
  reproducible: readonly string[];
}

export type NitroPins = Readonly<Record<NitroNetwork, NitroImageMeasurement | null>>;

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
  /** Present only for a shared dual image; membership is not attested network proof. */
  networks?: readonly NitroNetwork[];
  eligible_networks?: readonly NitroNetwork[];
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
export function compareNitroReleases(
  a: Pick<NitroMeasurement, 'release' | 'built_at'>,
  b: Pick<NitroMeasurement, 'release' | 'built_at'>
): number {
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
function imageNetworks(entry: NitroImageMeasurement): readonly NitroNetwork[] {
  return entry.network === null ? entry.networks : [entry.network];
}

/**
 * The inherited comparator chooses dates only when BOTH IDs carry a date.
 * That relation can be non-transitive across mixed ID formats. Do not change
 * legacy-only semantics: instead require a strict total order over the complete
 * registered history whenever a dual image participates, even if unselected.
 */
function requireConsistentDualHistoryOrder(entries: readonly NitroImageMeasurement[]): void {
  const ordered = [...entries].sort(compareNitroReleases);
  for (let left = 0; left < ordered.length; left += 1) {
    for (let right = left + 1; right < ordered.length; right += 1) {
      const forward = compareNitroReleases(ordered[left], ordered[right]);
      const backward = compareNitroReleases(ordered[right], ordered[left]);
      // Checking every pair, not just adjacent entries, establishes a total
      // order for this accepted set. Sorting alone cannot prove transitivity.
      if (
        !Number.isFinite(forward) ||
        !Number.isFinite(backward) ||
        forward >= 0 ||
        backward <= 0
      ) {
        throw new Error('inconsistent Nitro release ordering in dual history');
      }
    }
  }
}

/** Validate the entire registered supersedes graph, independently of pin eligibility. */
function requireAcyclicDualHistory(entries: readonly NitroImageMeasurement[]): void {
  const incoming = new Map(entries.map((entry) => [entry.release, 0]));
  const edges = new Map(
    entries.map((entry) => [entry.release, entry.network === null ? entry.supersedes : []])
  );
  for (const [release, targets] of edges) {
    for (const target of targets) {
      if (!incoming.has(target))
        throw new Error(`invalid Nitro supersession ${release} -> ${target}`);
      incoming.set(target, incoming.get(target)! + 1);
    }
  }
  const ready = [...incoming].filter(([, count]) => count === 0).map(([release]) => release);
  for (let index = 0; index < ready.length; index += 1) {
    for (const target of edges.get(ready[index])!) {
      const remaining = incoming.get(target)! - 1;
      incoming.set(target, remaining);
      if (remaining === 0) ready.push(target);
    }
  }
  if (ready.length !== entries.length) throw new Error('cyclic Nitro supersession');
}

function registeredHistory(set: NitroMeasurementSet): {
  entries: NitroImageMeasurement[];
  retired: Set<string>;
} {
  const entries = [
    ...set.measurements,
    ...(set.dual_measurements ?? []).map(parseDualNitroMeasurement),
  ];
  const byRelease = new Map<string, NitroImageMeasurement>();
  for (const entry of entries) {
    if (byRelease.has(entry.release))
      throw new Error(`duplicate Nitro release ID ${entry.release}`);
    byRelease.set(entry.release, entry);
  }
  if (entries.some((entry) => entry.network === null)) {
    requireAcyclicDualHistory(entries);
    requireConsistentDualHistoryOrder(entries);
  }
  const retired = new Set<string>();
  for (const entry of entries) {
    if (entry.network !== null) {
      if (entry.superseded_by) retired.add(entry.release);
      continue;
    }
    for (const id of entry.supersedes) {
      const target = byRelease.get(id);
      // Ordering and graph acyclicity were validated independently above.
      if (
        !target ||
        compareNitroReleases(target, entry) >= 0 ||
        !imageNetworks(target).every((network) => entry.networks.includes(network))
      ) {
        throw new Error(`invalid Nitro supersession ${entry.release} -> ${id}`);
      }
      // Retirement is independent of whether the superseding entry is eligible.
      retired.add(id);
    }
  }
  return { entries, retired };
}

export function selectNitroPins(set: NitroMeasurementSet): NitroPins {
  const { entries, retired } = registeredHistory(set);
  const byRelease = new Map(entries.map((entry) => [entry.release, entry]));
  const pins: Record<NitroNetwork, NitroImageMeasurement | null> = { mainnet: null, testnet: null };
  const seen = new Set<string>();
  for (const release of set.reproducible) {
    if (seen.has(release)) throw new Error(`REPRODUCIBLE_NITRO_RELEASES lists ${release} twice`);
    seen.add(release);
    const entry = byRelease.get(release);
    if (!entry)
      throw new Error(
        `REPRODUCIBLE_NITRO_RELEASES names ${release}, which has no committed manifest under deploy/nitro/measurements/`
      );
    if (retired.has(release)) continue;
    for (const network of imageNetworks(entry)) {
      const current = pins[network];
      if (!current || compareNitroReleases(entry, current) > 0) pins[network] = entry;
    }
  }
  return Object.freeze(pins);
}

const COMMITTED_SET: NitroMeasurementSet = Object.freeze({
  measurements: COMMITTED_NITRO_MEASUREMENTS,
  dual_measurements: COMMITTED_DUAL_NITRO_MEASUREMENTS,
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
  const history = registeredHistory(set).entries;
  const matches = history.filter(
    (entry) => entry.pcr0 === pcr0 && entry.pcr1 === pcr1 && entry.pcr2 === pcr2
  );
  // Preserve legacy-only behavior; mixed/dual history uses deterministic newest display.
  if (set.dual_measurements?.length) matches.sort((a, b) => compareNitroReleases(b, a));
  const eligible = (entry: NitroImageMeasurement) =>
    imageNetworks(entry).filter((network) => pins[network]?.release === entry.release);
  const pinOf = (entry: NitroImageMeasurement) =>
    entry.network === null
      ? eligible(entry).length
        ? entry.release
        : null
      : (pins[entry.network]?.release ?? null);
  const report = (
    verdict: NitroMeasurementVerdict,
    entry: NitroImageMeasurement | null,
    detail: string
  ): NitroMeasurementClassification => ({
    verdict,
    release: entry?.release ?? null,
    network: entry?.network ?? null,
    git_commit: entry?.git_commit ?? null,
    pinned_release: entry ? pinOf(entry) : null,
    detail,
    ...(entry?.network === null
      ? { networks: entry.networks, eligible_networks: eligible(entry) }
      : {}),
  });

  const active = matches.filter((entry) => eligible(entry).length > 0);
  if (active.length > 1 && active.some((entry) => entry.network === null)) {
    return report(
      'mismatch',
      null,
      'PCR0/1/2 match distinct active image identities involving a dual release; network and release identity are ambiguous.'
    );
  }
  const pinned = active[0];
  if (pinned) {
    return report(
      'reproducible-match',
      pinned,
      pinned.network === null
        ? `PCR0/1/2 equal current shared image ${pinned.release}; eligible networks: ${eligible(pinned).join(', ')}. Image membership does not prove a request network or the exact running source commit.`
        : `PCR0/1/2 equal ${pinned.release} (${pinned.network}), the newest release built from a commit the published history reaches (${shortCommit(pinned.git_commit)}); anybody can rebuild it and re-derive them.`
    );
  }
  const retired = matches.find((entry) => reproducible.has(entry.release));
  if (retired) {
    return report(
      'mismatch',
      retired,
      retired.network === null
        ? `PCR0/1/2 equal historical shared image ${retired.release}, which is reproducible but is not a current pin on either network.`
        : `PCR0/1/2 equal ${retired.release} (${retired.network}), which can be rebuilt but is not the ${retired.network} pin (${pinOf(retired) ?? 'none'}).`
    );
  }
  const unreproducible = matches[0];
  if (unreproducible) {
    return report(
      'measured-but-unreproducible',
      unreproducible,
      unreproducible.network === null
        ? `PCR0/1/2 equal historical shared image ${unreproducible.release}, which is not listed as reproducible; image membership proves no network.`
        : `PCR0/1/2 equal ${unreproducible.release} (${unreproducible.network}), which build-enclave-eif.sh measured from ${shortCommit(unreproducible.git_commit)}, a commit the published history does not reach, so nobody can rebuild the image and re-derive them. The ${unreproducible.network} pin is ${pinOf(unreproducible) ?? 'empty'}.`
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

/** Versioned shared-image history. Query filtering must not change pin selection. */
export function dualNitroMeasurements(set: NitroMeasurementSet = activeSet) {
  const pins = selectNitroPins(set);
  return registeredHistory(set)
    .entries.filter((entry): entry is DualNitroMeasurement => entry.network === null)
    .sort((a, b) => compareNitroReleases(b, a))
    .map((entry) => ({
      ...entry,
      eligible_networks: imageNetworks(entry).filter(
        (network) => pins[network]?.release === entry.release
      ),
    }));
}
