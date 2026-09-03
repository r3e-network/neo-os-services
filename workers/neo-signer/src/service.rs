//! The custody service: what the pages and the signing endpoints call.
//!
//! Everything that has to happen in a fixed order happens here, once, so no
//! caller can assemble a shorter version by accident. The signing path is the
//! same sequence every time — identify the caller, read the record, run the
//! guards, evaluate the policy, sign, then write the audit row and the ledger —
//! and the reason the audit row is written before the witness is handed back
//! rather than after is that a signature nobody logged is a signature nobody can
//! account for later. An audit or ledger write that fails therefore aborts the
//! request: the witness is dropped, nothing is returned, and the caller gets a
//! server error rather than a signature the vault cannot explain.
//!
//! Two surfaces meet here, and both are authenticated by [`CallerCredentials`]:
//!
//! * The management surface ([`SignerService::generate_key`],
//!   [`SignerService::save_policy`], [`SignerService::create_caller`] and the
//!   rest) needs a caller holding `admin` plus a whole-vault grant, and writes an
//!   audit row naming the caller that made the change.
//! * The caller surface ([`SignerService::sign_transaction`],
//!   [`SignerService::sign_consensus`], [`SignerService::key_info`]) needs `sign`
//!   plus a grant for the key it names.
//!
//! Neither trusts anything the caller says about itself: the token, the origin,
//! the capabilities and the key grant all come from the vault. That is why no
//! method here takes a session, an operator flag or a "this one is local"
//! parameter — a management call that could be made without a credential would
//! be a management call any consumer could make, which is the boundary this
//! service exists to close.
//!
//! One write path has no credentials by design:
//! [`provision_admin_caller`], which seeds the first `admin` row into an empty
//! table. It is reachable only from code that already holds the [`Store`] and
//! therefore the whole database anyway, which is the same trust root as the
//! master key file.
//!
//! Only the two import paths accept a private key, and both seal it under the
//! master key and drop the plaintext as they return.

use std::{
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::{
    audit::{self, GuardRejection, Refusal},
    auth::{self, AccessRejection, CallerCredentials},
    crypto,
    model::{
        CallerCapability, KeyGrant, ScriptHash, SignerAuditAction, SignerAuditOutcome,
        SignerAuditRecord, SignerCaller, SignerConsensusReservation, SignerKey, SignerPolicy,
        SignerRequestCompletion, SignerValueEvent, WorkloadIdentity,
    },
    network::{self, Network},
    policy::{self, AssetWindowSpend, SigningRequest, WindowSpend},
    store::Store,
    tx::{self, ConsensusPayload, DbftCommitment, Intent, UnsignedTransaction},
    vault::MasterKey,
};

/// A caller-facing answer: either what was asked for, or a refusal carrying the
/// code and message that are safe to send back.
///
/// One enum for signing and for key lookup, because both fail the same way — a
/// caller not entitled to ask — and a handler that has to remember two shapes is
/// how one of them ends up replying `200` with nothing in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome<T> {
    /// Granted, with the payload that is safe to send to this caller.
    Allowed(T),
    /// Refused, with a stable code.
    Refused(Refusal),
}

/// The witness a single-signature account needs, in the form a caller assembles
/// into a transaction or a consensus payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedWitness {
    pub key_id: String,
    pub script_hash: ScriptHash,
    pub address: String,
    /// `SHA256` of the bytes that were signed, in display order. For a
    /// transaction this is the id an explorer shows; for a consensus payload it
    /// is the same digest, which is still the only way to find the row again.
    pub digest: String,
    /// `0c 40 <64B r||s>`.
    pub invocation: Vec<u8>,
    /// `0c 21 <33B pubkey> 41 56e7b327`.
    pub verification: Vec<u8>,
}

/// What a caller may learn about a key it is granted.
///
/// A purpose-built type rather than [`SignerKey`], because `SignerKey` carries
/// the sealed envelope: handing that struct to a serializer is how a custody
/// service publishes ciphertext of its own private keys. This one holds no key
/// material of any kind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyPublicInfo {
    pub key_id: String,
    pub label: String,
    pub network: Network,
    /// The magic the key's signatures commit to, as bound at custody time.
    /// Surfaced so an operator can confirm a private-network key carries its
    /// chain's real identity rather than the default.
    pub network_magic: u32,
    pub public_key: [u8; 33],
    pub script_hash: ScriptHash,
    pub address: String,
    pub verification_script: Vec<u8>,
    /// False when the operator's kill switch is on, so a caller can tell
    /// "signing will be refused" apart from "the service is broken" before it
    /// asks.
    pub signing_enabled: bool,
}

pub type SignResponse = Outcome<SignedWitness>;
pub type InfoResponse = Outcome<KeyPublicInfo>;

impl<T> Outcome<T> {
    /// Transform the answer, leave the refusal alone.
    ///
    /// The transport needs this because what a method returns is a domain type
    /// and what a route sends is a wire type, and the two halves of an `Outcome`
    /// have to stay one value: a handler that destructured it to remap the
    /// success is a handler that can forget the denial and answer `200` with
    /// nothing in it.
    pub fn map<U>(self, transform: impl FnOnce(T) -> U) -> Outcome<U> {
        match self {
            Outcome::Allowed(value) => Outcome::Allowed(transform(value)),
            Outcome::Refused(refusal) => Outcome::Refused(refusal),
        }
    }
}

/// What a caller record looks like to the management API.
///
/// The same reason [`KeyPublicInfo`] exists: [`SignerCaller`] carries the token
/// digest, and a service that hands that struct to a serializer has published a
/// third-party-verifiable copy of every credential in the vault — not the token,
/// but enough to confirm a guessed one. This type holds everything an operator
/// needs to manage a caller and nothing that can be checked against one, which
/// is why the create and list routes return it rather than the row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallerInfo {
    pub id: String,
    pub label: String,
    pub auth_mode: String,
    pub workload_public_key: Option<String>,
    pub workload_subject: Option<String>,
    pub key_grant: KeyGrant,
    pub capabilities: Vec<CallerCapability>,
    pub allowed_origins: Vec<String>,
    pub created_at_unix: u64,
    pub disabled: bool,
}

impl From<&SignerCaller> for CallerInfo {
    fn from(caller: &SignerCaller) -> Self {
        CallerInfo {
            id: caller.id.clone(),
            label: caller.label.clone(),
            auth_mode: if caller.workload_identity.is_some() {
                "workload-ed25519".to_string()
            } else {
                "bearer".to_string()
            },
            workload_public_key: caller
                .workload_identity
                .as_ref()
                .map(|identity| hex::encode(identity.public_key)),
            workload_subject: caller
                .workload_identity
                .as_ref()
                .and_then(|identity| identity.subject.clone()),
            key_grant: caller.key_grant.clone(),
            capabilities: caller.capabilities.clone(),
            allowed_origins: caller.allowed_origins.clone(),
            created_at_unix: caller.created_at_unix,
            disabled: caller.disabled,
        }
    }
}

/// Provisioning input for an Ed25519 workload caller.
pub struct WorkloadCallerSpec<'a> {
    pub label: &'a str,
    pub key_grant: KeyGrant,
    pub capabilities: &'a [CallerCapability],
    pub allowed_origins: &'a [String],
    pub public_key: [u8; 32],
    pub subject: Option<&'a str>,
}

/// The custody service. `Clone` like the other workspace handles — the master
/// key is resolved once at start-up and shared, so a request that clones the
/// service does not put a second copy of key material on the heap.
///
/// Deliberately not `Debug`. `MasterKey` implements no `Debug` at all, and a
/// service that redacted one field from a struct print would be one forgotten
/// `{:?}` away from publishing the thing it exists to protect.
#[derive(Clone)]
pub struct SignerService {
    repository: Store,
    master_key: Arc<MasterKey>,
    /// Serializes every decision that can change what a key may do.
    ///
    /// The store opens a fresh SQLite connection per operation. Without one
    /// shared lock, two signing threads can both read the same rolling-window
    /// total, both pass, and only then append their spends. Keeping the lock on
    /// the cloned service also orders policy edits, caller revocation and key
    /// kill-switch changes against signing.
    decision_lock: Arc<Mutex<()>>,
}

/// Which bytes a signing request covers, and whether value moved afterwards.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RequestKind {
    Transaction,
    Consensus,
    Raw,
}

/// Whether a caller got past identification and authorization.
enum Access {
    Granted(SignerCaller),
    /// A token that matched no caller at all. Its own variant because its own
    /// audit action: an unmatched token is someone probing the endpoint, while a
    /// matched token that is refused was a caller whose request went wrong, and
    /// an operator scanning the log needs those two separated without reading
    /// every reason code.
    Unknown(Refusal),
    /// Identified, or not identified for a reason the caller should hear. The
    /// caller is kept when there was one: a refusal is the one event where the
    /// audit row matters most, and "this caller asked and was told no" is only
    /// actionable if it names the caller.
    Refused(Option<SignerCaller>, Refusal),
}

/// Bytes the policy is about to judge, owned so the request the policy sees and
/// the bytes the signature covers cannot drift apart mid-request.
enum Parsed {
    Transaction {
        transaction: UnsignedTransaction,
        intents: Vec<Intent>,
    },
    Consensus {
        payload: ConsensusPayload,
    },
    /// Raw bytes: nothing to decode, so the policy decides on the switch
    /// alone.
    Raw,
}

impl Parsed {
    /// The request shape [`policy::evaluate`] decides on.
    fn request(&self) -> SigningRequest<'_> {
        match self {
            Parsed::Transaction {
                transaction,
                intents,
            } => SigningRequest::Transaction {
                transaction,
                intents,
            },
            Parsed::Consensus { payload } => SigningRequest::Consensus { payload },
            Parsed::Raw => SigningRequest::Raw,
        }
    }
}

