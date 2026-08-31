//! Decode what a caller asks the Signer to sign into something a policy can
//! decide on.
//!
//! A custody service must never sign opaque bytes it has not interpreted: the
//! script in front of us says either "move N of asset X to Y" or "call method M
//! on contract C", and every policy rule is a rule about those
//! facts. So this module mirrors the node's own wire format and refuses
//! anything it cannot fully account for — trailing bytes, an opcode that could
//! compute a contract hash at runtime, a syscall that is not
//! `System.Contract.Call`, an attribute type whose payload is not understood.
//! A parse error here means *no signature*, which is the only safe response to
//! a transaction we cannot describe.
//!
//! Two byte-order conventions cost the most to get wrong, so they are stated
//! once, here:
//!
//! * Hashes as RPC *displays* them (`0xef4073a0…`) are the reverse of the 20
//!   bytes that appear on the wire and inside [`super::crypto`]'s `HASH160`
//!   output. Operators paste display hashes, so policy input is parsed with
//!   [`display_to_script_hash`] and stored in wire order.
//! * A `SYSCALL` operand is the first four bytes of `SHA256(name)`, written
//!   little-endian, which is why `System.Contract.Call` appears as
//!   `62 7d 5b 52`.

/// Largest transaction the node accepts (`Transaction.MaxTransactionSize`).
pub const MAX_TRANSACTION_SIZE: usize = 102_400;
/// Combined cap on signers and attributes (`Transaction.MaxTransactionAttributes`).
pub const MAX_TRANSACTION_ATTRIBUTES: usize = 16;
/// Cap on a signer's allowed contracts / groups / rules (`Signer.MaxSubitems`).
pub const MAX_SIGNER_SUBITEMS: usize = 16;
/// A varbytes field cannot exceed the wire's own length prefix (`ushort.MaxValue`).
const MAX_VARBYTES: usize = u16::MAX as usize;
/// Bound on `PACK` so a malformed script cannot make us allocate on its word.
const MAX_PACK_ITEMS: i128 = 1_024;
/// Length of a `UInt160` in wire order.
pub const HASH160_LEN: usize = 20;
/// `ExtensiblePayload` categories are read with `ReadVarString(32)`.
const MAX_CATEGORY_LEN: usize = 32;

/// `System.Contract.Call` transition hash: `SHA256("System.Contract.Call")[0..4]`.
pub const CONTRACT_CALL_INTEROP: [u8; 4] = [0x62, 0x7d, 0x5b, 0x52];

/// Parse a 40-hex-character display hash into wire order, at compile time.
const fn parse_display_hash(value: &str) -> Option<[u8; HASH160_LEN]> {
    let bytes = value.as_bytes();
    if bytes.len() != HASH160_LEN * 2 {
        return None;
    }
    let mut out = [0u8; HASH160_LEN];
    let mut i = 0;
    while i < HASH160_LEN {
        // Display order is the reverse of wire order, so wire byte `i` comes
        // from display byte `19 - i`.
        let source = HASH160_LEN - 1 - i;
        let high = match hex_digit(bytes[source * 2]) {
            Some(v) => v,
            None => return None,
        };
        let low = match hex_digit(bytes[source * 2 + 1]) {
            Some(v) => v,
            None => return None,
        };
        out[i] = (high << 4) | low;
        i += 1;
    }
    Some(out)
}

const fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// The two native GAS-11 token contracts, in wire order.
///
/// Transfers are recognised by shape rather than by these constants, so they are
/// not what makes an amount limit apply; they are here because only these two
/// have a fixed decimal count (NEO 0, GAS 8), which is what a ceiling has to be
/// displayed in.
pub mod native {
    /// NEO (`0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5`).
    pub const NEO: [u8; 20] =
        match super::parse_display_hash("ef4073a0f2b305a38ec4050e4d3d28bc40ea63f5") {
            Some(hash) => hash,
            None => [0u8; 20],
        };
    /// GAS (`0xd2a4cff31913016155e38e474a2c06d08be276cf`).
    pub const GAS: [u8; 20] =
        match super::parse_display_hash("d2a4cff31913016155e38e474a2c06d08be276cf") {
            Some(hash) => hash,
            None => [0u8; 20],
        };
}

