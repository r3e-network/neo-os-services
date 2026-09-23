/**
 * Measurement-publication gate for the Nitro enclaves.
 *
 * The attested-custody claim rests on one number: the PCR0 of the EIF that
 * actually runs. Three artifacts have to agree on it, and until this gate
 * existed nothing compared them:
 *
 *   1. deploy/nitro/measurements/<release>.json — what the build measured.
 *   2. the CMK key policy's `kms:RecipientAttestation:ImageSha384` condition —
 *      the only thing that actually stops the parent instance from decrypting
 *      the master key (workers/neo-signer/src/attestation.rs:9-20 deliberately
 *      leaves SIGNER_SERVICE_EXPECTED_PCR0 unset and delegates to it).
 *   3. the verifier pin a relying party reads (apps/web/lib/nitro-measurements.ts).
 *
 * A policy that lives only inside an AWS account cannot be diffed by anybody
 * outside it, so this gate requires the policy to be exported into the tree and
 * compared against the manifest — and, where that has not happened yet, requires
 * a dated, owned, expiring record saying so. Absence is a finding; an
 * undocumented absence is a hard failure.
 *
 * The verifier pins, per network, the newest release it lists in
 * REPRODUCIBLE_NITRO_RELEASES. A deployed verifier has no git history, so that
 * list is the only place reachability can live, and rule 5 is what keeps it
 * true: it must name exactly the committed morpheus-oracle manifests whose
 * git_commit HEAD descends from, each of them committed.
 *
 * Exported as functions so the suite can drive each rule against a throwaway
 * tree; run as a CLI it audits the repository it lives in.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Every enclave whose measurement a relying party has to be able to check. */
export const REQUIRED_APP_IDS = Object.freeze(['morpheus-oracle', 'morpheus-custody']);

/**
 * Manifests built on or after this instant must carry `reproducible_verified`.
 * The nine manifests already in the tree predate the reproducibility gate
 * (built 2026-06-14/15, before `--verify-reproducible` defaulted on), so the
 * rule is dated rather than retroactive: it binds every new release without
 * pretending the old ones were re-derived.
 */
export const REPRODUCIBILITY_REQUIRED_FROM = '2026-09-21T00:00:00Z';

/** Inputs that change what the enclave measures. */
export const BUILD_INPUT_PATHS = Object.freeze([
  'deploy/nitro/Dockerfile.enclave',
  'deploy/nitro/Dockerfile.signer',
  'Cargo.lock',
]);
const BUILD_INPUT_PREFIXES = Object.freeze(['vendor/']);

const MEASUREMENTS_DIR = 'deploy/nitro/measurements';
const KMS_DIR = 'deploy/nitro/kms';
const PINS_FILE = `${KMS_DIR}/attestation-pins.json`;
const SCHEMA_FILE = `${MEASUREMENTS_DIR}/manifest.schema.json`;
/** Documentation fixture: schema-valid on purpose, never a release. */
const DOC_FIXTURES = new Set(['example.json']);
const NON_MANIFEST_FILES = new Set(['manifest.schema.json']);

const HEX96 = /^[0-9a-f]{96}$/;
const ZERO_PCR = '0'.repeat(96);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** Only a full object id names a commit; `HEAD` or a branch name would resolve to anything. */
const FULL_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Where the verifier declares which releases it may pin (rule 5). */
const VERIFIER_PIN_FILE = 'apps/web/lib/nitro-measurements.ts';
const VERIFIER_PIN_NAME = 'REPRODUCIBLE_NITRO_RELEASES';
const VERIFIER_PIN_DECLARATION =
  /^export const REPRODUCIBLE_NITRO_RELEASES: readonly string\[\] = \[([^\]]*)\];/m;
const VERIFIER_APP_ID = 'morpheus-oracle';