/// A request that reached the end of the signing path with permission.
struct Approved {
    witness: SignedWitness,
    kind: RequestKind,
    intents: Vec<Intent>,
    consensus: Option<SignerConsensusReservation>,
}

impl SignerService {
    /// Wrap a repository and a master key the caller already resolved.
    pub fn new(repository: Store, master_key: MasterKey) -> Self {
        Self {
            repository,
            master_key: Arc::new(master_key),
            decision_lock: Arc::new(Mutex::new(())),
        }
    }

    /// Build the service for a workspace, resolving the master key against
    /// `data_dir` — see [`crate::vault`].
    pub fn open(repository: Store, data_dir: &Path) -> Result<Self> {
        Ok(Self::new(repository, MasterKey::open(data_dir)?))
    }

    /// The workspace store, for the list queries a page makes beside signing.
    pub fn repository(&self) -> &Store {
        &self.repository
    }

    /// Identify the vault without revealing it, so an operator can confirm two
    /// deployments opened the same master key.
    pub fn vault_fingerprint(&self) -> String {
        self.master_key.fingerprint()
    }

    /// Enter the process-wide decision critical section.
    ///
    /// A poisoned lock means a previous decision panicked while it held the
    /// boundary. Continuing would make the next request guess which writes
    /// completed, so the only safe answer is a service failure.
    fn lock_decision(&self) -> Result<MutexGuard<'_, ()>> {
        self.decision_lock.lock().map_err(|_| {
            anyhow::anyhow!(
                "the signer decision lock is poisoned; restart before signing or changing policy"
            )
        })
    }

    // -- custody: keys ------------------------------------------------------

    /// Create a fresh key and store it sealed.
    ///
    /// `network_magic` names the chain identity for a private network whose real
    /// magic is not the default; `None` takes the canonical value for `network`.
    pub fn generate_key(
        &self,
        credentials: &CallerCredentials,
        label: &str,
        network: Network,
        network_magic: Option<u32>,
    ) -> Result<Outcome<KeyPublicInfo>> {
        let _decision = self.lock_decision()?;
        let caller = match self.admin_caller(credentials, SignerAuditAction::KeyGenerated, None)? {
            Ok(caller) => caller,
            Err(refusal) => return Ok(Outcome::Refused(refusal)),
        };
        let private_key = crypto::generate_private_key();
        self.store_key(
            credentials,
            &caller,
            KeyRequest {
                label,
                network,
                requested_magic: network_magic,
                action: SignerAuditAction::KeyGenerated,
            },
            &private_key,
        )
    }

    /// Take custody of a raw hexadecimal private key.
    pub fn import_key(
        &self,
        credentials: &CallerCredentials,
        label: &str,
        network: Network,
        network_magic: Option<u32>,
        private_key: &str,
    ) -> Result<Outcome<KeyPublicInfo>> {
        let _decision = self.lock_decision()?;
        let caller = match self.admin_caller(credentials, SignerAuditAction::KeyImported, None)? {
            Ok(caller) => caller,
            Err(refusal) => return Ok(Outcome::Refused(refusal)),
        };
        let parsed = match parse_raw_private_key(private_key) {
            Ok(parsed) => parsed,
            Err(message) => {
                return self.reject_invalid(
                    credentials,
                    &caller,
                    SignerAuditAction::KeyImported,
                    None,
                    &message,
                )
            }
        };
        self.store_key(
            credentials,
            &caller,
            KeyRequest {
                label,
                network,
                requested_magic: network_magic,
                action: SignerAuditAction::KeyImported,
            },
            &parsed,
        )
    }

    /// Take custody of a NEP-2 (`6P…`) key and its passphrase.
    ///
    /// The passphrase decrypts in memory, the plaintext is sealed under the
    /// vault key, and nothing here can export it again — which is the difference
    /// between custody and storage.
    pub fn import_nep2_key(
        &self,
        credentials: &CallerCredentials,
        label: &str,
        network: Network,
        network_magic: Option<u32>,
        nep2: &str,
        passphrase: &str,
    ) -> Result<Outcome<KeyPublicInfo>> {
        let _decision = self.lock_decision()?;
        let caller = match self.admin_caller(credentials, SignerAuditAction::KeyImported, None)? {
            Ok(caller) => caller,
            Err(refusal) => return Ok(Outcome::Refused(refusal)),
        };
        let parsed = match crypto::decrypt_nep2(nep2.trim(), passphrase)
            .map_err(|error| error.to_string())
            .and_then(|decrypted| {
                <[u8; 32]>::try_from(decrypted.as_slice())
                    .map_err(|_| "the NEP-2 key decrypted to the wrong length".to_string())
            }) {
            Ok(private_key) => Zeroizing::new(private_key),
            Err(message) => {
                return self.reject_invalid(
                    credentials,
                    &caller,
                    SignerAuditAction::KeyImported,
                    None,
                    &message,
                )
            }
        };
        self.store_key(
            credentials,
            &caller,
            KeyRequest {
                label,
                network,
                requested_magic: network_magic,
                action: SignerAuditAction::KeyImported,
            },
            &parsed,
        )
    }

    /// The kill switch, audited.
    pub fn set_key_disabled(
        &self,
        credentials: &CallerCredentials,
        id: &str,
        disabled: bool,
    ) -> Result<Outcome<KeyPublicInfo>> {
        let _decision = self.lock_decision()?;
        let action = if disabled {
            SignerAuditAction::KeyDisabled
        } else {
            SignerAuditAction::KeyEnabled
        };
        let caller = match self.admin_caller(credentials, action, Some(id))? {
            Ok(caller) => caller,
            Err(refusal) => return Ok(Outcome::Refused(refusal)),
        };
        if self.custody_row(id)?.is_none() {
            return self.deny(credentials, &caller, action, Some(id), &unknown_key(id));
        }
        self.repository.set_signer_key_disabled(id, disabled)?;
        let key = self.repository.get_signer_key(id)?;
        self.record_entry(admin_entry(
            credentials,
            &caller,
            action,
            Some(id.to_string()),
            format!(
                "{} ({}) {}",
                key.address(),
                key.label,
                if disabled {
                    "switched off"
                } else {
                    "switched on"
                }
            ),
        )?)?;
        match identity(&key) {
            Err(refusal) => self.deny(credentials, &caller, action, Some(id), &refusal),
            Ok(info) => Ok(Outcome::Allowed(info)),
        }
    }

    /// Drop a key. Its audit rows and ledger rows survive deliberately — see
    /// [`Store::delete_signer_key`].
    pub fn delete_key(&self, credentials: &CallerCredentials, id: &str) -> Result<Outcome<()>> {
        let _decision = self.lock_decision()?;
        let caller =
            match self.admin_caller(credentials, SignerAuditAction::KeyDeleted, Some(id))? {
                Ok(caller) => caller,
                Err(refusal) => return Ok(Outcome::Refused(refusal)),
            };
        let key = match self.custody_row(id)? {
            Some(key) => key,
            None => {
                return self.deny(
                    credentials,
                    &caller,
                    SignerAuditAction::KeyDeleted,
                    Some(id),
                    &unknown_key(id),
                )
            }
        };
        self.repository.delete_signer_key(id)?;
        self.record_entry(admin_entry(
            credentials,
            &caller,
            SignerAuditAction::KeyDeleted,
            Some(id.to_string()),
            format!("{} ({}) released from custody", key.address(), key.label),
        )?)?;
        Ok(Outcome::Allowed(()))
    }

    /// Replace a key's boundary and audit what the new one commits to.
    ///
    /// Returns the normalized policy rather than the one passed in: the page has
    /// to show what was stored, and a whitelist that dropped a duplicate entry
    /// should look different once rather than forever.
    pub fn save_policy(
        &self,
        credentials: &CallerCredentials,
        id: &str,
        policy: &SignerPolicy,
    ) -> Result<Outcome<SignerPolicy>> {
        let _decision = self.lock_decision()?;
        let caller =
            match self.admin_caller(credentials, SignerAuditAction::PolicySaved, Some(id))? {
                Ok(caller) => caller,
                Err(refusal) => return Ok(Outcome::Refused(refusal)),
            };
        if self.custody_row(id)?.is_none() {
            return self.deny(
                credentials,
                &caller,
                SignerAuditAction::PolicySaved,
                Some(id),
                &unknown_key(id),
            );
        }
        if policy.mixes_raw_and_semantic_authority() {
            return self.reject_invalid(
                credentials,
                &caller,
                SignerAuditAction::PolicySaved,
                Some(id),
                "allow_raw requires a dedicated raw-only key and cannot be combined with consensus, transfer, contract-call, or global authority",
            );
        }
        let stored = policy.clone().normalized();
        self.repository
            .save_signer_policy(id, &stored, now_unix()?)?;
        self.record_entry(SignerAuditRecord {
            origin: credentials.origin_label(),
            caller_id: Some(caller.id),
            key_id: Some(id.to_string()),
            ..entry(SignerAuditAction::PolicySaved, policy_summary(&stored))?
        })?;
        Ok(Outcome::Allowed(stored))
    }

    /// Read a custody row without deciding anything about it.
    fn custody_row(&self, id: &str) -> Result<Option<SignerKey>> {
        self.repository.find_signer_key(id)
    }

    // -- custody: callers ---------------------------------------------------

    /// Add a caller and return its token.
    ///
    /// The plaintext token exists once, here. The row holds only its digest, so a
    /// copied database cannot sign; an operator who loses the token rotates it.
    pub fn create_caller(
        &self,
        credentials: &CallerCredentials,
        label: &str,
        grant: KeyGrant,
        capabilities: &[CallerCapability],
        origins: &[String],
    ) -> Result<Outcome<(CallerInfo, String)>> {
        let _decision = self.lock_decision()?;
        let caller = match self.admin_caller(credentials, SignerAuditAction::CallerCreated, None)? {
            Ok(caller) => caller,
            Err(refusal) => return Ok(Outcome::Refused(refusal)),
        };
        // Checked before the token exists: minting a credential for a request
        // that will be refused is a stray secret in the process's memory.
        //
        // Exactly one, and named — not "at least one". A record holding both would
        // be a single string that can both ask for a signature and move the
        // boundary that decides it, which is the separation §5.1 exists to keep
        // and which no per-route check can undo afterwards. An empty list would be
        // a credential that answers `admin-capability-missing` forever, and since
        // capabilities are never edited there is no later request that makes it
        // useful.
        let capabilities = match single_capability(capabilities) {
            Some(capabilities) => capabilities,
            None => {
                return self.reject_invalid(
                    credentials,
                    &caller,
                    SignerAuditAction::CallerCreated,
                    None,
                    "capabilities must name exactly one of sign, raw_sign or admin",
                )
            }
        };
        let token = auth::generate_token();
        let created = SignerCaller {
            id: format!("caller-{}", Uuid::new_v4()),
            label: match operator_label(label) {
                Ok(label) => label,
                Err(error) => {
                    return self.reject_invalid(
                        credentials,
                        &caller,
                        SignerAuditAction::CallerCreated,
                        None,
                        &error.to_string(),
                    )
                }
            },
            token_digest: auth::token_digest(&token),
            workload_identity: None,
            key_grant: grant,
            capabilities,
            allowed_origins: match normalize_origins(origins) {
                Ok(origins) => origins,
                Err(error) => {
                    return self.reject_invalid(
                        credentials,
                        &caller,
                        SignerAuditAction::CallerCreated,
                        None,
                        &error.to_string(),
                    )
                }
            },
            created_at_unix: now_unix()?,
            disabled: false,
        }
        .normalized();
        self.repository.create_signer_caller(&created)?;
        self.record_entry(SignerAuditRecord {
            origin: credentials.origin_label(),
            caller_id: Some(caller.id),
            ..entry(SignerAuditAction::CallerCreated, caller_summary(&created))?
        })?;
        Ok(Outcome::Allowed((CallerInfo::from(&created), token)))
    }

    /// Add an Ed25519 proof-of-possession caller without minting a bearer
    /// secret.
    pub fn create_workload_caller(
        &self,
        credentials: &CallerCredentials,
        spec: WorkloadCallerSpec<'_>,
    ) -> Result<Outcome<CallerInfo>> {
        let _decision = self.lock_decision()?;
        let caller = match self.admin_caller(credentials, SignerAuditAction::CallerCreated, None)? {
            Ok(caller) => caller,
            Err(refusal) => return Ok(Outcome::Refused(refusal)),
        };
        let capabilities = match single_capability(spec.capabilities) {
            Some(capabilities) => capabilities,
            None => {
                return self.reject_invalid(
                    credentials,
                    &caller,
                    SignerAuditAction::CallerCreated,
                    None,
                    "capabilities must name exactly one of sign or admin",
                )
            }
        };
        if !auth::workload_public_key_is_valid(&spec.public_key) {
            return self.reject_invalid(
                credentials,
                &caller,
                SignerAuditAction::CallerCreated,
                None,
                "workload_public_key must be a valid Ed25519 public key",
            );
        }
        let subject = match normalize_subject(spec.subject) {
            Ok(subject) => subject,
            Err(error) => {
                return self.reject_invalid(
                    credentials,
                    &caller,
                    SignerAuditAction::CallerCreated,
                    None,
                    &error.to_string(),
                )
            }
        };
        // A random digest with no corresponding token keeps the legacy
        // NOT-NULL column inert for workload rows migrated from v1.
        let unreachable_token = auth::generate_token();
        let created = SignerCaller {
            id: format!("caller-{}", Uuid::new_v4()),
            label: match operator_label(spec.label) {
                Ok(label) => label,
                Err(error) => {
                    return self.reject_invalid(
                        credentials,
                        &caller,
                        SignerAuditAction::CallerCreated,
                        None,
                        &error.to_string(),
                    )
                }
            },
            token_digest: auth::token_digest(&unreachable_token),
            workload_identity: Some(WorkloadIdentity {
                public_key: spec.public_key,
                subject,
            }),
            key_grant: spec.key_grant,
            capabilities,
            allowed_origins: match normalize_origins(spec.allowed_origins) {
                Ok(origins) => origins,
                Err(error) => {
                    return self.reject_invalid(
                        credentials,
                        &caller,
                        SignerAuditAction::CallerCreated,
                        None,
                        &error.to_string(),
                    )
                }
            },
            created_at_unix: now_unix()?,
            disabled: false,
        }
        .normalized();
        self.repository.create_signer_caller(&created)?;
        self.record_entry(SignerAuditRecord {
            origin: credentials.origin_label(),
            caller_id: Some(caller.id),
            ..entry(SignerAuditAction::CallerCreated, caller_summary(&created))?
        })?;
        Ok(Outcome::Allowed(CallerInfo::from(&created)))
    }

    /// Issue a new token for an existing caller, invalidating the old one.
    ///
    /// A rotation changes the credential and nothing else: the new holder gets
    /// exactly the capabilities and grants of the row it replaces, so rotating a
    /// signing caller cannot quietly produce an admin one.
    pub fn rotate_caller_token(
        &self,
        credentials: &CallerCredentials,
        id: &str,
    ) -> Result<Outcome<String>> {
        let _decision = self.lock_decision()?;
        let caller = match self.admin_caller(credentials, SignerAuditAction::CallerRotated, None)? {
            Ok(caller) => caller,
            Err(refusal) => return Ok(Outcome::Refused(refusal)),
        };
        let rotated = match self.caller_row(id)? {
            Some(rotated) => rotated,
            None => {
                return self.deny(
                    credentials,
                    &caller,
                    SignerAuditAction::CallerRotated,
                    None,
                    &unknown_caller(id),
                )
            }
        };
        if rotated.workload_identity.is_some() {
            return self.reject_invalid(
                credentials,
                &caller,
                SignerAuditAction::CallerRotated,
                None,
                "workload callers use a pinned Ed25519 key and cannot rotate a bearer token",
            );
        }
        let token = auth::generate_token();
        self.repository
            .set_signer_caller_digest(id, &auth::token_digest(&token))?;
        self.record_entry(SignerAuditRecord {
            origin: credentials.origin_label(),
            caller_id: Some(caller.id),
            ..entry(SignerAuditAction::CallerRotated, rotated.label)?
        })?;
        Ok(Outcome::Allowed(token))
    }

    /// Enable or disable a caller.
    pub fn set_caller_disabled(
        &self,
        credentials: &CallerCredentials,
        id: &str,
        disabled: bool,
    ) -> Result<Outcome<CallerInfo>> {
        let _decision = self.lock_decision()?;
        let action = if disabled {
            SignerAuditAction::CallerDisabled
        } else {
            SignerAuditAction::CallerEnabled
        };
        let caller = match self.admin_caller(credentials, action, None)? {
            Ok(caller) => caller,
            Err(refusal) => return Ok(Outcome::Refused(refusal)),
        };
        if self.caller_row(id)?.is_none() {
            return self.deny(credentials, &caller, action, None, &unknown_caller(id));
        }
        self.repository.set_signer_caller_disabled(id, disabled)?;
        let updated = self.repository.get_signer_caller(id)?;
        self.record_entry(SignerAuditRecord {
            origin: credentials.origin_label(),
            caller_id: Some(caller.id),
            ..entry(
                action,
                format!(
                    "{} {}",
                    updated.label,
                    if disabled { "disabled" } else { "enabled" }
                ),
            )?
        })?;
        Ok(Outcome::Allowed(CallerInfo::from(&updated)))
    }

    /// Retire a caller. Its audit rows survive — see [`Store::delete_signer_caller`].
    pub fn delete_caller(&self, credentials: &CallerCredentials, id: &str) -> Result<Outcome<()>> {
        let _decision = self.lock_decision()?;
        let caller = match self.admin_caller(credentials, SignerAuditAction::CallerDeleted, None)? {
            Ok(caller) => caller,
            Err(refusal) => return Ok(Outcome::Refused(refusal)),
        };
        let deleted = match self.caller_row(id)? {
            Some(deleted) => deleted,
            None => {
                return self.deny(
                    credentials,
                    &caller,
                    SignerAuditAction::CallerDeleted,
                    None,
                    &unknown_caller(id),
                )
            }
        };
        self.repository.delete_signer_caller(id)?;
        self.record_entry(SignerAuditRecord {
            origin: credentials.origin_label(),
            // The acting caller, not the one being deleted: the row answers "who
            // did this", and naming the retired caller would read as if it had
            // retired itself.
            caller_id: Some(caller.id),
            ..entry(SignerAuditAction::CallerDeleted, deleted.label)?
        })?;
        Ok(Outcome::Allowed(()))
    }

    fn caller_row(&self, id: &str) -> Result<Option<SignerCaller>> {
        self.repository.find_signer_caller(id)
    }

    // -- management reads ---------------------------------------------------

    /// Every key in the vault, as its public identity.
    pub fn list_keys(
        &self,
        credentials: &CallerCredentials,
    ) -> Result<Outcome<Vec<KeyPublicInfo>>> {
        let action = SignerAuditAction::KeyViewed;
        let caller = match self.admin_caller(credentials, action, None)? {
            Ok(caller) => caller,
            Err(refusal) => return Ok(Outcome::Refused(refusal)),
        };
        let mut keys = Vec::new();
        for key in self.repository.list_signer_keys()? {
            match identity(&key) {
                Ok(info) => keys.push(info),
                // Loud rather than skipped: an operator inventorying the vault has
                // to see that a row is unreadable, and a list that quietly omits
                // one is how a vault starts lying about what it holds.
                Err(refusal) => {
                    return self.deny(credentials, &caller, action, Some(&key.id), &refusal)
                }
            }
        }
        self.record_entry(admin_entry(
            credentials,
            &caller,
            action,
            None,
            format!("{} key(s) listed", keys.len()),
        )?)?;
        Ok(Outcome::Allowed(keys))
    }

    /// One key's public identity and the boundary it is held under.
    pub fn key_detail(
        &self,
        credentials: &CallerCredentials,
        id: &str,
    ) -> Result<Outcome<(KeyPublicInfo, SignerPolicy)>> {
        let action = SignerAuditAction::KeyViewed;
        let caller = match self.admin_caller(credentials, action, Some(id))? {
            Ok(caller) => caller,
            Err(refusal) => return Ok(Outcome::Refused(refusal)),
        };
        let key = match self.custody_row(id)? {
            Some(key) => key,
            None => return self.deny(credentials, &caller, action, Some(id), &unknown_key(id)),
        };
        let info = match identity(&key) {
            Ok(info) => info,
            Err(refusal) => return self.deny(credentials, &caller, action, Some(id), &refusal),
        };
        let boundary = self.repository.signer_policy_or_default(id)?;
        self.record_entry(admin_entry(
            credentials,
            &caller,
            action,
            Some(id.to_string()),
            format!("{} read with its boundary", info.address),
        )?)?;
        Ok(Outcome::Allowed((info, boundary)))
    }

    /// Every caller, with no credential in the answer.
    pub fn list_callers(
        &self,
        credentials: &CallerCredentials,
    ) -> Result<Outcome<Vec<CallerInfo>>> {
        let action = SignerAuditAction::CallerViewed;
        let caller = match self.admin_caller(credentials, action, None)? {
            Ok(caller) => caller,
            Err(refusal) => return Ok(Outcome::Refused(refusal)),
        };
        let callers: Vec<CallerInfo> = self
            .repository
            .list_signer_callers()?
            .iter()
            .map(CallerInfo::from)
            .collect();
        self.record_entry(admin_entry(
            credentials,
            &caller,
            action,
            None,
            format!("{} caller(s) listed", callers.len()),
        )?)?;
        Ok(Outcome::Allowed(callers))
    }

    /// The audit trail, newest first.
    ///
    /// The one management read that records nothing when it succeeds. `list_keys`
    /// and `list_callers` disclose facts about custody, so an operator has to be
    /// able to see who enumerated them; this discloses the record of those other
    /// things, and recording the read would add a line to the trail for every
    /// repaint of the console page — which is a way for a legitimate caller to
    /// bury the history an incident investigation reads. A *refusal* is still
    /// recorded, because someone reaching for the trail without the authority is
    /// exactly what the trail is for.
    pub fn list_audit(
        &self,
        credentials: &CallerCredentials,
        key_id: Option<&str>,
        limit: usize,
    ) -> Result<Outcome<Vec<SignerAuditRecord>>> {
        let action = SignerAuditAction::AuditRead;
        let _caller = match self.admin_caller(credentials, action, key_id)? {
            Ok(caller) => caller,
            Err(refusal) => return Ok(Outcome::Refused(refusal)),
        };
        Ok(Outcome::Allowed(
            self.repository.list_signer_audit(key_id, limit)?,
        ))
    }

    // -- caller-facing ------------------------------------------------------

    /// Sign a serialized unsigned transaction for one key.
    pub fn sign_transaction(
        &self,
        credentials: &CallerCredentials,
        key_id: &str,
        unsigned: &[u8],
    ) -> Result<SignResponse> {
        self.sign(
            credentials,
            key_id,
            unsigned,
            RequestKind::Transaction,
            None,
        )
    }

    pub fn sign_transaction_with_request_id(
        &self,
        credentials: &CallerCredentials,
        key_id: &str,
        unsigned: &[u8],
        request_id: Option<&str>,
    ) -> Result<SignResponse> {
        self.sign(
            credentials,
            key_id,
            unsigned,
            RequestKind::Transaction,
            request_id,
        )
    }

    /// Sign the `SerializeUnsigned` bytes of an extensible (dBFT) payload.
    pub fn sign_consensus(
        &self,
        credentials: &CallerCredentials,
        key_id: &str,
        unsigned: &[u8],
    ) -> Result<SignResponse> {
        self.sign(credentials, key_id, unsigned, RequestKind::Consensus, None)
    }

    pub fn sign_consensus_with_request_id(
        &self,
        credentials: &CallerCredentials,
        key_id: &str,
        unsigned: &[u8],
        request_id: Option<&str>,
    ) -> Result<SignResponse> {
        self.sign(
            credentials,
            key_id,
            unsigned,
            RequestKind::Consensus,
            request_id,
        )
    }

    /// Sign raw caller bytes under `key_id` — the digest/preimage signing the
    /// enclave's pinned role keys need. The bytes are deliberately not parsed:
    /// the boundary's `allow_raw` switch is the only thing standing between a
    /// raw request and a witness, which is why it defaults to closed and why
    /// enabling it is a whole-key decision the attested boundary digest covers.
    pub fn sign_raw(
        &self,
        credentials: &CallerCredentials,
        key_id: &str,
        data: &[u8],
    ) -> Result<SignResponse> {
        self.sign(credentials, key_id, data, RequestKind::Raw, None)
    }

    pub fn sign_raw_with_request_id(
        &self,
        credentials: &CallerCredentials,
        key_id: &str,
        data: &[u8],
        request_id: Option<&str>,
    ) -> Result<SignResponse> {
        self.sign(credentials, key_id, data, RequestKind::Raw, request_id)
    }

    /// The account details a caller needs in order to build a transaction for
    /// this key.
    ///
    /// Authenticated exactly like signing and audited as a read: knowing which
    /// address a key controls is the first half of every attack on a boundary
    /// written in terms of that address. A disabled key is still readable, and
    /// says so — a caller that cannot tell "off" from "gone" restarts nothing.
    pub fn key_info(&self, credentials: &CallerCredentials, key_id: &str) -> Result<InfoResponse> {
        let action = SignerAuditAction::KeyViewed;
        let access = self.access_any(
            credentials,
            &[CallerCapability::Sign, CallerCapability::RawSign],
            Some(key_id),
        );
        let caller = match self.resolved(access, credentials, action, Some(key_id))? {
            Ok(caller) => caller,
            Err(refusal) => return Ok(Outcome::Refused(refusal)),
        };
        let key = match self.repository.find_signer_key(key_id)? {
            Some(key) => key,
            None => {
                return Ok(Outcome::Refused(self.refuse(
                    action,
                    credentials,
                    Some(&caller),
                    None,
                    &unknown_key(key_id),
                )?));
            }
        };
        let info = match identity(&key) {
            Ok(info) => info,
            Err(refusal) => {
                return Ok(Outcome::Refused(self.refuse(
                    action,
                    credentials,
                    Some(&caller),
                    Some(key_id),
                    &refusal,
                )?));
            }
        };
        self.record_entry(SignerAuditRecord {
            origin: credentials.origin_label(),
            caller_id: Some(caller.id),
            key_id: Some(key_id.to_string()),
            ..entry(action, format!("read granted for {}", info.address))?
        })?;
        Ok(Outcome::Allowed(info))
    }

    // -- the signing path ---------------------------------------------------

    fn sign(
        &self,
        credentials: &CallerCredentials,
        key_id: &str,
        unsigned: &[u8],
        kind: RequestKind,
        request_id: Option<&str>,
    ) -> Result<SignResponse> {
        let _decision = self.lock_decision()?;
        let action = RequestKind::action(kind);
        let access = self.guard_signing(credentials, key_id, kind);
        let caller = match self.resolved(access, credentials, action, Some(key_id))? {
            Ok(caller) => caller,
            Err(refusal) => return Ok(Outcome::Refused(refusal)),
        };
        let idempotency = if let Some(request_id) = request_id {
            if !valid_request_id(request_id) {
                let refusal = Refusal::request_id(
                    audit::REQUEST_ID_INVALID,
                    "request_id must be 1-128 safe ASCII characters",
                    format!("invalid request id presented: {request_id:?}"),
                );
                return Ok(Outcome::Refused(self.refuse(
                    action,
                    credentials,
                    Some(&caller),
                    Some(key_id),
                    &refusal,
                )?));
            }
            if let Err(refusal) = self.custody(key_id) {
                return Ok(Outcome::Refused(self.refuse(
                    action,
                    credentials,
                    Some(&caller),
                    Some(key_id),
                    &refusal,
                )?));
            }
            let request_digest = idempotency_digest(action, key_id, unsigned);
            if let Some(completed) = self
                .repository
                .find_signer_request(&caller.id, request_id)?
            {
                if completed.request_digest != request_digest
                    || completed.key_id != key_id
                    || completed.action != action
                {
                    let refusal = Refusal::request_id(
                        audit::REQUEST_ID_CONFLICT,
                        "request_id was already used for a different signing request",
                        format!(
                            "request id {request_id:?} for caller {} is already bound",
                            caller.id
                        ),
                    );
                    return Ok(Outcome::Refused(self.refuse(
                        action,
                        credentials,
                        Some(&caller),
                        Some(key_id),
                        &refusal,
                    )?));
                }
                return Ok(Outcome::Allowed(SignedWitness {
                    key_id: completed.key_id,
                    script_hash: completed.script_hash,
                    address: completed.address,
                    digest: completed.result_digest,
                    invocation: completed.invocation,
                    verification: completed.verification,
                }));
            }
            Some((request_id.to_string(), request_digest))
        } else {
            None
        };
        match self.attempt(key_id, unsigned, kind) {
            Err(refusal) => Ok(Outcome::Refused(self.refuse(
                action,
                credentials,
                Some(&caller),
                Some(key_id),
                &refusal,
            )?)),
            Ok(approved) => {
                // The decision is written down before the witness leaves the
                // service, and the spend ledger names the row that authorised it.
                let record = SignerAuditRecord {
                    caller_id: Some(caller.id.clone()),
                    key_id: Some(key_id.to_string()),
                    origin: credentials.origin_label(),
                    tx_id: Some(approved.witness.digest.clone()),
                    ..entry(action, intent_summary(&approved.intents))?
                };
                let recorded_at_unix = record.recorded_at_unix;
                let events = if approved.kind == RequestKind::Transaction {
                    value_events(
                        key_id,
                        recorded_at_unix,
                        &approved.intents,
                        approved.witness.script_hash,
                        None,
                    )
                } else {
                    Vec::new()
                };
                let request =
                    idempotency.map(|(request_id, request_digest)| SignerRequestCompletion {
                        caller_id: caller.id,
                        request_id,
                        key_id: key_id.to_string(),
                        action,
                        request_digest,
                        result_digest: approved.witness.digest.clone(),
                        script_hash: approved.witness.script_hash,
                        address: approved.witness.address.clone(),
                        invocation: approved.witness.invocation.clone(),
                        verification: approved.witness.verification.clone(),
                        completed_at_unix: recorded_at_unix,
                        audit_id: None,
                    });
                self.repository.record_signer_decision(
                    &record,
                    &events,
                    approved.consensus.as_ref(),
                    request.as_ref(),
                )?;
                Ok(Outcome::Allowed(approved.witness))
            }
        }
    }

    /// Identify-to-signature, stopping before anything is written down. Every
    /// way the request can be answered with "no" comes back as a [`Refusal`].
    fn attempt(
        &self,
        key_id: &str,
        unsigned: &[u8],
        kind: RequestKind,
    ) -> Result<Approved, Refusal> {
        let key = self.custody(key_id)?;
        let account = key.account().ok_or_else(|| {
            Refusal::guard(
                GuardRejection::PublicKeyUnusable,
                format!("{key_id} has no usable public key on record"),
            )
        })?;
        let parsed = self.parse(unsigned, kind)?;

        let boundary = self
            .repository
            .signer_policy_or_default(key_id)
            .map_err(|error| {
                Refusal::failed(
                    "signer-store-unreadable",
                    "the policy store could not be read",
                    format!("{key_id}: {error:?}"),
                )
            })?;
        let spent = self.window_spend(key_id, &boundary)?;
        let request = parsed.request();
        let intents = match request {
            SigningRequest::Transaction { intents, .. } => intents,
            SigningRequest::Consensus { .. } | SigningRequest::Raw => &[],
        };
        match policy::evaluate(&boundary, account, &request, &spent) {
            policy::Verdict::Allow => {}
            policy::Verdict::Deny { reason, detail } => {
                return Err(Refusal::policy(reason, detail));
            }
        }
        let asset_spent = self.asset_window_spend(key_id, &boundary)?;
        match policy::evaluate_asset_limits(&boundary, intents, &asset_spent) {
            policy::Verdict::Allow => {}
            policy::Verdict::Deny { reason, detail } => {
                return Err(Refusal::policy(reason, detail));
            }
        }
        let signatures = self.signature_count(key_id, &boundary)?;
        match policy::evaluate_signature_rate(&boundary, signatures) {
            policy::Verdict::Allow => {}
            policy::Verdict::Deny { reason, detail } => {
                return Err(Refusal::policy(reason, detail));
            }
        }
        let consensus = self.consensus_reservation(&key, &parsed, unsigned)?;
        // Key material enters memory only after every structural, policy and
        // anti-equivocation check has passed.
        let private_key = self.open_key(&key)?;

        // The framed Neo preimage and the unframed raw bytes are two
        // different signature primitives with two different replay domains —
        // a magic-framed signature is worthless for a digest lane and a raw
        // signature would be replayable across networks — so the kind picks
        // the primitive, and the witness digest records what was signed.
        let (signature, digest) = match kind {
            RequestKind::Transaction | RequestKind::Consensus => (
                crypto::sign_transaction(&private_key, unsigned, key.network_magic()).map_err(
                    |error| {
                        Refusal::failed(
                            "signer-signature-failed",
                            "the signature could not be produced",
                            error.to_string(),
                        )
                    },
                )?,
                // A transaction id is displayed byte-reversed — the explorer
                // order the digest exists to be found under.
                tx::script_hash_to_display(&crypto::transaction_hash(unsigned)),
            ),
            RequestKind::Raw => (
                crypto::sign_raw(&private_key, unsigned).map_err(|error| {
                    Refusal::failed(
                        "signer-signature-failed",
                        "the signature could not be produced",
                        error.to_string(),
                    )
                })?,
                // A raw digest is not an on-chain id, so it takes the order a
                // verifier computes: plain SHA-256, un-reversed.
                format!("0x{}", hex::encode(crypto::sha256(unsigned))),
            ),
        };
        Ok(Approved {
            witness: SignedWitness {
                key_id: key.id.clone(),
                script_hash: account,
                address: key.address(),
                digest,
                invocation: crypto::invocation_script(&signature),
                verification: key.verification_script(),
            },
            kind,
            intents: match parsed {
                Parsed::Transaction { intents, .. } => intents,
                Parsed::Consensus { .. } | Parsed::Raw => Vec::new(),
            },
            consensus,
        })
    }

    /// Build and preflight the durable dBFT slot this request would occupy.
    fn consensus_reservation(
        &self,
        key: &SignerKey,
        parsed: &Parsed,
        unsigned: &[u8],
    ) -> Result<Option<SignerConsensusReservation>, Refusal> {
        let Parsed::Consensus { payload } = parsed else {
            return Ok(None);
        };
        let message = payload.dbft_message().map_err(|error| {
            Refusal::failed(
                "signer-payload-unparsable",
                "the consensus payload could not be read",
                error.to_string(),
            )
        })?;
        let checkpoint_digest = |bytes: &[u8]| {
            <[u8; 32]>::try_from(crypto::sha256(bytes)).map_err(|_| {
                Refusal::failed(
                    "signer-digest-failed",
                    "the consensus checkpoint could not be produced",
                    "SHA-256 did not return 32 bytes",
                )
            })
        };
        let (phase, view_number, checkpoint) = match message.commitment {
            DbftCommitment::None => return Ok(None),
            DbftCommitment::PrepareRequest => (
                tx::DbftMessageType::PrepareRequest as u8,
                message.header.view_number,
                checkpoint_digest(unsigned)?,
            ),
            DbftCommitment::PrepareResponse(preparation_hash) => (
                tx::DbftMessageType::PrepareRequest as u8,
                message.header.view_number,
                preparation_hash,
            ),
            DbftCommitment::Commit(signature) => (
                tx::DbftMessageType::Commit as u8,
                0,
                checkpoint_digest(&signature)?,
            ),
        };
        let candidate = SignerConsensusReservation {
            public_key: key.public_key,
            network_magic: key.network_magic(),
            block_index: message.header.block_index,
            phase,
            validator_index: message.header.validator_index,
            view_number,
            checkpoint,
            recorded_at_unix: now_unix().map_err(|error| {
                Refusal::failed(
                    "signer-clock-unavailable",
                    "the signing decision could not be timestamped",
                    error.to_string(),
                )
            })?,
            audit_id: None,
        };
        if let Some(existing) = self
            .repository
            .reserve_signer_consensus(&candidate)
            .map_err(|error| {
                Refusal::failed(
                    "signer-store-unreadable",
                    "the consensus journal could not be read",
                    error.to_string(),
                )
            })?
        {
            if existing.public_key != candidate.public_key
                || existing.checkpoint != candidate.checkpoint
            {
                return Err(Refusal::guard(
                    GuardRejection::ConsensusEquivocation,
                    format!(
                        "public key {} already reserved dBFT phase 0x{:02x} at height {}, validator {}, view {} with checkpoint 0x{}; refused 0x{}",
                        hex::encode(key.public_key),
                        candidate.phase,
                        candidate.block_index,
                        candidate.validator_index,
                        candidate.view_number,
                        hex::encode(existing.checkpoint),
                        hex::encode(candidate.checkpoint),
                    ),
                ));
            }
        }
        Ok(Some(candidate))
    }

    /// Read and decode the bytes a signature is about to cover.
    fn parse(&self, unsigned: &[u8], kind: RequestKind) -> Result<Parsed, Refusal> {
        match kind {
            RequestKind::Transaction => {
                let transaction = UnsignedTransaction::parse(unsigned).map_err(|error| {
                    Refusal::failed(
                        "signer-transaction-unparsable",
                        "the transaction could not be read",
                        error.to_string(),
                    )
                })?;
                let intents = transaction.intents().map_err(|error| {
                    Refusal::failed(
                        "signer-script-unparsable",
                        "the transaction script could not be read",
                        error.to_string(),
                    )
                })?;
                Ok(Parsed::Transaction {
                    transaction,
                    intents,
                })
            }
            RequestKind::Consensus => {
                let payload = ConsensusPayload::parse(unsigned).map_err(|error| {
                    Refusal::failed(
                        "signer-payload-unparsable",
                        "the consensus payload could not be read",
                        error.to_string(),
                    )
                })?;
                Ok(Parsed::Consensus { payload })
            }
            RequestKind::Raw => Ok(Parsed::Raw),
        }
    }

    /// Read the custody record, refusing anything the guards reject.
    fn custody(&self, key_id: &str) -> Result<SignerKey, Refusal> {
        let key = self
            .repository
            .find_signer_key(key_id)
            .map_err(|error| {
                Refusal::failed(
                    "signer-store-unreadable",
                    "the custody store could not be read",
                    format!("{key_id}: {error:?}"),
                )
            })?
            .ok_or_else(|| {
                Refusal::failed(
                    "signer-key-unknown",
                    "this key is not held by the service",
                    format!("no custody record for {key_id}"),
                )
            })?;
        if key.disabled {
            return Err(Refusal::guard(
                GuardRejection::KeyDisabled,
                format!("{key_id} is switched off by the operator"),
            ));
        }
        Ok(key)
    }

    /// Identify the caller and check that it may do *this* kind of thing to
    /// *this* key.
    ///
    /// `key_id` is `None` for a management route that names no key — list the
    /// vault, create into it, provision a caller — which [`auth::authorize`]
    /// reads as "this reaches the whole vault" and demands a whole-vault grant
    /// for.
    fn access(
        &self,
        credentials: &CallerCredentials,
        required: CallerCapability,
        key_id: Option<&str>,
    ) -> Access {
        self.access_any(credentials, &[required], key_id)
    }

    fn access_any(
        &self,
        credentials: &CallerCredentials,
        required: &[CallerCapability],
        key_id: Option<&str>,
    ) -> Access {
        let callers = match self.repository.list_signer_callers() {
            Ok(callers) => callers,
            Err(error) => {
                return Access::Refused(
                    None,
                    Refusal::failed(
                        "signer-store-unreadable",
                        "the custody store could not be read",
                        format!("caller list: {error:?}"),
                    ),
                )
            }
        };
        match auth::authenticate_any(&callers, credentials, required, key_id) {
            Ok(caller) => {
                if let Some(nonce) = credentials.workload_nonce() {
                    let Some(expires_at) = credentials.workload_expires_at() else {
                        return Access::Refused(
                            Some(caller.clone()),
                            Refusal::access(AccessRejection::WorkloadMalformed),
                        );
                    };
                    let now = match now_unix() {
                        Ok(now) => now,
                        Err(error) => {
                            return Access::Refused(
                                Some(caller.clone()),
                                Refusal::failed(
                                    "signer-clock-unavailable",
                                    "the workload assertion could not be timestamped",
                                    error.to_string(),
                                ),
                            )
                        }
                    };
                    match self
                        .repository
                        .reserve_workload_nonce(&caller.id, nonce, expires_at, now)
                    {
                        Ok(true) => {}
                        Ok(false) => {
                            return Access::Refused(
                                Some(caller.clone()),
                                Refusal::access(AccessRejection::WorkloadReplay),
                            )
                        }
                        Err(error) => {
                            return Access::Refused(
                                Some(caller.clone()),
                                Refusal::failed(
                                    "signer-store-unreadable",
                                    "the workload replay journal could not be written",
                                    error.to_string(),
                                ),
                            )
                        }
                    }
                }
                Access::Granted(caller.clone())
            }
            Err(rejection @ AccessRejection::UnknownToken) => {
                Access::Unknown(Refusal::access(rejection))
            }
            Err(rejection) => Access::Refused(
                auth::identify(&callers, credentials).cloned(),
                Refusal::access(rejection),
            ),
        }
    }

    /// Route-specific signing authorization. Raw bytes are deliberately a
    /// distinct capability because they can encode Neo transaction preimages
    /// without traversing the transaction parser or semantic policy.
    fn guard_signing(
        &self,
        credentials: &CallerCredentials,
        key_id: &str,
        kind: RequestKind,
    ) -> Access {
        let required = match kind {
            RequestKind::Raw => CallerCapability::RawSign,
            RequestKind::Transaction | RequestKind::Consensus => CallerCapability::Sign,
        };
        self.access(credentials, required, Some(key_id))
    }

    /// The management path's guard, and the reason no route has to remember to
    /// call it: a signing credential reaching any of these methods is refused
    /// here, before a body is parsed or a row is written.
    fn guard_admin(&self, credentials: &CallerCredentials, key_id: Option<&str>) -> Access {
        self.access(credentials, CallerCapability::Admin, key_id)
    }

    /// Run the management guard and write down whatever it decided.
    fn admin_caller(
        &self,
        credentials: &CallerCredentials,
        action: SignerAuditAction,
        key_id: Option<&str>,
    ) -> Result<Result<SignerCaller, Refusal>> {
        let access = self.guard_admin(credentials, key_id);
        self.resolved(access, credentials, action, key_id)
    }

    /// Turn a guard outcome into the acting caller, or into a refusal that has
    /// already been recorded.
    ///
    /// The nested `Result` is the convention this service already uses on the
    /// signing path, not a quirk of this function: the outer `Err` is something
    /// the service could not do (and the handler's `500`), the inner is the
    /// caller's own request answered with a denial. Resolved in one place because
    /// every route has to get a refusal's audit row right, and a per-method copy
    /// of that match is how one method ends up refusing without recording it.
    fn resolved(
        &self,
        access: Access,
        credentials: &CallerCredentials,
        action: SignerAuditAction,
        key_id: Option<&str>,
    ) -> Result<Result<SignerCaller, Refusal>> {
        match access {
            Access::Granted(caller) => Ok(Ok(caller)),
            Access::Unknown(refusal) => Ok(Err(self.refuse(
                SignerAuditAction::UnknownToken,
                credentials,
                None,
                None,
                &refusal,
            )?)),
            Access::Refused(caller, refusal) => {
                // A caller found by its token owns its refusal, including the key
                // it named. A request that identified nobody is logged as just
                // that — a stray key id in a row with no one behind it can only
                // mislead whoever reads it next.
                let named = caller.as_ref().and(key_id);
                Ok(Err(self.refuse(
                    action,
                    credentials,
                    caller.as_ref(),
                    named,
                    &refusal,
                )?))
            }
        }
    }

    /// Open a sealed key and check it still is the key the record describes.
    fn open_key(&self, key: &SignerKey) -> Result<Zeroizing<[u8; 32]>, Refusal> {
        let opened = self.master_key.open_sealed(&key.sealed).map_err(|error| {
            Refusal::failed(
                "signer-vault-unreadable",
                "the sealed key could not be opened",
                format!("{}: {error:?}", key.id),
            )
        })?;
        let private_key = <[u8; 32]>::try_from(opened.as_slice()).map_err(|_| {
            Refusal::guard(
                GuardRejection::CustodyMismatch,
                format!("{} opened to the wrong length", key.id),
            )
        })?;
        let public_key = crypto::public_key_from_private(&private_key).map_err(|_| {
            Refusal::guard(
                GuardRejection::PublicKeyUnusable,
                format!("{} opened to an unusable key", key.id),
            )
        })?;
        if public_key != key.public_key {
            return Err(Refusal::guard(
                GuardRejection::CustodyMismatch,
                format!("{} opened to a different public key", key.id),
            ));
        }
        Ok(Zeroizing::new(private_key))
    }

    /// What the key has already moved inside its window.
    fn window_spend(&self, key_id: &str, boundary: &SignerPolicy) -> Result<WindowSpend, Refusal> {
        let Some(limit) = boundary.window_limit else {
            return Ok(WindowSpend::new());
        };
        let since = now_unix()
            .map_err(|error| {
                Refusal::failed(
                    "signer-clock-unusable",
                    "the service clock could not be read",
                    format!("{error:?}"),
                )
            })?
            .saturating_sub(limit.seconds);
        self.repository
            .signer_window_spend(key_id, since)
            .map_err(|error| {
                Refusal::failed(
                    "signer-store-unreadable",
                    "the spend ledger could not be read",
                    format!("{key_id}: {error:?}"),
                )
            })
    }

    /// Successful signatures already produced inside this key's configured
    /// rolling window.
    fn signature_count(&self, key_id: &str, boundary: &SignerPolicy) -> Result<u64, Refusal> {
        let Some(limit) = boundary.max_signatures else {
            return Ok(0);
        };
        let since = now_unix()
            .map_err(|error| {
                Refusal::failed(
                    "signer-clock-unusable",
                    "the service clock could not be read",
                    format!("{error:?}"),
                )
            })?
            .saturating_sub(limit.seconds);
        self.repository
            .signer_signature_count(key_id, since)
            .map_err(|error| {
                Refusal::failed(
                    "signer-store-unreadable",
                    "the signature audit could not be read",
                    format!("{key_id}: {error:?}"),
                )
            })
    }

    /// Prior spend for every distinct asset-specific rolling period. One
    /// ledger read covers the longest period, then shorter periods are folded
    /// from the same immutable event list.
    fn asset_window_spend(
        &self,
        key_id: &str,
        boundary: &SignerPolicy,
    ) -> Result<AssetWindowSpend, Refusal> {
        let Some(longest) = boundary
            .asset_limits
            .iter()
            .filter_map(|limit| limit.window_limit)
            .map(|window| window.seconds)
            .max()
        else {
            return Ok(AssetWindowSpend::new());
        };
        let now = now_unix().map_err(|error| {
            Refusal::failed(
                "signer-clock-unusable",
                "the service clock could not be read",
                format!("{error:?}"),
            )
        })?;
        let events = self
            .repository
            .signer_value_events_since(key_id, now.saturating_sub(longest))
            .map_err(|error| {
                Refusal::failed(
                    "signer-store-unreadable",
                    "the spend ledger could not be read",
                    format!("{key_id}: {error:?}"),
                )
            })?;
        let mut spent = AssetWindowSpend::new();
        for limit in &boundary.asset_limits {
            let Some(window) = limit.window_limit else {
                continue;
            };
            if spent.contains(limit.asset, window.seconds) {
                continue;
            }
            let since = now.saturating_sub(window.seconds);
            spent.record(limit.asset, window.seconds, 0);
            for event in events
                .iter()
                .filter(|event| event.asset == limit.asset && event.recorded_at_unix >= since)
            {
                spent.record(limit.asset, window.seconds, event.amount);
            }
        }
        Ok(spent)
    }

    /// Log a refusal and hand it back for the response.
    fn refuse(
        &self,
        action: SignerAuditAction,
        credentials: &CallerCredentials,
        caller: Option<&SignerCaller>,
        key_id: Option<&str>,
        refusal: &Refusal,
    ) -> Result<Refusal> {
        self.record_entry(SignerAuditRecord {
            outcome: refusal.outcome,
            caller_id: caller.map(|caller| caller.id.clone()),
            key_id: key_id.map(str::to_string),
            origin: credentials.origin_label(),
            reason: Some(refusal.code.to_string()),
            ..entry(action, refusal.detail.clone())?
        })?;
        Ok(refusal.clone())
    }

    /// Record a refusal that happened *after* the caller was authorized, and
    /// package it for the handler.
    ///
    /// Generic over the success type because every management method returns a
    /// different one, and a handler-facing `deny` that only fitted some routes is
    /// a route that invents its own refusal path — which is where an unrecorded
    /// denial comes from.
    fn deny<T>(
        &self,
        credentials: &CallerCredentials,
        caller: &SignerCaller,
        action: SignerAuditAction,
        key_id: Option<&str>,
        refusal: &Refusal,
    ) -> Result<Outcome<T>> {
        self.refuse(action, credentials, Some(caller), key_id, refusal)?;
        Ok(Outcome::Refused(refusal.clone()))
    }

    /// A management request whose own body could not be used.
    fn reject_invalid<T>(
        &self,
        credentials: &CallerCredentials,
        caller: &SignerCaller,
        action: SignerAuditAction,
        key_id: Option<&str>,
        message: &str,
    ) -> Result<Outcome<T>> {
        let detail = format!("{} rejected: {message}", caller.label);
        self.deny(
            credentials,
            caller,
            action,
            key_id,
            &Refusal::invalid(message, detail),
        )
    }

    fn record_entry(&self, entry: SignerAuditRecord) -> Result<i64> {
        self.repository.record_signer_audit(&entry)
    }

    /// Seal a private key and store it, in the one place that knows how.
    ///
    /// Called only after the management guard has passed, so the two ways a
    /// request body can be unusable — a blank label, a value that is not a point
    /// on the curve — are answered as `invalid` refusals rather than as store
    /// errors, and nothing is written for either.
    fn store_key(
        &self,
        credentials: &CallerCredentials,
        caller: &SignerCaller,
        request: KeyRequest<'_>,
        private_key: &Zeroizing<[u8; 32]>,
    ) -> Result<Outcome<KeyPublicInfo>> {
        let KeyRequest {
            label,
            network,
            requested_magic,
            action,
        } = request;
        let label = match operator_label(label) {
            Ok(label) => label,
            Err(error) => {
                return self.reject_invalid(credentials, caller, action, None, &error.to_string())
            }
        };
        // The magic is resolved once, here, and then bound to the row. `None`
        // means the canonical table — what every pre-existing consumer sends. A
        // private network may name its real deployment magic, because two
        // private chains that share the default can replay each other's
        // signatures and the only cure is a key that carries its chain's actual
        // identity. Mainnet and testnet have exactly one magic each: accepting
        // another would seal a key whose signatures no node verifies, which is
        // discovered only after real value is on the line.
        let network_magic = match requested_magic {
            None => network::network_magic(network),
            Some(magic) if magic == network::network_magic(network) => magic,
            Some(0) => {
                return self.reject_invalid(
                    credentials,
                    caller,
                    action,
                    None,
                    "network magic 0 is not a usable chain identity",
                )
            }
            Some(magic) if network == Network::Private => magic,
            Some(magic) => {
                return self.reject_invalid(
                    credentials,
                    caller,
                    action,
                    None,
                    &format!(
                        "{network} signs under magic {} only; a key bound to {magic} would \
                         produce signatures no node of that chain accepts",
                        network::network_magic(network)
                    ),
                )
            }
        };
        let public_key = match crypto::public_key_from_private(private_key) {
            Ok(public_key) => public_key,
            Err(_) => {
                return self.reject_invalid(
                    credentials,
                    caller,
                    action,
                    None,
                    "the value is not a usable P-256 private key",
                )
            }
        };
        // Checked here rather than left to the unique index so an operator who
        // pastes a key twice is told which row already holds it. Only a
        // whole-vault admin can reach this line — `admin_caller` requires the
        // grant for a request that names no key — so naming the id discloses
        // nothing the caller could not list.
        if let Some(existing_id) = self.repository.signer_key_id_holding(&public_key)? {
            return self.reject_invalid(
                credentials,
                caller,
                action,
                Some(&existing_id),
                &format!("this key is already held as {existing_id}"),
            );
        }
        let sealed = self.master_key.seal(private_key)?;
        let key = SignerKey {
            id: format!("key-{}", Uuid::new_v4()),
            label,
            network,
            network_magic,
            public_key,
            sealed,
            created_at_unix: now_unix()?,
            disabled: false,
        };
        self.repository.create_signer_key(&key)?;
        // Written before the identity is derived, not after: a key in custody with
        // no row saying it arrived is the exact gap this service exists to close,
        // so the record cannot be the thing that fails.
        self.record_entry(admin_entry(
            credentials,
            caller,
            action,
            Some(key.id.clone()),
            format!("{} sealed into custody", key.address()),
        )?)?;
        let info = match identity(&key) {
            Ok(info) => info,
            Err(refusal) => return self.deny(credentials, caller, action, Some(&key.id), &refusal),
        };
        Ok(Outcome::Allowed(info))
    }
}