/// Something the caller asked us to sign that we could not interpret.
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum TxError {
    /// Input ended in the middle of a field.
    Truncated,
    /// Bytes remained after the transaction was read.
    TrailingBytes {
        /// Offset of the first unread byte.
        offset: usize,
    },
    /// Input exceeded [`MAX_TRANSACTION_SIZE`].
    TooLarge,
    /// A varint exceeded what this field may legally hold.
    CountOutOfRange {
        /// What was being read, for the audit message.
        field: &'static str,
        /// The decoded count.
        value: u64,
    },
    /// A varbytes length outran the remaining input.
    LengthOutOfRange {
        /// What was being read.
        field: &'static str,
    },
    /// `Transaction.Version` was not zero.
    UnsupportedVersion {
        /// The version byte seen.
        version: u8,
    },
    /// The node rejects a transaction with no signers.
    NoSigners,
    /// Two signers shared an account, which the node rejects.
    DuplicateSigner {
        /// The repeated account, wire order.
        account: [u8; 20],
    },
    /// Reserved bits were set in a signer's scope byte.
    InvalidScope {
        /// The scope byte seen.
        scope: u8,
    },
    /// `Global` was combined with other scopes, which the node rejects.
    GlobalWithOtherScope,
    /// A signer delegated to witness rules, whose evaluation depends on chain
    /// state we cannot see, so no static policy can be applied.
    WitnessRulesUnsupported,
    /// The node rejects a transaction whose script is empty.
    EmptyScript,
    /// Two attributes shared a type, which the node rejects.
    DuplicateAttribute {
        /// The repeated attribute type.
        attribute_type: u8,
    },
    /// An attribute carries a payload this parser does not know, so the
    /// transaction's meaning is not fully determined.
    UnknownAttribute {
        /// The attribute byte seen.
        attribute_type: u8,
    },
    /// An opcode outside the push/pack/syscall subset appeared, so the script
    /// could compute something at run time that we cannot predict.
    UnsupportedOpcode {
        /// The opcode seen.
        opcode: u8,
    },
    /// A `SYSCALL` was not `System.Contract.Call`.
    UnsupportedSyscall {
        /// The four-byte transition hash seen.
        interop: [u8; 4],
    },
    /// A `SYSCALL` ended the script before its operand.
    IncompleteSyscall,
    /// `PACK` counted more items than the stack held, or more than allowed.
    BadPack,
    /// The stack did not hold `(contract, method, flags, args)` for a call.
    MalformedCall,
    /// A value exceeded the range policy arithmetic can bound.
    ValueOutOfRange {
        /// What the value was for.
        field: &'static str,
    },
    /// The script contained no `System.Contract.Call` at all.
    NoContractCalls,
    /// `ExtensiblePayload` requires a non-empty validity range.
    InvalidValidityRange {
        /// First block height the payload claimed to be valid for.
        start: u32,
        /// Last block height the payload claimed to be valid for.
        end: u32,
    },
    /// A UTF-8 string field was not valid UTF-8.
    InvalidUtf8 {
        /// What the string was for.
        field: &'static str,
    },
}

