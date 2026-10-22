//! Offline Testnet material preparation and explicit, later purpose sealing.
//! This example is never a runtime executable. See EMBEDDED_CUSTODY.md.
#[cfg(not(unix))]
fn main() {
    eprintln!("preparation requires an approved Unix file-backed holder");
    std::process::exit(1);
}

#[cfg(unix)]
fn main() {
    if tool::run(std::env::args().skip(1).collect()).is_err() {
        // Never format errors that could originate in a private bundle/child.
        eprintln!("material operation failed; no eligible completion; preserve protected partial evidence");
        std::process::exit(1);
    }
}

#[cfg(unix)]
mod tool {
    use anyhow::{ensure, Context, Result};
    use base64::{engine::general_purpose::STANDARD, Engine};
    use neo_signer::{
        auth::token_digest,
        enrollment::ValidatedGenesisEnrollment,
        network::{self, Network},
        provision::{custody_encryption_context, EnvelopePurpose},
        vault::MasterKey,
        vault_profile::{
            root_key_commitment, CoordinatorProfile, ValidatedVaultProfile, VaultNetwork,
            VaultProfile,
        },
    };
    use rand::{rngs::OsRng, RngCore};
    use serde::{Deserialize, Serialize};
    use sha2::{Digest, Sha256};
    use std::{
        collections::BTreeMap,
        fs::{self, File, OpenOptions},
        io::{Read, Seek, Write},
        os::{
            fd::{AsRawFd, BorrowedFd, FromRawFd, IntoRawFd},
            unix::fs::{MetadataExt, OpenOptionsExt},
        },
        path::{Component, Path, PathBuf},
        process::{Command, Stdio},
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };
    use zeroize::{Zeroize, Zeroizing};

    const CMK: &str = "arn:aws:kms:us-east-1:736326664265:key/821b2d72-4774-412c-8e8a-7ca9487ab8ac";
    const REGION: &str = "us-east-1";
    const MAX: usize = 32 * 1024;
    const PREPARED: &str = "PREPARED.json";
    const SEALED: &str = "SEALED.json";
    const PURPOSES: [(EnvelopePurpose, &str); 3] = [
        (EnvelopePurpose::MasterKey, "master-key.b64"),
        (EnvelopePurpose::TransportToken, "transport-token.b64"),
        (EnvelopePurpose::FirstAdmin, "first-admin.b64"),
    ];

    // POSIX FD flags; no new dependency or ambient command is needed.
    unsafe extern "C" {
        fn fcntl(fd: i32, cmd: i32, ...) -> i32;
        fn close(fd: i32) -> i32;
        fn geteuid() -> u32;
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Plan {
        schema: String,
        environment: String,
        source_commit: String,
        source_tree: String,
        ceremony_id: String,
        caller_id: String,
        caller_label: String,
        vault_id: String,
        root_key_version: String,
        networks: Vec<VaultNetwork>,
        custody_kms_key_arn: String,
        coordinator: CoordinatorProfile,
    }

    #[derive(Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Bundle {
        schema: String,
        plan_sha256: String,
        created_at_unix: u64,
        root: [u8; 32],
        transport_token: String,
        admin_token: String,
    }

    impl Drop for Bundle {
        fn drop(&mut self) {
            self.root.zeroize();
            self.transport_token.zeroize();
            self.admin_token.zeroize();
        }
    }

    #[derive(Serialize, Deserialize, PartialEq, Eq, Debug)]
    #[serde(deny_unknown_fields)]
    struct PreparationReceipt {
        schema: String,
        ceremony_id: String,
        created_at_unix: u64,
        source_commit: String,
        source_tree: String,
        example_source_sha256: String,
        context_source_sha256: String,
        plan_sha256: String,
        environment: String,
        networks: Vec<VaultNetwork>,
        vault_id: String,
        root_key_commitment: String,
        admin_token_sha256: String,
        transport_token_sha256: String,
        enrollment_file_sha256: String,
        profile_file_sha256: String,
        native_profile_sha256: String,
        native_network_set_sha256: String,
    }

    struct Public {
        profile: ValidatedVaultProfile,
        profile_bytes: Vec<u8>,
        enrollment_bytes: Vec<u8>,
        receipt: PreparationReceipt,
    }

    fn sha(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }
    fn lower_hex(s: &str, len: usize) -> bool {
        s.len() == len
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }
    fn identifier(s: &str) -> bool {
        !s.is_empty()
            && s.len() <= 128
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    }
    fn token(s: &str) -> bool {
        s.starts_with("nsk1_") && lower_hex(&s[5..], 64)
    }

    impl Plan {
        fn profile(&self, commitment: String, release_policy_version: String) -> VaultProfile {
            VaultProfile {
                profile_version: 1,
                vault_id: self.vault_id.clone(),
                environment: self.environment.clone(),
                networks: self.networks.clone(),
                custody_kms_key_arn: self.custody_kms_key_arn.clone(),
                root_key_version: self.root_key_version.clone(),
                root_key_commitment: commitment,
                snapshot_format_version: 2,
                signer_schema_version: 1,
                coordinator: self.coordinator.clone(),
                release_policy_version,
            }
        }
        fn validate(&self) -> Result<()> {
            ensure!(
                self.schema == "neoos/testnet-material-plan/v1" && self.environment == "testnet",
                "Testnet plan required"
            );
            ensure!(
                self.custody_kms_key_arn == CMK && self.coordinator.aws_region == REGION,
                "fixed Testnet CMK required"
            );
            ensure!(
                lower_hex(&self.source_commit, 40) && lower_hex(&self.source_tree, 40),
                "source identity required"
            );
            ensure!(
                identifier(&self.ceremony_id) && identifier(&self.caller_id),
                "invalid public identifier"
            );
            ensure!(
                !self.caller_label.is_empty()
                    && self.caller_label.len() <= 128
                    && self.caller_label.trim() == self.caller_label
                    && !self.caller_label.chars().any(char::is_control),
                "invalid label"
            );
            let n3 = neo_os_core::network_identity::known_neo_n3_identity("testnet")
                .context("reviewed Testnet missing")?;
            ensure!(
                self.networks.len() == 2
                    && self.networks[0].chain_family == "neo-n3"
                    && self.networks[0].chain_id
                        == u64::from(network::network_magic(Network::Testnet))
                    && self.networks[0].genesis_hash == n3.genesis_hash
                    && self.networks[1].chain_family == "neox"
                    && self.networks[1].chain_id == network::neox_chain_id(Network::Testnet),
                "dual-builder Testnet identity required"
            );
            // Validate every remaining native public constraint BEFORE entropy.
            self.profile("1".repeat(64), "1".repeat(64)).validate()?;
            Ok(())
        }
    }

