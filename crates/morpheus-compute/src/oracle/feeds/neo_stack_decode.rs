//! Port of `workers/nitro-worker/src/oracle/feeds/neo-stack-decode.js` — Neo
//! RPC stack-item decoding (with the quirky reversed-bytestring recovery the
//! feed contract needs), the feed-record shaping over decoded entries, and the
//! IO half (`fetchJsonRpc` / `fetchNeoN3FeedRecords` /
//! `loadOnchainFeedRecords`) behind an injected [`HttpTransport`].

use serde_json::{json, Value as Json};

use crate::core::buffer_from_base64;
use crate::js::{js_stringify, js_trim_string, js_truthy};
use crate::oracle::decimal::integer_to_decimal_string;
use crate::transport::{HttpRequest, HttpTransport};

use super::shared::FEED_PRICE_DECIMALS;

const KNOWN_PAIR_PREFIXES: [&str; 3] = ["TWELVEDATA:", "BINANCE-SPOT:", "COINBASE-SPOT:"];

/// `/^[\x09\x0a\x0d\x20-\x7e]*$/` — tab/LF/CR plus printable ASCII.
fn is_printable_ascii(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| matches!(byte, 0x09 | 0x0a | 0x0d | 0x20..=0x7e))
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0xf) as usize] as char);
    }
    out
}

/// `decodeNeoByteString(bytes)` — the contract may store pair strings
/// byte-reversed; try the reversed text against the known pair prefixes first,
/// then the plain text, then a reversed uppercase-symbol form, then fall back
/// to a hex literal.
pub fn decode_neo_byte_string(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut reversed_bytes = bytes.to_vec();
    reversed_bytes.reverse();
    let reversed = String::from_utf8_lossy(&reversed_bytes);
    if is_printable_ascii(&reversed)
        && KNOWN_PAIR_PREFIXES
            .iter()
            .any(|prefix| reversed.starts_with(prefix))
    {
        return reversed.into_owned();
    }
    if is_printable_ascii(&text) {
        return text.into_owned();
    }
    if is_printable_ascii(&reversed)
        && reversed.bytes().all(|byte| {
            byte.is_ascii_uppercase() || byte.is_ascii_digit() || matches!(byte, b':' | b'_' | b'-')
        })
    {
        return reversed.into_owned();
    }
    format!("0x{}", hex_lower(bytes))
}

/// `parseNeoStackItem(item)` — Neo RPC stack items into plain JSON values.
pub fn parse_neo_stack_item(item: &Json) -> Json {
    let Some(object) = item.as_object() else {
        return Json::Null;
    };
    let item_type = js_trim_string(object.get("type")).to_lowercase();
    let value = object.get("value");
    match item_type.as_str() {
        "array" | "struct" => match value.and_then(Json::as_array) {
            Some(items) => Json::Array(items.iter().map(parse_neo_stack_item).collect()),
            None => Json::Array(Vec::new()),
        },
        "string" | "hash160" | "hash256" => Json::String(match value.filter(|v| !v.is_null()) {
            Some(present) => js_stringify(present),
            None => String::new(),
        }),
        "integer" => Json::String(match value.filter(|v| !v.is_null()) {
            Some(present) => js_stringify(present),
            None => "0".to_string(),
        }),
        "boolean" => Json::Bool(value.map(js_truthy).unwrap_or(false)),
        "bytestring" | "bytearray" => {
            let raw = js_trim_string(value);
            if raw.is_empty() {
                return Json::String(String::new());
            }
            let bytes = buffer_from_base64(&raw);
            let decoded = decode_neo_byte_string(&bytes);
            if bytes.len() == 20 && decoded.starts_with("0x") {
                // hash160 storage is little-endian on Neo — render big-endian
                let mut reversed = bytes.clone();
                reversed.reverse();
                Json::String(format!("0x{}", hex_lower(&reversed)))
            } else {
                Json::String(decoded)
            }
        }
        _ => value
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(Json::Null),
    }
}