impl std::fmt::Display for TxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            TxError::Truncated => "input ended mid-field",
            TxError::TrailingBytes { offset } => {
                return write!(f, "unexpected bytes at offset {offset}")
            }
            TxError::TooLarge => "transaction exceeds the maximum size",
            TxError::CountOutOfRange { field, value } => {
                return write!(f, "{field} count {value} is out of range")
            }
            TxError::LengthOutOfRange { field } => {
                return write!(f, "{field} length is out of range")
            }
            TxError::UnsupportedVersion { version } => {
                return write!(f, "unsupported transaction version {version}")
            }
            TxError::NoSigners => "transaction has no signers",
            TxError::DuplicateSigner { account } => {
                return write!(f, "duplicate signer {}", hex::encode(account))
            }
            TxError::InvalidScope { scope } => {
                return write!(f, "invalid witness scope 0x{scope:02x}")
            }
            TxError::GlobalWithOtherScope => "global scope cannot be combined",
            TxError::WitnessRulesUnsupported => {
                "witness-rule scopes cannot be evaluated statically"
            }
            TxError::EmptyScript => "transaction script is empty",
            TxError::DuplicateAttribute { attribute_type } => {
                return write!(f, "duplicate attribute type 0x{attribute_type:02x}")
            }
            TxError::UnknownAttribute { attribute_type } => {
                return write!(f, "unrecognised attribute type 0x{attribute_type:02x}")
            }
            TxError::UnsupportedOpcode { opcode } => {
                return write!(f, "unsupported opcode 0x{opcode:02x}")
            }
            TxError::UnsupportedSyscall { interop } => {
                return write!(f, "unsupported syscall {}", hex::encode(interop))
            }
            TxError::IncompleteSyscall => "syscall operand is truncated",
            TxError::BadPack => "pack count does not match the stack",
            TxError::MalformedCall => "contract call is missing stack arguments",
            TxError::ValueOutOfRange { field } => {
                return write!(f, "{field} is out of the representable range")
            }
            TxError::NoContractCalls => "script performs no contract call",
            TxError::InvalidValidityRange { start, end } => {
                return write!(f, "valid block range {start}..{end} is empty")
            }
            TxError::InvalidUtf8 { field } => return write!(f, "{field} is not valid UTF-8"),
        };
        f.write_str(message)
    }
}

impl std::error::Error for TxError {}

/// A stack item produced by the subset of the VM this parser accepts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StackItem {
    /// `PUSHNULL`.
    Null,
    /// `PUSHT` / `PUSHF`.
    Bool(bool),
    /// A little-endian two's-complement integer, as pushed.
    Integer(Vec<u8>),
    /// A `PUSHDATA*` byte string.
    ByteString(Vec<u8>),
    /// A `PACK`ed array, in the order the VM pops them (first popped is index 0).
    Array(Vec<StackItem>),
}

impl StackItem {
    /// The item as a 20-byte script hash, if it is byte-string shaped. Only a
    /// pushed byte string counts: an integer-encoded hash would not be produced
    /// by any real wallet, and accepting it would let a crafted script slip a
    /// hash past a check written against this function.
    fn script_hash(&self) -> Option<[u8; HASH160_LEN]> {
        match self {
            StackItem::ByteString(bytes) => <[u8; HASH160_LEN]>::try_from(bytes.as_slice()).ok(),
            _ => None,
        }
    }

    fn as_i128(&self) -> Option<i128> {
        let bytes = match self {
            StackItem::Integer(bytes) => bytes.as_slice(),
            _ => return None,
        };
        if bytes.is_empty() || bytes.len() > 16 {
            return None;
        }
        let mut buf = [0u8; 16];
        // Sign-extend: the top byte of a short push carries its own sign bit.
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

    fn as_text(&self) -> Option<&[u8]> {
        match self {
            StackItem::ByteString(bytes) => Some(bytes),
            _ => None,
        }
    }
}

/// A signer in the transaction, with the scopes that bound where its witness
/// may be used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Signer {
    /// The account (script hash) in wire order.
    pub account: [u8; HASH160_LEN],
    /// The decoded scope flags.
    pub scope: Scope,
    /// Contracts permitted when [`Scope::CUSTOM_CONTRACTS`] is set, wire order.
    pub allowed_contracts: Vec<[u8; HASH160_LEN]>,
    /// Groups permitted when [`Scope::CUSTOM_GROUPS`] is set.
    pub allowed_groups: Vec<[u8; 33]>,
}

/// Witness scope flags, as a plain bit set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Scope(pub u8);

impl Scope {
    /// The witness is only valid for the entry contract.
    pub const CALLED_BY_ENTRY: u8 = 0x01;
    /// The witness carries an explicit contract list.
    pub const CUSTOM_CONTRACTS: u8 = 0x10;
    /// The witness carries an explicit group-key list.
    pub const CUSTOM_GROUPS: u8 = 0x20;
    /// The witness defers to on-chain witness rules.
    pub const WITNESS_RULES: u8 = 0x40;
    /// The witness is valid anywhere.
    pub const GLOBAL: u8 = 0x80;
    const KNOWN: u8 = Self::CALLED_BY_ENTRY
        | Self::CUSTOM_CONTRACTS
        | Self::CUSTOM_GROUPS
        | Self::WITNESS_RULES
        | Self::GLOBAL;

