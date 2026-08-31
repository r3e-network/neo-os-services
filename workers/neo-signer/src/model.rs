//! Entities the signer service stores and decides on.

use std::fmt;
use std::str::FromStr;

use crate::crypto;
use crate::network;
use crate::network::Network;
use crate::tx;
use crate::tx::HASH160_LEN;

/// A Neo N3 `UInt160` — an account or a contract — held in *wire* order.
///
/// The type exists because the two byte orders in play are indistinguishable
/// once they are in a `Vec<u8>`: RPC and explorers show a hash reversed
/// relative to the bytes that appear on the wire, and a policy list stored in
/// the wrong order simply never matches, which reads as "this contract is not
/// whitelisted" rather than as a bug. So a [`ScriptHash`] only ever holds wire
/// order, and its text form is always display order — what an operator pastes
/// and what an operator reads. There is no way to build one from a string
/// without going through that conversion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ScriptHash(pub [u8; HASH160_LEN]);

impl ScriptHash {
    /// Wrap bytes already in wire order — the order a parser read them out of a
    /// transaction.
    pub const fn from_wire(bytes: [u8; HASH160_LEN]) -> Self {
        ScriptHash(bytes)
    }

    /// The bytes as they appear on the wire.
    pub const fn as_bytes(self) -> [u8; HASH160_LEN] {
        self.0
    }

    /// Render as an explorer shows it: `0x` then the bytes reversed.
    pub fn to_display(self) -> String {
        tx::script_hash_to_display(&self.0)
    }
}

impl From<[u8; HASH160_LEN]> for ScriptHash {
    fn from(bytes: [u8; HASH160_LEN]) -> Self {
        ScriptHash(bytes)
    }
}

impl From<ScriptHash> for [u8; HASH160_LEN] {
    fn from(hash: ScriptHash) -> Self {
        hash.0
    }
}

impl fmt::Display for ScriptHash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_display())
    }
}

/// Why a pasted hash could not be used.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ScriptHashFormatError;

impl fmt::Display for ScriptHashFormatError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(
            "expected a script hash as 40 hex characters in display order, with an optional 0x prefix",
        )
    }
}

impl std::error::Error for ScriptHashFormatError {}

impl FromStr for ScriptHash {
    type Err = ScriptHashFormatError;

    /// Parse the display-order form. A bare 40-hex string is taken as display
    /// order too, because that is what an explorer shows when the `0x` is
    /// stripped; there is no way to tell the two apart, and guessing "wire"
    /// would silently invert every policy list.
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        tx::display_to_script_hash(value)
            .map(ScriptHash)
            .ok_or(ScriptHashFormatError)
    }
}

/// The functional boundaries attached to one custody key.
///
/// Two defaults are easy to confuse and both matter for safety:
///
/// * The three `allow_*` switches start **closed**. A key with no policy can
///   sign nothing, which is the direction a mistake is survivable in.
/// * An empty list means **no restriction**, not "nothing is permitted". A
///   blacklist is therefore only useful on its own, and a whitelist has to be
///   filled in deliberately — hence [`SignerPolicy::problems`] for the
///   half-configured combinations that would otherwise look like protection.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SignerPolicy {
    /// Sign dBFT consensus payloads.
    pub allow_consensus: bool,
    /// Sign NEP-17 `transfer` calls.
    pub allow_transfer: bool,
    /// Sign any contract call that is not a recognised transfer.
    pub allow_contract_call: bool,
    /// Accept a witness whose scope this key holds is `Global`. Off by
    /// default: a global witness can be spent by any contract, so the contract
    /// and asset lists below only describe the transaction in front of us, not
    /// the use the signature is eventually put to.
    pub allow_global_scope: bool,
    /// Contracts that may be called. Empty means any contract not denied below.
    pub contract_whitelist: Vec<ScriptHash>,
    /// Contracts that may never be called; wins over the whitelist.
    pub contract_blacklist: Vec<ScriptHash>,
    /// Token contracts this key may move. Empty means any token not denied.
    pub asset_whitelist: Vec<ScriptHash>,
    /// Token contracts this key may never move.
    pub asset_blacklist: Vec<ScriptHash>,
    /// Accounts that may receive a transfer.
    pub transfer_to_whitelist: Vec<ScriptHash>,
    /// Accounts that may never receive a transfer.
    pub transfer_to_blacklist: Vec<ScriptHash>,
    /// Ceiling on one transfer, in the token's own raw units.
    pub max_single_amount: Option<i128>,
    /// Rolling ceiling on the value moved out of this key.
    pub window_limit: Option<WindowLimit>,
}

