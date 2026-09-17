import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditCargoLockProvenance } from './check-cargo-lock-provenance.mjs';
import { checkFormatWorkflows } from './lib-rust-format.mjs';

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
  for (const dockerfile of [
    'deploy/nitro/Dockerfile.enclave',
    'deploy/nitro/Dockerfile.signer',
    'deploy/nitro/Dockerfile.relayer',
  ]) {
    requirePattern(
      problems,
      source,
      new RegExp(dockerfile.replaceAll('/', '\\/')),
      `publish workflow does not build ${dockerfile}`
    );
  }
  for (const image of [
    'neo-os-services-nitro-host',
    'neo-os-services-signer',
    'neo-os-services-relayer',
  ]) {
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
  for (const conflict of writers) {
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
  const writers = await discoverNodeFeedWriterUnits(root);
  if (writers.length === 0) {
    problems.push('no Node feed writer units discovered under deploy/');
    return { problems, writers };
  }
  const writerBasenames = writers.map((unit) => unit.fileName);
  const writerStems = [...new Set(writerBasenames.map(writerStem))];

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

export async function auditProductionTopology(root = repoRoot) {
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = await auditProductionTopology();
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
      },
      null,
      2
    )
  );
}