    fn parse(value: u8) -> Result<Self, TxError> {
        if value & !Self::KNOWN != 0 {
            return Err(TxError::InvalidScope { scope: value });
        }
        if value & Self::GLOBAL != 0 && value != Self::GLOBAL {
            return Err(TxError::GlobalWithOtherScope);
        }
        Ok(Scope(value))
    }

    pub fn has(self, flag: u8) -> bool {
        self.0 & flag != 0
    }

    /// Whether this scope lets the witness be used by any contract the entry
    /// script hands control to — which is what makes `Global` worth flagging
    /// loudly in a policy decision.
    pub fn is_global(self) -> bool {
        self.0 == Self::GLOBAL
    }
}

impl std::fmt::Display for Scope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.0 == 0 {
            return f.write_str("none");
        }
        let mut parts: Vec<&str> = Vec::new();
        if self.has(Scope::CALLED_BY_ENTRY) {
            parts.push("called-by-entry");
        }
        if self.has(Scope::CUSTOM_CONTRACTS) {
            parts.push("custom-contracts");
        }
        if self.has(Scope::CUSTOM_GROUPS) {
            parts.push("custom-groups");
        }
        if self.has(Scope::WITNESS_RULES) {
            parts.push("witness-rules");
        }
        if self.is_global() {
            parts.push("global");
        }
        f.write_str(&parts.join("+"))
    }
}

/// A transaction attribute whose meaning affects what signing authorises.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Attribute {
    /// Skip the fee-per-byte check.
    HighPriority,
    /// Not valid before a block height.
    NotValidBefore(u32),
    /// Invalid once the referenced transaction lands.
    Conflicts([u8; 32]),
}

/// One `System.Contract.Call` decoded out of the script.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Call {
    /// Target contract, wire order.
    pub contract: [u8; HASH160_LEN],
    /// Method name as pushed.
    pub method: String,
    /// `CallFlags` value as pushed.
    pub flags: u8,
    /// Method arguments, in order.
    pub args: Vec<StackItem>,
}

/// What a script intends to do, as far as a policy can act on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Intent {
    /// A NEP-17 `transfer` of `amount` of `asset` from `from` to `to`.
    Transfer {
        /// Token contract, wire order.
        asset: [u8; HASH160_LEN],
        /// Source account, wire order.
        from: [u8; HASH160_LEN],
        /// Destination account, wire order.
        to: [u8; HASH160_LEN],
        /// Raw token units (NEO is 0 decimals, GAS is 8).
        amount: i128,
    },
    /// Any other contract call, including a non-canonical call on a token.
    ContractCall {
        /// Target contract, wire order.
        contract: [u8; HASH160_LEN],
        /// Method name.
        method: String,
        /// `CallFlags` value.
        flags: u8,
    },
}

/// A decoded, unsigned transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsignedTransaction {
    /// Must be zero.
    pub version: u8,
    /// Replay-distinguishing nonce.
    pub nonce: u32,
    /// Network-reported system fee.
    pub system_fee: i64,
    /// Network-reported network fee.
    pub network_fee: i64,
    /// Last block height the transaction is valid for.
    pub valid_until_block: u32,
    /// Signers, in order; the first is the sender.
    pub signers: Vec<Signer>,
    /// Attributes present on the transaction.
    pub attributes: Vec<Attribute>,
    /// The verification script, verbatim.
    pub script: Vec<u8>,
}

