/**
 * Network targeting for the host feed writer / monitor / health audit.
 *
 * Default remains mainnet so the live box (i-0c52851f134db20ee) is unchanged
 * until an operator sets FEED_NETWORK=testnet. Testnet MorpheusDataFeed
 * 0x9bea75cf… does not implement updateFeeds. After magic-pinned network
 * selection, a proven public ABI may select testnet-only per-pair updateFeed.
 * Mainnet and unknown networks must not silently downgrade from batch.
 *
 * MORPHEUS_NETWORK is intentionally ignored. A relayer/enclave env must not
 * silently retarget a feed writer. N3_FEED / FEED_MAGIC may confirm the
 * selected FEED_NETWORK defaults; a mismatch fails closed. FEED_RPCS may
 * rotate URLs and is isolated by getversion magic.
 */

export const FEED_SLO_SECONDS = 6 * 3600;
export const FEED_GAS_WARN_DEFAULT = 8;
export const CLOCK_SKEW_TOLERANCE_SEC = 120;
export const FEED_WRITE_MODE_BATCH = 'batch_update_feeds';
export const FEED_WRITE_MODE_PER_PAIR = 'per_pair_update_feed';
export const MAX_PER_PAIR_FEED_UPDATES = 64;
export const PER_PAIR_ATTEMPTS = 2;
export const PER_PAIR_TIMEOUT_MS = 20_000;
export const FEED_CONFIRMATION_POLL_ATTEMPTS = 8;
export const FEED_CONFIRMATION_POLL_INTERVAL_MS = 1_500;
export const FEED_VALID_UNTIL_OFFSET = 500;
export const FEED_PAIR_PREFIX = 'TWELVEDATA:';
export const FEED_UPDATER_ROLE = 'updater';

export const UPDATE_FEED_PARAMETERS = Object.freeze([
  Object.freeze({ name: 'pair', type: 'String' }),
  Object.freeze({ name: 'roundId', type: 'Integer' }),
  Object.freeze({ name: 'price', type: 'Integer' }),
  Object.freeze({ name: 'timestamp', type: 'Integer' }),
  Object.freeze({ name: 'attestationHash', type: 'ByteArray' }),
  Object.freeze({ name: 'sourceSetId', type: 'Integer' }),
]);

export const UPDATE_FEEDS_PARAMETERS = Object.freeze([
  Object.freeze({ name: 'pairs', type: 'Array' }),
  Object.freeze({ name: 'roundIds', type: 'Array' }),
  Object.freeze({ name: 'prices', type: 'Array' }),
  Object.freeze({ name: 'timestamps', type: 'Array' }),
  Object.freeze({ name: 'attestationHashes', type: 'Array' }),
  Object.freeze({ name: 'sourceSetIds', type: 'Array' }),
]);

export const FEED_TRANSPORT_ERROR_CODES = Object.freeze([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ABORT_ERR',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'FEED_TRANSPORT_TIMEOUT',
  'FEED_TRANSPORT_RESET',
]);

export const ENCLAVE_NETWORK_BIND_KEYS = Object.freeze([
  'FEED_NETWORK',
  'FEED_MAGIC',
  'N3_FEED',
  'FEED_CONTRACT',
  'MORPHEUS_NETWORK',
  'N3_UPDATER_SH',
  'N3_UPDATER',
]);

export const DEFAULT_RETIRED_FEED_PAIRS = Object.freeze([
  'COPPER-USD',
  'FLM-USD',
  '1000FLM-USD',
  '1000JPY-USD',
]);

export const FEED_NETWORK_DEFAULTS = Object.freeze({
  mainnet: Object.freeze({
    network: 'mainnet',
    magic: 860833102,
    feed: '03013f49c42a14546c8bbe58f9d434c3517fccab',
    updaterPub: '02f63e3f618d8f6995eb85279a03361beb715d25d3b97407c73c351d26ba849744',
    updaterSh: '9fb28bdacfaa7fcc0a4d660d0dc990b0e7d46118',
    updaterAddress: 'NN8tbpgAx8zm5BNJZEqvi71Rj2Z8LX2RHh',
    rpcs: Object.freeze([
      'https://mainnet1.neo.coz.io:443',
      'https://api.n3index.dev/mainnet',
      'https://rpc10.n3.nspcc.ru:10331',
    ]),
  }),
  testnet: Object.freeze({
    network: 'testnet',
    magic: 894710606,
    feed: '9bea75cf702f6afc09125aa6d22f082bfd2ee064',
    updaterPub: '02911ea28aee939ef686f42e1137954135998b71e7e997794bde8c0a40f4b95cb4',
    updaterSh: 'e421999c396ee0249a8a8c9dd95bfbdaf55f8bf7',
    updaterAddress: 'NiUs458jFbTH1DA3b9QyeDhMaD282h3iJg',
    rpcs: Object.freeze([
      'https://api.n3index.dev/testnet',
      'https://testnet1.neo.coz.io:443',
      'http://seed1t5.neo.org:20332',
      'http://seed2t5.neo.org:20332',
    ]),
  }),
});

export const DOCUMENTED_FEED_PUSHER_INSTANCE = 'i-0c52851f134db20ee';

export const FEED_UNIT_RESERVED_KEYS = Object.freeze([
  'FEED_NETWORK',
  'FEED_CHAINS',
  'SIGNER_URL',
  'PUSH_LOG',
  'PUSH_STATUS',
  'MISSING_STATE',
  'PUSH_PROM_TEXTFILE',
  'MONITOR_NETWORK',
  'MONITOR_LOG',
  'MONITOR_STATUS',
  'MONITOR_PROM_TEXTFILE',
  'FEED_TOPUP_ENV_FILE',
  'TOPUP_LOG',
]);

const MAINNET_PUSHER_PINS = Object.freeze({
  FEED_NETWORK: 'mainnet',
  FEED_CHAINS: 'neo-n3',
  PUSH_LOG: '/opt/morpheus/nitro/feed-pusher.log',
  PUSH_STATUS: '/opt/morpheus/nitro/feed-pusher-status.json',
  MISSING_STATE: '/opt/morpheus/nitro/feed-pusher-missing.json',
  PUSH_PROM_TEXTFILE: '',
});

const MAINNET_NEOX_PUSHER_PINS = Object.freeze({
  FEED_NETWORK: 'mainnet',
  FEED_CHAINS: 'neox',
  PUSH_LOG: '/opt/morpheus/nitro/feed-pusher-neox.log',
  PUSH_STATUS: '/opt/morpheus/nitro/feed-pusher-neox-status.json',
  MISSING_STATE: '/opt/morpheus/nitro/feed-pusher-neox-missing.json',
  PUSH_PROM_TEXTFILE: '',
});

