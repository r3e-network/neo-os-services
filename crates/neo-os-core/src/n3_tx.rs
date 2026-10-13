//! Pure Neo N3 wire encoding for the enclave's feed lane: the invocation
//! script (`sc.createScript`), the unsigned-transaction serialization, and the
//! `getMessageForSigning` preimage. Every rule here is pinned two ways: read
//! from the repo's own neon-js (`node_modules/@cityofzion/neon-core`) and
//! byte-checked against golden vectors harvested from that same library.
//!
//! Two quirks a reader must not "fix":
//! * [`ContractParam::Base64Bytes`] mirrors `ContractParam.byteArray(string)`,
//!   which BASE64-decodes its string argument (`HexString.fromBase64`) — not
//!   hex-decodes. The feed's attestation hashes are 32-hex-char strings, so
//!   they ride the wire as 24 base64-decoded bytes, exactly as the deployed
//!   feed-pusher and enclave-server both emit them.
//! * Integers emit the smallest SIGNED two's-complement little-endian form
//!   rounded up to {1,2,4,8,16,32} bytes (255 becomes `ff 00`, not `ff`),
//!   with single-byte PUSH<n> opcodes for -1..=16.
//!
//! T03 extensions (fulfillment/automation/fee-top-up lanes), pinned by
//! `tests/vectors/n3_extension.json` the same way:
//! * [`ContractParam::HexBytes`] mirrors `ContractParam.byteArray(
//!   HexString.fromHex(hex, true))` — the hex-decoded bytes VERBATIM (the
//!   little-endian constructor and the emitter's reversal cancel).
//! * [`ContractParam::Hash160`] mirrors `ContractParam.hash160(value)` — the
//!   20-byte script hash REVERSED on the wire, whether the input is a
//!   base58check address or a (big-endian, optionally 0x-prefixed) hex string.
//! * [`ContractParam::Boolean`] emits PUSHT (`08`) / PUSHF (`09`);
//!   [`ContractParam::Any`] emits PUSHNULL (`0b`).
//! * Byte strings longer than 255 bytes switch to PUSHDATA2 (`0d`, u16 LE) —
//!   the fulfillRequest script with a payload-sized result crosses that.
//! * [`Witness`] + [`FeedTx::serialize_signed`] is `Transaction.serialize(true)`
//!   (witnesses appended after the script); [`FeedTx::hash_display`] is the
//!   `0x`-prefixed display hash every confirmation poll keys on.

use sha2::{Digest, Sha256};

/// The contract-argument shapes the relayer's N3 lanes need, in the neon-js
/// emission order the deployed contracts expect.
pub enum ContractParam {
    /// UTF-8 string, PUSHDATA-emitted in natural byte order.
    String(String),
    /// Emit via the signed minimal-LE integer encoding above.
    Integer(i64),
    /// A string `ContractParam.byteArray` would receive: BASE64-decoded at
    /// emission (see the module doc).
    Base64Bytes(String),
    /// A hex string `ContractParam.byteArray(HexString.fromHex(hex, true))`
    /// would receive: hex-DECODED at emission, bytes verbatim (no reversal).
    HexBytes(String),
    /// `ContractParam.hash160(value)`: a base58check address or a (big-endian,
    /// optionally 0x-prefixed) 20-byte hex string — emitted little-endian.
    Hash160(String),
    /// `ContractParam.boolean` — PUSHT / PUSHF.
    Boolean(bool),
    /// `ContractParam.any(null)` — PUSHNULL.
    Any,
    /// VM array: elements emitted last-to-first, then the count, then PACK.
    Array(Vec<ContractParam>),
}

const OP_PUSHINT8: u8 = 0x00;
const OP_PUSHINT16: u8 = 0x01;
const OP_PUSHINT32: u8 = 0x02;
const OP_PUSHINT64: u8 = 0x03;
// 0x04 and 0x05 are PUSHINT128 and PUSHINT256: wider integer pushes the encoder
// never emits but a wallet may. The decoder accepts the whole 0x00..=0x05 range.
const OP_PUSHINT256: u8 = 0x05;
const OP_PUSHDATA1: u8 = 0x0c;
const OP_PUSHDATA2: u8 = 0x0d;
const OP_PUSHDATA4: u8 = 0x0e;
const OP_PUSHT: u8 = 0x08;
const OP_PUSHF: u8 = 0x09;
/// PUSHNULL — `ContractParam.any(null)`.
const OP_PUSHNULL: u8 = 0x0b;
const OP_PUSHM1: u8 = 0x0f;
const OP_PUSH0: u8 = 0x10;
const OP_PUSH16: u8 = 0x20;
const OP_PACK: u8 = 0xc0;
const OP_SYSCALL: u8 = 0x41;
/// Length of a `UInt160` in wire order.
pub const HASH160_LEN: usize = 20;
/// `InteropServiceCode.SYSTEM_CONTRACT_CALL` (`System.Contract.Call`).
const SYSTEM_CONTRACT_CALL: [u8; 4] = [0x62, 0x7d, 0x5b, 0x52];
/// `CallFlags.All` — `createScript`'s default — pushed via PUSH16.
const CALL_FLAGS_ALL: u8 = 0x1f;
/// `WitnessScope.CalledByEntry`.
pub const WITNESS_SCOPE_CALLED_BY_ENTRY: u8 = 0x01;

