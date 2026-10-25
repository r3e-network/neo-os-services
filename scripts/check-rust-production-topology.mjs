import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditCargoLockProvenance } from './check-cargo-lock-provenance.mjs';
import { checkFormatWorkflows } from './lib-rust-format.mjs';
import { parseWorkflowJobs } from './lib-workflow-graph.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function requirePattern(problems, source, pattern, message) {
  if (!pattern.test(source)) problems.push(message);
}

function rejectPattern(problems, source, pattern, message) {
  if (pattern.test(source)) problems.push(message);
}

export const RUST_FEED_AUTHORITY_UNITS = Object.freeze([
  'deploy/systemd/morpheus-relayer.service',
  'deploy/systemd/morpheus-relayer-nitro.service',
]);

export const RUST_FEED_AUTHORITY_BASENAMES = Object.freeze([
  'morpheus-relayer.service',
  'morpheus-relayer-nitro.service',
]);

export const NODE_FEED_WRITER_UNIT_PATTERN =
  /^(morpheus-feed-pusher|morpheus-feed-topup|morpheus-neox-fulfiller)(?:-[^.]+)?\.(service|timer)$/;

export const HISTORICAL_MAINNET_FEED_WRITER_ALLOWLIST = Object.freeze([
  'morpheus-feed-pusher.service',
  'morpheus-feed-pusher.timer',
  'morpheus-feed-pusher-neox.service',
  'morpheus-feed-pusher-neox.timer',
  'morpheus-feed-topup.service',
  'morpheus-feed-topup.timer',
  'morpheus-neox-fulfiller.service',
]);

export function isNodeFeedWriterUnitName(fileName) {
  return NODE_FEED_WRITER_UNIT_PATTERN.test(path.basename(String(fileName || '')));
}

export function compatibilityMarkerForFeedWriter(fileName) {
  const name = path.basename(String(fileName || ''));
  if (name.startsWith('morpheus-feed-topup')) return 'ENABLE_NODE_FEE_TOPUP_COMPAT';
  if (name.startsWith('morpheus-neox-fulfiller')) return 'ENABLE_NODE_NEOX_FULFILLER_COMPAT';
  return 'ENABLE_NODE_FEED_PUSHER_COMPAT';
}

function writerStem(fileName) {
  return path.basename(String(fileName || '')).replace(/\.(service|timer)$/, '');
}

async function auditDeployReferences(root, { checkRetiredNames = true } = {}) {
  const deployRoot = path.join(root, 'deploy');
  let rootEntry;
  try {
    rootEntry = await fs.lstat(deployRoot);
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const linkProblem = (entry) =>
    `${entry} is a deployment symlink; deploy sources must be regular files and directories`;
  if (rootEntry.isSymbolicLink()) return [linkProblem('deploy')];

  const found = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(root, fullPath).split(path.sep).join('/');
      if (checkRetiredNames && RETIRED_PUBLIC_FEED_WRITER_BASENAMES.includes(entry.name)) {
        found.push(`${relativePath} is retired; historical units must stay outside deploy/`);
      }
      if (entry.isSymbolicLink()) {
        found.push(linkProblem(relativePath));
      } else if (entry.isDirectory()) {
        await visit(fullPath);
      }
    }
  }
  await visit(deployRoot);
  return found.sort();
}

async function walkDeployFiles(root, { predicate } = {}) {
  const deployRoot = path.join(root, 'deploy');
  const found = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        await visit(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (predicate && !predicate(entry.name, fullPath)) continue;
      found.push({
        fileName: entry.name,
        relativePath: path.relative(root, fullPath).split(path.sep).join('/'),
      });
    }
  }
  await visit(deployRoot);
  found.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return found;
}

export async function discoverNodeFeedWriterUnits(root = repoRoot) {
  return walkDeployFiles(root, {
    predicate: (fileName) => isNodeFeedWriterUnitName(fileName),
  });
}

// ── Boot-enabled chain writers, discovered by what a unit DOES ─────────────────
// The filename pattern above only finds writers that are named like one, and it
// missed deploy/feed-pusher/morpheus-public-feed-writer.{service,timer}: boot
// enabled, every 60 s, running a script that is in no repository with the
// frontier signer env loaded. So every service under deploy/ that is
// boot-enabled — its own [Install], or triggered by a timer that has one — is
// classified by its content, and each one that writes (or cannot be ruled out as
// writing) to chain outside the Rust relayer authority is a problem unless an
// unexpired REVIEWED exception names it. An exception never silences a unit: the
// gate prints every excepted unit by name, an expired exception fails the gate,
// and an exception that matches nothing fails it too (so it cannot outlive the
// unit it covers).

// A reviewed exception is { key, reason, expiresOn }. `key` is
// `boot-enabled-chain-writer:<service stem>`; `expiresOn` (YYYY-MM-DD, UTC) is
// the first day the exception no longer holds.
// The public-writer exception exhausted its single renewal on 2026-10-21.
// Exact historical units and exception remain under scripts/fixtures/ only.
export const REVIEWED_TOPOLOGY_EXCEPTIONS = Object.freeze([]);

// Installed old units may outlive a source checkout; keep their names in the
// authority conflict contract even though no deployable copy remains here.
export const RETIRED_PUBLIC_FEED_WRITER_BASENAMES = Object.freeze([
  'morpheus-public-feed-writer.service',
  'morpheus-public-feed-writer.timer',
]);

export const BOOT_ENABLED_CHAIN_WRITER_KEY_PREFIX = 'boot-enabled-chain-writer:';

// The deployed code root the units run from; a script path under it maps back
// into this repository.
const DEPLOYED_CODE_ROOT = '/opt/neoos/services/';