/// What a custody request carries into [`SignerService::store_key`]: the label
/// the operator chose, the chain it binds to, the magic that binds it, and the
/// audit row it files under.
struct KeyRequest<'a> {
    label: &'a str,
    network: Network,
    requested_magic: Option<u32>,
    action: SignerAuditAction,
}

impl RequestKind {
    /// Which audit action this request's row is filed under.
    fn action(kind: Self) -> SignerAuditAction {
        match kind {
            RequestKind::Transaction => SignerAuditAction::TransactionSigned,
            RequestKind::Consensus => SignerAuditAction::ConsensusSigned,
            RequestKind::Raw => SignerAuditAction::RawSigned,
        }
    }
}

/// A management action's row: allowed, and naming the credential that asked for
/// it. Before the management API existed these rows carried `caller_id = None`
/// because the operator's session was the only thing behind them; now the
/// question "which integration changed this boundary?" has an answer.
fn admin_entry(
    credentials: &CallerCredentials,
    caller: &SignerCaller,
    action: SignerAuditAction,
    key_id: Option<String>,
    detail: String,
) -> Result<SignerAuditRecord> {
    Ok(SignerAuditRecord {
        origin: credentials.origin_label(),
        caller_id: Some(caller.id.clone()),
        key_id,
        ..entry(action, detail)?
    })
}

