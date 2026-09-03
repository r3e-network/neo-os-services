//! Minimal CBOR decoder (port of packages/shared/src/cbor.js).
//!
//! Decodes "just enough" CBOR to read the COSE_Sign1 structure and the
//! attestation payload map: definite AND indefinite lengths (RFC 8949 §3.2),
//! with the same limits and the same error strings as the JS oracle — the
//! golden vectors pin those messages. Notable behaviours carried over
//! deliberately:
//! - floats (major 7 minors 25/26/27) decode to `null`;
//! - simple values other than true/false/null/undefined decode to `null`;
//! - tags pass their inner value through unchanged;
//! - map keys: byte strings become their hex string, everything else its JS
//!   `String()` form; duplicate keys replace in place (first position kept);
//! - every recursion counts against the item/depth budgets, so a small input
//!   full of one-byte containers cannot blow the stack.

use crate::{CoreError, CoreResult};

pub const DEFAULT_MAX_INPUT_BYTES: usize = 1024 * 1024;
pub const DEFAULT_MAX_DEPTH: usize = 32;
pub const DEFAULT_MAX_ITEMS: usize = 4096;
pub const DEFAULT_MAX_STRING_BYTES: usize = 1024 * 1024;

/// JS safe-integer ceiling (2^53 - 1).
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy)]
pub struct CborLimits {
    pub max_input_bytes: usize,
    pub max_depth: usize,
    pub max_items: usize,
    pub max_string_bytes: usize,
}

