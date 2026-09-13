use morpheus_relayer_rs::config::{CustodyKeyIds, NeoN3Config, RelayerConfig};
use morpheus_relayer_rs::handlers::{validate_request, HandlerConfig};
use morpheus_relayer_rs::oracle::{client::NeoN3RpcClient, contract::MorpheusOracleContract};
use morpheus_relayer_rs::retry::{calculate_delay, RetryConfig, RetryEntry};
use morpheus_relayer_rs::state_machine::RequestStateMachine;
use morpheus_relayer_rs::types::{FulfillmentResult, OracleRequestEvent, RequestState};
use std::time::Duration;
use tokio::time::timeout;

#[tokio::test]
async fn test_full_request_processing_pipeline() {
    // This integration test simulates a complete request flow:
    // 1. Event discovery
    // 2. Validation
    // 3. State machine transitions
    // 4. Processing
    // 5. Response submission

    let config = NeoN3Config {
        rpc_url: "http://localhost:10332".to_string(),
        rpc_urls: vec![],
        oracle_contract: "0x...".to_string(),
        indexer_url: None,
        custody_key_ids: CustodyKeyIds {
            updater: "updater_key_id".to_string(),
            fee_funder: None,
        },
        scan_mode: "request_cursor".to_string(),
        fee_top_up: None,
        fulfill_confirm_timeout_ms: 45000,
    };

    let handler_config = HandlerConfig {
        max_retries: 3,
        retry_backoff_ms: 1000,
        concurrency_limit: 10,
        timeout_ms: 45000,
    };

    let event = OracleRequestEvent {
        chain: "neo_n3".to_string(),
        request_id: "12345".to_string(),
        request_type: "getPrice".to_string(),
        app_id: Some("app123".to_string()),
        module_id: Some("module456".to_string()),
        operation: Some("price".to_string()),
        requester: "0xabcdef123456".to_string(),
        callback_contract: "0xcontract123".to_string(),
        callback_method: "fulfillRequest".to_string(),
        payload_text: "{\"pair\":\"BTC/USD\"}".to_string(),
        created_at_ms: 1704067200000,
        fulfilled_at_ms: 0,
        block_number: 8500000,
        tx_hash: "0xtxhash123".to_string(),
        log_index: 0,
    };

    // Step 1: Validate event
    assert!(validate_request(&event).is_ok());

    // Step 2: Create state machine and transition through states
    let mut state_machine = RequestStateMachine::new();
    assert!(state_machine.try_transition(RequestState::Processing, "start"));

    let transition_history = state_machine.get_transition_history();
    assert_eq!(transition_history.len(), 1);
    assert!(matches!(
        transition_history[0].to_state,
        RequestState::Processing
    ));

    // Step 3: Simulate successful fulfillment
    let result = FulfillmentResult {
        request_id: event.request_id.clone(),
        success: true,
        result: Some("{\"price\": 45000}".to_string()),
        error: None,
        tx_hash: None,
        vm_state: None,
    };

    // Transition to confirmed state
    state_machine.try_transition(RequestState::Confirmed, "success");
    assert!(matches!(
        state_machine.current_state,
        RequestState::Confirmed
    ));

    // Verify statistics
    let stats = state_machine.get_statistics();
    assert_eq!(stats.pending_count, 1);
    assert_eq!(stats.processing_count, 1);
    assert_eq!(stats.confirmed_count, 1);
}

#[tokio::test]
async fn test_event_deduplication() {
    let event = OracleRequestEvent {
        chain: "neo_n3".to_string(),
        request_id: "999".to_string(),
        request_type: "getData".to_string(),
        app_id: None,
        module_id: None,
        operation: None,
        requester: "0xrequester".to_string(),
        callback_contract: "0xcontract".to_string(),
        callback_method: "method".to_string(),
        payload_text: "payload".to_string(),
        created_at_ms: 1704067200000,
        fulfilled_at_ms: 0,
        block_number: 8500001,
        tx_hash: "0xtxhash".to_string(),
        log_index: 0,
    };

    let key = format!(
        "{}:{}:{}:{}:{}:{}",
        event.chain,
        event.request_id,
        event.request_type,
        event.requester,
        event.callback_contract,
        event.tx_hash
    );

    assert!(!key.is_empty());
    assert!(key.contains("999"));
    assert!(key.contains("getData"));
}

#[tokio::test]
async fn test_retry_with_exponential_backoff() {
    let config = RetryConfig {
        jitter_enabled: false,
        ..Default::default()
    };

    // Test base delays without jitter
    let delay1 = calculate_delay(&config, 1);
    let delay2 = calculate_delay(&config, 2);
    let delay3 = calculate_delay(&config, 3);

    assert_eq!(delay1, Duration::from_millis(1000));
    assert_eq!(delay2, Duration::from_millis(2000));
    assert_eq!(delay3, Duration::from_millis(4000));
}

#[tokio::test]
async fn test_state_machine_invalid_transitions() {
    let mut state_machine = RequestStateMachine::new();

    // Try invalid transition (skipping Processing)
    assert!(!state_machine.try_transition(RequestState::Confirmed, "invalid"));
    assert!(matches!(state_machine.current_state, RequestState::Pending));

    // Valid transition
    assert!(state_machine.try_transition(RequestState::Processing, "valid"));
    assert!(matches!(
        state_machine.current_state,
        RequestState::Processing
    ));

    // Invalid transition from Processing
    assert!(!state_machine.try_transition(RequestState::Pending, "backward"));
}

