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

#[tokio::test]
async fn panicking_lane_still_stops_and_joins_the_other_network() {
    let control = Controller::new();
    let events = Arc::new(Mutex::new(Vec::new()));
    let mut tasks = JoinSet::new();
    tasks.spawn(async { panic!("synthetic lane panic"); #[allow(unreachable_code)] Ok(()) });
    let c = control.clone(); let e = events.clone();
    tasks.spawn(async move { c.stop_reason().await; e.lock().unwrap().push("sibling drained"); Ok(()) });
    let c = control.clone(); let e = events.clone();
    let server = async move { c.frontier_shutdown().await; e.lock().unwrap().push("frontier closed"); Ok(()) };
    assert!(tokio::time::timeout(Duration::from_secs(5),
        supervise(tasks, control.clone(), server, pending())).await.unwrap().is_err());
    assert_eq!(*events.lock().unwrap(), vec!["sibling drained", "frontier closed"]);
    assert_eq!(control.phase.load(Ordering::SeqCst), CLOSED);
}

#[tokio::test]
async fn server_failure_stops_and_joins_both_network_lanes() {
    let control = Controller::new();
    let events = Arc::new(Mutex::new(Vec::new()));
    let mut tasks = JoinSet::new();
    for network in ["mainnet", "testnet"] {
        let c = control.clone(); let e = events.clone();
        tasks.spawn(async move { c.stop_reason().await; e.lock().unwrap().push(network); Ok(()) });
    }
    let result = tokio::time::timeout(Duration::from_secs(5), supervise(tasks, control.clone(),
        async { Err("synthetic frontier exit".into()) }, pending())).await.unwrap();
    assert!(result.is_err());
    let mut drained = events.lock().unwrap().clone(); drained.sort_unstable();
    assert_eq!(drained, vec!["mainnet", "testnet"]);
    assert!(*control.frontier_closed.borrow());
    assert_eq!(control.phase.load(Ordering::SeqCst), CLOSED);
}

#[tokio::test]
async fn stalled_top_level_drain_keeps_frontier_dependency_alive_and_unhealthy() {
    struct Dependency(Arc<std::sync::atomic::AtomicBool>);
    impl Drop for Dependency {
        fn drop(&mut self) { self.0.store(true, Ordering::SeqCst); }
    }
    let control = Controller::new();
    let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let dependency = Dependency(dropped.clone());
    let mut tasks = JoinSet::new();
    tasks.spawn(async { Err("synthetic network exit".to_string()) });
    let c = control.clone();
    let (entered, observed) = tokio::sync::oneshot::channel();
    let (release, held) = tokio::sync::oneshot::channel();
    tasks.spawn(async move {
        c.stop_reason().await; entered.send(()).unwrap(); held.await.unwrap(); Ok(())
    });
    let c = control.clone();
    let server = async move { c.frontier_shutdown().await; drop(dependency); Ok(()) };
    let joined = tokio::spawn(supervise(tasks, control.clone(), server, pending()));
    tokio::time::timeout(Duration::from_secs(5), observed).await.unwrap().unwrap();
    assert!(control.is_draining());
    assert_eq!(control.health()["healthy"], false);
    assert!(!*control.frontier_closed.borrow());
    assert!(!dropped.load(Ordering::SeqCst));
    assert!(!joined.is_finished());
    release.send(()).unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(5), joined).await.unwrap().unwrap().is_err());
    assert!(dropped.load(Ordering::SeqCst));
}

#[test]
fn awaiting_provision_controller_is_unhealthy_and_exposes_no_auth_material() {
    let control = Controller::new();
    let health = control.health();
    assert_eq!(health["phase"], "awaiting-provision");
    assert_eq!(health["healthy"], false);
    for network in ["mainnet", "testnet"] {
        assert_eq!(health["networks"][network]["healthy"], false);
    }
    for field in ["jwt", "bearer", "storeAuth", "runtime_token", "custodyToken"] {
        assert!(!health.to_string().contains(field));
    }
}