/// Why a script/tx could not be encoded. neon-js throws on the same inputs
/// (bad hex, a Hash160 that is neither 20-byte hex nor a valid address), so
/// the error is parity, not politeness.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct N3EncodeError(pub String);

impl std::fmt::Display for N3EncodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for N3EncodeError {}

/// `sc.createScript({scriptHash, operation, args})`: args packed as one VM
/// array, then the call flags, the operation string, the script hash (stored
/// little-endian on the wire), and the `System.Contract.Call` syscall.
pub fn create_invoke_script(
    script_hash: &[u8; 20],
    operation: &str,
    args: &[ContractParam],
) -> Result<Vec<u8>, N3EncodeError> {
    let mut out = Vec::new();
    emit_array(&mut out, args)?;
    out.push(CALL_FLAGS_ALL);
    emit_string(&mut out, operation);
    out.push(OP_PUSHDATA1);
    out.push(20);
    out.extend(script_hash.iter().rev());
    out.push(OP_SYSCALL);
    out.extend_from_slice(&SYSTEM_CONTRACT_CALL);
    Ok(out)
}

fn emit_array(out: &mut Vec<u8>, items: &[ContractParam]) -> Result<(), N3EncodeError> {
    for item in items.iter().rev() {
        emit_param(out, item)?;
    }
    emit_integer(out, items.len() as i64);
    out.push(OP_PACK);
    Ok(())
}

fn emit_param(out: &mut Vec<u8>, param: &ContractParam) -> Result<(), N3EncodeError> {
    match param {
        ContractParam::String(value) => emit_string(out, value),
        ContractParam::Integer(value) => emit_integer(out, *value),
        ContractParam::Base64Bytes(value) => {
            let bytes = crate::base64::decode_lenient(value);
            emit_byte_string(out, &bytes);
        }
        ContractParam::HexBytes(value) => {
            let bytes = decode_hex_strict(value)
                .ok_or_else(|| N3EncodeError(format!("invalid hex string: {value:?}")))?;
            emit_byte_string(out, &bytes);
        }
        ContractParam::Hash160(value) => {
            let bytes = hash160_param_bytes(value)
                .ok_or_else(|| N3EncodeError(format!("invalid Hash160: {value:?}")))?;
            // hash160_param_bytes yields the little-endian wire form directly.
            emit_byte_string(out, &bytes);
        }
        ContractParam::Boolean(value) => out.push(if *value { OP_PUSHT } else { OP_PUSHF }),
        ContractParam::Any => out.push(OP_PUSHNULL),
        ContractParam::Array(items) => emit_array(out, items)?,
    }
    Ok(())
}

fn emit_string(out: &mut Vec<u8>, value: &str) {
    emit_byte_string(out, value.as_bytes());
}

/// neon-js `emitPushData`: <0x100 → PUSHDATA1, <0x10000 → PUSHDATA2 (u16 LE),
/// otherwise PUSHDATA4 (u32 LE). The fulfillRequest script crosses 255 bytes
/// as soon as the result payload grows past ~180 bytes, so PUSHDATA2 is the
/// common case for that lane.
fn emit_byte_string(out: &mut Vec<u8>, bytes: &[u8]) {
    if bytes.len() < 0x100 {
        out.push(OP_PUSHDATA1);
        out.push(bytes.len() as u8);
    } else if bytes.len() < 0x1_0000 {
        out.push(OP_PUSHDATA2);
        out.extend_from_slice(&(bytes.len() as u16).to_le_bytes());
    } else {
        out.push(OP_PUSHDATA4);
        out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    }
    out.extend_from_slice(bytes);
}

/// `-1..=16` push as single opcodes; everything else as the smallest signed
/// two's-complement LE form rounded to {1,2,4,8} bytes (a `ContractParam`
/// integer beyond 8 bytes cannot occur in the feed domain and is truncated
/// here to the 8-byte form rather than panicking).
fn emit_integer(out: &mut Vec<u8>, value: i64) {
    if (-1..=16).contains(&value) {
        if value < 0 {
            out.push(OP_PUSHM1);
        } else {
            out.push(OP_PUSH0 + value as u8);
        }
        return;
    }
    let bytes = signed_le_twos(value);
    let opcode = match bytes.len() {
        1 => OP_PUSHINT8,
        2 => OP_PUSHINT16,
        3 | 4 => OP_PUSHINT32,
        _ => OP_PUSHINT64,
    };
    out.push(opcode);
    out.extend_from_slice(&bytes);
}

/// Smallest signed two's-complement LE byte form, padded to its size class.
/// 255 needs two bytes (`ff 00`) because a lone `ff` reads as -1 — pinned by
/// the `int_255` golden vector.
fn signed_le_twos(value: i64) -> Vec<u8> {
    let width = if (-0x80i64..0x80).contains(&value) {
        1
    } else if (-0x8000i64..0x8000).contains(&value) {
        2
    } else if (-0x8000_0000i64..0x8000_0000).contains(&value) {
        4
    } else {
        8
    };
    value.to_le_bytes()[..width].to_vec()
}

