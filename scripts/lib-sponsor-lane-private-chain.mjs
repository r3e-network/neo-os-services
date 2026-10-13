// Pure helpers for the CU-153 sponsor-lane journey
// (scripts/test-sponsor-lane-private-chain.mjs).
//
// Nothing in this module performs I/O. It holds the decisions that decide whether
// the journey can report a false pass: the wire encoding the real parser will be
// asked to read, the fake SIGN's byte contract, the SQL the local delivery peer is
// allowed to issue, and the single acceptance evaluator. The driver is only
// orchestration around these.
//
// Two encoders are mirrored here and both are pinned to golden vectors taken from
// the Rust encoder (`crates/neo-os-core/src/n3_tx.rs`, vectors in
// `crates/neo-os-core/tests/n3_tx.rs`), not to a round-trip against themselves.
// The real gate is the one in the lane: `parse_unsigned_tx` and
// `validate_sponsorable_intent` refuse anything this module gets wrong, so a
// mistake here is a red journey rather than a green lie.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as cryptoSign,
} from 'node:crypto';

/** The disposable private chain's magic, shared with the CU-88 harness. */
export const PRIVATE_CHAIN_MAGIC = 894710606;

/**
 * `fee_ceiling_units between 1 and 20000000` in
 * `db/services/migrations/20261012120000_relayer_delivery_sponsor.sql`. The
 * journey's ceiling is this bound so one reservation already reaches the
 * principal's lifetime budget and the refusal is reachable in two requests
 * instead of twenty.
 */
export const SPONSOR_SCHEMA_MAX_FEE_CEILING_UNITS = 20_000_000;

/** `N3_ADDRESS_VERSION` from `workers/neo-signer/src/crypto.rs`. */
export const NEO_ADDRESS_VERSION = 0x35;

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const P256_ORDER = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

export class HarnessError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HarnessError';
  }
}

function fail(message) {
  throw new HarnessError(message);
}

/**
 * Every acceptance check the journey must see before it may report green.
 * A run that is missing any of these is a failure, never a partial pass.
 */
export const ACCEPTANCE_CHECKS = [
  'check/intent-paid-and-confirmed',
  'check/journal-id-returned',
  'check/journal-receipt-matches-signed',
  'check/journal-holds-the-reserved-ceiling',
  'check/sponsor-charged',
  'check/recipient-paid',
  'check/budget-debited',
  'check/budget-exhaustion-refused',
  'check/refusal-broadcast-nothing',
  'check/ineligible-intent-refused',
];

export function stripHexPrefix(value) {
  const text = String(value ?? '').trim();
  return (/^0x/i.test(text) ? text.slice(2) : text).toLowerCase();
}

/** A 20-byte script hash as `0x` + 40 lowercase hex digits, or a refusal. */
export function normalizeScriptHash(value) {
  const bare = stripHexPrefix(value);
  if (!/^[0-9a-f]{40}$/.test(bare)) {
    fail(`expected a 20-byte hex script hash, received ${JSON.stringify(String(value ?? ''))}`);
  }
  return `0x${bare}`;
}

/**
 * The one profile check. A journey that can be driven outside the disposable
 * private testnet is a production code path wearing a test name.
 */
export function assertTestOnlyProfile({ nodeEnv, network, magic }) {
  const env = String(nodeEnv ?? '')
    .trim()
    .toLowerCase();
  if (env === 'production') {
    fail('the sponsor-lane journey refuses to run with NODE_ENV=production');
  }
  if (
    String(network ?? '')
      .trim()
      .toLowerCase() === 'mainnet'
  ) {
    fail('the sponsor-lane journey refuses to run against mainnet');
  }
  if (Number(magic) !== PRIVATE_CHAIN_MAGIC) {
    fail(`the private chain must use testnet magic ${PRIVATE_CHAIN_MAGIC}, received ${magic}`);
  }
}

