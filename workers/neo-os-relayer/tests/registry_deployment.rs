//! The packaged binary must resolve reviewed contracts without a source checkout.
use std::{
    fs,
    path::PathBuf,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

struct Workdir(PathBuf);

impl Drop for Workdir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn deployed_binary_uses_reviewed_registries_in_empty_or_forged_workdirs() {
    let root = Workdir(std::env::temp_dir().join(format!(
        "neoos-relayer-registry-{}-{}", std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
    )));
    fs::create_dir_all(&root.0).unwrap();
    for input in [None, Some("{}"), Some("not-json")] {
        if let Some(input) = input {
            fs::create_dir_all(root.0.join("config/networks")).unwrap();
            for network in ["mainnet", "testnet"] {
                fs::write(
                    root.0.join(format!("config/networks/{network}.json")),
                    input,
                )
                .unwrap();
            }
        }
        for network in ["mainnet", "testnet"] {
            let output = Command::new(env!("CARGO_BIN_EXE_neo-os-relayer"))
                .arg("config:validate")
                .current_dir(&root.0)
                .env_clear()
                .env("NODE_ENV", "production")
                .env("MORPHEUS_NETWORK", network)
                .output()
                .unwrap();
            let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(report["network"], network);
            let errors = report["errors"].as_array().unwrap();
            for field in ["neo_n3.oracleContract", "neo_n3.datafeedContract"] {
                assert!(
                    !errors.iter().any(|e| e["key"] == field),
                    "{network} lost registry field {field} in workdir with {input:?}: {report}"
                );
            }
            assert!(
                !output.status.success(),
                "missing custody must still fail closed"
            );
            assert!(errors.iter().any(|e| e["key"] == "nitro.custodyToken"));
        }
    }
}