/// A rolling window over which transferred value accumulates.
///
/// One struct rather than two optional fields on purpose: a ceiling with no
/// window, or a window with no ceiling, is a limit that silently does nothing.
///
/// The ceiling is **per token contract**, because raw token units are not
/// comparable across tokens — NEO counts whole tokens, GAS counts 1e8ths, and a
/// third token might use 1e6 — so summing them into one number would make the
/// limit mean something different every time it was read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowLimit {
    /// Length of the window, in seconds.
    pub seconds: u64,
    /// Most that may leave this key, per token, over the window.
    pub max_amount: i128,
}

impl SignerPolicy {
    /// Sort and de-duplicate the lists, so a policy round-tripped through the
    /// database compares equal to the one that was written.
    pub fn normalized(mut self) -> Self {
        for list in [
            &mut self.contract_whitelist,
            &mut self.contract_blacklist,
            &mut self.asset_whitelist,
            &mut self.asset_blacklist,
            &mut self.transfer_to_whitelist,
            &mut self.transfer_to_blacklist,
        ] {
            list.sort_unstable();
            list.dedup();
        }
        self
    }

    /// Configurations that look like a boundary but enforce nothing. The page
    /// shows these next to the form rather than refusing to save: an operator
    /// who means "no per-transfer ceiling" should be able to say so.
    pub fn problems(&self) -> Vec<PolicyProblem> {
        let mut problems = Vec::new();
        if !self.allow_transfer
            && (!self.asset_whitelist.is_empty()
                || !self.asset_blacklist.is_empty()
                || !self.transfer_to_whitelist.is_empty()
                || !self.transfer_to_blacklist.is_empty()
                || self.max_single_amount.is_some()
                || self.window_limit.is_some())
        {
            problems.push(PolicyProblem::TransferRulesWithoutTransfer);
        }
        if self.allow_contract_call && self.contract_whitelist.is_empty() {
            problems.push(PolicyProblem::ContractCallsUnbounded);
        }
        if self.allow_transfer && self.asset_whitelist.is_empty() {
            problems.push(PolicyProblem::TransfersWithoutAssetList);
        }
        if self.allow_global_scope {
            problems.push(PolicyProblem::GlobalScopeEnabled);
        }
        if self.max_single_amount.is_some_and(|ceiling| ceiling <= 0) {
            problems.push(PolicyProblem::ZeroAmountCeiling);
        }
        if self.window_limit.is_some_and(|limit| limit.max_amount <= 0) {
            problems.push(PolicyProblem::ZeroAmountCeiling);
        }
        problems.sort_by_key(|problem| problem.code());
        problems.dedup();
        problems
    }
}

/// A policy shape that is legal to store but weaker than it appears.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyProblem {
    /// Amount and recipient rules are set, but transfers are not allowed, so
    /// nothing will ever reach them.
    TransferRulesWithoutTransfer,
    /// Contract calls are allowed and no contract is named, so any contract
    /// this key is a signer for can be called.
    ContractCallsUnbounded,
    /// Transfers are allowed for any token contract.
    TransfersWithoutAssetList,
    /// Witnesses may be given `Global` scope.
    GlobalScopeEnabled,
    /// A ceiling of zero or less, which no positive transfer can satisfy.
    ZeroAmountCeiling,
}

impl PolicyProblem {
    /// Stable identifier for the page and the audit log.
    pub fn code(self) -> &'static str {
        match self {
            PolicyProblem::TransferRulesWithoutTransfer => "transfer-rules-without-transfer",
            PolicyProblem::ContractCallsUnbounded => "contract-calls-unbounded",
            PolicyProblem::TransfersWithoutAssetList => "transfers-without-asset-list",
            PolicyProblem::GlobalScopeEnabled => "global-scope-enabled",
            PolicyProblem::ZeroAmountCeiling => "zero-amount-ceiling",
        }
    }
}

