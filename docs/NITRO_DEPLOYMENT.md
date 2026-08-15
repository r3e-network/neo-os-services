# AWS Nitro merged enclave deployment

This runbook deploys the merged NeoOS compute-and-sign runtime into AWS Nitro.
The host relayer talks only to `127.0.0.1:8787`; that port is a vsock proxy into
the enclave.

## Files

- `deploy/nitro/enclave-server.mjs` implements the merged semantic compute and
  signing routes plus KMS-attested provisioning.
- `deploy/nitro/Dockerfile.enclave` builds the measured enclave image.
- `deploy/nitro/build-enclave-eif.sh` builds the EIF and measurement manifest.
- `deploy/nitro/start-nitro-signer.sh` runs the merged enclave and local bridge.
- `deploy/systemd/morpheus-nitro-signer.service` owns enclave lifecycle.
- `deploy/systemd/morpheus-relayer-nitro.service` starts the relayer against the
  local Nitro signer.

## Secret rendering

Run from the repo root:

```bash
npm run render:nitro-env -- --network mainnet --output-dir .secrets/nitro
```

The renderer reads the configured sources and refuses production output unless
the runtime-auth, updater and verifier KMS ciphertexts are present. It never
copies plaintext WIF/private-key fields into the provisioning artifact.

The generated files are local-only transport/provisioning inputs:

- `.secrets/nitro/morpheus-nitro-signer.env`
- `.secrets/nitro/morpheus-relayer.env`

`morpheus-nitro-signer.env` contains transport authentication plus KMS
CiphertextBlob values, never a WIF/private key. KMS policy must require the
published PCR measurement.

## Host install

```bash
sudo dnf install -y docker jq socat aws-nitro-enclaves-cli aws-nitro-enclaves-cli-devel
sudo systemctl enable --now docker nitro-enclaves-allocator
sudo install -d -m 0700 /opt/morpheus/nitro
sudo cp deploy/systemd/morpheus-nitro-signer.service /etc/systemd/system/
sudo cp deploy/systemd/morpheus-relayer-nitro.service /etc/systemd/system/
sudo deploy/nitro/build-enclave-eif.sh --verify-reproducible
sudo systemctl daemon-reload
sudo systemctl enable --now morpheus-nitro-signer
curl -fsS http://127.0.0.1:8787/health
sudo systemctl enable --now morpheus-relayer-nitro
```

## Safety

Do not set `MORPHEUS_ALLOW_UNPINNED_SIGNERS=true` for mainnet. If the renderer
cannot find the pinned updater/verifier material, stop and recover the correct
signer or perform an explicit on-chain role rotation.
