// Pure helpers for the CU-88 end-to-end harness (scripts/test-e2e-private-chain.mjs).
//
// Nothing in this module performs I/O. It holds the decisions that decide whether
// the harness can report a false pass: which process environment is safe to
// assemble, which contract hash both ends must agree on, how the on-chain request
// is read back, and the single acceptance evaluator. The driver is only
// orchestration around these.
//
// The harness is a test seam. Like the measured-contract override it drives
// (CU-87), it is refused outside the private testnet profile and must never be
// reachable from a production build or a production network.

export const PRIVATE_CHAIN_MAGIC = 894710606;
export const MEASURED_CONTRACT_OVERRIDE_ENV = 'MORPHEUS_TEST_MEASURED_ORACLE_CONTRACT_OVERRIDE';

/** Custody roles the harness provisions. updater and oracle_verifier must differ. */
export const CUSTODY_ROLES = ['worker', 'relayer', 'updater', 'oracle_verifier'];

export class HarnessError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HarnessError';
  }
}

/**
 * Every acceptance check the harness must see before it may report green.
 * A run that is missing any of these is a failure, never a partial pass.
 */
export const ACCEPTANCE_CHECKS = [
  'check/on-chain-request-succeeded',
  'check/on-chain-result-matches-computed',
  'check/on-chain-completion-timestamp-stored',
  'check/corrupt-signature-rejected',
  'check/replay-rejected',
  'check/contract-binding-agrees',
  'check/verifier-identity-is-custody-key',
  'check/verifier-key-pinned-by-relayer',
];

export function stripHexPrefix(value) {
  const text = String(value ?? '').trim();
  return (/^0x/i.test(text) ? text.slice(2) : text).toLowerCase();
}

/**
 * A 20-byte script hash as `0x` + 40 lowercase hex digits. Anything else is a
 * refusal: the override and the relayer's contract setting must name the same
 * deployed kernel, and a silently coerced value would make that equality vacuous.
 */
export function normalizeScriptHash(value) {
  const bare = stripHexPrefix(value).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(bare)) {
    throw new HarnessError(
      `expected a 20-byte hex script hash, received ${JSON.stringify(String(value ?? ''))}`
    );
  }
  return `0x${bare}`;
}