    fn parse_plan(bytes: &[u8], expected: &str) -> Result<Plan> {
        ensure!(
            bytes.len() <= MAX && lower_hex(expected, 64) && sha(bytes) == expected,
            "plan hash mismatch"
        );
        let plan: Plan = serde_json::from_slice(bytes)?;
        plan.validate()?;
        Ok(plan)
    }

    fn generate_bundle(
        plan: &Plan,
        plan_sha: &str,
        now: u64,
        mut entropy: impl FnMut(&mut [u8]) -> Result<()>,
    ) -> Result<Bundle> {
        plan.validate()?;
        ensure!(
            now > 0 && now <= i64::MAX as u64,
            "invalid preparation time"
        );
        let mut root = Zeroizing::new([0u8; 32]);
        entropy(root.as_mut())?;
        let mut next_token = || -> Result<String> {
            let mut b = Zeroizing::new([0u8; 32]);
            entropy(b.as_mut())?;
            // Same two-v4-UUID format as auth::generate_token, with fallible RNG.
            for start in [0, 16] {
                b[start + 6] = (b[start + 6] & 15) | 64;
                b[start + 8] = (b[start + 8] & 63) | 128;
            }
            Ok(format!("nsk1_{}", hex::encode(b.as_ref())))
        };
        let transport = Zeroizing::new(next_token()?);
        let admin = Zeroizing::new(next_token()?);
        ensure!(transport.as_str() != admin.as_str(), "credential collision");
        Ok(Bundle {
            schema: "neoos/testnet-private-material/v1".into(),
            plan_sha256: plan_sha.into(),
            created_at_unix: now,
            root: *root,
            transport_token: transport.to_string(),
            admin_token: admin.to_string(),
        })
    }

    fn derive_public(plan: &Plan, plan_sha: &str, bundle: &Bundle) -> Result<Public> {
        plan.validate()?;
        ensure!(
            bundle.schema == "neoos/testnet-private-material/v1" && bundle.plan_sha256 == plan_sha,
            "private bundle binding mismatch"
        );
        ensure!(
            bundle.created_at_unix > 0 && bundle.created_at_unix <= i64::MAX as u64,
            "invalid preparation time"
        );
        ensure!(
            token(&bundle.transport_token)
                && token(&bundle.admin_token)
                && bundle.transport_token != bundle.admin_token,
            "invalid distinct credentials"
        );
        let commitment = hex::encode(root_key_commitment(&MasterKey::from_bytes(bundle.root)));
        let admin_digest = hex::encode(token_digest(&bundle.admin_token));
        let enrollment_bytes = serde_json::to_vec(&serde_json::json!({
            "schema":"neoos/first-admin-enrollment/v1", "purpose":"first-testnet-admin/v1",
            "ceremony_id":plan.ceremony_id, "environment":"testnet", "vault_id":plan.vault_id,
            "networks":plan.networks, "custody_kms_key_arn":CMK, "root_key_version":plan.root_key_version,
            "root_key_commitment":commitment, "coordinator":plan.coordinator,
            "caller":{"id":plan.caller_id,"label":plan.caller_label,"created_at_unix":bundle.created_at_unix,
                "token_digest":admin_digest,"auth_mode":"bearer","capabilities":["admin"],
                "key_grant":"any","allowed_origins":[],"disabled":false}
        }))?;
        let enrollment_sha = sha(&enrollment_bytes);
        let document = plan.profile(commitment.clone(), enrollment_sha.clone());
        let profile_bytes = serde_json::to_vec(&document)?;
        let profile = VaultProfile::from_json(&profile_bytes)?;
        profile.verify_master(&MasterKey::from_bytes(bundle.root))?;
        ValidatedGenesisEnrollment::from_json(&enrollment_bytes, &profile)?;
        let receipt = PreparationReceipt {
            schema: "neoos/testnet-material-prepared/v2".into(),
            ceremony_id: plan.ceremony_id.clone(),
            created_at_unix: bundle.created_at_unix,
            source_commit: plan.source_commit.clone(),
            source_tree: plan.source_tree.clone(),
            example_source_sha256: sha(include_bytes!("prepare_testnet_material.rs")),
            context_source_sha256: sha(include_bytes!("../src/provision.rs")),
            plan_sha256: plan_sha.into(),
            environment: "testnet".into(),
            networks: plan.networks.clone(),
            vault_id: plan.vault_id.clone(),
            root_key_commitment: commitment,
            admin_token_sha256: admin_digest,
            transport_token_sha256: hex::encode(token_digest(&bundle.transport_token)),
            enrollment_file_sha256: enrollment_sha,
            profile_file_sha256: sha(&profile_bytes),
            native_profile_sha256: hex::encode(profile.profile_hash()),
            native_network_set_sha256: hex::encode(profile.network_set_hash()),
        };
        Ok(Public {
            profile,
            profile_bytes,
            enrollment_bytes,
            receipt,
        })
    }

    fn close_checked(file: File) -> Result<()> {
        // POSIX close is not retried on EINTR: ownership is already consumed.
        ensure!(
            unsafe { close(file.into_raw_fd()) } == 0,
            "file close failed"
        );
        Ok(())
    }
    fn sync_directory(path: &Path) -> Result<()> {
        let dir = File::open(path)?;
        dir.sync_all()?;
        close_checked(dir)
    }
    fn clean_absolute(path: &Path) -> Result<()> {
        ensure!(path.is_absolute(), "absolute path required");
        let mut part = PathBuf::new();
        for component in path.components() {
            ensure!(
                matches!(component, Component::RootDir | Component::Normal(_)),
                "noncanonical path"
            );
            part.push(component);
            ensure!(
                !fs::symlink_metadata(&part)?.file_type().is_symlink(),
                "symlink path refused"
            );
        }
        Ok(())
    }
    fn private_directory(path: &Path, empty: bool) -> Result<()> {
        clean_absolute(path)?;
        let m = fs::metadata(path)?;
        ensure!(
            m.is_dir() && m.uid() == unsafe { geteuid() } && m.mode() & 0o7777 == 0o700,
            "owner-only directory required"
        );
        ensure!(
            !empty || fs::read_dir(path)?.next().is_none(),
            "fresh empty directory required"
        );
        Ok(())
    }
    fn opened_metadata(fd: i32) -> Result<fs::Metadata> {
        // Duplicate is CLOEXEC; original ownership is unaffected.
        ensure!(unsafe { fcntl(fd, 1) } >= 0, "descriptor closed");
        let copy = unsafe { BorrowedFd::borrow_raw(fd) }.try_clone_to_owned()?;
        Ok(File::from(copy).metadata()?)
    }
    fn same(a: &fs::Metadata, b: &fs::Metadata) -> bool {
        a.dev() == b.dev() && a.ino() == b.ino()
    }
    fn open_fds() -> Result<Vec<i32>> {
        let root = if cfg!(target_os = "linux") {
            "/proc/self/fd"
        } else {
            "/dev/fd"
        };
        let mut fds = Vec::new();
        for entry in fs::read_dir(root)? {
            if let Ok(fd) = entry?.file_name().to_string_lossy().parse::<i32>() {
                fds.push(fd);
            }
        }
        Ok(fds)
    }

