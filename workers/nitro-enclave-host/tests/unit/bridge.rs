//! Bridge tests: the worker-auth resolution order and the minimal HTTP
//! client against a real loopback listener (content-length, chunked, and
//! connection-refused shapes).

use super::*;
use std::io::{Read, Write};

#[path = "support.rs"]
#[allow(clippy::duplicate_mod)] // intentional: one shared doubles file per test module
mod support;

use crate::overlay::EnvOverlay;
use crate::state::BridgePlane;
use crate::RUNTIME_NAME;

/// A one-shot HTTP server on an ephemeral port; `respond` writes raw bytes.
fn serve_once(respond: Vec<u8>) -> (u16, std::thread::JoinHandle<()>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let handle = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        let mut buffer = [0u8; 8192];
        let _ = stream.read(&mut buffer); // read the request head (ignore)
        stream.write_all(&respond).expect("respond");
    });
    (port, handle)
}

/// Accept one request, return the raw bytes the client sent, then answer
/// with `respond` so the forward call completes.
fn capture_request_then_respond(respond: Vec<u8>) -> (u16, std::thread::JoinHandle<Vec<u8>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let handle = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let read = stream.read(&mut chunk).expect("read");
            buffer.extend_from_slice(&chunk[..read]);
            if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
            if read == 0 {
                break;
            }
        }
        stream.write_all(&respond).expect("respond");
        buffer
    });
    (port, handle)
}

#[test]
fn the_worker_token_resolution_follows_the_node_priority() {
    let overlay = EnvOverlay::new([
        ("MORPHEUS_RUNTIME_TOKEN", "first"),
        ("NITRO_API_TOKEN", "second"),
        ("NITRO_SHARED_SECRET", "third"),
    ]);
    assert_eq!(
        resolve_worker_auth_token(&overlay).as_deref(),
        Some("first")
    );

    let overlay = EnvOverlay::new([
        ("NITRO_API_TOKEN", "second"),
        ("NITRO_SHARED_SECRET", "third"),
    ]);
    assert_eq!(
        resolve_worker_auth_token(&overlay).as_deref(),
        Some("second")
    );

    let overlay = EnvOverlay::new(Vec::<(&str, &str)>::new());
    assert_eq!(resolve_worker_auth_token(&overlay), None);
}

#[test]
fn forward_sends_the_headers_and_parses_a_content_length_response() {
    let body = br#"{"answer": 42}"#;
    let mut response = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n",
        body.len()
    );
    response.push_str(std::str::from_utf8(body).expect("utf8 body"));
    let (port, capture) = capture_request_then_respond(response.into_bytes());

    let reply = LoopbackBridge::new(port).forward(
        "/oracle/query",
        &serde_json::json!({ "question": "block-height" }),
        Some("s3cret"),
    );
    let seen = capture.join().expect("server thread");

    assert!(reply.ok);
    assert_eq!(reply.status, 200);
    assert_eq!(reply.body, serde_json::json!({ "answer": 42 }));

    let text = String::from_utf8_lossy(&seen);
    assert!(text.contains("POST /oracle/query HTTP/1.1\r\n"), "{text}");
    assert!(text.contains("authorization: Bearer s3cret\r\n"), "{text}");
    assert!(text.contains("x-nitro-token: s3cret\r\n"), "{text}");
    assert!(
        text.contains("content-type: application/json\r\n"),
        "{text}"
    );
    assert!(text.contains("connection: close\r\n"), "{text}");
}

#[test]
fn a_chunked_response_is_decoded() {
    let response = b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n5\r\n{\"a\":\r\n3\r\n42}\r\n0\r\n\r\n";
    let (port, server) = serve_once(response.to_vec());
    let reply = LoopbackBridge::new(port).forward("/oracle/query", &serde_json::json!({}), None);
    server.join().expect("server thread");
    assert!(reply.ok);
    assert_eq!(reply.body, serde_json::json!({ "a": 42 }));
}

#[test]
fn an_unparseable_body_becomes_the_raw_shape() {
    let response = "HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nnope!";
    let (port, server) = serve_once(response.as_bytes().to_vec());
    let reply = LoopbackBridge::new(port).forward("/oracle/query", &serde_json::json!({}), None);
    server.join().expect("server thread");
    assert_eq!(reply.body, serde_json::json!({ "raw": "nope!" }));
}

#[test]
fn a_non_2xx_status_is_forwarded_with_ok_false() {
    let body = br#"{"error":"compute refused"}"#;
    let mut response = format!(
        "HTTP/1.1 422 Unprocessable Entity\r\ncontent-length: {}\r\n\r\n",
        body.len()
    );
    response.push_str(std::str::from_utf8(body).expect("utf8 body"));
    let (port, server) = serve_once(response.into_bytes());
    let reply = LoopbackBridge::new(port).forward("/oracle/query", &serde_json::json!({}), None);
    server.join().expect("server thread");
    assert!(!reply.ok);
    assert_eq!(reply.status, 422);
    assert_eq!(reply.body["error"], "compute refused");
}

#[test]
fn a_dead_child_is_a_503_shaped_error_not_a_panic() {
    // Bind then close: the port is guaranteed free immediately after.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    drop(listener);

    let reply = LoopbackBridge::new(port).forward("/oracle/query", &serde_json::json!({}), None);
    assert!(!reply.ok);
    assert_eq!(reply.status, 503);
    assert_eq!(reply.body["status"], "error");
    assert_eq!(reply.body["runtime"], RUNTIME_NAME);
    assert!(reply.body["error"]
        .as_str()
        .expect("message")
        .contains("is unreachable"));
}
