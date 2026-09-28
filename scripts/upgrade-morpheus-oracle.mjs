#!/usr/bin/env node
/**
 * MorpheusOracle (MiniApp OS kernel) in-place upgrade via ContractManagement.Update.
 *
 * Two update gates exist on chain (scripts/lib-oracle-upgrade.mjs):
 *   - the generation deployed as of 2026-09-28 applies an admin-signed
 *     update(nef, manifest) immediately;
 *   - the generation that replaces it accepts update(nef, manifest) only after
 *     scheduleUpdate(nef, manifest) pinned sha256(nef || manifest) and 24 h elapsed
 *     (cancelUpdate clears the schedule). Every later update, a rollback included, takes
 *     this path.
 * The tool reads the deployed ABI and the pending schedule and plans the one step to take
 * now: update (immediate gate), schedule, wait, execute, or cancel (--cancel). See
 * docs/runbooks/morpheus-oracle-upgrade.md and
 * docs/security/ORACLE-INTEGRATION-WITNESS-20260928.md for the operational order.
 *
 * Usage:
 *   node scripts/upgrade-morpheus-oracle.mjs [--network testnet|mainnet] [--rpc <url>]
 *       [--oracle <hash>] [--nef <path>] [--manifest <path>] [--archive-dir <dir>]
 *       [--batch-size 16] [--probe-app <appId>]
 *       [--cancel] [--reschedule] [--allow-same-artifact]
 *
 * Safety model:
 *   - DRY RUN by default: read-only RPC only. Reports the deployed state, the local artifact
 *     and its sha256(nef || manifest), the pending schedule and the planned step; archives
 *     the current on-chain NEF + manifest (the rollback artifact) under --archive-dir;
 *     test-invokes the planned call with the admin as signer; prints the RebuildIndexes plan.
 *     Nothing is signed or broadcast.
 *   - UPGRADE_APPLY=1: signs and broadcasts the planned step with the admin key
 *     (MORPHEUS_ORACLE_ADMIN_WIF, falling back to the pinned updater role) and verifies it.
 *     A running timelock or a conflicting schedule is refused, never worked around.
 *   - REBUILD_APPLY=1: runs the chunked rebuildIndexes backfill (requires the upgraded
 *     contract on-chain) and verifies the callback index against the registry via
 *     getstorage. Independent of UPGRADE_APPLY so the backfill can be resumed.
 */
import { trimString } from './lib-strings.mjs';
import { buildIndexRebuildChunks } from './lib-index-rebuild-plan.mjs';
import {
  PREFIX_UPGRADE_HASH,
  PREFIX_UPGRADE_TIME,
  TIMELOCK_DELAY_MS,
  UPGRADE_ACTIONS,
  assertNefChecksum,
  computeUpgradeArtifactHash,
  decodePendingUpgrade,
  describeUpgradeGate,
  manifestsEquivalent,
  reconstructNefFile,
  planKernelUpgrade,
  storageKeyBase64,
  upgradeInvocation,
} from './lib-oracle-upgrade.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { experimental, sc, u, wallet } from '@cityofzion/neon-js';
import { loadDotEnv } from './lib-env.mjs';
import { normalizeMorpheusNetwork, resolvePinnedNeoN3Role } from './lib-neo-signers.mjs';
import {
  readReviewedNetworkRegistrySync,
  resolveReviewedNeoN3Magic,
} from './lib-network-registry.mjs';

const DEFAULT_ORACLE_HASH = '0xf54d8584ef82315c1800373272ab08ae0db2d5ef';
const PREFIX_CALLBACK_INDEX = 0x27; // MorpheusOracle.cs PREFIX_CALLBACK_INDEX
const TX_POLL_ATTEMPTS = 18;
const TX_POLL_INTERVAL_MS = 5_000;
const NO_PENDING = Object.freeze({ scheduled: false, executeAfterMs: null, hashHex: null });

const { values: flags } = parseArgs({
  options: {
    network: { type: 'string' },
    'batch-size': { type: 'string' },
    rpc: { type: 'string' },
    'probe-app': { type: 'string' },
    oracle: { type: 'string' },
    nef: { type: 'string' },
    manifest: { type: 'string' },
    'archive-dir': { type: 'string' },
    cancel: { type: 'boolean', default: false },
    reschedule: { type: 'boolean', default: false },
    'allow-same-artifact': { type: 'boolean', default: false },
  },
});

