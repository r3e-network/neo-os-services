# Retired heartbeat skeleton

This crate is **not** the NeoOS relayer.

See [`RETIRED.md`](./RETIRED.md). Production authority is
`workers/neo-os-relayer` plus `workers/nitro-enclave-host`. The directory
remains only as an excluded archive; it is outside the Cargo workspace
and outside every measured Docker build context. The live `Cargo.toml`
is an archive stub.

Do not follow `PROJECT_SUMMARY.md` or `PERFORMANCE_COMPARISON.md`.
`DEPLOYMENT_GUIDE.md` is a pointer only. Those files describe a crate
that was never completed and is not deployed.
