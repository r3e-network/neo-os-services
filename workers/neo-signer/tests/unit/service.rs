//! The signing path end to end: identify, guard, decide, sign, write down.
//!
//! Every test here drives [`SignerService`] through its public surface against a
//! real SQLite workspace in a temporary directory, because the parts worth
//! pinning are the joints: whether a refusal leaves the spend ledger untouched,
//! whether the audit row names the caller that asked, whether the bytes the
//! policy judged are the bytes the signature covers. Those are exactly the
//! things a unit test of [`crate::policy`] cannot see, since the engine
//! is pure and holds no state.
//!
//! The signatures are checked against an independently built preimage
//! (`SHA256(magic || SHA256(bytes))`) rather than against this service's own
//! helper, so a preimage that drifted in both directions at once would still
//! fail here.

use anyhow::Result;

use super::*;
use crate::{model::WindowLimit, network, tx::HASH160_LEN};

/// A recipient, an asset-agnostic account: nothing in these tests depends on it
/// being a real wallet, only on it being an account that is not the key's own.
const RECIPIENT: [u8; HASH160_LEN] = [0x22u8; HASH160_LEN];

/// One custody workspace: a temporary database, a vault over it, a generated key
/// and a server-to-server caller granted every key.
///
/// The harness boots the way an operator does — [`provision_admin_caller`] seeds
/// the one admin credential, and that credential creates the signing caller — so
/// every test below drives the authenticated surface exactly as a consumer does,
/// management calls included. `admin` is the credential those calls need;
/// [`Custody::credentials`] is the signing one.
struct Custody {
    service: SignerService,
    /// The vault's key, as the management API described it back. No sealed
    /// envelope rides along, which is the point of the type.
    key: KeyPublicInfo,
    token: String,
    caller_id: String,
    admin: CallerCredentials,
    admin_id: String,
    // Declared last so it outlives everything that reads through it.
    _dir: tempfile::TempDir,
}

impl Custody {
    fn open() -> Result<Self> {
        let dir = tempfile::tempdir()?;
        let repository = Store::open(dir.path().join("neonexus.db"))?;
        let service = SignerService::new(repository, MasterKey::from_bytes([9u8; 32]));
        let (admin_row, admin_token) = provision_admin_caller(service.repository(), "bootstrap")?;
        let admin = CallerCredentials::server_to_server(&admin_token);
        let key = allowed(service.generate_key(&admin, "treasury", Network::Testnet)?);
        let (caller, token) = allowed(service.create_caller(
            &admin,
            "relayer",
            KeyGrant::Any,
            &[CallerCapability::Sign],
            &[],
        )?);
        Ok(Custody {
            service,
            key,
            token,
            caller_id: caller.id,
            admin,
            admin_id: admin_row.id,
            _dir: dir,
        })
    }

    fn credentials(&self) -> CallerCredentials {
        CallerCredentials::server_to_server(&self.token)
    }

    fn account(&self) -> [u8; HASH160_LEN] {
        self.key.script_hash.as_bytes()
    }

    /// A NEO transfer of `amount` from the harness key to [`RECIPIENT`].
    fn transfer(&self, amount: i128, nonce: u32) -> Vec<u8> {
        let script = transfer_script(self.account(), RECIPIENT, amount, tx::native::NEO);
        transaction(self.account(), nonce, &script)
    }

    fn sign(&self, unsigned: &[u8]) -> Result<SignResponse> {
        self.service
            .sign_transaction(&self.credentials(), &self.key.key_id, unsigned)
    }

    /// Set a boundary as the provisioned admin, and hand back what was stored.
    fn save(&self, policy: &SignerPolicy) -> Result<SignerPolicy> {
        Ok(allowed(self.service.save_policy(
            &self.admin,
            &self.key.key_id,
            policy,
        )?))
    }

    /// Allow transfers of NEO and nothing else.
    fn allow_neo_transfers(&self) -> Result<SignerPolicy> {
        self.save(&SignerPolicy {
            allow_transfer: true,
            asset_whitelist: vec![ScriptHash::from_wire(tx::native::NEO)],
            ..Default::default()
        })
    }

    fn spend(&self) -> Result<Vec<SignerValueEvent>> {
        self.service
            .repository()
            .signer_value_events_since(&self.key.key_id, 0)
    }

    fn audit(&self) -> Result<Vec<SignerAuditRecord>> {
        self.service.repository().list_signer_audit(None, 100)
    }
}

// -- request builders -------------------------------------------------------

/// `PUSHDATA1`, the only push width a hand-written call script needs here.
fn push_bytes(bytes: &[u8]) -> Vec<u8> {
    let mut out = vec![0x0c, bytes.len() as u8];
    out.extend_from_slice(bytes);
    out
}

/// Fewest little-endian bytes that still read back as `value`.
fn minimal_le_bytes(value: i128) -> Vec<u8> {
    let all = value.to_le_bytes();
    let filler = if value < 0 { 0xffu8 } else { 0u8 };
    let mut length = 1usize;
    loop {
        let top = all[length - 1];
        let sign_honest = if value < 0 {
            top & 0x80 != 0
        } else {
            top & 0x80 == 0
        };
        if sign_honest && all[length..].iter().all(|byte| *byte == filler) {
            break;
        }
        length += 1;
    }
    all[..length].to_vec()
}

/// A `PUSHINT*` of the widths the VM defines (1, 2, 4, 8 bytes), padded with the
/// value's own sign. Every amount in these tests fits in eight.
fn push_integer(value: i128) -> Vec<u8> {
    let bytes = minimal_le_bytes(value);
    let (opcode, width): (u8, usize) = match bytes.len() {
        1 => (0x00, 1),
        2 => (0x01, 2),
        3..=4 => (0x02, 4),
        _ => (0x03, 8),
    };
    let mut out = vec![opcode];
    out.extend_from_slice(&bytes);
    out.resize(1 + width, if value < 0 { 0xff } else { 0x00 });
    out
}