impl fmt::Display for PolicyProblem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            PolicyProblem::TransferRulesWithoutTransfer => {
                "transfer limits are set but transfers are not allowed, so they will never be reached"
            }
            PolicyProblem::ContractCallsUnbounded => {
                "contract calls are allowed with no contract whitelist, so any called contract is accepted"
            }
            PolicyProblem::TransfersWithoutAssetList => {
                "transfers are allowed for any token contract, not only the listed ones"
            }
            PolicyProblem::GlobalScopeEnabled => {
                "global witness scope is allowed: the signature can be spent by contracts other than the one being signed"
            }
            PolicyProblem::ZeroAmountCeiling => {
                "an amount ceiling of zero or less can never be satisfied by a positive transfer"
            }
        };
        f.write_str(message)
    }
}

/// A private key held in custody — everything about the key except the key.
///
/// The plaintext private key is not a field on any type in this module, and the
/// only way to get one is [`crate::crypto::open_private_key`], which
/// hands back a `Zeroizing` buffer. That is deliberate: a struct that could be
/// cloned, formatted, or written to the audit log with a key inside it is one
/// `Debug` print away from leaking the thing the service exists to protect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignerKey {
    /// Stable identifier callers use to name this key.
    pub id: String,
    /// Operator-facing name.
    pub label: String,
    /// Which chain this key signs for. The magic is derived from it at signing
    /// time, so a caller can never ask for the same bytes to be signed on a
    /// different network.
    pub network: Network,
    /// Compressed public key, 33 bytes.
    pub public_key: [u8; 33],
    /// The AES-256-GCM envelope holding the private key.
    pub sealed: SealedPrivateKey,
    pub created_at_unix: u64,
    /// One-switch kill: a disabled key refuses every request without evaluating
    /// its policy, so an operator does not have to edit a policy to stop a key.
    pub disabled: bool,
}

impl SignerKey {
    /// The verification script of the single-signature account this key
    /// controls: `0c21 <pubkey> 41 56e7b327`.
    pub fn verification_script(&self) -> Vec<u8> {
        crypto::verification_script(&self.public_key)
    }

    /// The account — `HASH160(verification_script)` — in wire order.
    ///
    /// `None` would mean `public_key` is not a point on the curve, which cannot
    /// be true of a key this service stored. It is `Option` rather than an
    /// assertion so a corrupt row fails the request closed instead of being
    /// papered over with a zero hash that would silently match nothing.
    pub fn account(&self) -> Option<ScriptHash> {
        <[u8; HASH160_LEN]>::try_from(crypto::script_hash(&self.public_key).as_slice())
            .ok()
            .map(ScriptHash::from_wire)
    }

    /// The Neo address, as an operator reads it on an explorer.
    pub fn address(&self) -> String {
        crypto::address_from_script_hash(&crypto::script_hash(&self.public_key))
    }

    /// The chain's network magic, taken from the same table the config
    /// generators render — not restated here.
    pub fn network_magic(&self) -> u32 {
        network::network_magic(self.network)
    }
}

/// The sealed private key: the AEAD ciphertext and the nonce it was sealed
/// under, kept as one value because opening needs both and a mismatch between
/// rows reads as "wrong passphrase".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedPrivateKey {
    /// 12-byte AES-GCM nonce, random per key.
    pub nonce: [u8; 12],
    pub ciphertext: Vec<u8>,
}

/// Which custody keys a caller may ask for a signature from.
///
/// An enum rather than a list whose emptiness could mean two things: the policy
/// lists in [`SignerPolicy`] read "empty" as "unrestricted", and a caller grant
/// list that did the same would hand every key in the vault to whoever typed no
/// grants. So the permissive case has to be named.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyGrant {
    /// Any key in the vault, including keys created later.
    Any,
    /// Only these key ids. An empty list grants nothing, which is the
    /// construction to reach for when the grant has not been decided yet.
    Only(Vec<String>),
}

impl KeyGrant {
    /// Whether `key_id` may be requested under this grant.
    pub fn grants(&self, key_id: &str) -> bool {
        match self {
            KeyGrant::Any => true,
            KeyGrant::Only(ids) => ids.iter().any(|id| id == key_id),
        }
    }

    pub fn normalized(self) -> Self {
        match self {
            KeyGrant::Any => KeyGrant::Any,
            KeyGrant::Only(mut ids) => {
                ids.sort();
                ids.dedup();
                KeyGrant::Only(ids)
            }
        }
    }