/** Enclaves launched in debug mode report all-zero PCRs; see CL-29. */
const DEBUG_LAUNCH_FLAGS = Object.freeze([`--debug${'-'}mode`, `--attach${'-'}console`]);
const DEBUG_SCAN_ROOTS = Object.freeze(['deploy', 'scripts']);
const DEBUG_SCAN_EXTENSIONS = Object.freeze([
  '.sh',
  '.mjs',
  '.js',
  '.ts',
  '.yml',
  '.yaml',
  '.service',
  '.conf',
  '.env',
]);
const DEBUG_SCAN_SKIP_DIRS = new Set([
  'node_modules',
  'target',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
]);
/** This file and its suite name the flags in order to forbid them. */
const DEBUG_SCAN_SKIP_FILES = new Set([
  'scripts/check-nitro-measurements.mjs',
  'scripts/check-nitro-measurements.test.mjs',
]);

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePcr(value) {
  return String(value ?? '')
    .trim()
    .replace(/^0x/i, '')
    .toLowerCase();
}

/**
 * The subset of JSON Schema draft 2020-12 that manifest.schema.json uses.
 *
 * Deliberately hand-written rather than pulled from a dependency: this runs in
 * the trust path of a measurement pin, and the repository's only resident ajv
 * is a transitive draft-07 copy owned by eslint.
 */
export function validateManifestSchema(value, schema, label = 'manifest') {
  const problems = [];
  if (!isPlainObject(value)) {
    return [`${label}: expected a JSON object`];
  }
  for (const key of schema.required ?? []) {
    if (!(key in value)) problems.push(`${label}: missing required property ${key}`);
  }
  const properties = schema.properties ?? {};
  for (const [key, entry] of Object.entries(value)) {
    const spec = properties[key];
    if (!spec) {
      if (schema.additionalProperties === false) {
        problems.push(`${label}: unknown property ${key} is not allowed by the schema`);
      }
      continue;
    }
    problems.push(...validateProperty(entry, spec, `${label}.${key}`));
  }
  return problems;
}

function validateProperty(value, spec, label) {
  const problems = [];
  const types = Array.isArray(spec.type) ? spec.type : spec.type ? [spec.type] : [];
  if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
    return [`${label}: expected type ${types.join('|')}, got ${describe(value)}`];
  }
  if (value === null) return problems;
  if (spec.enum && !spec.enum.includes(value)) {
    problems.push(`${label}: ${JSON.stringify(value)} is not one of ${spec.enum.join(', ')}`);
  }
  if (spec.const !== undefined && value !== spec.const) {
    problems.push(
      `${label}: expected the constant ${JSON.stringify(spec.const)}, got ${JSON.stringify(value)}`
    );
  }
  if (typeof value === 'string') {
    if (spec.pattern && !new RegExp(spec.pattern).test(value)) {
      problems.push(`${label}: ${JSON.stringify(value)} does not match ${spec.pattern}`);
    }
    if (typeof spec.minLength === 'number' && value.length < spec.minLength) {
      problems.push(`${label}: shorter than the required ${spec.minLength} characters`);
    }
    if (spec.format === 'date-time' && !Number.isFinite(Date.parse(value))) {
      problems.push(`${label}: ${JSON.stringify(value)} is not an ISO-8601 timestamp`);
    }
  }
  return problems;
}

function matchesType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'object') return isPlainObject(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number';
  return true;
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Every committed manifest, keyed by release id. */
export function loadManifests(root = REPO_ROOT) {
  const dir = join(root, MEASUREMENTS_DIR);
  const found = new Map();
  const problems = [];
  if (!existsSync(dir)) {
    return { manifests: found, problems: [`${MEASUREMENTS_DIR}/ is missing`] };
  }
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.json') || NON_MANIFEST_FILES.has(file)) continue;
    let data;
    try {
      data = readJson(join(dir, file));
    } catch (error) {
      problems.push(`${MEASUREMENTS_DIR}/${file}: not parseable JSON (${error.message})`);
      continue;
    }
    found.set(file, { file, data, fixture: DOC_FIXTURES.has(file) });
  }
  return { manifests: found, problems };
}

