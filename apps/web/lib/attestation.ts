import { createHash } from 'node:crypto';

import { stableStringify } from '@r3e-network/neo-os-services-shared/utils';

function sha256Hex(value: unknown) {
  const buffer = Buffer.isBuffer(value)
    ? value
    : value instanceof Uint8Array
      ? Buffer.from(value)
      : Buffer.from(typeof value === 'string' ? value : stableStringify(value), 'utf8');
  return createHash('sha256').update(buffer).digest('hex');
}

function normalizeHex(value: unknown) {
  return String(value || '')
    .trim()
    .replace(/^0x/i, '')
    .toLowerCase();
}

function normalizeText(value: unknown) {
  const text = String(value || '').trim();
  return text || null;
}

function unwrapRecord(input: unknown) {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  if (record.worker_response && typeof record.worker_response === 'object') {
    return record.worker_response as Record<string, unknown>;
  }
  if (record.envelope && typeof record.envelope === 'object') {
    return record.envelope as Record<string, unknown>;
  }
  return record;
}

function unwrapVerification(input: unknown) {
  const record = unwrapRecord(input);
  if (!record) return null;
  if (record.verification && typeof record.verification === 'object') {
    return record.verification as Record<string, unknown>;
  }
  if (record.output_hash || record.attestation_hash || record.tee_attestation) return record;
  return null;
}

function unwrapAttestation(input: unknown) {
  const record = unwrapRecord(input);
  if (!record) return null;
  if (record.tee_attestation && typeof record.tee_attestation === 'object')
    return record.tee_attestation as Record<string, unknown>;
  if (record.attestation && typeof record.attestation === 'object')
    return record.attestation as Record<string, unknown>;
  if (
    record.report_data ||
    record.quote ||
    record.event_log ||
    record.compose_hash ||
    record.app_id
  )
    return record;
  return null;
}

function reportDataPrefix(reportData: unknown) {
  const normalized = normalizeHex(reportData);
  if (!normalized) return '';
  return normalized.slice(0, 64);
}

/** Longest binding value we will ever accept out of an envelope (512 bytes). */
const MAX_BINDING_HEX_LENGTH = 1024;

/**
 * Normalize a value that is supposed to be committed into an attestation
 * document field. Anything that is not non-empty, even-length, bounded hex
 * normalizes to '' so it can never become a "binding" that is trivially
 * satisfied.
 */
function normalizeBindingHex(value: unknown) {
  const normalized = normalizeHex(value);
  if (!normalized || normalized.length % 2 !== 0) return '';
  if (normalized.length > MAX_BINDING_HEX_LENGTH) return '';
  return /^[0-9a-f]+$/.test(normalized) ? normalized : '';
}

function firstBindingHex(candidates: unknown[]) {
  for (const candidate of candidates) {
    const normalized = normalizeBindingHex(candidate);
    if (normalized) return normalized;
  }
  return '';
}

/**
 * How an attestation DOCUMENT is tied to the envelope being verified.
 *
 * - `report_data` (STRONG): the enclave commits the result's `output_hash`
 *   into the document's `nonce` field (`build_tee_attestation` in
 *   workers/nitro-enclave-host/src/compute_execute.rs calls
 *   `handle_attestation({ report_data: output_hash })`, and
 *   `handle_attestation` routes `report_data` into the NSM `nonce`). Because
 *   `output_hash = sha256(canonical result payload)` and the relying party
 *   independently supplies the expected payload/hash to layer 1, this closes
 *   the chain result -> output_hash -> document. A document harvested from a
 *   DIFFERENT result carries a different nonce and is rejected.
 * - `fulfillment_digest` (WEAK): the enclave commits
 *   `sha256(fulfillment_digest_bytes)` into `user_data`
 *   (workers/nitro-enclave-host/src/fulfill.rs). The digest preimage is built
 *   by `neo_os_core::digest::build_fulfillment_digest_bytes` over the request
 *   envelope; this verifier cannot recompute it, so matching it proves only
 *   that the document was issued for the fulfillment the envelope DECLARES,
 *   not that the declared result is the one the enclave produced. It is
 *   therefore checked (a mismatch fails) but never reported as a verified
 *   result binding.
 * - `none`: nothing in the envelope ties it to the document.
 */
