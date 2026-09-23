import crypto from 'node:crypto';
import { wallet as neonWallet } from '@cityofzion/neon-js';

import { parseBooleanEnv, trimString } from '@r3e-network/neo-os-services-shared/utils';
import { decodeCoseSign1 } from '@r3e-network/neo-os-services-shared/cbor';
import {
  buildCoseSign1SigStructure,
  coseEs384SignatureToDer,
} from '@r3e-network/neo-os-services-shared/cose-verify';
import {
  AWS_NITRO_ROOT_G1_PEM,
  assertPinnedNitroRootPem,
} from '@r3e-network/neo-os-services-shared/nitro-root';
import { normalizeErrorMessage } from './feed-sync.js';
import {
  NEO_N3_PLAINTEXT_KEY_RETIRED_CODE,
  resolvePinnedNeoN3VerifierPublicKey,
} from './lib/neo-signers.js';

export function normalizePublicKey(value) {
  return trimString(value).replace(/^0x/i, '').toLowerCase();
}

// CBOR / COSE_Sign1 DECODING (decodeCoseSign1) is single-sourced in
// @r3e-network/neo-os-services-shared/cbor, shared with the enclave server that PRODUCES
// these documents, so producer and verifier agree on indefinite-length CBOR.
//
// The Sig_structure ENCODER (buildCoseSign1SigStructure / cborEncodeSigStructure) and
// the ES384 raw(r||s)->DER converter (coseEs384SignatureToDer) are now ALSO single-sourced
// in @r3e-network/neo-os-services-shared/cose-verify. Previously they were verifier-only helpers
// duplicated here, in apps/web/lib/nitro-attestation.ts, and re-inlined in the shared
// cbor test — three copies that could drift silently. A Nitro NSM attestation document
// is a COSE_Sign1 (CBOR array [protected, unprotected, payload(bstr), signature]); the
// payload is a CBOR map with the measured `pcrs`, `user_data`, `public_key`, `nonce` that
// the relayer reads to VERIFY (C1) the document binds the digest + matches the pinned PCR0.

// The AWS Nitro attestation certificate chain (cabundle + leaf) lives in the COSE
// payload map: `certificate` (leaf, DER bstr) and `cabundle` (array of DER bstr,
// root-first). Return the chain leaf-first as DER buffers, or null when absent.
function extractAttestationCertChain(payload) {
  const leaf = payload.certificate;
  const cabundle = Array.isArray(payload.cabundle) ? payload.cabundle : [];
  if (!Buffer.isBuffer(leaf)) return null;
  const intermediates = cabundle.filter(Buffer.isBuffer);
  return { leaf, intermediates };
}

// COSE_Sign1 ES384 signature + certificate-chain verification against a pinned AWS
// Nitro root certificate. Returns one of:
//   { verified: true }                     — signature + chain to the pinned root OK
//   { verified: false, checked: false }    — not checkable (no cert chain in the
//                                            document / placeholder signature). The
//                                            caller MUST NOT treat this as attested.
//                                            The root itself is always pinned (see
//                                            resolveNitroRootCertPem), so "no anchor"
//                                            is no longer one of these cases.
//   throws                                 — a real, checkable signature/chain that
//                                            FAILS verification (forged document)
function verifyCoseSign1Crypto(rootCertPem, cose, payload) {
  if (!trimString(rootCertPem)) return { verified: false, checked: false };
  const chain = extractAttestationCertChain(payload);
  if (!chain) return { verified: false, checked: false };
  const der = coseEs384SignatureToDer(cose.signature);
  if (!der) return { verified: false, checked: false };

  let leafCert;
  let rootCert;
  let intermediateCerts;
  try {
    const { X509Certificate } = crypto;
    leafCert = new X509Certificate(chain.leaf);
    rootCert = new X509Certificate(rootCertPem);
    intermediateCerts = chain.intermediates.map((der509) => new X509Certificate(der509));
  } catch {
    // Malformed certs in a doc we were ASKED to verify (root pinned) is a hard fail.
    throw new Error(
      'invalid signature: enclave attestation certificate chain is malformed — refusing to submit'
    );
  }

  // Chain validation: each cert must be issued by the next; the top must chain to
  // the pinned root. AWS publishes the chain root-first in cabundle, leaf separate.
  const ordered = [leafCert, ...intermediateCerts.slice().reverse()];
  for (let i = 0; i < ordered.length; i += 1) {
    const issuer = ordered[i + 1] || rootCert;
    if (!ordered[i].verify(issuer.publicKey)) {
      throw new Error(
        'invalid signature: enclave attestation certificate chain does not verify to the pinned ' +
          'AWS Nitro root — refusing to submit'
      );
    }
  }
  // The top intermediate (or the leaf, if no intermediates) must chain to the root.
  const topCert = ordered[ordered.length - 1];
  if (topCert !== rootCert && !topCert.verify(rootCert.publicKey)) {
    throw new Error(
      'invalid signature: enclave attestation certificate chain does not verify to the pinned ' +
        'AWS Nitro root — refusing to submit'
    );
  }

  // COSE_Sign1 signature over the Sig_structure using the LEAF cert's P-384 key.
  const sigStructure = buildCoseSign1SigStructure(cose.protectedHeaderBytes, cose.payloadBytes);
  let ok = false;
  try {
    ok = crypto.verify(
      'sha384',
      sigStructure,
      { key: leafCert.publicKey, dsaEncoding: 'der' },
      der
    );
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new Error(
      'invalid signature: enclave attestation COSE_Sign1 ES384 signature does not verify against ' +
        'the leaf certificate — refusing to submit'
    );
  }
  return { verified: true, checked: true };
}