/**
 * Rule 1: every committed manifest is schema-valid, names itself, carries real
 * PCRs, and — once past the reproducibility cutover — says its PCRs were
 * re-derived from an independent build.
 */
export function auditManifests(root = REPO_ROOT) {
  const schemaPath = join(root, SCHEMA_FILE);
  if (!existsSync(schemaPath)) return [`${SCHEMA_FILE} is missing`];
  let schema;
  try {
    schema = readJson(schemaPath);
  } catch (error) {
    return [`${SCHEMA_FILE}: not parseable JSON (${error.message})`];
  }
  const { manifests, problems } = loadManifests(root);
  const cutover = Date.parse(REPRODUCIBILITY_REQUIRED_FROM);
  for (const { file, data, fixture } of manifests.values()) {
    const label = `${MEASUREMENTS_DIR}/${file}`;
    const schemaProblems = validateManifestSchema(data, schema, label);
    problems.push(...schemaProblems);
    if (schemaProblems.length > 0) continue;
    if (!fixture && `${data.release}.json` !== file) {
      problems.push(
        `${label}: release id ${JSON.stringify(data.release)} does not match the filename; a verifier that pins a filename would pin a different release`
      );
    }
    for (const name of ['pcr0', 'pcr1', 'pcr2']) {
      if (normalizePcr(data[name]) === ZERO_PCR) {
        problems.push(
          `${label}: ${name} is the all-zero placeholder, which is what a debug-mode enclave reports — no KMS condition built on it binds anything`
        );
      }
    }
    if (fixture) continue;
    const builtAt = Date.parse(data.built_at);
    if (Number.isFinite(builtAt) && builtAt >= cutover && data.reproducible_verified !== true) {
      problems.push(
        `${label}: built ${data.built_at}, on or after ${REPRODUCIBILITY_REQUIRED_FROM}, so it must set reproducible_verified: true — rebuild with deploy/nitro/build-enclave-eif.sh (reproducibility is the default) instead of --allow-unverified`
      );
    }
  }
  return problems;
}

/** Pull every `kms:RecipientAttestation:ImageSha384` condition out of a key policy. */
export function extractAttestationConditions(policy) {
  const statements = Array.isArray(policy?.Statement) ? policy.Statement : [];
  const found = [];
  for (const statement of statements) {
    const condition = statement?.Condition;
    if (!isPlainObject(condition)) continue;
    for (const [operator, entries] of Object.entries(condition)) {
      if (!isPlainObject(entries)) continue;
      for (const [key, raw] of Object.entries(entries)) {
        if (key.toLowerCase() !== 'kms:recipientattestation:imagesha384') continue;
        for (const value of Array.isArray(raw) ? raw : [raw]) {
          found.push({
            sid: statement.Sid ?? '(unnamed statement)',
            effect: statement.Effect,
            operator,
            value: normalizePcr(value),
          });
        }
      }
    }
  }
  return found;
}

/**
 * Rule 2: the exported key policy and the committed manifest name the same
 * PCR0, and every enclave that has neither is recorded as unpublished with an
 * owner and a deadline that has not passed.
 */