/// Why an invocation script could not be reduced to one contract call.
///
/// Every variant means *no description of this script*, which is the only safe
/// answer to hand a policy that must decide on what a transaction will do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum N3DecodeError {
    /// The script contained no `System.Contract.Call`.
    NoCall,
    /// More than one call, or stack items left over once the call was popped, so
    /// the script does more (or claims more) than one call describes.
    NotOneCall,
    /// The script ended in the middle of an operand.
    Truncated,
    /// An opcode outside the push/pack/syscall subset appeared. A script that
    /// jumps or computes a hash at run time cannot be reduced to fixed facts.
    UnsupportedOpcode(u8),
    /// A `SYSCALL` was not `System.Contract.Call`.
    UnsupportedSyscall([u8; 4]),
    /// A `System.Contract.Call` did not pop `(args, flags, method, contract)`.
    MalformedCall,
}

impl std::fmt::Display for N3DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoCall => f.write_str("script performs no contract call"),
            Self::NotOneCall => f.write_str("script does not perform exactly one contract call"),
            Self::Truncated => f.write_str("script ends in the middle of an operand"),
            Self::UnsupportedOpcode(opcode) => {
                write!(f, "unsupported opcode 0x{opcode:02x}")
            }
            Self::UnsupportedSyscall(interop) => {
                write!(f, "unsupported syscall {:02x?}", interop)
            }
            Self::MalformedCall => {
                f.write_str("contract call does not pop args, flags, method, contract")
            }
        }
    }
}

impl std::error::Error for N3DecodeError {}

/// One `System.Contract.Call` decoded out of an invocation script.
///
/// The inverse of [`create_invoke_script`]: `contract` is in **display order**,
/// the order that function takes, so a decoded target compares directly against
/// an `0x…` 40-hex hash. Argument byte strings are the raw wire bytes, so a
/// `Hash160` argument still has to be reversed before it is compared in display
/// order — the same split `hash160_param_bytes` makes on the way in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvokeCall {
    /// Target contract in display order.
    pub contract: [u8; 20],
    /// Method name as pushed.
    pub method: String,
    /// `CallFlags` value as pushed.
    pub call_flags: u8,
    /// Method arguments in declared order.
    pub args: Vec<InvokeArg>,
}

/// A stack item produced by the subset of the VM an invocation script uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InvokeArg {
    /// `PUSHNULL`.
    Null,
    /// `PUSHT` / `PUSHF`.
    Bool(bool),
    /// A little-endian two's-complement integer, exactly as pushed.
    Integer(Vec<u8>),
    /// A `PUSHDATA*` byte string.
    ByteString(Vec<u8>),
    /// A `PACK`ed array, in declared order.
    Array(Vec<InvokeArg>),
}

impl InvokeArg {
    /// The item as a signed integer, if it is integer-shaped and fits in 128
    /// bits. Short pushes are sign-extended from their own top byte.
    pub fn as_i128(&self) -> Option<i128> {
        let bytes = match self {
            Self::Integer(bytes) => bytes.as_slice(),
            _ => return None,
        };
        if bytes.is_empty() || bytes.len() > 16 {
            return None;
        }
        let mut buf = [0u8; 16];
        let sign = if bytes[bytes.len() - 1] & 0x80 != 0 {
            0xff
        } else {
            0x00
        };
        buf[..bytes.len()].copy_from_slice(bytes);
        for slot in &mut buf[bytes.len()..] {
            *slot = sign;
        }
        Some(i128::from_le_bytes(buf))
    }

    pub fn as_bytes(&self) -> Option<&[u8]> {
        match self {
            Self::ByteString(bytes) => Some(bytes),
            _ => None,
        }
    }

    pub fn as_items(&self) -> Option<&[InvokeArg]> {
        match self {
            Self::Array(items) => Some(items.as_slice()),
            _ => None,
        }
    }

    /// A byte string that decodes as UTF-8.
    pub fn as_text(&self) -> Option<String> {
        let bytes = self.as_bytes()?;
        String::from_utf8(bytes.to_vec()).ok()
    }

    pub fn is_integer(&self) -> bool {
        matches!(self, Self::Integer(_))
    }

    /// Whether this integer is strictly negative. The sign bit of a
    /// little-endian two's-complement word is the top bit of its last byte.
    pub fn is_negative_integer(&self) -> bool {
        match self {
            Self::Integer(bytes) => match bytes.last() {
                Some(top) => top & 0x80 != 0,
                None => false,
            },
            _ => false,
        }
    }

    /// The item as a non-negative `u64`, if it is one. `None` covers a negative
    /// value and a value wider than 64 bits; the caller decides which of those
    /// is a shape failure and which is an amount no ceiling can hold.
    pub fn as_non_negative_u64(&self) -> Option<u64> {
        let bytes = match self {
            Self::Integer(bytes) => bytes.as_slice(),
            _ => return None,
        };
        if self.is_negative_integer() {
            return None;
        }
        let mut width = bytes.len();
        while width > 0 && bytes[width - 1] == 0 {
            width -= 1;
        }
        if width > 8 {
            return None;
        }
        let mut value: u64 = 0;
        for (index, byte) in bytes[..width].iter().enumerate() {
            value |= u64::from(*byte) << (8 * index);
        }
        Some(value)
    }