export type DocumentBindingSource = 'report_data' | 'fulfillment_digest' | 'none';

export interface DerivedDocumentBindings {
  /** Preimage hex whose sha256 the enclave commits into `user_data`. */
  userDataHex: string;
  /** Hex the enclave commits verbatim into the document `nonce`. */
  nonceHex: string;
  source: DocumentBindingSource;
  /** True only for a source that ties the document to the verified RESULT. */
  bindsResult: boolean;
}

const UNBOUND_DOCUMENT: DerivedDocumentBindings = Object.freeze({
  userDataHex: '',
  nonceHex: '',
  source: 'none',
  bindsResult: false,
});

/**
 * SECURITY (SVC-A-2): derive the document<->envelope bindings from the
 * ENVELOPE, never from a caller-supplied `expected_user_data_hex` / `nonce`
 * field. Before this existed, `/api/attestation/verify` only checked the
 * bindings a caller asked it to check, and no shipped caller asked for any —
 * so a genuine attestation document harvested from one request verified an
 * attacker-authored envelope for any other result.
 */
export function deriveDocumentBindings(input: unknown): DerivedDocumentBindings {
  const record = unwrapRecord(input);
  if (!record) return UNBOUND_DOCUMENT;
  const verification = unwrapVerification(record);
  const attestation = unwrapAttestation(record) ?? unwrapAttestation(verification);

  // STRONG first: report_data is derivable from the result itself.
  const reportData = firstBindingHex([
    attestation?.report_data,
    verification?.report_data,
    record.report_data,
  ]);
  if (reportData) {
    return { userDataHex: '', nonceHex: reportData, source: 'report_data', bindsResult: true };
  }

  const fulfillmentDigest = firstBindingHex([
    record.fulfillment_digest_hex,
    record.fulfillment_digest,
    verification?.fulfillment_digest_hex,
    verification?.fulfillment_digest,
    attestation?.fulfillment_digest_hex,
  ]);
  if (fulfillmentDigest) {
    return {
      userDataHex: fulfillmentDigest,
      // The fulfil lane echoes the request nonce into the document nonce.
      nonceHex: firstBindingHex([record.nonce, verification?.nonce]),
      source: 'fulfillment_digest',
      bindsResult: false,
    };
  }

  return UNBOUND_DOCUMENT;
}

