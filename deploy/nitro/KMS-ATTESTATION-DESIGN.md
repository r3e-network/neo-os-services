# Phase C (complete) — KMS attestation-gated key release

> **✅ DEPLOYED + END-TO-END VALIDATED (2026-06-15).** The X25519 oracle decryption key is
> released ONLY to the attested enclave via KMS. Live: EIF `oracle-enclave-exec-2026-06-15.9`
> (PCR0 `842f4f53…`); CMK `alias/morpheus-enclave-master` gates `kms:Decrypt` on
> `kms:RecipientAttestation:ImageSha384 = 842f4f53…` (trimmed to this single PCR0); the host
> provisions only the CMK CIPHERTEXT (`/var/lib/morpheus/oracle-key-kms.b64`), and the enclave
> kms-decrypts it in-TEE (`nsm-attest kms-decrypt` → `materializeOracleKeyFromKms`).
>
> ⚠️ **An earlier note here claimed "validated" off a `/oracle/fulfill` envelope-format error —
> that was a FALSE POSITIVE.** The attested `kms-decrypt` was in fact failing (see the CMS-BER
> gotcha below) and the key was silently falling back to a host keystore, so it was NOT in-TEE.
> GENUINE validation now: the key materializes in-TEE (`key_source` from the KMS ciphertext,
> durable across reboots), is published on the mainnet kernel, and a full client round-trip
> (fetch on-chain key → encrypt → submit → `success:true module_id confidential.decrypt`)
> passes. Both host-resident keystores were shredded; the host instance role CANNOT decrypt the
> ciphertext (no matching attestation).
>
> 🐞 **CMS-BER gotcha (the real Phase-C blocker, fixed 2026-06-15).** AWS KMS returns the Nitro
> `CiphertextForRecipient` CMS EnvelopedData as **indefinite-length BER** with a **segmented
> `[0]` OCTET STRING** `encryptedContent`. Go's `encoding/asn1` is DER-only and rejected it
> ("indefinite length found (not DER)"), so `nsm-attest`'s CMS parse failed and every
> attestation-gated decrypt fell back to a host key. Fixed in `deploy/nitro/nsm-attest/cms.go`:
> `berToDER()` transcodes BER→DER and `concatOctetSegments()` joins the segmented OCTET STRING
> (stdlib only; unit-tested). This applies to ANY KMS-sealed key the enclave materializes.
>
> **Remaining for FULL "no key on host" closure** (the old host-accessible copy still exists):
>
> 1. **Rotate** the X25519 key (the current key was historically host-exposed) — generate a
>    fresh key, KMS-encrypt under the CMK, provision the new ciphertext, **retain the old key**
>    for payloads already sealed to the old pubkey.
> 2. **Delete the host keystore** `/data/morpheus/oracle-key.json` (kept for now as the
>    rollback fallback: `rm /var/lib/morpheus/oracle-key-kms.b64` + restart → plaintext path).
> 3. **Scope the EC2 instance role off** the Secrets-Manager wrap-key/neodid masters — coupled
>    to moving the **neodid salt** to the same KMS-attested path (it's still SM-derived).
> 4. Security: **rotate the supplied AWS access key**; remove inline IAM policy
>    `morpheus-kms-attestation-admin` from `codex-morpheus-deploy`.

**Goal:** only the _attested_ enclave can unwrap the confidential keys (X25519 oracle
decryption key, neodid salt master, Neo N3 wrap key). The host — even with the EC2
instance role + IMDS creds + the on-disk keystore — **cannot**. This is the true
"no private key on the host" guarantee (the vsock-proxy step alone leaves the host able
to re-derive; KMS attestation closes that).

## AWS infra — PROVISIONED (2026-06-15)

Admin creds (`iam user codex-morpheus-deploy`, acct 736326664265, IAMFullAccess + KMS
PowerUser) were supplied and used to provision:

- **CMK created:** `arn:aws:kms:us-east-1:736326664265:key/5d9b6835-6976-4fd9-92ba-5db5176d7c3a`,
  alias `alias/morpheus-enclave-master` (symmetric ENCRYPT_DECRYPT).
- **Key policy set:** root full (mgmt); `codex-morpheus-deploy` Encrypt/ReEncrypt/Describe/
  Get+PutKeyPolicy/GenerateDataKey; **`MorpheusNitroRelayerInstanceRole` kms:Decrypt
  conditioned on `kms:RecipientAttestation:ImageSha384`** — currently a **PLACEHOLDER
  all-zero PCR0** (nothing can decrypt yet). Encrypt verified working.
- An inline IAM policy `morpheus-kms-attestation-admin` was added to the deploy user for
  kms:Encrypt/PutKeyPolicy + iam:PutRolePolicy (remove after the work).

**Remaining AWS steps (after the KMS-capable EIF exists):** replace the placeholder PCR0
in the key policy `EnclaveAttestedDecrypt` statement with the real EIF PCR0; encrypt the
X25519 key material under the CMK; (after cutover) remove the instance role's
Secrets-Manager master access.

> 🔴 The supplied access key is in chat history — **deactivate/rotate it** after this work.

## Approach

AWS KMS `Decrypt` conditioned on **`kms:RecipientAttestation`**. The enclave sends a
Nitro attestation document with the `Decrypt` call; KMS verifies it + the PCR condition,
then returns the plaintext **encrypted to the enclave's public key** (from the
attestation) as `CiphertextForRecipient`, which only the enclave can open (NSM private
key). The host cannot produce a valid attestation, so its `Decrypt` is denied.