function assertLoopbackUrl(value, name) {
  const text = String(value ?? '').trim();
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    fail(`${name} is not a URL: ${text}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail(`${name} must be an http(s) URL`);
  }
  if (!['127.0.0.1', '[::1]', '::1'].includes(parsed.hostname)) {
    fail(`${name} must be a literal loopback address, received host ${parsed.hostname}`);
  }
  return text.replace(/\/$/, '');
}

/**
 * Environment for the real `neo-os-relayer serve:sponsor` in the disposable
 * profile. Every endpoint is loopback-checked, and the only stand-ins named here
 * are the two the row allows: the signing endpoint and the delivery store's HTTP
 * peer.
 */
export function buildSponsorEnv(shape) {
  assertTestOnlyProfile(shape);
  const rpcUrl = assertLoopbackUrl(shape.chainRpcUrl, 'chainRpcUrl');
  const custodyUrl = assertLoopbackUrl(shape.signUrl, 'signUrl');
  const storeUrl = assertLoopbackUrl(shape.storeUrl, 'storeUrl');
  const sponsorUrl = new URL(assertLoopbackUrl(shape.sponsorUrl, 'sponsorUrl'));
  const contract = normalizeScriptHash(shape.sponsorableContract);
  const feeCeilingUnits = Number(shape.feeCeilingUnits);
  if (!Number.isInteger(feeCeilingUnits) || feeCeilingUnits < 1) {
    fail(`feeCeilingUnits must be a positive integer, received ${shape.feeCeilingUnits}`);
  }
  if (feeCeilingUnits > SPONSOR_SCHEMA_MAX_FEE_CEILING_UNITS) {
    fail(
      `feeCeilingUnits must fit the reservation schema bound of ${SPONSOR_SCHEMA_MAX_FEE_CEILING_UNITS}`
    );
  }
  if (shape.enabled !== true) {
    fail('the journey runs with the kill switch open; say so explicitly');
  }
  return {
    NODE_ENV: String(shape.nodeEnv),
    MORPHEUS_NETWORK: String(shape.network),
    MORPHEUS_LOCAL_CHAIN: 'true',
    MORPHEUS_LOCAL_CHAIN_RPC_URLS: rpcUrl,
    MORPHEUS_RELAYER_MODE: 'requests_only',
    MORPHEUS_RELAYER_NEO_N3_SCAN_MODE: 'block_cursor',
    MORPHEUS_RELAYER_ALLOW_RUNTIME_FALLBACKS: 'false',
    MORPHEUS_ACTIVE_CHAINS: 'neo_n3',
    MORPHEUS_RELAYER_NEO_N3_START_BLOCK: '0',
    MORPHEUS_RELAYER_NEO_N3_CONFIRMATIONS: '0',
    MORPHEUS_AUTOMATION_ENABLED: 'false',
    MORPHEUS_RELAYER_STATE_FILE: String(shape.stateFile),
    SUPABASE_URL: storeUrl,
    SUPABASE_SERVICE_ROLE_KEY: String(shape.storeToken),
    SIGNER_SERVICE_URL: custodyUrl,
    SIGNER_SERVICE_TOKEN: String(shape.signToken),
    SIGNER_ROLE_SPONSOR_KEY_ID: String(shape.signKeyId),
    MORPHEUS_SPONSOR_HOST: sponsorUrl.hostname,
    MORPHEUS_SPONSOR_PORT: String(sponsorUrl.port || 80),
    MORPHEUS_SPONSOR_CONTRACT: contract,
    MORPHEUS_SPONSOR_FEE_CEILING_UNITS: String(feeCeilingUnits),
    MORPHEUS_SPONSOR_ENABLED: 'true',
    // The disposable chain is a single consensus node and does not tick a
    // block every few hundred milliseconds; a window of five seconds reported
    // `SUBMISSION_UNKNOWN` for a transaction the node had already accepted into
    // its mempool. The window is long enough to see a block on that chain and
    // short enough to fail a run rather than hang it.
    MORPHEUS_SPONSOR_CONFIRM_ATTEMPTS: String(shape.confirmAttempts ?? 120),
    MORPHEUS_SPONSOR_CONFIRM_WAIT_MS: String(shape.confirmWaitMs ?? 500),
    MORPHEUS_SPONSOR_PRINCIPAL_HEADER: 'x-neoos-principal',
  };
}

// ---------------------------------------------------------------------------
// Base58Check and Neo addresses
// ---------------------------------------------------------------------------

function base58Encode(bytes) {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let out = '';
  while (value > 0n) {
    out = BASE58_ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

function base58Decode(text) {
  let value = 0n;
  for (const character of String(text)) {
    const index = BASE58_ALPHABET.indexOf(character);
    if (index < 0) fail(`${text} is not a base58 address`);
    value = value * 58n + BigInt(index);
  }
  const hex = value.toString(16).padStart(2, '0');
  const body = Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
  let leading = 0;
  for (const character of String(text)) {
    if (character !== '1') break;
    leading += 1;
  }
  return Buffer.concat([Buffer.alloc(leading), body]);
}

/** The Neo address of a display-order script hash (`0x35` + wire order). */
export function base58checkEncode(scriptHashDisplay) {
  const display = stripHexPrefix(scriptHashDisplay);
  if (!/^[0-9a-f]{40}$/.test(display)) {
    fail(`expected a 20-byte script hash, received ${JSON.stringify(String(scriptHashDisplay))}`);
  }
  const payload = Buffer.concat([
    Buffer.from([NEO_ADDRESS_VERSION]),
    Buffer.from(display, 'hex').reverse(),
  ]);
  const checksum = sha256(sha256(payload)).subarray(0, 4);
  return base58Encode(Buffer.concat([payload, checksum]));
}

/** A Neo address back to its display-order script hash. */
export function base58checkDecode(address) {
  const text = String(address ?? '').trim();
  if (text.length < 25) fail(`${text} is not a base58 address`);
  const raw = base58Decode(text);
  if (raw.length < 5) fail(`${text} is not a base58 address`);
  const payload = raw.subarray(0, raw.length - 4);
  const checksum = raw.subarray(raw.length - 4);
  if (!sha256(sha256(payload)).subarray(0, 4).equals(checksum)) {
    fail(`${text} is not a base58check address`);
  }
  if (payload[0] !== NEO_ADDRESS_VERSION) {
    fail(`${text} is not a Neo N3 address`);
  }
  return Buffer.from(payload.subarray(1)).reverse().toString('hex');
}

/**
 * The Neo N3 address of a display-order script hash: the account the contract
 * or key at that hash controls.
 *
 * Pure and **synchronous**, and it has to stay that way. An `async` conversion
 * hands back a Promise; a Promise has no own enumerable properties, so
 * `JSON.stringify` encodes it as `{}`; and the node is then asked to read `{}`
 * as a base58 address, which is how this journey was blocked
 * (`Invalid Base58 character '{' at position 0`). A caller must not be able to
 * obtain a value here that it could forget to await.
 */
export function scriptHashToAddress(value) {
  return base58checkEncode(normalizeScriptHash(value));
}

function describeValue(value) {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'undefined') return 'undefined';
  if (kind === 'function') return `a function (${value.name || 'anonymous'})`;
  if (kind === 'symbol') return `a symbol (${String(value)})`;
  if (kind === 'bigint') return `a bigint (${value})`;
  if (kind === 'object') {
    if (typeof value.then === 'function') return 'a thenable';
    try {
      const json = JSON.stringify(value);
      return `an object (${json === undefined ? Object.prototype.toString.call(value) : json})`;
    } catch {
      return 'an object';
    }
  }
  return `a ${kind} (${JSON.stringify(value)})`;
}

function isThenable(value) {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof value.then === 'function'
  );
}

/**
 * A JSON-RPC parameter list, refused unless every entry is a value the node can
 * read as itself.
 *
 * The whole class of defect this journey was blocked on is here: a thenable
 * survives `JSON.stringify` as `{}` and becomes a JSON object on the wire where
 * the node expects a string, a number or an array. Refusing it before the body
 * is built turns that into a harness failure with the call named, instead of a
 * parser complaint about a Base58 character that is really a brace.
 */
export function assertRpcParams(method, params) {
  const name = String(method ?? 'rpc');
  if (!Array.isArray(params)) {
    fail(`${name} needs a parameter list, received ${describeValue(params)}`);
  }
  for (const [index, value] of params.entries()) {
    if (isThenable(value)) {
      fail(
        `${name} parameter ${index} is a thenable; await it before the call, ` +
          `because a Promise encodes as "{}" on the wire`
      );
    }
    const kind = typeof value;
    if (value === undefined || kind === 'function' || kind === 'symbol' || kind === 'bigint') {
      fail(`${name} parameter ${index} is not a JSON value: ${describeValue(value)}`);
    }
  }
  return params;
}

/**
 * A Neo N3 address as the chain RPC reads one: a string, and a real base58check
 * address. Anything else is a refusal in this harness rather than a JSON object
 * or a bare digit on the wire.
 */
export function assertRpcAddress(value, name = 'address') {
  const field = String(name ?? 'address');
  if (typeof value !== 'string') {
    fail(`${field} must be a Neo address string, received ${describeValue(value)}`);
  }
  const text = value.trim();
  try {
    base58checkDecode(text);
  } catch (error) {
    fail(`${field} is not a Neo N3 address: ${error.message}`);
  }
  return text;
}

/**
 * The amount an account holds of one NEP-17 asset, from a `getnep17balances`
 * result.
 *
 * The node names the field `assethash` (and `lastupdatedblock`) — not
 * `asset_hash`. A reader keyed on the wrong name matches no row and reports
 * zero for every account, which looks like an unfunded sponsor and hides a real
 * charge, so the field name is pinned here and refused for anything else.
 */
export function nep17AssetAmount(result, assetHash) {
  const wanted = stripHexPrefix(assetHash);
  if (!/^[0-9a-f]{40}$/.test(wanted)) {
    fail(`a NEP-17 asset hash must be 20 bytes, received ${JSON.stringify(String(assetHash))}`);
  }
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    fail(`getnep17balances returned ${describeValue(result)}`);
  }
  if (!Array.isArray(result.balance)) {
    fail(`getnep17balances returned no balance array, received ${describeValue(result.balance)}`);
  }
  for (const row of result.balance) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      fail(`getnep17balances returned a balance row that is ${describeValue(row)}`);
    }
  }
  const entry = result.balance.find((row) => stripHexPrefix(row.assethash) === wanted);
  if (!entry) return 0n;
  const text = String(entry.amount ?? '');
  if (!/^\d+$/.test(text)) {
    fail(`a NEP-17 amount must be a non-negative integer string, received ${JSON.stringify(text)}`);
  }
  return BigInt(text);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest();
}

function ripemd160(bytes) {
  return createHash('ripemd160').update(bytes).digest();
}

// ---------------------------------------------------------------------------
// Wire encoding — mirrors crates/neo-os-core/src/n3_tx.rs
// ---------------------------------------------------------------------------

const OP_PUSHINT8 = 0x00;
const OP_PUSHINT16 = 0x01;
const OP_PUSHINT32 = 0x02;
const OP_PUSHINT64 = 0x03;
const OP_PUSHDATA1 = 0x0c;
const OP_PUSHDATA2 = 0x0d;
const OP_PUSHDATA4 = 0x0e;
const OP_PUSHNULL = 0x0b;
const OP_PUSHM1 = 0x0f;
const OP_PUSH0 = 0x10;
const OP_PUSH16 = 0x20;
/** `OP_PUSH0 .. OP_PUSH16`: the seventeen small integer opcodes. */
const SMALL_INT_MAX = OP_PUSH16 - OP_PUSH0;
const OP_PACK = 0xc0;
const OP_SYSCALL = 0x41;
const SYSTEM_CONTRACT_CALL = Buffer.from([0x62, 0x7d, 0x5b, 0x52]);
const CALL_FLAGS_ALL = 0x1f;
const WITNESS_SCOPE_CALLED_BY_ENTRY = 0x01;

/** Display order in, wire order out. The one place this repository reverses. */
export function hash160Wire(value) {
  const display = stripHexPrefix(value);
  if (!/^[0-9a-f]{40}$/.test(display)) {
    fail(
      `a Hash160 argument must be a 20-byte hex script hash, received ${JSON.stringify(String(value))}`
    );
  }
  return Buffer.from(display, 'hex').reverse();
}

function emitByteString(out, bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length < 0x100) {
    out.push(OP_PUSHDATA1, buffer.length);
  } else if (buffer.length < 0x1_0000) {
    out.push(OP_PUSHDATA2);
    out.push(...Buffer.from([buffer.length & 0xff, (buffer.length >> 8) & 0xff]));
  } else {
    out.push(OP_PUSHDATA4);
    out.push(...Buffer.from(new Uint32Array([buffer.length]).buffer));
  }
  out.push(...buffer);
}

/**
 * The smallest signed two's-complement little-endian form, rounded up to
 * {1,2,4,8} bytes: a width whose sign extension reproduces the value, which is
 * what `signed_le_twos` in the Rust encoder emits.
 */
function signedLeTwos(value) {
  const full = Buffer.from(
    BigInt.asUintN(64, BigInt(value)).toString(16).padStart(16, '0'),
    'hex'
  ).reverse();
  for (const width of [1, 2, 4, 8]) {
    const slice = full.subarray(0, width);
    let restored = 0n;
    for (let index = width - 1; index >= 0; index -= 1) {
      restored = (restored << 8n) + BigInt(slice[index]);
    }
    if ((slice[width - 1] & 0x80) !== 0) restored -= 1n << BigInt(8 * width);
    if (restored === BigInt(value)) return slice;
  }
  return full;
}

function emitInteger(out, value) {
  const big = BigInt(value);
  if (big >= -1n && big <= BigInt(SMALL_INT_MAX)) {
    out.push(big < 0n ? OP_PUSHM1 : OP_PUSH0 + Number(big));
    return;
  }
  const bytes = signedLeTwos(big);
  const opcode =
    bytes.length === 1
      ? OP_PUSHINT8
      : bytes.length === 2
        ? OP_PUSHINT16
        : bytes.length <= 4
          ? OP_PUSHINT32
          : OP_PUSHINT64;
  out.push(opcode, ...bytes);
}

function emitParam(out, param) {
  switch (param.type) {
    case 'string':
      emitByteString(out, Buffer.from(String(param.value), 'utf8'));
      return;
    case 'bytes':
      emitByteString(out, param.value);
      return;
    case 'hash160':
      emitByteString(out, hash160Wire(param.value));
      return;
    case 'int':
      emitInteger(out, param.value);
      return;
    case 'bool':
      out.push(param.value ? 0x08 : 0x09);
      return;
    case 'null':
      out.push(OP_PUSHNULL);
      return;
    case 'array':
      emitArray(out, param.value ?? []);
      return;
    default:
      fail(`unknown invocation argument type ${JSON.stringify(param.type)}`);
  }
}

function emitArray(out, items) {
  for (const item of [...items].reverse()) emitParam(out, item);
  emitInteger(out, items.length);
  out.push(OP_PACK);
}

/**
 * `sc.createScript({scriptHash, operation, args})`: the argument array, the call
 * flags, the method name, the contract hash in wire order, and the
 * `System.Contract.Call` syscall.
 */
export function encodeInvokeScript(contractDisplay, method, args = []) {
  if (typeof method !== 'string' || method.length === 0) {
    fail('an invocation needs a method name');
  }
  const out = [];
  emitArray(out, args);
  out.push(CALL_FLAGS_ALL);
  emitByteString(out, Buffer.from(method, 'utf8'));
  out.push(OP_PUSHDATA1, 20, ...hash160Wire(contractDisplay));
  out.push(OP_SYSCALL, ...SYSTEM_CONTRACT_CALL);
  return Uint8Array.from(out);
}

function pushVarUint(out, value) {
  if (value < 0xfd) {
    out.push(value);
  } else if (value <= 0xffff) {
    out.push(0xfd, value & 0xff, (value >> 8) & 0xff);
  } else {
    out.push(0xfe, value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
  }
}

/** `Transaction.serialize(false)`, the shape `parse_unsigned_tx` accepts. */
export function encodeUnsignedTx({
  nonce,
  systemFee,
  networkFee,
  validUntilBlock,
  signerDisplay,
  script,
}) {
  const scriptBytes = Buffer.isBuffer(script) ? script : Buffer.from(script);
  const out = [];
  out.push(0);
  out.push(...new Uint8Array(new Uint32Array([Number(nonce) >>> 0]).buffer));
  out.push(...new Uint8Array(new BigUint64Array([BigInt(systemFee)]).buffer));
  out.push(...new Uint8Array(new BigUint64Array([BigInt(networkFee)]).buffer));
  out.push(...new Uint8Array(new Uint32Array([Number(validUntilBlock) >>> 0]).buffer));
  out.push(1);
  out.push(...hash160Wire(signerDisplay));
  out.push(WITNESS_SCOPE_CALLED_BY_ENTRY);
  out.push(0);
  pushVarUint(out, scriptBytes.length);
  out.push(...scriptBytes);
  return Uint8Array.from(out);
}

/** The transaction hash in display form: `reverseHex(SHA256(unsigned))`. */
export function transactionHashDisplay(unsignedBytes) {
  const digest = sha256(Buffer.from(unsignedBytes));
  return `0x${Buffer.from(digest).reverse().toString('hex')}`;
}

/** `getMessageForSigning(magic)`: `magic_le32 || SHA256(unsigned)`. */
export function messageForSigning(unsignedBytes, magic) {
  return Buffer.concat([
    Buffer.from(new Uint32Array([Number(magic) >>> 0]).buffer),
    sha256(Buffer.from(unsignedBytes)),
  ]);
}

// ---------------------------------------------------------------------------
// The fake SIGN — the byte contract of workers/neo-signer/src/crypto.rs
// ---------------------------------------------------------------------------

function privateKeyObject(privateKeyHex) {
  const scalar = Buffer.from(stripHexPrefix(privateKeyHex), 'hex');
  if (scalar.length !== 32 || scalar.every((byte) => byte === 0)) {
    fail('the signing key must be a 32-byte P-256 scalar');
  }
  // SEC1 ECPrivateKey for prime256v1 without the optional public key.
  const der = Buffer.concat([
    Buffer.from('30310201010420', 'hex'),
    scalar,
    Buffer.from('a00a06082a8648ce3d030107', 'hex'),
  ]);
  return createPrivateKey({ key: der, format: 'der', type: 'sec1' });
}

/** The public identity a custody `GET /keys/:id` answers with. */
export function keyIdentity({ privateKeyHex }) {
  const privateKey = privateKeyObject(privateKeyHex);
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  const prefix = (y[y.length - 1] & 1) === 1 ? 0x03 : 0x02;
  const compressed = Buffer.concat([Buffer.from([prefix]), x]);
  const verificationScript = Buffer.concat([
    Buffer.from([0x0c, 33]),
    compressed,
    Buffer.from('4156e7b327', 'hex'),
  ]);
  // `hash160(verification_script)` is the account's wire-order script hash; the
  // identity a custody service publishes is its display order, which is what
  // `CustodySignerAdapter::verify_witness` compares the witness against.
  const wireHash = ripemd160(sha256(verificationScript));
  const displayHash = Buffer.from(wireHash).reverse();
  return {
    public_key: compressed.toString('hex'),
    script_hash: `0x${displayHash.toString('hex')}`,
    address: base58checkEncode(`0x${displayHash.toString('hex')}`),
    verification_script: verificationScript.toString('hex'),
    chain_family: 'neo-n3',
  };
}

/**
 * One single-signature witness. ECDSA-P256 over
 * `SHA256(magic_le32 || SHA256(unsigned_tx))`, low-S, `r||s`, with the 66-byte
 * invocation script and the 40-byte verification script of a single-sig account.
 */
export function signWitness({ privateKeyHex, unsignedBytes, magic, nonceSalt }) {
  const identity = keyIdentity({ privateKeyHex });
  const preimage = messageForSigning(unsignedBytes, magic);
  const privateKey = privateKeyObject(privateKeyHex);
  void nonceSalt;
  const signature = cryptoSign('sha256', preimage, {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  // Consensus rejects high-S signatures, so the harness must not mint one.
  const r = signature.subarray(0, 32);
  let s = BigInt(`0x${signature.subarray(32).toString('hex')}`);
  const halfOrder = P256_ORDER / 2n;
  if (s > halfOrder) s = P256_ORDER - s;
  const sBytes = Buffer.from(s.toString(16).padStart(64, '0'), 'hex');
  const normalized = Buffer.concat([r, sBytes]);
  return {
    signature: normalized.toString('hex'),
    invocation_script: `0c40${normalized.toString('hex')}`,
    verification_script: identity.verification_script,
    digest: sha256(preimage).toString('hex'),
  };
}

// ---------------------------------------------------------------------------
// Intent scripts
// ---------------------------------------------------------------------------

/**
 * The two script shapes CU-150 validates. Arguments are derived here from the
 * journey's own fixture values; the validator is the thing that decides whether
 * the resulting bytes are sponsorable at all.
 */
export function sponsorIntentScript(spec) {
  const method = String(spec.method);
  if (method === 'registerAccount') {
    return {
      reimbursementUnits: 0,
      script: encodeInvokeScript(spec.contract, 'registerAccount', [
        { type: 'hash160', value: spec.accountId },
        { type: 'hash160', value: spec.verifier },
        { type: 'bytes', value: Buffer.from(spec.verifierParams ?? '', 'hex') },
        { type: 'hash160', value: spec.hookId },
        { type: 'hash160', value: spec.backupOwner },
        { type: 'int', value: spec.escapeTimelock ?? 0 },
      ]),
    };
  }
  if (method !== 'executeSponsoredUserOp') {
    fail(`unknown sponsorable method ${JSON.stringify(method)}`);
  }
  const reimbursementUnits = Number(spec.reimbursementUnits);
  if (!Number.isInteger(reimbursementUnits) || reimbursementUnits <= 0) {
    fail(
      `the reimbursement amount must be a positive integer, received ${spec.reimbursementUnits}`
    );
  }
  const op = spec.op ?? {};
  return {
    reimbursementUnits,
    script: encodeInvokeScript(spec.contract, 'executeSponsoredUserOp', [
      { type: 'hash160', value: spec.accountId },
      {
        type: 'array',
        value: [
          { type: 'hash160', value: op.targetContract },
          { type: 'string', value: op.method },
          { type: 'array', value: op.args ?? [] },
          { type: 'int', value: op.nonce ?? 0 },
          { type: 'int', value: op.deadline ?? 0 },
          { type: 'bytes', value: Buffer.from(op.signature ?? []) },
        ],
      },
      { type: 'hash160', value: spec.paymaster },
      { type: 'hash160', value: spec.sponsor },
      { type: 'int', value: reimbursementUnits },
    ]),
  };
}

// ---------------------------------------------------------------------------
// The delivery store's local HTTP peer
// ---------------------------------------------------------------------------

/** The prefix every shipped delivery function carries in `public`. */
export const DELIVERY_FUNCTION_PREFIX = 'morpheus_delivery_';

const DELIVERY_RPCS = {
  sponsor_reserve: [
    ['p_network', 'text'],
    ['p_principal', 'uuid'],
    ['p_idempotency_key', 'text'],
    ['p_contract', 'text'],
    ['p_account', 'text'],
    ['p_intent', 'jsonb'],
    ['p_fee_ceiling_units', 'bigint'],
  ],
  claim: [
    ['p_network', 'text'],
    ['p_chain', 'text'],
    ['p_account', 'text'],
    ['p_owner', 'text'],
    ['p_lease_ms', 'bigint'],
    ['p_kinds', 'text[]'],
  ],
  transition: [
    ['p_job', 'text'],
    ['p_owner', 'text'],
    ['p_generation', 'bigint'],
    ['p_op', 'text'],
    ['p_data', 'jsonb'],
    ['p_lease_ms', 'bigint'],
  ],
  lookup: [['p_job', 'text']],
};

function sqlLiteral(type, value) {
  if (value === undefined || value === null) return 'null';
  switch (type) {
    case 'text':
      return `'${String(value).replace(/'/g, "''")}'`;
    case 'uuid':
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value))) {
        fail(`p_principal must be a UUID, received ${JSON.stringify(value)}`);
      }
      return `'${String(value)}'::uuid`;
    case 'bigint':
      if (!/^-?\d+$/.test(String(value))) {
        fail(`a bigint argument must be an integer, received ${JSON.stringify(value)}`);
      }
      return String(value);
    case 'jsonb':
      return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
    case 'text[]':
      if (!Array.isArray(value)) fail('a text[] argument must be an array');
      return `array[${value.map((item) => sqlLiteral('text', item)).join(',')}]`;
    default:
      return fail(`unknown SQL argument type ${type}`);
  }
}