/// A fresh audit row, stamped now and bounded, with the fields every entry
/// shape has in common.
fn entry(action: SignerAuditAction, detail: String) -> Result<SignerAuditRecord> {
    Ok(SignerAuditRecord {
        id: 0,
        recorded_at_unix: now_unix()?,
        action,
        outcome: SignerAuditOutcome::Allowed,
        caller_id: None,
        key_id: None,
        tx_id: None,
        reason: None,
        detail: Some(audit::bounded(&detail)),
        origin: None,
    })
}

/// Ledger rows for the transfers this signature authorised.
///
/// The accounting rule is the policy engine's, not a second opinion: every
/// [`Intent::Transfer`] whose `from` is this key's own account is recorded, which
/// is exactly the set [`policy::evaluate`] added to the window while it decided.
/// A payment back to the key's own account is included too — it leaves the
/// account and comes back, and a window that ignored the round trip would let a
/// key with a 100 NEO ceiling move 100 NEO out and in again, in one request,
/// forever.
fn value_events(
    key_id: &str,
    recorded_at_unix: u64,
    intents: &[Intent],
    account: ScriptHash,
    audit_id: Option<i64>,
) -> Vec<SignerValueEvent> {
    intents
        .iter()
        .filter_map(|intent| match intent {
            Intent::Transfer {
                asset,
                from,
                amount,
                ..
            } if ScriptHash(*from) == account => Some(SignerValueEvent {
                id: 0,
                key_id: key_id.to_string(),
                recorded_at_unix,
                asset: ScriptHash(*asset),
                amount: *amount,
                audit_id,
            }),
            _ => None,
        })
        .collect()
}

