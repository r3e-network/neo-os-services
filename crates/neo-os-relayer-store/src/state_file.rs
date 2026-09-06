//! Atomic state-file persistence and coalescing persistor (T03).
//!
//! Ported from `workers/morpheus-relayer/src/queue.js:createPersistor` and `state.js`.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

static TMP_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Atomically write `content` to `path` using a temporary file and rename.
///
/// Ensures crash-safety: the destination file is never partially written.
pub fn save_state_file_atomic(path: &Path, content: &str) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let pid = std::process::id();
    let counter = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);

    let tmp_file_name = format!(
        ".{}.tmp.{}.{}.{}",
        path.file_name().and_then(|s| s.to_str()).unwrap_or("state"),
        pid,
        nanos,
        counter
    );
    let tmp_path = match path.parent() {
        Some(parent) => parent.join(tmp_file_name),
        None => PathBuf::from(tmp_file_name),
    };

    let write_res = (|| {
        let mut file = File::create(&tmp_path)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        Ok(())
    })();

    if let Err(e) = write_res {
        let _ = fs::remove_file(&tmp_path);
        return Err(e);
    }

    if let Err(e) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(e);
    }

    Ok(())
}

/// Atomically write a JSON state value to `path`.
pub fn save_state_json_atomic(path: &Path, state: &Value) -> io::Result<()> {
    let json_str = serde_json::to_string_pretty(state)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    save_state_file_atomic(path, &json_str)
}

/// Load a JSON state value from `path` if it exists.
pub fn load_state_json(path: &Path) -> io::Result<Option<Value>> {
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(path)?;
    if content.trim().is_empty() {
        return Ok(None);
    }
    let value: Value = serde_json::from_str(&content)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    Ok(Some(value))
}

/// Coalescing state persistor (port of `queue.js:createPersistor`).
///
/// Prevents synchronous re-serialization and disk flush on every single event
/// during high-throughput ticks while ensuring trailing writes flush state.
pub struct RelayerStatePersistor {
    path: PathBuf,
    min_interval_ms: u64,
    last_write_at_ms: Option<u64>,
    dirty: bool,
}

impl RelayerStatePersistor {
    pub fn new(path: impl Into<PathBuf>, min_interval_ms: u64) -> Self {
        Self {
            path: path.into(),
            min_interval_ms,
            last_write_at_ms: None,
            dirty: false,
        }
    }

    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Immediate flush of the state to disk.
    pub fn flush(&mut self, state: &Value, now_ms: u64) -> io::Result<()> {
        self.dirty = false;
        self.last_write_at_ms = Some(now_ms);
        save_state_json_atomic(&self.path, state)
    }

    /// Persist with burst coalescing: flushes immediately if elapsed >= min_interval_ms,
    /// otherwise marks dirty for trailing flush.
    pub fn persist(&mut self, state: &Value, now_ms: u64) -> io::Result<bool> {
        let should_flush = match self.last_write_at_ms {
            None => true,
            Some(last) => {
                now_ms.saturating_sub(last) >= self.min_interval_ms || self.min_interval_ms == 0
            }
        };
        if should_flush {
            self.flush(state, now_ms)?;
            Ok(true)
        } else {
            self.dirty = true;
            Ok(false)
        }
    }
}