export function auditAttestationPins(root = REPO_ROOT, { today = null } = {}) {
  const pinsPath = join(root, PINS_FILE);
  if (!existsSync(pinsPath)) {
    return [
      `${PINS_FILE} is missing; without it no relying party can tell which key policy gates the enclave's master key`,
    ];
  }
  let doc;
  try {
    doc = readJson(pinsPath);
  } catch (error) {
    return [`${PINS_FILE}: not parseable JSON (${error.message})`];
  }
  const problems = [];
  const requiredAppIds = Array.isArray(doc.required_app_ids) ? doc.required_app_ids : [];
  if (requiredAppIds.length === 0) {
    problems.push(
      `${PINS_FILE}: required_app_ids must list the enclaves that need a published pin`
    );
  }
  const { manifests } = loadManifests(root);
  const byRelease = new Map();
  for (const entry of manifests.values()) {
    if (!entry.fixture) byRelease.set(entry.data.release, entry.data);
  }

  const pinned = new Set();
  for (const [index, pin] of (Array.isArray(doc.pins) ? doc.pins : []).entries()) {
    const label = `${PINS_FILE} pins[${index}]`;
    const missing = ['app_id', 'key_alias', 'key_arn', 'policy_file', 'pinned_release'].filter(
      (field) => typeof pin?.[field] !== 'string' || pin[field].trim() === ''
    );
    if (missing.length > 0) {
      problems.push(`${label}: missing ${missing.join(', ')}`);
      continue;
    }
    pinned.add(pin.app_id);
    if (!REQUIRED_APP_IDS.includes(pin.app_id)) {
      problems.push(`${label}: app_id ${pin.app_id} is not a known enclave`);
    }
    const manifest = byRelease.get(pin.pinned_release);
    if (!manifest) {
      problems.push(
        `${label}: pinned_release ${pin.pinned_release} has no committed manifest under ${MEASUREMENTS_DIR}/`
      );
      continue;
    }
    if (manifest.app_id !== pin.app_id) {
      problems.push(
        `${label}: pins ${pin.pinned_release} (app_id ${manifest.app_id}) for app_id ${pin.app_id}`
      );
    }
    const policyPath = join(root, KMS_DIR, pin.policy_file);
    if (!existsSync(policyPath)) {
      problems.push(
        `${label}: policy_file ${KMS_DIR}/${pin.policy_file} is not committed; export it with \`aws kms get-key-policy --key-id ${pin.key_alias} --policy-name default\``
      );
      continue;
    }
    let policy;
    try {
      policy = readJson(policyPath);
    } catch (error) {
      problems.push(`${KMS_DIR}/${pin.policy_file}: not parseable JSON (${error.message})`);
      continue;
    }
    const conditions = extractAttestationConditions(policy);
    if (conditions.length === 0) {
      problems.push(
        `${KMS_DIR}/${pin.policy_file}: no kms:RecipientAttestation:ImageSha384 condition, so kms:Decrypt is not gated on a measurement at all`
      );
      continue;
    }
    const expected = normalizePcr(manifest.pcr0);
    for (const condition of conditions) {
      if (condition.value === ZERO_PCR) {
        problems.push(
          `${KMS_DIR}/${pin.policy_file} statement ${condition.sid}: ImageSha384 is the all-zero placeholder; nothing can satisfy it and nothing is gated by it`
        );
        continue;
      }
      if (!HEX96.test(condition.value)) {
        problems.push(
          `${KMS_DIR}/${pin.policy_file} statement ${condition.sid}: ImageSha384 is not a 96-character SHA-384 hex digest`
        );
        continue;
      }
      if (condition.value !== expected) {
        problems.push(
          `${KMS_DIR}/${pin.policy_file} statement ${condition.sid}: ImageSha384 ${condition.value.slice(0, 16)}… does not equal ${pin.pinned_release} pcr0 ${expected.slice(0, 16)}…`
        );
      }
      if (condition.effect !== 'Allow') {
        problems.push(
          `${KMS_DIR}/${pin.policy_file} statement ${condition.sid}: attestation condition sits on a ${condition.effect} statement`
        );
      }
    }
  }

  const now = today ? Date.parse(`${today}T00:00:00Z`) : Date.now();
  const recorded = new Set();
  for (const [index, entry] of (Array.isArray(doc.unpublished) ? doc.unpublished : []).entries()) {
    const label = `${PINS_FILE} unpublished[${index}]`;
    const missing = ['app_id', 'reason', 'blocked_on', 'required_by', 'owner'].filter(
      (field) => typeof entry?.[field] !== 'string' || entry[field].trim() === ''
    );
    if (missing.length > 0) {
      problems.push(
        `${label}: missing ${missing.join(', ')}; an unpublished measurement is only acceptable while it is owned and dated`
      );
      continue;
    }
    recorded.add(entry.app_id);
    if (!DATE_ONLY.test(entry.required_by)) {
      problems.push(`${label}: required_by must be a YYYY-MM-DD date`);
      continue;
    }
    if (Date.parse(`${entry.required_by}T23:59:59Z`) < now) {
      problems.push(
        `${label}: required_by ${entry.required_by} is past due — publish the ${entry.app_id} measurement and key policy, or re-date the record under review`
      );
    }
  }

  for (const appId of new Set([...pinned].filter((appId) => recorded.has(appId)))) {
    problems.push(
      `${PINS_FILE}: ${appId} is both pinned and recorded as unpublished; one of the two records is stale`
    );
  }
  for (const appId of requiredAppIds) {
    if (!pinned.has(appId) && !recorded.has(appId)) {
      problems.push(
        `${PINS_FILE}: ${appId} has neither a published measurement pin nor an unpublished record — a relying party has nothing to check and nothing saying why`
      );
    }
  }
  return problems;
}

