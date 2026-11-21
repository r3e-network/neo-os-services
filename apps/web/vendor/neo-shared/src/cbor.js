// Minimal, dependency-free CBOR / COSE_Sign1 decoder shared by the enclave server
// (which PRODUCES Nitro NSM attestation documents) and the relayer (which VERIFIES
// them). Keeping ONE decoder on both sides is a correctness requirement: previously
// each had its own copy that disagreed on indefinite-length CBOR (RFC 8949 §3.2) —
// the relayer threw `unsupported minor 31` (rejecting a legitimately-attested doc),
// while the enclave set length = -1 and silently produced EMPTY strings/arrays/maps.
// Either way an indefinite-length-encoded attestation was mis-handled. This module
// decodes both definite and indefinite lengths correctly so producer and verifier
// agree, and a shared fixture test pins that agreement.
//
// We decode just enough CBOR to read the COSE_Sign1 structure and the attestation
// payload map (pcrs, user_data, public_key, nonce) — no external CBOR/COSE library.

// Sentinel returned for the CBOR "break" stop code (0xff, major 7 / minor 31).
// It terminates an indefinite-length string/array/map. Not a valid data item, so
// it can never collide with a decoded value.
const BREAK = Symbol('cbor-break');

const DEFAULT_CBOR_LIMITS = Object.freeze({
  maxInputBytes: 1024 * 1024,
  maxDepth: 32,
  maxItems: 4096,
  maxStringBytes: 1024 * 1024,
});

/**
 * Decode a single CBOR data item starting at `offset`.
 * @param {Buffer} buf
 * @param {number} offset
 * @returns {{ value: unknown, pos: number }} decoded value and the position after it
 */