    /// `IsUnsignedIntegerWithinBytes` from
    /// `neo-os-aa/contracts/UnifiedSmartWallet.Execution.cs`: the value must be
    /// non-negative and its minimal signed little-endian form, with one trailing
    /// sign byte trimmed, must fit in `max_bytes`.
    pub fn is_unsigned_within(&self, max_bytes: usize) -> bool {
        let bytes = match self {
            Self::Integer(bytes) => bytes.as_slice(),
            _ => return false,
        };
        if self.is_negative_integer() {
            return false;
        }
        let mut width = bytes.len();
        while width > 0 && bytes[width - 1] == 0 {
            width -= 1;
        }
        width <= max_bytes
    }
}

/// Decode exactly one `System.Contract.Call` out of an invocation script —
/// the inverse of [`create_invoke_script`], and the same push/pack/syscall
/// subset `workers/neo-signer/src/tx.rs` accepts for a whole transaction.
///
/// Anything else is refused: a script that jumps, calls another function, or
/// derives a hash at run time cannot be reduced to a fixed list of facts, and
/// acting on it would mean trusting the caller's description of it.
pub fn decode_invoke_call(script: &[u8]) -> Result<InvokeCall, N3DecodeError> {
    let mut cursor = DecodeCursor::new(script);
    let mut stack: Vec<InvokeArg> = Vec::new();
    let mut call: Option<InvokeCall> = None;
    while cursor.remaining() > 0 {
        let opcode = cursor.u8()?;
        match opcode {
            OP_PUSHINT8..=OP_PUSHINT256 => {
                let width = 1usize << (opcode - OP_PUSHINT8);
                stack.push(InvokeArg::Integer(cursor.bytes(width)?.to_vec()));
            }
            OP_PUSHT | OP_PUSHF => stack.push(InvokeArg::Bool(opcode == OP_PUSHT)),
            OP_PUSHNULL => stack.push(InvokeArg::Null),
            OP_PUSHDATA1..=OP_PUSHDATA4 => {
                let width = 1usize << (opcode - OP_PUSHDATA1);
                let length = cursor.le_usize(width)?;
                stack.push(InvokeArg::ByteString(cursor.bytes(length)?.to_vec()));
            }
            OP_PUSHM1 => stack.push(InvokeArg::Integer(vec![0xff])),
            OP_PUSH0..=OP_PUSH16 => stack.push(InvokeArg::Integer(vec![opcode - OP_PUSH0])),
            OP_PACK => {
                let count = stack
                    .pop()
                    .and_then(|item| item.as_i128())
                    .ok_or(N3DecodeError::MalformedCall)?;
                if !(0..=MAX_PACK_ITEMS).contains(&count) || count as usize > stack.len() {
                    return Err(N3DecodeError::MalformedCall);
                }
                let start = stack.len() - count as usize;
                // `PACK` pops and appends, so array index 0 is the item on top
                // of the stack — the reverse of `split_off`'s push order. Without
                // this reversal a two-argument call would be read with its
                // arguments swapped.
                let mut items = stack.split_off(start);
                items.reverse();
                stack.push(InvokeArg::Array(items));
            }
            OP_SYSCALL => {
                let mut interop = [0u8; 4];
                interop.copy_from_slice(cursor.bytes(4)?);
                if interop != SYSTEM_CONTRACT_CALL {
                    return Err(N3DecodeError::UnsupportedSyscall(interop));
                }
                if call.is_some() {
                    return Err(N3DecodeError::NotOneCall);
                }
                call = Some(pop_invoke_call(&mut stack)?);
            }
            other => return Err(N3DecodeError::UnsupportedOpcode(other)),
        }
    }
    let call = call.ok_or(N3DecodeError::NoCall)?;
    // Every push the script made must have been consumed by that one call.
    // Leftover items mean the script is not fully described by it.
    if !stack.is_empty() {
        return Err(N3DecodeError::NotOneCall);
    }
    Ok(call)
}

/// Pop `(args, flags, method, contract)` for one syscall. The script pushes the
/// args array first and the contract hash last, so the contract is on top. The
/// contract comes back in display order.
fn pop_invoke_call(stack: &mut Vec<InvokeArg>) -> Result<InvokeCall, N3DecodeError> {
    let mut wire = stack
        .pop()
        .and_then(|item| item.as_bytes().map(|bytes| bytes.to_vec()))
        .filter(|bytes| bytes.len() == HASH160_LEN)
        .ok_or(N3DecodeError::MalformedCall)?;
    wire.reverse();
    let mut contract = [0u8; HASH160_LEN];
    contract.copy_from_slice(&wire);

    let method = stack
        .pop()
        .and_then(|item| item.as_text())
        .ok_or(N3DecodeError::MalformedCall)?;
    let flags = stack
        .pop()
        .and_then(|item| item.as_i128())
        .and_then(|flags| u8::try_from(flags).ok())
        .ok_or(N3DecodeError::MalformedCall)?;
    let args = match stack.pop().ok_or(N3DecodeError::MalformedCall)? {
        InvokeArg::Array(items) => items,
        _ => return Err(N3DecodeError::MalformedCall),
    };
    Ok(InvokeCall {
        contract,
        method,
        call_flags: flags,
        args,
    })
}