// The PCR0 the live enclave is pinned to. Sourced from MORPHEUS_EXPECTED_PCR0 (or
// config.nitro.expectedPcr0). When unset, PCR0 cannot be asserted — the relayer
// still verifies the digest binding but cannot claim the document came from the
// expected measured image, so trust is downgraded. Lowercase hex, no 0x.
export function resolveExpectedPcr0(config) {
  return normalizePublicKey(
    trimString(config?.nitro?.expectedPcr0 || '') ||
      trimString(process.env.MORPHEUS_EXPECTED_PCR0 || '')
  );
}

// Whether the enclave signature cross-check (digest-sig) is enabled. Resolved from
// config.nitro.verifyEnclaveSignature (an explicit boolean there is authoritative —
// that is the operator's documented opt-out) and otherwise from
// MORPHEUS_RELAYER_VERIFY_ENCLAVE_SIGNATURE, read directly so it is operable without
// a config.js change. SECURITY (SVC-A-4): the fallback default is ON in production,
// matching how config.js:597-600 and crates/neo-os-core/src/config.rs:1331-1337
// already resolve the same key, so a partially-built config can no longer silently
// downgrade a production relayer to no cross-check. Outside production it stays
// opt-in, and resolveAttestationMaxAgeMs below hardens the same way.
export function enclaveSignatureVerificationEnabled(config) {
  const configured = config?.nitro?.verifyEnclaveSignature;
  if (typeof configured === 'boolean') return configured;
  if (configured) return true;
  return parseBooleanEnv(
    process.env.MORPHEUS_RELAYER_VERIFY_ENCLAVE_SIGNATURE,
    process.env.NODE_ENV === 'production'
  );
}

/**
 * Verify the enclave attestation document (C1) against the relayer's INDEPENDENTLY
 * recomputed fulfillment digest. Returns { attested, reason, pcr0 }:
 *   - attested true  => the document proves the result was produced inside the
 *     measured enclave (user_data == sha256(localDigest) AND, when a PCR0 is
 *     pinned, the document's PCR0 matches it).
 *   - attested false => attestation absent or unprovable; the caller MUST NOT label
 *     the result enclave-attested (it downgrades trust_tier). `reason` explains why.
 *
 * Backward-compatible: when no attestation doc is present (today's enclave images
 * pre-cutover) this returns attested:false WITHOUT throwing, so the lane keeps
 * fulfilling. A doc that IS present but binds the WRONG digest (or wrong PCR0 when
 * one is pinned) is a HARD failure — the caller treats it like a digest mismatch
 * and refuses to submit.
 */
// Pinned AWS Nitro attestation ROOT certificate (PEM). The relayer verifies the
// COSE_Sign1 ES384 signature + the document's chain up to this root before it may
// claim `attested:true`.
//
// SECURITY (SVC-A-4, CL-01): the anchor is PINNED IN CODE — it defaults to
// AWS_NITRO_ROOT_G1_PEM, whose DER SHA-256 the shared module asserts against
// AWS_NITRO_ROOT_FINGERPRINTS_SHA256 at load. There is deliberately no
// "unset means skip" branch any more: a host that left MORPHEUS_NITRO_ROOT_CERT_PEM
// unset previously got no signature or chain verification at all, and a host that
// set it to a root of its own got forged documents verified as attested. An
// operator override is still accepted (so a G1->G2 rotation can be staged from
// config), but only when it hashes to a pinned fingerprint; anything else is a hard
// error rather than a new trust anchor.
export function resolveNitroRootCertPem(config) {
  const fromConfig = trimString(config?.nitro?.nitroRootCertPem || '');
  if (fromConfig) {
    return assertPinnedNitroRootPem(fromConfig, { source: 'config nitro.nitroRootCertPem' });
  }
  const fromEnv = trimString(process.env.MORPHEUS_NITRO_ROOT_CERT_PEM || '');
  if (fromEnv) {
    return assertPinnedNitroRootPem(fromEnv, { source: 'MORPHEUS_NITRO_ROOT_CERT_PEM' });
  }
  return AWS_NITRO_ROOT_G1_PEM;
}

