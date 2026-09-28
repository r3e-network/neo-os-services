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

// The pending upgrade read from storage (getstorage returns null for an absent key).
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
