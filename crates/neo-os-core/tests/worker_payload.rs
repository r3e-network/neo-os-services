mod common;

use common::{canonical, canonical_file, load_family, to_js};
use neo_os_core::kernel::build_worker_payload;

#[test]
fn worker_payloads_match_js_oracle() {
    for case in load_family("worker_payload") {
        let name = case["name"].as_str().unwrap_or("?");
        let args = case.get("args").and_then(|v| v.as_array()).expect("args");
        assert!(args.len() == 5, "{name}: expected 5 args");

        let chain = args[0].as_str().expect("chain");
        let request_type = args[1].as_str().expect("request_type");
        let payload = to_js(&args[2]);
        let request_id = to_js(&args[3]);
        let context = to_js(&args[4]);

        let built = build_worker_payload(chain, request_type, &payload, &request_id, &context);
        assert_eq!(
            canonical(&neo_os_core::js_value::JsValue::Object(built)),
            canonical_file(case.get("payload").expect("payload")),
            "{name}"
        );
    }
}