impl UnsignedTransaction {
    /// Parse a serialized unsigned transaction — exactly the bytes whose hash
    /// goes into the signing preimage.
    pub fn parse(bytes: &[u8]) -> Result<Self, TxError> {
        if bytes.len() > MAX_TRANSACTION_SIZE {
            return Err(TxError::TooLarge);
        }
        let mut reader = Reader::new(bytes);
        let version = reader.u8()?;
        if version > 0 {
            return Err(TxError::UnsupportedVersion { version });
        }
        let nonce = reader.u32()?;
        let system_fee = reader.i64()?;
        let network_fee = reader.i64()?;
        if system_fee < 0 || network_fee < 0 || system_fee.checked_add(network_fee).is_none() {
            // The node rejects all three, and a negative fee would defeat any
            // amount limit expressed in tokens.
            return Err(TxError::ValueOutOfRange { field: "fee" });
        }
        let valid_until_block = reader.u32()?;
        let signers = reader.signers()?;
        let attributes = reader.attributes(signers.len())?;
        let script = reader.varbytes("script", MAX_VARBYTES)?;
        if script.is_empty() {
            return Err(TxError::EmptyScript);
        }
        reader.finish()?;
        Ok(UnsignedTransaction {
            version,
            nonce,
            system_fee,
            network_fee,
            valid_until_block,
            signers,
            attributes,
            script,
        })
    }

    /// The sender / first signer. `None` only for a hand-built value with an
    /// empty signer list — [`UnsignedTransaction::parse`] rejects those.
    pub fn sender(&self) -> Option<[u8; HASH160_LEN]> {
        self.signers.first().map(|signer| signer.account)
    }

    /// Every `System.Contract.Call` in the script, in execution order.
    pub fn calls(&self) -> Result<Vec<Call>, TxError> {
        decode_script(&self.script)
    }

    /// The calls, folded into what a policy decides on: recognised NEP-17
    /// transfers become [`Intent::Transfer`], everything else stays a call.
    pub fn intents(&self) -> Result<Vec<Intent>, TxError> {
        Ok(self.calls()?.into_iter().map(intent_of).collect())
    }
}

fn intent_of(call: Call) -> Intent {
    match transfer_shape(&call) {
        Some((from, to, amount)) => Intent::Transfer {
            asset: call.contract,
            from,
            to,
            amount,
        },
        None => Intent::ContractCall {
            contract: call.contract,
            method: call.method,
            flags: call.flags,
        },
    }
}

/// `(from, to, amount)` when the call is shaped like a NEP-17 `transfer`.
///
/// Shape, not contract identity: any four-argument `transfer` whose first two
/// arguments are accounts and whose third is an integer is read as a transfer,
/// so a per-transfer or window ceiling reaches token contracts and not just the
/// native two. Narrower reading would leave such a call as a bare contract call,
/// where no amount limit applies at all, and an operator who whitelisted a token
/// would believe the ceilings covered it. Misreading a look-alike method as a
/// transfer asks for *more* permission rather than less, since a transfer needs
/// the transfer gate on top of the contract gates; and an amount too wide for
/// `i128` falls back to a call, which is the gate an operator can reason about.
fn transfer_shape(call: &Call) -> Option<([u8; HASH160_LEN], [u8; HASH160_LEN], i128)> {
    if call.method != "transfer" || call.args.len() != 4 {
        return None;
    }
    let from = call.args[0].script_hash()?;
    let to = call.args[1].script_hash()?;
    let amount = call.args[2].as_i128()?;
    Some((from, to, amount))
}

/// A parsed `ExtensiblePayload` — the container dBFT rounds are relayed in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsensusPayload {
    /// Payload class; dBFT rounds use `"dBFT"`.
    pub category: String,
    /// First block height the payload is valid for.
    pub valid_block_start: u32,
    /// Last block height the payload is valid for.
    pub valid_block_end: u32,
    /// The committee member signing, wire order.
    pub sender: [u8; HASH160_LEN],
    /// Consensus message body, opaque here.
    pub data: Vec<u8>,
}

impl ConsensusPayload {
    /// Parse the `SerializeUnsigned` bytes of an extensible payload — again,
    /// exactly the bytes that go into the signing preimage.
    pub fn parse(bytes: &[u8]) -> Result<Self, TxError> {
        let mut reader = Reader::new(bytes);
        let category = reader.varstring("category", MAX_CATEGORY_LEN)?;
        let valid_block_start = reader.u32()?;
        let valid_block_end = reader.u32()?;
        if valid_block_start >= valid_block_end {
            return Err(TxError::InvalidValidityRange {
                start: valid_block_start,
                end: valid_block_end,
            });
        }
        let sender = reader.hash160()?;
        let data = reader.varbytes("payload data", MAX_VARBYTES)?;
        reader.finish()?;
        Ok(ConsensusPayload {
            category,
            valid_block_start,
            valid_block_end,
            sender,
            data,
        })
    }
}

