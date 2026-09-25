# External-Only Release Blockers (2026-09-03)

Code remediation for the September 2026 trust-boundary wave is in the local
working trees across Services, Explorer, Contracts/DevPack/MiniApps/MiniGames,
Fura, Web, Admin, and neo-nexus. The items below cannot be closed by repository
edits alone.

## Custody / Secrets

1. Rotate and revoke any live Secrets Manager masters previously readable by
   parent roles; confirm IAM denies `secretsmanager:GetSecretValue` /
   `kms:Encrypt` / `kms:GenerateDataKey*` for confidential material.
2. Re-encrypt production X25519 / NeoDID / runtime-token ciphertexts under
   current Nitro PCR Recipient policies and re-provision enclaves.
3. Keep Neo X signing disabled until a measured Rust secp256k1 custody signer
   and transaction relay are deployed and attested.
4. Durable Nitro custody vault checkpoint/restore must land before treating
   enclave restarts as key-preserving.

## Explorer / App

5. Rotate/revoke the testnet council WIF that appeared in git history object
   `11594103f1cc14fe8a117d76fd6d24caac881f31`. Working tree guards prevent
   reintroduction; history rewrite is optional and only on explicit request.
6. Synchronize App DebugProtocol and App package lock hashes so CI validates
   the shipping dependency graph.

## Contracts / MiniApps / DevPack

7. Publish the CompactBase.Upgrade (and related governance) commit in
   `neo-os-contracts`, then refresh MiniApp/MiniGames
   `MiniApp.DevPack.sha256.json` `source_commit` pins and the DevPack
   `contract-registry-inputs.lock.json` from the sibling workspace.
8. Timelocked on-chain upgrade/redeploy of live SelfLoan and PlatformGame after
   artifact review.
9. Complete enumerated v1→v2 storage migration (or Registry rebind to fresh v2
   contracts) for any live MiniApp estates that still lack a v2 marker.

## Fura

10. Host install of Prometheus blackbox-exporter and prove live public-readiness
    scrapes.
11. Configure a real off-site `S3_BACKUP_BUCKET` in host env (deploy no longer
    overwrites a present value with empty staged config).
12. Narrow `TRUSTED_PROXY_CIDRS` to the cluster ingress-nginx pod CIDR.
13. Public DNS currently collapses multiple hostnames onto one origin; split
    infrastructure only if product requires independent failure domains.

## Operator / Deploy

14. Ensure production compose/units keep `NODE_ENV=production` and pairwise-
    distinct credentials across runtime/workflow/operator/relayer/signing/relay/
    custody domains (runtime now fails closed on collision).
15. Configure server-only `MORPHEUS_RUNTIME_URL` (and network-scoped aliases);
    remove residual WIF/private-key env from Vercel, Cloudflare, relayer, and
    feed-pusher once custody URL/token/role key IDs are live.
16. No commit/push was performed for this remediation wave; operators must
    review and land changes deliberately across sibling repositories.

17. Deploy and read back the reviewed MorpheusOracle update before enabling
    runtime encryption or verification key publication. The recorded live N3
    kernel at `0xf54d8584` has no 24-hour key timelock and its admin-only key
    setters are immediate single-signature paths. Until the deployed ABI
    contains the complete propose/cancel/execute/pending method sets, the
    publisher scripts intentionally fail closed. Do not run a key write as a
    workaround.