/// A NEP-17 `transfer` call, pushed the way a wallet pushes it: arguments
/// last-first, `PACK`, then the flags, method and contract.
fn transfer_script(
    from: [u8; HASH160_LEN],
    to: [u8; HASH160_LEN],
    amount: i128,
    asset: [u8; HASH160_LEN],
) -> Vec<u8> {
    let mut script = Vec::new();
    script.push(0x0b);
    script.extend(push_integer(amount));
    script.extend(push_bytes(&to));
    script.extend(push_bytes(&from));
    script.extend([0x14, 0xc0]);
    script.push(0x1f);
    script.extend(push_bytes(b"transfer"));
    script.extend(push_bytes(&asset));
    script.push(0x41);
    script.extend(tx::CONTRACT_CALL_INTEROP);
    script
}

/// `SerializeUnsigned` for a transaction signed by exactly `account`.
fn transaction(account: [u8; HASH160_LEN], nonce: u32, script: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.push(0u8);
    out.extend_from_slice(&nonce.to_le_bytes());
    out.extend_from_slice(&0i64.to_le_bytes());
    out.extend_from_slice(&0i64.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.push(1);
    out.extend_from_slice(&account);
    out.push(tx::Scope::CALLED_BY_ENTRY);
    out.push(0);
    out.push(script.len() as u8);
    out.extend_from_slice(script);
    out
}

/// `SerializeUnsigned` for an extensible payload — the container dBFT uses.
fn consensus_payload(category: &str, sender: [u8; HASH160_LEN]) -> Vec<u8> {
    let mut out = vec![category.len() as u8];
    out.extend_from_slice(category.as_bytes());
    out.extend_from_slice(&100u32.to_le_bytes());
    out.extend_from_slice(&200u32.to_le_bytes());
    out.extend_from_slice(&sender);
    out.push(1);
    out.push(0x01);
    out
}

// -- assertions -------------------------------------------------------------

fn allowed<T>(outcome: Outcome<T>) -> T {
    match outcome {
        Outcome::Allowed(value) => value,
        Outcome::Refused(refusal) => {
            unreachable!(
                "expected permission, refused with {}: {}",
                refusal.code, refusal.message
            )
        }
    }
}

fn refused<T>(outcome: Outcome<T>) -> Refusal {
    match outcome {
        Outcome::Refused(refusal) => refusal,
        Outcome::Allowed(_) => unreachable!("expected a refusal, got a signature"),
    }
}

/// The 64-byte `r||s` out of `0c 40 …`.
fn signature_of(witness: &SignedWitness) -> [u8; 64] {
    witness
        .invocation
        .get(2..66)
        .map(|bytes| bytes.to_vec())
        .unwrap_or_else(|| unreachable!("an invocation script is always 66 bytes"))
        .as_slice()
        .try_into()
        .unwrap_or_else(|_| unreachable!("64 bytes are 64 bytes"))
}

fn row_with(rows: &[SignerAuditRecord], action: SignerAuditAction) -> SignerAuditRecord {
    rows.iter()
        .find(|row| row.action == action)
        .cloned()
        .unwrap_or_else(|| {
            unreachable!(
                "expected a {action} row; the log holds {:?}",
                rows.iter().map(|row| row.action).collect::<Vec<_>>()
            )
        })
}

/// `magic_le32 || SHA256(bytes)` — the 36 bytes the curve is asked over, built
/// without [`crypto::sign_data`] so the checks below do not pass merely because
/// both sides agree. (The curve hashes this again; that is N3's second hash.)
fn preimage(unsigned: &[u8], magic: u32) -> Vec<u8> {
    let mut out = magic.to_le_bytes().to_vec();
    out.extend(crypto::sha256(unsigned));
    out
}

// -- the boundary decides ---------------------------------------------------

#[test]
fn a_key_with_no_boundary_signs_nothing() -> Result<()> {
    let custody = Custody::open()?;

    let unsigned = custody.transfer(100, 1);
    let refusal = refused(custody.sign(&unsigned)?);
    assert_eq!(refusal.code, policy::DenyReason::TransferForbidden.code());
    assert_eq!(refusal.outcome, SignerAuditOutcome::Denied);
    assert!(
        custody.spend()?.is_empty(),
        "a refusal must not spend the window"
    );
    Ok(())
}

#[test]
fn an_allowed_transfer_is_signed_over_the_preimage_the_node_checks() -> Result<()> {
    let custody = Custody::open()?;
    custody.allow_neo_transfers()?;

    let unsigned = custody.transfer(100, 1);
    let witness = allowed(custody.sign(&unsigned)?);

    assert_eq!(witness.key_id, custody.key.key_id);
    assert_eq!(witness.address, custody.key.address);
    assert_eq!(
        witness.script_hash,
        ScriptHash::from_wire(custody.account())
    );
    assert_eq!(witness.verification, custody.key.verification_script);
    assert_eq!(&witness.invocation[..2], &[0x0c, 0x40]);
    let magic = network::network_magic(Network::Testnet);
    assert!(
        crypto::verify_signature(
            &custody.key.public_key,
            &preimage(&unsigned, magic),
            &signature_of(&witness)
        ),
        "the signature must cover the bytes the caller sent, hashed the way the node hashes them"
    );
    assert_eq!(
        witness.digest,
        tx::script_hash_to_display(&crypto::transaction_hash(&unsigned))
    );

    // What left the key is on the ledger, and the ledger row names the decision.
    let events = custody.spend()?;
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].amount, 100);
    assert_eq!(events[0].asset, ScriptHash::from_wire(tx::native::NEO));
    assert_eq!(events[0].key_id, custody.key.key_id);

    let row = row_with(&custody.audit()?, SignerAuditAction::TransactionSigned);
    assert_eq!(row.outcome, SignerAuditOutcome::Allowed);
    assert_eq!(row.key_id.as_deref(), Some(custody.key.key_id.as_str()));
    assert_eq!(row.caller_id.as_deref(), Some(custody.caller_id.as_str()));
    assert_eq!(row.tx_id.as_deref(), Some(witness.digest.as_str()));
    assert!(
        row.reason.is_none(),
        "an allowed request has no refusal code"
    );
    let detail = row
        .detail
        .clone()
        .unwrap_or_else(|| unreachable!("a signature is always explained"));
    assert!(detail.contains("1 transfer(s) totalling 100"), "{detail}");
    assert_eq!(events[0].audit_id, Some(row.id));
    Ok(())
}