/// Decode a verification script made only of pushes, `PACK` and
/// `System.Contract.Call` syscalls. Anything else is refused: a script that
/// jumps, calls another function, or derives a hash at run time cannot be
/// reduced to a fixed list of intents, and signing it would mean trusting the
/// caller's description of it.
fn decode_script(script: &[u8]) -> Result<Vec<Call>, TxError> {
    let mut reader = Reader::new(script);
    let mut stack: Vec<StackItem> = Vec::new();
    let mut calls: Vec<Call> = Vec::new();
    while reader.has_more() {
        let opcode = reader.u8()?;
        match opcode {
            OP_PUSHINT8..=OP_PUSHINT256 => {
                let width = 1usize << (opcode - OP_PUSHINT8);
                stack.push(StackItem::Integer(reader.bytes(width, "integer")?.to_vec()));
            }
            OP_PUSHT | OP_PUSHF => stack.push(StackItem::Bool(opcode == OP_PUSHT)),
            OP_PUSHNULL => stack.push(StackItem::Null),
            OP_PUSHDATA1..=OP_PUSHDATA4 => {
                let width = 1usize << (opcode - OP_PUSHDATA1);
                let length = reader.length(width, "byte string")?;
                stack.push(StackItem::ByteString(
                    reader.bytes(length, "byte string")?.to_vec(),
                ));
            }
            OP_PUSH0..=OP_PUSH16 => stack.push(StackItem::Integer(vec![opcode - OP_PUSH0])),
            OP_PACK => {
                let count = stack
                    .pop()
                    .and_then(|item| item.as_i128())
                    .ok_or(TxError::BadPack)?;
                if !(0..=MAX_PACK_ITEMS).contains(&count) || count as usize > stack.len() {
                    return Err(TxError::BadPack);
                }
                let start = stack.len() - count as usize;
                // `PACK` pops and appends, so array index 0 is the item on top
                // of the stack — the reverse of `split_off`'s push order. Scripts
                // push call arguments last-argument-first, so without this
                // reversal `transfer(from, to, amount, data)` would be read
                // with its `from` and `data` swapped.
                let mut items = stack.split_off(start);
                items.reverse();
                stack.push(StackItem::Array(items));
            }
            OP_SYSCALL => {
                let interop = reader.interop_hash()?;
                if interop != CONTRACT_CALL_INTEROP {
                    return Err(TxError::UnsupportedSyscall { interop });
                }
                calls.push(pop_call(&mut stack)?);
            }
            other => return Err(TxError::UnsupportedOpcode { opcode: other }),
        }
    }
    if calls.is_empty() {
        return Err(TxError::NoContractCalls);
    }
    Ok(calls)
}

const OP_PUSHINT8: u8 = 0x00;
const OP_PUSHINT256: u8 = 0x05;
const OP_PUSHT: u8 = 0x08;
const OP_PUSHF: u8 = 0x09;
const OP_PUSHNULL: u8 = 0x0b;
const OP_PUSHDATA1: u8 = 0x0c;
const OP_PUSHDATA4: u8 = 0x0e;
const OP_PUSH0: u8 = 0x10;
const OP_PUSH16: u8 = 0x20;
const OP_SYSCALL: u8 = 0x41;
const OP_PACK: u8 = 0xc0;