    struct PrivateFile {
        file: File,
        parent: PathBuf,
    }
    impl PrivateFile {
        fn take(fd: i32, path: &Path, empty: bool) -> Result<Self> {
            ensure!(fd > 2, "private descriptor cannot be a standard sink");
            ensure!(unsafe { fcntl(fd, 1) } >= 0, "private descriptor closed");
            let file = unsafe { File::from_raw_fd(fd) };
            // Do this immediately, before validation or any possible child.
            ensure!(unsafe { fcntl(fd, 2, 1) } == 0, "CLOEXEC required");
            clean_absolute(path)?;
            for ancestor in path.ancestors().skip(1) {
                ensure!(
                    !ancestor.join(".git").exists(),
                    "private holder cannot be in a repository"
                );
            }
            for component in path.components().filter_map(|c| c.as_os_str().to_str()) {
                ensure!(
                    ![
                        ".config",
                        ".aws",
                        ".ssh",
                        "claudedocs",
                        "evidence",
                        "runtime"
                    ]
                    .contains(&component),
                    "private holder outside configuration/evidence/runtime required"
                );
            }
            let parent = path
                .parent()
                .context("private parent missing")?
                .to_path_buf();
            private_directory(&parent, false)?;
            let m = file.metadata()?;
            ensure!(
                m.is_file()
                    && m.uid() == unsafe { geteuid() }
                    && m.mode() & 0o7777 == 0o600
                    && m.nlink() == 1,
                "private regular owner file required"
            );
            ensure!(
                same(&m, &fs::symlink_metadata(path)?),
                "descriptor/path mismatch"
            );
            for other_fd in open_fds()? {
                if other_fd != fd {
                    if let Ok(other) = opened_metadata(other_fd) {
                        ensure!(!same(&m, &other), "private descriptor alias refused");
                    }
                }
            }
            let access = unsafe { fcntl(fd, 3) };
            ensure!(
                access >= 0
                    && if empty {
                        access & 3 != 0
                    } else {
                        access & 3 != 1
                    },
                "private descriptor access mismatch"
            );
            ensure!(!empty || m.len() == 0, "private output must be empty");
            ensure!(m.len() <= MAX as u64, "private input too large");
            Ok(Self { file, parent })
        }
        fn retain(mut self, bundle: &Bundle) -> Result<()> {
            let bytes = Zeroizing::new(serde_json::to_vec(bundle)?);
            self.file.rewind()?;
            self.file.write_all(&bytes)?;
            self.file.flush()?;
            self.file.sync_all()?;
            close_checked(self.file)?;
            sync_directory(&self.parent)
        }
        fn consume(mut self) -> Result<Bundle> {
            self.file.rewind()?;
            let mut bytes = Zeroizing::new(Vec::new());
            Read::by_ref(&mut self.file)
                .take(MAX as u64 + 1)
                .read_to_end(&mut bytes)?;
            // Close the entire input BEFORE parsing or any Encrypt child.
            close_checked(self.file)?;
            ensure!(bytes.len() <= MAX, "private input too large");
            Ok(serde_json::from_slice(&bytes)?)
        }
    }

