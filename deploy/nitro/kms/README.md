# KMS attestation pins

The enclave's identity gate is not in this repository by default. `kms:Decrypt`
on the enclave master key is conditioned on
`kms:RecipientAttestation:ImageSha384` — the PCR0 of the EIF that is allowed to
unwrap the key material — and that condition lives in an AWS key policy inside
one account. `workers/neo-signer/src/attestation.rs:9-20` says so explicitly:
the boot guard deliberately leaves `SIGNER_SERVICE_EXPECTED_PCR0` unset because
baking a pin into the rootfs changes the PCR0 it pins, and delegates to the key
policy instead.

That is a sound design and an unverifiable one at the same time. A relying
party who wants to know which code holds the signing keys cannot read an AWS
key policy. This directory closes that gap: the policy is **exported into
version control**, and `scripts/check-nitro-measurements.mjs` asserts that its
`ImageSha384` equals the `pcr0` of a committed manifest under
`../measurements/`.

## Files

| File                    | What it is                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `attestation-pins.json` | The index: which CMK gates which enclave, and which release it pins.                 |
| `<alias>.policy.json`   | The exported AWS key policy, verbatim. One per CMK named in `attestation-pins.json`. |

### `attestation-pins.json`

```jsonc
{
  "required_app_ids": ["morpheus-oracle", "morpheus-custody"],
  "pins": [
    {
      "app_id": "morpheus-oracle", // must match the manifest's app_id
      "key_alias": "alias/morpheus-enclave-master",
      "key_arn": "arn:aws:kms:us-east-1:...:key/...",
      "policy_file": "morpheus-enclave-master.policy.json",
      "pinned_release": "oracle-enclave-exec-2026-06-15.9", // measurements/<release>.json
    },
  ],
  "unpublished": [
    {
      "app_id": "morpheus-custody",
      "reason": "why no pin exists yet, with the evidence",
      "blocked_on": "the concrete command or access that unblocks it",
      "required_by": "YYYY-MM-DD", // past due is a hard CI failure
      "owner": "who owns it",
    },
  ],
}
```

Every id in `required_app_ids` must appear in exactly one of `pins` or
`unpublished`. Neither is a hard failure; both is a hard failure (one record is
stale). An `unpublished` entry whose `required_by` has passed is a hard failure
too — the record is a dated commitment, not a permanent exemption.

## Publishing a pin

On a machine with KMS read access to the key:

```bash
aws kms get-key-policy \
  --key-id alias/morpheus-enclave-master \
  --policy-name default \
  --output text \
  > deploy/nitro/kms/morpheus-enclave-master.policy.json
```

`--output text` yields the policy document itself (the JSON string), not the
API envelope. Commit it byte-for-byte; do not hand-edit it, because the point of
the file is that it is what AWS actually enforces.

Then add the matching entry to `pins`, drop the `unpublished` record, and run:

```bash
npm run check:nitro-measurements
```

The gate refuses an `ImageSha384` that is the all-zero placeholder, that is not
a 96-character SHA-384 digest, that sits on a `Deny` statement, or that differs
from the pinned manifest's `pcr0`.

## Rotation order (CL-13)

Publish, then activate — never the reverse:

1. Build the EIF with the default reproducibility check and commit the new
   manifest (`reproducible_verified: true`).
2. Commit the updated key policy export and the `pins` entry in the same change,
   so the new PCR0 is readable before it is live.
3. Roll the KMS condition and the running enclave.
4. Move the verifier pin (`apps/web/lib/nitro-measurements.ts`) last.

A client that sees step 1-2 land can distinguish a legitimate upgrade from a key
substitution. A client that only sees step 3 cannot.

## What is deliberately not here

No key material, no ciphertext, no credentials. A KMS key policy is a public
authorization statement about a key; it is not a secret, and keeping it secret
is what made the measurement pin uncheckable in the first place.