// Maximum accepted age (ms) of an attestation document's echoed timestamp. 0 (the
// default) disables the timestamp-age gate; the nonce-echo binding is the primary
// anti-replay control. Sourced from config.nitro.attestationMaxAgeMs or
// MORPHEUS_ATTESTATION_MAX_AGE_MS. SECURITY (S9): in production an unset value
// falls back to a 10-minute freshness window (fail closed against stale/replayed
// attestation documents) instead of disabling the gate.
export function resolveAttestationMaxAgeMs(config) {
  const fromConfig = Number(config?.nitro?.attestationMaxAgeMs);
  if (Number.isFinite(fromConfig) && fromConfig > 0) return fromConfig;
  const fromEnv = Number(process.env.MORPHEUS_ATTESTATION_MAX_AGE_MS || 0);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  if (process.env.NODE_ENV === 'production') return 600_000;
  return 0;
}

export function verifyEnclaveAttestation(config, body, localDigestHex, options = {}) {
  const docBase64 = trimString(body?.attestation_doc_base64 || '');
  if (!docBase64) {
    return { attested: false, reason: 'no attestation document', pcr0: '' };
  }
  let cose;
  let payload;
  try {
    cose = decodeCoseSign1(Buffer.from(docBase64, 'base64'));
    payload = cose.payload;
  } catch (error) {
    return {
      attested: false,
      reason: `attestation parse failed: ${normalizeErrorMessage(error)}`,
      pcr0: '',
    };
  }
  // user_data MUST commit to sha256(the relayer-recomputed digest bytes). A doc that
  // commits to a DIFFERENT digest is an active attempt to attest a result the relayer
  // did not compute — treat it as a hard failure (throw), not a downgrade.
  const userData = Buffer.isBuffer(payload.user_data)
    ? payload.user_data.toString('hex')
    : normalizePublicKey(payload.user_data || '');
  const expectedUserData = crypto
    .createHash('sha256')
    .update(Buffer.from(localDigestHex, 'hex'))
    .digest('hex');
  if (userData && userData !== expectedUserData) {
    throw new Error(
      'invalid signature: enclave attestation user_data does not bind the fulfillment digest ' +
        `(doc=${userData} expected=${expectedUserData}) — refusing to submit`
    );
  }
  if (!userData) {
    return { attested: false, reason: 'attestation document has no user_data binding', pcr0: '' };
  }

  // FRESHNESS / ANTI-REPLAY (a): when the relayer supplied a per-request nonce AND the
  // document carries a nonce, the document MUST echo that exact nonce. A
  // captured-but-genuine document for the same digest carries a DIFFERENT (older)
  // nonce, so a mismatch is a replay attempt — hard fail. Backward compatibility: a
  // pre-cutover enclave image that does NOT echo a nonce leaves the doc nonce empty;
  // we cannot prove freshness then, so the nonce-echo gate stays inert (the
  // digest+PCR0 binding below still applies). Once the enclave echoes nonces, a
  // replayed doc (wrong nonce) is rejected.
  const expectedNonce = normalizePublicKey(options.expectedNonce || '');
  const docNonce = Buffer.isBuffer(payload.nonce)
    ? payload.nonce.toString('hex')
    : normalizePublicKey(payload.nonce || '');
  if (expectedNonce && docNonce && docNonce !== expectedNonce) {
    throw new Error(
      'invalid signature: enclave attestation nonce does not echo the relayer-supplied nonce ' +
        `(doc=${docNonce} expected=${expectedNonce}) — refusing to submit (possible replay)`
    );
  }

  // FRESHNESS / ANTI-REPLAY (a, timestamp): when a max-age is configured AND the
  // document carries a timestamp, reject a document whose timestamp is older than the
  // window (stale/replayed). NSM timestamps are epoch milliseconds. A future-dated
  // doc beyond a small skew is also rejected. No timestamp / no max-age => inert.
  const maxAgeMs = resolveAttestationMaxAgeMs(config);
  if (maxAgeMs > 0) {
    const docTimestampMs = Number(payload.timestamp);
    if (Number.isFinite(docTimestampMs) && docTimestampMs > 0) {
      const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
      const ageMs = now - docTimestampMs;
      const FUTURE_SKEW_MS = 60_000;
      if (ageMs > maxAgeMs || ageMs < -FUTURE_SKEW_MS) {
        throw new Error(
          'invalid signature: enclave attestation timestamp is outside the freshness window ' +
            `(age_ms=${ageMs} max_ms=${maxAgeMs}) — refusing to submit (possible replay)`
        );
      }
    }
  }

  // COSE_Sign1 signature + certificate-chain verification (b). The AWS Nitro root is
  // always pinned (resolveNitroRootCertPem), so whenever the document carries a real
  // certificate chain + a 96-byte ES384 signature the COSE_Sign1 signature and the
  // chain up to that root ARE verified. A document that FAILS this crypto check is
  // NOT attested — it is a forged/tampered structure and a hard failure (throw). When
  // the document carries no cert chain / a placeholder signature, fulfillment may
  // continue for compatibility, but it MUST remain host-unattested. PCR fields inside
  // an unsigned payload are attacker-controlled and can never establish enclave trust.
  const cryptoResult = verifyCoseSign1Crypto(resolveNitroRootCertPem(config), cose, payload);

  // PCR0 binding: the document must come from the pinned measured image. When a
  // PCR0 is configured we ASSERT it (a mismatch is a hard failure — wrong/forged
  // image). When none is configured we cannot prove the image, so we do not claim
  // enclave-attested (downgrade) but keep submitting.
  const pcrs = payload.pcrs && typeof payload.pcrs === 'object' ? payload.pcrs : {};
  const docPcr0 = Buffer.isBuffer(pcrs['0'])
    ? pcrs['0'].toString('hex')
    : normalizePublicKey(pcrs['0'] || pcrs.pcr0 || '');
  const expectedPcr0 = resolveExpectedPcr0(config);
  if (expectedPcr0) {
    if (!docPcr0 || docPcr0 !== expectedPcr0) {
      throw new Error(
        'invalid signature: enclave attestation PCR0 does not match the pinned measurement ' +
          `(doc=${docPcr0 || 'missing'} expected=${expectedPcr0}) — refusing to submit`
      );
    }
    if (!cryptoResult.verified) {
      return {
        attested: false,
        reason:
          'attestation digest and PCR0 matched but COSE signature/certificate chain was not verified',
        pcr0: docPcr0,
        cose_verified: false,
      };
    }
    return {
      attested: true,
      reason: 'attested (digest + PCR0 + COSE signature/chain verified)',
      pcr0: docPcr0,
      cose_verified: true,
    };
  }
  // Digest binding verified, but PCR0 not pinned -> cannot prove the measured image.
  return {
    attested: false,
    reason: 'attestation digest verified but no MORPHEUS_EXPECTED_PCR0 pinned',
    pcr0: docPcr0,
    cose_verified: Boolean(cryptoResult.verified),
  };
}