/// Pop `(contract, method, flags, args)` for one syscall. The script pushes the
/// args array first and the contract hash last, so the contract is on top.
fn pop_call(stack: &mut Vec<StackItem>) -> Result<Call, TxError> {
    let contract = stack
        .pop()
        .and_then(|item| item.script_hash())
        .ok_or(TxError::MalformedCall)?;
    let method = stack
        .pop()
        .and_then(|item| item.as_text().map(Vec::from))
        .ok_or(TxError::MalformedCall)?;
    let flags = stack
        .pop()
        .and_then(|item| item.as_i128())
        .ok_or(TxError::MalformedCall)?;
    let args = match stack.pop().ok_or(TxError::MalformedCall)? {
        StackItem::Array(items) => items,
        _ => return Err(TxError::MalformedCall),
    };
    let method = String::from_utf8(method).map_err(|_| TxError::InvalidUtf8 { field: "method" })?;
    let flags = u8::try_from(flags).map_err(|_| TxError::MalformedCall)?;
    Ok(Call {
        contract,
        method,
        flags,
        args,
    })
}

/// A bounds-checked cursor. Every read is checked against the *remaining input*
/// before anything is allocated, so a hostile length prefix costs a comparison
/// rather than a huge reservation.
struct Reader<'a> {
    data: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Reader { data, offset: 0 }
    }

    fn has_more(&self) -> bool {
        self.offset < self.data.len()
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], TxError> {
        let end = self
            .offset
            .checked_add(length)
            .filter(|end| *end <= self.data.len())
            .ok_or(TxError::Truncated)?;
        let slice = &self.data[self.offset..end];
        self.offset = end;
        Ok(slice)
    }

    fn u8(&mut self) -> Result<u8, TxError> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> Result<u32, TxError> {
        let bytes = self.take(4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn i64(&mut self) -> Result<i64, TxError> {
        let mut buf = [0u8; 8];
        buf.copy_from_slice(self.take(8)?);
        Ok(i64::from_le_bytes(buf))
    }

    fn bytes(&mut self, length: usize, field: &'static str) -> Result<&'a [u8], TxError> {
        self.take(length)
            .map_err(|_| TxError::LengthOutOfRange { field })
    }

    /// Read a length written as `width` little-endian bytes.
    fn length(&mut self, width: usize, field: &'static str) -> Result<usize, TxError> {
        let bytes = self
            .take(width)
            .map_err(|_| TxError::LengthOutOfRange { field })?;
        let mut value: u64 = 0;
        for (i, byte) in bytes.iter().enumerate() {
            value |= u64::from(*byte) << (8 * i);
        }
        usize::try_from(value).map_err(|_| TxError::LengthOutOfRange { field })
    }

    fn varint(&mut self, field: &'static str) -> Result<u64, TxError> {
        let first = self.u8()?;
        if first == 0xff {
            let bytes = self
                .take(8)
                .map_err(|_| TxError::LengthOutOfRange { field })?;
            let mut value: u64 = 0;
            for (i, byte) in bytes.iter().enumerate() {
                value |= u64::from(*byte) << (8 * i);
            }
            return Ok(value);
        }
        let width = match first {
            0xfd => 2,
            0xfe => 4,
            other => return Ok(u64::from(other)),
        };
        Ok(self.length(width, field)? as u64)
    }

    fn count(&mut self, field: &'static str, max: usize) -> Result<usize, TxError> {
        let value = self.varint(field)?;
        if value > max as u64 {
            return Err(TxError::CountOutOfRange { field, value });
        }
        // Cheap pre-check: the items cannot fit even at their minimum width.
        if value > (self.data.len() - self.offset) as u64 {
            return Err(TxError::CountOutOfRange { field, value });
        }
        Ok(value as usize)
    }

    fn varbytes(&mut self, field: &'static str, max: usize) -> Result<Vec<u8>, TxError> {
        let length = self.count(field, max)?;
        Ok(self.bytes(length, field)?.to_vec())
    }

    fn varstring(&mut self, field: &'static str, max: usize) -> Result<String, TxError> {
        let bytes = self.varbytes(field, max)?;
        String::from_utf8(bytes).map_err(|_| TxError::InvalidUtf8 { field })
    }

    fn hash160(&mut self) -> Result<[u8; HASH160_LEN], TxError> {
        let bytes = self.take(HASH160_LEN)?;
        let mut out = [0u8; HASH160_LEN];
        out.copy_from_slice(bytes);
        Ok(out)
    }

    fn interop_hash(&mut self) -> Result<[u8; 4], TxError> {
        let bytes = self.take(4).map_err(|_| TxError::IncompleteSyscall)?;
        let mut out = [0u8; 4];
        out.copy_from_slice(bytes);
        Ok(out)
    }

    fn signers(&mut self) -> Result<Vec<Signer>, TxError> {
        let count = self.count("signer", MAX_TRANSACTION_ATTRIBUTES)?;
        if count == 0 {
            return Err(TxError::NoSigners);
        }
        let mut signers = Vec::with_capacity(count);
        for _ in 0..count {
            let account = self.hash160()?;
            if signers.iter().any(|s: &Signer| s.account == account) {
                return Err(TxError::DuplicateSigner { account });
            }
            let scope = Scope::parse(self.u8()?)?;
            let mut allowed_contracts = Vec::new();
            if scope.has(Scope::CUSTOM_CONTRACTS) {
                let n = self.count("allowed contracts", MAX_SIGNER_SUBITEMS)?;
                for _ in 0..n {
                    allowed_contracts.push(self.hash160()?);
                }
            }
            let mut allowed_groups = Vec::new();
            if scope.has(Scope::CUSTOM_GROUPS) {
                let n = self.count("allowed groups", MAX_SIGNER_SUBITEMS)?;
                for _ in 0..n {
                    let bytes = self.take(33)?;
                    let mut group = [0u8; 33];
                    group.copy_from_slice(bytes);
                    allowed_groups.push(group);
                }
            }
            if scope.has(Scope::WITNESS_RULES) {
                return Err(TxError::WitnessRulesUnsupported);
            }
            signers.push(Signer {
                account,
                scope,
                allowed_contracts,
                allowed_groups,
            });
        }
        Ok(signers)
    }

    fn attributes(&mut self, signer_count: usize) -> Result<Vec<Attribute>, TxError> {
        let max = MAX_TRANSACTION_ATTRIBUTES.saturating_sub(signer_count);
        let count = self.count("attribute", max)?;
        let mut seen: Vec<u8> = Vec::with_capacity(count);
        let mut attributes = Vec::with_capacity(count);
        for _ in 0..count {
            let attribute_type = self.u8()?;
            // Mirrors the node's `AllowMultiple`: a transaction may carry more
            // than one `Conflicts`, and refusing such a transaction would mean
            // refusing work that is perfectly legal.
            let deduplicated = attribute_type != 0x21;
            if deduplicated && seen.contains(&attribute_type) {
                return Err(TxError::DuplicateAttribute { attribute_type });
            }
            if deduplicated {
                seen.push(attribute_type);
            }
            attributes.push(match attribute_type {
                0x01 => Attribute::HighPriority,
                0x20 => Attribute::NotValidBefore(self.u32()?),
                0x21 => {
                    let mut hash = [0u8; 32];
                    hash.copy_from_slice(self.take(32)?);
                    Attribute::Conflicts(hash)
                }
                other => {
                    return Err(TxError::UnknownAttribute {
                        attribute_type: other,
                    })
                }
            });
        }
        Ok(attributes)
    }

    fn finish(&self) -> Result<(), TxError> {
        if self.offset == self.data.len() {
            Ok(())
        } else {
            Err(TxError::TrailingBytes {
                offset: self.offset,
            })
        }
    }
}

/// Turn an operator-supplied hash into wire order. Accepts the `0x` prefix and
/// either case, because that is what people paste from explorers; rejects
/// anything that is not exactly 20 bytes, rather than guessing.
pub fn display_to_script_hash(value: &str) -> Option<[u8; HASH160_LEN]> {
    let trimmed = value.trim();
    let without_prefix = if trimmed.len() > 2 && trimmed.starts_with("0x") {
        &trimmed[2..]
    } else {
        trimmed
    };
    parse_display_hash(without_prefix)
}

/// Render a wire-order hash the way RPC and explorers display it.
pub fn script_hash_to_display(hash: &[u8]) -> String {
    let mut out = String::with_capacity(2 + hash.len() * 2);
    out.push_str("0x");
    for byte in hash.iter().rev() {
        out.push_str(&hex::encode([*byte]));
    }
    out
}

#[cfg(test)]
#[path = "../tests/unit/tx.rs"]
mod tests;
