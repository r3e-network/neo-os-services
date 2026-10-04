// Pure helpers for scripts/upgrade-morpheus-oracle.mjs: artifact identity, the deployed
// kernel's update gate, the pending timelocked upgrade, and the next step to take.
//
// Two kernel generations exist on chain. The one deployed on 2026-09-28 exposes an
// admin-gated update(nef, manifest) that applies immediately. The generation that replaces
// it (MorpheusOracle.cs "timelocked, hash-pinned self-upgrade") accepts update only after
// scheduleUpdate(nef, manifest) pinned sha256(nef || manifest) and TIMELOCK_DELAY_MS
// elapsed, and cancelUpdate clears the schedule. After the first upgrade every later
// update, including a rollback, takes the scheduled path, so the tool must plan it.

import { createHash } from 'node:crypto';

// MorpheusOracle.cs storage prefixes and delay for the timelocked self-upgrade.
export const PREFIX_UPGRADE_TIME = 0x31;
export const PREFIX_UPGRADE_HASH = 0x32;
export const TIMELOCK_DELAY_MS = 86_400_000;

export const UPGRADE_ACTIONS = Object.freeze({
  NOOP: 'noop',
  UPDATE: 'update',
  SCHEDULE: 'schedule',
  WAIT: 'wait',
  EXECUTE: 'execute',
  CANCEL: 'cancel',
  BLOCKED: 'blocked',
});

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest();
}

// The value ScheduleUpdate stores and Update recomputes:
// CryptoLib.Sha256(Helper.Concat(nefFile, (ByteString)manifest)).
export function computeUpgradeArtifactHash(nefBytes, manifestText) {
  if (typeof manifestText !== 'string' || manifestText.length === 0) {
    throw new Error('manifest text is required');
  }
  const nef = Buffer.from(nefBytes);
  if (nef.length === 0) throw new Error('NEF bytes are required');
  return sha256(Buffer.concat([nef, Buffer.from(manifestText, 'utf8')])).toString('hex');
}

// NEF3 checksum: the first four bytes (little-endian) of SHA256(SHA256(body)), where the
// body is every byte before the trailing checksum.
export function computeNefBodyChecksum(body) {
  return sha256(sha256(Buffer.from(body))).readUInt32LE(0);
}

export function nefChecksum(nefBytes) {
  const nef = Buffer.from(nefBytes);
  if (nef.length < 4 + 4 || nef.subarray(0, 4).toString('ascii') !== 'NEF3') {
    throw new Error('not a NEF3 file');
  }
  return nef.readUInt32LE(nef.length - 4);
}

export function assertNefChecksum(nefBytes) {
  const nef = Buffer.from(nefBytes);
  const declared = nefChecksum(nef);
  const actual = computeNefBodyChecksum(nef.subarray(0, nef.length - 4));
  if (declared !== actual) {
    throw new Error(`NEF checksum ${declared} does not match its contents (${actual})`);
  }
  return declared;
}

const CALL_FLAGS = Object.freeze({
  None: 0,
  ReadStates: 1,
  WriteStates: 2,
  AllowCall: 4,
  AllowNotify: 8,
  States: 3,
  ReadOnly: 5,
  All: 15,
});

function varInt(n) {
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
}

function varBytes(buf) {
  return Buffer.concat([varInt(buf.length), buf]);
}

function varString(text) {
  return varBytes(Buffer.from(text ?? '', 'utf8'));
}