/// Seed the first admin credential into a vault that has none.
///
/// The one write path in this module with no [`CallerCredentials`], and it has
/// to be: a service that authenticates its management API cannot be configured
/// through that API before a credential exists. It is deliberately not a method
/// on [`SignerService`] — nothing can reach it without holding the [`Store`] and
/// therefore the whole database and the master key file already, which is the
/// same trust root as opening the vault by hand. The HTTP surface has no route
/// to it, and must never gain one.
///
/// Refuses when an `admin` caller already exists, so running the provisioning
/// step twice cannot mint a second superuser alongside the first. That also
/// means losing the only admin token is recovered by retiring its row against
/// the database directly — painful and visible on purpose, because the
/// alternative is a credentialless path that always works.
pub fn provision_admin_caller(repository: &Store, label: &str) -> Result<(CallerInfo, String)> {
    let existing = repository.list_signer_callers()?;
    if existing
        .iter()
        .any(|caller| caller.has_capability(CallerCapability::Admin))
    {
        anyhow::bail!(
            "this vault already has an admin caller; provision a second one through the \
             management API so the change is attributed and audited"
        );
    }
    let token = auth::generate_token();
    let caller = SignerCaller {
        id: format!("caller-{}", Uuid::new_v4()),
        label: operator_label(label)?,
        token_digest: auth::token_digest(&token),
        workload_identity: None,
        // Whole-vault, and only `admin`: the token that opens a service for the
        // first time should not also be the one that signs with what it creates.
        key_grant: KeyGrant::Any,
        capabilities: vec![CallerCapability::Admin],
        allowed_origins: Vec::new(),
        created_at_unix: now_unix()?,
        disabled: false,
    }
    .normalized();
    repository.create_signer_caller(&caller)?;
    repository.record_signer_audit(&SignerAuditRecord {
        caller_id: Some(caller.id.clone()),
        ..entry(
            SignerAuditAction::CallerCreated,
            format!("{} (provisioned)", caller_summary(&caller)),
        )?
    })?;
    Ok((CallerInfo::from(&caller), token))
}