const WRITER_SCRIPT_NAME = /feed-?writ|writer|pusher|push\b|fulfil|top-?up|broadcast/i;
const WRITER_DESCRIPTION = /\b(?:writer|pusher|fulfill?er|top-?up|broadcaster)\b/i;
const WRITER_FLAG = /(?:^|\s)--(?:execute|broadcast|submit)(?:\s|=|$)/;
const SIGNER_ENV_FILE = /^morpheus-(?:nitro|custody)-signer(?:-[a-z0-9]+)?\.env$/;
const CHAIN_WRITE_CALL =
  /\bsendrawtransaction\b|\bsendRawTransaction\b|\bsignTransaction\b|\bsignMessage\b|\.sendTransaction\(|wallet\.sign\(|\bfulfillRequest\(/;

export function parseSystemdUnit(source) {
  const sections = new Set();
  const directives = new Map();
  for (const rawLine of String(source || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      sections.add(section[1]);
      continue;
    }
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!directives.has(key)) directives.set(key, []);
    directives.get(key).push(value);
  }
  return {
    sections,
    get: (key) => directives.get(key) || [],
    first: (key) => (directives.get(key) || [])[0] || '',
  };
}

function isBootEnabled(unit) {
  return (
    unit.sections.has('Install') && unit.get('WantedBy').concat(unit.get('RequiredBy')).length > 0
  );
}

// The program a service launches and the script it hands to Node, if any.
function describeExec(execStart) {
  const tokens = String(execStart || '')
    .replace(/^[-@:+!]+/, '')
    .split(/\s+/)
    .filter(Boolean);
  const nodeIndex = tokens.findIndex((token) => /^(?:node|nodejs|npm)$/.test(path.basename(token)));
  const viaNpm = nodeIndex >= 0 && path.basename(tokens[nodeIndex]) === 'npm';
  let script = '';
  if (nodeIndex >= 0 && !viaNpm) {
    script = tokens.slice(nodeIndex + 1).find((token) => !token.startsWith('-')) || '';
  }
  const relayerIndex = tokens.findIndex((token) => path.basename(token) === 'neo-os-relayer');
  return {
    script,
    // An npm package script cannot be traced to a reviewed entry point here.
    npmScript: viaNpm ? tokens.slice(nodeIndex + 1).join(' ') : '',
    rustDeliveryLoop:
      relayerIndex >= 0 && ['loop', 'once'].includes(tokens[relayerIndex + 1] || ''),
  };
}

// Map a deployed script path back into the repository ('' when it cannot be).
function repoPathForScript(script, workingDirectory) {
  if (!script) return '';
  let deployed = '';
  if (path.posix.isAbsolute(script)) deployed = path.posix.normalize(script);
  else if (workingDirectory) deployed = path.posix.join(workingDirectory.replace(/^-/, ''), script);
  return deployed.startsWith(DEPLOYED_CODE_ROOT) ? deployed.slice(DEPLOYED_CODE_ROOT.length) : '';
}

export async function chainWriterSignals(unit, root = repoRoot) {
  const signals = [];
  const execs = unit.get('ExecStart');
  for (const execStart of execs) {
    const exec = describeExec(execStart);
    if (exec.rustDeliveryLoop) signals.push('runs the Rust relayer delivery loop');
    if (exec.script) {
      const name = path.posix.basename(exec.script);
      if (WRITER_SCRIPT_NAME.test(name)) signals.push(`runs writer script ${name}`);
      const repoPath = repoPathForScript(exec.script, unit.first('WorkingDirectory'));
      if (repoPath) {
        let source = null;
        try {
          source = await fs.readFile(path.join(root, repoPath), 'utf8');
        } catch (error) {
          if (!error || error.code !== 'ENOENT') throw error;
        }
        if (source === null) {
          signals.push(`runs ${repoPath}, which is not in this repository`);
        } else if (CHAIN_WRITE_CALL.test(source)) {
          signals.push(`runs ${repoPath}, which signs or broadcasts transactions`);
        }
      } else {
        signals.push(`runs ${exec.script}, which cannot be traced into this repository`);
      }
    }
    if (exec.npmScript) {
      signals.push(`runs npm ${exec.npmScript}, whose entry point cannot be traced`);
    }
    if (WRITER_FLAG.test(execStart)) signals.push('passes an --execute/--broadcast/--submit flag');
  }
  if (WRITER_DESCRIPTION.test(unit.first('Description'))) {
    signals.push(`describes itself as a writer ("${unit.first('Description')}")`);
  }
  for (const environmentFile of unit.get('EnvironmentFile')) {
    const name = path.posix.basename(environmentFile.replace(/^-/, ''));
    if (SIGNER_ENV_FILE.test(name)) signals.push(`loads signer credentials from ${name}`);
  }
  return [...new Set(signals)];
}

// Every service under deploy/ that starts at boot, with the units that make it
// do so (itself and/or its timers).
export async function discoverBootEnabledServices(root = repoRoot) {
  const files = await walkDeployFiles(root, {
    predicate: (fileName) => /\.(service|timer)$/.test(fileName),
  });
  const byName = new Map();
  for (const file of files) {
    const source = await fs.readFile(path.join(root, file.relativePath), 'utf8');
    byName.set(file.fileName, { ...file, unit: parseSystemdUnit(source) });
  }
  const enabled = new Map();
  const enable = (serviceName, via) => {
    const entry = enabled.get(serviceName) || { service: serviceName, via: [] };
    if (!entry.via.includes(via)) entry.via.push(via);
    enabled.set(serviceName, entry);
  };
  for (const [name, file] of byName) {
    if (!isBootEnabled(file.unit)) continue;
    if (name.endsWith('.service')) enable(name, name);
    else enable(file.unit.first('Unit') || name.replace(/\.timer$/, '.service'), name);
  }
  return [...enabled.values()]
    .map((entry) => {
      const file = byName.get(entry.service);
      const via = entry.via.sort();
      return {
        ...entry,
        via,
        viaPaths: via.map((name) => byName.get(name)?.relativePath || name),
        relativePath: file ? file.relativePath : null,
        unit: file ? file.unit : null,
      };
    })
    .sort((left, right) => left.service.localeCompare(right.service));
}

function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

export async function auditBootEnabledChainWriters(
  root = repoRoot,
  { exceptions = REVIEWED_TOPOLOGY_EXCEPTIONS, today = utcToday() } = {}
) {
  const problems = [];
  const writers = [];
  const excepted = [];
  const byKey = new Map();
  for (const exception of exceptions) {
    if (
      typeof exception?.key !== 'string' ||
      !exception.key.startsWith(BOOT_ENABLED_CHAIN_WRITER_KEY_PREFIX) ||
      typeof exception.reason !== 'string' ||
      !exception.reason.trim() ||
      !/^\d{4}-\d{2}-\d{2}$/.test(String(exception.expiresOn || ''))
    ) {
      problems.push(
        `reviewed exception ${JSON.stringify(exception?.key)} must carry a ${BOOT_ENABLED_CHAIN_WRITER_KEY_PREFIX}<unit> key, a reason and an expiresOn date`
      );
      continue;
    }
    byKey.set(exception.key, exception);
  }
  const matched = new Set();
  for (const entry of await discoverBootEnabledServices(root)) {
    if (!entry.unit) {
      problems.push(
        `${entry.via.join(', ')} starts ${entry.service} at boot, but no such unit is under deploy/`
      );
      continue;
    }
    const signals = await chainWriterSignals(entry.unit, root);
    if (!signals.length) continue;
    const isRustAuthority =
      RUST_FEED_AUTHORITY_BASENAMES.includes(entry.service) &&
      entry.unit.get('ExecStart').some((execStart) => describeExec(execStart).rustDeliveryLoop);
    if (isRustAuthority) continue;
    const key = `${BOOT_ENABLED_CHAIN_WRITER_KEY_PREFIX}${entry.service.replace(/\.service$/, '')}`;
    const writer = {
      key,
      service: entry.service,
      relativePath: entry.relativePath,
      bootEnabledBy: entry.via,
      signals,
    };
    writers.push(writer);
    const exception = byKey.get(key);
    if (!exception) {
      problems.push(
        `${entry.relativePath} is a boot-enabled chain writer outside the Rust relayer authority ` +
          `(started at boot by ${entry.via.join(', ')}; ${signals.join('; ')})`
      );
      continue;
    }
    matched.add(key);
    if (today >= exception.expiresOn) {
      problems.push(
        `${entry.relativePath}: reviewed exception ${key} expired on ${exception.expiresOn} (${exception.reason})`
      );
      continue;
    }
    excepted.push({
      key,
      units: [...new Set([entry.relativePath, ...entry.viaPaths])],
      reason: exception.reason,
      expiresOn: exception.expiresOn,
      signals,
    });
  }
  for (const key of byKey.keys()) {
    if (!matched.has(key)) {
      problems.push(
        `reviewed exception ${key} matches no boot-enabled chain writer under deploy/; remove it`
      );
    }
  }
  return { problems, writers, excepted };
}

export async function discoverOperatorMarkdown(root) {
  const found = [];
  for (const directory of ['docs', 'deploy']) {
    const start = path.join(root, directory);
    async function visit(current) {
      let entries;
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch (error) {
        if (error && error.code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue;
          await visit(fullPath);
          continue;
        }
        if (entry.isFile() && entry.name.endsWith('.md')) {
          found.push(path.relative(root, fullPath).split(path.sep).join('/'));
        }
      }
    }
    await visit(start);
  }
  found.sort();
  return found;
}

export function checkWriterEnablePostureInDocs(name, source, writerStems) {
  const problems = [];
  for (const stem of writerStems) {
    const escaped = String(stem).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`systemctl\\s+enable\\s+--now\\s+[^\\n]*\\b${escaped}\\b`).test(source)) {
      problems.push(`${name} still enables Node chain writer ${stem} by default`);
    }
  }
  return problems;
}