// Rebuilds the raw NEF file from the getcontractstate `nef` JSON so a rollback can submit
// exactly the deployed bytes. neon-js' NEF.fromJson does not round-trip the RPC shape
// (base64 script, named call flags, big-endian token hashes), so the file is assembled per
// the NEF3 layout and checked against the checksum the node reported.
export function reconstructNefFile(nefJson) {
  if (!nefJson || typeof nefJson !== 'object' || typeof nefJson.script !== 'string') {
    throw new Error('getcontractstate nef JSON is required');
  }
  const parts = [Buffer.from('NEF3', 'ascii')];
  const compiler = Buffer.alloc(64);
  Buffer.from(nefJson.compiler ?? '', 'utf8').copy(compiler);
  parts.push(compiler);
  parts.push(varString(nefJson.source || ''));
  parts.push(Buffer.from([0])); // reserved
  const tokens = Array.isArray(nefJson.tokens) ? nefJson.tokens : [];
  parts.push(varInt(tokens.length));
  for (const token of tokens) {
    parts.push(Buffer.from(String(token.hash).replace(/^0x/i, ''), 'hex').reverse()); // LE
    parts.push(varString(token.method));
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
  const checksum = computeNefBodyChecksum(body);
  if (checksum !== nefJson.checksum) {
    throw new Error(`reconstructed checksum ${checksum} != reported ${nefJson.checksum}`);
  }
  const tail = Buffer.alloc(4);
  tail.writeUInt32LE(checksum);
  return Buffer.concat([body, tail]);
}

function hasMethod(methods, name, arity) {
  return methods.some(
    (method) =>
      method?.name === name &&
      Array.isArray(method.parameters) &&
      method.parameters.length === arity
  );
}

// True when the manifest's ABI has a method with this name and parameter count.
export function manifestHasMethod(manifest, name, arity = 0) {
  return hasMethod(manifest?.abi?.methods ?? [], name, arity);
}

// Splits zero-argument getters into those the manifest's ABI has and those it lacks, so a
// verification never calls a member of another generation (a call to one FAULTs).
export function splitGettersByAbi(manifest, names) {
  const present = [];
  const absent = [];
  for (const name of names) (manifestHasMethod(manifest, name, 0) ? present : absent).push(name);
  return { present, absent };
}

// Which update path the deployed ABI offers. Throws when the kernel cannot be updated in
// place, or when it exposes only half of the timelock (never guess the gate).
export function describeUpgradeGate(manifest) {
  const methods = manifest?.abi?.methods;
  if (!Array.isArray(methods)) throw new Error('deployed manifest carries no ABI');
  if (!hasMethod(methods, 'update', 2)) {
    throw new Error('deployed kernel does not expose update(nefFile, manifest)');
  }
  const schedule = hasMethod(methods, 'scheduleUpdate', 2);
  const cancel = hasMethod(methods, 'cancelUpdate', 0);
  if (schedule !== cancel) {
    throw new Error('deployed kernel exposes an incomplete update timelock ABI');
  }
  return { timelocked: schedule };
}

// Decodes a Neo storage integer (little-endian two's complement; empty is zero).
export function decodeStorageInteger(base64) {
  const bytes = Buffer.from(String(base64 ?? ''), 'base64');
  if (bytes.length === 0) return 0n;
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index--) {
    value = (value << 8n) | BigInt(bytes[index]);
  }
  if (bytes[bytes.length - 1] & 0x80) {
    value -= 1n << BigInt(bytes.length * 8);
  }
  return value;
}

// The pending upgrade read from storage. null (or an empty string) stands for an absent key: the
// caller maps the -104 "Unknown storage item" error that neo-go and C# nodes answer for an absent
// key to null (isUnknownStorageItemError); older nodes answered null themselves.
export function decodePendingUpgrade({ timeBase64, hashBase64 }) {
  const hasTime = typeof timeBase64 === 'string' && timeBase64.length > 0;
  const hasHash = typeof hashBase64 === 'string' && hashBase64.length > 0;
  if (!hasTime && !hasHash) return { scheduled: false, executeAfterMs: null, hashHex: null };
  if (hasTime !== hasHash) {
    throw new Error('pending upgrade storage is half written (time and hash must both exist)');
  }
  const hash = Buffer.from(hashBase64, 'base64');
  if (hash.length !== 32) throw new Error(`pending upgrade hash is ${hash.length} bytes, not 32`);
  return {
    scheduled: true,
    executeAfterMs: decodeStorageInteger(timeBase64),
    hashHex: hash.toString('hex'),
  };
}

export function storageKeyBase64(prefixByte) {
  return Buffer.from([prefixByte]).toString('base64');
}

function toBigInt(value, label) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?[0-9]+$/.test(value.trim())) return BigInt(value.trim());
  throw new Error(`${label} must be an integer`);
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortValue(value[key])])
    );
  }
  return value;
}

// Manifest equality independent of key order and whitespace (the node re-serialises it).
export function manifestsEquivalent(left, right) {
  const parse = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
  return JSON.stringify(sortValue(parse(left))) === JSON.stringify(sortValue(parse(right)));
}