    /// Stable discriminator for the stored column, paired with [`KeyGrant::from_mode`].
    pub fn mode(&self) -> &'static str {
        match self {
            KeyGrant::Any => "any",
            KeyGrant::Only(_) => "only",
        }
    }

    /// Rebuild the grant from its stored mode and id list.
    pub fn from_mode(mode: &str, ids: Vec<String>) -> Self {
        match mode {
            "any" => KeyGrant::Any,
            _ => KeyGrant::Only(ids),
        }
    }
}

/// What a caller is allowed to *do*, as opposed to which keys it may name
/// (see [`KeyGrant`]).
///
/// Two capabilities on one record rather than two credential stores, because a
/// second store is a second thing that can stop being checked. Signing callers
/// and console callers share this table, the digest comparison, the origin
/// binding and the disabled flag, and differ only in this field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum CallerCapability {
    /// Ask for a signature from a granted key.
    Sign,
    /// Create, import, disable or delete keys, edit boundaries, and provision
    /// other callers.
    Admin,
}

impl CallerCapability {
    pub const ALL: [Self; 2] = [Self::Sign, Self::Admin];

    pub fn label(self) -> &'static str {
        match self {
            Self::Sign => "sign",
            Self::Admin => "admin",
        }
    }
}

impl fmt::Display for CallerCapability {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.label())
    }
}

impl FromStr for CallerCapability {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|capability| capability.label() == value)
            .ok_or_else(|| anyhow::anyhow!("unsupported signer caller capability: {value}"))
    }
}

/// An authenticated user of the signing API: a dAPI backend, a relayer, a
/// partner service — not an operator with a browser session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignerCaller {
    pub id: String,
    pub label: String,
    /// SHA-256 of the bearer token. The token itself is never stored, so a
    /// database copy does not grant signing.
    pub token_digest: [u8; 32],
    pub key_grant: KeyGrant,
    /// What this caller may do. **Empty means it can do nothing** — not "every-
    /// thing", and not "whatever the request implies". A default-permissive
    /// reading of an unset list would turn a half-provisioned row into an admin
    /// credential, which is the failure this field exists to prevent.
    pub capabilities: Vec<CallerCapability>,
    /// Origins allowed to present this token. Empty means the caller is
    /// server-to-server and a request that arrives *with* a browser origin is
    /// refused — see [`crate::auth`].
    pub allowed_origins: Vec<String>,
    pub created_at_unix: u64,
    pub disabled: bool,
}

impl SignerCaller {
    pub fn has_capability(&self, required: CallerCapability) -> bool {
        self.capabilities.contains(&required)
    }

    pub fn normalized(mut self) -> Self {
        self.key_grant = self.key_grant.normalized();
        for origin in &mut self.allowed_origins {
            *origin = origin.trim().to_ascii_lowercase();
        }
        self.allowed_origins.sort();
        self.allowed_origins.dedup();
        self.capabilities.sort();
        self.capabilities.dedup();
        self
    }
}

/// What a row in the signer audit log records.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignerAuditAction {
    KeyGenerated,
    KeyImported,
    KeyDisabled,
    KeyEnabled,
    KeyDeleted,
    PolicySaved,
    CallerCreated,
    CallerRotated,
    CallerDisabled,
    CallerEnabled,
    CallerDeleted,
    KeyViewed,
    CallerViewed,
    AuditRead,
    TransactionSigned,
    ConsensusSigned,
    /// A token was presented that matches no caller. Recorded because it is
    /// the one event that shows someone probing the endpoint.
    UnknownToken,
}

impl SignerAuditAction {
    pub const ALL: [Self; 17] = [
        SignerAuditAction::KeyGenerated,
        SignerAuditAction::KeyImported,
        SignerAuditAction::KeyDisabled,
        SignerAuditAction::KeyEnabled,
        SignerAuditAction::KeyDeleted,
        SignerAuditAction::PolicySaved,
        SignerAuditAction::CallerCreated,
        SignerAuditAction::CallerRotated,
        SignerAuditAction::CallerDisabled,
        SignerAuditAction::CallerEnabled,
        SignerAuditAction::CallerDeleted,
        SignerAuditAction::KeyViewed,
        SignerAuditAction::CallerViewed,
        SignerAuditAction::AuditRead,
        SignerAuditAction::TransactionSigned,
        SignerAuditAction::ConsensusSigned,
        SignerAuditAction::UnknownToken,
    ];