impl Default for CborLimits {
    fn default() -> Self {
        CborLimits {
            max_input_bytes: DEFAULT_MAX_INPUT_BYTES,
            max_depth: DEFAULT_MAX_DEPTH,
            max_items: DEFAULT_MAX_ITEMS,
            max_string_bytes: DEFAULT_MAX_STRING_BYTES,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum CborValue {
    Null,
    Undefined,
    Bool(bool),
    /// Major 0/1 within JS safe-integer range.
    Int(i64),
    Bytes(Vec<u8>),
    Text(String),
    Array(Vec<CborValue>),
    /// Insertion-ordered; byte-string keys arrive hex-encoded.
    Map(Vec<(String, CborValue)>),
}

impl CborValue {
    /// `Buffer.isBuffer(value)` — only byte strings are buffers on the JS side.
    pub fn as_bytes(&self) -> Option<&[u8]> {
        match self {
            CborValue::Bytes(b) => Some(b),
            _ => None,
        }
    }

    pub fn as_map(&self) -> Option<&[(String, CborValue)]> {
        match self {
            CborValue::Map(entries) => Some(entries),
            _ => None,
        }
    }
}

/// Sentinel the JS code smuggles through the recursive reader to terminate
/// indefinite-length containers.
enum Item {
    Value(CborValue),
    Break,
}

struct Decoder<'a> {
    buf: &'a [u8],
    limits: CborLimits,
    items: usize,
    string_bytes: usize,
    /// Position after the most recently read item.
    pos: usize,
}

/// Decode a single CBOR data item starting at `offset` (port of `cborRead`).
/// Returns the decoded value and the position after it.
pub fn cbor_read(buf: &[u8], offset: usize) -> CoreResult<(CborValue, usize)> {
    cbor_read_with_limits(buf, offset, &CborLimits::default())
}

pub fn cbor_read_with_limits(
    buf: &[u8],
    offset: usize,
    limits: &CborLimits,
) -> CoreResult<(CborValue, usize)> {
    if buf.len() > limits.max_input_bytes {
        return Err(CoreError::new("cbor: input exceeds size limit"));
    }
    let mut decoder = Decoder {
        buf,
        limits: *limits,
        items: 0,
        string_bytes: 0,
        pos: offset,
    };
    match decoder.read(offset, 0)? {
        Item::Value(value) => Ok((value, decoder.pos)),
        Item::Break => Err(CoreError::new("cbor: unexpected top-level break")),
    }
}

impl Decoder<'_> {
    fn err(&self, msg: impl Into<String>) -> CoreError {
        CoreError::new(msg.into())
    }

    fn read_uint(&mut self, n: usize) -> CoreResult<u64> {
        let mut value: u64 = 0;
        for _ in 0..n {
            if self.pos >= self.buf.len() {
                return Err(self.err("cbor: truncated uint"));
            }
            value = (value << 8) | u64::from(self.buf[self.pos]);
            self.pos += 1;
        }
        Ok(value)
    }

    /// Reads one item starting at `item_offset`. On success `self.pos` is the
    /// position immediately after the item.
    fn read(&mut self, item_offset: usize, depth: usize) -> CoreResult<Item> {
        let limits = self.limits;
        if depth > limits.max_depth {
            return Err(self.err("cbor: nesting depth exceeds limit"));
        }
        self.items += 1;
        if self.items > limits.max_items {
            return Err(self.err("cbor: item count exceeds limit"));
        }
        if item_offset >= self.buf.len() {
            return Err(self.err("cbor: truncated"));
        }
        let initial = self.buf[item_offset];
        let major = initial >> 5;
        let minor = initial & 0x1f;
        self.pos = item_offset + 1;

        let mut length: u64 = 0;
        let mut indefinite = false;
        if minor < 24 {
            length = u64::from(minor);
        } else {
            match minor {
                24 => length = self.read_uint(1)?,
                25 => length = self.read_uint(2)?,
                26 => length = self.read_uint(4)?,
                27 => length = self.read_uint(8)?,
                31 => indefinite = true,
                other => return Err(self.err(format!("cbor: unsupported minor {other}"))),
            }
        }

        match major {
            0 | 1 => {
                if indefinite {
                    return Err(self.err("cbor: indefinite length invalid for integer"));
                }
                if length > MAX_SAFE_INTEGER {
                    return Err(self.err("cbor: integer length is not safely representable"));
                }
                let value = if major == 0 {
                    length as i64
                } else {
                    -1 - length as i64
                };
                Ok(Item::Value(CborValue::Int(value)))
            }
            2 | 3 => self.read_string(major, length, indefinite, depth),
            4 => self.read_array(length, indefinite, depth),
            5 => self.read_map(length, indefinite, depth),
            6 => {
                if indefinite {
                    return Err(self.err("cbor: indefinite length invalid for tag"));
                }
                match self.read(self.pos, depth + 1)? {
                    Item::Break => Err(self.err("cbor: unexpected break after tag")),
                    Item::Value(value) => Ok(Item::Value(value)),
                }
            }
            7 => match minor {
                31 => Ok(Item::Break),
                20 => Ok(Item::Value(CborValue::Bool(false))),
                21 => Ok(Item::Value(CborValue::Bool(true))),
                22 => Ok(Item::Value(CborValue::Null)),
                23 => Ok(Item::Value(CborValue::Undefined)),
                // "Decode just enough": floats and other simple values fall
                // back to null (length bytes already consumed for 24-27).
                _ => Ok(Item::Value(CborValue::Null)),
            },
            other => Err(self.err(format!("cbor: unsupported major {other}"))),
        }
    }

    fn read_string(
        &mut self,
        major: u8,
        length: u64,
        indefinite: bool,
        depth: usize,
    ) -> CoreResult<Item> {
        let limits = self.limits;
        if indefinite {
            let mut joined: Vec<u8> = Vec::new();
            loop {
                match self.read(self.pos, depth + 1)? {
                    Item::Break => break,
                    Item::Value(chunk) => {
                        let chunk_bytes = match (&chunk, major) {
                            (CborValue::Bytes(b), 2) => b.clone(),
                            (CborValue::Text(s), 3) => s.clone().into_bytes(),
                            _ => {
                                return Err(self.err(if major == 2 {
                                    "cbor: invalid byte-string chunk"
                                } else {
                                    "cbor: invalid text-string chunk"
                                }))
                            }
                        };
                        if joined.len() + chunk_bytes.len() > limits.max_string_bytes {
                            return Err(self.err("cbor: string length exceeds limit"));
                        }
                        joined.extend_from_slice(&chunk_bytes);
                    }
                }
            }
            if major == 2 {
                return Ok(Item::Value(CborValue::Bytes(joined)));
            }
            let text = String::from_utf8(joined)
                .map_err(|_| self.err("cbor: invalid utf8 in text string"))?;
            return Ok(Item::Value(CborValue::Text(text)));
        }

        let len = bounded(length, "string", limits.max_string_bytes)?;
        self.string_bytes += len;
        if self.string_bytes > limits.max_string_bytes {
            return Err(self.err("cbor: cumulative string bytes exceed limit"));
        }
        if self.pos + len > self.buf.len() {
            return Err(self.err("cbor: truncated string"));
        }
        let slice = &self.buf[self.pos..self.pos + len];
        self.pos += len;
        if major == 2 {
            Ok(Item::Value(CborValue::Bytes(slice.to_vec())))
        } else {
            let text = String::from_utf8(slice.to_vec())
                .map_err(|_| self.err("cbor: invalid utf8 in text string"))?;
            Ok(Item::Value(CborValue::Text(text)))
        }
    }

    fn read_array(&mut self, length: u64, indefinite: bool, depth: usize) -> CoreResult<Item> {
        let limits = self.limits;
        let mut arr: Vec<CborValue> = Vec::new();
        if indefinite {
            loop {
                match self.read(self.pos, depth + 1)? {
                    Item::Break => break,
                    Item::Value(value) => {
                        arr.push(value);
                        if arr.len() > limits.max_items {
                            return Err(self.err("cbor: array length exceeds limit"));
                        }
                    }
                }
            }
        } else {
            let len = bounded(length, "array", limits.max_items)?;
            for _ in 0..len {
                match self.read(self.pos, depth + 1)? {
                    Item::Break => return Err(self.err("cbor: unexpected break in array")),
                    Item::Value(value) => arr.push(value),
                }
            }
        }
        Ok(Item::Value(CborValue::Array(arr)))
    }

    fn read_map(&mut self, length: u64, indefinite: bool, depth: usize) -> CoreResult<Item> {
        let limits = self.limits;
        let mut map: Vec<(String, CborValue)> = Vec::new();
        if indefinite {
            let mut pairs = 0usize;
            while self.add_pair(depth, &mut map, true)? {
                pairs += 1;
                if pairs > limits.max_items {
                    return Err(self.err("cbor: map length exceeds limit"));
                }
            }
        } else {
            let len = bounded(length, "map", limits.max_items)?;
            for _ in 0..len {
                self.add_pair(depth, &mut map, false)?;
            }
        }
        Ok(Item::Value(CborValue::Map(map)))
    }

    /// Reads one key/value pair into `map`. Returns `Ok(false)` when a BREAK
    /// key was consumed and `allow_break` permits it.
    fn add_pair(
        &mut self,
        depth: usize,
        map: &mut Vec<(String, CborValue)>,
        allow_break: bool,
    ) -> CoreResult<bool> {
        let key = match self.read(self.pos, depth + 1)? {
            Item::Break => {
                if allow_break {
                    return Ok(false);
                }
                return Err(self.err("cbor: unexpected break in map"));
            }
            Item::Value(key) => key,
        };
        let value = match self.read(self.pos, depth + 1)? {
            Item::Break => return Err(self.err("cbor: unexpected break as map value")),
            Item::Value(value) => value,
        };
        let key_name = match key {
            CborValue::Bytes(b) => crate::hex_encode(&b),
            CborValue::Text(s) => s,
            CborValue::Int(i) => i.to_string(),
            CborValue::Bool(true) => "true".to_string(),
            CborValue::Bool(false) => "false".to_string(),
            CborValue::Null => "null".to_string(),
            CborValue::Undefined => "undefined".to_string(),
            // JS String() would join arrays with commas; fail closed rather
            // than approximate it.
            CborValue::Array(_) | CborValue::Map(_) => {
                return Err(self.err("cbor: unsupported map key type"))
            }
        };
        // Object.defineProperty replaces the value but keeps the first
        // insertion position.
        if let Some(slot) = map.iter_mut().find(|(k, _)| *k == key_name) {
            slot.1 = value;
        } else {
            map.push((key_name, value));
        }
        Ok(true)
    }
}

fn bounded(length: u64, kind: &str, maximum: usize) -> CoreResult<usize> {
    if length > MAX_SAFE_INTEGER {
        return Err(CoreError::new(format!(
            "cbor: {kind} length is not safely representable"
        )));
    }
    if length > maximum as u64 {
        return Err(CoreError::new(format!("cbor: {kind} length exceeds limit")));
    }
    Ok(length as usize)
}

#[derive(Debug, Clone)]
pub struct CoseSign1 {
    pub protected_header_bytes: Vec<u8>,
    pub payload_bytes: Vec<u8>,
    pub payload: CborValue,
    pub signature: Vec<u8>,
}

/// Decode a COSE_Sign1 into its four elements plus the decoded payload map
/// (port of `decodeCoseSign1`). The relayer needs the RAW protected-header and
/// payload byte strings to rebuild the Sig_structure for ES384 verification.
pub fn decode_cose_sign1(buf: &[u8]) -> CoreResult<CoseSign1> {
    let (value, _) = cbor_read(buf, 0)?;
    let items = match &value {
        CborValue::Array(items) if items.len() == 4 => items,
        _ => return Err(CoreError::new("cose: not a 4-element COSE_Sign1")),
    };
    let CborValue::Bytes(payload_bytes) = &items[2] else {
        return Err(CoreError::new("cose: payload is not a byte string"));
    };
    let (payload, _) = cbor_read(payload_bytes, 0)?;
    if !matches!(payload, CborValue::Map(_)) {
        return Err(CoreError::new("cose: payload is not a map"));
    }
    let protected_header_bytes = match &items[0] {
        CborValue::Bytes(b) => b.clone(),
        _ => Vec::new(),
    };
    let signature = match &items[3] {
        CborValue::Bytes(b) => b.clone(),
        _ => Vec::new(),
    };
    Ok(CoseSign1 {
        protected_header_bytes,
        payload_bytes: payload_bytes.clone(),
        payload,
        signature,
    })
}

/// Decode a COSE_Sign1 and return only its payload map (port of
/// `decodeCoseSign1Payload`).
pub fn decode_cose_sign1_payload(buf: &[u8]) -> CoreResult<CborValue> {
    decode_cose_sign1(buf).map(|decoded| decoded.payload)
}