/// Bound on `PACK` so a malformed script cannot make us allocate on its word.
/// Matches `workers/neo-signer/src/tx.rs`.
const MAX_PACK_ITEMS: i128 = 1_024;

/// A bounds-checked cursor. Every read is checked against the *remaining input*
/// before anything is allocated, so a hostile length prefix costs a comparison
/// rather than a huge reservation.
struct DecodeCursor<'a> {
    data: &'a [u8],
    offset: usize,
}

impl<'a> DecodeCursor<'a> {
    fn new(data: &'a [u8]) -> Self {
        DecodeCursor { data, offset: 0 }
    }

    fn remaining(&self) -> usize {
        self.data.len() - self.offset
    }

    fn bytes(&mut self, length: usize) -> Result<&'a [u8], N3DecodeError> {
        let end = self
            .offset
            .checked_add(length)
            .filter(|end| *end <= self.data.len())
            .ok_or(N3DecodeError::Truncated)?;
        let slice = &self.data[self.offset..end];
        self.offset = end;
        Ok(slice)
    }

    fn u8(&mut self) -> Result<u8, N3DecodeError> {
        Ok(self.bytes(1)?[0])
    }

    /// Read a length written as `width` little-endian bytes.
    fn le_usize(&mut self, width: usize) -> Result<usize, N3DecodeError> {
        let bytes = self.bytes(width)?;
        let mut value: u64 = 0;
        for (index, byte) in bytes.iter().enumerate() {
            value |= u64::from(*byte) << (8 * index);
        }
        usize::try_from(value).map_err(|_| N3DecodeError::Truncated)
    }
}

/// A signature witness: the push-a-signature invocation script and the
/// verification script the custody service pins (`0c21 <33B pubkey>
/// 4156e7b327` for a single-sig key).
pub struct Witness {
    pub invocation_script: Vec<u8>,
    pub verification_script: Vec<u8>,
}

/// One signer: the account (display script hash, serialized little-endian)
/// with the `CalledByEntry` scope. The relayer never carries the wider scope
/// shapes, so only the two fixed fields serialize.
pub struct FeedSigner {
    /// Display (big-endian) script hash of the signing account.
    pub script_hash: [u8; 20],
}

/// The unsigned-transaction fields the relayer's tx builder fills. Version
/// is fixed 0 (neon-js refuses to serialize anything else).
pub struct FeedTx<'a> {
    pub nonce: u32,
    pub valid_until_block: u32,
    pub system_fee: u64,
    pub network_fee: u64,
    pub signer: FeedSigner,
    pub script: &'a [u8],
}

impl FeedTx<'_> {
    /// `Transaction.serialize(false)`: version || nonce || systemFee ||
    /// networkFee || validUntilBlock || signers || attributes || script —
    /// fees as u64 LE (neon-js `toReverseHex().padEnd(16, "0")`), the account
    /// little-endian, no attributes, no witnesses.
    pub fn serialize_unsigned(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.push(0u8);
        out.extend_from_slice(&self.nonce.to_le_bytes());
        out.extend_from_slice(&self.system_fee.to_le_bytes());
        out.extend_from_slice(&self.network_fee.to_le_bytes());
        out.extend_from_slice(&self.valid_until_block.to_le_bytes());
        // serializeArrayOf(signers): one signer, no allowed contracts/groups.
        out.push(1);
        out.extend_from_slice(
            &self
                .signer
                .script_hash
                .iter()
                .rev()
                .copied()
                .collect::<Vec<u8>>(),
        );
        out.push(WITNESS_SCOPE_CALLED_BY_ENTRY);
        // serializeArrayOf(attributes): zero attributes.
        out.push(0);
        push_varuint(&mut out, self.script.len());
        out.extend_from_slice(self.script);
        out
    }

    /// `Transaction.serialize(true)`: the unsigned serialization followed by
    /// the witnesses array (count, then per witness: invocation and
    /// verification scripts as varuint-length byte strings).
    pub fn serialize_signed(&self, witnesses: &[Witness]) -> Vec<u8> {
        let mut out = self.serialize_unsigned();
        out.push(witnesses.len() as u8);
        for witness in witnesses {
            push_varuint(&mut out, witness.invocation_script.len());
            out.extend_from_slice(&witness.invocation_script);
            push_varuint(&mut out, witness.verification_script.len());
            out.extend_from_slice(&witness.verification_script);
        }
        out
    }

    /// `getMessageForSigning(magic)`: `num2hexstring(magic, 4, true) +
    /// reverseHex(hash())` — and neon-js's `hash()` is itself
    /// `reverseHex(sha256(serialize(false)))`, so the reverses cancel and the
    /// message is the magic little-endian followed by the plain SHA-256 of
    /// the unsigned serialization (the same framing custody's raw-sign
    /// primitive hashes).
    pub fn message_for_signing(&self, magic: u32) -> Vec<u8> {
        let mut message = magic.to_le_bytes().to_vec();
        message.extend_from_slice(&Sha256::digest(self.serialize_unsigned()));
        message
    }

    /// The transaction hash in display form: neon-js `transaction.hash()` =
    /// `reverseHex(sha256(serialize(false)))` — the WITNESSES ARE EXCLUDED
    /// (Neo N3 hashes the unsigned portion; signatures commit via the
    /// witnesses themselves). This is what `getapplicationlog` polling and
    /// `custodySignTransaction`'s fee sizing key on.
    pub fn hash_display(&self) -> String {
        let digest = Sha256::digest(self.serialize_unsigned());
        let mut display = digest.to_vec();
        display.reverse();
        format!(
            "0x{}",
            display
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        )
    }
}