## Components

1. **KMS CMK** (symmetric, "morpheus-enclave-master"). Key policy allows `kms:Decrypt`
   for the instance role **only** when
   `kms:RecipientAttestation:ImageSha384` (PCR0) == the deployed EIF's PCR0
   (optionally also PCR1/PCR2). Without the condition match, Decrypt is denied.
2. **Ciphertext key material.** The X25519 keystore's wrap key (or the key material
   directly) re-encrypted under the CMK; the ciphertext is provisioned to the enclave
   (env/keystore — it's ciphertext, safe).
3. **Enclave KMS-decrypt** — two implementation options:
   - **(a) `@aws-sdk/client-kms` + NSM (recommended, fewer moving parts):** the enclave
     generates an attestation with an ephemeral RSA pubkey via `/dev/nsm`, calls
     `Decrypt({ CiphertextBlob, Recipient:{ AttestationDocument, KeyEncryptionAlgorithm:
'RSAES_OAEP_SHA_256' } })`, and decrypts `CiphertextForRecipient` with the NSM
     private key. Egress via the existing vsock proxy (kms.us-east-1 already allow-listed;
     the SDK fetch-transport fix `a90122b` makes the SDK honor it). Needs the
     `@aws-sdk/client-kms` dep + NSM RSA glue (extend `nsm-attest`).
   - **(b) `kmstool-enclave-cli`** (AWS Nitro SDK, Rust): handles attestation+Decrypt,
     talks to a host `kmstool-instance`/`vsock-proxy`. Needs the tool built into the EIF +
     a host KMS vsock-proxy service. More standard, more infra.
4. **IAM scoping:** remove `secretsmanager:GetSecretValue` for the masters from the
   instance role (so the host can't read them); keep `kms:Decrypt` (gated by the policy).

## Deployment sequence (resolves the PCR chicken-and-egg)

1. **[admin]** Create the CMK; policy grants the instance role `kms:Decrypt` (PCR
   condition added in step 3).
2. Build the EIF with the enclave KMS-decrypt code → record PCR0.
3. **[admin]** Update the key policy: condition `kms:Decrypt` on
   `kms:RecipientAttestation:ImageSha384 = <EIF PCR0>`.
4. Encrypt the key material under the CMK → provision the ciphertext to the enclave.
5. Cutover to the new EIF (auto-rollback) → enclave attests + KMS-decrypts in-TEE →
   validate decrypt works.
6. **[admin]** Remove the SM master access from the instance role.
7. Rotate the X25519 key (host-exposed historically), retaining the old key for
   decrypting payloads already sealed to the old pubkey.

## What I can implement now (no AWS admin)

- The enclave KMS-decrypt module (option a): `@aws-sdk/client-kms` dep + the NSM
  attestation-with-pubkey + `Decrypt`+`Recipient` + CiphertextForRecipient open;
  wire it into `loadStableOracleKeyMaterial` as a new source (before the env-sealed path).
- A mocked unit test (KMS returns a known CiphertextForRecipient → enclave opens it).
- The provisioning change to carry the CMK ciphertext.
  This stays dormant until the CMK exists (step 1) + the EIF cutover (step 5).

## Foundation already shipped (this session)

- `a90122b` — enclave AWS SDK egresses via the vsock proxy (so it can reach KMS/SM itself).
- `b0a0cf5` — enclave unseals a ciphertext keystore from env in-TEE (round-trip tested).
  KMS attestation replaces the _wrap-key source_ (KMS-attested instead of SM-derived);
  the in-TEE unseal plumbing is reused.