// Decides the one step to take now. Inputs are already-read facts; nothing here touches
// the network. `sameAsDeployed` means the local NEF checksum and manifest equal the
// deployed ones.
export function planKernelUpgrade({
  gate,
  sameAsDeployed,
  localArtifactHash,
  pending = { scheduled: false, executeAfterMs: null, hashHex: null },
  chainTimeMs,
  cancel = false,
  reschedule = false,
  allowSameArtifact = false,
}) {
  if (!gate || typeof gate.timelocked !== 'boolean') throw new Error('gate is required');
  const artifactHash = String(localArtifactHash || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(artifactHash)) {
    throw new Error('localArtifactHash must be a sha256 hex digest');
  }

  if (cancel) {
    if (!gate.timelocked) {
      return {
        action: UPGRADE_ACTIONS.BLOCKED,
        reason: 'the deployed kernel has no update timelock, so there is nothing to cancel',
      };
    }
    if (!pending.scheduled) {
      return { action: UPGRADE_ACTIONS.BLOCKED, reason: 'no upgrade is scheduled' };
    }
    return {
      action: UPGRADE_ACTIONS.CANCEL,
      reason: `cancel the scheduled upgrade ${pending.hashHex}`,
    };
  }

  if (!gate.timelocked) {
    if (sameAsDeployed && !allowSameArtifact) {
      return { action: UPGRADE_ACTIONS.NOOP, reason: 'the local artifact is already deployed' };
    }
    return {
      action: UPGRADE_ACTIONS.UPDATE,
      reason: 'the deployed kernel applies update(nef, manifest) immediately',
    };
  }

  if (!pending.scheduled) {
    if (sameAsDeployed && !allowSameArtifact) {
      return { action: UPGRADE_ACTIONS.NOOP, reason: 'the local artifact is already deployed' };
    }
    return {
      action: UPGRADE_ACTIONS.SCHEDULE,
      reason: 'schedule the local artifact; update is accepted only after the timelock',
    };
  }

  if (pending.hashHex !== artifactHash) {
    if (reschedule) {
      return {
        action: UPGRADE_ACTIONS.SCHEDULE,
        reason: `replace the scheduled upgrade ${pending.hashHex}; the timelock restarts`,
      };
    }
    return {
      action: UPGRADE_ACTIONS.BLOCKED,
      reason:
        `a different artifact is scheduled (${pending.hashHex}); ` +
        'cancel it (--cancel) or replace it (--reschedule), which restarts the timelock',
    };
  }

  const executeAfterMs = toBigInt(pending.executeAfterMs, 'pending executeAfterMs');
  const now = toBigInt(chainTimeMs, 'chainTimeMs');
  if (now < executeAfterMs) {
    return {
      action: UPGRADE_ACTIONS.WAIT,
      reason: 'the scheduled upgrade matches the local artifact but its timelock is running',
      executeAfterMs,
      remainingMs: executeAfterMs - now,
    };
  }
  return {
    action: UPGRADE_ACTIONS.EXECUTE,
    reason: 'the scheduled upgrade matches the local artifact and its timelock has elapsed',
    executeAfterMs,
  };
}

// The contract method each sendable action invokes, and whether it carries the artifact.
export function upgradeInvocation(action) {
  switch (action) {
    case UPGRADE_ACTIONS.UPDATE:
    case UPGRADE_ACTIONS.EXECUTE:
      return { method: 'update', withArtifact: true };
    case UPGRADE_ACTIONS.SCHEDULE:
      return { method: 'scheduleUpdate', withArtifact: true };
    case UPGRADE_ACTIONS.CANCEL:
      return { method: 'cancelUpdate', withArtifact: false };
    default:
      return null;
  }
}

// --- What real nodes answer -----------------------------------------------------------------------

// getstorage of a key that is not stored: neo-go (0.121, 0.123 on both public mainnet nodes) and
// C# Neo (3.10) answer the JSON-RPC error -104 "Unknown storage item" instead of null.
export const RPC_ERROR_UNKNOWN_STORAGE_ITEM = -104;

export function isUnknownStorageItemError(rpcError) {
  if (!rpcError || typeof rpcError !== 'object') return false;
  if (rpcError.code === RPC_ERROR_UNKNOWN_STORAGE_ITEM) return true;
  return typeof rpcError.message === 'string' && /unknown storage item/i.test(rpcError.message);
}