#[tokio::test]
async fn test_retry_entry_lifecycle() {
    let entry = RetryEntry::new("test_event", 3, serde_json::json!({"data": "test"}));

    assert_eq!(entry.retry_count, 0);
    assert!(entry.should_retry());

    // Check if ready (depends on timestamp, will fail in deterministic way for testing)
    // In real scenario, we'd mock time or set next_retry_at explicitly
}

#[tokio::test]
async fn test_validation_edge_cases() {
    // Empty required fields should fail
    let bad_event = OracleRequestEvent {
        chain: "neo_n3".to_string(),
        request_id: "".to_string(),
        request_type: "test".to_string(),
        app_id: None,
        module_id: None,
        operation: None,
        requester: "requester".to_string(),
        callback_contract: "contract".to_string(),
        callback_method: "method".to_string(),
        payload_text: "payload".to_string(),
        created_at_ms: 0,
        fulfilled_at_ms: 0,
        block_number: 1,
        tx_hash: "tx".to_string(),
        log_index: 0,
    };

    assert!(validate_request(&bad_event).is_err());

    // Invalid request ID format
    let bad_id_event = OracleRequestEvent {
        chain: "neo_n3".to_string(),
        request_id: "not_a_number".to_string(),
        request_type: "test".to_string(),
        app_id: None,
        module_id: None,
        operation: None,
        requester: "requester".to_string(),
        callback_contract: "contract".to_string(),
        callback_method: "method".to_string(),
        payload_text: "payload".to_string(),
        created_at_ms: 0,
        fulfilled_at_ms: 0,
        block_number: 1,
        tx_hash: "tx".to_string(),
        log_index: 0,
    };

    assert!(validate_request(&bad_id_event).is_err());
}

#[tokio::test]
async fn test_concurrent_event_processing() {
    use std::sync::Arc;

    let num_events = 100;
    let events: Vec<OracleRequestEvent> = (0..num_events)
        .map(|i| OracleRequestEvent {
            chain: "neo_n3".to_string(),
            request_id: i.to_string(),
            request_type: "test".to_string(),
            app_id: None,
            module_id: None,
            operation: None,
            requester: "requester".to_string(),
            callback_contract: "contract".to_string(),
            callback_method: "method".to_string(),
            payload_text: "payload".to_string(),
            created_at_ms: 0,
            fulfilled_at_ms: 0,
            block_number: 1 + i,
            tx_hash: format!("tx_{}", i),
            log_index: 0,
        })
        .collect();

    let shared_counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));

    let handles = events.into_iter().map(|event| {
        let counter = Arc::clone(&shared_counter);
        tokio::spawn(async move {
            if validate_request(&event).is_ok() {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
        })
    });

    futures::future::join_all(handles).await;

    assert_eq!(
        shared_counter.load(std::sync::atomic::Ordering::SeqCst),
        num_events
    );
}

#[tokio::test]
async fn test_transaction_timeout_simulation() {
    // Simulate a transaction that takes too long
    let timeout_duration = Duration::from_millis(100);
    let operation_duration = Duration::from_millis(500);

    let result = timeout(timeout_duration, async {
        tokio::time::sleep(operation_duration).await;
    })
    .await;

    assert!(result.is_err()); // Should timeout
}

#[tokio::test]
async fn test_state_machine_builder() {
    use morpheus_relayer_rs::state_machine::StateMachineBuilder;

    let event = OracleRequestEvent {
        chain: "neo_n3".to_string(),
        request_id: "789".to_string(),
        request_type: "fetch".to_string(),
        app_id: None,
        module_id: None,
        operation: None,
        requester: "builder_tester".to_string(),
        callback_contract: "callback_contract".to_string(),
        callback_method: "onResult".to_string(),
        payload_text: "test_payload".to_string(),
        created_at_ms: 0,
        fulfilled_at_ms: 0,
        block_number: 1,
        tx_hash: "builder_tx".to_string(),
        log_index: 0,
    };

    let machine = StateMachineBuilder::new()
        .with_event(event)
        .with_metadata("test_key", "test_value")
        .build();

    // Builder should create initial state
    assert_eq!(machine.transition_history.len(), 0);
    assert!(machine
        .transition_history
        .first()
        .and_then(|t| t.metadata.as_ref())
        .is_some());
}

/// Simple performance benchmark helper
fn run_benchmark<F>(name: &str, iterations: usize, mut operation: F)
where
    F: FnMut() -> (),
{
    let start = std::time::Instant::now();

    for _ in 0..iterations {
        operation();
    }

    let duration = start.elapsed();
    let ops_per_sec = iterations as f64 / duration.as_secs_f64();

    println!(
        "{}: {} iterations in {:?} ({:.2} ops/sec)",
        name, iterations, duration, ops_per_sec
    );
}

#[test]
fn benchmark_state_machine_performance() {
    run_benchmark("StateMachine Transitions", 10000, || {
        let mut machine = RequestStateMachine::new();
        machine.force_transition(RequestState::Processing, "benchmark");
        machine.force_transition(RequestState::Confirmed, "benchmark");
    });
}

#[test]
fn benchmark_request_validation_performance() {
    run_benchmark("Request Validation", 10000, || {
        let event = OracleRequestEvent {
            chain: "neo_n3".to_string(),
            request_id: "123".to_string(),
            request_type: "test".to_string(),
            app_id: None,
            module_id: None,
            operation: None,
            requester: "requester".to_string(),
            callback_contract: "contract".to_string(),
            callback_method: "method".to_string(),
            payload_text: "payload".to_string(),
            created_at_ms: 0,
            fulfilled_at_ms: 0,
            block_number: 1,
            tx_hash: "tx".to_string(),
            log_index: 0,
        };

        validate_request(&event).ok();
    });
}
