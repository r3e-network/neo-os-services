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

use sha2::{Digest, Sha256};

/// The contract-argument shapes `updateFeeds` needs, in the neon-js emission
/// order the deployed contract expects.
pub enum ContractParam {
    /// UTF-8 string, PUSHDATA1-emitted in natural byte order.
    String(String),
    /// Emit via the signed minimal-LE integer encoding above.
    Integer(i64),
    /// A string `ContractParam.byteArray` would receive: BASE64-decoded at
    /// emission (see the module doc).
    Base64Bytes(String),
    /// VM array: elements emitted last-to-first, then the count, then PACK.
    Array(Vec<ContractParam>),
}

const OP_PUSHINT8: u8 = 0x00;
const OP_PUSHINT16: u8 = 0x01;
const OP_PUSHINT32: u8 = 0x02;
const OP_PUSHINT64: u8 = 0x03;
const OP_PUSHDATA1: u8 = 0x0c;
const OP_PUSHM1: u8 = 0x0f;
const OP_PUSH0: u8 = 0x10;
const OP_PACK: u8 = 0xc0;
const OP_SYSCALL: u8 = 0x41;
/// `InteropServiceCode.SYSTEM_CONTRACT_CALL` (`System.Contract.Call`).
const SYSTEM_CONTRACT_CALL: [u8; 4] = [0x62, 0x7d, 0x5b, 0x52];
/// `CallFlags.All` — `createScript`'s default — pushed via PUSH16.
const CALL_FLAGS_ALL: u8 = 0x1f;
/// `WitnessScope.CalledByEntry`.
pub const WITNESS_SCOPE_CALLED_BY_ENTRY: u8 = 0x01;

/// `sc.createScript({scriptHash, operation, args})`: args packed as one VM
/// array, then the call flags, the operation string, the script hash (stored
/// little-endian on the wire), and the `System.Contract.Call` syscall.
pub fn create_invoke_script(
    script_hash: &[u8; 20],
    operation: &str,
    args: &[ContractParam],
) -> Vec<u8> {
    let mut out = Vec::new();
    emit_array(&mut out, args);
    out.push(CALL_FLAGS_ALL);
    emit_string(&mut out, operation);
    out.push(OP_PUSHDATA1);
    out.push(20);
    out.extend(script_hash.iter().rev());
    out.push(OP_SYSCALL);
    out.extend_from_slice(&SYSTEM_CONTRACT_CALL);
    out
}

fn emit_array(out: &mut Vec<u8>, items: &[ContractParam]) {
    for item in items.iter().rev() {
        emit_param(out, item);
    }
    emit_integer(out, items.len() as i64);
    out.push(OP_PACK);
}

fn emit_param(out: &mut Vec<u8>, param: &ContractParam) {
    match param {
        ContractParam::String(value) => emit_string(out, value),
        ContractParam::Integer(value) => emit_integer(out, *value),
        ContractParam::Base64Bytes(value) => {
            let bytes = crate::base64::decode_lenient(value);
            emit_byte_string(out, &bytes);
        }
        ContractParam::Array(items) => emit_array(out, items),
    }
}

fn emit_string(out: &mut Vec<u8>, value: &str) {
    emit_byte_string(out, value.as_bytes());
}

fn emit_byte_string(out: &mut Vec<u8>, bytes: &[u8]) {
    out.push(OP_PUSHDATA1);
    out.push(bytes.len() as u8);
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

/// One signer: the account (display script hash, serialized little-endian)
/// with the `CalledByEntry` scope. The feed tx never carries the wider scope
/// shapes, so only the two fixed fields serialize.
pub struct FeedSigner {
    /// Display (big-endian) script hash of the signing account.
    pub script_hash: [u8; 20],
}

/// The unsigned-transaction fields `buildUpdateFeedsTxMessage` fills. Version
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
