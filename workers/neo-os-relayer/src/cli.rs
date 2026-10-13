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
    "serve:sponsor",
    "config:validate",
    "config:dump",
    "health",
    "delivery:import",
    "delivery:replay",
    "delivery:resolve-legacy",
    "delivery:reconcile",
    "delivery:rescan",
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
        "delivery:rescan" => {
            let chain = args
                .get(2)
                .ok_or("rescan requires chain, from, to")?
                .clone();
            let from = args.get(3).ok_or("rescan from required")?.parse::<u64>()?;
            let to = args.get(4).ok_or("rescan to required")?.parse::<u64>()?;
            let config = config.clone();
            let result = tokio::task::spawn_blocking(move || {
                crate::durable_v2::rescan(
                    &config,
                    &chain,
                    from,
                    to,
                    &crate::transport::RelayerHttpTransport::new(),
                )
            })
            .await?
            .map_err(std::io::Error::other)?;
            println!("{result}");
        }
        "delivery:reconcile" => {
            let key = args
                .get(2)
                .ok_or("reconcile requires job_key, actor and reason")?
                .clone();
            let actor = args.get(3).ok_or("reconcile actor required")?.clone();
            let reason = args
                .get(4)
                .ok_or("reconcile evidence reason required")?
                .clone();
            let config = config.clone();
            tokio::task::spawn_blocking(move || -> Result<(), String> {
                let transport = crate::transport::RelayerHttpTransport::new();
                let client = crate::durable_v2::client(&config, &transport)?;
                let store = neo_os_relayer_store::delivery::DeliveryStore { client: &client };
                let job = store.lookup(&key, now_ms() as u64)?;
                let hash = job
                    .journal
                    .pointer("/signed/tx_hash")
                    .or_else(|| job.journal.pointer("/legacy/tx_hash"))
                    .and_then(serde_json::Value::as_str)
                    .filter(|v| !v.is_empty())
                    .ok_or("no recorded transaction hash; use evidence-based legacy resolution")?;
                let receipt = match crate::delivery::observe_existing_transaction(
                    &config, &job.chain, hash, &transport,
                ) {
                    Ok(receipt) => receipt,
                    Err(error) if job.chain == "neo_n3" => crate::delivery::observe_expired_n3(
                        &config,
                        job.journal.get("signed").ok_or(error)?,
                        &transport,
                    )?,
                    Err(error) => return Err(error),
                };
                store.reconcile(
                    &job,
                    serde_json::to_value(receipt).map_err(|e| e.to_string())?,
                    &actor,
                    &reason,
                    now_ms() as u64,
                )
            })
            .await?
            .map_err(std::io::Error::other)?;
            println!("{}", serde_json::json!({"reconciled":true}));
        }
        "delivery:import" => {
            let path = args
                .get(2)
                .ok_or("delivery:import requires a JSON job-export file")?;
            let rows: Vec<serde_json::Value> =
                serde_json::from_str(&std::fs::read_to_string(path)?)?;
            let config = config.clone();
            let count = tokio::task::spawn_blocking(move || {
                crate::durable_v2::import_legacy_rows(
                    &config,
                    &rows,
                    &crate::transport::RelayerHttpTransport::new(),
                )
            })
            .await?
            .map_err(std::io::Error::other)?
            .len();
            println!(
                "{}",
                serde_json::json!({"imported":count,"prior_execution":"quarantined until reconciliation"})
            );
        }
        "delivery:replay" | "delivery:resolve-legacy" => {
            let key = args
                .get(2)
                .ok_or("delivery replay requires job_key, actor and reason")?
                .clone();
            let actor = args.get(3).ok_or("delivery replay actor required")?.clone();
            let reason = args
                .get(4)
                .ok_or("delivery replay reason/evidence reference required")?
                .clone();
            let resolve = mode == "delivery:resolve-legacy";
            let config = config.clone();
            tokio::task::spawn_blocking(move || {
                let transport = crate::transport::RelayerHttpTransport::new();
                let client = crate::durable_v2::client(&config, &transport)?;
                neo_os_relayer_store::delivery::DeliveryStore { client: &client }.replay(
                    &key,
                    &actor,
                    &reason,
                    resolve,
                    now_ms() as u64,
                )
            })
            .await?
            .map_err(std::io::Error::other)?;
            println!("{}", serde_json::json!({"requeued":true}));
        }
        "health" => {
            println!(
                "{}",
                crate::relayer::runtime_health(&config).map_err(std::io::Error::other)?
            );
        }
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
        "serve:sponsor" => {
            let transport = crate::transport::RelayerHttpTransport::new();
            crate::sponsor_api::serve_configured(&config, &transport)
                .await
                .map_err(std::io::Error::other)?;
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