/// The public identity of a custody row.
///
/// Fails on a stored public key that derives no account rather than returning a
/// half-filled identity: every caller of this builds a response or an audit row,
/// and either one describing an account that does not exist is worse than an
/// error that names the key.
fn identity(key: &SignerKey) -> Result<KeyPublicInfo, Refusal> {
    let script_hash = key.account().ok_or_else(|| {
        Refusal::guard(
            GuardRejection::PublicKeyUnusable,
            format!("{} has no usable public key on record", key.id),
        )
    })?;
    Ok(KeyPublicInfo {
        key_id: key.id.clone(),
        label: key.label.clone(),
        network: key.network,
        network_magic: key.network_magic,
        public_key: key.public_key,
        script_hash,
        address: key.address(),
        verification_script: key.verification_script(),
        signing_enabled: !key.disabled,
    })
}

/// A management request naming a key this service does not hold. `404` on the
/// wire — the same code the signing path answers with, because the useful
/// distinction for a caller is "this id is not here", not which surface it
/// asked.
fn unknown_key(key_id: &str) -> Refusal {
    Refusal::failed(
        "signer-key-unknown",
        "this key is not held by the service",
        format!("no custody record for {key_id}"),
    )
}

/// A management request naming a caller that does not exist.
fn unknown_caller(caller_id: &str) -> Refusal {
    Refusal::failed(
        "signer-caller-unknown",
        "no caller is registered under this id",
        format!("no caller record for {caller_id}"),
    )
}