const MAINNET_MONITOR_PINS = Object.freeze({
  FEED_NETWORK: 'mainnet',
  MONITOR_NETWORK: 'neo-n3',
  MONITOR_LOG: '/opt/morpheus/nitro/feed-monitor.log',
  MONITOR_STATUS: '/opt/morpheus/nitro/feed-status.json',
  MONITOR_PROM_TEXTFILE: '',
});

export const FEED_UNIT_PINNED_ENV = Object.freeze({
  'morpheus-feed-pusher.service': MAINNET_PUSHER_PINS,
  'morpheus-feed-pusher-neox.service': MAINNET_NEOX_PUSHER_PINS,
  'morpheus-feed-monitor.service': MAINNET_MONITOR_PINS,
  'morpheus-feed-topup.service': Object.freeze({
    FEED_NETWORK: 'mainnet',
    FEED_TOPUP_ENV_FILE: '/opt/morpheus/nitro/feed-topup.env',
    TOPUP_LOG: '/opt/morpheus/nitro/feed-topup.log',
  }),
  'morpheus-feed-pusher-testnet.service': Object.freeze({
    FEED_NETWORK: 'testnet',
    FEED_CHAINS: 'neo-n3',
    SIGNER_URL: 'http://127.0.0.1:8791',
    PUSH_LOG: '/opt/morpheus/nitro/feed-pusher-testnet.log',
    PUSH_STATUS: '/opt/morpheus/nitro/feed-pusher-testnet-status.json',
    MISSING_STATE: '/opt/morpheus/nitro/feed-pusher-testnet-missing.json',
    PUSH_PROM_TEXTFILE: '/opt/morpheus/nitro/feed-pusher-testnet.prom',
  }),
  'morpheus-feed-monitor-testnet.service': Object.freeze({
    FEED_NETWORK: 'testnet',
    MONITOR_NETWORK: 'neo-n3-testnet',
    MONITOR_LOG: '/opt/morpheus/nitro/feed-monitor-testnet.log',
    MONITOR_STATUS: '/opt/morpheus/nitro/feed-status-testnet.json',
    MONITOR_PROM_TEXTFILE: '/opt/morpheus/nitro/feed-monitor-testnet.prom',
  }),
});

/**
 * Model systemd.exec Environment / EnvironmentFile / exec-time env precedence.
 *
 * systemd loads EnvironmentFile= after Environment= and documented behavior is
 * that file assignments override Environment= regardless of unit-file order.
 * Assignments in `execEnv` (`ExecStart=/usr/bin/env KEY=val …`) are applied at
 * execve and cannot be overridden by either.
 */
export function applySystemdServiceEnv({
  environment = {},
  environmentFile = {},
  execEnv = {},
} = {}) {
  return { ...environment, ...environmentFile, ...execEnv };
}

