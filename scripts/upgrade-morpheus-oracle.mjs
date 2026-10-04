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
 *   node scripts/upgrade-morpheus-oracle.mjs [--network testnet|mainnet]
 *       [--rpc <url> [--rpc <url2>]] [--env-file <path>]
 *       [--oracle <hash>] [--nef <path>] [--manifest <path>] [--archive-dir <dir>]
 *       [--batch-size 16] [--probe-app <appId>] [--system-fee-margin <percent>]
 *       [--skip-simulation] [--cancel] [--reschedule] [--allow-same-artifact]
 *
 * Safety model:
 *   - NOTHING is read from the checkout implicitly: neither ./.env nor
 *     deploy/nitro/morpheus.<network>.env. A file is loaded only when named with --env-file, and
 *     the real environment wins over it.
 *   - Endpoints: --rpc (repeatable) names the node(s). The first receives the transactions and
 *     answers every read; every further one is a read-only cross-check. Without --rpc, NEO_RPC_URL,
 *     then two independent official public nodes. All endpoints must be on --network and must agree
 *     about the deployed kernel (updatecounter, NEF checksum, manifest) before anything is planned.
 *     A mainnet apply requires --rpc on the command line.
 *   - DRY RUN by default: read-only RPC only. Reports the deployed state, the local artifact
 *     and its sha256(nef || manifest), the pending schedule and the planned step; archives
 *     the current on-chain NEF + manifest (the rollback artifact) under --archive-dir;
 *     simulates the planned call on the node (an invokefunction: a node-side simulation, not a
 *     transaction; --skip-simulation skips it) with the admin as signer; prints the RebuildIndexes
 *     plan. Nothing is signed or broadcast.
 *   - UPGRADE_APPLY=1: signs and broadcasts the planned step with the admin key
 *     (MORPHEUS_ORACLE_ADMIN_WIF, falling back to the pinned updater role) and verifies it.
 *     The transaction's system fee is the node's simulation plus --system-fee-margin percent
 *     (default 10). A running timelock or a conflicting schedule is refused, never worked around.
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
  applySystemFeeMargin,
  assertNefChecksum,
  assertRpcAgreement,
  canonicalManifestText,
  computeUpgradeArtifactHash,
  decodePendingUpgrade,
  decodeStackItem,
  describeRollbackArtifact,
  describeUpgradeGate,
  isUnknownStorageItemError,
  manifestHasMethod,
  manifestsEquivalent,
  observeContractState,
  parseSystemFeeMarginPercent,
  reconstructNefFile,
  planKernelUpgrade,
  resolveRpcEndpoints,
  splitGettersByAbi,
  storageKeyBase64,
  upgradeInvocation,
} from './lib-oracle-upgrade.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { experimental, sc, tx, u, wallet } from '@cityofzion/neon-js';
import { loadNamedEnvFiles } from './lib-env.mjs';
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
// Zero-argument getters read after an update, when the target ABI has them.
const POST_UPDATE_GETTERS = [
  'accruedRequestFees',
  'reservedRequestFees',
  'withdrawableFees',
  'getMiniAppCount',
  'getTotalRequests',
  'isIndexRebuildRequired',
  'indexRebuildCursor',
];
const SIMULATION_NOTE =
  'a node-side simulation: the node runs the call in a throwaway VM; it is not a transaction, ' +
  'nothing is signed or broadcast and no state changes';

const { values: flags } = parseArgs({
  options: {
    network: { type: 'string' },
    'batch-size': { type: 'string' },
    rpc: { type: 'string', multiple: true },
    'env-file': { type: 'string', multiple: true },
    'probe-app': { type: 'string' },
    oracle: { type: 'string' },
    nef: { type: 'string' },
    manifest: { type: 'string' },
    'archive-dir': { type: 'string' },
    'system-fee-margin': { type: 'string' },
    'skip-simulation': { type: 'boolean', default: false },
    cancel: { type: 'boolean', default: false },
    reschedule: { type: 'boolean', default: false },
    'allow-same-artifact': { type: 'boolean', default: false },
  },
});