#[test]
fn a_witness_does_not_carry_over_to_another_network() -> Result<()> {
    let custody = Custody::open()?;
    custody.allow_neo_transfers()?;

    let unsigned = custody.transfer(100, 7);
    let witness = allowed(custody.sign(&unsigned)?);
    let signature = signature_of(&witness);
    let public_key = custody.key.public_key;

    assert!(crypto::verify_signature(
        &public_key,
        &preimage(&unsigned, network::network_magic(Network::Testnet)),
        &signature
    ));
    for network in [Network::Mainnet, Network::Private] {
        assert!(
            !crypto::verify_signature(
                &public_key,
                &preimage(&unsigned, network::network_magic(network)),
                &signature
            ),
            "{network} shares these bytes but not this key's chain"
        );
    }
    Ok(())
}

#[test]
fn a_rolling_window_counts_only_the_signatures_it_allowed() -> Result<()> {
    let custody = Custody::open()?;
    custody.save(&SignerPolicy {
        allow_transfer: true,
        window_limit: Some(WindowLimit {
            seconds: 3_600,
            max_amount: 1_000,
        }),
        ..Default::default()
    })?;

    let first = custody.transfer(600, 1);
    allowed(custody.sign(&first)?);

    // 600 already gone, so 600 more is over the ceiling — and it is the *sum*
    // that fails, not the single amount, which is well inside any ceiling.
    let second = custody.transfer(600, 2);
    let refusal = refused(custody.sign(&second)?);
    assert_eq!(
        refusal.code,
        policy::DenyReason::WindowAmountExceeded.code()
    );
    assert_eq!(custody.spend()?.len(), 1);

    // The refusal cost nothing, so the remaining room is still there.
    let third = custody.transfer(400, 3);
    allowed(custody.sign(&third)?);
    let events = custody.spend()?;
    assert_eq!(events.len(), 2);
    assert_eq!(events[1].amount, 400);
    Ok(())
}

#[test]
fn a_batch_is_measured_as_the_transfer_that_broke_the_ceiling() -> Result<()> {
    let custody = Custody::open()?;
    custody.save(&SignerPolicy {
        allow_transfer: true,
        max_single_amount: Some(1_000),
        window_limit: Some(WindowLimit {
            seconds: 3_600,
            max_amount: 1_000,
        }),
        ..Default::default()
    })?;

    // Two payments each inside the per-transfer ceiling, together over the
    // window: the engine adds them one at a time as it decides, so the batch is
    // refused before a signature exists rather than half of it being paid for.
    let account = custody.account();
    let script = [
        transfer_script(account, RECIPIENT, 600, tx::native::NEO),
        transfer_script(account, RECIPIENT, 600, tx::native::NEO),
    ]
    .concat();
    let unsigned = transaction(account, 4, &script);
    let refusal = refused(custody.sign(&unsigned)?);
    assert_eq!(
        refusal.code,
        policy::DenyReason::WindowAmountExceeded.code()
    );
    assert!(
        custody.spend()?.is_empty(),
        "half a batch must not be paid for"
    );
    Ok(())
}

#[test]
fn a_caller_cannot_sign_away_another_account() -> Result<()> {
    let custody = Custody::open()?;
    custody.allow_neo_transfers()?;

    // Well-formed, and the caller holds a valid token — but the witness this
    // key produces is being offered to move someone else's tokens.
    let someone_else = [0x77u8; HASH160_LEN];
    let script = transfer_script(someone_else, RECIPIENT, 100, tx::native::NEO);
    let unsigned = transaction(someone_else, 5, &script);
    let refusal = refused(custody.sign(&unsigned)?);
    assert_eq!(refusal.code, policy::DenyReason::NotASigner.code());
    assert_eq!(refusal.outcome, SignerAuditOutcome::Denied);
    Ok(())
}

// -- guards -----------------------------------------------------------------

#[test]
fn the_kill_switch_refuses_before_the_boundary_is_read() -> Result<()> {
    let custody = Custody::open()?;
    let boundary = custody.allow_neo_transfers()?;
    custody
        .service
        .set_key_disabled(&custody.admin, &custody.key.key_id, true)?;

    let unsigned = custody.transfer(100, 1);
    let refusal = refused(custody.sign(&unsigned)?);
    assert_eq!(refusal.code, GuardRejection::KeyDisabled.code());
    assert_eq!(refusal.outcome, SignerAuditOutcome::Denied);
    assert!(boundary.allow_transfer);

    // A caller can still see the account, and is told signing is off — "off"
    // and "gone" have to be distinguishable or nothing gets restarted right.
    let info = allowed(
        custody
            .service
            .key_info(&custody.credentials(), &custody.key.key_id)?,
    );
    assert!(!info.signing_enabled);
    assert_eq!(info.address, custody.key.address);

    let row = row_with(&custody.audit()?, SignerAuditAction::TransactionSigned);
    assert_eq!(
        row.reason.as_deref(),
        Some(GuardRejection::KeyDisabled.code())
    );

    custody
        .service
        .set_key_disabled(&custody.admin, &custody.key.key_id, false)?;
    let response = custody.sign(&unsigned)?;
    assert!(
        matches!(response, Outcome::Allowed(_)),
        "flipping the switch back has to flip signing back"
    );
    Ok(())
}

