//! SignClient proto regeneration identity.
//!
//! tonic/prost output is excluded from rustfmt. This test is the format-gate
//! authority: two successive generations must be byte-identical. It uses the
//! same `tonic-build` + `protoc-bin-vendored` pins as `build.rs`.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

fn proto_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("proto")
}

fn generate_into(out_dir: &Path) {
    fs::create_dir_all(out_dir).expect("proto out dir");
    let protoc = protoc_bin_vendored::protoc_bin_path().expect("vendored protoc");
    std::env::set_var("PROTOC", protoc);
    let proto = proto_dir();
    tonic_build::configure()
        .out_dir(out_dir)
        .compile_protos(
            &[
                proto.join("servicepb.proto").to_string_lossy().into_owned(),
                proto.join("signpb.proto").to_string_lossy().into_owned(),
            ],
            &[proto.to_string_lossy().into_owned()],
        )
        .expect("tonic proto generation");
}

fn rust_files(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut files = BTreeMap::new();
    for entry in fs::read_dir(dir).expect("read proto out dir") {
        let entry = entry.expect("proto out entry");
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("rs") {
            files.insert(
                path.file_name()
                    .expect("proto file name")
                    .to_string_lossy()
                    .into_owned(),
                fs::read(&path).expect("read generated proto rust"),
            );
        }
    }
    files
}

#[test]
fn proto_generation_is_byte_stable() {
    let first = tempfile::tempdir().expect("first proto dir");
    let second = tempfile::tempdir().expect("second proto dir");
    generate_into(first.path());
    generate_into(second.path());

    let left = rust_files(first.path());
    let right = rust_files(second.path());
    assert!(
        !left.is_empty(),
        "tonic_build must emit at least one .rs file"
    );
    assert_eq!(
        left.keys().collect::<Vec<_>>(),
        right.keys().collect::<Vec<_>>(),
        "proto generation must emit the same file names"
    );
    for (name, bytes) in &left {
        assert_eq!(
            bytes,
            right.get(name).expect("matching proto file"),
            "generated {name} is not byte-identical across regenerations"
        );
    }
}
