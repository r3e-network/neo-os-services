//! Synthetic source qualification only. No real holder material or service.
//! Authored with the candidate; NOT executed as part of its preparation.
use super::*;
use crate::{store::Store, vault_profile::VaultProfile};
use serde_json::{json, Value};

const ROOT: [u8; 32] = [0x5a; 32];
const ARN: &str = "arn:aws:kms:us-east-1:736326664265:key/11111111-2222-3333-4444-555555555555";

fn profile() -> ValidatedVaultProfile {
    let mut document = crate::vault_profile::test_profile(ROOT).document().clone();
    document.environment = "mainnet".into();
    for binding in &mut document.networks {
        binding.chain_id = match binding.chain_family.as_str() {
            "neo-n3" => u64::from(network::network_magic(Network::Mainnet)),
            "neox" => network::neox_chain_id(Network::Mainnet),
            _ => unreachable!(),
        };
    }
    document.validate().unwrap()
}

fn scalar(index: usize) -> Zeroizing<[u8; 32]> {
    let mut s = Zeroizing::new([0u8; 32]);
    s[31] = (index + 1) as u8;
    s
}

fn manifest(p: &ValidatedVaultProfile) -> Value {
    let roles = (0..2)
        .map(|i| {
            let public = crypto::public_key_from_private(&scalar(i)).unwrap();
            let mut display = crypto::script_hash(&public);
            display.reverse();
            json!({"role":ROLES[i], "key_id":ROLE_IDS[i], "public_key":hex::encode(public),
            "script_hash":format!("0x{}",hex::encode(display)),
            "ciphertext_slot":CIPHER_SLOTS[i], "expected_kms_key_arn":ARN,
            "encryption_context":"explicit-empty-legacy-n3/v1",
            "material_provenance_sha256":"44".repeat(32)})
        })
        .collect::<Vec<_>>();
    json!({"schema":"neoos/legacy-n3-migration/v1", "purpose":PURPOSE,
        "ceremony_id":"synthetic-migration", "profile_sha256":hex::encode(p.profile_hash()),
        "credential_epoch":"internal-r1", "caller_id":"internal-n3-raw-r1",
        "legacy_checkpoint_sha256":"22".repeat(32),
        "external_authority_map_sha256":"33".repeat(32), "roles":roles})
}

fn validated(v: &Value, p: &ValidatedVaultProfile) -> Result<MeasuredMigration> {
    let bytes = serde_json::to_vec(v).unwrap();
    let pin: [u8; 32] = Sha256::digest(&bytes).into();
    MeasuredMigration::from_measured_bytes(&bytes, &pin, p)
}

fn material() -> [DecodedRoleMaterial; 2] {
    std::array::from_fn(|i| DecodedRoleMaterial {
        key_id: ROLE_IDS[i].into(),
        response_kms_key_arn: ARN.into(),
        scalar: scalar(i),
    })
}

fn prepared() -> PreparedMigration {
    let p = profile();
    validated(&manifest(&p), &p)
        .unwrap()
        .prepare(&p, &MasterKey::from_bytes(ROOT), material(), 1_793_000_000)
        .unwrap()
}

// Synthetic proof confined to this cfg(test) child. Production has no issuer.
fn permit(p: &PreparedMigration) -> MigrationGenesisPermit {
    MigrationGenesisPermit {
        manifest_digest: p.manifest_digest,
        profile_hash: p.profile_hash,
        operation_digest: p.operation_digest,
    }
}