#[test]
fn a_key_sealed_under_another_vault_is_a_failure_not_a_denial() -> Result<()> {
    let custody = Custody::open()?;
    custody.allow_neo_transfers()?;
    let other_vault = SignerService::new(
        custody.service.repository().clone(),
        MasterKey::from_bytes([12u8; 32]),
    );

    let unsigned = custody.transfer(100, 1);
    let refusal = refused(other_vault.sign_transaction(
        &custody.credentials(),
        &custody.key.key_id,
        &unsigned,
    )?);
    assert_eq!(refusal.code, "signer-vault-unreadable");
    assert_eq!(refusal.outcome, SignerAuditOutcome::Failed);
    // The record is intact: the same request under the right vault still works.
    assert!(matches!(custody.sign(&unsigned)?, Outcome::Allowed(_)));
    Ok(())
}

#[test]
fn bytes_the_service_cannot_read_are_refused_without_a_signature() -> Result<()> {
    let custody = Custody::open()?;
    custody.allow_neo_transfers()?;

    let junk = refused(custody.sign(&[0xff, 0xff, 0xff, 0xff, 0xff])?);
    assert_eq!(junk.code, "signer-transaction-unparsable");
    assert_eq!(junk.outcome, SignerAuditOutcome::Failed);

    // A valid transaction envelope whose script needs a step the decoder does
    // not implement: the bytes parse, and what they would do does not.
    let smuggled = transaction(custody.account(), 2, &[0x21]);
    let script = refused(custody.sign(&smuggled)?);
    assert_eq!(script.code, "signer-script-unparsable");
    assert_eq!(script.outcome, SignerAuditOutcome::Failed);
    assert!(custody.spend()?.is_empty());
    Ok(())
}

// -- access -----------------------------------------------------------------

#[test]
fn a_caller_cannot_name_a_key_it_was_not_granted() -> Result<()> {
    let custody = Custody::open()?;
    custody.allow_neo_transfers()?;
    let (outsider, token) = allowed(custody.service.create_caller(
        &custody.admin,
        "outsider",
        KeyGrant::Only(vec!["key-someone-elses".to_string()]),
        &[CallerCapability::Sign],
        &[],
    )?);
    let credentials = CallerCredentials::server_to_server(&token);

    let unsigned = custody.transfer(100, 1);
    let refusal = refused(custody.service.sign_transaction(
        &credentials,
        &custody.key.key_id,
        &unsigned,
    )?);
    assert_eq!(refusal.code, AccessRejection::KeyNotGranted.code());
    assert!(custody.spend()?.is_empty());

    // The row still says who asked, and for what, even though the answer was no.
    let row = row_with(&custody.audit()?, SignerAuditAction::TransactionSigned);
    assert_eq!(
        row.reason.as_deref(),
        Some(AccessRejection::KeyNotGranted.code())
    );
    assert_eq!(row.key_id.as_deref(), Some(custody.key.key_id.as_str()));
    assert_eq!(row.caller_id.as_deref(), Some(outsider.id.as_str()));
    Ok(())
}

#[test]
fn a_token_that_matches_nobody_is_filed_as_a_probe() -> Result<()> {
    let custody = Custody::open()?;
    let credentials = CallerCredentials::server_to_server("nsk1_not_a_real_token");

    let unsigned = custody.transfer(100, 1);
    let refusal = refused(custody.service.sign_transaction(
        &credentials,
        &custody.key.key_id,
        &unsigned,
    )?);
    assert_eq!(refusal.code, AccessRejection::UnknownToken.code());

    let rows = custody.audit()?;
    let row = row_with(&rows, SignerAuditAction::UnknownToken);
    assert_eq!(row.outcome, SignerAuditOutcome::Denied);
    assert!(
        row.caller_id.is_none(),
        "there is no caller to attribute, and naming one would blame the wrong row"
    );
    assert!(
        row.key_id.is_none(),
        "an unauthenticated request must not put a custody key in the log"
    );
    assert!(
        !rows
            .iter()
            .any(|row| row.action == SignerAuditAction::TransactionSigned),
        "nothing was signed, so nothing is filed under signing"
    );
    Ok(())
}

#[test]
fn a_request_with_no_token_is_turned_away_at_the_door() -> Result<()> {
    let custody = Custody::open()?;
    let credentials = CallerCredentials::server_to_server("");

    let unsigned = custody.transfer(100, 1);
    let refusal = refused(custody.service.sign_transaction(
        &credentials,
        &custody.key.key_id,
        &unsigned,
    )?);
    assert_eq!(refusal.code, AccessRejection::MissingToken.code());
    assert_eq!(refusal.outcome, SignerAuditOutcome::Denied);
    // Nothing about the vault was read to answer it.
    assert_eq!(refusal.detail, AccessRejection::MissingToken.to_string());

    let row = row_with(&custody.audit()?, SignerAuditAction::TransactionSigned);
    assert!(
        row.caller_id.is_none(),
        "there is no caller behind this request"
    );
    assert!(
        row.key_id.is_none(),
        "and a request that proved nothing must not pin a custody key to it"
    );
    Ok(())
}

#[test]
fn an_origin_bound_caller_signs_only_from_its_origin() -> Result<()> {
    let custody = Custody::open()?;
    custody.allow_neo_transfers()?;
    let (browser, token) = allowed(custody.service.create_caller(
        &custody.admin,
        "dapp",
        KeyGrant::Any,
        &[CallerCapability::Sign],
        &["HTTPS://Neo.ORG/app".to_string()],
    )?);

    let unsigned = custody.transfer(100, 1);
    let from_page = CallerCredentials::new(
        Some(&format!("Bearer {token}")),
        Some("https://neo.org"),
        None,
    );
    assert!(matches!(
        custody
            .service
            .sign_transaction(&from_page, &custody.key.key_id, &unsigned)?,
        Outcome::Allowed(_)
    ));

    let lookalike = CallerCredentials::new(
        Some(&format!("Bearer {token}")),
        Some("https://neo.org.evil.test"),
        None,
    );
    let refusal = refused(custody.service.sign_transaction(
        &lookalike,
        &custody.key.key_id,
        &unsigned,
    )?);
    assert_eq!(
        refusal.code,
        AccessRejection::OriginNotAllowed.code(),
        "a suffix match here is the classic way an origin list is bypassed"
    );

    let with_no_origin = CallerCredentials::new(Some(&format!("Bearer {token}")), None, None);
    assert_eq!(
        refused(custody.service.sign_transaction(
            &with_no_origin,
            &custody.key.key_id,
            &unsigned
        )?)
        .code,
        AccessRejection::OriginRequired.code()
    );

    // The caller bound to origins is audited with the origin it presented.
    let rows = custody.audit()?;
    let refused_row = rows
        .iter()
        .find(|row| row.reason.as_deref() == Some(AccessRejection::OriginNotAllowed.code()))
        .unwrap_or_else(|| unreachable!("the refusal above belongs in the log"));
    assert_eq!(
        refused_row.origin.as_deref(),
        Some("https://neo.org.evil.test")
    );
    assert_eq!(
        refused_row.caller_id.as_deref(),
        Some(browser.id.as_str()),
        "the token still identified the caller; only the origin was wrong"
    );
    assert_eq!(
        custody.spend()?.len(),
        1,
        "only the request that was allowed moved value"
    );
    Ok(())
}