// A getter's stack item as a printable value. Integers stay exact decimal strings, booleans are
// booleans (reading one as an integer printed "null"), and any other type is returned as it came
// so a verification never hides what it could not decode.
export function decodeStackItem(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.type === 'Integer') return BigInt(item.value).toString();
  if (item.type === 'Boolean') return item.value === true || item.value === 'true';
  return { type: item.type, value: item.value };
}

// --- The system fee margin --------------------------------------------------------------------------

// A transaction's whole system fee is charged whether or not the script uses all of it, and a
// script that needs more than the fee FAULTs after burning it. The fee is the node's simulation of
// the call at the time of signing, so state that moves before inclusion can push the real cost
// over it; the margin is the headroom.
export const DEFAULT_SYSTEM_FEE_MARGIN_PERCENT = 10;

export function parseSystemFeeMarginPercent(raw) {
  if (raw === undefined || raw === null) return DEFAULT_SYSTEM_FEE_MARGIN_PERCENT;
  const text = String(raw).trim();
  const value = /^\d+(\.\d{1,2})?$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isFinite(value) || value > 100) {
    throw new Error(
      `--system-fee-margin must be a percentage between 0 and 100 with at most two decimals ` +
        `(default ${DEFAULT_SYSTEM_FEE_MARGIN_PERCENT}), got '${raw}'`
    );
  }
  return value;
}

function toFeeBigInt(value) {
  const fee =
    typeof value === 'bigint'
      ? value
      : typeof value === 'number' && Number.isSafeInteger(value)
        ? BigInt(value)
        : typeof value === 'string' && /^[0-9]+$/.test(value.trim())
          ? BigInt(value.trim())
          : null;
  if (fee === null || fee < 0n) throw new Error('system fee must be a non-negative integer');
  return fee;
}

// simulated + simulated * percent / 100, with the margin rounded up so it is never below the
// percentage asked for. percent has at most two decimals (parseSystemFeeMarginPercent).
export function applySystemFeeMargin(simulatedFee, marginPercent) {
  const fee = toFeeBigInt(simulatedFee);
  const basisPoints = BigInt(Math.round(Number(marginPercent) * 100));
  return fee + (fee * basisPoints + 9_999n) / 10_000n;
}

// --- The rollback artifact, independent of the node that served it -----------------------------------

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

// The manifest as one text that does not depend on who serialised it: JSON with the keys sorted
// at every level (arrays keep their order, which is content) and no whitespace. A neo-go node and
// a C# node serve the same manifest in different key orders, so sha256(nef || served text)
// differs between them for the same contract.
export function canonicalManifestText(manifest) {
  if (typeof manifest === 'string' && manifest.trim() === '') {
    throw new Error('manifest is required');
  }
  const parsed = typeof manifest === 'string' ? JSON.parse(manifest) : manifest;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('manifest must be a JSON object');
  }
  return JSON.stringify(sortValue(parsed));
}

export function computeCanonicalArtifactHash(nefBytes, manifest) {
  return computeUpgradeArtifactHash(nefBytes, canonicalManifestText(manifest));
}

export const ARTIFACT_FORM =
  'sha256(nef bytes || canonical manifest text): the manifest JSON with keys sorted at every ' +
  'level and no whitespace, so the hash is the same whichever node served it; submitting the ' +
  'archived nef and manifest files makes scheduleUpdate pin exactly this hash';

// The identities of an archived on-chain artifact. artifact_sha256 is over the canonical manifest
// (the archived .manifest.json) and is the one to compare; served_artifact_sha256 is over the text
// the serving node emitted, depends on that node's key order, and is kept to match older figures.
export function describeRollbackArtifact({ nefBytes, servedManifestText }) {
  const canonical = canonicalManifestText(servedManifestText);
  return {
    artifact_form: ARTIFACT_FORM,
    artifact_sha256: computeUpgradeArtifactHash(nefBytes, canonical),
    served_artifact_sha256: computeUpgradeArtifactHash(nefBytes, servedManifestText),
    nef_sha256: sha256Hex(Buffer.from(nefBytes)),
    manifest_sha256: sha256Hex(canonical),
    served_manifest_sha256: sha256Hex(servedManifestText),
    canonical_manifest_text: canonical,
  };
}

