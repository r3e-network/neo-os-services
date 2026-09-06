fn main() -> Result<(), Box<dyn std::error::Error>> {
    let protoc = protoc_bin_vendored::protoc_bin_path()?;
    std::env::set_var("PROTOC", protoc);

    println!("cargo:rerun-if-changed=proto/servicepb.proto");
    println!("cargo:rerun-if-changed=proto/signpb.proto");
    tonic_build::configure()
        .compile_protos(&["proto/servicepb.proto", "proto/signpb.proto"], &["proto"])?;
    Ok(())
}