#[test]
fn a_server_to_server_caller_refuses_a_browser_origin() -> Result<()> {
    let custody = Custody::open()?;
    custody.allow_neo_transfers()?;

    // The harness caller declared no origins, so it is server-to-server: a
    // token turning up in a page is the leak the operator wants noticed.
    let from_page = CallerCredentials::new(
        Some(&format!("Bearer {}", custody.token)),
        Some("https://neo.org"),
        None,
    );
    let unsigned = custody.transfer(100, 1);
    let refusal = refused(custody.service.sign_transaction(
        &from_page,
        &custody.key.key_id,
        &unsigned,
    )?);
    assert_eq!(refusal.code, AccessRejection::OriginUnexpected.code());
    assert!(custody.spend()?.is_empty());
    Ok(())
}

#[test]
fn an_origin_has_to_be_written_as_a_url() -> Result<()> {
    let custody = Custody::open()?;

    let refusal = refused(custody.service.create_caller(
        &custody.admin,
        "dapp",
        KeyGrant::Any,
        &[CallerCapability::Sign],
        &["neo.org".to_string()],
    )?);
    assert_eq!(refusal.code, "signer-admin-request-invalid");
    assert!(refusal.message.contains("not an origin"), "{refusal:?}");
    assert_eq!(refusal.outcome, SignerAuditOutcome::Denied);
    assert!(
        custody
            .service
            .repository()
            .list_signer_callers()?
            .iter()
            .all(|caller| caller.label != "dapp"),
        "a rejected caller must not exist half-built"
    );
    Ok(())
}

// -- capabilities -----------------------------------------------------------

#[test]
fn a_signing_credential_reaches_no_management_route_and_the_no_is_written_down() -> Result<()> {
    let custody = Custody::open()?;
    let signer = custody.credentials();

    let listed = refused(custody.service.list_keys(&signer)?);
    assert_eq!(listed.code, AccessRejection::CapabilityMissing.code());
    assert_eq!(listed.outcome, SignerAuditOutcome::Denied);
    let saved = refused(custody.service.save_policy(
        &signer,
        &custody.key.key_id,
        &SignerPolicy {
            allow_transfer: true,
            ..Default::default()
        },
    )?);
    assert_eq!(
        saved.code, listed.code,
        "the same no, whichever route asked"
    );

    // The refusal says nothing was touched, so nothing may have been.
    assert!(custody
        .service
        .repository()
        .load_signer_policy(&custody.key.key_id)?
        .is_none());
    // Both nos are attributable: "a relayer's token tried to open the console"
    // is the row an operator acts on.
    for action in [SignerAuditAction::KeyViewed, SignerAuditAction::PolicySaved] {
        let row = row_with(&custody.audit()?, action);
        assert_eq!(row.caller_id.as_deref(), Some(custody.caller_id.as_str()));
        assert_eq!(row.reason.as_deref(), Some(listed.code));
        assert_eq!(row.outcome, SignerAuditOutcome::Denied);
    }
    // And neither says anything about the vault it was refused from.
    assert!(!listed.message.contains(&custody.key.address), "{listed:?}");
    assert!(!saved.detail.contains(&custody.key.address), "{saved:?}");
    Ok(())
}

#[test]
fn an_admin_credential_cannot_sign_and_says_the_same_no() -> Result<()> {
    let custody = Custody::open()?;
    custody.allow_neo_transfers()?;
    let unsigned = custody.transfer(100, 1);

    let refusal = refused(custody.service.sign_transaction(
        &custody.admin,
        &custody.key.key_id,
        &unsigned,
    )?);
    assert_eq!(refusal.code, AccessRejection::CapabilityMissing.code());
    assert!(
        custody.spend()?.is_empty(),
        "a credential that may not sign may not spend the window either"
    );
    // One code, one sentence, both directions: otherwise whoever holds a bearer
    // string can offer it to two endpoints and learn which kind it is.
    let the_other_way = refused(custody.service.list_keys(&custody.credentials())?);
    assert_eq!(refusal.message, the_other_way.message);
    assert_eq!(refusal.code, the_other_way.code);
    Ok(())
}

#[test]
fn the_bootstrap_path_runs_once_and_never_grants_signing() -> Result<()> {
    let custody = Custody::open()?;
    let admin = custody
        .service
        .repository()
        .get_signer_caller(&custody.admin_id)?;
    assert_eq!(
        admin.capabilities,
        vec![CallerCapability::Admin],
        "the credential that opens a vault must not also be able to spend from it"
    );
    assert!(admin.key_grant.grants("any key created later"));

    let error = provision_admin_caller(custody.service.repository(), "second")
        .err()
        .unwrap_or_else(|| unreachable!("this vault already has an admin"));
    assert!(
        error.to_string().contains("already has an admin"),
        "{error}"
    );
    // bootstrap + the signing caller; the refusal wrote nothing.
    assert_eq!(custody.service.repository().list_signer_callers()?.len(), 2);
    Ok(())
}