export function cborRead(buf, offset, options = {}) {
  if (!Buffer.isBuffer(buf)) throw new Error('cbor: input must be a Buffer');
  const limits = { ...DEFAULT_CBOR_LIMITS, ...options };
  if (buf.length > limits.maxInputBytes) throw new Error('cbor: input exceeds size limit');
  const state = { items: 0, stringBytes: 0 };

  const read = (itemOffset, depth) => {
    if (depth > limits.maxDepth) throw new Error('cbor: nesting depth exceeds limit');
    state.items += 1;
    if (state.items > limits.maxItems) throw new Error('cbor: item count exceeds limit');
    if (itemOffset >= buf.length) throw new Error('cbor: truncated');
    const initial = buf[itemOffset];
    const major = initial >> 5;
    const minor = initial & 0x1f;
    let pos = itemOffset + 1;
    const readUint = (n) => {
      let value = 0n;
      for (let i = 0; i < n; i += 1) {
        if (pos >= buf.length) throw new Error('cbor: truncated uint');
        value = (value << 8n) | BigInt(buf[pos]);
        pos += 1;
      }
      return value;
    };
    const boundedLength = (length, kind, maximum) => {
      if (length > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`cbor: ${kind} length is not safely representable`);
      }
      const numeric = Number(length);
      if (numeric > maximum) throw new Error(`cbor: ${kind} length exceeds limit`);
      return numeric;
    };

    let length = 0n;
    let indefinite = false;
    if (minor < 24) length = BigInt(minor);
    else if (minor === 24) length = readUint(1);
    else if (minor === 25) length = readUint(2);
    else if (minor === 26) length = readUint(4);
    else if (minor === 27) length = readUint(8);
    else if (minor === 31) indefinite = true;
    else throw new Error(`cbor: unsupported minor ${minor}`);

    switch (major) {
      case 0:
      case 1: {
        if (indefinite) throw new Error('cbor: indefinite length invalid for integer');
        const numeric = boundedLength(length, 'integer', Number.MAX_SAFE_INTEGER);
        return { value: major === 0 ? numeric : -1 - numeric, pos };
      }
      case 2:
      case 3: {
        if (indefinite) {
          const chunks = [];
          let joinedBytes = 0;
          for (;;) {
            const item = read(pos, depth + 1);
            pos = item.pos;
            if (item.value === BREAK) break;
            if (major === 2 && !Buffer.isBuffer(item.value)) {
              throw new Error('cbor: invalid byte-string chunk');
            }
            if (major === 3 && typeof item.value !== 'string') {
              throw new Error('cbor: invalid text-string chunk');
            }
            const chunk = Buffer.isBuffer(item.value)
              ? item.value
              : Buffer.from(item.value, 'utf8');
            joinedBytes += chunk.length;
            if (joinedBytes > limits.maxStringBytes) {
              throw new Error('cbor: string length exceeds limit');
            }
            chunks.push(chunk);
          }
          const joined = Buffer.concat(chunks, joinedBytes);
          return { value: major === 2 ? joined : joined.toString('utf8'), pos };
        }
        const len = boundedLength(length, 'string', limits.maxStringBytes);
        state.stringBytes += len;
        if (state.stringBytes > limits.maxStringBytes) {
          throw new Error('cbor: cumulative string bytes exceed limit');
        }
        if (pos + len > buf.length) throw new Error('cbor: truncated string');
        const slice = buf.subarray(pos, pos + len);
        pos += len;
        return { value: major === 2 ? Buffer.from(slice) : slice.toString('utf8'), pos };
      }
      case 4: {
        const arr = [];
        if (indefinite) {
          for (;;) {
            const item = read(pos, depth + 1);
            pos = item.pos;
            if (item.value === BREAK) break;
            arr.push(item.value);
            if (arr.length > limits.maxItems) throw new Error('cbor: array length exceeds limit');
          }
          return { value: arr, pos };
        }
        const len = boundedLength(length, 'array', limits.maxItems);
        for (let i = 0; i < len; i += 1) {
          const item = read(pos, depth + 1);
          if (item.value === BREAK) throw new Error('cbor: unexpected break in array');
          arr.push(item.value);
          pos = item.pos;
        }
        return { value: arr, pos };
      }
      case 5: {
        const map = {};
        const addPair = (allowBreak) => {
          const key = read(pos, depth + 1);
          pos = key.pos;
          if (key.value === BREAK) {
            if (!allowBreak) throw new Error('cbor: unexpected break in map');
            return false;
          }
          const val = read(pos, depth + 1);
          pos = val.pos;
          if (val.value === BREAK) throw new Error('cbor: unexpected break as map value');
          const keyName = Buffer.isBuffer(key.value)
            ? key.value.toString('hex')
            : String(key.value);
          Object.defineProperty(map, keyName, {
            value: val.value,
            enumerable: true,
            configurable: true,
            writable: true,
          });
          return true;
        };
        if (indefinite) {
          let pairs = 0;
          while (addPair(true)) {
            pairs += 1;
            if (pairs > limits.maxItems) throw new Error('cbor: map length exceeds limit');
          }
          return { value: map, pos };
        }
        const len = boundedLength(length, 'map', limits.maxItems);
        for (let i = 0; i < len; i += 1) addPair(false);
        return { value: map, pos };
      }
      case 6: {
        if (indefinite) throw new Error('cbor: indefinite length invalid for tag');
        const inner = read(pos, depth + 1);
        if (inner.value === BREAK) throw new Error('cbor: unexpected break after tag');
        return { value: inner.value, pos: inner.pos };
      }
      case 7:
        if (minor === 31) return { value: BREAK, pos };
        if (minor === 20) return { value: false, pos };
        if (minor === 21) return { value: true, pos };
        if (minor === 22) return { value: null, pos };
        if (minor === 23) return { value: undefined, pos };
        return { value: null, pos };
      default:
        throw new Error(`cbor: unsupported major ${major}`);
    }
  };

  return read(offset, 0);
}

/**
 * Decode a COSE_Sign1 buffer into its four elements plus the decoded payload map.
 * Used by the relayer, which needs the raw protected-header and payload byte strings
 * to reconstruct the Sig_structure for ES384 signature verification.
 * @param {Buffer} coseBuffer
 */
export function decodeCoseSign1(coseBuffer) {
  const { value: cose } = cborRead(coseBuffer, 0);
  if (!Array.isArray(cose) || cose.length !== 4) {
    throw new Error('cose: not a 4-element COSE_Sign1');
  }
  const [protectedHeaderBytes, , payloadBytes, signature] = cose;
  if (!Buffer.isBuffer(payloadBytes)) throw new Error('cose: payload is not a byte string');
  const { value: payload } = cborRead(payloadBytes, 0);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('cose: payload is not a map');
  }
  return {
    protectedHeaderBytes: Buffer.isBuffer(protectedHeaderBytes)
      ? protectedHeaderBytes
      : Buffer.alloc(0),
    payloadBytes,
    payload,
    signature: Buffer.isBuffer(signature) ? signature : Buffer.alloc(0),
  };
}

/**
 * Decode a COSE_Sign1 buffer and return only its payload map (attestation fields:
 * pcrs, user_data, public_key, nonce, ...). Used by the enclave server, which only
 * needs to read the committed fields.
 * @param {Buffer} coseBuffer
 */
export function decodeCoseSign1Payload(coseBuffer) {
  return decodeCoseSign1(coseBuffer).payload;
}