#[test]
fn original_profile_is_unchanged_and_independent_manifest_pin_is_required() {
    let p = profile();
    let before = serde_json::to_vec(p.document()).unwrap();
    let bytes = serde_json::to_vec(&manifest(&p)).unwrap();
    let pin: [u8; 32] = Sha256::digest(&bytes).into();
    let m = MeasuredMigration::from_measured_bytes(&bytes, &pin, &p).unwrap();
    assert_eq!(m.profile_hash, *p.profile_hash());
    assert_eq!(before, serde_json::to_vec(p.document()).unwrap());
    assert!(MeasuredMigration::from_measured_bytes(&bytes, &[0; 32], &p).is_err());
    assert!(
        MeasuredMigration::from_measured_bytes(&vec![0; MAX_MANIFEST_BYTES + 1], &pin, &p).is_err()
    );
    let unchanged: VaultProfile = serde_json::from_slice(&before).unwrap();
    assert_eq!(
        unchanged.release_policy_version,
        p.document().release_policy_version
    );
}

#[test]
fn rejects_manifest_duplicates_unknown_fields_and_other_scope() {
    let p = profile();
    let original = manifest(&p);
    let mut extra = original.clone();
    extra["admin"] = json!(true);
    assert!(validated(&extra, &p).is_err());
    let bytes = serde_json::to_string(&original).unwrap();
    let duplicate = format!("{{\"schema\":\"duplicate\",{}", &bytes[1..]);
    let pin: [u8; 32] = Sha256::digest(duplicate.as_bytes()).into();
    assert!(MeasuredMigration::from_measured_bytes(duplicate.as_bytes(), &pin, &p).is_err());
    let testnet = crate::vault_profile::test_profile(ROOT);
    assert!(validated(&manifest(&testnet), &testnet).is_err());
    let mut other = original.clone();
    other["roles"].as_array_mut().unwrap().reverse();
    assert!(validated(&other, &p).is_err());
    other = original.clone();
    other["roles"].as_array_mut().unwrap().pop();
    assert!(validated(&other, &p).is_err());
    other = original.clone();
    other["roles"][0]["key_id"] = json!("mn-relayer-r1");
    assert!(validated(&other, &p).is_err());
}

#[test]
fn refuses_unbound_key_alias_context_and_zero_provenance() {
    let p = profile();
    for (field, value) in [
        (
            "expected_kms_key_arn",
            "arn:aws:kms:us-east-1:736326664265:alias/example".to_string(),
        ),
        (
            "expected_kms_key_arn",
            ARN.replace("us-east-1", "us-west-2"),
        ),
        ("encryption_context", "try-empty-on-error".into()),
        ("material_provenance_sha256", "00".repeat(32)),
        ("public_key", "00".repeat(33)),
        ("script_hash", format!("0x{}", "00".repeat(20))),
    ] {
        let mut v = manifest(&p);
        v["roles"][0][field] = json!(value);
        assert!(validated(&v, &p).is_err());
    }
}

#[test]
fn release_requests_are_exact_empty_context_with_no_key_search() {
    let p = profile();
    let m = validated(&manifest(&p), &p).unwrap();
    for (i, role) in ROLES.iter().enumerate() {
        let r = m.release_request(i).unwrap();
        assert_eq!(r.role, *role);
        assert_eq!(r.ciphertext_slot, CIPHER_SLOTS[i]);
        assert_eq!(r.expected_kms_key_arn, ARN);
        assert!(r.encryption_context.is_empty());
    }
    assert!(m.release_request(2).is_err());
}

#[test]
fn mismatched_kms_response_or_role_scalar_refuses_before_store() {
    let p = profile();
    let m = validated(&manifest(&p), &p).unwrap();
    let mut x = material();
    x[0].response_kms_key_arn = ARN.replace("11111111", "22222222");
    assert!(m.prepare(&p, &MasterKey::from_bytes(ROOT), x, 1).is_err());
    let mut x = material();
    x.swap(0, 1);
    assert!(m.prepare(&p, &MasterKey::from_bytes(ROOT), x, 1).is_err());
    let mut x = material();
    x[1].scalar = scalar(0);
    assert!(m.prepare(&p, &MasterKey::from_bytes(ROOT), x, 1).is_err());
    let mut x = material();
    x[0].scalar = Zeroizing::new([0; 32]);
    assert!(m.prepare(&p, &MasterKey::from_bytes(ROOT), x, 1).is_err());
    assert!(m
        .prepare(&p, &MasterKey::from_bytes([7; 32]), material(), 1)
        .is_err());
    assert!(m
        .prepare(&p, &MasterKey::from_bytes(ROOT), material(), 0)
        .is_err());
}