export function checkPublishWorkflow(source) {
  const problems = [];
  for (const dockerfile of ['deploy/nitro/Dockerfile.enclave', 'deploy/nitro/Dockerfile.relayer']) {
    requirePattern(
      problems,
      source,
      new RegExp(dockerfile.replaceAll('/', '\\/')),
      `publish workflow does not build ${dockerfile}`
    );
  }
  for (const image of ['neo-os-services-nitro-host', 'neo-os-services-relayer']) {
    requirePattern(
      problems,
      source,
      new RegExp(image),
      `publish workflow does not publish ${image}`
    );
  }
  rejectPattern(
    problems,
    source,
    /dockerfile:\s*workers\/(?:nitro-worker|morpheus-relayer)\/Dockerfile/,
    'publish workflow still promotes a Node worker/relayer Dockerfile'
  );
  rejectPattern(
    problems,
    source,
    /legacy_image:/,
    'publish workflow still publishes a legacy authority alias'
  );
  rejectPattern(
    problems,
    source,
    /relayer-preview/i,
    'publish workflow retains the retired relayer preview image name'
  );
  rejectPattern(
    problems,
    source,
    /type=raw,value=latest|type=ref,event=branch/,
    'published service images must use immutable SHA tags only'
  );
  requirePattern(
    problems,
    source,
    /flavor:\s*latest=false/,
    'publish workflow does not explicitly disable latest'
  );
  requirePattern(
    problems,
    source,
    /check:production-topology/,
    'publish workflow is not gated by the topology audit'
  );
  for (const packageName of ['neo-signer', 'nitro-enclave-host', 'neo-os-relayer']) {
    requirePattern(
      problems,
      source,
      new RegExp(`-p ${packageName}`),
      `publish gate does not test ${packageName}`
    );
  }
  // Generic publishing has no environment custody inputs. Keep the dedicated
  // signer recipe in the topology audit and all three Rust suites above.
  let publishBody = '';
  try {
    const jobs = parseWorkflowJobs(source);
    if (
      jobs
        .map((job) => job.name)
        .sort()
        .join(',') !== 'build-and-push,runner,test'
    ) {
      problems.push('Publish build action contract refuses extra or unsupported jobs');
    }
    publishBody = jobs.find((job) => job.name === 'build-and-push')?.body || '';
  } catch {
    problems.push('Publish build action contract requires a parsed workflow job');
  }
  // A small, fail-closed contract for this workflow, not a general YAML parser.
  // Scope selectors to the actual job and action. Comments cannot supply inputs.
  const body = publishBody
    .split('\n')
    .filter((line) => line.trim() && !line.trimStart().startsWith('#'))
    .map((line) => line.replace(/^(      - uses: \S+)\s+#.*$/, '$1'))
    .join('\n');
  const sections = body.split(/^    steps:$/m);
  const matrix = sections[0].match(/^        include:\n([\s\S]*)$/m)?.[1] || '';
  const expectedMatrix = [
    '          - name: nitro-host',
    '            dockerfile: deploy/nitro/Dockerfile.enclave',
    '            image: ghcr.io/${{ github.repository_owner }}/neo-os-services-nitro-host',
    '          - name: relayer',
    '            dockerfile: deploy/nitro/Dockerfile.relayer',
    '            image: ghcr.io/${{ github.repository_owner }}/neo-os-services-relayer',
  ].join('\n');
  if (matrix.trimEnd() !== expectedMatrix) {
    problems.push(
      'Generic publish matrix must contain only nitro-host and relayer; custody requires its dedicated measured build'
    );
  }
  const expectedHeader = [
    '    needs: [runner, test]',
    "    runs-on: ${{ needs.runner.outputs.runner || 'ubuntu-latest' }}",
    '    permissions:',
    '      contents: read',
    '      packages: write',
    '    strategy:',
    '      fail-fast: false',
    '      matrix:',
    '        include:',
    expectedMatrix,
  ].join('\n');
  if (sections.length !== 2 || sections[0].trimEnd() !== expectedHeader) {
    problems.push('Publish build action requires the reviewed matrix job shape');
  }
  // All publication steps are explicit. Additional actions/run steps, duplicate
  // mappings, aliases, targets and build-context overrides require fresh review.
  const expectedSteps = [
    ['actions/checkout', []],
    ['docker/setup-buildx-action', []],
    [
      'docker/login-action',
      [
        '        with:',
        '          registry: ghcr.io',
        '          username: ${{ github.actor }}',
        '          password: ${{ secrets.GITHUB_TOKEN }}',
      ],
    ],
    [
      'docker/metadata-action',
      [
        '        id: meta',
        '        with:',
        '          images: ${{ matrix.image }}',
        '          flavor: latest=false',
        '          tags: type=sha,format=long,prefix=sha-',
      ],
    ],
    [
      'docker/build-push-action',
      [
        '        with:',
        '          context: .',
        '          file: ${{ matrix.dockerfile }}',
        '          platforms: linux/amd64',
        '          push: true',
        '          tags: ${{ steps.meta.outputs.tags }}',
        '          labels: ${{ steps.meta.outputs.labels }}',
      ],
    ],
  ];
  const steps = (sections[1] || '').split(/^      - /m);
  const validSteps =
    steps.shift()?.trim() === '' &&
    steps.length === expectedSteps.length &&
    steps.every((step, index) => {
      const [header, ...inputs] = step.trimEnd().split('\n');
      const uses = header.match(/^uses: ([a-z/-]+)@[0-9a-f]{40}$/);
      return (
        uses?.[1] === expectedSteps[index][0] &&
        inputs.join('\n') === expectedSteps[index][1].join('\n')
      );
    });
  if (!validSteps) {
    problems.push(
      'Publish build action must bind context/file to the validated matrix with only reviewed publication steps and inputs'
    );
  }
  return problems;
}

export function checkAuthorityUnit(name, source) {
  const problems = [];
  rejectPattern(
    problems,
    source,
    /^ExecStart=.*(?:\/node\b|\/npm\b|workers\/morpheus-relayer)/m,
    `${name} launches Node on an authority unit`
  );
  rejectPattern(
    problems,
    source,
    /^ConditionPathExists=\/opt\/morpheus\/nitro\/ENABLE_RUST_RELAYER_PREVIEW$/m,
    `${name} retains the obsolete Rust relayer preview gate`
  );
  requirePattern(
    problems,
    source,
    /^ExecStartPre=\/opt\/neoos\/services\/bin\/neo-os-relayer config:validate$/m,
    `${name} does not fail closed on config validation`
  );
  requirePattern(
    problems,
    source,
    /^Environment=NODE_ENV=production$/m,
    `${name} omits the legacy-named Rust production safety contract`
  );
  requirePattern(
    problems,
    source,
    /^ExecStart=\/opt\/neoos\/services\/bin\/neo-os-relayer /m,
    `${name} does not launch the installed Rust binary`
  );
  for (const directive of [
    'NoNewPrivileges=true',
    'PrivateDevices=true',
    'ProtectSystem=strict',
    'ProtectKernelTunables=true',
    'ProtectKernelModules=true',
    'ProtectControlGroups=true',
    'RestrictSUIDSGID=true',
    'LockPersonality=true',
    'SystemCallArchitectures=native',
    'UMask=0077',
  ]) {
    requirePattern(
      problems,
      source,
      new RegExp(`^${directive}$`, 'm'),
      `${name} omits systemd hardening directive ${directive}`
    );
  }
  return problems;
}

export function checkRustFeedAuthorityUnit(name, source, writerUnitNames = []) {
  const problems = [];
  const writers = [
    ...new Set(writerUnitNames.map((unit) => path.basename(String(unit || '')))),
  ].filter(Boolean);
  if (writers.length === 0) {
    problems.push(`${name} has no discovered Node feed writers to conflict with`);
    return problems;
  }
  for (const conflict of new Set([...writers, ...RETIRED_PUBLIC_FEED_WRITER_BASENAMES])) {
    requirePattern(
      problems,
      source,
      new RegExp(`^Conflicts=.*\\b${conflict.replaceAll('.', '\\.')}(?:\\s|$)`, 'm'),
      `${name} does not conflict with Node compatibility writer ${conflict}`
    );
  }
  return problems;
}

export function checkNodeFeedCompatUnit(name, source, marker = 'ENABLE_NODE_FEED_PUSHER_COMPAT') {
  const problems = [];
  requirePattern(
    problems,
    source,
    /COMPATIBILITY ONLY/,
    `${name} is not labelled compatibility-only`
  );
  requirePattern(
    problems,
    source,
    new RegExp(`^ConditionPathExists=/opt/morpheus/nitro/${marker}$`, 'm'),
    `${name} lacks the explicit Node chain-writer compatibility marker ${marker}`
  );
  for (const rustUnit of RUST_FEED_AUTHORITY_BASENAMES) {
    requirePattern(
      problems,
      source,
      new RegExp(`^Conflicts=.*\\b${rustUnit.replaceAll('.', '\\.')}(?:\\s|$)`, 'm'),
      `${name} does not conflict with Rust authority ${rustUnit}`
    );
    requirePattern(
      problems,
      source,
      new RegExp(`^Before=.*\\b${rustUnit.replaceAll('.', '\\.')}(?:\\s|$)`, 'm'),
      `${name} does not start before Rust authority ${rustUnit}`
    );
  }
  rejectPattern(
    problems,
    source,
    /^\[Install\]$/m,
    `${name} can still be enabled as a default boot chain authority`
  );
  return problems;
}

export async function auditNodeFeedWriterTopology(root) {
  const problems = [];
  const read = (relativePath) => fs.readFile(path.join(root, relativePath), 'utf8');
  // Deployment source must be self-contained. Following links could restore
  // retired units under another directory or escape the reviewed source tree.
  const unsafeReferences = await auditDeployReferences(root);
  if (unsafeReferences.length) {
    return {
      problems: unsafeReferences,
      writers: [],
    };
  }
  const writers = await discoverNodeFeedWriterUnits(root);
  if (writers.length === 0) {
    problems.push('no Node feed writer units discovered under deploy/');
    return { problems, writers };
  }
  const writerBasenames = writers.map((unit) => unit.fileName);
  const writerStems = [
    ...new Set([...writerBasenames, ...RETIRED_PUBLIC_FEED_WRITER_BASENAMES].map(writerStem)),
  ];
  for (const unit of RUST_FEED_AUTHORITY_UNITS) {
    try {
      await fs.access(path.join(root, unit));
    } catch {
      problems.push(`missing Rust feed authority unit ${unit}`);
      continue;
    }
    problems.push(...checkRustFeedAuthorityUnit(unit, await read(unit), writerBasenames));
  }

  for (const writer of writers) {
    problems.push(
      ...checkNodeFeedCompatUnit(
        writer.relativePath,
        await read(writer.relativePath),
        compatibilityMarkerForFeedWriter(writer.fileName)
      )
    );
  }

  for (const doc of await discoverOperatorMarkdown(root)) {
    problems.push(...checkWriterEnablePostureInDocs(doc, await read(doc), writerStems));
  }

  return { problems, writers };
}

export function checkSignerDockerfile(source) {
  const problems = [];
  requirePattern(
    problems,
    source,
    /^COPY crates\/neo-os-chain-evm \.\/crates\/neo-os-chain-evm$/m,
    'Signer image does not copy the real neo-os-chain-evm sources required by neo-signer'
  );
  requirePattern(
    problems,
    source,
    /^ARG SIGNER_SERVICE_WORKLOAD_AUDIENCE=http:\/\/127\.0\.0\.1:8789$/m,
    'Signer image does not bind workload proofs to the caller-visible custody bridge'
  );
  requirePattern(
    problems,
    source,
    /^ENV SIGNER_SERVICE_WORKLOAD_AUDIENCE=\$\{SIGNER_SERVICE_WORKLOAD_AUDIENCE\}$/m,
    'Signer image does not install the measured workload audience into signer_service'
  );
  return problems;
}

export function checkCustodyBuildScript(source) {
  const problems = [];
  requirePattern(
    problems,
    source,
    /workload_audience="\$\{SIGNER_SERVICE_WORKLOAD_AUDIENCE:-http:\/\/127\.0\.0\.1:\$\{custody_host_port\}\}"/,
    'Custody build does not derive its default audience from the caller-visible host port'
  );
  requirePattern(
    problems,
    source,
    /--build-arg "SIGNER_SERVICE_WORKLOAD_AUDIENCE=\$workload_audience"/,
    'Custody build does not measure the configured workload audience into the EIF'
  );
  return problems;
}

export function checkRelayerDockerfile(source) {
  const problems = [];
  for (const dependency of [
    'neo-os-core',
    'nitro-attest',
    'neo-os-chain-n3',
    'neo-os-chain-evm',
    'neo-os-relayer-store',
    'neo-os-service-runtime',
  ]) {
    requirePattern(
      problems,
      source,
      new RegExp(`^COPY crates/${dependency} \\.\\/crates/${dependency}$`, 'm'),
      `Relayer image does not copy the real ${dependency} dependency sources`
    );
  }
  return problems;
}

export function checkCompatCompose(name, source) {
  const problems = [];
  requirePattern(
    problems,
    source,
    /NODE COMPATIBILITY/,
    `${name} is not labelled as Node compatibility`
  );
  rejectPattern(
    problems,
    source,
    /MORPHEUS_NITRO_WORKER_IMAGE|MORPHEUS_RELAYER_IMAGE/,
    `${name} exposes ambiguous production-looking image variables`
  );
  rejectPattern(
    problems,
    source,
    /neo-os-services-(?:nitro-worker|relayer):latest|:\s*latest\b/,
    `${name} contains a floating Node authority image`
  );
  if (/\bnode\b|nitro-worker|morpheus-relayer/.test(source)) {
    requirePattern(
      problems,
      source,
      /MORPHEUS_COMPAT_(?:NITRO_WORKER|RELAYER)_IMAGE:\?pin-explicit-node-compat-/,
      `${name} does not require an explicitly pinned compatibility image`
    );
  }
  if (/SIGNER_ROLE_NEOX_UPDATER_KEY_ID/.test(source)) {
    requirePattern(
      problems,
      source,
      /SIGNER_ROLE_NEOX_VERIFIER_KEY_ID/,
      `${name} exposes the NeoX updater without the distinct verifier role`
    );
  }
  return problems;
}

export function checkNodeFreeScript(name, source) {
  const problems = [];
  rejectPattern(
    problems,
    source,
    /(^|[;&|]\s*)node(?:\s|$)|\bnpm(?:\s|$)/m,
    `${name} has a runtime Node/npm dependency`
  );
  return problems;
}

export function checkSignerStartScript(source) {
  const problems = [];
  for (const role of [
    'updater',
    'oracle_verifier',
    'relayer',
    'worker',
    'neox_updater',
    'neox_verifier',
  ]) {
    requirePattern(
      problems,
      source,
      new RegExp(`"${role}"`),
      `Nitro provisioning gate does not require the measured ${role} custody role`
    );
  }
  requirePattern(
    problems,
    source,
    /\$roles \| all\(\.ok == true\)/,
    'Nitro provisioning gate does not reject an unhealthy measured custody role'
  );
  return problems;
}

// `chainWriters` passes options through to auditBootEnabledChainWriters (tests
// inject `exceptions` / `today`); production uses the defaults.
export async function auditProductionTopology(root = repoRoot, { chainWriters = {} } = {}) {
  const unsafeReferences = await auditDeployReferences(root, { checkRetiredNames: false });
  if (unsafeReferences.length) return unsafeReferences;
  const problems = [];
  const read = (relativePath) => fs.readFile(path.join(root, relativePath), 'utf8');

  problems.push(...checkPublishWorkflow(await read('.github/workflows/publish-images.yml')));
  problems.push(...checkFormatWorkflows(root));
  problems.push(...auditCargoLockProvenance(root));

  const dockerfiles = {
    'deploy/nitro/Dockerfile.enclave': await read('deploy/nitro/Dockerfile.enclave'),
    'deploy/nitro/Dockerfile.signer': await read('deploy/nitro/Dockerfile.signer'),
    'deploy/nitro/Dockerfile.relayer': await read('deploy/nitro/Dockerfile.relayer'),
  };
  for (const [name, source] of Object.entries(dockerfiles)) {
    rejectPattern(
      problems,
      source,
      /^FROM\s+node\b|^ENTRYPOINT\s+\[?['"]?node|\bnpm\s+(?:ci|install|start)\b/im,
      `${name} contains a Node runtime/build authority`
    );
  }
  requirePattern(
    problems,
    dockerfiles['deploy/nitro/Dockerfile.relayer'],
    /CMD \["config:validate"\]/,
    'Rust relayer image default is not config:validate'
  );
  requirePattern(
    problems,
    dockerfiles['deploy/nitro/Dockerfile.relayer'],
    /org\.neoos\.release-channel="production"/,
    'Rust relayer image is not labelled as the production authority'
  );
  requirePattern(
    problems,
    dockerfiles['deploy/nitro/Dockerfile.relayer'],
    /^ENV NODE_ENV=production$/m,
    'Rust relayer image omits the legacy-named production safety posture'
  );
  requirePattern(
    problems,
    dockerfiles['deploy/nitro/Dockerfile.enclave'],
    /ARG SIGNER_ROLE_NEOX_UPDATER_KEY_ID=/,
    'Nitro host measurement omits the NeoX updater trust anchor'
  );
  requirePattern(
    problems,
    dockerfiles['deploy/nitro/Dockerfile.enclave'],
    /ARG SIGNER_ROLE_NEOX_VERIFIER_KEY_ID=/,
    'Nitro host measurement omits the distinct NeoX verifier trust anchor'
  );
  for (const role of ['NEOX_UPDATER', 'NEOX_VERIFIER']) {
    requirePattern(
      problems,
      dockerfiles['deploy/nitro/Dockerfile.enclave'],
      new RegExp(`^ENV SIGNER_ROLE_${role}_KEY_ID=\\$\\{SIGNER_ROLE_${role}_KEY_ID\\}$`, 'm'),
      `Nitro host runtime omits the measured ${role.toLowerCase()} trust anchor`
    );
  }
  requirePattern(
    problems,
    dockerfiles['deploy/nitro/Dockerfile.enclave'],
    /^COPY crates\/neo-os-chain-evm\/src crates\/neo-os-chain-evm\/src$/m,
    'Nitro host image does not replace the neo-os-chain-evm dependency stub with real sources'
  );
  problems.push(...checkSignerDockerfile(dockerfiles['deploy/nitro/Dockerfile.signer']));
  problems.push(...checkRelayerDockerfile(dockerfiles['deploy/nitro/Dockerfile.relayer']));

  for (const unit of [
    'deploy/systemd/morpheus-relayer.service',
    'deploy/systemd/morpheus-relayer-nitro.service',
    'deploy/systemd/morpheus-relayer-metrics.service',
  ]) {
    problems.push(...checkAuthorityUnit(unit, await read(unit)));
  }
  const feedWriterAudit = await auditNodeFeedWriterTopology(root);
  problems.push(...feedWriterAudit.problems);
  const chainWriterAudit = await auditBootEnabledChainWriters(root, chainWriters);
  problems.push(...chainWriterAudit.problems);

  const feedCompatRunbook = await read('deploy/feed-pusher/RUNBOOK.md');
  requirePattern(
    problems,
    feedCompatRunbook,
    /Compatibility only — not a production authority/,
    'Node feed-pusher runbook does not identify the writer as compatibility-only'
  );
  requirePattern(
    problems,
    feedCompatRunbook,
    /ENABLE_NODE_FEED_PUSHER_COMPAT/,
    'Node feed-pusher runbook omits its explicit compatibility marker'
  );
  rejectPattern(
    problems,
    feedCompatRunbook,
    /systemctl\s+enable\s+--now\s+[^\n]*morpheus-feed-pusher/,
    'Node feed-pusher runbook still enables the compatibility writer by default'
  );
  requirePattern(
    problems,
    feedCompatRunbook,
    /ENABLE_NODE_FEE_TOPUP_COMPAT/,
    'Node fee-topup runbook omits its explicit compatibility marker'
  );
  rejectPattern(
    problems,
    feedCompatRunbook,
    /systemctl\s+enable\s+--now\s+[^\n]*morpheus-feed-topup/,
    'Node fee-topup runbook still enables the compatibility chain writer by default'
  );

  const neoxCompatRunbook = await read('deploy/evm/RUNBOOK.md');
  requirePattern(
    problems,
    neoxCompatRunbook,
    /not a\s+production fallback/,
    'NeoX host fulfiller runbook still presents the Node process as a production fallback'
  );
  rejectPattern(
    problems,
    neoxCompatRunbook,
    /systemctl\s+enable\s+--now\s+[^\n]*morpheus-neox-fulfiller/,
    'NeoX host fulfiller runbook still tells operators to enable the Node writer'
  );
  const neoxCompatSource = await read('deploy/evm/neox-fulfiller.mjs');
  requirePattern(
    problems,
    neoxCompatSource,
    /NODE_ENV[\s\S]{0,500}process\.exit\(78\)/,
    'NeoX host fulfiller no longer fails closed in production'
  );

  const cloudflareControlPlane = await read('deploy/cloudflare/morpheus-control-plane/worker.mjs');
  requirePattern(
    problems,
    cloudflareControlPlane,
    /return json\(\s*410,\s*\{[^}]*reason: 'feed_publication_owned_by_rust_relayer'/s,
    'Cloudflare feed trigger is not retired in favour of the Rust relayer'
  );
  requirePattern(
    problems,
    cloudflareControlPlane,
    /return json\(\s*503,\s*\{[^}]*reason: 'rust_automation_delivery_unavailable'/s,
    'Cloudflare automation ingress does not fail closed while Rust automation is unavailable'
  );

  for (const compatUnit of [
    'deploy/systemd/morpheus-relayer-node-compat.service',
    'deploy/nitro/morpheus-nitro-worker.service',
  ]) {
    const source = await read(compatUnit);
    requirePattern(
      problems,
      source,
      /COMPATIBILITY ONLY/,
      `${compatUnit} is not labelled compatibility-only`
    );
    requirePattern(
      problems,
      source,
      /^ConditionPathExists=\/opt\/morpheus\/nitro\/ENABLE_NODE_COMPAT$/m,
      `${compatUnit} lacks the explicit Node compatibility marker`
    );
    rejectPattern(
      problems,
      source,
      /^\[Install\]$/m,
      `${compatUnit} can still be enabled as a default boot authority`
    );
  }

  const composeDir = path.join(root, 'deploy', 'nitro');
  const composeNames = (await fs.readdir(composeDir))
    .filter((name) => /^docker-compose.*\.yml$/.test(name) && name !== 'docker-compose.rust.yml')
    .sort();
  for (const name of composeNames) {
    problems.push(
      ...checkCompatCompose(`deploy/nitro/${name}`, await read(`deploy/nitro/${name}`))
    );
  }
  const rustCompose = await read('deploy/nitro/docker-compose.rust.yml');
  requirePattern(
    problems,
    rustCompose,
    /MORPHEUS_RUST_RELAYER_IMAGE:\?pin-immutable-rust-relayer-image/,
    'Production Rust compose does not require an immutable relayer image'
  );
  rejectPattern(
    problems,
    rustCompose,
    /preview|profiles:/i,
    'Production Rust compose retains a preview/profile gate'
  );
  rejectPattern(
    problems,
    rustCompose,
    /\bnode\b|\bnpm\b/i,
    'Production Rust compose contains Node/npm'
  );

  for (const script of [
    'deploy/nitro/build-enclave-eif.sh',
    'deploy/nitro/build-custody-eif.sh',
    'deploy/nitro/start-nitro-signer.sh',
    'deploy/nitro/start-nitro-custody.sh',
    'deploy/nitro/provision-enclave-compute.sh',
  ]) {
    problems.push(...checkNodeFreeScript(script, await read(script)));
  }
  problems.push(...checkCustodyBuildScript(await read('deploy/nitro/build-custody-eif.sh')));
  problems.push(...checkSignerStartScript(await read('deploy/nitro/start-nitro-signer.sh')));

  const buildScript = await read('deploy/nitro/build-enclave-eif.sh');
  for (const marker of [
    'SIGNER_ROLE_NEOX_UPDATER_KEY_ID',
    'SIGNER_ROLE_NEOX_VERIFIER_KEY_ID',
    'neox_updater_key_id',
    'neox_verifier_key_id',
    'all six SIGNER_ROLE_*_KEY_ID',
    'must be distinct custody roles',
  ]) {
    requirePattern(
      problems,
      buildScript,
      new RegExp(marker.replace('*', '\\*')),
      `Nitro measurement manifest/build is missing ${marker}`
    );
  }

  const relayerEnvExample = await read('deploy/nitro/neo-os-relayer.env.example');
  for (const marker of [
    'SIGNER_ROLE_NEOX_UPDATER_KEY_ID',
    'SIGNER_ROLE_NEOX_VERIFIER_KEY_ID',
    'MORPHEUS_RELAYER_NEOX_RPC_URL',
    'MORPHEUS_RELAYER_NEOX_CHAIN_ID',
    'MORPHEUS_RELAYER_NEOX_ORACLE',
    'MORPHEUS_RELAYER_NEOX_DATAFEED',
    'MORPHEUS_RELAYER_NEOX_FEED_GAS_LIMIT',
    'CONTRACT_MORPHEUS_DATAFEED_HASH_MAINNET',
    'CONTRACT_MORPHEUS_ORACLE_HASH_MAINNET',
    'MORPHEUS_FEED_SYNC_ENABLED',
    'MORPHEUS_FEED_SYMBOLS',
    'MORPHEUS_RELAYER_INSTANCE_ID',
  ]) {
    requirePattern(
      problems,
      relayerEnvExample,
      new RegExp(`^${marker}=`, 'm'),
      `Rust relayer env example omits ${marker}`
    );
  }
  requirePattern(
    problems,
    relayerEnvExample,
    /^MORPHEUS_RUNTIME_TOKEN=replace-with-frontier-runtime-bearer-token$/m,
    'Rust relayer env example omits the frontier bearer credential'
  );
  requirePattern(
    problems,
    relayerEnvExample,
    /^SIGNER_SERVICE_TOKEN=replace-with-dedicated-relayer-bearer-caller-token$/m,
    'Rust relayer env example does not distinguish the custody bearer caller'
  );
  requirePattern(
    problems,
    relayerEnvExample,
    /^MORPHEUS_AUTOMATION_ENABLED=false$/m,
    'Rust relayer env example does not keep automation fail-closed'
  );
  requirePattern(
    problems,
    relayerEnvExample,
    /^MORPHEUS_RELAYER_ENCLAVE_FULFILL=true$/m,
    'Rust relayer env example does not enable authoritative measured-host fulfillment'
  );
  rejectPattern(
    problems,
    relayerEnvExample,
    /custody-workload-token/,
    'Rust relayer env example conflates bearer and workload-ed25519 authentication'
  );

  const compatNitroEnvExample = await read('deploy/nitro/morpheus.env.example');
  requirePattern(
    problems,
    compatNitroEnvExample,
    /"MORPHEUS_AUTOMATION_ENABLED":"false"/,
    'Node compatibility env example does not default automation to fail-closed'
  );
  rejectPattern(
    problems,
    compatNitroEnvExample,
    /"MORPHEUS_AUTOMATION_ENABLED":"true"/,
    'Node compatibility env example silently enables the non-authoritative automation lane'
  );
  const compatEnvRenderer = await read('scripts/render-nitro-compose-env.mjs');
  rejectPattern(
    problems,
    compatEnvRenderer,
    /MORPHEUS_AUTOMATION_ENABLED'\) \|\| 'true'/,
    'Node compatibility env renderer still defaults automation on'
  );

  const packageJson = JSON.parse(await read('package.json'));
  for (const command of [
    'check:relayer',
    'test:relayer',
    'start:relayer',
    'once:relayer',
    'metrics:relayer',
    'metrics:relayer:prom',
    'start:relayer:metrics',
  ]) {
    const script = packageJson.scripts?.[command] || '';
    rejectPattern(
      problems,
      script,
      /workers\/morpheus-relayer|:compat/,
      `npm run ${command} still resolves to Node compatibility`
    );
    requirePattern(
      problems,
      script,
      /neo-os-relayer|:relayer:rust/,
      `npm run ${command} does not resolve to the Rust relayer`
    );
  }

  return problems;
}

const invokedPath = process.argv[1]
  ? await fs.realpath(process.argv[1]).catch(() => path.resolve(process.argv[1]))
  : '';
const modulePath = await fs.realpath(fileURLToPath(import.meta.url));

if (invokedPath && invokedPath === modulePath) {
  // Refuse before the production audit or its later exception-reporting scan
  // can open deployment content. In particular, never open a linked FIFO.
  const unsafeReferences = await auditDeployReferences(repoRoot, { checkRetiredNames: false });
  if (unsafeReferences.length) {
    console.error('Rust production topology audit failed:');
    for (const problem of unsafeReferences) console.error(`- ${problem}`);
    process.exit(1);
  }
  const problems = await auditProductionTopology();
  // Reported whether or not the gate passes: an excepted unit is never silent.
  const { excepted } = await auditBootEnabledChainWriters();
  for (const exception of excepted) {
    console.error(
      `WARNING reviewed exception ${exception.key} (expires ${exception.expiresOn}): ` +
        `${exception.units.join(' + ')} is a boot-enabled chain writer outside the Rust ` +
        `relayer authority — ${exception.reason}`
    );
  }
  if (problems.length > 0) {
    console.error('Rust production topology audit failed:');
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        authority: [
          'nitro-host (Rust EIF)',
          'signer (Rust EIF)',
          'neo-os-relayer (Rust; N3/NeoX request+feed)',
        ],
        fail_closed: ['relayer automation'],
        compatibility: [
          'Node worker/relayer (explicitly pinned, never default-published)',
          'Node chain writers (feed-pusher, fee-topup, NeoX fulfiller; explicit rollback markers, never boot-enabled)',
        ],
        reviewed_exceptions: excepted,
      },
      null,
      2
    )
  );
}