/**
 * The only SQL the local delivery peer may issue: the shipped RPC, called by
 * name, as `service_role`. An unknown name or an unexpected field is a refusal
 * rather than an interpolation.
 *
 * PostgREST routes `POST /rest/v1/rpc/<sql function>`, so the relayer names
 * `morpheus_delivery_sponsor_reserve` rather than `sponsor_reserve`. Both spell
 * the same function; anything else is still a refusal.
 */
export function deliveryRpcSql(name, body = {}) {
  const posted = String(name ?? '');
  const bare = posted.startsWith(DELIVERY_FUNCTION_PREFIX)
    ? posted.slice(DELIVERY_FUNCTION_PREFIX.length)
    : posted;
  const signature = DELIVERY_RPCS[bare];
  if (!signature) fail(`unknown delivery RPC ${JSON.stringify(name)}`);
  const supplied = Object.keys(body);
  const expected = signature.map(([key]) => key);
  for (const key of supplied) {
    if (!expected.includes(key)) fail(`unexpected argument ${key} for ${bare}`);
  }
  for (const [key] of signature) {
    if (!(key in body) && !['p_kinds', 'p_data'].includes(key)) {
      fail(`missing argument ${key} for ${bare}`);
    }
  }
  const call = signature.map(([key, type]) => sqlLiteral(type, body[key])).join(',');
  return {
    name: bare,
    sql:
      `begin; set local role service_role; ` +
      `select public.${DELIVERY_FUNCTION_PREFIX}${bare}(${call}); commit;`,
  };
}