#[test]
fn a_rotation_changes_the_credential_and_nothing_else() -> Result<()> {
    let custody = Custody::open()?;
    custody.allow_neo_transfers()?;
    let (scoped, token) = allowed(custody.service.create_caller(
        &custody.admin,
        "relayer-2",
        KeyGrant::Only(vec![custody.key.key_id.clone()]),
        &[CallerCapability::Sign],
        &[],
    )?);

    let rotated = allowed(
        custody
            .service
            .rotate_caller_token(&custody.admin, &scoped.id)?,
    );
    assert_ne!(rotated, token);
    let after = custody.service.repository().get_signer_caller(&scoped.id)?;
    assert_eq!(
        after.capabilities,
        vec![CallerCapability::Sign],
        "rotating a signing caller cannot produce an admin one"
    );
    assert_eq!(after.key_grant, scoped.key_grant);

    let fresh = CallerCredentials::server_to_server(&rotated);
    let unsigned = custody.transfer(100, 1);
    allowed(
        custody
            .service
            .sign_transaction(&fresh, &custody.key.key_id, &unsigned)?,
    );
    assert_eq!(
        refused(custody.service.list_keys(&fresh)?).code,
        AccessRejection::CapabilityMissing.code(),
        "the new token is the same authority, not a fresh chance at more"
    );
    Ok(())
}

#[test]
fn an_admin_granted_one_key_cannot_read_the_vault() -> Result<()> {
    let custody = Custody::open()?;
    let second = allowed(custody.service.generate_key(
        &custody.admin,
        "other",
        Network::Testnet,
    )?);
    let (_, token) = allowed(custody.service.create_caller(
        &custody.admin,
        "key-admin",
        KeyGrant::Only(vec![custody.key.key_id.clone()]),
        &[CallerCapability::Admin],
        &[],
    )?);
    let admin = CallerCredentials::server_to_server(&token);

    // The key it was granted: readable, and the only one it can name.
    let (info, _) = allowed(custody.service.key_detail(&admin, &custody.key.key_id)?);
    assert_eq!(info.key_id, custody.key.key_id);
    assert_eq!(
        refused(custody.service.key_detail(&admin, &second.key_id)?).code,
        AccessRejection::KeyNotGranted.code()
    );
    // A request naming no key reaches every key, so the grant that binds it is
    // the whole vault — an admin scoped to one row must not be able to list the
    // rows it was scoped away from.
    assert_eq!(
        refused(custody.service.list_keys(&admin)?).code,
        AccessRejection::KeyNotGranted.code()
    );
    assert_eq!(
        refused(custody.service.create_caller(
            &admin,
            "escalation",
            KeyGrant::Any,
            &[CallerCapability::Admin],
            &[],
        )?)
        .code,
        AccessRejection::KeyNotGranted.code(),
        "creating a caller grants across the vault, so it needs the vault"
    );
    Ok(())
}

// -- consensus --------------------------------------------------------------

#[test]
fn consensus_signing_needs_its_own_permission_and_its_own_sender() -> Result<()> {
    let custody = Custody::open()?;
    custody.allow_neo_transfers()?;
    let payload = consensus_payload(policy::CONSENSUS_CATEGORY, custody.account());
    let sign = |credentials: &CallerCredentials,
                service: &SignerService,
                key_id: &str,
                bytes: &[u8]| service.sign_consensus(credentials, key_id, bytes);

    let refusal = refused(sign(
        &custody.credentials(),
        &custody.service,
        &custody.key.key_id,
        &payload,
    )?);
    assert_eq!(refusal.code, policy::DenyReason::ConsensusForbidden.code());

    custody.save(&SignerPolicy {
        allow_transfer: true,
        allow_consensus: true,
        ..Default::default()
    })?;
    let witness = allowed(sign(
        &custody.credentials(),
        &custody.service,
        &custody.key.key_id,
        &payload,
    )?);
    assert!(crypto::verify_signature(
        &custody.key.public_key,
        &preimage(&payload, network::network_magic(Network::Testnet)),
        &signature_of(&witness)
    ));
    let row = row_with(&custody.audit()?, SignerAuditAction::ConsensusSigned);
    assert_eq!(row.tx_id.as_deref(), Some(witness.digest.as_str()));
    assert_eq!(row.outcome, SignerAuditOutcome::Allowed);

    // Another committee member's round, relayed to this key: refused.
    let not_mine = consensus_payload(policy::CONSENSUS_CATEGORY, [0x33u8; HASH160_LEN]);
    assert_eq!(
        refused(sign(
            &custody.credentials(),
            &custody.service,
            &custody.key.key_id,
            &not_mine
        )?)
        .code,
        policy::DenyReason::ConsensusSenderMismatch.code()
    );

    // An application message wearing a consensus request.
    let disguised = consensus_payload("application", custody.account());
    assert_eq!(
        refused(sign(
            &custody.credentials(),
            &custody.service,
            &custody.key.key_id,
            &disguised
        )?)
        .code,
        policy::DenyReason::ConsensusCategoryForbidden.code()
    );

    // A consensus round signs many payloads in a block: it is not value, and it
    // must not eat the transfer window or leave ledger rows behind.
    assert!(custody.spend()?.is_empty());
    Ok(())
}

// -- custody bookkeeping ----------------------------------------------------

#[test]
fn a_key_already_in_custody_cannot_be_imported_twice() -> Result<()> {
    let custody = Custody::open()?;
    let private_key = [5u8; 32];
    let imported = allowed(custody.service.import_key(
        &custody.admin,
        "from-hex",
        Network::Mainnet,
        &hex::encode(private_key),
    )?);
    assert_eq!(imported.network, Network::Mainnet);
    assert_eq!(
        imported.public_key,
        crypto::public_key_from_private(&private_key)?
    );

    let refusal = refused(custody.service.import_key(
        &custody.admin,
        "again",
        Network::Mainnet,
        &hex::encode(private_key),
    )?);
    assert_eq!(refusal.code, "signer-admin-request-invalid");
    assert!(
        refusal
            .message
            .contains(&format!("already held as {}", imported.key_id)),
        "{refusal:?}"
    );
    // The harness key plus the one import; the refusal added nothing.
    assert_eq!(custody.service.repository().list_signer_keys()?.len(), 2);
    Ok(())
}