/// `String(entry[i] ?? '0')` for the already-decoded entry fields.
fn string_or(value: &Json, fallback: &str) -> String {
    if value.is_null() {
        fallback.to_string()
    } else {
        js_stringify(value)
    }
}

/// The pure record-shaping body of `fetchNeoN3FeedRecords`: entries (already
/// through [`parse_neo_stack_item`]) of at least six fields become the
/// storage-pair-keyed record map the feed state consumes.
pub fn shape_feed_records(raw_records: &[Json]) -> Json {
    let mut records = serde_json::Map::new();
    for entry in raw_records {
        let Some(items) = entry.as_array() else {
            continue;
        };
        if items.len() < 6 {
            continue;
        }
        let storage_pair = js_trim_string(Some(&items[0]));
        let pair = if storage_pair.contains(':') {
            storage_pair
                .split(':')
                .skip(1)
                .collect::<Vec<&str>>()
                .join(":")
        } else {
            storage_pair.clone()
        };
        let round_id = string_or(&items[1], "0");
        let price_units = string_or(&items[2], "0");
        let price =
            integer_to_decimal_string(&Json::String(price_units.clone()), FEED_PRICE_DECIMALS);
        let timestamp = string_or(&items[3], "0");
        let attestation_hash = js_trim_string(Some(&items[4]));
        let source_set_id = string_or(&items[5], "0");
        records.insert(
            storage_pair.clone(),
            json!({
                "storage_pair": storage_pair,
                "pair": pair,
                "round_id": round_id,
                "price_units": price_units,
                "price": price,
                "timestamp": timestamp,
                "attestation_hash": attestation_hash,
                "source_set_id": source_set_id,
                "price_scale_decimals": FEED_PRICE_DECIMALS,
            }),
        );
    }
    Json::Object(records)
}

/// `AbortSignal.timeout(15_000)` on the Neo RPC request.
pub const RPC_TIMEOUT_MS: u64 = 15_000;

/// `fetchJsonRpc(url, body)` — POST JSON, tolerate an unparseable response
/// body (treated as null), surface the RPC error message.
pub fn fetch_json_rpc(
    url: &str,
    body: &Json,
    transport: HttpTransport<'_>,
) -> Result<Json, String> {
    let request = HttpRequest {
        url: url.to_string(),
        method: "POST".to_string(),
        headers: vec![("content-type".to_string(), "application/json".to_string())],
        body: Some(body.to_string().into_bytes()),
        timeout_ms: RPC_TIMEOUT_MS,
        follow_redirects: true,
    };
    let response = transport(&request)?;
    let payload: Json = serde_json::from_slice(&response.body).unwrap_or(Json::Null);
    let error_message = || {
        let nested = payload
            .get("error")
            .and_then(|error| error.get("message"))
            .filter(|message| !message.is_null());
        let nested = js_trim_string(nested);
        if !nested.is_empty() {
            return nested;
        }
        let top = js_trim_string(payload.get("message"));
        if !top.is_empty() {
            return top;
        }
        format!("rpc request failed with status {}", response.status)
    };
    if !(200..300).contains(&response.status) {
        return Err(error_message());
    }
    if let Some(message) = payload
        .get("error")
        .and_then(|error| error.get("message"))
        .filter(|message| !message.is_null())
    {
        return Err(js_stringify(message));
    }
    Ok(payload.get("result").cloned().unwrap_or(Json::Null))
}