// --- Which node to trust ------------------------------------------------------------------------------

// Two independent operators per network, both neo-go: COZ and NeoSPCC. Both mainnet nodes and the
// testnet pair answered getversion with the reviewed magic and agreed on getcontractstate when read
// on 2026-10-04. They are the default only for reads and a testnet run; a mainnet transaction never
// uses them without an explicit --rpc.
export const OFFICIAL_PUBLIC_RPC_URLS = Object.freeze({
  mainnet: Object.freeze(['https://mainnet1.neo.coz.io:443', 'https://rpc10.n3.nspcc.ru:10331']),
  testnet: Object.freeze(['https://testnet1.neo.coz.io:443', 'https://rpc.t5.n3.nspcc.ru:20331']),
});

function normalizeRpcUrls(values, label) {
  const urls = [];
  for (const value of values) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) continue;
    let parsed;
    try {
      parsed = new URL(text);
    } catch {
      throw new Error(`${label} '${text}' is not a valid URL`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`${label} '${text}' must be an http(s) URL`);
    }
    const url = text.replace(/\/+$/, '');
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

// The endpoints a run reads from and the first of which it also sends to. --rpc (repeatable) wins;
// otherwise NEO_RPC_URL from the real environment; otherwise the two official endpoints. A mainnet
// apply needs --rpc on the command line: a transaction goes only to a node the operator named.
export function resolveRpcEndpoints({ network, flagUrls = [], envUrl = '', applying = false }) {
  const flagged = normalizeRpcUrls(flagUrls, '--rpc');
  if (flagged.length > 0) return { urls: flagged, source: 'flag' };
  if (applying && network === 'mainnet') {
    throw new Error(
      'mainnet apply requires an explicit --rpc <url> on the command line (pass it twice to ' +
        'cross-check two nodes); neither NEO_RPC_URL nor the built-in endpoints are accepted ' +
        'for a mainnet transaction'
    );
  }
  const fromEnv = normalizeRpcUrls([envUrl], 'NEO_RPC_URL');
  if (fromEnv.length > 0) return { urls: fromEnv, source: 'env' };
  const defaults = OFFICIAL_PUBLIC_RPC_URLS[network];
  if (!defaults)
    throw new Error(`no official public RPC endpoints are known for ${network}; pass --rpc`);
  return { urls: [...defaults], source: 'default' };
}

// What an endpoint says about the deployed kernel, reduced to what must be the same everywhere.
// The manifest is compared canonically: nodes serialise it in different key orders.
export function observeContractState(rpc, state) {
  return {
    rpc,
    updatecounter: state.updatecounter,
    nefChecksum: state.nef?.checksum,
    manifestSha256: sha256Hex(canonicalManifestText(state.manifest)),
  };
}

// Every endpoint must report the same updatecounter, NEF checksum and manifest before anything is
// planned from them. Returns the agreed facts.
export function assertRpcAgreement(observations) {
  if (!Array.isArray(observations) || observations.length === 0) {
    throw new Error('assertRpcAgreement needs at least one observation');
  }
  const [first, ...rest] = observations;
  const fields = [
    ['updatecounter', 'updatecounter'],
    ['nef_checksum', 'nefChecksum'],
    ['manifest', 'manifestSha256'],
  ];
  const differing = new Set();
  for (const other of rest) {
    for (const [label, key] of fields) if (other[key] !== first[key]) differing.add(label);
  }
  if (differing.size > 0) {
    const table = observations
      .map(
        (entry) =>
          `  ${entry.rpc}: updatecounter=${entry.updatecounter} nef_checksum=${entry.nefChecksum} ` +
          `manifest_sha256=${entry.manifestSha256}`
      )
      .join('\n');
    throw new Error(
      `RPC endpoints disagree about the deployed MorpheusOracle (${[...differing].join(', ')}); ` +
        `nothing was planned:\n${table}`
    );
  }
  return {
    endpoints: observations.length,
    cross_checked: observations.length > 1,
    updatecounter: first.updatecounter,
    nef_checksum: first.nefChecksum,
    manifest_sha256: first.manifestSha256,
  };
}
