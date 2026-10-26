//! Lifecycle fakes only: no socket, KMS, issuer, database, vault or signature.
use super::*;
use std::future::pending;

#[tokio::test]
async fn a_lane_exit_drains_siblings_before_frontier_closes() {
    let control=Controller::new();
    let events=Arc::new(Mutex::new(Vec::new()));
    let mut tasks=JoinSet::new();
    tasks.spawn(async { Err("synthetic lane failure".to_string()) });
    let sibling=control.clone();let e=events.clone();
    tasks.spawn(async move { sibling.stop_reason().await;e.lock().unwrap().push("relayer drained");Ok(()) });
    let frontier=control.clone();let e=events.clone();
    let server=async move {frontier.frontier_shutdown().await;e.lock().unwrap().push("frontier closed");Ok(())};
    assert!(supervise(tasks,control.clone(),server,pending()).await.is_err());
    assert_eq!(*events.lock().unwrap(),vec!["relayer drained","frontier closed"]);
    assert_eq!(control.phase.load(Ordering::SeqCst),CLOSED);
}

#[tokio::test]
async fn graceful_shutdown_is_joined_and_keeps_dependencies_until_drain() {
    let control=Controller::new();let mut tasks=JoinSet::new();
    let c=control.clone();let (release,wait)=tokio::sync::oneshot::channel();
    tasks.spawn(async move {c.stop_reason().await;wait.await.unwrap();Ok(())});
    let server_control=control.clone();
    let server=async move {server_control.frontier_shutdown().await;Ok(())};
    let joined=tokio::spawn(supervise(tasks,control.clone(),server,async {ShutdownReason::Terminate}));
    tokio::task::yield_now().await;
    assert_eq!(control.phase.load(Ordering::SeqCst),DRAINING);
    assert!(!*control.frontier_closed.borrow());
    assert!(!joined.is_finished());
    release.send(()).unwrap();
    assert!(joined.await.unwrap().is_ok());
    assert!(*control.frontier_closed.borrow());
}

#[test]
fn gate_defaults_off_and_unknown_values_do_not_enable_it() {
    assert!(!crate::relayer_auth::enabled(&EnvOverlay::default()).unwrap());
    assert!(crate::relayer_auth::enabled(&EnvOverlay::new([(crate::relayer_auth::GATE,"yes")])).is_err());
}
