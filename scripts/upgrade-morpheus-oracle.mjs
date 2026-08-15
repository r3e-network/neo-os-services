#!/usr/bin/env node
/**
 * MorpheusOracle (MiniApp OS kernel) in-place upgrade via ContractManagement.Update.
 *
 * Ships the prepared kernel generation (reserved-fee pool + gated WithdrawAccruedFees,
 * O(1) callback reverse index with the uniqueness assert, RebuildIndexes backfill) onto
 * the deployed kernel hash. See docs/runbooks/morpheus-oracle-upgrade.md for the full
 * operational order (testnet -> smoke -> backfill -> mainnet).
 *
 * Usage:
 *   node scripts/upgrade-morpheus-oracle.mjs [--network testnet|mainnet]
 *                                            [--batch-size 16] [--rpc <url>]
 *
 * Safety model (mirrors the repo's deploy gates):
 *   - DRY RUN by default: read-only RPC only. Reports the deployed state (updatecounter,
 *     checksum, admin/updater), diffs the local contracts/build artifact against it,
 *     archives the current on-chain state to private-backups/upgrades/ (the rollback
 *     artifact), test-invokes `update` for a gas estimate, and prints the RebuildIndexes
 *     chunk plan. Nothing is signed or broadcast.
 *   - UPGRADE_APPLY=1: signs and broadcasts the `update` transaction with the admin key
 *     (MORPHEUS_ORACLE_ADMIN_WIF, falling back to the pinned updater role), then runs the
 *     post-update verification reads.
 *   - REBUILD_APPLY=1: runs the chunked rebuildIndexes backfill (requires the upgraded
 *     contract on-chain) and verifies the callback index against the registry via
 *     getstorage. Independent of UPGRADE_APPLY so the backfill can be resumed.
 */
import { trimString } from './lib-strings.mjs';
import { buildIndexRebuildChunks } from './lib-index-rebuild-plan.mjs';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { experimental, sc, u, wallet } from '@cityofzion/neon-js';
import { loadDotEnv } from './lib-env.mjs';
import { normalizeMorpheusNetwork, resolvePinnedNeoN3Role } from './lib-neo-signers.mjs';

const DEFAULT_ORACLE_HASH = '0xf54d8584ef82315c1800373272ab08ae0db2d5ef';
const PREFIX_CALLBACK_INDEX = 0x27; // MorpheusOracle.cs PREFIX_CALLBACK_INDEX
const TX_POLL_ATTEMPTS = 18;
const TX_POLL_INTERVAL_MS = 5_000;