// Verify the enclave's secp256r1 signature over the relayer-recomputed digest using
// the on-chain-pinned oracle_verifier public key (the digest-sig cross-check). Only
// runs for neo_n3/legacy when a pinned verifier pubkey is configured; otherwise it
// is a no-op (returns {checked:false}) so deployments that have not pinned a verifier
// key keep fulfilling. A returned public_key that differs from the pinned key, or a
// signature that does NOT verify against the pinned key, is a HARD failure (throws).
export function verifyEnclaveSignatureAgainstPinnedVerifier(config, chain, body, localDigestHex) {
  if (chain !== 'neo_n3' && chain !== 'legacy') return { verified: false, checked: false };
  let pinned;
  try {
    pinned = normalizePublicKey(resolvePinnedNeoN3VerifierPublicKey(config.network, process.env));
  } catch (error) {
    // "No verifier key pinned" skips the cross-check; a plaintext verifier key
    // set on this process (S5) must not: swallowing it would turn a refused
    // configuration into a silently skipped signature check.
    if (error?.code === NEO_N3_PLAINTEXT_KEY_RETIRED_CODE) throw error;
    pinned = '';
  }
  if (!pinned) return { verified: false, checked: false };
  const returnedKey = normalizePublicKey(body?.public_key || '');
  // The enclave must sign with the pinned verifier key (the only key the on-chain
  // contract accepts). A different key would be rejected on-chain anyway; flag it.
  if (returnedKey && returnedKey !== pinned) {
    throw new Error(
      `verifier rejected signature: enclave public_key ${returnedKey} != pinned oracle_verifier ${pinned}`
    );
  }
  const signature = trimString(body?.signature || '');
  let ok = false;
  try {
    ok = neonWallet.verify(localDigestHex, signature, pinned);
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new Error(
      'invalid signature: enclave signature does not verify against the pinned oracle_verifier ' +
        'public key over the recomputed digest — refusing to submit'
    );
  }
  return { verified: true, checked: true };
}