function* walkFiles(dir, root) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (DEBUG_SCAN_SKIP_DIRS.has(entry.name)) continue;
      yield* walkFiles(full, root);
      continue;
    }
    if (!entry.isFile()) continue;
    yield { full, rel: relative(root, full) };
  }
}

/** Rule 3 (CL-29): nothing in the deploy tree launches a debug-mode enclave. */
export function auditDebugFlags(root = REPO_ROOT) {
  const problems = [];
  for (const dirName of DEBUG_SCAN_ROOTS) {
    const dir = join(root, dirName);
    if (!existsSync(dir)) continue;
    for (const { full, rel } of walkFiles(dir, root)) {
      if (DEBUG_SCAN_SKIP_FILES.has(rel)) continue;
      const name = basename(full);
      if (!DEBUG_SCAN_EXTENSIONS.some((ext) => name.endsWith(ext))) continue;
      let text;
      try {
        if (statSync(full).size > 4_000_000) continue;
        text = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      for (const flag of DEBUG_LAUNCH_FLAGS) {
        if (!text.includes(flag)) continue;
        const line = text.slice(0, text.indexOf(flag)).split('\n').length;
        problems.push(
          `${rel}:${line}: ${flag} — a debug-mode enclave reports all-zero PCRs, so the KMS condition and the remote verifier both stop binding`
        );
      }
    }
  }
  return problems;
}

/**
 * Rule 4 (CL-27): a change to a measured build input has to arrive with a new
 * manifest, otherwise the committed measurement set silently stops describing
 * the tree.
 */
export function auditBuildInputManifests({
  changedFiles = [],
  addedFiles = [],
  manifestsByPath = {},
  isCommitReachable = null,
} = {}) {
  const touched = changedFiles.filter(
    (file) =>
      BUILD_INPUT_PATHS.includes(file) ||
      BUILD_INPUT_PREFIXES.some((prefix) => file.startsWith(prefix))
  );
  if (touched.length === 0) return [];
  const added = addedFiles.filter(
    (file) =>
      file.startsWith(`${MEASUREMENTS_DIR}/`) &&
      file.endsWith('.json') &&
      !NON_MANIFEST_FILES.has(basename(file)) &&
      !DOC_FIXTURES.has(basename(file))
  );
  if (added.length === 0) {
    return [
      `${touched.join(', ')} changed but no new manifest was added under ${MEASUREMENTS_DIR}/ — the committed PCRs no longer describe this tree, and the KMS RecipientAttestation condition will stop matching at the next rebuild`,
    ];
  }
  const problems = [];
  if (typeof isCommitReachable === 'function') {
    for (const file of added) {
      const commit = manifestsByPath[file]?.git_commit;
      if (!commit || commit === 'unknown') {
        problems.push(`${file}: git_commit must name the commit the EIF was built from`);
        continue;
      }
      if (!isCommitReachable(commit)) {
        problems.push(
          `${file}: git_commit ${commit} is not reachable from this branch, so the manifest measures a tree nobody can check out`
        );
      }
    }
  }
  return problems;
}

/**
 * The release list the verifier derives its pin from, read only in a form the
 * gate can trust: one declaration, a literal list of string literals. Anything
 * the gate would have to evaluate is a finding, not a pass.
 */
export function readVerifierPin(root = REPO_ROOT) {
  const file = join(root, VERIFIER_PIN_FILE);
  if (!existsSync(file)) {
    return {
      releases: null,
      problems: [
        `${VERIFIER_PIN_FILE} is missing, so nothing says which measurement the verifier pins`,
      ],
    };
  }
  const source = readFileSync(file, 'utf8');
  const declarations = source.match(/^export const REPRODUCIBLE_NITRO_RELEASES\b/gm) ?? [];
  const declaration = VERIFIER_PIN_DECLARATION.exec(source);
  if (declarations.length !== 1 || !declaration) {
    return {
      releases: null,
      problems: [
        `${VERIFIER_PIN_FILE}: ${VERIFIER_PIN_NAME} must be declared once as a literal list of release ids (found ${declarations.length} declaration(s) in a form the gate cannot read)`,
      ],
    };
  }
  const releases = [];
  let rest = declaration[1].replace(/\/\/[^\n]*/g, '');
  const literal = /^\s*(['"])([^'"\\\n]+)\1\s*(?:,|$)/;
  while (rest.trim() !== '') {
    const next = literal.exec(rest);
    if (!next) {
      return {
        releases: null,
        problems: [
          `${VERIFIER_PIN_FILE}: ${VERIFIER_PIN_NAME} holds ${JSON.stringify(rest.trim().slice(0, 40))}, which is not a string literal the gate can read`,
        ],
      };
    }
    releases.push(next[2]);
    rest = rest.slice(next[0].length);
  }
  return { releases, problems: [] };
}

/**
 * Which commits HEAD descends from. Refuses to answer without the history: a
 * shallow clone reports a reachable commit as missing, which would let a stale
 * pin pass.
 */
function gitReachability(root) {
  const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  const inside = git(['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    return {
      problem: `cannot tell which manifests have a reachable git_commit: ${root} is not a git work tree`,
      isReachable: null,
    };
  }
  const shallow = git(['rev-parse', '--is-shallow-repository']);
  if (shallow.status !== 0 || shallow.stdout.trim() !== 'false') {
    return {
      problem:
        'cannot tell which manifests have a reachable git_commit in a shallow clone; fetch the full history (CI: fetch-depth: 0)',
      isReachable: null,
    };
  }
  return {
    problem: null,
    isReachable: (commit) =>
      FULL_COMMIT.test(commit) && git(['merge-base', '--is-ancestor', commit, 'HEAD']).status === 0,
  };
}

/**
 * Rule 5: the verifier pin. REPRODUCIBLE_NITRO_RELEASES must name exactly the
 * committed morpheus-oracle manifests whose git_commit HEAD descends from, and
 * each of them must be committed. The verifier pins the newest listed release
 * per network, so an extra entry pins a measurement nobody can re-derive and a
 * missing one pins an older release than anybody can rebuild.
 */
export function auditVerifierPin(root = REPO_ROOT) {
  const { releases, problems } = readVerifierPin(root);
  if (!releases) return problems;
  const label = `${VERIFIER_PIN_FILE} ${VERIFIER_PIN_NAME}`;
  const committed = new Map();
  for (const entry of loadManifests(root).manifests.values()) {
    if (!entry.fixture && isPlainObject(entry.data)) committed.set(entry.data.release, entry.data);
  }
  const reachability = gitReachability(root);
  if (reachability.problem) problems.push(`${label}: ${reachability.problem}`);

  const listed = new Set();
  for (const release of releases) {
    if (listed.has(release)) {
      problems.push(`${label} lists ${release} twice`);
      continue;
    }
    listed.add(release);
    const manifest = committed.get(release);
    if (!manifest) {
      problems.push(
        `${label} names ${release}, which has no committed manifest under ${MEASUREMENTS_DIR}/ — the verifier would pin a measurement nobody can read`
      );
      continue;
    }
    if (manifest.app_id !== VERIFIER_APP_ID) {
      problems.push(
        `${label} names ${release}, a ${manifest.app_id} manifest; the verifier pins ${VERIFIER_APP_ID} releases only`
      );
      continue;
    }
    if (reachability.isReachable && !reachability.isReachable(String(manifest.git_commit))) {
      problems.push(
        `${label} names ${release}, but its git_commit ${manifest.git_commit} is not reachable from HEAD, so nobody holding this tree can check it out, rebuild the image and re-derive its PCRs`
      );
    }
  }
  if (reachability.isReachable) {
    for (const [release, manifest] of committed) {
      if (manifest.app_id !== VERIFIER_APP_ID || listed.has(release)) continue;
      if (reachability.isReachable(String(manifest.git_commit))) {
        problems.push(
          `${release} names a reachable git_commit ${manifest.git_commit}, so anybody can rebuild it, but ${label} does not list it — the verifier would pin an older release, or nothing`
        );
      }
    }
  }
  return problems;
}

/** Every rule, in the order a reviewer reads them. */
export function auditNitroMeasurements(root = REPO_ROOT, options = {}) {
  const problems = [
    ...auditManifests(root),
    ...auditAttestationPins(root, options),
    ...auditDebugFlags(root),
    ...auditVerifierPin(root),
  ];
  const pinsPath = join(root, PINS_FILE);
  if (existsSync(pinsPath)) {
    try {
      const declared = new Set(readJson(pinsPath).required_app_ids ?? []);
      for (const appId of REQUIRED_APP_IDS) {
        if (!declared.has(appId)) {
          problems.push(
            `${PINS_FILE}: required_app_ids omits ${appId}; dropping an enclave from the list removes its publication requirement`
          );
        }
      }
    } catch {
      // already reported by auditAttestationPins
    }
  }
  if (options.changedFiles) problems.push(...auditBuildInputManifests(options));
  return problems;
}

function parseArgs(argv) {
  const out = { root: REPO_ROOT, base: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') out.root = resolve(argv[++index] ?? '');
    else if (arg.startsWith('--root=')) out.root = resolve(arg.slice('--root='.length));
    else if (arg === '--base') out.base = argv[++index] ?? null;
    else if (arg.startsWith('--base=')) out.base = arg.slice('--base='.length);
  }
  return out;
}

async function diffAgainst(root, base) {
  const { execFileSync } = await import('node:child_process');
  const git = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const status = git(['diff', '--name-status', `${base}...HEAD`]).trim();
  const changedFiles = [];
  const addedFiles = [];
  for (const line of status ? status.split('\n') : []) {
    const [code, ...rest] = line.split('\t');
    const file = rest[rest.length - 1];
    if (!file) continue;
    changedFiles.push(file);
    if (code.startsWith('A')) addedFiles.push(file);
  }
  const manifestsByPath = {};
  for (const file of addedFiles) {
    if (!file.startsWith(`${MEASUREMENTS_DIR}/`) || !file.endsWith('.json')) continue;
    try {
      manifestsByPath[file] = readJson(join(root, file));
    } catch {
      // auditManifests reports the parse failure.
    }
  }
  const isCommitReachable = (commit) => {
    if (!FULL_COMMIT.test(commit)) return false;
    try {
      git(['merge-base', '--is-ancestor', commit, 'HEAD']);
      return true;
    } catch {
      return false;
    }
  };
  return { changedFiles, addedFiles, manifestsByPath, isCommitReachable };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const options = args.base ? await diffAgainst(args.root, args.base) : {};
  const problems = auditNitroMeasurements(args.root, options);
  if (problems.length > 0) {
    console.error('Nitro measurement publication gate failed:');
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log('Nitro measurement publication gate passed.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