/// Decode a hexadecimal private key, or say what was wrong with it.
///
/// The message is safe to return to an authorized admin caller and the value is
/// not: nothing here quotes the input back, because the string it rejects *is*
/// a private key.
fn parse_raw_private_key(private_key: &str) -> Result<Zeroizing<[u8; 32]>, String> {
    let raw = hex::decode(private_key.trim())
        .map_err(|_| "the private key must be 64 hexadecimal characters".to_string())?;
    <[u8; 32]>::try_from(raw)
        .map(Zeroizing::new)
        .map_err(|_| "the private key must be exactly 32 bytes".to_string())
}

fn operator_label(label: &str) -> Result<String> {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        anyhow::bail!("a name is required");
    }
    Ok(trimmed.chars().take(120).collect())
}

/// The capability set a new caller record may be created with: one, named, and
/// any number of times (`["sign", "sign"]` is a caller that means `sign`, and
/// [`SignerCaller::normalized`] sorts the repeat out).
fn single_capability(capabilities: &[CallerCapability]) -> Option<Vec<CallerCapability>> {
    let mut distinct = capabilities.to_vec();
    distinct.sort();
    distinct.dedup();
    match distinct.as_slice() {
        [capability] => Some(vec![*capability]),
        _ => None,
    }
}

/// Validate the origins a caller will be bound to.
///
/// Validation rather than [`SignerCaller::normalized`]'s tidying, because a
/// silently dropped origin is a hole that reads as a policy: an operator who
/// typed `neo.org` and meant `https://neo.org` would otherwise get a caller that
/// accepts nothing, and would have no way to find out the entry was never what
/// they meant.
fn normalize_origins(origins: &[String]) -> Result<Vec<String>> {
    origins
        .iter()
        .map(|origin| {
            auth::normalize_origin(origin).ok_or_else(|| {
                anyhow::anyhow!(
                    "{origin} is not an origin; write it as a full URL such as https://neo.org"
                )
            })
        })
        .collect()
}

