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
  const measurementChainVerified = input.nitroMeasurementChainVerified === true;
  // `full_attestation_ok` now REQUIRES the cryptographic Nitro layer: the hash
  // binding holds, metadata matches, AND the COSE/cert/PCR/binding chain
  // verified. Quote/event_log presence alone no longer flips this true.
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
      : 'enclave-key-signed; measurement chain NOT verified (no/invalid Nitro attestation document)',
    measurement_chain_verified: measurementChainVerified,
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