/// `num2VarInt`: 1-byte lengths as-is, then the 0xfd/0xfe escapes.
fn push_varuint(out: &mut Vec<u8>, value: usize) {
    if value < 0xfd {
        out.push(value as u8);
    } else if value <= 0xffff {
        out.push(0xfd);
        out.extend_from_slice(&(value as u16).to_le_bytes());
    } else {
        out.push(0xfe);
        out.extend_from_slice(&(value as u32).to_le_bytes());
    }
}

// ---- unsigned transaction envelopes ----

/// Why an unsigned envelope could not be framed.
///
/// The sponsor path pays for exactly one wire shape, so anything that is not
/// that shape is refused rather than half-parsed: a partially-understood
/// transaction is the one thing a fee payer must never sign.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum N3TxParseError {
    /// The bytes end before a complete field.
    Truncated,
    /// Bytes remain after the declared script.
    TrailingBytes,
    /// `version` is not the 0 the encoder emits.
    UnsupportedVersion,
    /// Not exactly one signer.
    SignerCount,
    /// The signer's scope is not the single `CalledByEntry` the encoder emits.
    SignerScope,
    /// A non-zero attribute count; the encoder emits none.
    Attributes,
    /// The script length is not in the canonical `num2VarInt` form, or names
    /// more bytes than the envelope carries.
    ScriptLength,
}

impl std::fmt::Display for N3TxParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Truncated => "the envelope ends before a complete field",
            Self::TrailingBytes => "the envelope has bytes after the invocation script",
            Self::UnsupportedVersion => "the envelope is not a version-0 transaction",
            Self::SignerCount => "the envelope does not carry exactly one signer",
            Self::SignerScope => "the signer scope is not CalledByEntry",
            Self::Attributes => "the envelope carries transaction attributes",
            Self::ScriptLength => "the invocation script length is not canonical",
        })
    }
}

impl std::error::Error for N3TxParseError {}

/// One unsigned Neo N3 transaction, framed exactly as
/// [`FeedTx::serialize_unsigned`] emits it.
///
/// The public fields are in the same order the public surface uses elsewhere in
/// this module: `signer` is **display order**, the `0x…` 40-hex form, so a
/// comparison against a journal column is a byte comparison. Parsing is the
/// inverse of the encoder and re-serialising a parsed envelope reproduces the
/// input bytes exactly, so a second encoding of the same transaction cannot
/// slip past a caller that prices or signs these bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsignedTx {
    pub nonce: u32,
    pub valid_until_block: u32,
    pub system_fee: u64,
    pub network_fee: u64,
    /// The fee payer, display order.
    pub signer: [u8; HASH160_LEN],
    pub script: Vec<u8>,
}

impl UnsignedTx {
    /// The view the encoder takes, so the two never diverge on the wire.
    fn as_feed_tx(&self) -> FeedTx<'_> {
        FeedTx {
            nonce: self.nonce,
            valid_until_block: self.valid_until_block,
            system_fee: self.system_fee,
            network_fee: self.network_fee,
            signer: FeedSigner {
                script_hash: self.signer,
            },
            script: &self.script,
        }
    }

    /// `Transaction.serialize(false)` for this envelope. Byte-identical to the
    /// bytes [`parse_unsigned_tx`] accepted.
    pub fn serialize_unsigned(&self) -> Vec<u8> {
        self.as_feed_tx().serialize_unsigned()
    }

    /// `Transaction.serialize(true)`: the unsigned serialization plus the
    /// witness array.
    pub fn serialize_signed(&self, witnesses: &[Witness]) -> Vec<u8> {
        self.as_feed_tx().serialize_signed(witnesses)
    }

    /// The transaction hash the chain and `getapplicationlog` key on.
    pub fn hash_display(&self) -> String {
        self.as_feed_tx().hash_display()
    }

    /// `SystemFee + NetworkFee`, the amount the fee payer spends on this
    /// transaction. `None` when the sum leaves the datoshi domain, so a caller
    /// refuses rather than wraps.
    pub fn transaction_fee_units(&self) -> Option<u64> {
        self.system_fee.checked_add(self.network_fee)
    }
}