export function parseExecStartEnvPins(execStart) {
  const text = String(execStart || '').trim();
  if (!text.startsWith('/usr/bin/env ')) return {};
  const pins = {};
  const parts = text.split(/\s+/);
  for (let index = 1; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === '/usr/bin/node' || part.endsWith('.mjs')) break;
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    pins[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return pins;
}

export function parseSystemdUnitText(unitText) {
  const environment = {};
  const environmentFiles = [];
  let execStart = '';
  for (const rawLine of String(unitText || '').split('\n')) {
    const line = rawLine.trim();
    const envMatch = line.match(/^Environment=([A-Z0-9_]+)=(.*)$/);
    if (envMatch) {
      environment[envMatch[1]] = envMatch[2];
      continue;
    }
    const fileMatch = line.match(/^EnvironmentFile=-?(.*)$/);
    if (fileMatch) {
      environmentFiles.push(fileMatch[1]);
      continue;
    }
    if (line.startsWith('ExecStart=')) {
      execStart = line.slice('ExecStart='.length);
    }
  }
  return {
    environment,
    environmentFiles,
    execStart,
    execEnv: parseExecStartEnvPins(execStart),
  };
}

export function parseEnvFileAssignments(content) {
  const values = {};
  for (const rawLine of String(content || '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

export function reservedKeysPresent(assignments = {}) {
  return FEED_UNIT_RESERVED_KEYS.filter((key) => Object.hasOwn(assignments, key));
}

export function resolveFeedTopupPaths(env = process.env) {
  const network = String(env.FEED_NETWORK || 'mainnet')
    .trim()
    .toLowerCase();
  const defaults =
    network === 'testnet'
      ? {
          log: '/opt/morpheus/nitro/feed-topup-testnet.log',
          envFile: '/opt/morpheus/nitro/feed-topup-testnet.env',
        }
      : {
          log: '/opt/morpheus/nitro/feed-topup.log',
          envFile: '/opt/morpheus/nitro/feed-topup.env',
        };
  return {
    log: String(env.TOPUP_LOG || defaults.log),
    envFile: String(env.FEED_TOPUP_ENV_FILE || defaults.envFile),
  };
}

export function normalizeHash160(value, fallback = '') {
  const raw = String(value || fallback || '')
    .trim()
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(raw)) return '';
  return raw;
}

export function parseRpcList(value, fallback = []) {
  const raw = value == null || value === '' ? fallback : value;
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  return list.map((entry) => String(entry || '').trim()).filter(Boolean);
}

export function rpcHostLabel(rpcUrl) {
  try {
    return new URL(rpcUrl).host || 'invalid-url';
  } catch {
    return 'invalid-url';
  }
}

function explicitEnvValue(env, key) {
  if (!env || !Object.hasOwn(env, key)) return '';
  const value = env[key];
  if (value == null) return '';
  return String(value).trim();
}

export function resolveFeedNetwork(env = process.env) {
  const requested = String(env.FEED_NETWORK || 'mainnet')
    .trim()
    .toLowerCase();
  if (requested !== 'mainnet' && requested !== 'testnet') {
    throw new Error(`FEED_NETWORK must be mainnet or testnet, got ${requested}`);
  }
  const defaults = FEED_NETWORK_DEFAULTS[requested];
  const explicitFeed = explicitEnvValue(env, 'N3_FEED') || explicitEnvValue(env, 'FEED_CONTRACT');
  const explicitMagic = explicitEnvValue(env, 'FEED_MAGIC');
  const feed = normalizeHash160(explicitFeed || defaults.feed, defaults.feed);
  const updaterSh = normalizeHash160(env.N3_UPDATER_SH || env.N3_UPDATER, defaults.updaterSh);
  const updaterPub = String(env.N3_UPDATER_PUB || defaults.updaterPub).trim();
  const magic = Number(explicitMagic || defaults.magic);
  const rpcs = parseRpcList(env.FEED_RPCS, defaults.rpcs);
  if (!feed) throw new Error(`N3_FEED is not a Hash160 for ${requested}`);
  if (!updaterSh) throw new Error(`N3_UPDATER_SH is not a Hash160 for ${requested}`);
  if (!Number.isFinite(magic) || magic <= 0) {
    throw new Error(`FEED_MAGIC is not a positive network magic for ${requested}`);
  }
  if (!rpcs.length) throw new Error(`FEED_RPCS is empty for ${requested}`);
  // N3_FEED / FEED_MAGIC may confirm the selected network. They must not silently
  // retarget hash or magic. FEED_RPCS stays configurable; isolation is getversion.
  if (explicitFeed && feed !== defaults.feed) {
    throw new Error(
      `N3_FEED does not match FEED_NETWORK=${requested} MorpheusDataFeed (refusing silent retarget)`
    );
  }
  if (explicitMagic && magic !== defaults.magic) {
    throw new Error(
      `FEED_MAGIC does not match FEED_NETWORK=${requested} magic (refusing silent retarget)`
    );
  }
  return {
    network: requested,
    magic,
    feed,
    updaterPub,
    updaterSh,
    updaterAddress: defaults.updaterAddress,
    rpcs,
  };
}

export function validateFeedPusherEnv(env = process.env, { requireTdKey = true } = {}) {
  const errors = [];
  let network;
  try {
    network = resolveFeedNetwork(env);
  } catch (error) {
    const summary = error instanceof Error ? error.message : String(error);
    let code = 'invalid_feed_network';
    if (/N3_FEED does not match/.test(summary)) code = 'feed_hash_mismatch';
    else if (/FEED_MAGIC does not match/.test(summary)) code = 'feed_magic_mismatch';
    errors.push({ code, summary });
    return { network: null, errors };
  }
  if (requireTdKey && !String(env.TD_KEY || '').trim()) {
    errors.push({
      code: 'missing_td_key',
      summary: 'TD_KEY is required to fetch TwelveData prices for an enabled chain',
    });
  }
  return { network, errors };
}

export function inspectWriterMethod(methods, name, expectedParams) {
  const expected = Array.isArray(expectedParams) ? expectedParams : [];
  const matches = (Array.isArray(methods) ? methods : []).filter(
    (method) => String(method?.name || '') === name
  );
  if (matches.length === 0) {
    return { name, present: false, ok: false, reason: 'missing' };
  }
  if (matches.length > 1) {
    return { name, present: true, ok: false, reason: 'ambiguous' };
  }
  const parameters = matches[0]?.parameters;
  if (!Array.isArray(parameters)) {
    return { name, present: true, ok: false, reason: 'unspecified_parameters' };
  }
  if (parameters.length !== expected.length) {
    return { name, present: true, ok: false, reason: 'wrong_arity' };
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (String(parameters[index]?.type || '') !== expected[index].type) {
      return { name, present: true, ok: false, reason: 'wrong_types' };
    }
  }
  return { name, present: true, ok: true, reason: null, parameters };
}

export function parseContractUpdateMethods(manifest) {
  const methods = Array.isArray(manifest?.abi?.methods) ? manifest.abi.methods : null;
  if (!methods) {
    return {
      probed: false,
      has_update_feeds: null,
      has_update_feed: null,
      update_feed: null,
      update_feeds: null,
      methods: [],
    };
  }
  const names = methods.map((method) => String(method?.name || ''));
  const updateFeed = inspectWriterMethod(methods, 'updateFeed', UPDATE_FEED_PARAMETERS);
  const updateFeeds = inspectWriterMethod(methods, 'updateFeeds', UPDATE_FEEDS_PARAMETERS);
  return {
    probed: true,
    has_update_feeds: updateFeeds.ok,
    has_update_feed: updateFeed.ok,
    update_feed: updateFeed,
    update_feeds: updateFeeds,
    methods: names,
  };
}

export function assertWriterAbiExact(abi, { network } = {}) {
  if (!abi || abi.probed !== true) {
    throw new Error(`[neo-n3] ${network || 'unknown'} ABI not proven: refusing to write`);
  }
  for (const inspected of [abi.update_feed, abi.update_feeds]) {
    if (inspected && inspected.present && !inspected.ok) {
      throw new Error(
        `[neo-n3] ${network || 'unknown'} ABI ${inspected.name} is ${inspected.reason}: refusing ambiguous or wrong-arity writer`
      );
    }
  }
  // The deployed mainnet MorpheusDataFeed intentionally retains the legacy
  // singular entry point alongside the canonical batch entry point. Both
  // signatures must still be exact; mainnet is deterministic because it
  // always selects updateFeeds. Testnet and unknown networks must reject a
  // mixed ABI rather than inheriting that mainnet compatibility rule.
  if (
    abi.has_update_feed === true &&
    abi.has_update_feeds === true &&
    network !== 'mainnet'
  ) {
    throw new Error(
      `[neo-n3] ${network || 'unknown'} ABI exposes multiple supported writer ABIs: ` +
        'refusing mixed write-mode dispatch outside the explicit mainnet batch policy'
    );
  }
  return abi;
}

export function assertBatchUpdateFeedsSupported(manifest, { feed, network } = {}) {
  const abi = parseContractUpdateMethods(manifest);
  if (!abi.probed) return abi;
  assertWriterAbiExact(abi, { network });
  if (!abi.has_update_feeds) {
    throw new Error(
      `[neo-n3] ${network || 'unknown'} feed 0x${feed || '?'} has no updateFeeds ` +
        `(has updateFeed=${abi.has_update_feed}). The batch pusher and enclave /feed/sign ` +
        'cannot write this contract.'
    );
  }
  return abi;
}

/**
 * Select the N3 write path from a magic-pinned network + a proven public ABI.
 *
 * Call only after resolveFeedNetwork / getversion. Any unprobed ABI, unknown
 * network, or mainnet without updateFeeds fails closed — never a silent
 * downgrade from batch to per-pair.
 */
export function resolveFeedWriteMode(network, abi) {
  const net = String(network || '')
    .trim()
    .toLowerCase();
  if (net !== 'mainnet' && net !== 'testnet') {
    throw new Error(
      `[neo-n3] unknown feed network ${net || '(empty)'}: refusing write-mode dispatch`
    );
  }
  assertWriterAbiExact(abi, { network: net });
  if (net === 'testnet' && abi.has_update_feed === true) {
    return FEED_WRITE_MODE_PER_PAIR;
  }
  if (net === 'mainnet' && abi.has_update_feeds === true) {
    return FEED_WRITE_MODE_BATCH;
  }
  if (net === 'mainnet') {
    throw new Error(
      `[neo-n3] mainnet feed has no updateFeeds (has updateFeed=${abi.has_update_feed}). ` +
        'Refusing silent downgrade from batch to per-pair.'
    );
  }
  throw new Error(
    `[neo-n3] ${net} feed has no proven writer method ` +
      `(updateFeeds=${abi.has_update_feeds}, updateFeed=${abi.has_update_feed})`
  );
}

export function storagePairName(symbol) {
  const bare = String(symbol || '')
    .trim()
    .replace(/^TWELVEDATA:/i, '')
    .toUpperCase();
  if (!bare) throw new Error('feed pair symbol is required');
  return `${FEED_PAIR_PREFIX}${bare}`;
}

export function encodeUpdateFeedInvocation({
  pair,
  roundId,
  price,
  timestamp,
  attestationHash,
  sourceSetId = 0,
} = {}) {
  const storagePair = storagePairName(pair);
  const round = Number(roundId);
  const scaled = Number(price);
  const ts = Number(timestamp);
  const source = Number(sourceSetId);
  if (!Number.isSafeInteger(round) || round <= 0) {
    throw new Error('updateFeed roundId must be a positive integer');
  }
  if (!Number.isSafeInteger(scaled) || scaled <= 0) {
    throw new Error('updateFeed price must be a positive integer (1e6 scale)');
  }
  if (!Number.isSafeInteger(ts) || ts <= 0) {
    throw new Error('updateFeed timestamp must be a positive unix second');
  }
  if (!Number.isSafeInteger(source) || source < 0) {
    throw new Error('updateFeed sourceSetId must be a non-negative integer');
  }
  const hash = attestationHash == null ? '' : String(attestationHash);
  return {
    operation: 'updateFeed',
    params: [
      { type: 'String', value: storagePair },
      { type: 'Integer', value: String(round) },
      { type: 'Integer', value: String(scaled) },
      { type: 'Integer', value: String(ts) },
      { type: 'ByteArray', value: hash },
      { type: 'Integer', value: String(source) },
    ],
  };
}

export function boundPerPairUpdates(pairs, { max = MAX_PER_PAIR_FEED_UPDATES } = {}) {
  if (!Array.isArray(pairs)) {
    throw new Error('per-pair update list must be an array');
  }
  if (!Number.isSafeInteger(max) || max <= 0) {
    throw new Error('per-pair update bound must be a positive integer');
  }
  if (pairs.length > max) {
    throw new Error(
      `per-pair update set exceeds bound ${max} (got ${pairs.length}); refusing unbounded write`
    );
  }
  return pairs.slice();
}

export function createFeedWriteReport({
  planned = [],
  skipped = [],
  writeMode = FEED_WRITE_MODE_PER_PAIR,
} = {}) {
  const pairs = boundPerPairUpdates(planned);
  const skippedPairs = boundPerPairUpdates(skipped);
  return {
    write_mode: writeMode,
    planned: pairs.slice(),
    confirmed: [],
    pending: [],
    submitted: [],
    failed: [],
    skipped: skippedPairs.slice(),
    faulted: [],
    txids: [],
    attempts: [],
    ok: pairs.length === 0,
  };
}

export function classifyFeedTransportError(error) {
  if (error == null || error === '') return null;
  const err = error instanceof Error || (error && typeof error === 'object') ? error : null;
  const code = String(err?.code || err?.cause?.code || '').toUpperCase();
  const name = String(err?.name || '');
  if (FEED_TRANSPORT_ERROR_CODES.includes(code)) {
    return { kind: 'transport', code };
  }
  if (name === 'TimeoutError' || name === 'AbortError') {
    return { kind: 'transport', code: code || 'ABORT_ERR' };
  }
  return null;
}

export function isRetryablePerPairError(error) {
  const message = String(error instanceof Error ? error.message : error || '');
  if (
    /invokescript fault|message mismatch|abi not proven|identity|refusing silent|wrong_arity|ambiguous abi|wrong-arity/i.test(
      message
    )
  ) {
    return false;
  }
  return classifyFeedTransportError(error) != null;
}

export function classifyBroadcastOutcome(error) {
  const transport = classifyFeedTransportError(error);
  if (transport) return { ...transport, retryable: true };
  const message = String(error instanceof Error ? error.message : error || '');
  const lower = message.toLowerCase();
  if (/alreadyexists|already exists|already in (the )?mempool|txn already exists/.test(lower)) {
    return { kind: 'already_exists', retryable: false };
  }
  if (/unknown transaction|unknown tx/.test(lower)) {
    return { kind: 'unknown_transaction', retryable: false };
  }
  if (message.trim()) {
    return { kind: 'rejection', retryable: false };
  }
  return { kind: 'unknown', retryable: false };
}

export function createSignedFeedTxIdentity({
  nonce,
  validUntilBlock,
  messageHex,
  hash,
  rawTx,
} = {}) {
  const nextNonce = Number(nonce);
  if (!Number.isInteger(nextNonce) || nextNonce < 0 || nextNonce > 0xffffffff) {
    throw new Error('signed feed tx nonce must be a uint32');
  }
  const until = Number(validUntilBlock);
  if (!Number.isSafeInteger(until) || until < 1) {
    throw new Error('signed feed tx validUntilBlock is not proven');
  }
  const message = String(messageHex || '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!message) throw new Error('signed feed tx message is required');
  const txHash = String(hash || '').trim();
  if (!txHash) throw new Error('signed feed tx hash is required');
  const raw = String(rawTx || '').trim();
  if (!raw) throw new Error('signed feed raw tx is required');
  return Object.freeze({
    nonce: nextNonce,
    validUntilBlock: until,
    messageHex: message,
    hash: txHash,
    rawTx: raw,
  });
}

export function canReplaceSignedTxIdentity(
  previous,
  { knownOnChain = false, validUntilExpired = false, rejected = false } = {}
) {
  if (!previous) return true;
  if (knownOnChain) return false;
  return Boolean(validUntilExpired || rejected);
}

export function nextPerPairTxParams(previous, { blockCount, systemFee, networkFee, nonce } = {}) {
  const count = Number(blockCount);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error('per-pair valid-until-block requires a proven getblockcount');
  }
  const nextNonce = Number(nonce);
  if (!Number.isInteger(nextNonce) || nextNonce < 0 || nextNonce > 0xffffffff) {
    throw new Error('per-pair nonce must be a uint32');
  }
  if (previous && Number(previous.nonce) === nextNonce) {
    throw new Error('per-pair nonce must change between attempts (idempotent retry key)');
  }
  const sys = Number(systemFee);
  const net = Number(networkFee);
  if (!Number.isSafeInteger(sys) || sys < 0) throw new Error('per-pair systemFee is not proven');
  if (!Number.isSafeInteger(net) || net < 0) throw new Error('per-pair networkFee is not proven');
  return {
    nonce: nextNonce,
    validUntilBlock: count + FEED_VALID_UNTIL_OFFSET,
    blockCount: count,
    systemFee: sys,
    networkFee: net,
  };
}

function pushUnique(list, value) {
  if (!list.includes(value)) list.push(value);
}

function removeValue(list, value) {
  const index = list.indexOf(value);
  if (index >= 0) list.splice(index, 1);
}

export function createPerPairWriteReport(options) {
  return createFeedWriteReport(options);
}

export function advanceFeedWrite(report, event = {}) {
  if (!report || typeof report !== 'object') {
    throw new Error('per-pair write report is required');
  }
  const pair = storagePairName(event.pair || event.symbol);
  const status = String(event.status || '').toLowerCase();
  const attempt = Number(event.attempt || 1);
  const row = {
    pair,
    status,
    attempt,
    txid: event.txid || null,
    error: event.error ? String(event.error) : null,
  };
  report.attempts.push(row);
  if (event.txid && !report.txids.includes(event.txid)) {
    report.txids.push(event.txid);
  }
  if (status === 'confirmed') {
    pushUnique(report.confirmed, pair);
    pushUnique(report.submitted, pair);
    removeValue(report.pending, pair);
    removeValue(report.failed, pair);
    removeValue(report.faulted, pair);
  } else if (status === 'pending' || status === 'timeout' || status === 'submitted') {
    pushUnique(report.submitted, pair);
    if (status !== 'submitted' || event.pending === true) {
      pushUnique(report.pending, pair);
    }
    if (status === 'timeout') {
      pushUnique(report.pending, pair);
    }
    removeValue(report.confirmed, pair);
  } else if (status === 'fault') {
    pushUnique(report.failed, pair);
    pushUnique(report.faulted, pair);
    removeValue(report.pending, pair);
    removeValue(report.confirmed, pair);
  } else if (status === 'failed') {
    pushUnique(report.failed, pair);
    removeValue(report.pending, pair);
    removeValue(report.confirmed, pair);
  } else if (status === 'skipped') {
    pushUnique(report.skipped, pair);
  } else {
    throw new Error(`unknown per-pair status ${status || '(empty)'}`);
  }
  return report;
}

export function advancePerPairWrite(report, event = {}) {
  return advanceFeedWrite(report, event);
}

export function markFeedWriteSubmitted(report, { pairs = [], identity, attempt = 1 } = {}) {
  if (!report || typeof report !== 'object') {
    throw new Error('feed write report is required');
  }
  if (!identity?.hash) throw new Error('submitted identity hash is required');
  const list = Array.isArray(pairs) ? pairs : [pairs];
  for (const pair of list) {
    advanceFeedWrite(report, {
      pair,
      status: 'submitted',
      txid: identity.hash,
      attempt,
    });
  }
  report.submitted_identity = Object.freeze({
    hash: identity.hash,
    nonce: identity.nonce,
    validUntilBlock: identity.validUntilBlock,
  });
  return report;
}

export function applyWriteConfirmation(
  report,
  { pairs = [], confirmation = {}, identity, attempt = 1 } = {}
) {
  if (!report || typeof report !== 'object') {
    throw new Error('feed write report is required');
  }
  const status =
    confirmation.status === 'confirmed'
      ? 'confirmed'
      : confirmation.status === 'fault'
        ? 'fault'
        : confirmation.status === 'timeout'
          ? 'timeout'
          : confirmation.status === 'failed'
            ? 'failed'
            : 'pending';
  const list = Array.isArray(pairs) ? pairs : [pairs];
  for (const pair of list) {
    advanceFeedWrite(report, {
      pair,
      status,
      txid: identity?.hash || confirmation.hash || null,
      error: confirmation.exception || confirmation.reason || confirmation.status,
      attempt,
    });
  }
  if (identity?.hash && !report.submitted_identity) {
    report.submitted_identity = Object.freeze({
      hash: identity.hash,
      nonce: identity.nonce,
      validUntilBlock: identity.validUntilBlock,
    });
  }
  return report;
}

export function deriveConfirmationStatus(report) {
  if (!report || typeof report !== 'object') {
    throw new Error('feed write report is required');
  }
  if (report.ok) {
    return (report.planned || []).length === 0 ? 'skipped' : 'confirmed';
  }
  if ((report.failed || []).length || (report.faulted || []).length) return 'failed';
  if ((report.pending || []).length) return 'pending';
  if ((report.submitted || []).length) return 'submitted';
  return 'failed';
}

export function finalizeFeedWrite(report) {
  if (!report || typeof report !== 'object') {
    throw new Error('per-pair write report is required');
  }
  const planned = Array.isArray(report.planned) ? report.planned : [];
  const confirmed = new Set(report.confirmed || []);
  const skipped = new Set(report.skipped || []);
  const pending = [...new Set(report.pending || [])];
  const failed = [...new Set(report.failed || [])];
  const unresolved = planned.filter(
    (pair) =>
      !confirmed.has(pair) &&
      !skipped.has(pair) &&
      !pending.includes(pair) &&
      !failed.includes(pair)
  );
  for (const pair of unresolved) failed.push(pair);
  report.pending = pending.filter((pair) => !confirmed.has(pair) && !failed.includes(pair));
  report.failed = failed;
  report.ok =
    failed.length === 0 &&
    report.pending.length === 0 &&
    planned.every((pair) => confirmed.has(pair) || skipped.has(pair));
  return report;
}

export function finalizePerPairWrite(report) {
  return finalizeFeedWrite(report);
}

const PROVEN_UPDATER_KEY_SOURCES = new Set(['kms_attested', 'host_plaintext']);

function readHealthSignerFlag(health) {
  if (health.checks && health.checks.signer === true) return true;
  return false;
}

function readHealthUpdaterSource(health) {
  const source = health.key_source && health.key_source.updater;
  return typeof source === 'string' ? source.trim() : '';
}

/**
 * Accept the live enclave GET /health body only: `ready` + `checks.signer` +
 * materialized `key_source.updater`. Compact `{ ready, signer }` does not prove
 * an updater key and is refused. `ready` alone is compute + oracle_verifier.
 */
export function assertSignerHealth(health) {
  if (!health || typeof health !== 'object') {
    throw new Error('signer health not proven');
  }
  const signerOk = readHealthSignerFlag(health);
  const updaterSource = readHealthUpdaterSource(health);
  const updaterOk = PROVEN_UPDATER_KEY_SOURCES.has(updaterSource);
  if (health.ready !== true || !signerOk || !updaterOk) {
    throw new Error(
      `signer health not proven (ready=${health.ready}, signer=${health.checks?.signer ?? health.signer}, updater=${updaterSource || 'unproven'})`
    );
  }
  return health;
}

export function assertContractIdentity(state, expectedFeed) {
  const expected = normalizeHash160(expectedFeed);
  const got = normalizeHash160(state?.hash || state?.id || state?.scripthash);
  if (!expected) throw new Error('expected contract identity is not a Hash160');
  if (!got || got !== expected) {
    throw new Error(`contract identity not proven: got 0x${got || '?'} expected 0x${expected}`);
  }
  return got;
}

export function assertUpdaterIdentity(stackItem, expectedUpdater) {
  const expected = normalizeHash160(expectedUpdater);
  if (!expected) throw new Error('expected updater identity is not a Hash160');
  const got = normalizeHash160(decodeNeoHash160(stackItem));
  if (!got || got !== expected) {
    throw new Error(`updater identity not proven: got 0x${got || '?'} expected 0x${expected}`);
  }
  return got;
}

export function assertPriceFreshness(prices, now) {
  const ts = Number(now);
  if (!Number.isFinite(ts) || ts <= 0) {
    throw new Error('price freshness not proven: cycle clock is missing');
  }
  if (ts > Date.now() / 1000 + CLOCK_SKEW_TOLERANCE_SEC) {
    throw new Error('price freshness not proven: cycle clock is ahead of host time');
  }
  if (!prices || typeof prices !== 'object' || Array.isArray(prices)) {
    throw new Error('price freshness not proven: TwelveData payload missing');
  }
  const fresh = Object.entries(prices).filter(([, value]) => Number.isFinite(value) && value > 0);
  if (!fresh.length) {
    throw new Error('price freshness not proven: no positive TwelveData quotes this cycle');
  }
  return fresh.length;
}

export function assertInvocationResult(result, { requireHash = false } = {}) {
  if (result == null || typeof result !== 'object') {
    throw new Error('invocation result not proven');
  }
  const state = String(result.state || '').toUpperCase();
  if (state && state !== 'HALT') {
    throw new Error(`invocation result not proven: state ${state} ${result.exception || ''}`);
  }
  if (requireHash) {
    const hash = String(result.hash || result.txid || '').trim();
    if (!hash) throw new Error('invocation result not proven: sendrawtransaction returned no hash');
    return hash;
  }
  return result;
}

export function assertBroadcastAccepted(result) {
  if (result == null || typeof result !== 'object') {
    throw new Error('broadcast acceptance not proven');
  }
  const state = String(result.state || '').toUpperCase();
  if (state && state !== 'HALT') {
    throw new Error(`broadcast rejected: state ${state} ${result.exception || ''}`);
  }
  const hash = String(result.hash || result.txid || '').trim();
  if (!hash) {
    throw new Error('broadcast acceptance not proven: sendrawtransaction returned no hash');
  }
  return hash;
}

function defaultConfirmSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function classifyApplicationLog(result, error) {
  if (error) {
    const message = String(error instanceof Error ? error.message : error || '').toLowerCase();
    if (/unknown transaction|unknown tx/.test(message)) {
      return { status: 'pending', reason: 'unknown_transaction' };
    }
    if (classifyFeedTransportError(error)) {
      return { status: 'pending', reason: 'rpc_transport' };
    }
    return { status: 'pending', reason: 'rpc_error' };
  }
  const execution = result?.executions?.[0];
  const vm = String(execution?.vmstate || result?.state || '').toUpperCase();
  if (vm === 'HALT') return { status: 'confirmed', vmstate: 'HALT' };
  if (vm === 'FAULT') {
    return {
      status: 'fault',
      vmstate: 'FAULT',
      exception: String(execution?.exception || result?.exception || ''),
    };
  }
  return { status: 'pending', reason: 'no_vmstate' };
}

export async function confirmFeedApplicationLog({
  rpc,
  hash,
  attempts = FEED_CONFIRMATION_POLL_ATTEMPTS,
  intervalMs = FEED_CONFIRMATION_POLL_INTERVAL_MS,
  sleep = defaultConfirmSleep,
} = {}) {
  if (typeof rpc !== 'function') throw new Error('confirmation rpc is required');
  const txid = String(hash || '').trim();
  if (!txid) throw new Error('confirmation requires a broadcast hash');
  const max = Number(attempts);
  const wait = Number(intervalMs);
  if (!Number.isSafeInteger(max) || max < 1 || max > 32) {
    throw new Error('confirmation attempts must be a bounded positive integer');
  }
  if (!Number.isSafeInteger(wait) || wait < 0 || wait > 10_000) {
    throw new Error('confirmation interval is outside the bounded range');
  }
  let last = { status: 'pending', reason: 'untried' };
  for (let index = 0; index < max; index += 1) {
    try {
      last = classifyApplicationLog(await rpc('getapplicationlog', [txid]));
    } catch (error) {
      last = classifyApplicationLog(null, error);
    }
    if (last.status === 'confirmed' || last.status === 'fault') {
      return { ...last, hash: txid, attempts: index + 1 };
    }
    if (index < max - 1) await sleep(wait);
  }
  return {
    status: 'timeout',
    reason: last.reason || 'confirmation_timeout',
    hash: txid,
    attempts: max,
  };
}

export async function reconcileSignedFeedTx({ rpc, identity } = {}) {
  if (typeof rpc !== 'function') throw new Error('reconcile rpc is required');
  const hash = String(identity?.hash || '').trim();
  if (!hash) throw new Error('reconcile requires a signed tx hash');
  try {
    const classified = classifyApplicationLog(await rpc('getapplicationlog', [hash]));
    if (classified.status === 'confirmed' || classified.status === 'fault') {
      return { found: true, ...classified, hash };
    }
  } catch (error) {
    const classified = classifyApplicationLog(null, error);
    if (classified.reason !== 'unknown_transaction') {
      return { found: false, ...classified, hash };
    }
  }
  try {
    const raw = await rpc('getrawtransaction', [hash, false]);
    if (raw) return { found: true, status: 'pending', reason: 'in_mempool_or_chain', hash };
  } catch {
    // Hash is not in mempool or chain.
  }
  return { found: false, status: 'unknown', hash };
}

function normalizeBoundNetworkName(value) {
  const network = String(value || '')
    .trim()
    .toLowerCase();
  if (network === 'mainnet' || network === 'testnet') return network;
  throw new Error(`enclave network identity unsupported network ${network || '(empty)'}`);
}

let boundEnclaveNetworkIdentity = null;

export function identitiesEqual(left, right) {
  if (!left || !right) return false;
  return (
    left.network === right.network &&
    left.magic === right.magic &&
    left.feed === right.feed &&
    left.updaterSh === right.updaterSh &&
    left.updaterPub === right.updaterPub &&
    left.updaterRole === right.updaterRole
  );
}

export function validateEnclaveNetworkIdentity(env = process.env) {
  const feed = resolveFeedNetwork(env);
  const explicitMorpheus = explicitEnvValue(env, 'MORPHEUS_NETWORK');
  const morpheus = explicitMorpheus ? normalizeBoundNetworkName(explicitMorpheus) : feed.network;
  if (morpheus !== feed.network) {
    throw new Error(
      `enclave network identity split-brain: FEED_NETWORK=${feed.network} MORPHEUS_NETWORK=${morpheus}`
    );
  }
  return Object.freeze({
    network: feed.network,
    magic: feed.magic,
    feed: feed.feed,
    updaterSh: feed.updaterSh,
    updaterPub: feed.updaterPub,
    updaterAddress: feed.updaterAddress,
    updaterRole: FEED_UPDATER_ROLE,
    rpcs: feed.rpcs,
  });
}

export function bindEnclaveNetworkIdentity(env = process.env) {
  const identity = validateEnclaveNetworkIdentity(env);
  if (boundEnclaveNetworkIdentity && !identitiesEqual(boundEnclaveNetworkIdentity, identity)) {
    throw new Error('enclave network identity is immutable; refusing retarget');
  }
  boundEnclaveNetworkIdentity = identity;
  return boundEnclaveNetworkIdentity;
}

export function provisionTouchesEnclaveNetworkIdentity(env = {}) {
  return ENCLAVE_NETWORK_BIND_KEYS.some((key) => explicitEnvValue(env, key));
}

export function assertProvisionEnclaveNetworkIdentity(currentEnv, incomingEnv = {}) {
  if (!provisionTouchesEnclaveNetworkIdentity(incomingEnv)) return null;
  const prospective = { ...currentEnv };
  for (const [key, value] of Object.entries(incomingEnv || {})) {
    const text = value == null ? '' : String(value).trim();
    if (text) prospective[key] = text;
  }
  const identity = validateEnclaveNetworkIdentity(prospective);
  if (boundEnclaveNetworkIdentity && !identitiesEqual(boundEnclaveNetworkIdentity, identity)) {
    throw new Error('enclave network identity is immutable; refusing retarget');
  }
  return identity;
}

export function __resetBoundEnclaveNetworkIdentityForTests() {
  boundEnclaveNetworkIdentity = null;
}

export function isMissingBatchUpdateFeedsError(error) {
  const message = String(error instanceof Error ? error.message : error || '').toLowerCase();
  if (!message) return false;
  return (
    message.includes('method not found: updatefeeds/6') ||
    /method\s+["']?updatefeeds["']?\s+with\s+6\s+parameter\(s\)\s+doesn['’]?t\s+exist/.test(
      message
    ) ||
    /method\s+["']?updatefeeds["']?.*doesn['’]?t\s+exist/.test(message) ||
    message.includes('has no updatefeeds')
  );
}

const JSONRPC_METHOD_NOT_FOUND = -32601;

function jsonRpcErrorParts(error) {
  if (error && typeof error === 'object' && !(error instanceof Error)) {
    const nested = error.error && typeof error.error === 'object' ? error.error : error;
    return {
      code: Number(nested.code),
      message: String(nested.message || nested.exception || ''),
    };
  }
  if (error instanceof Error) {
    const code = Number(error.code);
    return { code: Number.isFinite(code) ? code : NaN, message: error.message || '' };
  }
  return { code: NaN, message: String(error || '') };
}

export function isMissingGetAllFeedRecordsError(error) {
  const { code, message } = jsonRpcErrorParts(error);
  const lower = message.toLowerCase();
  if (!lower.trim()) return false;
  // Storage / business faults must never look like a missing ABI method.
  if (/\bkey(?:\s+that)?\s+does\s+not\s+exist\b/.test(lower)) return false;
  const neoGo = /(?:^|[\s,{])method not found:\s*getallfeedrecords\/\d+\b/.test(lower);
  const neoCsharp =
    /method\s+["']getallfeedrecords["']\s+with\s+\d+\s+parameter\(s\)\s+doesn['’]?t\s+exist(?:\s+in\s+the\s+contract\b)?/.test(
      lower
    );
  const jsonRpcNamed = code === JSONRPC_METHOD_NOT_FOUND && /getallfeedrecords/.test(lower);
  return neoGo || neoCsharp || jsonRpcNamed;
}

function emptyFeedRecordDecode(reason, extra = {}) {
  return {
    ok: false,
    reason,
    rows: [],
    record_count: 0,
    decoded_count: 0,
    undecodable_count: 0,
    ...extra,
  };
}

export function decodeFeedRecordStackItem(record) {
  const values = record && record.value;
  if (!Array.isArray(values) || values.length < 4) return null;
  const pairRaw = values[0]?.value;
  if (pairRaw == null || pairRaw === '') return null;
  let pair;
  try {
    pair = Buffer.from(String(pairRaw), 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (!pair) return null;
  return {
    pair,
    round: Number(values[1]?.value || 0),
    price: Number(values[2]?.value || 0) / 1e6,
    timestamp: Number(values[3]?.value || 0),
  };
}

/**
 * Decode getAllFeedRecords HALT/FAULT into a fail-closed result.
 *
 * Empty HALT, malformed stack, and any undecodable row in a nonempty registry
 * are hard failures — not bootstrap and not a healthy empty feed. FAULT is a
 * hard failure unless the exception is a clear missing-method signature, in
 * which case reason is `unsupported_method` so a caller may fall back to
 * per-pair getLatest.
 */
export function decodeGetAllFeedRecords(result) {
  if (result == null || typeof result !== 'object') {
    return emptyFeedRecordDecode('undecodable');
  }
  const state = String(result.state || '').toUpperCase();
  const exception = String(result.exception || result.message || '');
  if (state === 'FAULT') {
    if (isMissingGetAllFeedRecordsError(exception)) {
      return emptyFeedRecordDecode('unsupported_method');
    }
    return emptyFeedRecordDecode('fault');
  }
  if (state !== 'HALT') {
    return emptyFeedRecordDecode('undecodable');
  }
  const records =
    result.stack && result.stack[0] && Array.isArray(result.stack[0].value)
      ? result.stack[0].value
      : null;
  if (!Array.isArray(records)) {
    return emptyFeedRecordDecode('malformed');
  }
  if (records.length === 0) {
    return emptyFeedRecordDecode('empty');
  }
  const rows = [];
  let undecodableCount = 0;
  for (const record of records) {
    const decoded = decodeFeedRecordStackItem(record);
    if (!decoded) {
      undecodableCount += 1;
      continue;
    }
    rows.push(decoded);
  }
  if (undecodableCount > 0) {
    return {
      ok: false,
      reason: 'undecodable',
      rows,
      record_count: records.length,
      decoded_count: rows.length,
      undecodable_count: undecodableCount,
    };
  }
  return {
    ok: true,
    reason: null,
    rows,
    record_count: records.length,
    decoded_count: rows.length,
    undecodable_count: 0,
  };
}

function bytesToCanonicalHash160(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 20) return '';
  return `0x${Buffer.from(bytes).reverse().toString('hex')}`;
}

function decodeHexMaybe(value) {
  const raw = String(value || '')
    .trim()
    .replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]+$/.test(raw) || raw.length % 2 !== 0) return null;
  return Buffer.from(raw, 'hex');
}

/**
 * Decode a Neo HALT stack Hash160 into canonical `0x` + big-endian hex.
 *
 * Encodings the MorpheusDataFeed `updater()` HALT actually returns:
 * - ByteString / ByteArray: base64 of 20 little-endian bytes
 * - ByteString / ByteArray: 40-char hex of those same LE bytes
 * - Hash160: already-canonical 40-char hex, with or without `0x`
 * - a bare 40-char / `0x` hex string
 *
 * Unsupported representations throw. Callers that can degrade (audit updater
 * identity) catch; writers must not swallow this.
 */
export function decodeNeoHash160(stackItem) {
  if (stackItem == null || stackItem === '') {
    throw new Error('Hash160 stack item is empty');
  }
  if (typeof stackItem === 'string') {
    const canonical = normalizeHash160(stackItem);
    if (canonical) return `0x${canonical}`;
    throw new Error('unsupported Hash160 string representation');
  }
  if (!stackItem || typeof stackItem !== 'object') {
    throw new Error(`unsupported Hash160 stack item type ${typeof stackItem}`);
  }

  const type = String(stackItem.type || '').toLowerCase();
  const value = stackItem.value;
  if (value == null || value === '') {
    throw new Error(`Hash160 stack item ${type || 'unknown'} has an empty value`);
  }

  if (type === 'hash160' || type === 'hash256') {
    const canonical = normalizeHash160(value);
    if (canonical) return `0x${canonical}`;
    throw new Error(`unsupported Hash160 hex in ${type} item`);
  }

  if (type === 'bytestring' || type === 'bytearray' || type === '') {
    const asHex = decodeHexMaybe(value);
    if (asHex && asHex.length === 20) {
      return bytesToCanonicalHash160(asHex);
    }
    try {
      const bytes = Buffer.from(String(value), 'base64');
      const canonical = bytesToCanonicalHash160(bytes);
      if (canonical) return canonical;
    } catch {
      // fall through to the unsupported throw
    }
    throw new Error(`unsupported Hash160 ${type || 'ByteString'} encoding (need 20 bytes)`);
  }

  throw new Error(`unsupported Hash160 stack representation ${type || typeof value}`);
}

export function extractNetworkMagic(getversionResult) {
  const magic = Number(
    getversionResult?.protocol?.network ?? getversionResult?.network ?? getversionResult?.magic
  );
  if (!Number.isFinite(magic) || magic <= 0) {
    throw new Error('getversion did not return a network magic');
  }
  return magic;
}

export async function fetchGetVersion(rpcUrl, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getversion', params: [] }),
    signal: AbortSignal.timeout(12000),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('getversion returned non-JSON');
  }
  if (payload?.error) throw new Error('getversion rpc error');
  return payload.result;
}

export async function selectRpcsMatchingMagic(
  rpcUrls,
  expectedMagic,
  { probe = fetchGetVersion } = {}
) {
  const expected = Number(expectedMagic);
  if (!Number.isFinite(expected) || expected <= 0) {
    throw new Error('expected magic is not a positive network magic');
  }
  const urls = parseRpcList(rpcUrls);
  const matched = [];
  const rejected = [];
  for (const url of urls) {
    try {
      const magic = extractNetworkMagic(await probe(url));
      if (magic === expected) {
        matched.push(url);
      } else {
        rejected.push({ host: rpcHostLabel(url), magic, reason: 'magic_mismatch' });
      }
    } catch {
      rejected.push({ host: rpcHostLabel(url), reason: 'getversion_failed' });
    }
  }
  if (!matched.length) {
    throw new Error(
      `no RPC matched magic ${expected} after getversion (candidates=${urls.length})`
    );
  }
  return { matched, rejected };
}

export function normalizeChainUnixTime(value) {
  let time = Number(value);
  if (!Number.isFinite(time) || time <= 0) {
    throw new Error('getblock header time is missing');
  }
  // Some indexers return header time in milliseconds. Unix seconds for 2026
  // are ~1.78e9; treating ms as seconds makes every pair look hundreds of
  // millions of hours stale.
  if (time > 1e12) time = Math.floor(time / 1000);
  return time;
}

export async function readChainUnixTime(rpc) {
  const count = Number(await rpc('getblockcount', []));
  if (!Number.isFinite(count) || count < 1) {
    throw new Error('getblockcount did not return a block height');
  }
  const block = await rpc('getblock', [count - 1, 1]);
  return normalizeChainUnixTime(block?.time ?? block?.header?.time);
}

export function finalizePusherCycle({
  fetchError = null,
  chainErrors = [],
  missingAlerts = [],
} = {}) {
  const errors = [];
  if (fetchError) {
    errors.push({
      code: 'twelvedata_fetch_failed',
      summary: String(fetchError instanceof Error ? fetchError.message : fetchError),
      ...([
        'daily_quota_exhausted',
        'minute_rate_limited',
        'rate_limited',
        'subscription_expired',
        'provider_unauthorized',
        'provider_error',
        'no_usable_prices',
      ].includes(fetchError.providerCategory)
        ? { provider_category: fetchError.providerCategory }
        : {}),
    });
  }
  for (const error of chainErrors || []) {
    const summary = String(error instanceof Error ? error.message : error);
    errors.push({
      code: isMissingBatchUpdateFeedsError(summary)
        ? 'neo_n3_updatefeeds_missing'
        : 'chain_push_failed',
      summary,
    });
  }
  for (const alert of missingAlerts || []) {
    errors.push({
      code: 'symbol_missing_from_provider',
      summary: `${alert.symbol} missing from TwelveData for ${alert.cycles} consecutive cycles`,
    });
  }
  return {
    ok: errors.length === 0,
    errors,
    exitCode: errors.length === 0 ? 0 : 1,
  };
}
