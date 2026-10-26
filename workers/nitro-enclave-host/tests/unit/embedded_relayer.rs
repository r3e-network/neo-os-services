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

#[path="support.rs"]
#[allow(clippy::duplicate_mod)]
mod support;

#[test]
fn health_aliases_share_real_dispatch_identity_and_readiness_merge() {
    let harness=support::test_state(&support::healthy_overlay(),support::FakeAttest::with_document(b"doc"),
        support::FakeSigner::healthy(),support::FakeBridge::new(),support::FakeKms::default());
    let headers=http::HeaderMap::new();
    let control=Controller::new();
    for draining in [false,true] {
        if draining {control.begin_draining(ShutdownReason::Terminate);}
        for path in ["/health","/health/","/health/?probe=1","/mainnet/health/"] {
            let base=crate::dispatch::dispatch(&harness.state,"GET",path,&headers,"");
            assert_eq!(base.status,200,"healthy signing stub: {path}");
            let merged=merge_health_outcome("GET",path,&headers,base,&control);
            assert_eq!(merged.status,503,"{path}");
            assert_eq!(merged.body["ready"],false);
            assert_eq!(merged.body["embedded_relayer"]["healthy"],false);
        }
    }
    for (method,path) in [("HEAD","/health/"),("POST","/health"),("GET","/health//")] {
        let base=crate::dispatch::dispatch(&harness.state,method,path,&headers,"");
        let status=base.status;
        let merged=merge_health_outcome(method,path,&headers,base,&control);
        assert_eq!(merged.status,status);
        assert!(merged.body.get("embedded_relayer").is_none());
    }
}

#[test]
fn scoped_chosen_rpc_reaches_actual_each_network_config_without_generic_fallback() {
    for network in ["mainnet","testnet"] {
        let chosen=format!("https://chosen-{network}.example.invalid");
        let env=BTreeMap::from([
            ("NODE_ENV".into(),"test".into()),
            ("MORPHEUS_NETWORK".into(),network.into()),
            (format!("NEO_RPC_URLS_{}",network.to_ascii_uppercase()),chosen.clone()),
        ]);
        let config=neo_os_relayer::create_relayer_config_from_env(&env).unwrap();
        assert_eq!(config.network,network);
        assert!(config.raw["neo_n3"]["rpcUrls"].as_array().unwrap().iter().any(|v|v.as_str()==Some(chosen.as_str())));
        let other=if network=="mainnet"{"testnet"}else{"mainnet"};
        assert!(!config.raw["neo_n3"]["rpcUrls"].to_string().contains(&format!("chosen-{other}")));
    }
}

#[tokio::test]
async fn nested_chain_exit_notifies_outer_while_local_sibling_is_held() {
    struct Notify(Controller);
    impl RuntimeContext for Notify {
        fn notify_stopping(&self,reason:ShutdownReason) {self.0.begin_draining(reason);}
        fn refresh_config(&self,base:&RelayerConfig)->Result<RelayerConfig,String> {Ok(base.clone())}
        fn local_request(&self,_:&str,_:&str,_:Option<&str>,_:Option<&str>)->Option<Result<(u16,String),String>> {None}
    }
    struct Dependency(Arc<std::sync::atomic::AtomicBool>);
    impl Drop for Dependency {fn drop(&mut self){self.0.store(true,Ordering::SeqCst);}}
    let temp=tempfile::tempdir().unwrap();
    let cfg=RelayerConfig {
        repo_root:String::new(),instance_id:"nested-mainnet".into(),
        state_file:temp.path().join("state.json").to_string_lossy().into_owned(),network:"mainnet".into(),node_env:"test".into(),
        mode:"combined".into(),active_chains:vec!["neo_n3".into(),"neox".into()],poll_interval_ms:250,
        concurrency:1,max_blocks_per_tick:1,discovery_idle_backoff_ms:1,state_persist_min_interval_ms:1,
        raw:json!({"deliveryProtocol":"v2","heartbeats":{}}),
    };
    let control=Controller::new();
    let (stop,mut local_stop)=watch::channel(None);
    let mut inner=JoinSet::new();inner.spawn(async {Err("mainnet N3 terminated".to_string())});
    let (entered,held_started)=tokio::sync::oneshot::channel();
    let (release,held)=tokio::sync::oneshot::channel();
    inner.spawn(async move {
        local_stop.changed().await.unwrap();entered.send(()).unwrap();held.await.unwrap();Ok(())
    });
    let mut outer=JoinSet::new();let c=control.clone();
    outer.spawn(async move {
        let runtime=neo_os_relayer::transport::LoopRuntime{context:Some(Arc::new(Notify(c.clone()))),strict_drain:true};
        neo_os_relayer::relayer::supervise_chain_tasks_with_runtime(&cfg,&[],inner,stop,runtime,c.stop_reason()).await
    });
    let c=control.clone();let (stopped,testnet_stopped)=tokio::sync::oneshot::channel();
    outer.spawn(async move {c.stop_reason().await;stopped.send(()).unwrap();Ok(())});
    let dropped=Arc::new(std::sync::atomic::AtomicBool::new(false));let dependency=Dependency(dropped.clone());
    let c=control.clone();let server=async move {c.frontier_shutdown().await;drop(dependency);Ok(())};
    let joined=tokio::spawn(supervise(outer,control.clone(),server,pending()));
    tokio::time::timeout(Duration::from_secs(5),held_started).await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(5),testnet_stopped).await.unwrap().unwrap();
    assert!(control.is_draining());assert_eq!(control.health()["healthy"],false);
    assert!(!*control.frontier_closed.borrow());assert!(!dropped.load(Ordering::SeqCst));assert!(!joined.is_finished());
    release.send(()).unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(5),joined).await.unwrap().unwrap().is_err());
    assert!(dropped.load(Ordering::SeqCst));assert_eq!(control.phase.load(Ordering::SeqCst),CLOSED);
}