fn normalize_subject(subject: Option<&str>) -> Result<Option<String>> {
    let Some(subject) = subject else {
        return Ok(None);
    };
    let subject = subject.trim();
    if subject.is_empty() {
        anyhow::bail!("workload_subject must be omitted or non-empty");
    }
    if subject.len() > 200 || subject.chars().any(char::is_control) {
        anyhow::bail!("workload_subject must be at most 200 printable characters");
    }
    Ok(Some(subject.to_string()))
}

/// What a stored boundary commits to, in one line an operator can re-read.
fn policy_summary(policy: &SignerPolicy) -> String {
    let mut allowed: Vec<&str> = Vec::new();
    if policy.allow_consensus {
        allowed.push("consensus");
    }
    if policy.allow_transfer {
        allowed.push("transfer");
    }
    if policy.allow_contract_call {
        allowed.push("contract-call");
    }
    if policy.allow_global_scope {
        allowed.push("global-scope");
    }
    if policy.allow_raw {
        allowed.push("raw");
    }
    let mut summary = if allowed.is_empty() {
        String::from("nothing allowed")
    } else {
        format!("allowed {}", allowed.join(", "))
    };
    if let Some(ceiling) = policy.max_single_amount {
        summary.push_str(&format!(", per-transfer <= {ceiling}"));
    }
    if let Some(limit) = policy.window_limit {
        summary.push_str(&format!(
            ", per-token window {}s <= {}",
            limit.seconds, limit.max_amount
        ));
    }
    if let Some(max_signers) = policy.max_signers {
        summary.push_str(&format!(", signers <= {max_signers}"));
    }
    if let Some(max_system_fee) = policy.max_system_fee {
        summary.push_str(&format!(", system-fee <= {max_system_fee}"));
    }
    if let Some(max_network_fee) = policy.max_network_fee {
        summary.push_str(&format!(", network-fee <= {max_network_fee}"));
    }
    summary.push_str(&format!(
        "; lists contracts {}/{} methods {}/{} assets {}/{} recipients {}/{}",
        policy.contract_whitelist.len(),
        policy.contract_blacklist.len(),
        policy.contract_method_whitelist.len(),
        policy.contract_method_blacklist.len(),
        policy.asset_whitelist.len(),
        policy.asset_blacklist.len(),
        policy.transfer_to_whitelist.len(),
        policy.transfer_to_blacklist.len(),
    ));
    summary
}

fn caller_summary(caller: &SignerCaller) -> String {
    format!(
        "{} [{}] granting {} to {}; {} origin(s)",
        caller.label,
        if caller.workload_identity.is_some() {
            "workload-ed25519"
        } else {
            "bearer"
        },
        match &caller.key_grant {
            KeyGrant::Any => "every key".to_string(),
            KeyGrant::Only(ids) => format!("{} key(s)", ids.len()),
        },
        // Named because the grant says what a caller can touch and this says what
        // it can do: a row reading "grants 3 keys" is indistinguishable whether
        // the change handed out signing authority or console authority.
        if caller.capabilities.is_empty() {
            "no capabilities".to_string()
        } else {
            caller
                .capabilities
                .iter()
                .map(|capability| capability.label())
                .collect::<Vec<_>>()
                .join("+")
        },
        caller.allowed_origins.len()
    )
}

/// How much of the request the policy had to look at, for the audit row.
fn intent_summary(intents: &[Intent]) -> String {
    let mut transfers = 0usize;
    let mut calls = 0usize;
    let mut moved: i128 = 0;
    for intent in intents {
        match intent {
            Intent::Transfer { amount, .. } => {
                transfers += 1;
                moved = moved.saturating_add(*amount);
            }
            Intent::ContractCall { .. } => calls += 1,
        }
    }
    if transfers == 0 && calls == 0 {
        return String::from("no contract calls");
    }
    format!("{transfers} transfer(s) totalling {moved}, {calls} other call(s)")
}

fn valid_request_id(request_id: &str) -> bool {
    !request_id.is_empty()
        && request_id.len() <= 128
        && request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn idempotency_digest(action: SignerAuditAction, key_id: &str, unsigned: &[u8]) -> [u8; 32] {
    let mut framed = Vec::with_capacity(32 + key_id.len() + unsigned.len());
    framed.extend_from_slice(b"neoos-signer-request-v1\0");
    framed.extend_from_slice(action.label().as_bytes());
    framed.push(0);
    framed.extend_from_slice(key_id.as_bytes());
    framed.push(0);
    framed.extend_from_slice(unsigned);
    crypto::sha256(&framed)
        .try_into()
        .expect("SHA-256 always returns 32 bytes")
}

fn now_unix() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before Unix epoch")?
        .as_secs())
}

#[cfg(test)]
#[path = "../tests/unit/service.rs"]
mod tests;
