//! CLI subcommand handler for the relayer.
//!
//! Pinned against `workers/morpheus-relayer/src/cli.js`.

use std::collections::BTreeMap;
use std::io::Write;

use neo_os_core::js_value::JsObject;
use neo_os_core::state::snapshot_metrics;

use crate::config::{create_relayer_config, js_value_to_json};
use crate::config_introspect::{format_config_dump, validate_relayer_config};
use crate::observe::{render_prometheus_metrics, start_metrics_server};
use crate::relayer::{load_or_init_state, now_ms, run_relayer_loop, run_relayer_once};

const CLI_MODES: &[&str] = &[
    "once",
    "loop",
    "metrics",
    "metrics:prom",
    "serve:metrics",
    "config:validate",
    "config:dump",
];

fn validate_cli_mode(mode: &str) -> Result<(), String> {
    if CLI_MODES.contains(&mode) {
        Ok(())
    } else {
        Err(format!(
            "unknown relayer mode {mode:?}; expected one of: {}",
            CLI_MODES.join(", ")
        ))
    }
}

fn explicit_cli_mode(args: &[String]) -> Result<&str, String> {
    args.get(1).map(String::as_str).ok_or_else(|| {
        format!(
            "relayer mode is required; expected one of: {}",
            CLI_MODES.join(", ")
        )
    })
}

async fn load_metrics_snapshot(state_file: String) -> Result<JsObject, std::io::Error> {
    let handle = tokio::task::spawn_blocking(move || {
        let state = load_or_init_state(&state_file).map_err(std::io::Error::other)?;
        Ok::<JsObject, std::io::Error>(snapshot_metrics(&state, now_ms()))
    });
    handle
        .await
        .map_err(|error| std::io::Error::other(format!("metrics snapshot task failed: {error}")))?
}

pub async fn run_cli() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args: Vec<String> = std::env::args().collect();
    let mode = explicit_cli_mode(&args).map_err(std::io::Error::other)?;
    validate_cli_mode(mode).map_err(std::io::Error::other)?;

    let env: BTreeMap<String, String> = std::env::vars().collect();

    // 1. config:validate
    if mode == "config:validate" {
        let result = validate_relayer_config(&env, None);
        let output = serde_json::to_string_pretty(&result)?;
        println!("{output}");
        if !result.ok {
            return Err(std::io::Error::other("relayer configuration validation failed").into());
        }
        return Ok(());
    }

    // 2. config:dump
    if mode == "config:dump" {
        let dump = format_config_dump(&env);
        println!("{dump}");
        return Ok(());
    }

    // For runtime modes, eagerly construct config
    let config = create_relayer_config().map_err(std::io::Error::other)?;

    match mode {
        "loop" => {
            run_relayer_loop(&config).await?;
        }
        "metrics" => {
            let snapshot = load_metrics_snapshot(config.state_file.clone()).await?;
            let snapshot_val = js_value_to_json(&neo_os_core::js_value::JsValue::Object(snapshot));
            let output = serde_json::json!({
                "state_file": config.state_file,
                "metrics": snapshot_val,
            });
            println!("{}", serde_json::to_string_pretty(&output)?);
        }
        "metrics:prom" => {
            let snapshot = load_metrics_snapshot(config.state_file.clone()).await?;
            let snapshot_val = js_value_to_json(&neo_os_core::js_value::JsValue::Object(snapshot));
            let prom_text = render_prometheus_metrics(&snapshot_val);
            std::io::stdout().write_all(prom_text.as_bytes())?;
        }
        "serve:metrics" => {
            let host = config
                .raw
                .pointer("/metricsServer/host")
                .and_then(|v| v.as_str())
                .unwrap_or("127.0.0.1");
            let port = config
                .raw
                .pointer("/metricsServer/port")
                .and_then(|v| v.as_u64())
                .unwrap_or(9464) as u16;
            let path = config
                .raw
                .pointer("/metricsServer/path")
                .and_then(|v| v.as_str())
                .unwrap_or("/metrics");

            start_metrics_server(host, port, path, &config.state_file).await?;
        }
        "once" => {
            let result = run_relayer_once(&config).await.map_err(|e| {
                eprintln!("Relayer tick failed: {e}");
                std::io::Error::other(e)
            })?;
            println!("{}", serde_json::to_string_pretty(&result)?);
        }
        _ => unreachable!("mode was validated before dispatch"),
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{explicit_cli_mode, validate_cli_mode};

    #[test]
    fn rejects_missing_mode_instead_of_defaulting_to_once() {
        let error = explicit_cli_mode(&["neo-os-relayer".to_string()])
            .expect_err("missing mode must fail closed");
        assert!(error.contains("relayer mode is required"));
    }

    #[test]
    fn rejects_unknown_mode_instead_of_running_once() {
        let error = validate_cli_mode("typo").expect_err("unknown mode must fail closed");
        assert!(error.contains("unknown relayer mode"));
    }

    #[test]
    fn accepts_explicit_once_mode() {
        assert!(validate_cli_mode("once").is_ok());
    }
}