    pub fn label(self) -> &'static str {
        match self {
            SignerAuditAction::KeyGenerated => "signer-key-generated",
            SignerAuditAction::KeyImported => "signer-key-imported",
            SignerAuditAction::KeyDisabled => "signer-key-disabled",
            SignerAuditAction::KeyEnabled => "signer-key-enabled",
            SignerAuditAction::KeyDeleted => "signer-key-deleted",
            SignerAuditAction::PolicySaved => "signer-policy-saved",
            SignerAuditAction::CallerCreated => "signer-caller-created",
            SignerAuditAction::CallerRotated => "signer-caller-rotated",
            SignerAuditAction::CallerDisabled => "signer-caller-disabled",
            SignerAuditAction::CallerEnabled => "signer-caller-enabled",
            SignerAuditAction::CallerDeleted => "signer-caller-deleted",
            SignerAuditAction::KeyViewed => "signer-key-viewed",
            SignerAuditAction::CallerViewed => "signer-caller-viewed",
            SignerAuditAction::AuditRead => "signer-audit-read",
            SignerAuditAction::TransactionSigned => "signer-transaction-signed",
            SignerAuditAction::ConsensusSigned => "signer-consensus-signed",
            SignerAuditAction::UnknownToken => "signer-unknown-token",
        }
    }
}

impl fmt::Display for SignerAuditAction {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.label())
    }
}

impl FromStr for SignerAuditAction {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|action| action.label() == value)
            .ok_or_else(|| anyhow::anyhow!("unsupported signer audit action: {value}"))
    }
}

/// Whether a request was honoured, refused on purpose, or failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignerAuditOutcome {
    Allowed,
    Denied,
    /// Something broke rather than the policy saying no: unparseable bytes, a
    /// sealed key that will not open, a database error.
    Failed,
}

impl SignerAuditOutcome {
    pub fn label(self) -> &'static str {
        match self {
            SignerAuditOutcome::Allowed => "allowed",
            SignerAuditOutcome::Denied => "denied",
            SignerAuditOutcome::Failed => "failed",
        }
    }
}

impl fmt::Display for SignerAuditOutcome {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.label())
    }
}

impl FromStr for SignerAuditOutcome {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "allowed" => Ok(SignerAuditOutcome::Allowed),
            "denied" => Ok(SignerAuditOutcome::Denied),
            "failed" => Ok(SignerAuditOutcome::Failed),
            other => anyhow::bail!("unsupported signer audit outcome: {other}"),
        }
    }
}

/// One audited event: a signing request, a custody change, or a caller change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignerAuditRecord {
    pub id: i64,
    pub recorded_at_unix: u64,
    pub action: SignerAuditAction,
    pub outcome: SignerAuditOutcome,
    /// The caller whose request produced this row. `None` when the request
    /// carried no token that matched a caller — the only rows without one are
    /// `UnknownToken` and a store failure that happened before identification,
    /// because a custody change made through the management API names the
    /// credential that made it.
    pub caller_id: Option<String>,
    pub key_id: Option<String>,
    /// Display-order hash of the bytes that were signed, so an operator can
    /// find the transaction later. `None` when nothing was parsed.
    pub tx_id: Option<String>,
    /// Stable code: a [`crate::policy::DenyReason`], an
    /// [`crate::auth::AccessRejection`], or a service guard.
    pub reason: Option<String>,
    /// Bounded, redacted specifics — hashes and amounts, never key material.
    pub detail: Option<String>,
    /// The normalized `Origin` the request arrived from, if any.
    pub origin: Option<String>,
}

/// Value that left a custody key, recorded so the rolling window survives a
/// restart.
///
/// This is a ledger rather than a counter because the counter has to be
/// recomputable: `signer_policies` can be edited at any time, and a window
/// derived from the edits would move the answer whenever an operator changed
/// the config. Summing these rows over the window answers the question the
/// policy actually asks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignerValueEvent {
    pub id: i64,
    pub key_id: String,
    pub recorded_at_unix: u64,
    /// Token contract, wire order.
    pub asset: ScriptHash,
    pub amount: i128,
    /// The audit row that authorised this movement, when there was one.
    pub audit_id: Option<i64>,
}

#[cfg(test)]
#[path = "../tests/unit/model.rs"]
mod tests;
