# Legacy NSM helper toolchain review — 2026-10-02

## Finding and scope

The rollback-only Node signer image still builds
`deploy/nitro/nsm-attest/main.go` through
`deploy/nitro/Dockerfile.signer-legacy`. The old stage used the EOL
`golang:1.22-bookworm` image, created a fresh module in the image, and ran
`go get github.com/hf/nsm@latest`. That made the build depend on an unpinned
toolchain and floating module resolution.

The helper is an enclave build input even though the image is retired. Changing
it changes the EIF measurement. This patch therefore prepares the source only;
it does not build, publish, provision, restart or deploy an EIF.

## Source correction

The legacy builder now:

- uses the linux/amd64 Go `1.24.13` Bookworm image pinned to digest
  `sha256:98d673f18a1aac43da744209873cb79323e11706f909251bcfb131828b95559d`;
- copies the tracked `go.mod` and `go.sum` and runs `go mod download`;
- copies the tracked helper sources and builds with `-mod=readonly`;
- declares Go `1.24` in the helper module;
- refuses the old Go image, `go mod init`, floating `go get @latest`, or a
  missing digest through `scripts/nitro-legacy-toolchain.test.mjs`.

## Evidence

- The new toolchain test failed on the parent tree before the implementation.
- Replacing the pinned Go image with `golang:1.22-bookworm` made that test fail
  again; the source was restored afterward.
- `node --test scripts/nitro-legacy-toolchain.test.mjs`: 1/1 passed.
- `go test ./...` in `deploy/nitro/nsm-attest`: passed.
- `go vet ./...` with the local Go `1.24.13`: passed.
- `govulncheck ./...`: reported no vulnerabilities; the tool selected Go
  `1.26.8` automatically because the current govulncheck release requires it.
- A Docker `nsmbuild` validation was attempted with the pinned Dockerfile but
  the local Docker socket did not respond for over seven minutes. The process
  was terminated and this check remains unverified; no green result is claimed.

## Owner release action

Before any use of the legacy EIF, the owner must rebuild it from this exact
commit, capture reproducible PCR0/PCR1/PCR2 measurements, update the matching
KMS attestation policy, and perform the existing release read-back. The source
patch alone does not authorize a rollback or deployment.
