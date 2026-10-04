import assert from 'node:assert/strict';
import test from 'node:test';
import { sc } from '@cityofzion/neon-js';
import {
  DEFAULT_SYSTEM_FEE_MARGIN_PERCENT,
  OFFICIAL_PUBLIC_RPC_URLS,
  PREFIX_UPGRADE_HASH,
  PREFIX_UPGRADE_TIME,
  TIMELOCK_DELAY_MS,
  UPGRADE_ACTIONS,
  applySystemFeeMargin,
  assertNefChecksum,
  assertRpcAgreement,
  canonicalManifestText,
  computeCanonicalArtifactHash,
  computeUpgradeArtifactHash,
  decodePendingUpgrade,
  decodeStackItem,
  decodeStorageInteger,
  describeRollbackArtifact,
  describeUpgradeGate,
  isUnknownStorageItemError,
  manifestHasMethod,
  manifestsEquivalent,
  nefChecksum,
  observeContractState,
  parseSystemFeeMarginPercent,
  planKernelUpgrade,
  reconstructNefFile,
  resolveRpcEndpoints,
  splitGettersByAbi,
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

// --- Live-node compatibility -------------------------------------------------------------------

test('isUnknownStorageItemError recognises the absent-key answer of neo-go and C# nodes only', () => {
  // both public mainnet nodes (neo-go 0.123) and C# Neo 3.10.1 answer exactly this for an absent key
  assert.equal(isUnknownStorageItemError({ code: -104, message: 'Unknown storage item' }), true);
  assert.equal(isUnknownStorageItemError({ code: -104 }), true);
  assert.equal(isUnknownStorageItemError({ message: 'Unknown storage item' }), true);
  assert.equal(isUnknownStorageItemError({ code: -102, message: 'Unknown contract' }), false);
  assert.equal(isUnknownStorageItemError({ code: -32601, message: 'Method not found' }), false);
  assert.equal(isUnknownStorageItemError({}), false);
  assert.equal(isUnknownStorageItemError(null), false);
  assert.equal(isUnknownStorageItemError('Unknown storage item'), false);
});

test('decodeStackItem decodes integers and booleans, and never hides an unknown type as null', () => {
  assert.equal(decodeStackItem({ type: 'Integer', value: '7000000' }), '7000000');
  assert.equal(decodeStackItem({ type: 'Integer', value: '-1' }), '-1');
  assert.equal(decodeStackItem({ type: 'Boolean', value: true }), true);
  assert.equal(decodeStackItem({ type: 'Boolean', value: false }), false);
  assert.equal(decodeStackItem({ type: 'Boolean', value: 'true' }), true);
  assert.equal(decodeStackItem({ type: 'Boolean', value: 'false' }), false);
  assert.deepEqual(decodeStackItem({ type: 'ByteString', value: 'AQID' }), {
    type: 'ByteString',
    value: 'AQID',
  });
  assert.equal(decodeStackItem(undefined), null);
});

test('splitGettersByAbi keeps only the zero-argument members the target ABI has', () => {
  const manifest = {
    abi: {
      methods: [
        { name: 'accruedRequestFees', parameters: [] },
        { name: 'getMiniApp', parameters: [{}] },
        { name: 'isIndexRebuildRequired', parameters: [] },
      ],
    },
  };
  assert.equal(manifestHasMethod(manifest, 'accruedRequestFees'), true);
  assert.equal(manifestHasMethod(manifest, 'getMiniApp'), false);
  assert.equal(manifestHasMethod(manifest, 'getMiniApp', 1), true);
  assert.equal(manifestHasMethod({}, 'accruedRequestFees'), false);
  assert.deepEqual(
    splitGettersByAbi(manifest, [
      'accruedRequestFees',
      'getMiniApp',
      'indexRebuildCursor',
      'isIndexRebuildRequired',
    ]),
    {
      present: ['accruedRequestFees', 'isIndexRebuildRequired'],
      absent: ['getMiniApp', 'indexRebuildCursor'],
    }
  );
});

test('the default system fee margin is small, and parseSystemFeeMarginPercent refuses nonsense', () => {
  assert.equal(DEFAULT_SYSTEM_FEE_MARGIN_PERCENT, 10);
  assert.equal(parseSystemFeeMarginPercent(undefined), 10);
  assert.equal(parseSystemFeeMarginPercent('0'), 0);
  assert.equal(parseSystemFeeMarginPercent('25'), 25);
  assert.equal(parseSystemFeeMarginPercent('12.5'), 12.5);
  assert.equal(parseSystemFeeMarginPercent('100'), 100);
  for (const bad of ['', ' ', 'abc', '-1', '101', '10%', '1.234', 'NaN', 'Infinity', '1e1']) {
    assert.throws(
      () => parseSystemFeeMarginPercent(bad),
      /--system-fee-margin must be a percentage/,
      `'${bad}'`
    );
  }
});

test('applySystemFeeMargin adds the margin to the simulated fee and rounds up', () => {
  assert.equal(applySystemFeeMargin(10_000_000n, 10), 11_000_000n);
  assert.equal(applySystemFeeMargin('35706712', 10), 39_277_384n); // 3570671.2 rounds up
  assert.equal(applySystemFeeMargin(10_000_000, 12.5), 11_250_000n);
  assert.equal(applySystemFeeMargin(10_000_000n, 0), 10_000_000n);
  assert.equal(applySystemFeeMargin(1n, 10), 2n); // never rounds the margin down to nothing
  assert.equal(applySystemFeeMargin(0n, 10), 0n);
  assert.throws(() => applySystemFeeMargin(-1n, 10), /system fee/);
  assert.throws(() => applySystemFeeMargin('1.5', 10), /system fee/);
});

const MANIFEST_NEO_GO_ORDER =
  '{"name":"MorpheusOracle","abi":{"methods":[{"name":"admin","offset":893,"parameters":[],"returntype":"Hash160","safe":true}],"events":[]},"features":{},"groups":[],"permissions":[],"supportedstandards":[],"trusts":[],"extra":null}';
const MANIFEST_CSHARP_ORDER =
  '{"name":"MorpheusOracle","groups":[],"features":{},"supportedstandards":[],"abi":{"methods":[{"name":"admin","parameters":[],"returntype":"Hash160","offset":893,"safe":true}],"events":[]},"permissions":[],"trusts":[],"extra":null}';

test('canonicalManifestText sorts keys at every level, compactly, and keeps array order', () => {
  const canonical = canonicalManifestText(MANIFEST_NEO_GO_ORDER);
  assert.equal(canonical, canonicalManifestText(MANIFEST_CSHARP_ORDER));
  assert.equal(
    canonical,
    '{"abi":{"events":[],"methods":[{"name":"admin","offset":893,"parameters":[],"returntype":"Hash160","safe":true}]},"extra":null,"features":{},"groups":[],"name":"MorpheusOracle","permissions":[],"supportedstandards":[],"trusts":[]}'
  );
  // an object and its text give the same canonical form; array order is content
  assert.equal(canonicalManifestText(JSON.parse(MANIFEST_CSHARP_ORDER)), canonical);
  assert.notEqual(canonicalManifestText('{"a":[1,2]}'), canonicalManifestText('{"a":[2,1]}'));
  assert.throws(() => canonicalManifestText(''), /manifest/);
});

test('the canonical artifact hash does not depend on the key order a node serves', () => {
  const nef = Buffer.from([1, 2, 3]);
  assert.equal(
    computeCanonicalArtifactHash(nef, MANIFEST_NEO_GO_ORDER),
    computeCanonicalArtifactHash(nef, MANIFEST_CSHARP_ORDER)
  );
  // while the byte-exact hash that scheduleUpdate pins does
  assert.notEqual(
    computeUpgradeArtifactHash(nef, MANIFEST_NEO_GO_ORDER),
    computeUpgradeArtifactHash(nef, MANIFEST_CSHARP_ORDER)
  );
  assert.equal(
    computeCanonicalArtifactHash(nef, MANIFEST_NEO_GO_ORDER),
    computeUpgradeArtifactHash(nef, canonicalManifestText(MANIFEST_NEO_GO_ORDER))
  );
});

test('describeRollbackArtifact reports the canonical hash first and the node-order hash beside it', () => {
  const nef = Buffer.from([1, 2, 3]);
  const goOrder = describeRollbackArtifact({
    nefBytes: nef,
    servedManifestText: MANIFEST_NEO_GO_ORDER,
  });
  const csOrder = describeRollbackArtifact({
    nefBytes: nef,
    servedManifestText: MANIFEST_CSHARP_ORDER,
  });
  assert.equal(goOrder.artifact_sha256, csOrder.artifact_sha256);
  assert.equal(goOrder.manifest_sha256, csOrder.manifest_sha256);
  assert.notEqual(goOrder.served_artifact_sha256, csOrder.served_artifact_sha256);
  assert.notEqual(goOrder.served_manifest_sha256, csOrder.served_manifest_sha256);
  assert.equal(goOrder.canonical_manifest_text, canonicalManifestText(MANIFEST_NEO_GO_ORDER));
  assert.equal(
    goOrder.served_artifact_sha256,
    computeUpgradeArtifactHash(nef, MANIFEST_NEO_GO_ORDER)
  );
  assert.match(goOrder.nef_sha256, /^[0-9a-f]{64}$/);
  assert.match(goOrder.artifact_form, /canonical manifest/);
});

test('the default RPC endpoints are two distinct official https endpoints, never the third-party indexer', () => {
  for (const network of ['mainnet', 'testnet']) {
    const urls = OFFICIAL_PUBLIC_RPC_URLS[network];
    assert.ok(urls.length >= 2, `${network} needs two endpoints that can cross-check each other`);
    const hosts = urls.map((url) => new URL(url).hostname);
    assert.equal(new Set(hosts).size, hosts.length, `${network} endpoints are distinct hosts`);
    const operators = hosts.map((host) => host.split('.').slice(-2).join('.'));
    assert.equal(
      new Set(operators).size,
      operators.length,
      `${network} endpoints are independent operators`
    );
    for (const url of urls) {
      assert.equal(new URL(url).protocol, 'https:');
      assert.doesNotMatch(url, /n3index/);
    }
  }
  assert.ok(Object.isFrozen(OFFICIAL_PUBLIC_RPC_URLS));
});

test('resolveRpcEndpoints: flags win, the environment is one endpoint, the default is two', () => {
  const flagged = resolveRpcEndpoints({
    network: 'mainnet',
    flagUrls: ['https://a.example', 'https://b.example/', 'https://a.example'],
    envUrl: 'https://env.example',
    applying: true,
  });
  assert.deepEqual(flagged, { urls: ['https://a.example', 'https://b.example'], source: 'flag' });

  assert.deepEqual(
    resolveRpcEndpoints({ network: 'testnet', flagUrls: [], envUrl: 'https://env.example' }),
    { urls: ['https://env.example'], source: 'env' }
  );
  for (const network of ['mainnet', 'testnet']) {
    const defaults = resolveRpcEndpoints({ network, flagUrls: [], envUrl: '' });
    assert.equal(defaults.source, 'default');
    assert.deepEqual(defaults.urls, [...OFFICIAL_PUBLIC_RPC_URLS[network]]);
  }
});

test('resolveRpcEndpoints requires --rpc for a mainnet apply and rejects malformed urls', () => {
  assert.throws(
    () => resolveRpcEndpoints({ network: 'mainnet', flagUrls: [], envUrl: '', applying: true }),
    /mainnet apply requires an explicit --rpc/
  );
  assert.throws(
    () =>
      resolveRpcEndpoints({
        network: 'mainnet',
        flagUrls: [],
        envUrl: 'https://env.example',
        applying: true,
      }),
    /mainnet apply requires an explicit --rpc/
  );
  // a testnet apply may use the defaults or the environment
  assert.equal(
    resolveRpcEndpoints({ network: 'testnet', flagUrls: [], envUrl: '', applying: true }).source,
    'default'
  );
  for (const bad of ['not a url', 'ftp://node.example', 'node.example:10331']) {
    assert.throws(
      () => resolveRpcEndpoints({ network: 'testnet', flagUrls: [bad], envUrl: '' }),
      /--rpc/,
      bad
    );
  }
});

function observed(rpc, overrides = {}) {
  const manifest = { name: 'MorpheusOracle', abi: { methods: [], events: [] } };
  return observeContractState(rpc, {
    updatecounter: 1,
    nef: { checksum: 454480263 },
    manifest,
    ...overrides,
  });
}

test('assertRpcAgreement accepts identical observations and names every difference', () => {
  assert.deepEqual(assertRpcAgreement([observed('https://one.example')]), {
    endpoints: 1,
    cross_checked: false,
    updatecounter: 1,
    nef_checksum: 454480263,
    manifest_sha256: observed('x').manifestSha256,
  });
  const agreed = assertRpcAgreement([
    observed('https://one.example'),
    observed('https://two.example'),
  ]);
  assert.equal(agreed.endpoints, 2);
  assert.equal(agreed.cross_checked, true);

  // the manifest may be serialised in another key order by another node: that is agreement
  const reordered = observed('https://two.example', {
    manifest: { abi: { events: [], methods: [] }, name: 'MorpheusOracle' },
  });
  assert.equal(
    assertRpcAgreement([observed('https://one.example'), reordered]).cross_checked,
    true
  );

  for (const [label, overrides] of [
    ['updatecounter', { updatecounter: 2 }],
    ['nef_checksum', { nef: { checksum: 647482271 } }],
    [
      'manifest',
      { manifest: { name: 'MorpheusOracle', abi: { methods: [{ name: 'x' }], events: [] } } },
    ],
  ]) {
    assert.throws(
      () =>
        assertRpcAgreement([
          observed('https://one.example'),
          observed('https://two.example', overrides),
        ]),
      (error) =>
        /disagree about the deployed MorpheusOracle/.test(error.message) &&
        error.message.includes('https://one.example') &&
        error.message.includes('https://two.example') &&
        error.message.includes(label),
      label
    );
  }
  assert.throws(() => assertRpcAgreement([]), /at least one/);
});