#[test]
fn a_nep2_import_seals_the_same_key_and_checks_the_passphrase_first() -> Result<()> {
    let custody = Custody::open()?;
    let private_key = [7u8; 32];
    let public_key = crypto::public_key_from_private(&private_key)?;
    let expected = crypto::address_from_script_hash(&crypto::script_hash(&public_key));
    let nep2 = crypto::encrypt_nep2(&private_key, "super-secret-passphrase")?;

    let imported = allowed(custody.service.import_nep2_key(
        &custody.admin,
        "from-nep2",
        Network::Testnet,
        &nep2,
        "super-secret-passphrase",
    )?);
    assert_eq!(imported.address, expected);
    assert_eq!(imported.public_key, public_key);
    let stored = custody
        .service
        .repository()
        .get_signer_key(&imported.key_id)?;
    assert_ne!(
        hex::encode(&stored.sealed.ciphertext),
        hex::encode(private_key),
        "the envelope must not be the key wearing a header"
    );

    let refusal = refused(custody.service.import_nep2_key(
        &custody.admin,
        "bad",
        Network::Testnet,
        &nep2,
        "wrong-passphrase",
    )?);
    assert_eq!(refusal.code, "signer-admin-request-invalid");
    assert!(
        refusal.message.contains("passphrase is wrong"),
        "{refusal:?}"
    );
    assert_eq!(custody.service.repository().list_signer_keys()?.len(), 2);
    Ok(())
}

#[test]
fn an_unusable_private_key_is_refused_rather_than_stored() -> Result<()> {
    let custody = Custody::open()?;
    let zeros = hex::encode([0u8; 32]);

    for (label, value, cause) in [
        ("short", "010203", "exactly 32 bytes"),
        ("words", "not-hex", "64 hexadecimal"),
        ("zero", zeros.as_str(), "P-256"),
    ] {
        let refusal = refused(custody.service.import_key(
            &custody.admin,
            label,
            Network::Testnet,
            value,
        )?);
        assert_eq!(refusal.code, "signer-admin-request-invalid", "{label}");
        assert!(refusal.message.contains(cause), "{label}: {refusal:?}");
        // What got rejected is a private key, so it does not come back on the
        // wire and does not get written down either.
        assert!(!refusal.message.contains(value), "{label} echoed back");
        assert!(!refusal.detail.contains(value), "{label} logged the key");
    }

    // Refused three times, stored nothing, and each no is attributable.
    assert_eq!(custody.service.repository().list_signer_keys()?.len(), 1);
    let rows = custody.audit()?;
    let refusals: Vec<&SignerAuditRecord> = rows
        .iter()
        .filter(|row| row.action == SignerAuditAction::KeyImported)
        .collect();
    assert_eq!(refusals.len(), 3, "{refusals:?}");
    for row in refusals {
        assert_eq!(row.outcome, SignerAuditOutcome::Denied);
        assert_eq!(row.reason.as_deref(), Some("signer-admin-request-invalid"));
        assert_eq!(row.caller_id.as_deref(), Some(custody.admin_id.as_str()));
        assert!(row.key_id.is_none(), "nothing was imported to name");
    }
    Ok(())
}

#[test]
fn what_a_caller_learns_about_a_key_holds_no_key_material() -> Result<()> {
    let custody = Custody::open()?;
    let stored = custody
        .service
        .repository()
        .get_signer_key(&custody.key.key_id)?;

    let info = allowed(
        custody
            .service
            .key_info(&custody.credentials(), &custody.key.key_id)?,
    );
    assert_eq!(info.public_key, stored.public_key);
    assert_eq!(info.verification_script, stored.verification_script());
    assert_eq!(&info.verification_script[..2], &[0x0c, 0x21]);
    assert_eq!(
        &info.verification_script[35..],
        &[0x41, 0x56, 0xe7, 0xb3, 0x27]
    );
    assert!(info.signing_enabled);

    let printed = format!("{info:?}");
    assert!(
        !printed.contains(&hex::encode(&stored.sealed.ciphertext)),
        "a caller-facing struct print must not carry the sealed envelope"
    );
    assert!(!printed.contains("sealed"), "{printed}");

    let unknown = refused(
        custody
            .service
            .key_info(&custody.credentials(), "key-not-there")?,
    );
    assert_eq!(unknown.code, "signer-key-unknown");
    assert_eq!(unknown.outcome, SignerAuditOutcome::Failed);
    Ok(())
}

#[test]
fn a_saved_boundary_comes_back_normalized_and_sums_itself_in_the_log() -> Result<()> {
    let custody = Custody::open()?;
    let stored = custody.save(&SignerPolicy {
        allow_transfer: true,
        asset_whitelist: vec![
            ScriptHash::from_wire(tx::native::GAS),
            ScriptHash::from_wire(tx::native::NEO),
            ScriptHash::from_wire(tx::native::NEO),
        ],
        transfer_to_whitelist: vec![ScriptHash::from_wire(RECIPIENT)],
        max_single_amount: Some(500),
        window_limit: Some(WindowLimit {
            seconds: 60,
            max_amount: 1_000,
        }),
        ..Default::default()
    })?;
    assert_eq!(
        stored.asset_whitelist.len(),
        2,
        "a duplicate entry is dropped, not stored twice"
    );
    assert_eq!(
        custody
            .service
            .repository()
            .load_signer_policy(&custody.key.key_id)?
            .as_ref(),
        Some(&stored),
        "the row that lands in the database is the row a later read compares"
    );

    let detail = row_with(&custody.audit()?, SignerAuditAction::PolicySaved)
        .detail
        .clone()
        .unwrap_or_else(|| unreachable!("a saved boundary is always written down"));
    assert!(detail.contains("allowed transfer"), "{detail}");
    assert!(detail.contains("per-transfer <= 500"), "{detail}");
    assert!(detail.contains("window 60s <= 1000"), "{detail}");
    assert!(detail.contains("assets 2/0 recipients 1/0"), "{detail}");
    Ok(())
}