/// Read a `FeedTx::serialize_unsigned` envelope. The inverse of that encoder,
/// and nothing more: it frames the transaction and makes no claim about what
/// the invocation script means.
pub fn parse_unsigned_tx(bytes: &[u8]) -> Result<UnsignedTx, N3TxParseError> {
    let mut read = Reader::new(bytes);
    let version = read.byte()?;
    if version != 0 {
        return Err(N3TxParseError::UnsupportedVersion);
    }
    let nonce = read.u32()?;
    let system_fee = read.u64()?;
    let network_fee = read.u64()?;
    let valid_until_block = read.u32()?;
    if read.byte()? != 1 {
        return Err(N3TxParseError::SignerCount);
    }
    let mut signer = read.array::<HASH160_LEN>()?;
    // The wire carries the account little-endian; the public surface is display
    // order, matching `decode_invoke_call`'s hashes and the journal's `contract`
    // column.
    signer.reverse();
    if read.byte()? != WITNESS_SCOPE_CALLED_BY_ENTRY {
        return Err(N3TxParseError::SignerScope);
    }
    if read.byte()? != 0 {
        return Err(N3TxParseError::Attributes);
    }
    let script_len = read.canonical_varuint()?;
    let script = read.take(script_len)?;
    if !read.done() {
        return Err(N3TxParseError::TrailingBytes);
    }
    Ok(UnsignedTx {
        nonce,
        valid_until_block,
        system_fee,
        network_fee,
        signer,
        script: script.to_vec(),
    })
}

/// A bounds-checked cursor over a fixed buffer. Every field read is exact, so a
/// short buffer is [`N3TxParseError::Truncated`] and never a zero default.
struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Reader { bytes, at: 0 }
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], N3TxParseError> {
        let end = self
            .at
            .checked_add(count)
            .ok_or(N3TxParseError::Truncated)?;
        let slice = self
            .bytes
            .get(self.at..end)
            .ok_or(N3TxParseError::Truncated)?;
        self.at = end;
        Ok(slice)
    }

    fn byte(&mut self) -> Result<u8, N3TxParseError> {
        Ok(self.take(1)?[0])
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], N3TxParseError> {
        let slice = self.take(N)?;
        let mut out = [0u8; N];
        out.copy_from_slice(slice);
        Ok(out)
    }

    fn u32(&mut self) -> Result<u32, N3TxParseError> {
        Ok(u32::from_le_bytes(self.array()?))
    }

    fn u64(&mut self) -> Result<u64, N3TxParseError> {
        Ok(u64::from_le_bytes(self.array()?))
    }

    /// `num2VarInt`, accepted only in the single form [`push_varuint`] emits.
    /// A second encoding of the same length is a second encoding of the same
    /// transaction, and a fee payer must sign exactly one of them.
    fn canonical_varuint(&mut self) -> Result<usize, N3TxParseError> {
        let lead = self.byte()?;
        match lead {
            0x00..=0xfc => Ok(usize::from(lead)),
            0xfd => {
                let value = u16::from_le_bytes(self.array()?) as usize;
                if value < 0xfd {
                    return Err(N3TxParseError::ScriptLength);
                }
                Ok(value)
            }
            0xfe => {
                let value = u32::from_le_bytes(self.array()?) as usize;
                if value <= 0xffff {
                    return Err(N3TxParseError::ScriptLength);
                }
                Ok(value)
            }
            // `push_varuint` never emits the 8-byte form.
            _ => Err(N3TxParseError::ScriptLength),
        }
    }

    fn done(&self) -> bool {
        self.at == self.bytes.len()
    }
}

// ---- script-hash derivation (custody identity + address forms) ----

/// `Hash160`: RIPEMD160(SHA256(bytes)) — the Neo script-hash function.
pub fn hash160(bytes: &[u8]) -> [u8; 20] {
    use ripemd::Ripemd160;
    let sha = Sha256::digest(bytes);
    Ripemd160::digest(sha).into()
}

/// The single-sig verification script for a compressed public key:
/// `0c21 <33B pubkey> 4156e7b327` (PUSHDATA1 33 + SYSCALL Neo.Crypto.Verify).
/// Returns None unless `public_key` is exactly a 33-byte 02/03-prefixed key.
pub fn verification_script_single_sig(public_key: &[u8]) -> Option<Vec<u8>> {
    if public_key.len() != 33 || !matches!(public_key[0], 0x02 | 0x03) {
        return None;
    }
    let mut script = Vec::with_capacity(11 + public_key.len());
    script.push(OP_PUSHDATA1);
    script.push(public_key.len() as u8);
    script.extend_from_slice(public_key);
    // SYSCALL + Neo.Crypto.Verify interop hash, little-endian on the wire.
    script.extend_from_slice(&[0x41, 0x56, 0xe7, 0xb3, 0x27]);
    Some(script)
}

/// `wallet.getScriptHashFromPublicKey`: hash160 of the single-sig
/// verification script, returned in the little-endian display form neon-js
/// uses (the same convention the custody service's `script_hash` field
/// carries, so identity comparisons are direct byte comparisons).
pub fn script_hash_from_public_key(public_key: &[u8]) -> Option<[u8; 20]> {
    let mut hash = hash160(&verification_script_single_sig(public_key)?);
    hash.reverse();
    Some(hash)
}