// Environment files are an explicit choice: a populated checkout (./.env,
// deploy/nitro/morpheus.<network>.env) must not be able to change the RPC, the network magic or the
// signer of a run that did not ask for it. Node itself also recognises --env-file anywhere on the
// command line and loads the file before this script starts (a missing file ends the process there,
// exit 9). Both loaders agree: the real environment wins over a file and a later file wins over an
// earlier one.
await loadNamedEnvFiles(flags['env-file'] ?? []);

const network = normalizeMorpheusNetwork(
  flags.network || process.env.MORPHEUS_NETWORK || 'testnet'
);
const applyUpdate = process.env.UPGRADE_APPLY === '1';
const applyRebuild = process.env.REBUILD_APPLY === '1';
const skipSimulation = flags['skip-simulation'] === true;
if (skipSimulation && (applyUpdate || applyRebuild)) {
  throw new Error(
    '--skip-simulation is for dry runs: an apply simulates each call before it signs it, and the ' +
      "simulated gas is the transaction's system fee"
  );
}
const feeMarginPercent = parseSystemFeeMarginPercent(flags['system-fee-margin']);
const { urls: rpcUrls, source: rpcSource } = resolveRpcEndpoints({
  network,
  flagUrls: flags.rpc ?? [],
  envUrl: trimString(process.env.NEO_RPC_URL),
  applying: applyUpdate || applyRebuild,
});
const rpcAddress = rpcUrls[0];
const rpcPeers = rpcUrls.slice(1);
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
if (network === 'mainnet' && rpcUrls.length === 1) {
  console.error(
    'note: a single RPC endpoint is used for planning, sending and verifying, so its answers are ' +
      'not cross-checked; pass --rpc twice (two independent nodes) to require agreement.'
  );
}

let rpcId = 0;

class RpcError extends Error {
  constructor(method, rpcError) {
    super(`${method} RPC error: ${JSON.stringify(rpcError)}`);
    this.name = 'RpcError';
    this.method = method;
    this.rpcError = rpcError;
  }
}

// One JSON-RPC call; `raw` is the response body exactly as the node sent it.
async function rpcCall(url, method, params) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
  } catch (error) {
    throw new Error(
      `${method} request to ${url} failed: ${error.cause?.message || error.message}`,
      {
        cause: error,
      }
    );
  }
  if (!response.ok) throw new Error(`${method} HTTP ${response.status} from ${url}`);
  const raw = Buffer.from(await response.arrayBuffer());
  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error(`${method} from ${url} did not return JSON`);
  }
  if (body.error) throw new RpcError(method, body.error);
  return { result: body.result, raw };
}

async function rpcAt(url, method, params) {
  return (await rpcCall(url, method, params)).result;
}

