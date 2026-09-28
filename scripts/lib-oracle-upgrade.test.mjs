import assert from 'node:assert/strict';
import test from 'node:test';
import { sc } from '@cityofzion/neon-js';
import {
  PREFIX_UPGRADE_HASH,
  PREFIX_UPGRADE_TIME,
  TIMELOCK_DELAY_MS,
  UPGRADE_ACTIONS,
  assertNefChecksum,
  computeUpgradeArtifactHash,
  decodePendingUpgrade,
  decodeStorageInteger,
  describeUpgradeGate,
  manifestsEquivalent,
  nefChecksum,
  planKernelUpgrade,
  reconstructNefFile,
  storageKeyBase64,
  upgradeInvocation,
} from './lib-oracle-upgrade.mjs';

const IMMEDIATE_GATE_ABI = {
  abi: { methods: [{ name: 'update', parameters: [{}, {}] }] },
};
const TIMELOCKED_GATE_ABI = {
  abi: {
    methods: [
      { name: 'update', parameters: [{}, {}] },
      { name: 'scheduleUpdate', parameters: [{}, {}] },
      { name: 'cancelUpdate', parameters: [] },
    ],
  },
};
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function sampleNef() {
  return new sc.NEF({
    compiler: 'neo-os-tests',
    source: 'https://example.invalid/src',
    tokens: [
      {
        hash: 'd2a4cff31913016155e38e474a2c06d08be276cf',
        method: 'transfer',
        parametersCount: 4,
        hasReturnValue: true,
        callFlags: 15,
      },
    ],
    script: '0c0568656c6c6f40',
  });
}

// The getcontractstate `nef` shape: base64 script, 0x big-endian token hash, named flags.
// neon-js keeps a token hash as its serialized (little-endian) bytes, so reverse it.
function rpcShape(nef) {
  const json = nef.toJson();
  return {
    magic: json.magic,
    compiler: json.compiler,
    source: json.source,
    tokens: json.tokens.map((token) => ({
      hash: `0x${Buffer.from(token.hash, 'hex').reverse().toString('hex')}`,
      method: token.method,
      paramcount: token.parameterscount,
      hasreturnvalue: token.hasreturnvalue,
      callflags: 'All',
    })),
    script: Buffer.from(json.script, 'hex').toString('base64'),
    checksum: json.checksum,
  };
}

test('the artifact hash is sha256 over the NEF bytes followed by the manifest text', () => {
  // Fixed vector: sha256(0x010203 || '{"name":"x"}').
  assert.equal(
    computeUpgradeArtifactHash(Buffer.from([1, 2, 3]), '{"name":"x"}'),
    'c21ff1ac71554a86919e992c960835034fec0610b4e2bcb84f8e198f3fedba19'
  );
  // Byte-exact: a trailing newline is a different artifact.
  assert.notEqual(
    computeUpgradeArtifactHash(Buffer.from([1, 2, 3]), '{"name":"x"}\n'),
    computeUpgradeArtifactHash(Buffer.from([1, 2, 3]), '{"name":"x"}')
  );
  assert.throws(() => computeUpgradeArtifactHash(Buffer.alloc(0), '{}'), /NEF bytes/);
  assert.throws(() => computeUpgradeArtifactHash(Buffer.from([1]), ''), /manifest text/);
});

test('reconstructNefFile rebuilds the deployed NEF byte for byte from the RPC shape', () => {
  const nef = sampleNef();
  const rebuilt = reconstructNefFile(rpcShape(nef));
  assert.equal(rebuilt.toString('hex'), nef.serialize());
  assert.equal(nefChecksum(rebuilt), nef.checksum);
  assert.equal(assertNefChecksum(rebuilt), nef.checksum);
});

test('reconstructNefFile refuses a NEF whose reported checksum does not match', () => {
  const json = rpcShape(sampleNef());
  assert.throws(() => reconstructNefFile({ ...json, checksum: json.checksum + 1 }), /checksum/);
  assert.throws(
    () => reconstructNefFile({ ...json, tokens: [{ ...json.tokens[0], callflags: 'Everything' }] }),
    /unknown call flags/
  );
  assert.throws(() => reconstructNefFile(null), /nef JSON is required/);
});

test('assertNefChecksum rejects a tampered NEF', () => {
  const bytes = Buffer.from(sampleNef().serialize(), 'hex');
  bytes[bytes.length - 6] ^= 0xff; // flip a script byte, keep the stored checksum
  assert.throws(() => assertNefChecksum(bytes), /does not match/);
  assert.throws(() => nefChecksum(Buffer.from('not a nef')), /not a NEF3 file/);
});

