import {
  deriveDocumentBindings,
  verifyAttestation,
  type DerivedDocumentBindings,
} from '@/lib/attestation';
import {
  decodeNitroAttestationDocument,
  verifyNitroAttestationDocument,
  type NitroVerificationResult,
} from '@/lib/nitro-attestation';
import { recordOperationLog } from '@/lib/operation-logs';
import { badRequest } from '@/lib/api-helpers';
import { createRateLimitedHandler } from '@/lib/rate-limit';
import {
  UNVERIFIED_NITRO_MEASUREMENT,
  classifyNitroMeasurement,
  nitroMeasurementPins,
  type NitroImageMeasurement,
  type NitroMeasurementClassification,
  type NitroPcrs,
} from '@/lib/nitro-measurements';

const MAX_ATTESTATION_REQUEST_BYTES = 256 * 1024;

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Pull the raw base64 attestation document out of any of the shapes a caller
 * might send it in (top-level, nested under attestation/tee_attestation, or
 * inside a worker_response/envelope).
 */
function extractAttestationDocument(body: Record<string, unknown>): string | undefined {
  const candidates: unknown[] = [
    body.attestation_document,
    body.attestation_document_b64,
    // The fulfil lane names it `attestation_doc_base64`
    // (workers/nitro-enclave-host/src/fulfill.rs).
    body.attestation_doc_base64,
    (body.envelope as Record<string, unknown> | undefined)?.attestation_doc_base64,
    (body.worker_response as Record<string, unknown> | undefined)?.attestation_doc_base64,
    (body.attestation as Record<string, unknown> | undefined)?.attestation_document,
    (body.tee_attestation as Record<string, unknown> | undefined)?.attestation_document,
    (body.envelope as Record<string, unknown> | undefined)?.attestation_document,
    (body.worker_response as Record<string, unknown> | undefined)?.attestation_document,
  ];
  for (const candidate of candidates) {
    const value = optionalString(candidate);
    if (value) return value;
  }
  return undefined;
}

/**
 * SECURITY (SVC-A-2): find the document<->envelope binding by walking the same
 * envelope shapes layer 1 accepts. The caller's own `expected_user_data_hex` /
 * `nonce` fields are NEVER a source here — they may only agree with what the
 * envelope already says (see the conflict check in the handler).
 */
function deriveBindingsFromBody(body: Record<string, unknown>): DerivedDocumentBindings {
  const candidates: unknown[] = [
    body.envelope,
    body.worker_response,
    body.callback_result,
    body.response,
    body.verification,
    body.attestation,
    body.tee_attestation,
    body,
  ];
  let weakest: DerivedDocumentBindings | null = null;
  for (const candidate of candidates) {
    const derived = deriveDocumentBindings(candidate);
    if (derived.bindsResult) return derived;
    if (!weakest && derived.source !== 'none') weakest = derived;
  }
  return weakest ?? deriveDocumentBindings(undefined);
}

function normalizeBindingInput(value: unknown) {
  return String(value ?? '')
    .trim()
    .replace(/^0x/i, '')
    .toLowerCase();
}

/**
 * The PCRs a document claims, read without verifying it. Used only to pick
 * which pin to verify it against; the verifier then proves AWS signed them.
 */
function claimedPcrs(documentB64: string): NitroPcrs | null {
  try {
    const pcrs = decodeNitroAttestationDocument(documentB64).pcrs;
    return {
      pcr0: pcrs.get(0)?.toString('hex') ?? null,
      pcr1: pcrs.get(1)?.toString('hex') ?? null,
      pcr2: pcrs.get(2)?.toString('hex') ?? null,
    };
  } catch {
    return null;
  }
}

/** A document proves its PCRs only once its signature and AWS chain verify. */
function measurementOf(nitro: NitroVerificationResult | null): NitroMeasurementClassification {
  const authentic =
    nitro !== null &&
    nitro.cose_signature_ok &&
    nitro.cert_chain_ok &&
    nitro.root_pinned_ok &&
    nitro.document?.digest === 'SHA384' &&
    Boolean(nitro.document?.module_id);
  return authentic ? classifyNitroMeasurement(nitro.document ?? {}) : UNVERIFIED_NITRO_MEASUREMENT;
}

