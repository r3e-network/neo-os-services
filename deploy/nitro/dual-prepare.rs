//! Build-only public configuration check. Compiled as an example against the
//! exact host library in the builder stage; never copied into the runtime.
use std::io::Read;
use std::path::Path;

use nitro_enclave_host::custody_bootstrap;
use nitro_enclave_host::network_profiles::{NetworkProfiles, PROFILES_ENV};
use nitro_enclave_host::overlay::EnvOverlay;
use sha2::{Digest, Sha256};

fn valid_role_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

fn validate(path: &Path) -> Result<serde_json::Value, ()> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| ())?;
    if !metadata.is_file() || metadata.len() > 65_536 {
        return Err(());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|_| ())?
        .take(65_537)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() > 65_536 {
        return Err(());
    }
    let raw = std::str::from_utf8(&bytes).map_err(|_| ())?;
    // Never read process configuration. No NSM, KMS, state, key or listener is
    // initialized: this is precisely the planning step used by measured boot.
    let base = EnvOverlay::new([
        (PROFILES_ENV, raw),
        ("NODE_ENV", "production"),
        ("MORPHEUS_ATTESTED_BOOT", "require"),
        ("MORPHEUS_ALLOW_EPHEMERAL_KEY", "0"),
    ]);
    let profiles = NetworkProfiles::from_overlay(&base).map_err(|_| ())?;
    if !profiles.explicit {
        return Err(());
    }
    // Match InProcessCustodyTransport's native key-route grammar. These are
    // routing IDs, not generic public labels (which may contain dots).
    for overlay in profiles.overlays.values() {
        for role in [
            "ORACLE_VERIFIER",
            "UPDATER",
            "RELAYER",
            "WORKER",
            "NEOX_UPDATER",
            "NEOX_VERIFIER",
        ] {
            let key = format!("SIGNER_ROLE_{role}_KEY_ID");
            let id = overlay.get(&key).ok_or(())?;
            if !valid_role_id(id) {
                return Err(());
            }
        }
    }
    #[cfg(feature = "embedded-relayer")]
    nitro_enclave_host::embedded_relayer::validate_public_profiles(&profiles).map_err(|_| ())?;
    let plans = custody_bootstrap::prepare(&profiles).map_err(|_| ())?;
    let networks: Vec<_> = plans.keys().map(String::as_str).collect();
    if networks != ["mainnet", "testnet"] {
        return Err(());
    }
    Ok(serde_json::json!({
        "schema": "neoos/dual-custody-build/v1",
        "networks": networks,
        "map_sha256": hex::encode(Sha256::digest(&bytes)),
    }))
}

fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let result = if args.len() == 1 {
        validate(Path::new(&args[0]))
    } else {
        Err(())
    };
    match result {
        Ok(receipt) => println!("{receipt}"),
        Err(()) => {
            eprintln!("dual custody build preparation refused");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::valid_role_id;
    use axum::{routing::get, Json, Router};
    use nitro_enclave_host::{
        custody::CustodyRequest, embedded_custody::InProcessCustodyTransport,
    };
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[tokio::test(flavor = "current_thread")]
    async fn role_validation_matches_actual_native_key_route() {
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let router = Router::new().fallback(get(move || {
            seen.fetch_add(1, Ordering::SeqCst);
            async { Json(serde_json::json!({"synthetic": true})) }
        }));
        let transport = InProcessCustodyTransport::new("mainnet", router).unwrap();
        for (id, accepted) in [
            ("mainnet-worker".to_owned(), true),
            ("_worker".to_owned(), true),
            ("a".repeat(128), true),
            ("mainnet.worker".to_owned(), false),
            ("a/b".to_owned(), false),
            ("a%2fb".to_owned(), false),
            ("é".to_owned(), false),
            (String::new(), false),
            ("a".repeat(129), false),
        ] {
            assert_eq!(valid_role_id(&id), accepted, "{id}");
            let before = calls.load(Ordering::SeqCst);
            let result = transport
                .send_async(CustodyRequest {
                    method: "GET",
                    url: format!("http://127.0.0.1:0/mainnet/signer/api/v1/keys/{id}"),
                    token: None,
                    body: None,
                })
                .await;
            assert_eq!(result.is_ok(), accepted, "{id}");
            assert_eq!(calls.load(Ordering::SeqCst) - before, usize::from(accepted));
        }
    }
}