test('describeUpgradeGate tells the immediate generation from the timelocked one', () => {
  assert.deepEqual(describeUpgradeGate(IMMEDIATE_GATE_ABI), { timelocked: false });
  assert.deepEqual(describeUpgradeGate(TIMELOCKED_GATE_ABI), { timelocked: true });
  assert.throws(() => describeUpgradeGate({ abi: { methods: [] } }), /does not expose update/);
  assert.throws(
    () =>
      describeUpgradeGate({
        abi: {
          methods: [
            { name: 'update', parameters: [{}, {}] },
            { name: 'scheduleUpdate', parameters: [{}, {}] },
          ],
        },
      }),
    /incomplete update timelock/
  );
  assert.throws(() => describeUpgradeGate({}), /no ABI/);
});

test('decodeStorageInteger reads little-endian two-complement storage integers', () => {
  assert.equal(decodeStorageInteger(''), 0n);
  assert.equal(decodeStorageInteger(null), 0n);
  assert.equal(decodeStorageInteger('AQ=='), 1n);
  assert.equal(decodeStorageInteger('/w=='), -1n);
  assert.equal(decodeStorageInteger('gAA='), 128n);
  assert.equal(decodeStorageInteger('APhVj5kB'), 1759046400000n);
});

test('decodePendingUpgrade reads the scheduled time and hash, or reports none', () => {
  assert.deepEqual(decodePendingUpgrade({ timeBase64: null, hashBase64: null }), {
    scheduled: false,
    executeAfterMs: null,
    hashHex: null,
  });
  const hashBase64 = Buffer.from(HASH_A, 'hex').toString('base64');
  assert.deepEqual(decodePendingUpgrade({ timeBase64: 'APhVj5kB', hashBase64 }), {
    scheduled: true,
    executeAfterMs: 1759046400000n,
    hashHex: HASH_A,
  });
  assert.throws(
    () => decodePendingUpgrade({ timeBase64: 'APhVj5kB', hashBase64: null }),
    /half written/
  );
  assert.throws(
    () => decodePendingUpgrade({ timeBase64: 'APhVj5kB', hashBase64: 'AQID' }),
    /not 32/
  );
});

test('storage keys and the delay mirror MorpheusOracle.cs', () => {
  assert.equal(storageKeyBase64(PREFIX_UPGRADE_TIME), 'MQ==');
  assert.equal(storageKeyBase64(PREFIX_UPGRADE_HASH), 'Mg==');
  assert.equal(TIMELOCK_DELAY_MS, 24 * 60 * 60 * 1000);
});

test('manifestsEquivalent ignores key order and whitespace but not content', () => {
  assert.equal(
    manifestsEquivalent('{"name":"MorpheusOracle","abi":{"methods":[]}}', {
      abi: { methods: [] },
      name: 'MorpheusOracle',
    }),
    true
  );
  assert.equal(
    manifestsEquivalent('{"name":"MorpheusOracle"}', '{\n  "name": "MorpheusOracle"\n}'),
    true
  );
  assert.equal(manifestsEquivalent('{"name":"MorpheusOracle"}', '{"name":"Other"}'), false);
});

const IMMEDIATE = { timelocked: false };
const TIMELOCKED = { timelocked: true };
const NO_PENDING = { scheduled: false, executeAfterMs: null, hashHex: null };

function pendingOf(hashHex, executeAfterMs) {
  return { scheduled: true, executeAfterMs, hashHex };
}

test('planKernelUpgrade applies the deployed generation immediately', () => {
  assert.equal(
    planKernelUpgrade({
      gate: IMMEDIATE,
      sameAsDeployed: false,
      localArtifactHash: HASH_A,
      chainTimeMs: 0,
    }).action,
    UPGRADE_ACTIONS.UPDATE
  );
  assert.equal(
    planKernelUpgrade({
      gate: IMMEDIATE,
      sameAsDeployed: true,
      localArtifactHash: HASH_A,
      chainTimeMs: 0,
    }).action,
    UPGRADE_ACTIONS.NOOP
  );
});

test('planKernelUpgrade schedules, waits, then executes on the timelocked generation', () => {
  const now = 1_000_000_000_000n;
  assert.equal(
    planKernelUpgrade({
      gate: TIMELOCKED,
      sameAsDeployed: false,
      localArtifactHash: HASH_A,
      pending: NO_PENDING,
      chainTimeMs: now,
    }).action,
    UPGRADE_ACTIONS.SCHEDULE
  );

  const eta = now + BigInt(TIMELOCK_DELAY_MS);
  const waiting = planKernelUpgrade({
    gate: TIMELOCKED,
    sameAsDeployed: false,
    localArtifactHash: HASH_A,
    pending: pendingOf(HASH_A, eta),
    chainTimeMs: now + 1_000n,
  });
  assert.equal(waiting.action, UPGRADE_ACTIONS.WAIT);
  assert.equal(waiting.remainingMs, BigInt(TIMELOCK_DELAY_MS) - 1_000n);

  const ready = planKernelUpgrade({
    gate: TIMELOCKED,
    sameAsDeployed: false,
    localArtifactHash: HASH_A.toUpperCase(),
    pending: pendingOf(HASH_A, eta),
    chainTimeMs: eta,
  });
  assert.equal(ready.action, UPGRADE_ACTIONS.EXECUTE);
  assert.equal(ready.executeAfterMs, eta);
});