const handlePost = createRateLimitedHandler(
  async function POST(request: Request) {
    const declaredLength = Number(request.headers.get('content-length') || 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_ATTESTATION_REQUEST_BYTES) {
      return badRequest('attestation request body too large', 413, 'PAYLOAD_TOO_LARGE');
    }
    const rawBody = await request.text().catch(() => '');
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_ATTESTATION_REQUEST_BYTES) {
      return badRequest('attestation request body too large', 413, 'PAYLOAD_TOO_LARGE');
    }
    const body = (() => {
      try {
        return rawBody ? JSON.parse(rawBody) : null;
      } catch {
        return null;
      }
    })();
    if (!body || typeof body !== 'object') {
      const response = badRequest('invalid JSON body');
      await recordOperationLog({
        route: '/api/attestation/verify',
        method: 'POST',
        category: 'attestation',
        requestPayload: body,
        responsePayload: { error: 'invalid JSON body' },
        httpStatus: 400,
        error: 'invalid JSON body',
      });
      return response;
    }

    // ----- Layer 2 (new): REAL Nitro measurement chain (COSE + cert chain + PCR + binding). -----
    // Run first so its verified flag feeds the layer-1 verifier's redefined
    // `full_attestation_ok` / `measurement_chain_verified`.
    const attestationDocument = extractAttestationDocument(body as Record<string, unknown>);
    // The pin per network is the newest committed release whose git_commit a ref
    // reaches (lib/nitro-measurements.ts). It may be empty: then nothing verifies.
    const pins = nitroMeasurementPins();
    const pinnedReleases = {
      mainnet: pins.mainnet?.release ?? null,
      testnet: pins.testnet?.release ?? null,
    };
    // Never trust PCR values supplied by the caller. They are only useful as a
    // stale-client consistency check; the cryptographic verifier always compares
    // against a reviewed, committed pin.
    const callerPcrs = {
      pcr0: optionalString(body.expected_pcr0),
      pcr1: optionalString(body.expected_pcr1),
      pcr2: optionalString(body.expected_pcr2),
    };
    const statedPcrs = (['pcr0', 'pcr1', 'pcr2'] as const).filter((key) => callerPcrs[key]);
    const callerPcrMismatch =
      statedPcrs.length > 0 &&
      !Object.values(pins).some(
        (pin) =>
          pin &&
          statedPcrs.every(
            (key) => String(callerPcrs[key]).replace(/^0x/i, '').toLowerCase() === pin[key]
          )
      );
    if (callerPcrMismatch) {
      const response = badRequest(
        'requested PCRs do not match a pinned Nitro release',
        400,
        'PCR_PIN_MISMATCH'
      );
      await recordOperationLog({
        route: '/api/attestation/verify',
        method: 'POST',
        category: 'attestation',
        requestPayload: {
          ...body,
          expected_pcr0: '[redacted]',
          expected_pcr1: '[redacted]',
          expected_pcr2: '[redacted]',
        },
        responsePayload: { error: 'PCR_PIN_MISMATCH', pinned_releases: pinnedReleases },
        httpStatus: 400,
        error: 'requested PCRs do not match a pinned release',
      });
      return response;
    }
    // Verify against the pin of the network whose committed manifest carries the
    // document's claimed PCRs. A document matching no manifest, or a network
    // with nothing pinned, is verified against no PCRs and cannot pass.
    const claimed = attestationDocument ? claimedPcrs(attestationDocument) : null;
    const claimedMeasurement = claimed ? classifyNitroMeasurement(claimed) : null;
    const claimedNetwork = claimedMeasurement?.network ?? null;
    // A shared image never picks a network from caller metadata. Only a unique
    // selected image identity supplies PCRs; old/ambiguous dual tuples have no fallback.
    const comparedPin: NitroImageMeasurement | null = claimedMeasurement?.networks
      ? claimedMeasurement.verdict === 'reproducible-match'
        ? (Object.values(pins).find((pin) => pin?.release === claimedMeasurement.release) ?? null)
        : null
      : claimedNetwork
        ? pins[claimedNetwork]
        : null;
    const expectedPcrs = comparedPin
      ? { pcr0: comparedPin.pcr0, pcr1: comparedPin.pcr1, pcr2: comparedPin.pcr2 }
      : {};

    // ----- SECURITY (SVC-A-2): document <-> envelope binding, derived. -----
    // The bindings that tie the attestation document to the envelope in front
    // of us come from the ENVELOPE, never from an optional caller field. A
    // caller may still send `expected_user_data_hex` / `nonce`, but they may
    // only agree with the derived value (a disagreement is a hard 400) or add
    // a check where the envelope offers none — they can never MANUFACTURE a
    // binding claim, which is what made a harvested genuine document verify an
    // attacker-authored envelope.
    const derivedBindings = deriveBindingsFromBody(body as Record<string, unknown>);
    const callerUserDataHex = normalizeBindingInput(body.expected_user_data_hex);
    const callerNonce = normalizeBindingInput(body.nonce);
    const bindingConflict =
      (derivedBindings.userDataHex &&
        callerUserDataHex &&
        callerUserDataHex !== derivedBindings.userDataHex) ||
      (derivedBindings.nonceHex && callerNonce && callerNonce !== derivedBindings.nonceHex);
    if (bindingConflict) {
      const response = badRequest(
        'expected_user_data_hex/nonce disagree with the bindings carried by the envelope',
        400,
        'BINDING_CONFLICT'
      );
      await recordOperationLog({
        route: '/api/attestation/verify',
        method: 'POST',
        category: 'attestation',
        requestPayload: { binding_source: derivedBindings.source },
        responsePayload: { error: 'BINDING_CONFLICT' },
        httpStatus: 400,
        error: 'caller-supplied binding conflicts with the envelope',
      });
      return response;
    }
    // Derived first; a caller value is only ever an ADDITIONAL required check.
    const expectedUserDataHex = derivedBindings.userDataHex || callerUserDataHex || undefined;
    const expectedNonce = derivedBindings.nonceHex || callerNonce || undefined;

    let nitro: NitroVerificationResult | null = null;
    let nitroError: string | null = null;
    if (attestationDocument) {
      try {
        nitro = await verifyNitroAttestationDocument(attestationDocument, {
          expectedPcrs,
          expectedUserDataHex,
          expectedSignerPublicKey: optionalString(body.expected_signer_public_key),
          nonce: expectedNonce,
        });
      } catch (error) {
        nitroError = error instanceof Error ? error.message : String(error);
      }
    }
    // What the verified document says about the image that produced it. Freshness
    // and bindings do not enter into it; they decide acceptance below. The chain
    // can only verify against a pin, so only a reproducible-match is accepted.
    const measurement = attestationDocument ? measurementOf(nitro) : null;
    const nitroChainVerified = Boolean(nitro?.measurement_chain_verified);
    // A verified chain over a document that is not bound to THIS result proves
    // an enclave ran, not that it produced the result being verified.
    const dualImage = comparedPin?.network === null || Boolean(measurement?.networks);
    // No dual network/result proof protocol is supported in this release.
    const resultBindingVerified =
      !dualImage &&
      nitroChainVerified &&
      derivedBindings.bindsResult &&
      (derivedBindings.userDataHex ? Boolean(nitro?.user_data_bound_ok) : true) &&
      (derivedBindings.nonceHex ? Boolean(nitro?.nonce_match) : true);

    // ----- Layer 1 (legacy): output_hash <-> result hash binding + metadata. -----
    // `full_attestation_ok` / `measurement_chain_verified` REQUIRE layer 2.
    const hashBinding = verifyAttestation({
      envelope: body.envelope ?? body.worker_response ?? body.callback_result ?? body.response,
      verification: body.verification,
      attestation:
        body.attestation ??
        body.envelope ??
        body.worker_response ??
        body.callback_result ??
        body.response,
      expectedPayload: body.expected_payload,
      expectedOutputHash:
        typeof body.expected_output_hash === 'string' ? body.expected_output_hash : undefined,
      expectedAttestationHash:
        typeof body.expected_attestation_hash === 'string'
          ? body.expected_attestation_hash
          : undefined,
      expectedOnchainAttestationHash:
        typeof body.expected_onchain_attestation_hash === 'string'
          ? body.expected_onchain_attestation_hash
          : undefined,
      expectedComposeHash:
        typeof body.expected_compose_hash === 'string' ? body.expected_compose_hash : undefined,
      expectedAppId: typeof body.expected_app_id === 'string' ? body.expected_app_id : undefined,
      expectedInstanceId:
        typeof body.expected_instance_id === 'string' ? body.expected_instance_id : undefined,
      nitroMeasurementChainVerified: nitroChainVerified,
      nitroResultBindingVerified: resultBindingVerified,
    });

    const result = {
      ...hashBinding,
      ...(dualImage
        ? {
            network_binding_checked: false,
            network_binding_verified: false,
            full_attestation_ok: false,
            ok: false,
          }
        : {}),
      result_binding_source: derivedBindings.source,
      // Named so a consumer can tell "we could not check" from "it failed".
      result_binding_checked: derivedBindings.source !== 'none',
      nitro_attestation: nitro
        ? {
            cose_signature_ok: nitro.cose_signature_ok,
            cert_chain_ok: nitro.cert_chain_ok,
            root_pinned_ok: nitro.root_pinned_ok,
            pcr0_match: nitro.pcr0_match,
            pcr1_match: nitro.pcr1_match,
            pcr2_match: nitro.pcr2_match,
            user_data_bound_ok: nitro.user_data_bound_ok,
            public_key_bound_ok: nitro.public_key_bound_ok,
            nonce_match: nitro.nonce_match,
            timestamp_fresh: nitro.timestamp_fresh,
            measurement_chain_verified: nitro.measurement_chain_verified,
            errors: nitro.errors,
            document: nitro.document,
            pinned_release: comparedPin?.release ?? null,
          }
        : null,
      nitro_attestation_error: nitroError,
      // reproducible-match | measured-but-unreproducible | mismatch; null when
      // the request carried no document to measure.
      measurement_verdict: measurement?.verdict ?? null,
      measurement,
      pinned_nitro_release: comparedPin?.release ?? null,
      pinned_nitro_releases: pinnedReleases,
    };

    const status = result.full_attestation_ok ? 200 : 400;
    await recordOperationLog({
      route: '/api/attestation/verify',
      method: 'POST',
      category: 'attestation',
      requestPayload: body,
      responsePayload: result,
      httpStatus: status,
      error: result.ok ? null : 'attestation verification failed',
    });
    return Response.json(result, { status });
  },
  // SECURITY (S17): attestation verification is CPU-heavy (COSE signature,
  // cert chain, PCR comparisons); cap anonymous callers so it cannot be used as
  // a free DoS surface.
  { scope: 'attestation_verify', maxRequests: 15, windowMs: 60_000 }
);

export async function POST(request: Request) {
  return handlePost(request);
}
