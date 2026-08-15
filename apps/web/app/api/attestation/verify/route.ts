import { verifyAttestation } from '@/lib/attestation';
import {
  verifyNitroAttestationDocument,
  type NitroVerificationResult,
} from '@/lib/nitro-attestation';
import { recordOperationLog } from '@/lib/operation-logs';
import { badRequest } from '@/lib/api-helpers';
import { createRateLimitedHandler } from '@/lib/rate-limit';
import { ACTIVE_NITRO_MEASUREMENT } from '@/lib/nitro-measurements';

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
    // Never trust PCR values supplied by the caller. They are only useful as a
    // stale-client consistency check; the cryptographic verifier always compares
    // against this reviewed, committed manifest.
    const callerPcrs = {
      pcr0: optionalString(body.expected_pcr0),
      pcr1: optionalString(body.expected_pcr1),
      pcr2: optionalString(body.expected_pcr2),
    };
    const callerPcrMismatch = Object.entries(callerPcrs).some(
      ([key, value]) =>
        value &&
        value.replace(/^0x/i, '').toLowerCase() !==
          ACTIVE_NITRO_MEASUREMENT[key as 'pcr0' | 'pcr1' | 'pcr2']
    );
    if (callerPcrMismatch) {
      const response = badRequest(
        'requested PCRs do not match the active Nitro manifest',
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
        responsePayload: { error: 'PCR_PIN_MISMATCH', release: ACTIVE_NITRO_MEASUREMENT.release },
        httpStatus: 400,
        error: 'requested PCRs do not match active manifest',
      });
      return response;
    }
    const expectedPcrs = {
      pcr0: ACTIVE_NITRO_MEASUREMENT.pcr0,
      pcr1: ACTIVE_NITRO_MEASUREMENT.pcr1,
      pcr2: ACTIVE_NITRO_MEASUREMENT.pcr2,
    };

    let nitro: NitroVerificationResult | null = null;
    let nitroError: string | null = null;
    if (attestationDocument) {
      try {
        nitro = await verifyNitroAttestationDocument(attestationDocument, {
          expectedPcrs,
          expectedUserDataHex: optionalString(body.expected_user_data_hex),
          expectedSignerPublicKey: optionalString(body.expected_signer_public_key),
          nonce: optionalString(body.nonce),
        });
      } catch (error) {
        nitroError = error instanceof Error ? error.message : String(error);
      }
    }
    const measurementChainVerified = Boolean(nitro?.measurement_chain_verified);

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
      nitroMeasurementChainVerified: measurementChainVerified,
    });

    const result = {
      ...hashBinding,
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
            pinned_release: ACTIVE_NITRO_MEASUREMENT.release,
          }
        : null,
      nitro_attestation_error: nitroError,
      pinned_nitro_release: ACTIVE_NITRO_MEASUREMENT.release,
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
