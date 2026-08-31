//! The keyless compute child's lifecycle — the supervisor owning the
//! `node workers/nitro-worker/src/server.js` process that
//! [`crate::bridge::LoopbackBridge`] forwards to.
//!
//! In the merged server, `/provision` wrote the provisioned env into
//! `process.env` and the in-process worker handler observed it on the next
//! read. The split's child is a separate process whose config surface is its
//! boot env (`platform/core.js`'s `env()` resolves
//! `process.env[name] || runtimeConfig[name]`, and the runtime-config JSON is
//! cached on first read), so the host SPAWNS it with the overlay's merged
//! view and RESPAWNS it whenever `/provision` applies new env — the honest
//! equivalent of the merged server's instant visibility. A restart is
//! stateless: the child holds no signing keys (the host's overlay cannot
//! contain them — plaintext key provisioning is refused and signing-key
//! materialization lives with the custody service) and carries only caches
//! (provider config TTL 30s, provider response cache 1.5s).
//!
//! The child is also supervised: a crash is logged and respawned on the 1s
//! watch cadence instead of tearing the enclave down — the merged server kept
//! serving through worker errors, and so does the split. `/provision`'s
//! respawn is best-effort for the same reason: a failed spawn is logged and
//! left to the watch loop; the provision response still reports the applied
//! keys.
//!
//! The launch command comes from the process env (the bin's config seam):
//! `ENCLAVE_BRIDGE_CHILD_CMD` (default `node`),
//! `ENCLAVE_BRIDGE_CHILD_ARGS` (whitespace-split; default
//! `/app/workers/nitro-worker/src/server.js`), the port from
//! `ENCLAVE_WORKER_PORT`; `ENCLAVE_BRIDGE_CHILD_DISABLED=1` opts out for
//! parity runs that drive the child themselves.

use std::collections::BTreeMap;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use crate::overlay::EnvOverlay;

pub struct BridgeChild {
    program: String,
    args: Vec<String>,
    port: u16,
    inner: Mutex<Option<Child>>,
    generation: AtomicU64,
}

impl BridgeChild {
    /// The explicit constructor (tests, alternate wiring).
    pub fn from_parts(program: impl Into<String>, args: Vec<String>, port: u16) -> Self {
        BridgeChild {
            program: program.into(),
            args,
            port,
            inner: Mutex::new(None),
            generation: AtomicU64::new(0),
        }
    }

    /// The bin's production constructor: `None` when disabled.
    pub fn from_env(worker_port: u16) -> Option<Self> {
        let disabled = std::env::var("ENCLAVE_BRIDGE_CHILD_DISABLED")
            .map(|value| value.trim() == "1")
            .unwrap_or(false);
        if disabled {
            return None;
        }
        let program = std::env::var("ENCLAVE_BRIDGE_CHILD_CMD")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "node".to_string());
        let args_raw = std::env::var("ENCLAVE_BRIDGE_CHILD_ARGS")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "/app/workers/nitro-worker/src/server.js".to_string());
        let args: Vec<String> = args_raw.split_whitespace().map(str::to_string).collect();
        Some(BridgeChild::from_parts(program, args, worker_port))
    }

    /// How many times a child process has been spawned — bumping on every
    /// (re)spawn, so tests and logs can tell a respawn from the original.
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    pub fn pid(&self) -> Option<u32> {
        self.inner
            .lock()
            .expect("bridge child lock")
            .as_ref()
            .map(Child::id)
    }

    /// Spawn when absent or exited; no-op while a live child runs. The watch
    /// loop's tick, and the initial start.
    pub fn ensure_running(&self, overlay: &EnvOverlay) {
        let mut slot = self.inner.lock().expect("bridge child lock");
        let exited = match slot.as_mut() {
            None => true,
            Some(child) => match child.try_wait() {
                Ok(Some(status)) => {
                    eprintln!(
                        "{}",
                        serde_json::json!({
                            "level": "warn",
                            "msg": "bridge child exited; respawning",
                            "generation": self.generation(),
                            "exit_status": status.to_string(),
                        })
                    );
                    true
                }
                Ok(None) => false,
                Err(error) => {
                    eprintln!(
                        "{}",
                        serde_json::json!({
                            "level": "warn",
                            "msg": "bridge child liveness probe failed; respawning",
                            "generation": self.generation(),
                            "error": error.to_string(),
                        })
                    );
                    true
                }
            },
        };
        if exited {
            if let Some(mut child) = slot.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            self.spawn_locked(&mut slot, overlay);
        }
    }

    /// The `/provision` write: replace the child even when healthy, so the
    /// next forward observes the freshly applied env. Best-effort — a failed
    /// spawn leaves the respawn to the watch loop.
    pub fn respawn_for_provision(&self, overlay: &EnvOverlay) {
        let mut slot = self.inner.lock().expect("bridge child lock");
        if let Some(mut child) = slot.take() {
            println!(
                "{}",
                serde_json::json!({
                    "level": "info",
                    "msg": "respawning bridge child with provisioned env",
                    "generation": self.generation(),
                    "pid": child.id(),
                })
            );
            let _ = child.kill();
            let _ = child.wait();
        }
        self.spawn_locked(&mut slot, overlay);
    }

    fn spawn_locked(&self, slot: &mut Option<Child>, overlay: &EnvOverlay) {
        let result = Command::new(&self.program)
            .args(&self.args)
            .envs(build_child_env(overlay, self.port))
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn();
        match result {
            Ok(child) => {
                self.generation.fetch_add(1, Ordering::SeqCst);
                println!(
                    "{}",
                    serde_json::json!({
                        "level": "info",
                        "msg": "bridge child spawned",
                        "generation": self.generation(),
                        "pid": child.id(),
                        "port": self.port,
                    })
                );
                *slot = Some(child);
            }
            Err(error) => {
                eprintln!(
                    "{}",
                    serde_json::json!({
                        "level": "error",
                        "msg": "bridge child spawn failed; the watch loop will retry",
                        "program": self.program,
                        "error": error.to_string(),
                    })
                );
                *slot = None;
            }
        }
    }
}

impl Drop for BridgeChild {
    fn drop(&mut self) {
        if let Some(mut child) = self.inner.get_mut().expect("bridge child lock").take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// The child's spawn env: the overlay's merged view (image ENV shadowed by
/// everything `/provision` applied — the exact env the merged server's
/// `process.env` accumulated) with the loopback listener pinned. `server.js`
/// reads `PORT || NITROCORE_PORT` and binds `NITROCORE_HOST || HOST`;
/// pinned here regardless so the child is never exposed beyond loopback.
pub fn build_child_env(overlay: &EnvOverlay, port: u16) -> BTreeMap<String, String> {
    let mut env = overlay.merged_map();
    let port = port.to_string();
    env.insert("PORT".to_string(), port.clone());
    env.insert("NITROCORE_PORT".to_string(), port);
    env.insert("NITROCORE_HOST".to_string(), "127.0.0.1".to_string());
    env.insert("HOST".to_string(), "127.0.0.1".to_string());
    env
}

#[cfg(test)]
#[path = "../tests/unit/child.rs"]
mod tests;