    fn read_public(path: &Path) -> Result<Vec<u8>> {
        clean_absolute(path)?;
        let mut f = File::open(path)?;
        let m = f.metadata()?;
        ensure!(
            m.is_file() && m.nlink() == 1,
            "regular unaliased public input required"
        );
        let mut b = Vec::new();
        Read::by_ref(&mut f)
            .take(MAX as u64 + 1)
            .read_to_end(&mut b)?;
        close_checked(f)?;
        ensure!(b.len() <= MAX, "public input too large");
        Ok(b)
    }
    fn write_new(dir: &Path, name: &str, bytes: &[u8]) -> Result<()> {
        let path = dir.join(name);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)?;
        let result = (|| -> Result<()> {
            file.write_all(bytes)?;
            file.flush()?;
            file.sync_all()?;
            close_checked(file)?;
            sync_directory(dir)
        })();
        if result.is_err() {
            // No successful completion may be inferred from an I/O error.
            let _ = fs::remove_file(&path);
            let _ = sync_directory(dir);
        }
        result
    }
    fn publish_prepared(
        public: &Public,
        dir: &Path,
        mut write: impl FnMut(&Path, &str, &[u8]) -> Result<()>,
    ) -> Result<()> {
        write(dir, "testnet.json", &public.profile_bytes)?;
        write(dir, "testnet-enrollment.json", &public.enrollment_bytes)?;
        write(dir, PREPARED, &serde_json::to_vec(&public.receipt)?)
    }
    fn verify_prepared(
        plan: &Plan,
        plan_sha: &str,
        bundle: &Bundle,
        dir: &Path,
        expected: &str,
    ) -> Result<Public> {
        ensure!(
            lower_hex(expected, 64),
            "independent preparation receipt SHA required"
        );
        let bytes = read_public(&dir.join(PREPARED))?;
        ensure!(sha(&bytes) == expected, "preparation receipt SHA mismatch");
        let frozen: PreparationReceipt = serde_json::from_slice(&bytes)?;
        let public = derive_public(plan, plan_sha, bundle)?;
        ensure!(
            frozen == public.receipt,
            "prepared material substitution refused"
        );
        ensure!(
            read_public(&dir.join("testnet.json"))? == public.profile_bytes,
            "profile bytes changed"
        );
        ensure!(
            read_public(&dir.join("testnet-enrollment.json"))? == public.enrollment_bytes,
            "enrollment bytes changed"
        );
        Ok(public)
    }

    #[derive(Serialize)]
    #[serde(rename_all = "PascalCase")]
    struct EncryptRequest<'a> {
        key_id: &'a str,
        encryption_algorithm: &'a str,
        encryption_context: BTreeMap<String, String>,
        plaintext: &'a str,
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields, rename_all = "PascalCase")]
    struct EncryptResponse {
        key_id: String,
        encryption_algorithm: String,
        ciphertext_blob: String,
        #[serde(default)]
        key_material_id: Option<String>,
    }
    fn encrypt_request(
        profile: &ValidatedVaultProfile,
        purpose: EnvelopePurpose,
        plaintext: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>> {
        let encoded = Zeroizing::new(STANDARD.encode(plaintext));
        Ok(Zeroizing::new(serde_json::to_vec(&EncryptRequest {
            key_id: CMK,
            encryption_algorithm: "SYMMETRIC_DEFAULT",
            encryption_context: custody_encryption_context(profile, purpose)
                .into_iter()
                .collect(),
            plaintext: &encoded,
        })?))
    }
    fn response(bytes: &[u8]) -> Result<Vec<u8>> {
        ensure!(bytes.len() <= MAX, "Encrypt response too large");
        let r: EncryptResponse = serde_json::from_slice(bytes)?;
        ensure!(
            r.key_id == CMK && r.encryption_algorithm == "SYMMETRIC_DEFAULT",
            "Encrypt destination mismatch"
        );
        ensure!(
            r.key_material_id.as_ref().is_none_or(|s| s.len() <= 256),
            "invalid key material id"
        );
        let decoded = STANDARD.decode(&r.ciphertext_blob)?;
        ensure!(
            !decoded.is_empty()
                && decoded.len() <= 6144
                && STANDARD.encode(&decoded) == r.ciphertext_blob,
            "noncanonical ciphertext"
        );
        Ok(decoded)
    }
    fn seal(
        public: &Public,
        bundle: &Bundle,
        prep_sha: &str,
        dir: &Path,
        mut encrypt: impl FnMut(&[u8]) -> Result<Zeroizing<Vec<u8>>>,
        mut write: impl FnMut(&Path, &str, &[u8]) -> Result<()>,
    ) -> Result<()> {
        let mut ciphertexts = Vec::new();
        let mut artifacts = BTreeMap::new();
        for (purpose, name) in PURPOSES {
            let plaintext = match purpose {
                EnvelopePurpose::MasterKey => bundle.root.as_slice(),
                EnvelopePurpose::TransportToken => bundle.transport_token.as_bytes(),
                EnvelopePurpose::FirstAdmin => bundle.admin_token.as_bytes(),
            };
            let request = encrypt_request(&public.profile, purpose, plaintext)?;
            let returned = encrypt(&request)?;
            let decoded = response(&returned)?;
            ensure!(!ciphertexts.contains(&decoded), "reused ciphertext refused");
            let encoded = STANDARD.encode(&decoded);
            // Retain successful partial ciphertext privately; never retry.
            write(dir, name, encoded.as_bytes())?;
            artifacts.insert(name, serde_json::json!({"sha256":sha(encoded.as_bytes()), "context":custody_encryption_context(&public.profile,purpose)}));
            ciphertexts.push(decoded);
        }
        let receipt = serde_json::to_vec(
            &serde_json::json!({"schema":"neoos/testnet-material-sealed/v2","preparation_receipt_sha256":prep_sha,"key_id":CMK,"algorithm":"SYMMETRIC_DEFAULT","artifacts":artifacts}),
        )?;
        write(dir, SEALED, &receipt)
    }

    fn refuse_inheritable_fds() -> Result<()> {
        for fd in open_fds()? {
            let flags = unsafe { fcntl(fd, 1) };
            ensure!(
                fd <= 2 || flags < 0 || flags & 1 != 0,
                "inheritable descriptor refused"
            );
        }
        Ok(())
    }
    fn nonblocking(fd: i32) -> Result<()> {
        #[cfg(target_os = "linux")]
        const FLAG: i32 = 2048;
        #[cfg(not(target_os = "linux"))]
        const FLAG: i32 = 4;
        let current = unsafe { fcntl(fd, 3) };
        ensure!(
            current >= 0 && unsafe { fcntl(fd, 4, current | FLAG) } == 0,
            "nonblocking pipe required"
        );
        Ok(())
    }
    fn bounded_child(
        command: &mut Command,
        request: &[u8],
        timeout: Duration,
    ) -> Result<Zeroizing<Vec<u8>>> {
        ensure!(request.len() <= MAX, "request bound");
        refuse_inheritable_fds()?;
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let outcome = (|| -> Result<Zeroizing<Vec<u8>>> {
            let mut input = child.stdin.take().context("child stdin")?;
            nonblocking(input.as_raw_fd())?;
            input.write_all(request)?;
            drop(input);
            let mut stdout = child.stdout.take().context("child stdout")?;
            let mut stderr = child.stderr.take().context("child stderr")?;
            nonblocking(stdout.as_raw_fd())?;
            nonblocking(stderr.as_raw_fd())?;
            let mut out = Zeroizing::new(Vec::new());
            let mut err = Zeroizing::new(Vec::new());
            let mut eof = [false; 2];
            let started = Instant::now();
            loop {
                for (i, stream, bytes) in [
                    (0, &mut stdout as &mut dyn Read, &mut out),
                    (1, &mut stderr as &mut dyn Read, &mut err),
                ] {
                    let mut buf = Zeroizing::new([0u8; 4096]);
                    match stream.read(buf.as_mut()) {
                        Ok(0) => eof[i] = true,
                        Ok(n) => {
                            ensure!(bytes.len() + n <= MAX, "child output bound");
                            bytes.extend_from_slice(&buf[..n]);
                        }
                        Err(e)
                            if e.kind() == std::io::ErrorKind::WouldBlock
                                || e.kind() == std::io::ErrorKind::Interrupted => {}
                        Err(_) => anyhow::bail!("child output failed"),
                    }
                }
                if let Some(status) = child.try_wait()? {
                    if eof == [true, true] {
                        ensure!(status.success(), "Encrypt child failed");
                        return Ok(out);
                    }
                }
                ensure!(started.elapsed() < timeout, "Encrypt child timeout");
                std::thread::sleep(Duration::from_millis(5));
            }
        })();
        if outcome.is_err() {
            let _ = child.kill();
            let _ = child.wait();
        }
        outcome
    }

    struct AwsCli {
        executable: PathBuf,
        auth: Vec<(String, Zeroizing<String>)>,
    }
    impl AwsCli {
        fn approved(path: &Path) -> Result<Self> {
            clean_absolute(path)?;
            let m = fs::metadata(path)?;
            ensure!(
                m.is_file() && m.mode() & 0o111 != 0 && m.mode() & 0o022 == 0,
                "approved executable required"
            );
            let mut auth = Vec::new();
            // Only this explicitly invoked SEAL branch reads these names.
            for name in [
                "AWS_ACCESS_KEY_ID",
                "AWS_SECRET_ACCESS_KEY",
                "AWS_SESSION_TOKEN",
            ] {
                let value = Zeroizing::new(
                    std::env::var(name).context("temporary AWS authentication required")?,
                );
                ensure!(
                    !value.is_empty() && value.len() <= 16384,
                    "invalid temporary authentication"
                );
                auth.push((name.to_string(), value));
            }
            Ok(Self {
                executable: path.into(),
                auth,
            })
        }
        fn command(&self) -> Command {
            let mut command = Command::new(&self.executable);
            command.env_clear().args([
                "kms",
                "encrypt",
                "--cli-input-json",
                "file:///dev/stdin",
                "--cli-binary-format",
                "base64",
                "--region",
                REGION,
                "--endpoint-url",
                "https://kms.us-east-1.amazonaws.com",
                "--output",
                "json",
                "--no-cli-pager",
                "--cli-connect-timeout",
                "5",
                "--cli-read-timeout",
                "10",
            ]);
            for (name, value) in &self.auth {
                command.env(name, value.as_str());
            }
            command
                .env("AWS_CONFIG_FILE", "/dev/null")
                .env("AWS_SHARED_CREDENTIALS_FILE", "/dev/null")
                .env("AWS_EC2_METADATA_DISABLED", "true")
                .env("AWS_MAX_ATTEMPTS", "1")
                .env("AWS_RETRY_MODE", "standard")
                .env("AWS_PAGER", "")
                .env("AWS_CLI_AUTO_PROMPT", "off")
                .env("HOME", "/nonexistent");
            command
        }
        fn encrypt(&self, request: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
            bounded_child(&mut self.command(), request, Duration::from_secs(20))
        }
    }

    pub(super) fn run(args: Vec<String>) -> Result<()> {
        ensure!(
            matches!(
                args.first().map(String::as_str),
                Some("prepare") | Some("seal")
            ),
            "explicit subcommand required"
        );
        let preparing = args[0] == "prepare";
        ensure!(
            args.len() == if preparing { 6 } else { 9 },
            "invalid fixed argument count"
        );
        let plan_bytes = read_public(Path::new(&args[1]))?;
        let plan = parse_plan(&plan_bytes, &args[2])?;
        let public_dir = Path::new(&args[3]);
        private_directory(public_dir, preparing)?;
        let private = PrivateFile::take(args[4].parse()?, Path::new(&args[5]), preparing)?;
        refuse_inheritable_fds()?;
        if preparing {
            let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
            let bundle = generate_bundle(&plan, &args[2], now, |b| {
                OsRng
                    .try_fill_bytes(b)
                    .map_err(|_| anyhow::anyhow!("entropy unavailable"))
            })?;
            let public = derive_public(&plan, &args[2], &bundle)?;
            private.retain(&bundle)?;
            publish_prepared(&public, public_dir, write_new)?;
        } else {
            let bundle = private.consume()?;
            let public = verify_prepared(&plan, &args[2], &bundle, public_dir, &args[6])?;
            let ciphertext_dir = Path::new(&args[7]);
            private_directory(ciphertext_dir, true)?;
            let aws = AwsCli::approved(Path::new(&args[8]))?;
            seal(
                &public,
                &bundle,
                &args[6],
                ciphertext_dir,
                |r| aws.encrypt(r),
                write_new,
            )?;
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use serde_json::{json, Value};
        use std::os::unix::fs::{symlink, PermissionsExt};

        // Explicitly synthetic public fixtures. No production RNG/clock/auth.
        fn plan_bytes() -> Vec<u8> {
            serde_json::to_vec(&json!({
                "schema":"neoos/testnet-material-plan/v1", "environment":"testnet",
                "source_commit":"a".repeat(40), "source_tree":"b".repeat(40),
                "ceremony_id":"synthetic-ceremony", "caller_id":"synthetic-admin", "caller_label":"Synthetic only",
                "vault_id":"12".repeat(16), "root_key_version":"synthetic-root-v1", "custody_kms_key_arn":CMK,
                "networks":[
                    {"chain_family":"neo-n3","chain_id":894710606,"genesis_hash":"0x9d3276785e7306daf59a3f3b9e31912c095598bbfb8a4476b821b0e59be4c57a"},
                    {"chain_family":"neox","chain_id":12227332,"genesis_hash":format!("0x{}","34".repeat(32))}
                ],
                "coordinator":{"origin":"https://synthetic.invalid","aws_region":REGION,
                    "snapshot_bucket":"synthetic-custody-only","snapshot_prefix":"testnet/synthetic",
                    "receipt_keys":[{"key_id":"synthetic-p256", "public_key_sec1_hex":concat!(
                        "046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296",
                        "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5")} ]}
            })).unwrap()
        }
        fn fixture() -> (Plan, String, Bundle, Public) {
            let b = plan_bytes();
            let hash = sha(&b);
            let p = parse_plan(&b, &hash).unwrap();
            let bundle = Bundle {
                schema: "neoos/testnet-private-material/v1".into(),
                plan_sha256: hash.clone(),
                created_at_unix: 123456,
                root: [0x5a; 32],
                transport_token: format!("nsk1_{}", "1".repeat(64)),
                admin_token: format!("nsk1_{}", "2".repeat(64)),
            };
            let public = derive_public(&p, &hash, &bundle).unwrap();
            (p, hash, bundle, public)
        }
        fn directory() -> tempfile::TempDir {
            let d = tempfile::tempdir().unwrap();
            fs::set_permissions(d.path(), fs::Permissions::from_mode(0o700)).unwrap();
            d
        }
        fn canonical(dir: &tempfile::TempDir) -> PathBuf {
            dir.path().canonicalize().unwrap()
        }
        fn file(dir: &Path, name: &str) -> (File, PathBuf) {
            let p = dir.join(name);
            (
                OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&p)
                    .unwrap(),
                p,
            )
        }
        fn successful_response(n: u8) -> Zeroizing<Vec<u8>> {
            Zeroizing::new(serde_json::to_vec(&json!({"KeyId":CMK,"EncryptionAlgorithm":"SYMMETRIC_DEFAULT","CiphertextBlob":STANDARD.encode([n;64])})).unwrap())
        }

        #[test]
        fn actual_native_validators_and_independent_known_vectors_join() {
            let (_, _, bundle, public) = fixture();
            assert_eq!(
                public.receipt.root_key_commitment,
                "f7dabe4a6737d5dd6e3387103b4188dbddf21dd4c3667a11e88c6272128ddc44"
            );
            assert_eq!(
                public.receipt.admin_token_sha256,
                "e04730997303d1fc80799f0f101ee9de90c978708e49376b7c9b590cfb15dfd5"
            );
            assert_ne!(
                public.receipt.native_profile_sha256,
                public.receipt.profile_file_sha256
            );
            assert_eq!(
                public.profile.document().release_policy_version,
                sha(&public.enrollment_bytes)
            );
            public
                .profile
                .verify_master(&MasterKey::from_bytes(bundle.root))
                .unwrap();
            assert!(public
                .profile
                .verify_master(&MasterKey::from_bytes([0x5b; 32]))
                .is_err());
            ValidatedGenesisEnrollment::from_json(&public.enrollment_bytes, &public.profile)
                .unwrap();
            let mut altered = public.enrollment_bytes.clone();
            altered.push(b' ');
            assert!(ValidatedGenesisEnrollment::from_json(&altered, &public.profile).is_err());
        }

        #[test]
        fn plan_refusals_precede_entropy() {
            for field in [
                "mainnet",
                "one-family",
                "wrong-order",
                "n3-genesis",
                "n3-id",
                "x-id",
                "region",
                "cmk",
                "extra",
                "nested-extra",
                "label",
                "private-override",
            ] {
                let mut v: Value = serde_json::from_slice(&plan_bytes()).unwrap();
                match field {
                    "mainnet" => v["environment"] = json!("mainnet"),
                    "one-family" => {
                        v["networks"].as_array_mut().unwrap().pop();
                    }
                    "wrong-order" => v["networks"].as_array_mut().unwrap().swap(0, 1),
                    "n3-genesis" => {
                        v["networks"][0]["genesis_hash"] = json!(format!("0x{}", "45".repeat(32)))
                    }
                    "n3-id" => v["networks"][0]["chain_id"] = json!(860833102),
                    "x-id" => v["networks"][1]["chain_id"] = json!(47763),
                    "region" => v["coordinator"]["aws_region"] = json!("us-west-2"),
                    "cmk" => v["custody_kms_key_arn"] = json!("alias/other"),
                    "nested-extra" => v["coordinator"]["extra"] = json!(true),
                    "label" => v["caller_label"] = json!("\ninvalid"),
                    "private-override" => v["root_key_commitment"] = json!("1".repeat(64)),
                    _ => v["extra"] = json!(true),
                }
                let bytes = serde_json::to_vec(&v).unwrap();
                assert!(
                    parse_plan(&bytes, &sha(&bytes)).is_err(),
                    "accepted {field}"
                );
            }
            let bytes = plan_bytes();
            let text = String::from_utf8(bytes.clone()).unwrap();
            let duplicate = text.replacen('{', "{\"environment\":\"testnet\",", 1);
            assert!(parse_plan(duplicate.as_bytes(), &sha(duplicate.as_bytes())).is_err());
            assert!(parse_plan(&bytes, &"0".repeat(64)).is_err());
            assert!(parse_plan(&vec![b' '; MAX + 1], &"0".repeat(64)).is_err());
            let (mut p, hash, _, _) = fixture();
            p.environment = "mainnet".into();
            assert!(generate_bundle(&p, &hash, 1, |_| panic!(
                "entropy must not run for invalid plan"
            ))
            .is_err());
        }

        #[test]
        fn only_injected_synthetic_entropy_and_clock_are_exercised() {
            let (p, h, _, _) = fixture();
            let mut calls = 0;
            let b = generate_bundle(&p, &h, 42, |v| {
                calls += 1;
                v.fill(calls);
                Ok(())
            })
            .unwrap();
            assert_eq!(calls, 3);
            assert_eq!(b.root, [1; 32]);
            assert_eq!(b.created_at_unix, 42);
            assert!(token(&b.admin_token) && token(&b.transport_token));
            assert_ne!(b.admin_token, b.transport_token);
            assert!(
                generate_bundle(&p, &h, 42, |_| anyhow::bail!("synthetic entropy failure"))
                    .is_err()
            );
            assert!(generate_bundle(&p, &h, 42, |v| {
                v.fill(7);
                Ok(())
            })
            .is_err());
            assert!(
                generate_bundle(&p, &h, 0, |_| panic!("clock rejected before entropy")).is_err()
            );
        }

        #[test]
        fn private_file_is_durable_and_closed_before_any_child() {
            let (_, _, bundle, public) = fixture();
            let d = directory();
            let dir = canonical(&d);
            let (output, path) = file(&dir, "private.json");
            let fd = output.into_raw_fd();
            let private = PrivateFile::take(fd, &path, true).unwrap();
            assert_eq!(unsafe { fcntl(fd, 1) } & 1, 1);
            private.retain(&bundle).unwrap();
            assert_eq!(unsafe { fcntl(fd, 1) }, -1);
            let input = OpenOptions::new().read(true).open(&path).unwrap();
            let fd = input.into_raw_fd();
            let restored = PrivateFile::take(fd, &path, false)
                .unwrap()
                .consume()
                .unwrap();
            assert_eq!(unsafe { fcntl(fd, 1) }, -1);
            assert_eq!(restored.root, [0x5a; 32]);
            assert_eq!(restored.transport_token, bundle.transport_token);
            assert_eq!(restored.admin_token, bundle.admin_token);
            let script = dir.join("fake-child");
            fs::write(
                &script,
                format!("#!/bin/sh\nif [ -r /dev/fd/{fd} ]; then exit 91; fi\nexec /bin/cat\n"),
            )
            .unwrap();
            fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
            let request =
                encrypt_request(&public.profile, EnvelopePurpose::MasterKey, &restored.root)
                    .unwrap();
            let returned = bounded_child(
                Command::new(&script).env_clear(),
                &request,
                Duration::from_secs(2),
            )
            .unwrap();
            assert_eq!(returned.as_slice(), request.as_slice());
            let v: Value = serde_json::from_slice(&returned).unwrap();
            assert_eq!(
                STANDARD.decode(v["Plaintext"].as_str().unwrap()).unwrap(),
                [0x5a; 32]
            );
            assert!(!returned
                .windows(bundle.admin_token.len())
                .any(|w| w == bundle.admin_token.as_bytes()));
            assert!(!returned
                .windows(bundle.transport_token.len())
                .any(|w| w == bundle.transport_token.as_bytes()));
        }

        #[test]
        fn private_alias_permissions_paths_and_inheritance_refuse() {
            assert!(PrivateFile::take(1, Path::new("/unused"), true).is_err());
            let d = directory();
            let dir = canonical(&d);
            let (f, path) = file(&dir, "alias.json");
            let duplicate = f.try_clone().unwrap();
            assert!(PrivateFile::take(duplicate.into_raw_fd(), &path, true).is_err());
            drop(f);
            let (f, path) = file(&dir, "hard.json");
            fs::hard_link(&path, dir.join("hard2.json")).unwrap();
            assert!(PrivateFile::take(f.into_raw_fd(), &path, true).is_err());
            let (f, path) = file(&dir, "mode.json");
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
            assert!(PrivateFile::take(f.into_raw_fd(), &path, true).is_err());
            let (f, path) = file(&dir, "link-target.json");
            let link = dir.join("link.json");
            symlink(&path, &link).unwrap();
            assert!(PrivateFile::take(f.into_raw_fd(), &link, true).is_err());
            let (mut f, path) = file(&dir, "nonempty.json");
            f.write_all(b"synthetic").unwrap();
            assert!(PrivateFile::take(f.into_raw_fd(), &path, true).is_err());
            let (f, path) = file(&dir, "readonly.json");
            drop(f);
            let f = File::open(&path).unwrap();
            assert!(PrivateFile::take(f.into_raw_fd(), &path, true).is_err());
            let (f, _) = file(&dir, "inheritable.json");
            let fd = f.as_raw_fd();
            assert_eq!(unsafe { fcntl(fd, 2, 0) }, 0);
            assert!(refuse_inheritable_fds().is_err());
            assert_eq!(unsafe { fcntl(fd, 2, 1) }, 0);
        }

        #[test]
        fn transport_only_substitution_requires_independent_receipt() {
            let (p, h, mut bundle, public) = fixture();
            let d = directory();
            let dir = canonical(&d);
            publish_prepared(&public, &dir, write_new).unwrap();
            let independent = sha(&read_public(&dir.join(PREPARED)).unwrap());
            verify_prepared(&p, &h, &bundle, &dir, &independent).unwrap();
            bundle.transport_token = format!("nsk1_{}", "3".repeat(64));
            assert!(verify_prepared(&p, &h, &bundle, &dir, &independent).is_err());
            // Updating a digest next to the replaced token cannot update the independent pin.
            let replacement = derive_public(&p, &h, &bundle).unwrap();
            fs::write(
                dir.join(PREPARED),
                serde_json::to_vec(&replacement.receipt).unwrap(),
            )
            .unwrap();
            assert!(verify_prepared(&p, &h, &bundle, &dir, &independent).is_err());
        }

        #[test]
        fn changed_private_or_public_bindings_refuse_before_encrypt() {
            for mutation in [
                "root",
                "admin",
                "same-token",
                "time",
                "bundle-plan",
                "profile",
                "enrollment",
                "receipt",
                "source",
                "network",
            ] {
                let (mut p, h, mut b, public) = fixture();
                let d = directory();
                let dir = canonical(&d);
                publish_prepared(&public, &dir, write_new).unwrap();
                let expected = sha(&read_public(&dir.join(PREPARED)).unwrap());
                match mutation {
                    "root" => b.root = [0x6b; 32],
                    "admin" => b.admin_token = format!("nsk1_{}", "4".repeat(64)),
                    "same-token" => b.admin_token = b.transport_token.clone(),
                    "time" => b.created_at_unix += 1,
                    "bundle-plan" => b.plan_sha256 = "0".repeat(64),
                    "profile" => {
                        fs::write(dir.join("testnet.json"), b"{}").unwrap();
                    }
                    "enrollment" => {
                        fs::write(dir.join("testnet-enrollment.json"), b"{}").unwrap();
                    }
                    "receipt" => {
                        fs::write(dir.join(PREPARED), b"{}").unwrap();
                    }
                    "source" => p.source_commit = "c".repeat(40),
                    "network" => p.networks[0].genesis_hash = format!("0x{}", "6".repeat(64)),
                    _ => unreachable!(),
                }
                assert!(
                    verify_prepared(&p, &h, &b, &dir, &expected).is_err(),
                    "accepted {mutation}"
                );
            }
            let (_, _, b, _) = fixture();
            let bytes = Zeroizing::new(serde_json::to_vec(&b).unwrap());
            for len in [31, 33] {
                let mut v: Value = serde_json::from_slice(&bytes).unwrap();
                v["root"] = json!(vec![90; len]);
                assert!(
                    serde_json::from_slice::<Bundle>(&serde_json::to_vec(&v).unwrap()).is_err()
                );
            }
        }

        #[test]
        fn purpose_selected_plaintext_context_and_all_three_outputs() {
            let (_, _, b, public) = fixture();
            let d = directory();
            let dir = canonical(&d);
            let mut calls = 0;
            seal(&public,&b,&"a".repeat(64),&dir,|request|{
                let v:Value=serde_json::from_slice(request).unwrap();
                assert_eq!(v["KeyId"],CMK);assert_eq!(v["EncryptionAlgorithm"],"SYMMETRIC_DEFAULT");
                let expected=match calls {0=>b.root.as_slice(),1=>b.transport_token.as_bytes(),2=>b.admin_token.as_bytes(),_=>panic!("extra Encrypt")};
                assert_eq!(STANDARD.decode(v["Plaintext"].as_str().unwrap()).unwrap(),expected);
                assert_eq!(v["EncryptionContext"],json!({"neoos:component":"custody","neoos:purpose":(["master-key/v1","transport-token/v1","first-admin/v1"][calls]),
                    "neoos:vault-id":"12".repeat(16),"neoos:profile-sha256":hex::encode(public.profile.profile_hash()),
                    "neoos:network-set-sha256":hex::encode(public.profile.network_set_hash()),"neoos:root-key-version":"synthetic-root-v1"}));
                calls+=1;Ok(successful_response(calls as u8))
            },write_new).unwrap();
            assert_eq!(calls, 3);
            assert_eq!(fs::read_dir(&dir).unwrap().count(), 4);
            let v: Value =
                serde_json::from_slice(&read_public(&dir.join(SEALED)).unwrap()).unwrap();
            assert_eq!(v["artifacts"].as_object().unwrap().len(), 3);
            for entry in fs::read_dir(&dir).unwrap() {
                let bytes = fs::read(entry.unwrap().path()).unwrap();
                for secret in [
                    b.admin_token.as_bytes(),
                    b.transport_token.as_bytes(),
                    b.root.as_slice(),
                ] {
                    assert!(!bytes.windows(secret.len()).any(|w| w == secret));
                }
            }
        }

        #[test]
        fn malformed_encrypt_responses_and_partial_failure_never_complete() {
            for mutation in [
                "key",
                "algorithm",
                "empty",
                "base64",
                "extra",
                "too-large",
                "repeat",
                "call2",
            ] {
                let (_, _, b, public) = fixture();
                let d = directory();
                let dir = canonical(&d);
                let mut calls = 0;
                let result = seal(
                    &public,
                    &b,
                    &"a".repeat(64),
                    &dir,
                    |_| {
                        calls += 1;
                        if mutation == "call2" && calls == 2 {
                            anyhow::bail!("synthetic private upstream error");
                        }
                        let mut v: Value =
                            serde_json::from_slice(&successful_response(if mutation == "repeat" {
                                1
                            } else {
                                calls
                            }))
                            .unwrap();
                        match mutation {
                            "key" => v["KeyId"] = json!("alias/wrong"),
                            "algorithm" => v["EncryptionAlgorithm"] = json!("RSAES_OAEP_SHA_256"),
                            "empty" => v["CiphertextBlob"] = json!(""),
                            "base64" => v["CiphertextBlob"] = json!("AQ==\n"),
                            "extra" => v["unexpected"] = json!(true),
                            "too-large" => {
                                v["CiphertextBlob"] = json!(STANDARD.encode(vec![1; 6145]))
                            }
                            _ => {}
                        }
                        Ok(Zeroizing::new(serde_json::to_vec(&v).unwrap()))
                    },
                    write_new,
                );
                assert!(result.is_err(), "accepted {mutation}");
                assert!(!dir.join(SEALED).exists());
                assert!(calls <= 2);
            }
        }

        #[test]
        fn write_failures_never_publish_an_eligible_completion() {
            let (_, _, b, public) = fixture();
            for fail_at in 1..=3 {
                let d = directory();
                let dir = canonical(&d);
                let mut n = 0;
                assert!(publish_prepared(&public, &dir, |d, nm, bytes| {
                    n += 1;
                    if n == fail_at {
                        anyhow::bail!("synthetic durable-write failure");
                    }
                    write_new(d, nm, bytes)
                })
                .is_err());
                assert!(!dir.join(PREPARED).exists());
            }
            for fail_at in 1..=4 {
                let d = directory();
                let dir = canonical(&d);
                let mut n = 0;
                let mut calls = 0;
                assert!(seal(
                    &public,
                    &b,
                    &"a".repeat(64),
                    &dir,
                    |_| {
                        calls += 1;
                        Ok(successful_response(calls))
                    },
                    |d, nm, bytes| {
                        n += 1;
                        if n == fail_at {
                            anyhow::bail!("synthetic durable-write failure");
                        }
                        write_new(d, nm, bytes)
                    }
                )
                .is_err());
                assert!(!dir.join(SEALED).exists());
            }
            let d = directory();
            let dir = canonical(&d);
            write_new(&dir, "existing", b"original").unwrap();
            assert!(write_new(&dir, "existing", b"replacement").is_err());
            assert_eq!(fs::read(dir.join("existing")).unwrap(), b"original");
        }

        #[test]
        fn aws_command_uses_no_plaintext_argv_and_no_ambient_configuration() {
            let (_, _, b, public) = fixture();
            let d = directory();
            let dir = canonical(&d);
            let script = dir.join("fake-aws");
            fs::write(&script, b"#!/bin/sh\nexec /bin/cat\n").unwrap();
            fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
            let aws = AwsCli {
                executable: script,
                auth: vec![
                    (
                        "AWS_ACCESS_KEY_ID".into(),
                        Zeroizing::new("SYNTHETIC_ONLY".into()),
                    ),
                    (
                        "AWS_SECRET_ACCESS_KEY".into(),
                        Zeroizing::new("SYNTHETIC_ONLY".into()),
                    ),
                    (
                        "AWS_SESSION_TOKEN".into(),
                        Zeroizing::new("SYNTHETIC_ONLY".into()),
                    ),
                ],
            };
            let command = aws.command();
            let args: Vec<_> = command
                .get_args()
                .map(|s| s.to_string_lossy().into_owned())
                .collect();
            assert_eq!(
                args,
                [
                    "kms",
                    "encrypt",
                    "--cli-input-json",
                    "file:///dev/stdin",
                    "--cli-binary-format",
                    "base64",
                    "--region",
                    "us-east-1",
                    "--endpoint-url",
                    "https://kms.us-east-1.amazonaws.com",
                    "--output",
                    "json",
                    "--no-cli-pager",
                    "--cli-connect-timeout",
                    "5",
                    "--cli-read-timeout",
                    "10"
                ]
            );
            let env: BTreeMap<_, _> = command
                .get_envs()
                .map(|(k, v)| {
                    (
                        k.to_string_lossy().into_owned(),
                        v.map(|v| v.to_string_lossy().into_owned()),
                    )
                })
                .collect();
            assert_eq!(env.len(), 11);
            assert_eq!(env["AWS_MAX_ATTEMPTS"], Some("1".into()));
            assert!(!env.contains_key("AWS_PROFILE"));
            assert!(!env.contains_key("HTTPS_PROXY"));
            for secret in [&b.admin_token, &b.transport_token] {
                assert!(!args.iter().any(|v| v.contains(secret)));
                assert!(!env.values().flatten().any(|v| v.contains(secret)));
            }
            let request = encrypt_request(
                &public.profile,
                EnvelopePurpose::FirstAdmin,
                b.admin_token.as_bytes(),
            )
            .unwrap();
            assert_eq!(
                aws.encrypt(&request).unwrap().as_slice(),
                request.as_slice()
            );
        }

        #[test]
        fn fake_child_error_output_is_bounded_and_redacted() {
            let d = directory();
            let dir = canonical(&d);
            let script = dir.join("fake-failure");
            fs::write(&script, b"#!/bin/sh\n/bin/cat >&2\nexit 8\n").unwrap();
            fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
            let error = bounded_child(
                Command::new(script).env_clear(),
                b"SYNTHETIC_PRIVATE_CANARY",
                Duration::from_secs(2),
            )
            .unwrap_err();
            assert!(!error.to_string().contains("SYNTHETIC_PRIVATE_CANARY"));
        }
    }
}