#[test]
fn root_derivation_is_stable_epoch_caller_and_capability_separated() {
    let p = profile();
    let v = manifest(&p);
    let m = validated(&v, &p).unwrap();
    let root = MasterKey::from_bytes(ROOT);
    let raw = m.derive_internal_token(&root, InternalLane::Raw).unwrap();
    let again = m.derive_internal_token(&root, InternalLane::Raw).unwrap();
    let semantic = m
        .derive_internal_token(&root, InternalLane::Semantic)
        .unwrap();
    assert!(raw.as_str() == again.as_str());
    assert!(raw.as_str() != semantic.as_str());
    for field in ["credential_epoch", "caller_id"] {
        let mut other = v.clone();
        other[field] = json!("other-r2");
        let m = validated(&other, &p).unwrap();
        assert!(
            raw.as_str()
                != m.derive_internal_token(&root, InternalLane::Raw)
                    .unwrap()
                    .as_str()
        );
    }
}

#[test]
fn prepared_state_has_two_original_identities_one_raw_caller_and_no_admin() {
    let x = prepared();
    assert_eq!(x.keys().len(), 2);
    let root = MasterKey::from_bytes(ROOT);
    for (i, key) in x.keys().iter().enumerate() {
        assert_eq!(key.id, ROLE_IDS[i]);
        assert_eq!(
            key.public_key,
            crypto::public_key_from_private(&scalar(i)).unwrap()
        );
        assert_eq!(
            root.open_sealed(&key.sealed).unwrap().as_slice(),
            scalar(i).as_slice()
        );
        assert_eq!(key.network, Network::Mainnet);
    }
    assert_eq!(x.caller().capabilities, vec![CallerCapability::RawSign]);
    assert!(
        matches!(&x.caller().key_grant, KeyGrant::Only(ids) if ids == &ROLE_IDS.map(str::to_string).to_vec())
    );
    assert!(x.caller().allowed_origins.is_empty());
    assert!(x.policy().allow_raw);
    assert!(
        !x.policy().allow_transfer
            && !x.policy().allow_contract_call
            && !x.policy().allow_consensus
    );
    let receipt: Value = serde_json::from_str(x.audit().detail.as_ref().unwrap()).unwrap();
    assert_eq!(receipt["historical_native_actions_restored"], json!(false));
    assert_eq!(x.audit().recorded_at_unix, 1_793_000_000);
}

#[test]
fn atomic_initial_store_has_exact_batch_and_refuses_second_seed() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("vault.db")).unwrap();
    let x = prepared();
    store.stage_legacy_migration(&x, &permit(&x)).unwrap();
    assert_eq!(store.list_signer_keys().unwrap().len(), 2);
    assert_eq!(
        store.list_signer_callers().unwrap(),
        vec![x.caller().clone()]
    );
    for key in x.keys() {
        assert_eq!(
            store.load_signer_policy(&key.id).unwrap(),
            Some(x.policy().clone())
        );
    }
    let connection = rusqlite::Connection::open(store.db_path()).unwrap();
    for (table, count) in [
        ("signer_keys", 2),
        ("signer_policies", 2),
        ("signer_callers", 1),
        ("signer_audit", 1),
    ] {
        let query = format!("SELECT COUNT(*) FROM {table}");
        assert_eq!(
            connection
                .query_row(&query, [], |r| r.get::<_, i64>(0))
                .unwrap(),
            count
        );
    }
    assert!(store.stage_legacy_migration(&x, &permit(&x)).is_err());
}