test('planKernelUpgrade never silently replaces a different scheduled artifact', () => {
  const blocked = planKernelUpgrade({
    gate: TIMELOCKED,
    sameAsDeployed: false,
    localArtifactHash: HASH_A,
    pending: pendingOf(HASH_B, 5n),
    chainTimeMs: 10n,
  });
  assert.equal(blocked.action, UPGRADE_ACTIONS.BLOCKED);
  assert.match(blocked.reason, /different artifact is scheduled/);

  assert.equal(
    planKernelUpgrade({
      gate: TIMELOCKED,
      sameAsDeployed: false,
      localArtifactHash: HASH_A,
      pending: pendingOf(HASH_B, 5n),
      chainTimeMs: 10n,
      reschedule: true,
    }).action,
    UPGRADE_ACTIONS.SCHEDULE
  );
});

test('planKernelUpgrade cancels only a scheduled upgrade on the timelocked generation', () => {
  assert.equal(
    planKernelUpgrade({
      gate: TIMELOCKED,
      sameAsDeployed: true,
      localArtifactHash: HASH_A,
      pending: pendingOf(HASH_B, 5n),
      chainTimeMs: 10n,
      cancel: true,
    }).action,
    UPGRADE_ACTIONS.CANCEL
  );
  assert.equal(
    planKernelUpgrade({
      gate: TIMELOCKED,
      sameAsDeployed: true,
      localArtifactHash: HASH_A,
      pending: NO_PENDING,
      chainTimeMs: 10n,
      cancel: true,
    }).action,
    UPGRADE_ACTIONS.BLOCKED
  );
  assert.equal(
    planKernelUpgrade({
      gate: IMMEDIATE,
      sameAsDeployed: true,
      localArtifactHash: HASH_A,
      chainTimeMs: 10n,
      cancel: true,
    }).action,
    UPGRADE_ACTIONS.BLOCKED
  );
});

test('planKernelUpgrade treats a re-deploy of the live artifact as a no-op unless asked', () => {
  const base = {
    gate: TIMELOCKED,
    sameAsDeployed: true,
    localArtifactHash: HASH_A,
    pending: NO_PENDING,
    chainTimeMs: 10n,
  };
  assert.equal(planKernelUpgrade(base).action, UPGRADE_ACTIONS.NOOP);
  // The testnet timelock rehearsal schedules the artifact that is already live.
  assert.equal(
    planKernelUpgrade({ ...base, allowSameArtifact: true }).action,
    UPGRADE_ACTIONS.SCHEDULE
  );
});

test('planKernelUpgrade validates its inputs', () => {
  assert.throws(
    () => planKernelUpgrade({ gate: null, localArtifactHash: HASH_A }),
    /gate is required/
  );
  assert.throws(
    () => planKernelUpgrade({ gate: IMMEDIATE, localArtifactHash: 'abc' }),
    /sha256 hex digest/
  );
  assert.throws(
    () =>
      planKernelUpgrade({
        gate: TIMELOCKED,
        sameAsDeployed: false,
        localArtifactHash: HASH_A,
        pending: pendingOf(HASH_A, 5n),
        chainTimeMs: 'soon',
      }),
    /chainTimeMs must be an integer/
  );
});

test('upgradeInvocation maps each sendable action to its kernel method', () => {
  assert.deepEqual(upgradeInvocation(UPGRADE_ACTIONS.UPDATE), {
    method: 'update',
    withArtifact: true,
  });
  assert.deepEqual(upgradeInvocation(UPGRADE_ACTIONS.EXECUTE), {
    method: 'update',
    withArtifact: true,
  });
  assert.deepEqual(upgradeInvocation(UPGRADE_ACTIONS.SCHEDULE), {
    method: 'scheduleUpdate',
    withArtifact: true,
  });
  assert.deepEqual(upgradeInvocation(UPGRADE_ACTIONS.CANCEL), {
    method: 'cancelUpdate',
    withArtifact: false,
  });
  for (const action of [UPGRADE_ACTIONS.NOOP, UPGRADE_ACTIONS.WAIT, UPGRADE_ACTIONS.BLOCKED]) {
    assert.equal(upgradeInvocation(action), null);
  }
});
