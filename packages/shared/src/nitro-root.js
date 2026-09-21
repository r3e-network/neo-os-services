import { createHash, X509Certificate } from 'node:crypto';

/**
 * Pinned AWS Nitro Enclaves attestation ROOT trust anchor — the single source of
 * truth for every Node-side verifier in this repo.
 *
 * SECURITY (CL-01): an attestation verifier that takes its trust anchor from a
 * host environment variable, with "unset means skip", is not a verifier — a host
 * that supplies a root it controls can self-issue attestation documents that pass.
 * The anchor therefore ships INLINE here, its DER SHA-256 is asserted against
 * AWS_NITRO_ROOT_FINGERPRINTS_SHA256 at module load, and any operator-supplied
 * override must hash to one of the same pinned fingerprints or it is rejected.
 *
 * The canonical, reviewable PEM copy lives at
 * `apps/web/lib/attestation/aws-nitro-root.pem`; `nitro-root.test.mjs` asserts this
 * constant, that file, and `apps/web/lib/nitro-attestation.ts` all agree byte-for-byte,
 * so the copies cannot drift.
 */

/**
 * DER SHA-256 fingerprints of every accepted AWS Nitro Enclaves root, lowercase hex.
 * Published by AWS. On a G1->G2 rotation ADD an entry; never replace one, or every
 * in-flight document signed under the previous root stops verifying.
 * @type {readonly string[]}
 */
export const AWS_NITRO_ROOT_FINGERPRINTS_SHA256 = Object.freeze([
  '641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b', // AWS Nitro Enclaves Root G1
]);

/** Pinned AWS Nitro Enclaves Root G1 certificate (PEM). */
export const AWS_NITRO_ROOT_G1_PEM = `-----BEGIN CERTIFICATE-----
MIICETCCAZagAwIBAgIRAPkxdWgbkK/hHUbMtOTn+FYwCgYIKoZIzj0EAwMwSTEL
MAkGA1UEBhMCVVMxDzANBgNVBAoMBkFtYXpvbjEMMAoGA1UECwwDQVdTMRswGQYD
VQQDDBJhd3Mubml0cm8tZW5jbGF2ZXMwHhcNMTkxMDI4MTMyODA1WhcNNDkxMDI4
MTQyODA1WjBJMQswCQYDVQQGEwJVUzEPMA0GA1UECgwGQW1hem9uMQwwCgYDVQQL
DANBV1MxGzAZBgNVBAMMEmF3cy5uaXRyby1lbmNsYXZlczB2MBAGByqGSM49AgEG
BSuBBAAiA2IABPwCVOumCMHzaHDimtqQvkY4MpJzbolL//Zy2YlES1BR5TSksfbb
48C8WBoyt7F2Bw7eEtaaP+ohG2bnUs990d0JX28TcPQXCEPZ3BABIeTPYwEoCWZE
h8l5YoQwTcU/9KNCMEAwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUkCW1DdkF
R+eWw5b6cp3PmanfS5YwDgYDVR0PAQH/BAQDAgGGMAoGCCqGSM49BAMDA2kAMGYC
MQCjfy+Rocm9Xue4YnwWmNJVA44fA0P5W2OpYow9OYCVRaEevL8uO1XYru5xtMPW
rfMCMQCi85sWBbJwKKXdS6BptQFuZbT73o/gBh1qUxl/nNr12UO8Yfwr6wPLb+6N
IwLz3/Y=
-----END CERTIFICATE-----`;

const PEM_CERTIFICATE_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

/** Lowercase hex DER SHA-256 of a certificate's raw bytes. */
export function certificateFingerprintSha256(der) {
  return createHash('sha256').update(der).digest('hex');
}

/**
 * Split a PEM bundle into its individual certificate blocks. Returns [] when the
 * input contains no BEGIN/END CERTIFICATE block at all.
 * @param {string} pem
 * @returns {string[]}
 */
export function splitPemCertificates(pem) {
  if (typeof pem !== 'string') return [];
  return pem.match(PEM_CERTIFICATE_BLOCK) || [];
}

/**
 * Assert that `pem` contains only certificates whose DER SHA-256 is a pinned AWS
 * Nitro root fingerprint, and return it unchanged. Throws otherwise — an override
 * that is not the AWS root is an attempt to move the trust anchor, which must fail
 * closed rather than silently become the anchor.
 *
 * @param {string} pem
 * @param {{ source?: string }} [options] `source` names the origin in the error.
 * @returns {string} the same PEM, once verified
 */
export function assertPinnedNitroRootPem(pem, options = {}) {
  const source = options.source || 'AWS Nitro root certificate';
  const blocks = splitPemCertificates(pem);
  if (blocks.length === 0) {
    throw new Error(
      `${source}: contains no PEM CERTIFICATE block — refusing to use it as a trust anchor`
    );
  }
  for (const block of blocks) {
    let cert;
    try {
      cert = new X509Certificate(block);
    } catch {
      throw new Error(`${source}: certificate is malformed — refusing to use it as a trust anchor`);
    }
    const fingerprint = certificateFingerprintSha256(cert.raw);
    if (!AWS_NITRO_ROOT_FINGERPRINTS_SHA256.includes(fingerprint)) {
      throw new Error(
        `${source}: DER SHA-256 ${fingerprint} is not a pinned AWS Nitro Enclaves root ` +
          `(expected one of ${AWS_NITRO_ROOT_FINGERPRINTS_SHA256.join(', ')}) — refusing to use it ` +
          'as a trust anchor'
      );
    }
  }
  return pem;
}

// Fail closed at load if the inlined constant above ever drifts from the pinned
// fingerprint list (mirrors deploy/custody-state-authority/src/attestation.mjs:41).
assertPinnedNitroRootPem(AWS_NITRO_ROOT_G1_PEM, { source: 'inlined AWS_NITRO_ROOT_G1_PEM' });
