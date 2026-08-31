//! The bridge to the keyless compute child (`deploy/nitro/bridge-worker.mjs`
//! on loopback :8090) — the Rust shape of `computeViaWorker`
//! (enclave-server.mjs:580-601). The merged server called the worker handler
//! in-process; the split forwards over loopback HTTP so the child stays a
//! plain Node process with a stripped environment and no secrets.
//!
//! The wire contract mirrors `computeViaWorker` exactly: the worker-auth
//! token (MORPHEUS_RUNTIME_TOKEN, then NITRO_API_TOKEN, then
//! NITRO_SHARED_SECRET) rides both `authorization: Bearer` and
//! `x-nitro-token`; the reply is `{ok, status, body}` where `body` is the
//! parsed JSON (or `{raw: <text>}` when it does not parse) — the shape the
//! fulfillment pipeline's canonical builders consume unchanged.
//!
//! The client is deliberately minimal: one JSON POST to a loopback peer we
//! also ship. It speaks just enough HTTP/1.1 for that — content-length
//! responses, a chunked fallback, connection close — and fails closed with a
//! 503-shaped reply when the child is not listening, rather than panicking
//! the host or surfacing a transport error as compute output.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use crate::overlay::EnvOverlay;
use crate::state::{BridgePlane, BridgeReply};
use crate::RUNTIME_NAME;

/// How long the host will wait on the child for one compute call. The child
/// enforces its own upstream timeouts (smart-fetch's egress budget); this is
/// the outer bound.
const FORWARD_TIMEOUT: Duration = Duration::from_secs(120);

/// `resolveWorkerAuthToken` — the host→child credential, read from the
/// overlay (which is what the Node server read from its accumulated
/// `process.env`).
pub fn resolve_worker_auth_token(overlay: &EnvOverlay) -> Option<String> {
    for name in [
        "MORPHEUS_RUNTIME_TOKEN",
        "NITRO_API_TOKEN",
        "NITRO_SHARED_SECRET",
    ] {
        if let Some(value) = overlay.get_trimmed(name) {
            return Some(value);
        }
    }
    None
}

#[derive(Debug, Clone)]
pub struct LoopbackBridge {
    pub host: String,
    pub port: u16,
}

impl LoopbackBridge {
    pub fn new(port: u16) -> Self {
        LoopbackBridge {
            host: "127.0.0.1".to_string(),
            port,
        }
    }

    fn connect(&self) -> std::io::Result<TcpStream> {
        let stream = TcpStream::connect((self.host.as_str(), self.port))?;
        stream.set_read_timeout(Some(FORWARD_TIMEOUT))?;
        stream.set_write_timeout(Some(FORWARD_TIMEOUT))?;
        Ok(stream)
    }
}

/// Minimal HTTP/1.1 response reader: status line, headers, then body by
/// content-length, chunked transfer decoding, or EOF — the three forms a
/// Node `http` server can emit.
fn read_response(stream: &mut TcpStream) -> std::io::Result<(u16, Vec<u8>)> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8192];
    let header_end;
    loop {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "bridge: connection closed before response headers",
            ));
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(position) = find_header_end(&buffer) {
            header_end = position;
            break;
        }
        if buffer.len() > 1_048_576 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "bridge: response headers too large",
            ));
        }
    }
    let head = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "bridge: malformed status line",
            )
        })?;
    let mut content_length: Option<usize> = None;
    let mut chunked = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        if name == "content-length" {
            content_length = value.parse::<usize>().ok();
        } else if name == "transfer-encoding" && value.to_ascii_lowercase().contains("chunked") {
            chunked = true;
        }
    }
    let mut body = buffer[header_end + 4..].to_vec();
    if chunked {
        loop {
            if let Some(decoded) = decode_chunked(&body) {
                return Ok((status, decoded));
            }
            let read = stream.read(&mut chunk)?;
            if read == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "bridge: connection closed mid-body",
                ));
            }
            body.extend_from_slice(&chunk[..read]);
        }
    }
    if let Some(length) = content_length {
        while body.len() < length {
            let read = stream.read(&mut chunk)?;
            if read == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..read]);
        }
        body.truncate(length);
    }
    Ok((status, body))
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

/// Decode a complete chunked body; `None` while bytes are missing.
fn decode_chunked(body: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut position = 0usize;
    loop {
        let line_end = body[position..]
            .windows(2)
            .position(|window| window == b"\r\n")?
            + position;
        let size_text = std::str::from_utf8(&body[position..line_end]).ok()?;
        let size = usize::from_str_radix(size_text.split(';').next()?.trim(), 16).ok()?;
        position = line_end + 2;
        if size == 0 {
            return Some(out);
        }
        if position + size + 2 > body.len() {
            return None;
        }
        out.extend_from_slice(&body[position..position + size]);
        position += size + 2;
    }
}

impl BridgePlane for LoopbackBridge {
    fn forward(
        &self,
        route: &str,
        payload: &serde_json::Value,
        auth_token: Option<&str>,
    ) -> BridgeReply {
        let Ok(mut stream) = self.connect() else {
            return BridgeReply {
                ok: false,
                status: 503,
                body: serde_json::json!({
                    "status": "error",
                    "error": format!("compute child at {}:{} is unreachable", self.host, self.port),
                    "runtime": RUNTIME_NAME,
                }),
            };
        };
        let body = serde_json::to_vec(payload).unwrap_or_default();
        let mut request = format!(
            "POST {route} HTTP/1.1\r\nhost: {}:{}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n",
            self.host, self.port, body.len()
        );
        if let Some(token) = auth_token {
            request.push_str(&format!("authorization: Bearer {token}\r\n"));
            request.push_str(&format!("x-nitro-token: {token}\r\n"));
        }
        request.push_str("\r\n");
        let mut wire = request.into_bytes();
        wire.extend_from_slice(&body);
        if let Err(error) = stream.write_all(&wire) {
            return BridgeReply {
                ok: false,
                status: 503,
                body: serde_json::json!({
                    "status": "error",
                    "error": format!("bridge write failed: {error}"),
                    "runtime": RUNTIME_NAME,
                }),
            };
        }
        let (status, response_body) = match read_response(&mut stream) {
            Ok(result) => result,
            Err(error) => {
                return BridgeReply {
                    ok: false,
                    status: 503,
                    body: serde_json::json!({
                        "status": "error",
                        "error": format!("bridge read failed: {error}"),
                        "runtime": RUNTIME_NAME,
                    }),
                };
            }
        };
        let text = String::from_utf8_lossy(&response_body);
        // computeViaWorker: `text ? JSON.parse(text) : {}`, unparseable →
        // `{raw: text}`.
        let parsed = if text.is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str::<serde_json::Value>(&text)
                .unwrap_or_else(|_| serde_json::json!({ "raw": text }))
        };
        BridgeReply {
            ok: (200..300).contains(&status),
            status,
            body: parsed,
        }
    }

    fn ready(&self) -> bool {
        self.connect().is_ok()
    }
}

#[cfg(test)]
#[path = "../tests/unit/bridge.rs"]
mod tests;