export function verifyAttestation(input: {
  envelope?: unknown;
  verification?: unknown;
  attestation?: unknown;
  expectedPayload?: unknown;
  expectedOutputHash?: string;
  expectedAttestationHash?: string;
  expectedOnchainAttestationHash?: string;
  expectedComposeHash?: string;
  expectedAppId?: string;
  expectedInstanceId?: string;
  /**
   * Result of the REAL Nitro measurement-chain verifier
   * (`verifyNitroAttestationDocument` in `./nitro-attestation.ts`). This is the
   * authoritative cryptographic check (COSE_Sign1 + pinned AWS Nitro root cert
   * chain + PCR0/1/2 + result/nonce/signer binding). When omitted/false, the
   * measurement chain is treated as NOT verified — `full_attestation_ok` and
   * `measurement_chain_verified` REQUIRE it to be true. The legacy
   * "quote/event_log present" heuristic is no longer sufficient on its own.
   */
  nitroMeasurementChainVerified?: boolean;
  /**
   * SECURITY (SVC-A-2): true only when the verified document is tied to THIS
   * envelope's result by a binding the verifier derived from the envelope (see
   * `deriveDocumentBindings`). A verified measurement chain over an UNBOUND
   * document says nothing about the result in front of it — a genuine document
   * harvested from any other request would satisfy it — so it must never flip
   * `ok` / `full_attestation_ok` true on its own.
   */
  nitroResultBindingVerified?: boolean;
}) {
  const record = unwrapRecord(input.envelope ?? input.verification ?? input.attestation);
  const verification = unwrapVerification(input.verification ?? record ?? input.attestation);
  const attestation =
    unwrapAttestation(input.attestation) ??
    unwrapAttestation(verification) ??
    unwrapAttestation(record);
  if (!verification && !attestation) {
    return {
      ok: false,
      error: 'verification or attestation object missing',
      checks: {},
    };
  }

  const actualOutputHash = normalizeHex(verification?.output_hash);
  const actualAttestationHash = normalizeHex(verification?.attestation_hash);
  const actualReportData = normalizeHex(attestation?.report_data);
  const actualReportDataPrefix = reportDataPrefix(attestation?.report_data);
  const actualComposeHash = normalizeText(attestation?.compose_hash);
  const actualAppId = normalizeText(attestation?.app_id);
  const actualInstanceId = normalizeText(attestation?.instance_id);

  const expectedOutputHash = normalizeHex(
    input.expectedOutputHash ||
      (input.expectedPayload !== undefined ? sha256Hex(input.expectedPayload) : '')
  );
  const expectedAttestationHash = normalizeHex(
    input.expectedAttestationHash || input.expectedOnchainAttestationHash || expectedOutputHash
  );

  const bindingChecks = {
    output_hash_matches_expected:
      expectedOutputHash && actualOutputHash ? actualOutputHash === expectedOutputHash : null,
    attestation_hash_matches_expected:
      expectedAttestationHash && actualAttestationHash
        ? actualAttestationHash === expectedAttestationHash
        : null,
    attestation_hash_matches_output_hash:
      actualOutputHash && actualAttestationHash ? actualOutputHash === actualAttestationHash : null,
    report_data_prefix_matches_output_hash:
      actualReportDataPrefix && actualOutputHash
        ? actualReportDataPrefix === actualOutputHash
        : null,
    report_data_prefix_matches_attestation_hash:
      actualReportDataPrefix && actualAttestationHash
        ? actualReportDataPrefix === actualAttestationHash
        : null,
    report_data_prefix_matches_expected:
      actualReportDataPrefix && (expectedAttestationHash || expectedOutputHash)
        ? actualReportDataPrefix === (expectedAttestationHash || expectedOutputHash)
        : null,
  };

  const metadataChecks = {
    compose_hash_matches: input.expectedComposeHash
      ? actualComposeHash === normalizeText(input.expectedComposeHash)
      : null,
    app_id_matches: input.expectedAppId ? actualAppId === normalizeText(input.expectedAppId) : null,
    instance_id_matches: input.expectedInstanceId
      ? actualInstanceId === normalizeText(input.expectedInstanceId)
      : null,
  };

  const bindingFailed = Object.entries(bindingChecks)
    .filter(([, value]) => value === false)
    .map(([key]) => key);
  const metadataFailed = Object.entries(metadataChecks)
    .filter(([, value]) => value === false)
    .map(([key]) => key);

  const hasBindingEvidence = Boolean(
    actualOutputHash || actualAttestationHash || actualReportDataPrefix
  );
  const hasExpectedBinding = Boolean(expectedOutputHash || expectedAttestationHash);
  const bindingOk = hasExpectedBinding && hasBindingEvidence && bindingFailed.length === 0;
  const hasQuote = Boolean(attestation?.quote);
  const hasEventLog = Object.prototype.hasOwnProperty.call(attestation || {}, 'event_log');

  // REAL measurement-chain verification is now performed by
  // `verifyNitroAttestationDocument` (./nitro-attestation.ts) and its boolean is
  // passed in as `nitroMeasurementChainVerified`. The legacy "quote + event_log
  // present" heuristic is retained as a presence signal only — it is NEVER
  // sufficient by itself to claim a verified measurement chain.
  const measurementChainOk = input.nitroMeasurementChainVerified === true;
  const resultBindingVerified = input.nitroResultBindingVerified === true;
  // SECURITY (SVC-A-2): the reported measurement chain now means "a verified
  // chain over a document that is bound to THIS result". An unbound document
  // is reported separately (`nitro_attestation.measurement_chain_verified`)
  // and never satisfies this field.
  const measurementChainVerified = measurementChainOk && resultBindingVerified;
  // `full_attestation_ok` now REQUIRES the cryptographic Nitro layer: the hash
  // binding holds, metadata matches, AND the COSE/cert/PCR/binding chain
  // verified over a document bound to this result. Quote/event_log presence
  // alone no longer flips this true.
  const fullAttestationOk = bindingOk && metadataFailed.length === 0 && measurementChainVerified;

  return {
    // `ok` is the trust decision, not merely internal hash consistency. Callers
    // that only need the legacy binding diagnostic can read `binding_consistent`.
    ok: fullAttestationOk,
    binding_consistent: bindingOk && metadataFailed.length === 0,
    binding_ok: bindingOk,
    full_attestation_ok: fullAttestationOk,
    // Honest scope statement so API consumers do not over-trust the booleans
    // above. The hash binding is checked here; the AWS Nitro measurement chain
    // (pinned root + PCR0/1/2 + result binding) is verified by the new Nitro
    // layer and is reflected in `measurement_chain_verified`.
    attestation_scope: measurementChainVerified
      ? 'enclave-attested; AWS Nitro measurement chain verified (pinned root + PCR0/1/2 + result binding)'
      : measurementChainOk
        ? 'enclave-key-signed; AWS Nitro measurement chain verified (pinned root + PCR0/1/2) but the document is NOT bound to this result — it proves an enclave ran, not that it produced this result'
        : 'enclave-key-signed; measurement chain NOT verified (no/invalid Nitro attestation document)',
    measurement_chain_verified: measurementChainVerified,
    // Honest split of the two independent questions above.
    nitro_chain_verified: measurementChainOk,
    result_binding_verified: resultBindingVerified,
    evidence: {
      has_verification: Boolean(verification),
      has_attestation: Boolean(attestation),
      has_output_hash: Boolean(actualOutputHash),
      has_attestation_hash: Boolean(actualAttestationHash),
      has_report_data: Boolean(actualReportData),
      has_quote: hasQuote,
      has_event_log: hasEventLog,
    },
    checks: {
      ...bindingChecks,
      ...metadataChecks,
    },
    actual: {
      output_hash: actualOutputHash ? `0x${actualOutputHash}` : null,
      attestation_hash: actualAttestationHash ? `0x${actualAttestationHash}` : null,
      report_data: actualReportData ? `0x${actualReportData}` : null,
      report_data_prefix: actualReportDataPrefix ? `0x${actualReportDataPrefix}` : null,
      compose_hash: actualComposeHash,
      app_id: actualAppId,
      instance_id: actualInstanceId,
      device_id: attestation?.device_id || null,
      app_name: attestation?.app_name || null,
    },
    expected: {
      output_hash: expectedOutputHash ? `0x${expectedOutputHash}` : null,
      attestation_hash: expectedAttestationHash ? `0x${expectedAttestationHash}` : null,
      report_data_prefix:
        expectedAttestationHash || expectedOutputHash
          ? `0x${expectedAttestationHash || expectedOutputHash}`
          : null,
      compose_hash: normalizeText(input.expectedComposeHash),
      app_id: normalizeText(input.expectedAppId),
      instance_id: normalizeText(input.expectedInstanceId),
    },
    failed: [...bindingFailed, ...metadataFailed],
    note: 'Morpheus attestation_hash currently mirrors output_hash. The legacy binding check compares report_data and expected hashes; ok/full_attestation_ok additionally require the Nitro COSE signature, pinned AWS root chain, committed PCR measurements, requested bindings, and freshness checks.',
  };
}