/// `fetchNeoN3FeedRecords(rpcUrl, contractHash)` — `invokefunction`
/// getAllFeedRecords, fault-checked, then the stack item decoded into the
/// storage-pair record map.
pub fn fetch_neo_n3_feed_records(
    rpc_url: &Json,
    contract_hash: &Json,
    transport: HttpTransport<'_>,
) -> Result<Json, String> {
    if js_trim_string(Some(rpc_url)).is_empty() || js_trim_string(Some(contract_hash)).is_empty() {
        return Ok(json!({}));
    }
    let result = fetch_json_rpc(
        &js_stringify(rpc_url),
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "invokefunction",
            "params": [contract_hash, "getAllFeedRecords", []],
        }),
        transport,
    )?;
    let state = result
        .get("state")
        .filter(|value| js_truthy(value))
        .cloned()
        .unwrap_or(Json::String(String::new()));
    if js_stringify(&state).to_uppercase() == "FAULT" {
        let exception = js_trim_string(result.get("exception"));
        return Err(if exception.is_empty() {
            "getAllFeedRecords faulted".to_string()
        } else {
            exception
        });
    }
    let stack_item = result
        .get("stack")
        .and_then(Json::as_array)
        .and_then(|stack| stack.first());
    let raw_records = parse_neo_stack_item(stack_item.unwrap_or(&Json::Null));
    let Some(records) = raw_records.as_array() else {
        return Ok(json!({}));
    };
    Ok(shape_feed_records(records))
}