const { values: flags } = parseArgs({
  options: {
    network: { type: 'string' },
    'batch-size': { type: 'string' },
    rpc: { type: 'string' },
    'probe-app': { type: 'string' },
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
  process.env.NEO_NETWORK_MAGIC || (network === 'mainnet' ? 860833102 : 894710606)
);
const oracleHash = trimString(process.env.CONTRACT_MORPHEUS_ORACLE_HASH || DEFAULT_ORACLE_HASH);
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

// Rebuilds the raw NEF *file* bytes from the getcontractstate `nef` JSON so a rollback
// is simply `update` with this exact file. neon-js' NEF.fromJson does not round-trip
// the RPC shape (base64 script, named callflags, big-endian token hashes), so the file
// is assembled manually per the NEF3 layout and validated against the on-chain checksum.
function reconstructNefFile(nefJson) {
  const CALL_FLAGS = {
    None: 0,
    ReadStates: 1,
    WriteStates: 2,
    AllowCall: 4,
    AllowNotify: 8,
    States: 3,
    ReadOnly: 5,
    All: 15,
  };
  const varInt = (n) => {
    if (n < 0xfd) return Buffer.from([n]);
    if (n <= 0xffff) {
      const b = Buffer.alloc(3);
      b[0] = 0xfd;
      b.writeUInt16LE(n, 1);
      return b;
    }
    const b = Buffer.alloc(5);
    b[0] = 0xfe;
    b.writeUInt32LE(n, 1);
    return b;
  };
  const varBytes = (buf) => Buffer.concat([varInt(buf.length), buf]);
  const varStr = (s) => varBytes(Buffer.from(s ?? '', 'utf8'));

  const parts = [Buffer.from('NEF3', 'ascii')];
  const compiler = Buffer.alloc(64);
  Buffer.from(nefJson.compiler ?? '', 'utf8').copy(compiler);
  parts.push(compiler);
  parts.push(varStr(nefJson.source || ''));
  parts.push(Buffer.from([0])); // reserved
  parts.push(varInt(nefJson.tokens.length));
  for (const token of nefJson.tokens) {
    parts.push(Buffer.from(token.hash.replace(/^0x/, ''), 'hex').reverse()); // LE
    parts.push(varStr(token.method));
    const paramCount = Buffer.alloc(2);
    paramCount.writeUInt16LE(token.paramcount);
    parts.push(paramCount);
    parts.push(Buffer.from([token.hasreturnvalue ? 1 : 0]));
    const callFlags =
      typeof token.callflags === 'string' ? CALL_FLAGS[token.callflags] : token.callflags;
    if (callFlags === undefined) throw new Error(`unknown call flags '${token.callflags}'`);
    parts.push(Buffer.from([callFlags]));
  }
  parts.push(Buffer.alloc(2)); // reserved u16
  parts.push(varBytes(Buffer.from(nefJson.script, 'base64')));
  const body = Buffer.concat(parts);
  const checksum = createHash('sha256')
    .update(createHash('sha256').update(body).digest())
    .digest()
    .readUInt32LE(0);
  if (checksum !== nefJson.checksum) {
    throw new Error(`reconstructed checksum ${checksum} != reported ${nefJson.checksum}`);
  }
  const tail = Buffer.alloc(4);
  tail.writeUInt32LE(checksum);
  return Buffer.concat([body, tail]);
}

async function readMethod(method, params = [], signers = []) {
  const result = await rpc('invokefunction', [oracleHash, method, params, signers]);
  if (result.state !== 'HALT') {
    throw new Error(`${method} test invoke FAULTed: ${result.exception || 'unknown'}`);
  }
  return result;
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
const deployedMethods = state.manifest.abi.methods.map((m) => m.name);
const updateAbi = state.manifest.abi.methods.find((m) => m.name === 'update');
if (!updateAbi || updateAbi.parameters.length !== 2) {
  throw new Error(
    'deployed kernel does not expose update(nefFile, manifest); cannot upgrade in place'
  );
}

const adminInvoke = await readMethod('admin');
const updaterInvoke = await readMethod('updater');
const onChainAdmin = hash160FromStackItem(adminInvoke.stack?.[0]);
const onChainUpdater = hash160FromStackItem(updaterInvoke.stack?.[0]);

// --- 2. Local artifact ----------------------------------------------------------------
const nefPath = path.resolve('contracts/build/MorpheusOracle.nef');
const manifestPath = path.resolve('contracts/build/MorpheusOracle.manifest.json');
const [nefBytes, manifestRaw] = await Promise.all([
  fs.readFile(nefPath),
  fs.readFile(manifestPath, 'utf8'),
]);
const localManifest = JSON.parse(manifestRaw);
const localMethods = localManifest.abi.methods.map((m) => m.name);
const localChecksum = nefBytes.readUInt32LE(nefBytes.length - 4);
const addedMethods = localMethods.filter((m) => !deployedMethods.includes(m));
const removedMethods = deployedMethods.filter((m) => !localMethods.includes(m));

console.log(
  JSON.stringify(
    {
      network,
      rpc: rpcAddress,
      oracle_hash: oracleHash,
      deployed: {
        updatecounter: state.updatecounter,
        nef_checksum: state.nef.checksum,
        method_count: deployedMethods.length,
        admin: onChainAdmin,
        updater: onChainUpdater,
        update_gate: 'admin witness (ValidateAdmin)',
      },
      local: {
        nef: nefPath,
        nef_checksum: localChecksum,
        method_count: localMethods.length,
        methods_added: addedMethods,
        methods_removed: removedMethods,
      },
      checksum_changed: localChecksum !== state.nef.checksum,
      mode: applyUpdate ? 'APPLY' : 'DRY RUN',
    },
    null,
    2
  )
);

if (localChecksum === state.nef.checksum) {
  console.log('local NEF checksum equals the deployed checksum; nothing to update.');
}

// --- 3. Archive the current on-chain state (rollback artifact) ------------------------
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const archiveDir = path.resolve('private-backups', 'upgrades');
await fs.mkdir(archiveDir, { recursive: true });
const archiveBase = path.join(
  archiveDir,
  `morpheus-oracle.${network}.uc${state.updatecounter}.${timestamp}`
);
await fs.writeFile(`${archiveBase}.contractstate.json`, JSON.stringify(state, null, 2));
try {
  // Reconstruct the raw NEF file bytes so a rollback is `update` with this exact file.
  await fs.writeFile(`${archiveBase}.nef`, reconstructNefFile(state.nef));
} catch (error) {
  console.warn(`NEF reconstruction skipped (${error.message}); contractstate JSON archived.`);
}
await fs.writeFile(`${archiveBase}.manifest.json`, JSON.stringify(state.manifest, null, 2));
console.log(`archived current on-chain state to ${archiveBase}.*`);

// --- 4. Update preview (test invoke; no signature, no broadcast) -----------------------
const updateParams = [
  { type: 'ByteArray', value: nefBytes.toString('base64') },
  { type: 'String', value: manifestRaw },
];
const adminSigner = [{ account: onChainAdmin, scopes: 'CalledByEntry' }];
const preview = await rpc('invokefunction', [oracleHash, 'update', updateParams, adminSigner]);
console.log(
  `update preview: state=${preview.state} gasconsumed=${preview.gasconsumed}${
    preview.exception ? ` exception=${preview.exception}` : ''
  }`
);
if (preview.state !== 'HALT') {
  throw new Error('update test invoke FAULTed; refusing to continue');
}

// --- 5. RebuildIndexes chunk plan -------------------------------------------------------
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
  console.log('DRY RUN complete. Set UPGRADE_APPLY=1 to send the update transaction;');
  console.log('after it confirms, run again with REBUILD_APPLY=1 to backfill the indexes.');
  process.exit(0);
}

// --- 6. Signer (apply paths only) -------------------------------------------------------
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
    `signer ${account.address} (${accountHash}) is not the on-chain admin ${onChainAdmin}; the update would FAULT`
  );
}
const contract = new experimental.SmartContract(oracleHash, {
  rpcAddress,
  networkMagic,
  account,
});

// --- 7. Apply the update ----------------------------------------------------------------
if (applyUpdate) {
  if (localChecksum === state.nef.checksum) {
    console.log('skipping update transaction: checksum unchanged.');
  } else {
    const txid = await contract.invoke('update', [
      sc.ContractParam.byteArray(u.HexString.fromHex(nefBytes.toString('hex'), true)),
      sc.ContractParam.string(manifestRaw),
    ]);
    console.log(`MorpheusOracle update tx: ${txid}`);
    await waitForTransaction(txid);

    const updated = await rpc('getcontractstate', [oracleHash]);
    if (
      updated.updatecounter !== state.updatecounter + 1 ||
      updated.nef.checksum !== localChecksum
    ) {
      throw new Error(
        `post-update state mismatch: updatecounter=${updated.updatecounter} checksum=${updated.nef.checksum}`
      );
    }
    console.log(
      `update confirmed: updatecounter=${updated.updatecounter} checksum=${updated.nef.checksum}`
    );
  }

  // Post-update verification reads: the new fee views must answer and the registry
  // must still resolve (storage carried across the update untouched).
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

// --- 8. Chunked RebuildIndexes backfill ---------------------------------------------------
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