function assertString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HarnessError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function assertLoopbackUrl(value, name) {
  const url = assertString(value, name);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new HarnessError(`${name} is not a URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HarnessError(`${name} must be an http(s) URL`);
  }
  if (!['127.0.0.1', '[::1]', '::1'].includes(parsed.hostname)) {
    throw new HarnessError(
      `${name} must be a literal loopback address, received host ${parsed.hostname}`
    );
  }
  return url.replace(/\/$/, '');
}

/**
 * The one profile check. A harness that can be driven outside the disposable
 * private testnet is a production code path wearing a test name.
 */
export function assertTestOnlyProfile({ nodeEnv, network, magic }) {
  const env = String(nodeEnv ?? '')
    .trim()
    .toLowerCase();
  if (env === 'production') {
    throw new HarnessError('the end-to-end harness refuses to run with NODE_ENV=production');
  }
  if (
    String(network ?? '')
      .trim()
      .toLowerCase() === 'mainnet'
  ) {
    throw new HarnessError('the end-to-end harness refuses to run against mainnet');
  }
  if (Number(magic) !== PRIVATE_CHAIN_MAGIC) {
    throw new HarnessError(
      `the private chain must use testnet magic ${PRIVATE_CHAIN_MAGIC}, received ${magic}`
    );
  }
}

function resolveRoleKeys(custody) {
  const roleKeys = custody?.roleKeys ?? {};
  for (const role of CUSTODY_ROLES) {
    assertString(roleKeys[role], `custody role key ${role}`);
  }
  if (roleKeys.updater === roleKeys.oracle_verifier) {
    throw new HarnessError('the updater and the oracle_verifier must be different custody keys');
  }
  return roleKeys;
}

function commonEnv(shape) {
  assertTestOnlyProfile(shape);
  const kernelHash = normalizeScriptHash(shape.kernelHash);
  const custodyUrl = assertLoopbackUrl(shape.custody?.url, 'custody.url');
  const hostUrl = assertLoopbackUrl(shape.host?.url, 'host.url');
  // Every service endpoint the harness will ever point a child at is checked
  // here, so a builder that does not itself use one still refuses a remote
  // address rather than leaving it for the child to discover.
  const rpcUrl = shape.relayer?.rpcUrl
    ? assertLoopbackUrl(shape.relayer.rpcUrl, 'relayer.rpcUrl')
    : undefined;
  return { kernelHash, custodyUrl, hostUrl, rpcUrl };
}

/** Environment for the real `signer_service` custody binary. */
export function buildCustodyEnv(shape) {
  const { custodyUrl } = commonEnv(shape);
  const dataDir = assertString(shape.custody?.dataDir, 'custody.dataDir');
  const url = new URL(custodyUrl);
  return {
    SIGNER_SERVICE_DATA_DIR: dataDir,
    SIGNER_SERVICE_HOST: url.hostname,
    SIGNER_SERVICE_PORT: url.port,
  };
}

/** Environment for the real `enclave_host`, bound to custody and to the fresh kernel. */
export function buildHostEnv(shape) {
  const { kernelHash, custodyUrl, hostUrl } = commonEnv(shape);
  const roleKeys = resolveRoleKeys(shape.custody);
  const url = new URL(hostUrl);
  return {
    NODE_ENV: String(shape.nodeEnv),
    HOST: url.hostname,
    ENCLAVE_PORT: url.port,
    MORPHEUS_NETWORK: String(shape.network),
    NITRO_API_TOKEN: assertString(shape.host?.token, 'host.token'),
    SIGNER_SERVICE_URL: custodyUrl,
    SIGNER_SERVICE_TOKEN: assertString(shape.custody?.token, 'custody.token'),
    SIGNER_ROLE_WORKER_KEY_ID: roleKeys.worker,
    SIGNER_ROLE_RELAYER_KEY_ID: roleKeys.relayer,
    SIGNER_ROLE_UPDATER_KEY_ID: roleKeys.updater,
    SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID: roleKeys.oracle_verifier,
    [MEASURED_CONTRACT_OVERRIDE_ENV]: kernelHash,
  };
}

/**
 * Environment for the real `neo-os-relayer` in the disposable local-chain seam.
 * No database setting of any kind is assembled: the harness must leave no
 * database behind, so the delivery journal stays the in-memory one.
 */
export function buildRelayerEnv(shape) {
  const { kernelHash, custodyUrl, hostUrl, rpcUrl: resolvedRpc } = commonEnv(shape);
  const roleKeys = resolveRoleKeys(shape.custody);
  const rpcUrl = resolvedRpc ?? assertLoopbackUrl(shape.relayer?.rpcUrl, 'relayer.rpcUrl');
  const stateFile = assertString(shape.relayer?.stateFile, 'relayer.stateFile');
  const hostToken = assertString(shape.host?.token, 'host.token');
  return {
    NODE_ENV: String(shape.nodeEnv),
    MORPHEUS_NETWORK: String(shape.network),
    MORPHEUS_LOCAL_CHAIN: 'true',
    MORPHEUS_LOCAL_CHAIN_RPC_URLS: rpcUrl,
    MORPHEUS_RELAYER_MODE: 'requests_only',
    MORPHEUS_RELAYER_NEO_N3_SCAN_MODE: 'block_cursor',
    MORPHEUS_RELAYER_ALLOW_RUNTIME_FALLBACKS: 'false',
    MORPHEUS_RELAYER_NEO_N3_START_BLOCK: '0',
    MORPHEUS_RELAYER_NEO_N3_CONFIRMATIONS: '0',
    MORPHEUS_RELAYER_ENCLAVE_FULFILL: 'true',
    // The automation lane is the one part of a tick that needs a durable claim
    // store the harness does not run; leaving it on would make the job red for a
    // reason that has nothing to do with request fulfillment.
    MORPHEUS_AUTOMATION_ENABLED: 'false',
    MORPHEUS_RELAYER_STATE_FILE: stateFile,
    MORPHEUS_RUNTIME_URL: hostUrl,
    MORPHEUS_RUNTIME_TOKEN: hostToken,
    CONTRACT_MORPHEUS_ORACLE_HASH_TESTNET: kernelHash,
    SIGNER_SERVICE_URL: custodyUrl,
    SIGNER_SERVICE_TOKEN: assertString(shape.custody?.token, 'custody.token'),
    SIGNER_ROLE_UPDATER_KEY_ID: roleKeys.updater,
    SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID: roleKeys.oracle_verifier,
    SIGNER_ROLE_WORKER_KEY_ID: roleKeys.worker,
    SIGNER_ROLE_RELAYER_KEY_ID: roleKeys.relayer,
  };
}

/**
 * Parse `neo-os-relayer config:dump`, which prints one resolved setting per line
 * as `key  = value    (alias via source)`. Values are already secret-redacted by
 * the relayer, so nothing here can leak a token.
 */
export function parseConfigDump(dumpText) {
  const text = String(dumpText ?? '');
  if (text.trim() === '') {
    throw new HarnessError('the relayer config dump is empty');
  }
  const settings = {};
  for (const line of text.split('\n')) {
    const match = /^\s*(\S+)\s+= (.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const rest = match[2];
    const cut = rest.lastIndexOf('    (');
    settings[key] = (cut >= 0 ? rest.slice(0, cut) : rest).trim();
  }
  return settings;
}

/**
 * Read the resolved contract and custody key identities out of `neo-os-relayer
 * config:dump`. This is how the harness turns "we set an environment variable"
 * into "the relayer's own configuration resolution agrees".
 */
export function relayerEnvFromDump(dump) {
  const settings = typeof dump === 'string' ? parseConfigDump(dump) : dump;
  if (!settings || typeof settings !== 'object') {
    throw new HarnessError('the relayer config dump must resolve to a settings map');
  }
  const oracleContract = settings['neo_n3.oracleContract'];
  if (typeof oracleContract !== 'string' || stripHexPrefix(oracleContract).length !== 40) {
    throw new HarnessError('the relayer resolved no Neo N3 oracle contract');
  }
  const updaterKeyId = settings['neo_n3.custodyKeyIds.updater'];
  const oracleVerifierKeyId = settings['neo_n3.custodyKeyIds.oracle_verifier'];
  if (typeof updaterKeyId !== 'string' || updaterKeyId.trim() === '') {
    throw new HarnessError('the relayer resolved no custody updater key');
  }
  if (typeof oracleVerifierKeyId !== 'string' || oracleVerifierKeyId.trim() === '') {
    throw new HarnessError('the relayer resolved no custody oracle_verifier key');
  }
  return {
    oracleContract: normalizeScriptHash(oracleContract),
    updaterKeyId: updaterKeyId.trim(),
    oracleVerifierKeyId: oracleVerifierKeyId.trim(),
  };
}

function stackEntry(stack, index) {
  if (!stack || typeof stack !== 'object') {
    throw new HarnessError('the getRequest stack must be an object of indexed entries');
  }
  return stack[index] ?? stack[String(index)];
}

function stackInteger(stack, index) {
  const entry = stackEntry(stack, index);
  const value = entry?.value;
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (!/^-?\d+$/.test(text)) {
    throw new HarnessError(`getRequest stack index ${index} is not an integer`);
  }
  return Number(text);
}

function stackBoolean(stack, index) {
  const entry = stackEntry(stack, index);
  const value = entry?.value;
  if (typeof value !== 'boolean') {
    throw new HarnessError(`getRequest stack index ${index} is not a boolean`);
  }
  return value;
}

function stackBytes(stack, index) {
  const entry = stackEntry(stack, index);
  const value = entry?.value;
  if (typeof value !== 'string') {
    throw new HarnessError(`getRequest stack index ${index} is not a byte array`);
  }
  return value === '' ? new Uint8Array(0) : new Uint8Array(Buffer.from(value, 'base64'));
}

// A Neo `ByteString` field comes back base64-encoded, a `String` field does not.
// Both shapes appear in one stack, so the decoder names the field it is reading
// rather than guessing from the payload.
function stackText(stack, index, field) {
  const entry = stackEntry(stack, index);
  const value = entry?.value;
  if (typeof value !== 'string') {
    throw new HarnessError(`getRequest ${field} is not a string or byte array`);
  }
  if (entry?.type === 'ByteArray') {
    return value === '' ? '' : Buffer.from(value, 'base64').toString('utf8');
  }
  return value;
}

/**
 * Decode the MorpheusOracle `getRequest` stack, which is the `KernelRequest`
 * struct field by field:
 *
 *   0 Id, 1 AppId, 2 ModuleId, 3 Operation, 4 Payload,
 *   5 Requester, 6 Sponsor, 7 CallbackContract,
 *   8 Status (0 Pending, 1 Succeeded, 2 Failed),
 *   9 CreatedAt, 10 FulfilledAt, 11 Success, 12 Result, 13 Error, 14 FeePaid
 *
 * Field order is read from `contracts/MorpheusOracle/MorpheusOracle.cs`
 * (`struct KernelRequest`) and must not be re-derived from a driver's habits.
 */
export function decodeRequestStack(stack) {
  const requestId = stackInteger(stack, 0);
  if (requestId <= 0) {
    throw new HarnessError(`getRequest returned an unusable request id ${requestId}`);
  }
  return {
    requestId,
    appId: stackText(stack, 1, 'appId'),
    moduleId: stackText(stack, 2, 'moduleId'),
    operation: stackText(stack, 3, 'operation'),
    payloadText: stackText(stack, 4, 'payload'),
    state: stackInteger(stack, 8),
    createdAt: stackInteger(stack, 9),
    completionTimestamp: stackInteger(stack, 10),
    success: stackBoolean(stack, 11),
    resultHex: Buffer.from(stackBytes(stack, 12)).toString('hex'),
    error: stackText(stack, 13, 'error'),
  };
}

function check(name, ok, failures, detail) {
  if (!ok) {
    failures.push(`${name}: ${detail}`);
  }
  return { name, ok };
}

/**
 * The single decision about whether this run may report green. Every dimension
 * of the observation is required; a missing field is a failure, not an unknown.
 */
export function evaluateAcceptance(observed) {
  const failures = [];
  const onChain = observed?.onChain ?? {};
  const expected = observed?.expected ?? {};
  const binding = observed?.contractBinding ?? {};
  const custody = observed?.custody ?? {};

  const checks = [
    check(
      'check/on-chain-request-succeeded',
      onChain.state === 1 && onChain.success === true,
      failures,
      `state=${onChain.state} success=${onChain.success} error=${JSON.stringify(onChain.error ?? '')}`
    ),
    check(
      'check/on-chain-result-matches-computed',
      typeof onChain.resultHex === 'string' &&
        onChain.resultHex.length > 0 &&
        onChain.resultHex === expected.resultHex,
      failures,
      `on-chain=${JSON.stringify(onChain.resultHex)} computed=${JSON.stringify(expected.resultHex)}`
    ),
    check(
      'check/on-chain-completion-timestamp-stored',
      Number.isFinite(onChain.completionTimestamp) && onChain.completionTimestamp > 0,
      failures,
      `completionTimestamp=${onChain.completionTimestamp}`
    ),
    check(
      'check/corrupt-signature-rejected',
      observed?.corruptSignatureRejected === true,
      failures,
      'the corrupt-signature control did not fault'
    ),
    check(
      'check/replay-rejected',
      observed?.replayRejected === true,
      failures,
      'the replayed fulfillment was not rejected'
    ),
    check(
      'check/contract-binding-agrees',
      typeof binding.kernelHash === 'string' &&
        binding.kernelHash.length > 0 &&
        binding.hostOverride === binding.kernelHash &&
        binding.relayerContract === binding.kernelHash,
      failures,
      `kernel=${binding.kernelHash} host=${binding.hostOverride} relayer=${binding.relayerContract}`
    ),
    check(
      'check/verifier-identity-is-custody-key',
      typeof custody.verifierPublicKey === 'string' &&
        custody.verifierPublicKey.length > 0 &&
        custody.hostReportedPublicKey === custody.verifierPublicKey,
      failures,
      `custody=${custody.verifierPublicKey} host=${custody.hostReportedPublicKey}`
    ),
    check(
      'check/verifier-key-pinned-by-relayer',
      typeof custody.configuredVerifierKey === 'string' &&
        custody.configuredVerifierKey.length > 0 &&
        custody.relayerPinnedVerifier === custody.configuredVerifierKey,
      failures,
      `configured=${custody.configuredVerifierKey} relayer=${custody.relayerPinnedVerifier}`
    ),
  ];

  return {
    ok: failures.length === 0 && checks.every((entry) => entry.ok),
    checks,
    failures,
  };
}

const FORBIDDEN_ROOTS = ['/', '/Users', process.env.HOME ?? '/nonexistent-home-placeholder'];

/**
 * The ordered teardown. Refuses a root that could ever be a home directory: the
 * harness deletes its temporary tree on exit, and that deletion must be
 * impossible to aim at anything but a disposable scratch directory.
 */
export function teardownPlan({ children, root }) {
  const list = Array.isArray(children) ? children : [];
  if (list.length === 0) {
    throw new HarnessError('teardown requires the list of spawned children');
  }
  const target = String(root ?? '').trim();
  if (!target) {
    throw new HarnessError('teardown requires a temporary root');
  }
  const normalized = target.replace(/\/+$/, '');
  if (FORBIDDEN_ROOTS.some((forbidden) => normalized === forbidden.replace(/\/+$/, ''))) {
    throw new HarnessError(`refusing to plan a deletion of ${normalized}`);
  }
  if (!normalized.startsWith('/tmp/') && !normalized.startsWith('/private/tmp/')) {
    throw new HarnessError(
      `teardown root must be a disposable scratch directory, received ${normalized}`
    );
  }
  return [
    ...list.map((target_) => ({ action: 'stop', target: target_ })),
    { action: 'remove', target: normalized },
  ];
}