/// `loadOnchainFeedRecords(targetChain, { neoContext, dataFeedHash })` — the
/// neo_n3 gate; every failure collapses into the `{ records, error }` pair.
pub fn load_onchain_feed_records(
    target_chain: &str,
    neo_context: &Json,
    data_feed_hash: &Json,
    transport: HttpTransport<'_>,
) -> Json {
    if target_chain == "neo_n3" {
        let rpc_url = neo_context.get("rpcUrl").unwrap_or(&Json::Null);
        return match fetch_neo_n3_feed_records(rpc_url, data_feed_hash, transport) {
            Ok(records) => json!({ "records": records, "error": Json::Null }),
            Err(error) => json!({ "records": json!({}), "error": error }),
        };
    }
    json!({ "records": json!({}), "error": Json::Null })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::{HttpRequest, HttpResponse};

    fn base64_of(text: &str) -> String {
        buffer_to_base64(text.as_bytes())
    }

    fn buffer_to_base64(bytes: &[u8]) -> String {
        use base64::engine::general_purpose::GeneralPurpose;
        use base64::Engine as _;
        GeneralPurpose::new(
            &base64::alphabet::STANDARD,
            base64::engine::GeneralPurposeConfig::new(),
        )
        .encode(bytes)
    }

    fn bytestring(bytes: &[u8]) -> Json {
        json!({ "type": "ByteString", "value": buffer_to_base64(bytes) })
    }

    #[test]
    fn printable_strings_decode_forward_and_known_pair_prefixes_recover_reversed() {
        // plain printable text passes through
        assert_eq!(decode_neo_byte_string(b"NEO-USD"), "NEO-USD");
        // a reversed known-pair string recovers to the forward form
        let reversed: Vec<u8> = b"TWELVEDATA:NEO-USD".iter().rev().copied().collect();
        assert_eq!(decode_neo_byte_string(&reversed), "TWELVEDATA:NEO-USD");
        let reversed_binance: Vec<u8> = b"BINANCE-SPOT:NEO-USD".iter().rev().copied().collect();
        assert_eq!(
            decode_neo_byte_string(&reversed_binance),
            "BINANCE-SPOT:NEO-USD"
        );
        // non-printable bytes fall back to hex
        assert_eq!(decode_neo_byte_string(&[0x00, 0xff]), "0x00ff");
    }

    #[test]
    fn stack_items_decode_across_every_type() {
        assert_eq!(
            parse_neo_stack_item(&json!({ "type": "Integer", "value": "2694000" })),
            json!("2694000")
        );
        assert_eq!(
            parse_neo_stack_item(&json!({ "type": "Integer" })),
            json!("0")
        );
        assert_eq!(
            parse_neo_stack_item(
                &json!({ "type": "ByteString", "value": base64_of("TWELVEDATA:NEO-USD") })
            ),
            json!("TWELVEDATA:NEO-USD")
        );
        // reversed pair bytes recover through the prefix branch
        let reversed: Vec<u8> = b"TWELVEDATA:GAS-USD".iter().rev().copied().collect();
        assert_eq!(
            parse_neo_stack_item(&bytestring(&reversed)),
            json!("TWELVEDATA:GAS-USD")
        );
        assert_eq!(
            parse_neo_stack_item(&json!({ "type": "Boolean", "value": true })),
            json!(true)
        );
        assert_eq!(
            parse_neo_stack_item(&json!({ "type": "Boolean" })),
            json!(false)
        );
        assert_eq!(
            parse_neo_stack_item(&json!({ "type": "String", "value": "hello" })),
            json!("hello")
        );
        // structs recurse into arrays
        assert_eq!(
            parse_neo_stack_item(&json!({
                "type": "Struct",
                "value": [
                    { "type": "ByteString", "value": base64_of("TWELVEDATA:NEO-USD") },
                    { "type": "Integer", "value": "1" },
                    { "type": "Any" },
                ],
            })),
            json!(["TWELVEDATA:NEO-USD", "1", Json::Null])
        );
        // unknown types pass the raw value through
        assert_eq!(
            parse_neo_stack_item(&json!({ "type": "InteropInterface", "value": 7 })),
            json!(7)
        );
        // non-objects are null
        assert_eq!(parse_neo_stack_item(&json!(5)), Json::Null);
    }

    #[test]
    fn twenty_byte_hash_stacks_render_big_endian() {
        let mut bytes = vec![0x01u8, 0x02, 0x03];
        bytes.resize(20, 0xab);
        // non-printable → decoded as "0x{forward hex}" → the 20-byte branch
        // re-renders big-endian
        let expected_reversed: Vec<u8> = bytes.iter().rev().copied().collect();
        assert_eq!(
            parse_neo_stack_item(&bytestring(&bytes)),
            json!(format!("0x{}", hex_lower(&expected_reversed)))
        );
    }

    #[test]
    fn feed_records_shape_from_decoded_entries() {
        let records = shape_feed_records(&[
            json!([
                "TWELVEDATA:NEO-USD",
                "12",
                "2694000",
                "1900000000",
                "0xabc",
                "1",
            ]),
            // short entries are skipped
            json!(["TWELVEDATA:BTC-USD", "1", "2"]),
            // a second record for the same pair overwrites, first position kept
            json!([
                "TWELVEDATA:NEO-USD",
                "13",
                "2694100",
                "1900000060",
                "0xabd",
                "1",
            ]),
        ]);
        assert!(records.get("TWELVEDATA:BTC-USD").is_none());
        let neo = records.get("TWELVEDATA:NEO-USD").unwrap();
        assert_eq!(
            neo,
            &json!({
                "storage_pair": "TWELVEDATA:NEO-USD",
                "pair": "NEO-USD",
                "round_id": "13",
                "price_units": "2694100",
                "price": "2.694100",
                "timestamp": "1900000060",
                "attestation_hash": "0xabd",
                "source_set_id": "1",
                "price_scale_decimals": 6,
            })
        );
    }

    #[test]
    fn missing_entry_fields_fall_back_to_the_js_defaults() {
        let records = shape_feed_records(&[json!([
            "BINANCE-SPOT:GAS-USD",
            Json::Null,
            "1000000",
            Json::Null,
            "",
            "2",
        ])]);
        let gas = records.get("BINANCE-SPOT:GAS-USD").unwrap();
        assert_eq!(gas["round_id"], json!("0"));
        assert_eq!(gas["timestamp"], json!("0"));
        assert_eq!(gas["price"], json!("1.000000"));
        assert_eq!(gas["attestation_hash"], json!(""));
    }

    // ---- 5b-3: the IO half over the injected transport ----

    fn http_json_response(status: u16, body: Json) -> Result<HttpResponse, String> {
        Ok(HttpResponse {
            status,
            headers: Vec::new(),
            body: serde_json::to_vec(&body).unwrap(),
        })
    }

    #[test]
    fn fetch_json_rpc_posts_json_and_surfaces_errors() {
        let body = json!({"jsonrpc": "2.0", "id": 1, "method": "ping", "params": []});
        let transport = |request: &HttpRequest| -> Result<HttpResponse, String> {
            assert_eq!(request.method, "POST");
            assert_eq!(request.url, "https://rpc.example.com");
            assert_eq!(request.timeout_ms, RPC_TIMEOUT_MS);
            assert!(request.follow_redirects);
            assert_eq!(
                request.headers[0],
                ("content-type".to_string(), "application/json".to_string())
            );
            let sent: Json = serde_json::from_slice(request.body.as_deref().unwrap()).unwrap();
            assert_eq!(sent, body);
            http_json_response(
                200,
                json!({"jsonrpc": "2.0", "id": 1, "result": {"ok": true}}),
            )
        };
        let result =
            fetch_json_rpc("https://rpc.example.com", &body, &transport).expect("succeeds");
        assert_eq!(result, json!({"ok": true}));

        let error_transport = |request: &HttpRequest| -> Result<HttpResponse, String> {
            match request.url.as_str() {
                "https://http-error.example" => {
                    http_json_response(500, json!({"error": {"message": " node overloaded "}}))
                }
                "https://top-message.example" => {
                    http_json_response(503, json!({"message": "maintenance"}))
                }
                "https://silent.example" => Ok(HttpResponse {
                    status: 502,
                    headers: Vec::new(),
                    body: b"<html>bad gateway</html>".to_vec(),
                }),
                "https://rpc-error.example" => http_json_response(
                    200,
                    json!({"jsonrpc": "2.0", "id": 1, "error": {"code": -100, "message": "unknown contract"}}),
                ),
                "https://garbage.example" => Ok(HttpResponse {
                    status: 200,
                    headers: Vec::new(),
                    body: b"not json".to_vec(),
                }),
                other => panic!("unexpected url {other}"),
            }
        };
        assert_eq!(
            fetch_json_rpc("https://http-error.example", &body, &error_transport).unwrap_err(),
            "node overloaded"
        );
        assert_eq!(
            fetch_json_rpc("https://top-message.example", &body, &error_transport).unwrap_err(),
            "maintenance"
        );
        assert_eq!(
            fetch_json_rpc("https://silent.example", &body, &error_transport).unwrap_err(),
            "rpc request failed with status 502"
        );
        assert_eq!(
            fetch_json_rpc("https://rpc-error.example", &body, &error_transport).unwrap_err(),
            "unknown contract"
        );
        // an unparseable 2xx body is treated as null → result null
        assert_eq!(
            fetch_json_rpc("https://garbage.example", &body, &error_transport).unwrap(),
            Json::Null
        );

        let broken = |_request: &HttpRequest| -> Result<HttpResponse, String> {
            Err("connection refused".to_string())
        };
        assert_eq!(
            fetch_json_rpc("https://rpc.example.com", &body, &broken).unwrap_err(),
            "connection refused"
        );
    }

    fn rpc_records_response() -> Json {
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "state": "HALT",
                "stack": [{
                    "type": "Array",
                    "value": [{
                        "type": "Struct",
                        "value": [
                            { "type": "ByteString", "value": base64_of("TWELVEDATA:NEO-USD") },
                            { "type": "Integer", "value": "12" },
                            { "type": "Integer", "value": "2694000" },
                            { "type": "Integer", "value": "1900000000" },
                            { "type": "ByteString", "value": base64_of("att-1") },
                            { "type": "Integer", "value": "1" },
                        ],
                    }],
                }],
            },
        })
    }

    #[test]
    fn fetch_neo_n3_feed_records_round_trips_invokefunction() {
        let transport = |request: &HttpRequest| -> Result<HttpResponse, String> {
            let sent: Json = serde_json::from_slice(request.body.as_deref().unwrap()).unwrap();
            assert_eq!(sent["method"], "invokefunction");
            assert_eq!(sent["params"][0], "0x1234feed");
            assert_eq!(sent["params"][1], "getAllFeedRecords");
            assert_eq!(sent["params"][2], json!([]));
            http_json_response(200, rpc_records_response())
        };
        let records = fetch_neo_n3_feed_records(
            &json!("https://rpc.example.com"),
            &json!("0x1234feed"),
            &transport,
        )
        .expect("succeeds");
        let neo = records.get("TWELVEDATA:NEO-USD").expect("record present");
        assert_eq!(neo["pair"], json!("NEO-USD"));
        assert_eq!(neo["price"], json!("2.694000"));
        assert_eq!(neo["round_id"], json!("12"));

        // missing rpcUrl/contract → {} without touching the network
        let refusing = |_request: &HttpRequest| -> Result<HttpResponse, String> {
            panic!("network must not be reached");
        };
        assert_eq!(
            fetch_neo_n3_feed_records(&Json::Null, &json!("0xfeed"), &refusing).unwrap(),
            json!({})
        );
        assert_eq!(
            fetch_neo_n3_feed_records(&json!("https://rpc.example.com"), &json!("  "), &refusing)
                .unwrap(),
            json!({})
        );

        // FAULT with and without an exception message
        let fault = |result: Json| -> Result<HttpResponse, String> {
            http_json_response(200, json!({"jsonrpc": "2.0", "id": 1, "result": result}))
        };
        let exception_transport = |request: &HttpRequest| -> Result<HttpResponse, String> {
            let mut response = rpc_records_response();
            response["result"] = json!({"state": "FAULT", "exception": "storage read failed"});
            let _ = request;
            http_json_response(200, response)
        };
        assert_eq!(
            fetch_neo_n3_feed_records(
                &json!("https://rpc.example.com"),
                &json!("0xfeed"),
                &exception_transport
            )
            .unwrap_err(),
            "storage read failed"
        );
        let silent_fault = |request: &HttpRequest| -> Result<HttpResponse, String> {
            let mut response = rpc_records_response();
            response["result"] = json!({"state": "FAULT"});
            let _ = request;
            http_json_response(200, response)
        };
        assert_eq!(
            fetch_neo_n3_feed_records(
                &json!("https://rpc.example.com"),
                &json!("0xfeed"),
                &silent_fault
            )
            .unwrap_err(),
            "getAllFeedRecords faulted"
        );
        let _ = fault;

        // a non-array stack item decodes to null → {}
        let scalar_stack = |request: &HttpRequest| -> Result<HttpResponse, String> {
            let mut response = rpc_records_response();
            response["result"]["stack"] = json!([{ "type": "Any" }]);
            let _ = request;
            http_json_response(200, response)
        };
        assert_eq!(
            fetch_neo_n3_feed_records(
                &json!("https://rpc.example.com"),
                &json!("0xfeed"),
                &scalar_stack
            )
            .unwrap(),
            json!({})
        );
    }

    #[test]
    fn load_onchain_feed_records_gates_on_chain_and_collapses_errors() {
        let refusing = |_request: &HttpRequest| -> Result<HttpResponse, String> {
            panic!("network must not be reached for non-neo chains");
        };
        let skipped = load_onchain_feed_records(
            "ellvm",
            &json!({"rpcUrl": "https://rpc.example.com"}),
            &json!("0xfeed"),
            &refusing,
        );
        assert_eq!(skipped, json!({"records": {}, "error": Json::Null}));

        let transport = |request: &HttpRequest| -> Result<HttpResponse, String> {
            let sent: Json = serde_json::from_slice(request.body.as_deref().unwrap()).unwrap();
            assert_eq!(sent["params"][0], json!("0x1234feed"));
            http_json_response(200, rpc_records_response())
        };
        let loaded = load_onchain_feed_records(
            "neo_n3",
            &json!({"rpcUrl": "https://rpc.example.com"}),
            &json!("0x1234feed"),
            &transport,
        );
        assert!(loaded["error"].is_null());
        assert!(loaded["records"].get("TWELVEDATA:NEO-USD").is_some());

        let failing = |_request: &HttpRequest| -> Result<HttpResponse, String> {
            Err("rpc request failed with status 502".to_string())
        };
        let failed = load_onchain_feed_records(
            "neo_n3",
            &json!({"rpcUrl": "https://rpc.example.com"}),
            &json!("0xfeed"),
            &failing,
        );
        assert_eq!(failed["records"], json!({}));
        assert_eq!(failed["error"], json!("rpc request failed with status 502"));
    }
}