#[test]
fn receipt_failure_rolls_back_keys_policies_and_caller() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("vault.db")).unwrap();
    let connection = rusqlite::Connection::open(store.db_path()).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_migration BEFORE INSERT ON signer_audit BEGIN SELECT RAISE(ABORT,'synthetic'); END;").unwrap();
    let x = prepared();
    assert!(store.stage_legacy_migration(&x, &permit(&x)).is_err());
    assert!(store.list_signer_keys().unwrap().is_empty());
    assert!(store.list_signer_callers().unwrap().is_empty());
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM signer_policies", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn unknown_preseeded_table_or_wrong_permit_refuses_all_writes() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("vault.db")).unwrap();
    let x = prepared();
    let mut wrong = permit(&x);
    wrong.profile_hash = [0; 32];
    assert!(store.stage_legacy_migration(&x, &wrong).is_err());
    let connection = rusqlite::Connection::open(store.db_path()).unwrap();
    connection
        .execute_batch("CREATE TABLE unexpected(v INTEGER); INSERT INTO unexpected VALUES(1)")
        .unwrap();
    assert!(store.stage_legacy_migration(&x, &permit(&x)).is_err());
    assert!(store.list_signer_keys().unwrap().is_empty());
    assert!(store.list_signer_callers().unwrap().is_empty());
}

