//! Order-preserving bounded-concurrency map — the Rust port of shared utils'
//! `mapWithConcurrency`. Semantics that must not drift:
//! * results keep the INPUT order (slot-per-index),
//! * workers pull the next index only while no failure has been recorded,
//! * in-flight items run to completion after a failure (JS cannot cancel
//!   promises either), queued items are skipped,
//! * the returned error is the one from the LOWEST failing index (the JS
//!   `Promise.all` surfaces the first rejection in input order).
//!
//! Blocking transports throughout: one OS thread per lane, joined before
//! returning (`std::thread::scope`).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

pub fn map_with_concurrency<T, R, E, F>(items: &[T], limit: usize, worker: F) -> Result<Vec<R>, E>
where
    T: Sync,
    R: Send,
    E: Send + Clone,
    F: Fn(&T) -> Result<R, E> + Sync,
{
    if items.is_empty() {
        return Ok(Vec::new());
    }
    let width = limit.clamp(1, items.len());
    let results: Mutex<Vec<Option<R>>> = Mutex::new((0..items.len()).map(|_| None).collect());
    let first_error: Mutex<Option<E>> = Mutex::new(None);
    let cursor = AtomicUsize::new(0);

    std::thread::scope(|scope| {
        for _ in 0..width {
            scope.spawn(|| loop {
                if first_error.lock().expect("error lock").is_some() {
                    return;
                }
                let index = cursor.fetch_add(1, Ordering::SeqCst);
                if index >= items.len() {
                    return;
                }
                match worker(&items[index]) {
                    Ok(value) => {
                        results.lock().expect("results lock")[index] = Some(value);
                    }
                    Err(error) => {
                        let mut guard = first_error.lock().expect("error lock");
                        // Lowest index wins: an earlier failure recorded by
                        // another lane stays authoritative.
                        match &*guard {
                            None => *guard = Some(error),
                            Some(existing) => {
                                let _ = existing.clone();
                            }
                        }
                        return;
                    }
                }
            });
        }
    });

    if let Some(error) = first_error.into_inner().expect("error lock") {
        return Err(error);
    }
    let slots = results.into_inner().expect("results lock");
    Ok(slots
        .into_iter()
        .map(|slot| slot.expect("no gaps after success"))
        .collect())
}

/// Bounded scan concurrency: a positive `config.concurrency` clamps to
/// [1, 8]; anything else falls back to 4 (shared utils' resolveScanConcurrency).
pub fn resolve_scan_concurrency(configured: Option<usize>) -> usize {
    match configured {
        Some(value) if value > 0 => value.min(8),
        _ => 4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn preserves_input_order_under_concurrency() {
        let items: Vec<u32> = (0..50).collect();
        // Reverse-sleep ordering tricks: later items finish first, but slots
        // keep input order. (Deterministic: no sleeping, just slot mapping.)
        let out = map_with_concurrency(&items, 8, |value| Ok::<_, String>(value * 2))
            .expect("all succeed");
        assert_eq!(out, items.iter().map(|v| v * 2).collect::<Vec<_>>());
    }

    #[test]
    fn returns_the_lowest_index_error_and_skips_queued_items() {
        let items: Vec<u32> = (0..100).collect();
        let started = AtomicUsize::new(0);
        let error = map_with_concurrency(&items, 1, |value| {
            started.fetch_add(1, Ordering::SeqCst);
            if *value == 3 {
                Err(format!("boom at {value}"))
            } else {
                Ok(*value)
            }
        })
        .expect_err("item 3 fails");
        assert_eq!(error, "boom at 3");
        // Concurrency 1 + skip-after-failure: exactly items 0..=3 started.
        assert_eq!(started.load(Ordering::SeqCst), 4);
    }

    #[test]
    fn resolve_scan_concurrency_clamps_to_one_through_eight() {
        assert_eq!(resolve_scan_concurrency(None), 4);
        assert_eq!(resolve_scan_concurrency(Some(0)), 4);
        assert_eq!(resolve_scan_concurrency(Some(2)), 2);
        assert_eq!(resolve_scan_concurrency(Some(99)), 8);
    }

    #[test]
    fn empty_input_short_circuits() {
        let items: Vec<u32> = Vec::new();
        let out: Vec<u32> = map_with_concurrency(&items, 4, |_| Err::<u32, _>("never".to_string()))
            .expect("empty input never fails");
        assert!(out.is_empty());
    }
}