// ---------------------------------------------------------------------------
// Acceptance
// ---------------------------------------------------------------------------

function check(name, ok, failures, detail) {
  if (!ok) failures.push(`${name}: ${detail}`);
  return { name, ok: Boolean(ok) };
}

function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The single decision about whether this journey may report green. Every
 * dimension of the observation is required; a missing field is a failure, not an
 * unknown, and each dimension is a named test in
 * `lib-sponsor-lane-private-chain.test.mjs` that must fail when it is wrong.
 */
export function evaluateAcceptance(observed) {
  const failures = [];
  const response = observed?.response ?? null;
  const journal = observed?.journal ?? null;
  const balances = observed?.balances ?? null;
  const budgets = observed?.budgets ?? null;
  const exhaustion = observed?.exhaustion ?? null;
  const eligibility = observed?.eligibility ?? null;

  const responseOk =
    !!response &&
    response.code === 'SPONSOR_CONFIRMED' &&
    response.vm_state === 'HALT' &&
    typeof response.tx_hash === 'string' &&
    response.tx_hash.length > 0;
  const journalRecord = journal?.journal ?? {};
  const signed = journalRecord.signed ?? null;
  const receipt = journalRecord.receipt ?? null;
  const prepared = journalRecord.prepared ?? null;

  const sponsorDelta = asNumber(balances?.sponsorDelta);
  const recipientDelta = asNumber(balances?.recipientDelta);
  const reimbursementUnits = asNumber(balances?.reimbursementUnits);
  const feesCharged = asNumber(balances?.feesCharged);
  const declaredFeeUnits = asNumber(balances?.declaredFeeUnits);

  const checks = [
    check(
      'check/intent-paid-and-confirmed',
      responseOk && !!signed && response.tx_hash === signed.tx_hash,
      failures,
      `code=${response?.code} vm_state=${response?.vm_state} tx_hash=${response?.tx_hash} signed=${signed?.tx_hash}`
    ),
    check(
      'check/journal-id-returned',
      typeof response?.journal_id === 'string' &&
        response.journal_id.length > 0 &&
        response.journal_id === journal?.job_key,
      failures,
      `response=${response?.journal_id} job_key=${journal?.job_key}`
    ),
    check(
      'check/journal-receipt-matches-signed',
      !!receipt &&
        !!signed &&
        typeof receipt.tx_hash === 'string' &&
        receipt.tx_hash === signed.tx_hash &&
        receipt.vm_state === 'HALT',
      failures,
      `receipt=${JSON.stringify(receipt)} signed=${JSON.stringify(signed)}`
    ),
    check(
      'check/journal-holds-the-reserved-ceiling',
      !!prepared &&
        asNumber(prepared.fee_ceiling_units) === asNumber(budgets?.feeCeilingUnits) &&
        asNumber(budgets?.feeCeilingUnits) === SPONSOR_SCHEMA_MAX_FEE_CEILING_UNITS,
      failures,
      `prepared=${prepared?.fee_ceiling_units} configured=${budgets?.feeCeilingUnits}`
    ),
    check(
      'check/sponsor-charged',
      sponsorDelta !== null &&
        reimbursementUnits !== null &&
        feesCharged !== null &&
        feesCharged > 0 &&
        feesCharged <= (declaredFeeUnits ?? Number.POSITIVE_INFINITY) &&
        sponsorDelta === -(reimbursementUnits + feesCharged),
      failures,
      `sponsorDelta=${sponsorDelta} reimbursement=${reimbursementUnits} fees=${feesCharged} declared=${declaredFeeUnits}`
    ),
    check(
      'check/recipient-paid',
      recipientDelta !== null &&
        reimbursementUnits !== null &&
        reimbursementUnits > 0 &&
        recipientDelta === reimbursementUnits,
      failures,
      `recipientDelta=${recipientDelta} reimbursement=${reimbursementUnits}`
    ),
    check(
      'check/budget-debited',
      asNumber(budgets?.lifetimeDelta) === asNumber(budgets?.feeCeilingUnits) &&
        asNumber(budgets?.feeCeilingUnits) === SPONSOR_SCHEMA_MAX_FEE_CEILING_UNITS &&
        asNumber(budgets?.dailyDelta) === 1,
      failures,
      `lifetimeDelta=${budgets?.lifetimeDelta} dailyDelta=${budgets?.dailyDelta}`
    ),
    check(
      'check/budget-exhaustion-refused',
      exhaustion?.code === 'SPONSOR_BUDGET_EXHAUSTED',
      failures,
      `code=${exhaustion?.code}`
    ),
    check(
      'check/refusal-broadcast-nothing',
      asNumber(exhaustion?.journalRowsDelta) === 0 && asNumber(exhaustion?.chainTxCountDelta) === 0,
      failures,
      `journalRowsDelta=${exhaustion?.journalRowsDelta} chainTxCountDelta=${exhaustion?.chainTxCountDelta}`
    ),
    check(
      'check/ineligible-intent-refused',
      eligibility?.code === 'SPONSOR_REQUEST_INVALID' &&
        eligibility?.intent_code === 'SPONSOR_INTENT_WRONG_TARGET' &&
        asNumber(eligibility?.budgetDelta) === 0,
      failures,
      `code=${eligibility?.code} intent_code=${eligibility?.intent_code} budgetDelta=${eligibility?.budgetDelta}`
    ),
  ];

  return {
    ok: failures.length === 0 && checks.every((entry) => entry.ok),
    checks,
    failures,
  };
}

/**
 * The one deletion the journey is allowed to make. Refuses a root that could
 * ever be a home directory: the journey deletes its temporary tree on exit, and
 * that deletion must be impossible to aim at anything but a disposable scratch
 * directory.
 */
export function teardownRefusalRoot(root) {
  const target = String(root ?? '').trim();
  if (!target) return false;
  const normalized = target.replace(/\/+$/, '');
  const forbidden = ['/', '/Users', process.env.HOME ?? '/nonexistent-home-placeholder'];
  if (forbidden.some((entry) => normalized === entry.replace(/\/+$/, ''))) {
    fail(`refusing to plan a deletion of ${normalized}`);
  }
  if (!normalized.startsWith('/tmp/') && !normalized.startsWith('/private/tmp/')) {
    fail(`teardown root must be a disposable scratch directory, received ${normalized}`);
  }
  return true;
}

/** A throwaway 32-byte P-256 scalar for the disposable chain's accounts. */
export function throwawayPrivateKey() {
  for (;;) {
    const candidate = randomBytes(32);
    if (!candidate.every((byte) => byte === 0)) return candidate.toString('hex');
  }
}