const requestedNetwork = normalizeMorpheusNetwork(
  flags.network || process.env.MORPHEUS_NETWORK || 'testnet'
);
await loadDotEnv();
const network = normalizeMorpheusNetwork(
  flags.network || process.env.MORPHEUS_NETWORK || requestedNetwork
);
await loadDotEnv(new URL(`../deploy/nitro/morpheus.${network}.env`, import.meta.url), {
  override: true,
});

const rpcAddress = trimString(
  flags.rpc ||
    process.env.NEO_RPC_URL ||
    (network === 'mainnet' ? 'https://api.n3index.dev/mainnet' : 'https://api.n3index.dev/testnet')
);
const networkMagic = Number(
  resolveReviewedNeoN3Magic(
    readReviewedNetworkRegistrySync(process.cwd(), network),
    network,
    process.env.NEO_NETWORK_MAGIC || ''
  )
);
const oracleHash = trimString(
  flags.oracle || process.env.CONTRACT_MORPHEUS_ORACLE_HASH || DEFAULT_ORACLE_HASH
);
const batchSize = Math.max(1, Number(flags['batch-size'] || 16));
const applyUpdate = process.env.UPGRADE_APPLY === '1';
const applyRebuild = process.env.REBUILD_APPLY === '1';

let rpcId = 0;
async function rpc(method, params) {
  const response = await fetch(rpcAddress, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  if (!response.ok) throw new Error(`${method} HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`${method} RPC error: ${JSON.stringify(body.error)}`);
  return body.result;
}

function b64ToBuf(b64) {
  return Buffer.from(b64, 'base64');
}

function hash160FromStackItem(item) {
  if (!item || item.type !== 'ByteString' || !item.value) return null;
  const bytes = b64ToBuf(item.value);
  if (bytes.length !== 20) return null;
  return `0x${Buffer.from(bytes).reverse().toString('hex')}`;
}

function integerFromStackItem(item) {
  if (!item) return null;
  if (item.type === 'Integer') return BigInt(item.value);
  return null;
}

function booleanFromStackItem(item) {
  if (!item || item.type !== 'Boolean') return null;
  return item.value === true || item.value === 'true';
}

function jsonSafe(value) {
  return JSON.stringify(
    value,
    (_key, entry) => (typeof entry === 'bigint' ? entry.toString() : entry),
    2
  );
}

async function readMethod(method, params = [], signers = []) {
  const result = await rpc('invokefunction', [oracleHash, method, params, signers]);
  if (result.state !== 'HALT') {
    throw new Error(`${method} test invoke FAULTed: ${result.exception || 'unknown'}`);
  }
  return result;
}

async function readPendingUpgrade() {
  const [timeBase64, hashBase64] = await Promise.all([
    rpc('getstorage', [oracleHash, storageKeyBase64(PREFIX_UPGRADE_TIME)]),
    rpc('getstorage', [oracleHash, storageKeyBase64(PREFIX_UPGRADE_HASH)]),
  ]);
  return decodePendingUpgrade({ timeBase64, hashBase64 });
}

// Runtime.Time of the next block is at least the latest header's timestamp (ms).
async function readChainTimeMs() {
  const count = Number(await rpc('getblockcount', []));
  const header = await rpc('getblockheader', [count - 1, true]);
  const time = Number(header?.time);
  if (!Number.isSafeInteger(time) || time <= 0) {
    throw new Error('getblockheader returned no block time');
  }
  return BigInt(time);
}

async function waitForTransaction(txid) {
  for (let attempt = 0; attempt < TX_POLL_ATTEMPTS; attempt++) {
    try {
      const log = await rpc('getapplicationlog', [txid]);
      const execution = log?.executions?.[0];
      if (execution) {
        if (execution.vmstate !== 'HALT') {
          throw new Error(
            `transaction ${txid} executed with ${execution.vmstate}: ${execution.exception || ''}`
          );
        }
        return execution;
      }
    } catch (error) {
      if (!/Unknown transaction|Unknown script container|RPC error/.test(String(error.message)))
        throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, TX_POLL_INTERVAL_MS));
  }
  throw new Error(
    `transaction ${txid} not confirmed after ${(TX_POLL_ATTEMPTS * TX_POLL_INTERVAL_MS) / 1000}s`
  );
}

// --- 1. Current deployed state (read-only) ------------------------------------------
const state = await rpc('getcontractstate', [oracleHash]);
const gate = describeUpgradeGate(state.manifest);
const deployedMethods = state.manifest.abi.methods.map((m) => m.name);

const adminInvoke = await readMethod('admin');
const updaterInvoke = await readMethod('updater');
const onChainAdmin = hash160FromStackItem(adminInvoke.stack?.[0]);
const onChainUpdater = hash160FromStackItem(updaterInvoke.stack?.[0]);

// --- 2. Local artifact ----------------------------------------------------------------
const nefPath = path.resolve(flags.nef || 'contracts/build/MorpheusOracle.nef');
const manifestPath = path.resolve(flags.manifest || 'contracts/build/MorpheusOracle.manifest.json');
const [nefBytes, manifestRaw] = await Promise.all([
  fs.readFile(nefPath),
  fs.readFile(manifestPath, 'utf8'),
]);
const localChecksum = assertNefChecksum(nefBytes);
const localManifest = JSON.parse(manifestRaw);
if (localManifest.name !== state.manifest.name) {
  throw new Error(
    `local manifest name '${localManifest.name}' differs from the deployed '${state.manifest.name}'; ContractManagement.Update refuses a rename`
  );
}
const localMethods = localManifest.abi.methods.map((m) => m.name);
const addedMethods = localMethods.filter((m) => !deployedMethods.includes(m));
const removedMethods = deployedMethods.filter((m) => !localMethods.includes(m));
// The exact bytes scheduleUpdate pins and update must repeat.
const localArtifactHash = computeUpgradeArtifactHash(nefBytes, manifestRaw);
const sameAsDeployed =
  localChecksum === state.nef.checksum && manifestsEquivalent(state.manifest, localManifest);

// --- 3. Pending schedule and the plan ---------------------------------------------------
const pending = gate.timelocked ? await readPendingUpgrade() : NO_PENDING;
const chainTimeMs = gate.timelocked ? await readChainTimeMs() : null;
const plan = planKernelUpgrade({
  gate,
  sameAsDeployed,
  localArtifactHash,
  pending,
  chainTimeMs,
  cancel: flags.cancel,
  reschedule: flags.reschedule,
  allowSameArtifact: flags['allow-same-artifact'],
});

console.log(
  jsonSafe({
    network,
    rpc: rpcAddress,
    oracle_hash: oracleHash,
    deployed: {
      updatecounter: state.updatecounter,
      nef_checksum: state.nef.checksum,
      method_count: deployedMethods.length,
      admin: onChainAdmin,
      updater: onChainUpdater,
      update_gate: gate.timelocked
        ? `scheduleUpdate -> ${TIMELOCK_DELAY_MS / 3_600_000} h -> update (admin witness)`
        : 'immediate update (admin witness)',
    },
    local: {
      nef: nefPath,
      manifest: manifestPath,
      nef_checksum: localChecksum,
      artifact_sha256: localArtifactHash,
      method_count: localMethods.length,
      methods_added: addedMethods,
      methods_removed: removedMethods,
      same_as_deployed: sameAsDeployed,
    },
    pending_upgrade: pending,
    chain_time_ms: chainTimeMs,
    plan,
    mode: applyUpdate ? 'APPLY' : 'DRY RUN',
  })
);

// --- 4. Archive the current on-chain state (rollback artifact) ------------------------
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const archiveDir = path.resolve(flags['archive-dir'] || path.join('private-backups', 'upgrades'));
await fs.mkdir(archiveDir, { recursive: true });
const archiveBase = path.join(
  archiveDir,
  `morpheus-oracle.${network}.uc${state.updatecounter}.${timestamp}`
);
await fs.writeFile(`${archiveBase}.contractstate.json`, JSON.stringify(state, null, 2));
// Compact JSON: the rollback submits this exact text, and scheduleUpdate pins its bytes.
const rollbackManifestText = JSON.stringify(state.manifest);
await fs.writeFile(`${archiveBase}.manifest.json`, rollbackManifestText);
try {
  // Byte-exact NEF so a rollback can submit the deployed code (checksum-validated).
  const rollbackNef = reconstructNefFile(state.nef);
  await fs.writeFile(`${archiveBase}.nef`, rollbackNef);
  await fs.writeFile(
    `${archiveBase}.rollback.json`,
    jsonSafe({
      network,
      oracle_hash: oracleHash,
      updatecounter: state.updatecounter,
      nef_checksum: state.nef.checksum,
      artifact_sha256: computeUpgradeArtifactHash(rollbackNef, rollbackManifestText),
      nef: `${archiveBase}.nef`,
      manifest: `${archiveBase}.manifest.json`,
    })
  );
} catch (error) {
  console.warn(`NEF reconstruction skipped (${error.message}); contractstate JSON archived.`);
}
console.log(`archived current on-chain state to ${archiveBase}.*`);

// --- 5. Preview of the planned call (test invoke; no signature, no broadcast) ----------
const artifactParams = [
  { type: 'ByteArray', value: nefBytes.toString('base64') },
  { type: 'String', value: manifestRaw },
];
const adminSigner = [{ account: onChainAdmin, scopes: 'CalledByEntry' }];
const invocation = upgradeInvocation(plan.action);
if (plan.action === UPGRADE_ACTIONS.BLOCKED) {
  console.error(`refusing: ${plan.reason}`);
  process.exit(1);
}
if (invocation) {
  const preview = await rpc('invokefunction', [
    oracleHash,
    invocation.method,
    invocation.withArtifact ? artifactParams : [],
    adminSigner,
  ]);
  console.log(
    `${invocation.method} preview: state=${preview.state} gasconsumed=${preview.gasconsumed}${
      preview.exception ? ` exception=${preview.exception}` : ''
    }`
  );
  if (preview.state !== 'HALT') {
    throw new Error(`${invocation.method} test invoke FAULTed; refusing to continue`);
  }
} else if (plan.action === UPGRADE_ACTIONS.WAIT) {
  // Show the kernel's own verdict on an early update.
  const early = await rpc('invokefunction', [oracleHash, 'update', artifactParams, adminSigner]);
  console.log(
    `update preview (timelock running, ${plan.remainingMs} ms left): state=${early.state}${
      early.exception ? ` exception=${early.exception}` : ''
    }`
  );
} else {
  console.log(`nothing to send: ${plan.reason}`);
}

// --- 6. RebuildIndexes chunk plan -------------------------------------------------------
const appCountInvoke = await readMethod('getMiniAppCount');
const appCount = Number(integerFromStackItem(appCountInvoke.stack?.[0]) ?? 0n);
let plannedStart = 0;
if (
  deployedMethods.includes('isIndexRebuildRequired') &&
  deployedMethods.includes('indexRebuildCursor')
) {
  const requiredInvoke = await readMethod('isIndexRebuildRequired');
  if (booleanFromStackItem(requiredInvoke.stack?.[0])) {
    const cursorInvoke = await readMethod('indexRebuildCursor');
    plannedStart = Number(integerFromStackItem(cursorInvoke.stack?.[0]) ?? 0n);
  }
}
const plannedChunks = buildIndexRebuildChunks(appCount, batchSize, plannedStart);
if (appCount === 0) {
  console.log('rebuild plan: registry empty; no rebuildIndexes calls needed.');
} else {
  console.log(
    `rebuild plan: ${appCount} miniapp(s), cursor ${plannedStart} -> ${plannedChunks.length} chunk(s) of ${batchSize}: ${JSON.stringify(plannedChunks)}`
  );
}

if (!applyUpdate && !applyRebuild) {
  console.log(
    invocation
      ? `DRY RUN complete. Set UPGRADE_APPLY=1 to send ${invocation.method}.`
      : 'DRY RUN complete.'
  );
  if (plan.action === UPGRADE_ACTIONS.SCHEDULE) {
    console.log(
      `after it confirms, wait ${TIMELOCK_DELAY_MS / 3_600_000} h and run again with the same --nef/--manifest to execute.`
    );
  }
  console.log('after an update confirms, run again with REBUILD_APPLY=1 to backfill the indexes.');
  process.exit(0);
}

// --- 7. Signer (apply paths only) -------------------------------------------------------
let wif = trimString(process.env.MORPHEUS_ORACLE_ADMIN_WIF || '');
if (!wif) {
  const signer = resolvePinnedNeoN3Role(network, 'updater', { env: process.env });
  wif = signer.materialized?.wif || signer.materialized?.private_key || '';
}
if (!wif) {
  throw new Error('MORPHEUS_ORACLE_ADMIN_WIF (or a pinned updater key) is required to apply');
}
const account = new wallet.Account(wif);
const accountHash = `0x${account.scriptHash}`;
if (accountHash.toLowerCase() !== String(onChainAdmin).toLowerCase()) {
  throw new Error(
    `signer ${account.address} (${accountHash}) is not the on-chain admin ${onChainAdmin}; the call would FAULT`
  );
}
const contract = new experimental.SmartContract(oracleHash, {
  rpcAddress,
  networkMagic,
  account,
});

function artifactContractParams() {
  return [
    sc.ContractParam.byteArray(u.HexString.fromHex(nefBytes.toString('hex'), true)),
    sc.ContractParam.string(manifestRaw),
  ];
}

// --- 8. Apply the planned step ------------------------------------------------------------
let updated = false;
if (applyUpdate) {
  if (plan.action === UPGRADE_ACTIONS.WAIT) {
    throw new Error(
      `the scheduled upgrade is still timelocked for ${plan.remainingMs} ms; run again after ${plan.executeAfterMs}`
    );
  }
  if (!invocation) {
    console.log(`skipping the upgrade transaction: ${plan.reason}`);
  } else {
    const txid = await contract.invoke(
      invocation.method,
      invocation.withArtifact ? artifactContractParams() : []
    );
    console.log(`MorpheusOracle ${invocation.method} tx: ${txid}`);
    await waitForTransaction(txid);

    if (invocation.method === 'update') {
      const after = await rpc('getcontractstate', [oracleHash]);
      if (after.updatecounter !== state.updatecounter + 1 || after.nef.checksum !== localChecksum) {
        throw new Error(
          `post-update state mismatch: updatecounter=${after.updatecounter} checksum=${after.nef.checksum}`
        );
      }
      console.log(
        `update confirmed: updatecounter=${after.updatecounter} checksum=${after.nef.checksum}`
      );
      updated = true;
    } else if (invocation.method === 'scheduleUpdate') {
      const scheduled = await readPendingUpgrade();
      if (!scheduled.scheduled || scheduled.hashHex !== localArtifactHash) {
        throw new Error(
          `schedule not recorded as expected: ${jsonSafe(scheduled)} (wanted ${localArtifactHash})`
        );
      }
      console.log(
        `upgrade scheduled: artifact ${scheduled.hashHex} executable at ${scheduled.executeAfterMs} (Runtime.Time ms)`
      );
    } else if (invocation.method === 'cancelUpdate') {
      const cleared = await readPendingUpgrade();
      if (cleared.scheduled) throw new Error('cancelUpdate confirmed but a schedule remains');
      console.log('scheduled upgrade cancelled.');
    }
  }

  if (updated) {
    // Post-update verification reads: the fee views must answer and the registry must still
    // resolve (storage carried across the update untouched).
    const verification = {};
    for (const method of [
      'accruedRequestFees',
      'reservedRequestFees',
      'withdrawableFees',
      'getMiniAppCount',
      'getTotalRequests',
      'isIndexRebuildRequired',
      'indexRebuildCursor',
    ]) {
      const result = await readMethod(method);
      verification[method] = String(integerFromStackItem(result.stack?.[0]) ?? 'null');
    }
    let probeAppId = trimString(flags['probe-app'] || '');
    if (!probeAppId && appCount > 0) {
      const firstId = await readMethod('getMiniAppIdByIndex', [{ type: 'Integer', value: '0' }]);
      probeAppId = b64ToBuf(firstId.stack?.[0]?.value || '').toString('utf8');
    }
    if (probeAppId) {
      const probe = await readMethod('getMiniApp', [{ type: 'String', value: probeAppId }]);
      const fields = probe.stack?.[0]?.value || [];
      verification.getMiniApp = {
        appId: probeAppId,
        admin: hash160FromStackItem(fields[1]),
        callback: hash160FromStackItem(fields[3]),
        created_at: String(integerFromStackItem(fields[7]) ?? 'null'),
      };
      if (!verification.getMiniApp.created_at || verification.getMiniApp.created_at === '0') {
        throw new Error(
          `GetMiniApp probe for '${probeAppId}' returned an empty record after the update`
        );
      }
    }
    console.log(`post-update verification: ${JSON.stringify(verification, null, 2)}`);
  }
}

// --- 9. Chunked RebuildIndexes backfill ---------------------------------------------------
if (applyRebuild) {
  const current = await rpc('getcontractstate', [oracleHash]);
  const currentMethods = current.manifest.abi.methods.map((m) => m.name);
  if (!currentMethods.includes('rebuildIndexes')) {
    throw new Error(
      'deployed kernel has no rebuildIndexes; run the update first (UPGRADE_APPLY=1)'
    );
  }

  const currentCountInvoke = await readMethod('getMiniAppCount');
  const rebuildAppCount = Number(integerFromStackItem(currentCountInvoke.stack?.[0]) ?? 0n);
  let rebuildStart = 0;
  let lockActive = false;
  if (
    currentMethods.includes('isIndexRebuildRequired') &&
    currentMethods.includes('indexRebuildCursor')
  ) {
    const requiredInvoke = await readMethod('isIndexRebuildRequired');
    lockActive = booleanFromStackItem(requiredInvoke.stack?.[0]) === true;
    if (lockActive) {
      const cursorInvoke = await readMethod('indexRebuildCursor');
      rebuildStart = Number(integerFromStackItem(cursorInvoke.stack?.[0]) ?? 0n);
    }
  }
  const rebuildChunks = lockActive
    ? buildIndexRebuildChunks(rebuildAppCount, batchSize, rebuildStart)
    : currentMethods.includes('isIndexRebuildRequired')
      ? []
      : buildIndexRebuildChunks(rebuildAppCount, batchSize, 0);
  console.log(
    lockActive
      ? `resuming required index rebuild at cursor ${rebuildStart}/${rebuildAppCount}`
      : 'no required index rebuild is active; verification only'
  );

  for (const [start, count] of rebuildChunks) {
    const params = [
      { type: 'Integer', value: String(start) },
      { type: 'Integer', value: String(count) },
    ];
    const chunkPreview = await rpc('invokefunction', [
      oracleHash,
      'rebuildIndexes',
      params,
      adminSigner,
    ]);
    if (chunkPreview.state !== 'HALT') {
      throw new Error(
        `rebuildIndexes(${start}, ${count}) preview FAULTed: ${chunkPreview.exception || 'unknown'}`
      );
    }
    const txid = await contract.invoke('rebuildIndexes', [
      sc.ContractParam.integer(start),
      sc.ContractParam.integer(count),
    ]);
    console.log(
      `rebuildIndexes(${start}, ${count}) tx: ${txid} (preview gas ${chunkPreview.gasconsumed})`
    );
    await waitForTransaction(txid);
  }

  if (currentMethods.includes('isIndexRebuildRequired')) {
    const requiredInvoke = await readMethod('isIndexRebuildRequired');
    if (booleanFromStackItem(requiredInvoke.stack?.[0])) {
      throw new Error('index rebuild remains locked after the planned chunks');
    }
  }

  // Verify the callback index against the registry. Expected semantics are
  // first-wins: when legacy records share a callback, the earliest-registered
  // app keeps the mapping (matches the pre-index O(n) resolver).
  const expected = new Map();
  const appsWithCallbacks = [];
  for (let index = 0; index < rebuildAppCount; index++) {
    const idInvoke = await readMethod('getMiniAppIdByIndex', [
      { type: 'Integer', value: String(index) },
    ]);
    const appId = b64ToBuf(idInvoke.stack?.[0]?.value || '').toString('utf8');
    if (!appId) continue;
    const appInvoke = await readMethod('getMiniApp', [{ type: 'String', value: appId }]);
    const callback = hash160FromStackItem(appInvoke.stack?.[0]?.value?.[3]);
    if (!callback) continue;
    appsWithCallbacks.push({ appId, callback });
    if (!expected.has(callback)) expected.set(callback, appId);
  }
  let verified = 0;
  for (const [callback, appId] of expected) {
    const callbackLe = Buffer.from(callback.slice(2), 'hex').reverse();
    const key = Buffer.concat([Buffer.from([PREFIX_CALLBACK_INDEX]), callbackLe]);
    const stored = await rpc('getstorage', [oracleHash, key.toString('base64')]);
    const storedAppId = stored ? b64ToBuf(stored).toString('utf8') : null;
    if (storedAppId !== appId) {
      throw new Error(
        `callback index mismatch for ${callback}: expected '${appId}', found '${storedAppId}'`
      );
    }
    verified += 1;
  }
  const skipped = appsWithCallbacks.length - expected.size;
  console.log(
    `rebuild verified: ${verified} callback mapping(s) correct` +
      (skipped > 0 ? `; ${skipped} legacy duplicate record(s) correctly skipped (first-wins)` : '')
  );
}