#[test]
fn deleting_a_key_keeps_the_record_of_what_it_signed() -> Result<()> {
    let custody = Custody::open()?;
    custody.allow_neo_transfers()?;
    let unsigned = custody.transfer(100, 1);
    allowed(custody.sign(&unsigned)?);
    let before = custody.audit()?;
    assert!(!custody.spend()?.is_empty());

    allowed(
        custody
            .service
            .delete_key(&custody.admin, &custody.key.key_id)?,
    );
    assert!(custody
        .service
        .repository()
        .find_signer_key(&custody.key.key_id)?
        .is_none());
    let after = custody.audit()?;
    assert!(
        after
            .iter()
            .any(|row| row.action == SignerAuditAction::TransactionSigned),
        "the transfers a key was authorised to make survive the key"
    );
    assert!(row_with(&after, SignerAuditAction::KeyDeleted)
        .detail
        .is_some());
    assert_eq!(
        custody
            .spend()?
            .iter()
            .filter(|event| event.key_id == custody.key.key_id)
            .count(),
        1,
        "the ledger is the window's memory; cascade would disarm it"
    );
    assert_eq!(after.len(), before.len() + 1);

    // A caller that still names the deleted key is answered, not crashed on.
    let refusal = refused(custody.sign(&unsigned)?);
    assert_eq!(refusal.code, "signer-key-unknown");
    Ok(())
}

#[test]
fn a_boundary_change_is_attributed_to_the_credential_that_made_it() -> Result<()> {
    let custody = Custody::open()?;

    custody.allow_neo_transfers()?;
    let row = row_with(&custody.audit()?, SignerAuditAction::PolicySaved);
    assert_eq!(
        row.caller_id.as_deref(),
        Some(custody.admin_id.as_str()),
        "a custody change came through the management API, so the row says whose"
    );
    assert_eq!(row.key_id.as_deref(), Some(custody.key.key_id.as_str()));
    assert_eq!(row.outcome, SignerAuditOutcome::Allowed);
    assert!(
        row.origin.is_none(),
        "a server-to-server call has no origin to record, and must not invent one"
    );
    Ok(())
}

#[test]
fn a_rotated_token_invalidates_the_old_one() -> Result<()> {
    let custody = Custody::open()?;
    custody.allow_neo_transfers()?;
    let unsigned = custody.transfer(100, 1);
    assert!(matches!(custody.sign(&unsigned)?, Outcome::Allowed(_)));

    let token = allowed(
        custody
            .service
            .rotate_caller_token(&custody.admin, &custody.caller_id)?,
    );
    assert_ne!(token, custody.token);
    let stale = refused(custody.sign(&unsigned)?);
    assert_eq!(stale.code, AccessRejection::UnknownToken.code());

    let fresh = CallerCredentials::server_to_server(&token);
    assert!(matches!(
        custody
            .service
            .sign_transaction(&fresh, &custody.key.key_id, &unsigned)?,
        Outcome::Allowed(_)
    ));
    Ok(())
}

#[test]
fn a_disabled_caller_is_refused_without_reading_the_boundary() -> Result<()> {
    let custody = Custody::open()?;
    custody.allow_neo_transfers()?;
    allowed(
        custody
            .service
            .set_caller_disabled(&custody.admin, &custody.caller_id, true)?,
    );

    let unsigned = custody.transfer(100, 1);
    let refusal = refused(custody.sign(&unsigned)?);
    assert_eq!(refusal.code, AccessRejection::CallerDisabled.code());
    assert!(custody.spend()?.is_empty());

    let row = row_with(&custody.audit()?, SignerAuditAction::TransactionSigned);
    assert_eq!(
        row.caller_id.as_deref(),
        Some(custody.caller_id.as_str()),
        "a disabled caller is still identified — its token matched"
    );
    Ok(())
}

#[test]
fn a_restarted_service_signs_the_same_bytes_the_same_way() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let repository = Store::open(dir.path().join("neonexus.db"))?;
    let first = SignerService::open(repository.clone(), dir.path())?;
    // A restart: the master key is resolved again, from the same data directory.
    let restarted = SignerService::open(repository.clone(), dir.path())?;
    assert_eq!(first.vault_fingerprint(), restarted.vault_fingerprint());

    let (_admin, admin_token) = provision_admin_caller(first.repository(), "bootstrap")?;
    let admin = CallerCredentials::server_to_server(&admin_token);
    let key = allowed(first.generate_key(&admin, "treasury", Network::Testnet)?);
    allowed(first.save_policy(
        &admin,
        &key.key_id,
        &SignerPolicy {
            allow_transfer: true,
            ..Default::default()
        },
    )?);
    let (_caller, token) = allowed(first.create_caller(
        &admin,
        "relayer",
        KeyGrant::Any,
        &[CallerCapability::Sign],
        &[],
    )?);
    let credentials = CallerCredentials::server_to_server(&token);
    let account = key.script_hash.as_bytes();
    let unsigned = transaction(
        account,
        1,
        &transfer_script(account, RECIPIENT, 100, tx::native::NEO),
    );

    let before = allowed(first.sign_transaction(&credentials, &key.key_id, &unsigned)?);
    let after = allowed(restarted.sign_transaction(&credentials, &key.key_id, &unsigned)?);
    assert_eq!(
        before.invocation, after.invocation,
        "the nonce is derived from the key and the bytes, so a restart cannot change the signature"
    );
    assert_eq!(before.digest, after.digest);
    assert_eq!(before.address, key.address);

    // The management credential survives the restart as well. A service that
    // came back unable to answer for its own vault is a service that has lost
    // the boundary it exists to enforce.
    let listed = allowed(restarted.list_keys(&admin)?);
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].key_id, key.key_id);
    Ok(())
}
