//! Small, policy-free lifecycle primitives shared by the long-running Rust
//! services. Business logic, key custody and route contracts deliberately do
//! not live here; those boundaries must remain independently testable.

use std::fmt;

/// The operating-system event that asked a service to drain and stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShutdownReason {
    Interrupt,
    Terminate,
    SignalHandlerUnavailable,
}

impl fmt::Display for ShutdownReason {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            ShutdownReason::Interrupt => "interrupted",
            ShutdownReason::Terminate => "terminating",
            ShutdownReason::SignalHandlerUnavailable => "signal handler unavailable",
        })
    }
}

/// Wait for the platform's normal shutdown signal. Callers own logging and
/// draining semantics so a custody process can keep its no-access-log rule
/// while an observable service can use structured tracing.
pub async fn shutdown_signal() -> ShutdownReason {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut terminate = match signal(SignalKind::terminate()) {
            Ok(signal) => signal,
            Err(_) => return ShutdownReason::SignalHandlerUnavailable,
        };
        return tokio::select! {
            result = tokio::signal::ctrl_c() => {
                if result.is_ok() {
                    ShutdownReason::Interrupt
                } else {
                    ShutdownReason::SignalHandlerUnavailable
                }
            }
            _ = terminate.recv() => ShutdownReason::Terminate,
        };
    }

    #[cfg(not(unix))]
    {
        if tokio::signal::ctrl_c().await.is_ok() {
            ShutdownReason::Interrupt
        } else {
            ShutdownReason::SignalHandlerUnavailable
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shutdown_reasons_are_operator_readable() {
        assert_eq!(ShutdownReason::Interrupt.to_string(), "interrupted");
        assert_eq!(ShutdownReason::Terminate.to_string(), "terminating");
        assert_eq!(
            ShutdownReason::SignalHandlerUnavailable.to_string(),
            "signal handler unavailable"
        );
    }
}