function rpc(method, params) {
  return rpcAt(rpcAddress, method, params);
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

// getstorage as a base64 value, or null for a key that is not stored. neo-go (0.121, 0.123) and
// C# Neo (3.10) answer an absent key with the JSON-RPC error -104 "Unknown storage item"; older
// nodes answered null. Any other error is a real failure.
async function readStorage(keyBase64) {
  try {
    return (await rpc('getstorage', [oracleHash, keyBase64])) ?? null;
  } catch (error) {
    if (error instanceof RpcError && isUnknownStorageItemError(error.rpcError)) return null;
    throw error;
  }
}

async function readPendingUpgrade() {
  const [timeBase64, hashBase64] = await Promise.all([
    readStorage(storageKeyBase64(PREFIX_UPGRADE_TIME)),
    readStorage(storageKeyBase64(PREFIX_UPGRADE_HASH)),
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

// --- 0. Every endpoint is on this network and they agree about the kernel ------------------------
for (const url of rpcUrls) {
  const reported = (await rpcAt(url, 'getversion', []))?.protocol?.network;
  if (reported !== networkMagic) {
    throw new Error(
      `RPC endpoint ${url} reports network magic ${reported}, not the reviewed ${network} magic ${networkMagic}`
    );
  }
}

// --- 1. Current deployed state (read-only) ------------------------------------------
const stateResponse = await rpcCall(rpcAddress, 'getcontractstate', [oracleHash]);
const state = stateResponse.result;
const observations = [observeContractState(rpcAddress, state)];
for (const peer of rpcPeers) {
  try {
    observations.push(
      observeContractState(peer, await rpcAt(peer, 'getcontractstate', [oracleHash]))
    );
  } catch (error) {
    throw new Error(`cross-check endpoint ${peer}: ${error.message}`, { cause: error });
  }
}
const rpcAgreement = assertRpcAgreement(observations);
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
    rpc_peers: rpcPeers,
    rpc_source: rpcSource,
    rpc_agreement: rpcAgreement,
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
    preview_simulation: !skipSimulation,
    system_fee_margin_percent: feeMarginPercent,
    mode: applyUpdate ? 'APPLY' : applyRebuild ? 'APPLY (index rebuild)' : 'DRY RUN',
  })
);

// --- 4. Archive the current on-chain state (rollback artifact) ------------------------
// The archive holds the node's answer byte for byte (.getcontractstate.raw.json) and the artifact
// the way a rollback submits it: the NEF and the manifest in canonical form. The manifest as the
// serving node emitted it depends on that node's key order (neo-go and C# differ), so the hash a
// rollback pins is computed over the canonical form: it is the same whichever node served it.
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const archiveDir = path.resolve(flags['archive-dir'] || path.join('private-backups', 'upgrades'));
await fs.mkdir(archiveDir, { recursive: true });
const archiveBase = path.join(
  archiveDir,
  `morpheus-oracle.${network}.uc${state.updatecounter}.${timestamp}`
);
await fs.writeFile(`${archiveBase}.getcontractstate.raw.json`, stateResponse.raw);
await fs.writeFile(`${archiveBase}.contractstate.json`, JSON.stringify(state, null, 2));
const servedManifestText = JSON.stringify(state.manifest);
await fs.writeFile(`${archiveBase}.manifest.served.json`, servedManifestText);
await fs.writeFile(`${archiveBase}.manifest.json`, canonicalManifestText(servedManifestText));
try {
  // Byte-exact NEF so a rollback can submit the deployed code (checksum-validated).
  const rollbackNef = reconstructNefFile(state.nef);
  await fs.writeFile(`${archiveBase}.nef`, rollbackNef);
  const identity = describeRollbackArtifact({ nefBytes: rollbackNef, servedManifestText });
  await fs.writeFile(
    `${archiveBase}.rollback.json`,
    jsonSafe({
      network,
      oracle_hash: oracleHash,
      updatecounter: state.updatecounter,
      nef_checksum: state.nef.checksum,
      artifact_sha256: identity.artifact_sha256,
      artifact_form: identity.artifact_form,
      served_artifact_sha256: identity.served_artifact_sha256,
      nef_sha256: identity.nef_sha256,
      manifest_sha256: identity.manifest_sha256,
      served_manifest_sha256: identity.served_manifest_sha256,
      nef: `${archiveBase}.nef`,
      manifest: `${archiveBase}.manifest.json`,
      manifest_served: `${archiveBase}.manifest.served.json`,
      contractstate_raw: `${archiveBase}.getcontractstate.raw.json`,
      served_by: rpcAddress,
    })
  );
} catch (error) {
  console.warn(`NEF reconstruction skipped (${error.message}); contractstate JSON archived.`);
}
console.log(`archived current on-chain state to ${archiveBase}.*`);

// --- 5. Preview of the planned call (a node-side simulation; no signature, no broadcast) ------
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
  if (skipSimulation) {
    console.log(
      `${invocation.method} simulation skipped (--skip-simulation): no state-changing method was ` +
        'simulated on the node, so neither its verdict nor its gas is shown.'
    );
  } else {
    console.log(
      `previewing ${invocation.method} with invokefunction, ${SIMULATION_NOTE}. ` +
        '--skip-simulation skips it.'
    );
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
    console.log(
      `apply would attach system fee ${applySystemFeeMargin(preview.gasconsumed, feeMarginPercent)} ` +
        `(simulated ${preview.gasconsumed} + ${feeMarginPercent}% margin)`
    );
  }
} else if (plan.action === UPGRADE_ACTIONS.WAIT) {
  if (skipSimulation) {
    console.log(
      "update simulation skipped (--skip-simulation): the kernel's own verdict on an early update is not shown."
    );
  } else {
    // Show the kernel's own verdict on an early update.
    console.log(`previewing an early update with invokefunction, ${SIMULATION_NOTE}.`);
    const early = await rpc('invokefunction', [oracleHash, 'update', artifactParams, adminSigner]);
    console.log(
      `update preview (timelock running, ${plan.remainingMs} ms left): state=${early.state}${
        early.exception ? ` exception=${early.exception}` : ''
      }`
    );
  }
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
const txConfig = { rpcAddress, networkMagic, account };

function artifactContractParams() {
  return [
    sc.ContractParam.byteArray(u.HexString.fromHex(nefBytes.toString('hex'), true)),
    sc.ContractParam.string(manifestRaw),
  ];
}

// Sends one call of the kernel signed by the admin. The system fee is the node's simulation of
// this very call plus the margin: the simulation is of the state at signing time, and state that
// moves before inclusion can push the real cost over a fee with no headroom (a FAULT that still
// burns the fee).
async function sendInvocation(method, params) {
  const builder = new sc.ScriptBuilder();
  builder.emitAppCall(oracleHash, method, params);
  const signer = new tx.Signer({ account: account.scriptHash, scopes: 'CalledByEntry' });
  const simulated = BigInt(
    (
      await experimental.txHelpers.getSystemFee(u.HexString.fromHex(builder.build()), txConfig, [
        signer,
      ])
    ).toString()
  );
  const systemFee = applySystemFeeMargin(simulated, feeMarginPercent);
  console.log(
    `system fee for ${method}: simulated ${simulated} + ${feeMarginPercent}% margin = ${systemFee} ` +
      `datoshi (${u.BigInteger.fromNumber(systemFee.toString()).toDecimal(8)} GAS)`
  );
  const contract = new experimental.SmartContract(oracleHash, {
    ...txConfig,
    systemFeeOverride: u.BigInteger.fromNumber(systemFee.toString()),
  });
  return contract.invoke(method, params);
}

// --- 8. Apply the planned step ------------------------------------------------------------
let updated = false;
let targetManifest = null; // the ABI on chain after an update
if (applyUpdate) {
  if (plan.action === UPGRADE_ACTIONS.WAIT) {
    throw new Error(
      `the scheduled upgrade is still timelocked for ${plan.remainingMs} ms; run again after ${plan.executeAfterMs}`
    );
  }
  if (!invocation) {
    console.log(`skipping the upgrade transaction: ${plan.reason}`);
  } else {
    const txid = await sendInvocation(
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
      // The ABI now on chain decides what can be read: a rollback lands on an older ABI that lacks
      // the newer getters (a call to one FAULTs), and the new ABI's Boolean getters are not integers.
      targetManifest = after.manifest;
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
    // resolve (storage carried across the update untouched). Only members of the ABI that is
    // now on chain are read.
    const { present, absent } = splitGettersByAbi(targetManifest, POST_UPDATE_GETTERS);
    const verification = {};
    for (const method of present) {
      const result = await readMethod(method);
      verification[method] = decodeStackItem(result.stack?.[0]);
    }
    if (absent.length > 0) verification.not_in_target_abi = absent;
    let probeAppId = trimString(flags['probe-app'] || '');
    const canProbe =
      manifestHasMethod(targetManifest, 'getMiniAppIdByIndex', 1) &&
      manifestHasMethod(targetManifest, 'getMiniApp', 1);
    if (!canProbe) {
      verification.probe_skipped = 'getMiniAppIdByIndex/getMiniApp are not in the target ABI';
    } else {
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
    const txid = await sendInvocation('rebuildIndexes', [
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
    const stored = await readStorage(key.toString('base64'));
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
