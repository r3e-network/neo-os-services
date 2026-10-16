use super::*;
use serde_json::json;

#[path = "support.rs"]
#[allow(clippy::duplicate_mod)]
mod support;
use support::*;

struct FeedFiles(PathBuf);

impl FeedFiles {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "neoos-feed-isolation-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).expect("unique fixture directory");
        Self(root)
    }

    fn base(&self) -> PathBuf {
        self.0.join("state.json")
    }

    fn harness(&self, network: &str) -> TestState {
        self.harness_at(&self.base(), network)
    }

    fn harness_at(&self, base: &Path, network: &str) -> TestState {
        let h = test_state(
            &[
                ("MORPHEUS_NETWORK", network),
                ("MORPHEUS_FEED_STATE_PATH", base.to_str().unwrap()),
            ],
            FakeAttest::with_document(b"doc"),
            FakeSigner::healthy(),
            FakeBridge::new(),
            FakeKms::default(),
        );
        h.oracle_io.set_now_ms(1_700_000_001_000);
        h.oracle_io
            .set_reply(Ok(json_reply(r#"{"price":"12.5","timestamp":1700000000}"#)));
        h
    }

    fn scoped(&self, network: &str) -> PathBuf {
        scoped_feed_state_path(&self.base(), network, "neo_n3")
    }
}

impl Drop for FeedFiles {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn feed_request() -> Json {
    json!({"symbols":["NEO-USD"], "providers":["binance-spot"], "wait":true})
}

#[test]
fn feed_refuses_unbound_legacy_history_on_both_networks() {
    let files = FeedFiles::new();
    let original = r#"{"records":{"foreign-history":{"price":"100"}}}"#;
    std::fs::write(files.base(), original).unwrap();
    for network in ["mainnet", "testnet"] {
        let h = files.harness(network);
        let error = handle_oracle_feed(&h.state, &feed_request())
            .expect_err("unscoped history needs explicit provenance before migration");
        assert_eq!(error.status, 503);
        assert!(h.oracle_io.fetches().is_empty());
        assert!(h.signer.sign_calls().is_empty());
        assert!(!files.scoped(network).exists());
    }
    assert_eq!(std::fs::read_to_string(files.base()).unwrap(), original);
}

#[test]
fn feed_migrates_only_explicitly_bound_history_and_reads_it_after_restart() {
    let files = FeedFiles::new();
    let original = json!({"scope":{"network":"mainnet","target_chain":"neo_n3"},
        "records":{"mainnet-marker":{"price":"100"}}})
    .to_string();
    std::fs::write(files.base(), &original).unwrap();
    let main = files.harness("mainnet");
    let result = handle_oracle_feed(&main.state, &feed_request()).unwrap();
    assert_eq!(result.body["state_persisted"], true);
    let disk: Json =
        serde_json::from_slice(&std::fs::read(files.scoped("mainnet")).unwrap()).unwrap();
    assert_eq!(disk["scope"]["network"], "mainnet");
    assert_eq!(disk["records"]["mainnet-marker"]["price"], "100");
    let test = files.harness("testnet");
    assert_eq!(
        handle_oracle_feed(&test.state, &feed_request())
            .expect_err("foreign legacy history")
            .status,
        503
    );
    assert!(test.oracle_io.fetches().is_empty());
    assert!(!files.scoped("testnet").exists());
    let mut disk = disk;
    disk["records"]["restart-marker"] = json!({"price":"200"});
    std::fs::write(files.scoped("mainnet"), disk.to_string()).unwrap();
    let restarted = files.harness("mainnet");
    assert_eq!(
        handle_oracle_feed(&restarted.state, &feed_request())
            .unwrap()
            .body["state_persisted"],
        true
    );
    let disk: Json =
        serde_json::from_slice(&std::fs::read(files.scoped("mainnet")).unwrap()).unwrap();
    assert_eq!(disk["records"]["restart-marker"]["price"], "200");
    assert_eq!(std::fs::read_to_string(files.base()).unwrap(), original);
}

#[test]
fn feed_does_not_reset_or_fallback_when_scoped_state_is_invalid() {
    for raw in [
        "{",
        "[]",
        "{\"records\":[]}",
        "{\"scope\":{\"network\":\"mainnet\",\"target_chain\":\"neo_n3\"},\"records\":{}}",
    ] {
        let files = FeedFiles::new();
        std::fs::write(files.scoped("testnet"), raw).unwrap();
        std::fs::write(files.base(), r#"{"records":{}}"#).unwrap();
        let h = files.harness("testnet");
        assert_eq!(
            handle_oracle_feed(&h.state, &feed_request())
                .expect_err("invalid scoped state is not empty history")
                .status,
            503
        );
        assert!(h.oracle_io.fetches().is_empty());
        assert_eq!(
            std::fs::read_to_string(files.scoped("testnet")).unwrap(),
            raw
        );
    }
}

#[test]
fn feed_refuses_foreign_context_before_fetch_or_state_write() {
    for alias in [
        "network",
        "morpheus_network",
        "runtime_network",
        "environment",
    ] {
        let files = FeedFiles::new();
        let h = files.harness("testnet");
        let mut payload = feed_request();
        payload[alias] = json!("mainnet");
        assert_eq!(
            handle_oracle_feed(&h.state, &payload)
                .expect_err("foreign context")
                .status,
            400
        );
        assert!(h.oracle_io.fetches().is_empty());
        assert!(h.signer.sign_calls().is_empty());
        assert!(!files.scoped("testnet").exists());
        assert!(!files.scoped("mainnet").exists());
    }
}

struct PausedOracle {
    inner: FakeOracleIo,
    entered: std::sync::mpsc::Sender<()>,
    release: Mutex<std::sync::mpsc::Receiver<()>>,
}

impl crate::state::OracleIo for PausedOracle {
    fn fetch(
        &self,
        request: &neo_os_compute::transport::HttpRequest,
    ) -> Result<neo_os_compute::transport::HttpResponse, String> {
        self.entered.send(()).map_err(|e| e.to_string())?;
        self.release
            .lock()
            .unwrap()
            .recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        crate::state::OracleIo::fetch(&self.inner, request)
    }
    fn dns_lookup(&self, host: &str) -> Result<Vec<neo_os_compute::ssrf::ResolvedAddress>, String> {
        crate::state::OracleIo::dns_lookup(&self.inner, host)
    }
    fn now_ms(&self) -> u64 {
        crate::state::OracleIo::now_ms(&self.inner)
    }
    fn sleep_ms(&self, _ms: u64) {}
}

fn feed_overlap(same_scope: bool) {
    feed_overlap_at(same_scope, false);
}

fn feed_overlap_at(same_scope: bool, directory_alias: bool) {
    use std::sync::mpsc::channel;
    use std::time::Duration;
    let files = FeedFiles::new();
    let mut first = files.harness("mainnet");
    let second_base = if directory_alias {
        let alias = files.0.join("directory-alias");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&files.0, &alias).unwrap();
        alias.join("state.json")
    } else {
        files.base()
    };
    let second = files.harness_at(&second_base, if same_scope { "mainnet" } else { "testnet" });
    let (entered_tx, entered_rx) = channel();
    let (release_tx, release_rx) = channel();
    first.state.oracle_io = Box::new(PausedOracle {
        inner: first.oracle_io.clone(),
        entered: entered_tx,
        release: Mutex::new(release_rx),
    });
    let first_thread =
        std::thread::spawn(move || handle_oracle_feed(&first.state, &feed_request()));
    let first_started = entered_rx.recv_timeout(Duration::from_secs(2)).is_ok();
    let (done_tx, done_rx) = channel();
    let (started_tx, started_rx) = channel();
    let second_thread = std::thread::spawn(move || {
        started_tx.send(()).unwrap();
        let result = handle_oracle_feed(
            &second.state,
            &json!({
                "symbols":["GAS-USD"], "providers":["binance-spot"], "wait":true
            }),
        );
        done_tx.send(()).unwrap();
        result
    });
    let second_started = started_rx.recv_timeout(Duration::from_secs(2)).is_ok();
    let overlapped = done_rx.recv_timeout(Duration::from_millis(600)).is_ok();
    let _ = release_tx.send(());
    let first_result = first_thread.join().expect("first thread");
    let second_result = second_thread.join().expect("second thread");
    assert!(first_started, "first provider must be in-flight");
    assert!(
        second_started,
        "second thread must enter before the overlap check"
    );
    for result in [first_result.unwrap(), second_result.unwrap()] {
        assert_eq!(result.body["state_persisted"], true);
        assert_eq!(result.body["batch_submitted"], false);
    }
    assert_eq!(
        overlapped, !same_scope,
        "only the same scoped state file should serialize"
    );
    let first_disk: Json =
        serde_json::from_slice(&std::fs::read(files.scoped("mainnet")).unwrap()).unwrap();
    let second_disk: Json = serde_json::from_slice(
        &std::fs::read(files.scoped(if same_scope { "mainnet" } else { "testnet" })).unwrap(),
    )
    .unwrap();
    assert!(first_disk["records"].get("BINANCE-SPOT:NEO-USD").is_some());
    assert!(second_disk["records"].get("BINANCE-SPOT:GAS-USD").is_some());
    if same_scope {
        assert_eq!(first_disk, second_disk);
    }
}

#[test]
fn feed_slow_mainnet_does_not_block_testnet() {
    feed_overlap(false);
}

#[test]
fn feed_same_file_remains_serialized_across_context_instances() {
    feed_overlap(true);
}

#[test]
#[cfg(unix)]
fn feed_directory_alias_preserves_both_concurrent_records() {
    feed_overlap_at(true, true);
}

#[test]
fn feed_case_aliases_share_lock_before_and_after_creation() {
    let files = FeedFiles::new();
    let lower = files.scoped("mainnet");
    let upper = files.0.join("STATE.mainnet.neo_n3.JSON");
    let first = feed_file_lock(&lower).unwrap();
    let other = feed_file_lock(&upper).unwrap();
    assert!(
        Arc::ptr_eq(&first, &other),
        "case aliases must serialize even before creation"
    );
    std::fs::write(&lower, r#"{"records":{}}"#).unwrap();
    assert!(Arc::ptr_eq(&first, &feed_file_lock(&upper).unwrap()));
    save_feed_state(&lower, &json!({"records":{}})).unwrap();
    assert!(
        Arc::ptr_eq(&first, &feed_file_lock(&upper).unwrap()),
        "atomic replacement must not change lock identity"
    );
}

#[test]
#[cfg(unix)]
fn feed_refuses_leaf_aliases_before_import_and_preserves_originals() {
    for alias_kind in ["symlink", "hardlink", "broken-symlink", "legacy-symlink"] {
        let files = FeedFiles::new();
        let source = files.scoped("mainnet");
        let original = r#"{"records":{"mainnet-only-history":{}}}"#;
        std::fs::write(&source, original).unwrap();
        let alias = if alias_kind == "legacy-symlink" {
            files.base()
        } else {
            files.scoped("testnet")
        };
        match alias_kind {
            "hardlink" => std::fs::hard_link(&source, &alias).unwrap(),
            "broken-symlink" => {
                std::os::unix::fs::symlink(files.0.join("missing"), &alias).unwrap()
            }
            _ => std::os::unix::fs::symlink(&source, &alias).unwrap(),
        }
        let h = files.harness("testnet");
        let result = handle_oracle_feed(&h.state, &feed_request());
        assert!(
            result.is_err(),
            "{alias_kind} must be refused, got {result:?}"
        );
        assert_eq!(result.unwrap_err().status, 503);
        assert!(h.oracle_io.fetches().is_empty());
        assert!(h.signer.sign_calls().is_empty());
        assert_eq!(std::fs::read_to_string(&source).unwrap(), original);
        if alias_kind != "hardlink" {
            assert!(std::fs::symlink_metadata(&alias)
                .unwrap()
                .file_type()
                .is_symlink());
        }
    }
}

#[test]
fn feed_refuses_ambiguous_non_ascii_filename_before_fetch() {
    let files = FeedFiles::new();
    let h = files.harness_at(&files.0.join("état.json"), "mainnet");
    assert_eq!(
        handle_oracle_feed(&h.state, &feed_request())
            .unwrap_err()
            .status,
        503
    );
    assert!(h.oracle_io.fetches().is_empty());
}

#[test]
fn feed_refuses_scalar_records_without_resetting_history() {
    for value in [
        json!("corrupt"),
        json!(null),
        json!(42),
        json!([]),
        json!(false),
    ] {
        let files = FeedFiles::new();
        let original = json!({"records":{"BINANCE-SPOT:NEO-USD":value}}).to_string();
        std::fs::write(files.scoped("mainnet"), &original).unwrap();
        let h = files.harness("mainnet");
        assert_eq!(
            handle_oracle_feed(&h.state, &feed_request())
                .unwrap_err()
                .status,
            503
        );
        assert!(h.oracle_io.fetches().is_empty());
        assert!(h.signer.sign_calls().is_empty());
        assert_eq!(
            std::fs::read_to_string(files.scoped("mainnet")).unwrap(),
            original
        );
    }
}

#[test]
fn feed_temp_collision_preserves_unowned_file_and_baseline() {
    let files = FeedFiles::new();
    let path = files.scoped("mainnet");
    let temp = files.0.join("preexisting.tmp");
    let original = r#"{"records":{"old-marker":{}}}"#;
    std::fs::write(&path, original).unwrap();
    std::fs::write(&temp, "not owned by this save").unwrap();
    assert!(write_feed_state(&path, &temp, &files.0, r#"{"records":{}}"#).is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    assert_eq!(
        std::fs::read_to_string(&temp).unwrap(),
        "not owned by this save"
    );
}

#[test]
fn feed_failed_rename_removes_only_its_owned_temporary_file() {
    let files = FeedFiles::new();
    let temp = files.0.join("owned.tmp");
    // Parent of destination is missing, after exclusive temp creation.
    let destination = files.0.join("missing/state.json");
    assert!(write_feed_state(&destination, &temp, &files.0, "{}").is_err());
    assert!(!temp.exists());
    assert!(!destination.exists());
}

struct ObstructStateWrite {
    inner: FakeOracleIo,
    path: PathBuf,
}

impl crate::state::OracleIo for ObstructStateWrite {
    fn fetch(
        &self,
        request: &neo_os_compute::transport::HttpRequest,
    ) -> Result<neo_os_compute::transport::HttpResponse, String> {
        // Inject a real rename failure after the baseline has been loaded.
        std::fs::create_dir_all(&self.path).unwrap();
        std::fs::write(self.path.join("preserve"), b"unrelated state").unwrap();
        crate::state::OracleIo::fetch(&self.inner, request)
    }
    fn dns_lookup(&self, host: &str) -> Result<Vec<neo_os_compute::ssrf::ResolvedAddress>, String> {
        crate::state::OracleIo::dns_lookup(&self.inner, host)
    }
    fn now_ms(&self) -> u64 {
        crate::state::OracleIo::now_ms(&self.inner)
    }
    fn sleep_ms(&self, _ms: u64) {}
}

#[test]
fn feed_write_failure_is_local_and_never_creates_an_authoritative_cache() {
    let files = FeedFiles::new();
    let mut main = files.harness("mainnet");
    main.state.oracle_io = Box::new(ObstructStateWrite {
        inner: main.oracle_io.clone(),
        path: files.scoped("mainnet"),
    });
    let failed = handle_oracle_feed(&main.state, &feed_request()).unwrap();
    assert_eq!(failed.body["state_persisted"], false);
    assert_eq!(failed.body["state_write_failures_total"], 1);
    assert_eq!(
        std::fs::read(files.scoped("mainnet").join("preserve")).unwrap(),
        b"unrelated state"
    );
    let next = files.harness("testnet");
    let healthy = handle_oracle_feed(&next.state, &feed_request()).unwrap();
    assert_eq!(healthy.body["state_persisted"], true);
    assert_eq!(healthy.body["state_write_failures_total"], 0);
    // A fresh context must see the unreadable disk state, not a successful
    // in-memory copy cached before the failed rename.
    let restarted = files.harness("mainnet");
    assert_eq!(
        handle_oracle_feed(&restarted.state, &feed_request())
            .expect_err("failed write is not a committed baseline")
            .status,
        503
    );
    assert!(restarted.oracle_io.fetches().is_empty());
    assert!(std::fs::read_dir(&files.0).unwrap().all(|entry| !entry
        .unwrap()
        .path()
        .to_string_lossy()
        .ends_with(".tmp")));
}

#[test]
fn feed_accepts_existing_scoped_history_without_importing_foreign_legacy() {
    let files = FeedFiles::new();
    std::fs::write(
        files.scoped("testnet"),
        r#"{"records":{"scoped-marker":{"price":"1"}}}"#,
    )
    .unwrap();
    std::fs::write(files.base(), r#"{"records":{"foreign-marker":{}}}"#).unwrap();
    let test = files.harness("testnet");
    assert_eq!(
        handle_oracle_feed(&test.state, &feed_request())
            .unwrap()
            .body["state_persisted"],
        true
    );
    let disk: Json =
        serde_json::from_slice(&std::fs::read(files.scoped("testnet")).unwrap()).unwrap();
    assert_eq!(
        disk["scope"],
        json!({"network":"testnet","target_chain":"neo_n3"})
    );
    assert_eq!(disk["records"]["scoped-marker"]["price"], "1");
    assert!(disk["records"].get("foreign-marker").is_none());
}

fn json_reply(body: &str) -> neo_os_compute::transport::HttpResponse {
    neo_os_compute::transport::HttpResponse {
        status: 200,
        headers: vec![("content-type".to_string(), "application/json".to_string())],
        body: body.as_bytes().to_vec(),
    }
}

#[test]
fn explicit_unknown_network_fails_before_feed_fetch_or_signing() {
    let harness = test_state(
        &[
            ("MORPHEUS_NETWORK", TEST_NETWORK),
            ("NITRO_API_TOKEN", "s3cret"),
        ],
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );

    let error = handle_oracle_feed(
        &harness.state,
        &json!({ "network": "staging", "symbols": ["NEO-USD"], "wait": true }),
    )
    .expect_err("unknown network must fail closed");
    assert_eq!(error.status, 400);
    assert!(error.message.contains("unsupported Neo network"));
    assert!(harness.oracle_io.fetches().is_empty());
    assert!(harness.signer.sign_calls().is_empty());
}

#[test]
fn fetches_aggregates_signs_and_persists_but_fails_when_updates_cannot_be_submitted() {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let base_path = std::env::temp_dir().join(format!(
        "neo-os-host-feed-{}-{nonce}.json",
        std::process::id()
    ));
    let base_text = base_path.to_string_lossy().to_string();
    let overlay = [
        ("MORPHEUS_NETWORK", TEST_NETWORK),
        ("NITRO_API_TOKEN", "s3cret"),
        ("TWELVEDATA_API_KEY", "test-key"),
        ("MORPHEUS_FEED_STATE_PATH", base_text.as_str()),
    ];
    let harness = test_state(
        &overlay,
        FakeAttest::with_document(b"doc"),
        FakeSigner::healthy(),
        FakeBridge::new(),
        FakeKms::default(),
    );
    harness.oracle_io.set_now_ms(1_700_000_001_000);
    harness
        .oracle_io
        .set_reply(Ok(json_reply(r#"{"price":"12.5","timestamp":1700000000}"#)));

    let payload = json!({
        "symbols": ["NEO-USD"],
        "providers": ["twelvedata", "binance-spot"],
        "wait": true,
    });
    let outcome = handle_oracle_feed(&harness.state, &payload).expect("feed run");
    assert_eq!(outcome.status, 503, "{}", outcome.body);
    assert_eq!(outcome.body["mode"], "pricefeed");
    assert_eq!(outcome.body["batch_submitted"], false);
    assert_eq!(outcome.body["batch_count"], 2);
    assert_eq!(outcome.body["submission_required"], false);
    assert!(outcome.body["error"]
        .as_str()
        .expect("submission error")
        .contains("owned by the Rust relayer"));
    assert_eq!(outcome.body["state_persisted"], true);
    assert!(outcome.body["aggregations"]["NEO-USD"].is_object());
    assert!(outcome.body["sync_results"]
        .as_array()
        .expect("sync results")
        .iter()
        .filter(|entry| entry["provider"] != "aggregate")
        .all(|entry| {
            entry["relay_status"] == "skipped" && entry["skip_reason"] == "submission_unavailable"
        }));
    assert!(outcome.body["errors"]
        .to_string()
        .contains("submission transport is not configured"));

    // Each provider performs a real signed oracle read and then receives the
    // canonical quote signature. No child bridge or placeholder path runs.
    assert_eq!(harness.oracle_io.fetches().len(), 2);
    assert_eq!(harness.signer.sign_calls().len(), 4);
    assert!(harness.bridge.forwards().is_empty());

    let scoped = scoped_feed_state_path(&base_path, TEST_NETWORK, "neo_n3");
    let persisted: Json =
        serde_json::from_str(&std::fs::read_to_string(&scoped).expect("scoped state persisted"))
            .expect("state json");
    for key in ["TWELVEDATA:NEO-USD", "BINANCE-SPOT:NEO-USD", "AGG:NEO-USD"] {
        assert!(persisted["records"][key].is_object(), "missing {key}");
    }
    assert!(persisted["records"]["TWELVEDATA:NEO-USD"]
        .get("price")
        .is_none());
    assert_eq!(
        persisted["records"]["TWELVEDATA:NEO-USD"]["last_observed_price"],
        "12.5"
    );

    let fast = handle_oracle_feed(
        &harness.state,
        &json!({ "symbol": "NEO-USD", "fast_ack": true }),
    )
    .expect("structured refusal");
    assert_eq!(fast.status, 409);
    assert_eq!(fast.body["accepted"], false);

    let _ = std::fs::remove_file(scoped);
    let _ = std::fs::remove_file(base_path);
}