const NEO_ADDRESS_VERSION: u8 = 0x35;

/// `wallet.getScriptHashFromAddress`: base58check decode (Neo address version
/// 0x35), returning the 20-byte script hash in the same little-endian display
/// form neon-js uses (the reversal of the payload's big-endian hash). None on
/// any shape, checksum, or version failure.
pub fn script_hash_from_address(address: &str) -> Option<[u8; 20]> {
    let payload = base58_check_decode(address)?;
    if payload.len() != 21 || payload[0] != NEO_ADDRESS_VERSION {
        return None;
    }
    let mut hash = [0u8; 20];
    hash.copy_from_slice(&payload[1..]);
    hash.reverse();
    Some(hash)
}

/// `wallet.getAddressFromScriptHash`: the input is the little-endian script
/// hash (neon-js display form, as carried on the wire); the payload encodes it
/// reversed, plus version byte and sha256d checksum, base58-encoded.
pub fn address_from_script_hash(script_hash_le: &[u8; 20]) -> String {
    let mut payload = Vec::with_capacity(25);
    payload.push(NEO_ADDRESS_VERSION);
    payload.extend(script_hash_le.iter().rev());
    let checksum = Sha256::digest(Sha256::digest(&payload));
    payload.extend_from_slice(&checksum[..4]);
    base58_encode(&payload)
}

fn base58_check_decode(text: &str) -> Option<Vec<u8>> {
    let decoded = base58_decode(text)?;
    if decoded.len() < 5 {
        return None;
    }
    let (payload, checksum) = decoded.split_at(decoded.len() - 4);
    let expected = Sha256::digest(Sha256::digest(payload));
    if checksum != &expected[..4] {
        return None;
    }
    Some(payload.to_vec())
}

const BASE58_ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

fn base58_decode(text: &str) -> Option<Vec<u8>> {
    if text.is_empty() {
        return None;
    }
    let mut bytes: Vec<u8> = Vec::with_capacity(text.len());
    for ch in text.bytes() {
        let value = BASE58_ALPHABET.iter().position(|c| *c == ch)? as u32;
        let mut carry = value;
        for byte in bytes.iter_mut().rev() {
            let product = (*byte as u32) * 58 + carry;
            *byte = (product & 0xff) as u8;
            carry = product >> 8;
        }
        while carry > 0 {
            bytes.insert(0, (carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    // Leading '1's encode leading zero bytes.
    let zeros = text.bytes().take_while(|c| *c == b'1').count();
    let stripped = bytes.iter().position(|b| *b != 0).unwrap_or(bytes.len());
    let mut out = vec![0u8; zeros];
    out.extend_from_slice(&bytes[stripped..]);
    Some(out)
}

fn base58_encode(bytes: &[u8]) -> String {
    let mut digits: Vec<u8> = Vec::with_capacity(bytes.len() * 138 / 100 + 1);
    for byte in bytes {
        let mut carry = *byte as u32;
        for digit in digits.iter_mut() {
            let product = (*digit as u32) * 256 + carry;
            *digit = (product % 58) as u8;
            carry = product / 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let zeros = bytes.iter().take_while(|b| **b == 0).count();
    let mut out = String::with_capacity(digits.len() + zeros);
    for _ in 0..zeros {
        out.push('1');
    }
    for digit in digits.iter().rev() {
        out.push(BASE58_ALPHABET[*digit as usize] as char);
    }
    out
}

/// Strict hex decode: optional 0x prefix, even length, both cases. None on any
/// violation (parity with neon-js `HexString.fromHex`, which throws).
fn decode_hex_strict(value: &str) -> Option<Vec<u8>> {
    let raw = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
        .unwrap_or(value);
    if raw.is_empty() || !raw.len().is_multiple_of(2) {
        return None;
    }
    let bytes = raw
        .as_bytes()
        .chunks(2)
        .map(|pair| {
            let high = hex_value(pair[0])?;
            let low = hex_value(pair[1])?;
            Some((high << 4) | low)
        })
        .collect::<Option<Vec<u8>>>()?;
    Some(bytes)
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// The wire bytes a `Hash160` argument emits:
/// * a 20-byte (optionally 0x-prefixed) hex input is big-endian and gets
///   reversed to little-endian wire order;
/// * a base58check address decodes to wire-order bytes directly (the address
///   payload already stores the little-endian form).
pub fn hash160_param_bytes(value: &str) -> Option<[u8; 20]> {
    let trimmed = value.trim();
    let raw = trimmed.strip_prefix("0x").unwrap_or(trimmed);
    if raw.len() == 40 {
        let bytes = decode_hex_strict(raw)?;
        let mut wire = [0u8; 20];
        wire.copy_from_slice(&bytes);
        wire.reverse();
        return Some(wire);
    }
    // Not 20-byte hex — try the address form (JS: getScriptHashFromAddress,
    // which throws on a non-address, and the caller surfaces '' / an error).
    let payload = base58_check_decode(trimmed)?;
    if payload.len() != 21 || payload[0] != NEO_ADDRESS_VERSION {
        return None;
    }
    let mut wire = [0u8; 20];
    wire.copy_from_slice(&payload[1..]);
    Some(wire)
}