// Real local RSA/CMS composition with deterministic public WIF fixtures only.
// NSM and HTTPS/KMS are mocks; this is not evidence of a live attestation.
mod recipient_bridge {
    use super::*;
    use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
    use aws_lc_rs::rsa::{OaepPublicEncryptingKey, PublicEncryptingKey, OAEP_SHA256_MGF1SHA256};
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    use nitro_attest::{
        asn1::*,
        kms::Credentials,
        release::{AttestationSource, KmsTransport, ReleaseParams},
    };
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    };

    struct Source(Mutex<Vec<Vec<u8>>>);
    impl AttestationSource for Source {
        fn attest(
            &self,
            _: Option<&[u8]>,
            _: Option<&[u8]>,
            key: Option<&[u8]>,
        ) -> nitro_attest::AttestResult<Vec<u8>> {
            let key = key.ok_or("missing test recipient key")?;
            self.0.lock().unwrap().push(key.to_vec());
            Ok(key.to_vec()) // mock document deliberately exposes only the public SPKI
        }
    }
    fn tlv(tag: u8, body: &[u8]) -> Vec<u8> {
        let mut v = vec![tag];
        if body.len() < 128 {
            v.push(body.len() as u8)
        } else {
            let b = body.len().to_be_bytes();
            let b = &b[b.iter().position(|x| *x != 0).unwrap()..];
            v.push(0x80 | b.len() as u8);
            v.extend_from_slice(b);
        }
        v.extend_from_slice(body);
        v
    }
    fn seq(parts: &[Vec<u8>]) -> Vec<u8> {
        tlv(0x30, &parts.concat())
    }
    fn oid(o: &[u8]) -> Vec<u8> {
        tlv(6, o)
    }
    fn response_for(spki: &[u8], plain: &[u8]) -> Value {
        let public = PublicEncryptingKey::from_der(spki).unwrap();
        let oaep = OaepPublicEncryptingKey::new(public).unwrap();
        let cek = [0x5a; 32];
        let iv = [1; 16];
        let mut wrapped = vec![0; oaep.ciphertext_size()];
        let encrypted = oaep
            .encrypt(&OAEP_SHA256_MGF1SHA256, &cek, &mut wrapped, None)
            .unwrap();
        let mut buffer = vec![0; plain.len() + 16];
        let data = cbc::Encryptor::<aes::Aes256>::new((&cek).into(), (&iv).into())
            .encrypt_padded_b2b_mut::<Pkcs7>(plain, &mut buffer)
            .unwrap();
        let hash = seq(&[oid(oid_sha256()), tlv(5, &[])]);
        let params = seq(&[
            tlv(0xa0, &hash),
            tlv(0xa1, &seq(&[oid(oid_mgf1()), hash])),
            tlv(0xa2, &seq(&[oid(oid_p_specified()), tlv(4, &[])])),
        ]);
        let recipient = seq(&[
            tlv(2, &[0]),
            tlv(2, &[1]),
            seq(&[oid(oid_rsaes_oaep()), params]),
            tlv(4, encrypted),
        ]);
        let env = seq(&[
            tlv(2, &[0]),
            tlv(0x31, &recipient),
            seq(&[
                oid(oid_data()),
                seq(&[oid(oid_aes256_cbc()), tlv(4, &iv)]),
                tlv(0x80, data),
            ]),
        ]);
        let der = seq(&[oid(oid_enveloped_data()), tlv(0xa0, &env)]);
        json!({"KeyId":ARN,"CiphertextForRecipient":B64.encode(der)})
    }
    struct Transport {
        plain: Vec<u8>,
        reply_key: String,
        plaintext_reply: bool,
        calls: AtomicUsize,
        requests: Mutex<Vec<Value>>,
    }
    impl KmsTransport for Transport {
        fn post_json(
            &self,
            url: &str,
            headers: &[(String, String)],
            body: &str,
        ) -> nitro_attest::AttestResult<(u16, String)> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            assert_eq!(url, "https://kms.us-east-1.amazonaws.com/");
            assert!(headers
                .iter()
                .any(|(k, v)| k.eq_ignore_ascii_case("authorization")
                    && v.contains("AWS4-HMAC-SHA256")));
            let request: Value = serde_json::from_str(body).unwrap();
            self.requests.lock().unwrap().push(request.clone());
            assert_eq!(request["KeyId"], ARN);
            assert!(request.get("EncryptionContext").is_none());
            assert_eq!(
                request["Recipient"]["KeyEncryptionAlgorithm"],
                "RSAES_OAEP_SHA_256"
            );
            let spki = B64
                .decode(
                    request["Recipient"]["AttestationDocument"]
                        .as_str()
                        .unwrap(),
                )
                .unwrap();
            let mut reply = if self.plaintext_reply {
                json!({"KeyId":ARN,"Plaintext":B64.encode(&self.plain)})
            } else {
                response_for(&spki, &self.plain)
            };
            reply["KeyId"] = json!(self.reply_key);
            Ok((200, reply.to_string()))
        }
    }
    fn wif(i: usize) -> String {
        let mut b = vec![0x80];
        b.extend_from_slice(scalar(i).as_slice());
        b.push(1);
        bs58::encode(b).with_check().into_string()
    }
    fn transport(plain: Vec<u8>) -> Transport {
        Transport {
            plain,
            reply_key: ARN.into(),
            plaintext_reply: false,
            calls: AtomicUsize::new(0),
            requests: Mutex::new(Vec::new()),
        }
    }
    fn credentials() -> Credentials {
        Credentials {
            access_key_id: "AKIDEXAMPLE".into(),
            secret_access_key: "public-test-secret".into(),
            session_token: None,
        }
    }
    fn params(c: &Credentials) -> ReleaseParams<'_> {
        ReleaseParams {
            region: "us-east-1",
            credentials: c,
            ciphertext_b64: "AAECAwQFBgcICQ==",
            amz_date: "20261028T000000Z",
        }
    }

    #[test]
    fn exact_role_recipient_roundtrip_preserves_both_original_identities() {
        let p = profile();
        let m = validated(&manifest(&p), &p).unwrap();
        let c = credentials();
        let src = Source(Mutex::new(Vec::new()));
        let mut released = Vec::new();
        for (i, key_id) in ROLE_IDS.iter().enumerate() {
            let field = if i == 0 {
                "oracle_verifier_wif"
            } else {
                "updater_wif"
            };
            let t = transport(json!({field:wif(i)}).to_string().into_bytes());
            let material = m.release_legacy_role(i, &src, &t, &params(&c)).unwrap();
            assert_eq!(&material.key_id, key_id);
            assert!(material.scalar.as_slice() == scalar(i).as_slice());
            assert_eq!(t.calls.load(Ordering::SeqCst), 1);
            released.push(material);
        }
        let keys = src.0.lock().unwrap();
        assert_eq!(keys.len(), 2);
        assert_ne!(keys[0], keys[1]);
        drop(keys);
        let material: [DecodedRoleMaterial; 2] = released.try_into().ok().unwrap();
        let ready = m
            .prepare(&p, &MasterKey::from_bytes(ROOT), material, 1)
            .unwrap();
        assert_eq!(ready.keys().len(), 2);
    }
    #[test]
    fn region_index_and_ciphertext_caps_refuse_before_attestation_or_transport() {
        let p = profile();
        let m = validated(&manifest(&p), &p).unwrap();
        let c = credentials();
        let src = Source(Mutex::new(Vec::new()));
        let t = transport(wif(0).into_bytes());
        let mut input = params(&c);
        input.region = "us-west-2";
        assert!(m.release_legacy_role(0, &src, &t, &input).is_err());
        let huge = "A".repeat(8193);
        input = params(&c);
        input.ciphertext_b64 = &huge;
        assert!(m.release_legacy_role(0, &src, &t, &input).is_err());
        input.ciphertext_b64 = "";
        assert!(m.release_legacy_role(0, &src, &t, &input).is_err());
        assert!(m.release_legacy_role(2, &src, &t, &params(&c)).is_err());
        assert!(src.0.lock().unwrap().is_empty());
        assert_eq!(t.calls.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn kms_key_mismatch_or_plaintext_response_never_releases_or_retries() {
        let p = profile();
        let m = validated(&manifest(&p), &p).unwrap();
        let c = credentials();
        let src = Source(Mutex::new(Vec::new()));
        for plaintext_reply in [false, true] {
            let mut t = transport(wif(0).into_bytes());
            t.plaintext_reply = plaintext_reply;
            if !plaintext_reply {
                t.reply_key = ARN.replace("11111111", "22222222");
            }
            let error = m
                .release_legacy_role(0, &src, &t, &params(&c))
                .err()
                .unwrap()
                .to_string();
            assert_eq!(error, "attested migration role release refused");
            assert_eq!(t.calls.load(Ordering::SeqCst), 1);
            assert!(!error.contains(&wif(0)));
        }
    }
    #[test]
    fn recipient_success_with_other_identity_or_role_alias_still_refuses() {
        let p = profile();
        let m = validated(&manifest(&p), &p).unwrap();
        let c = credentials();
        let src = Source(Mutex::new(Vec::new()));
        for body in [
            wif(1),
            json!({"updater_wif":wif(0)}).to_string(),
            json!({"wif":wif(0),"private_key":wif(0)}).to_string(),
        ] {
            let t = transport(body.into_bytes());
            let error = m
                .release_legacy_role(0, &src, &t, &params(&c))
                .err()
                .unwrap()
                .to_string();
            assert_eq!(error, "released migration role identity refused");
            assert_eq!(t.calls.load(Ordering::SeqCst), 1);
        }
    }
}

#[test]
fn deleted_audit_history_is_not_a_virgin_migration_and_rolls_back_every_row() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("vault.db")).unwrap();
    let connection = rusqlite::Connection::open(store.db_path()).unwrap();
    // Simulate deleted history while preserving SQLite's monotonic audit id.
    connection
        .execute(
            "INSERT INTO sqlite_sequence(name,seq) VALUES('signer_audit',7)",
            [],
        )
        .unwrap();
    let x = prepared();
    assert!(store.stage_legacy_migration(&x, &permit(&x)).is_err());
    for table in [
        "signer_keys",
        "signer_policies",
        "signer_callers",
        "signer_audit",
    ] {
        let n: i64 = connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(n, 0);
    }
}
