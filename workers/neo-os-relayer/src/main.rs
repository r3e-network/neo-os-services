//! Placeholder binary for the neo-os-relayer skeleton (T01).
//!
//! The real CLI (`loop` / `once` / `metrics` / `metrics:prom` /
//! `serve:metrics` / `config:validate` / `config:dump`, with the exact exit
//! codes ops tooling depends on — see docs/rust-migration/ARCHITECTURE.md
//! §5.3) lands in T04. This placeholder exists only so the workspace member
//! compiles; it must never be wired into deploy tooling.

fn main() {
    eprintln!(
        "neo-os-relayer: skeleton binary (T01). Implementation lands in T04; \
         do not deploy this placeholder."
    );
    std::process::exit(2);
}
