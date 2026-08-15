export function normalizeHex(value: unknown) {
  const normalized = String(value || '')
    .trim()
    .replace(/^0x/i, '')
    .toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : '';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value: unknown, maxLength = 4096) {
  const text = String(value ?? '').trim();
  return text && text.length <= maxLength ? text : null;
}

function normalizeFixedHex(value: unknown, hexLength: number) {
  const normalized = String(value || '')
    .trim()
    .replace(/^0x/i, '')
    .toLowerCase();
  return normalized.length === hexLength && /^[0-9a-f]+$/.test(normalized) ? normalized : '';
}

function hasSignedHashEvidence(input: Record<string, unknown>, targetHash: string) {
  const outputHash = normalizeHex(input.output_hash);
  const attestationHash = normalizeHex(input.attestation_hash);
  const signature = normalizeFixedHex(input.signature, 128);
  const publicKey = normalizeFixedHex(input.public_key, 66);

  return (
    outputHash === targetHash &&
    attestationHash === targetHash &&
    Boolean(signature) &&
    /^(02|03)/.test(publicKey)
  );
}

type EnvelopeMatch = {
  envelope: Record<string, unknown>;
  priority: 1 | 2;
};

function findSignedEnvelope(
  input: unknown,
  targetHash: string,
  depth: number,
  budget: { remaining: number }
): EnvelopeMatch | null {
  budget.remaining -= 1;
  if (budget.remaining < 0 || depth > 12) return null;

  if (Array.isArray(input)) {
    let best: EnvelopeMatch | null = null;
    for (const entry of input) {
      const found = findSignedEnvelope(entry, targetHash, depth + 1, budget);
      if (found?.priority === 2) return found;
      if (!best && found) best = found;
    }
    return best;
  }

  if (!isPlainObject(input)) return null;

  const verification = isPlainObject(input.verification) ? input.verification : null;
  if (verification && hasSignedHashEvidence(verification, targetHash)) {
    return { envelope: input, priority: 2 };
  }

  let best: EnvelopeMatch | null = hasSignedHashEvidence(input, targetHash)
    ? { envelope: input, priority: 1 }
    : null;
  for (const value of Object.values(input)) {
    const found = findSignedEnvelope(value, targetHash, depth + 1, budget);
    if (found?.priority === 2) return found;
    if (!best && found) best = found;
  }
  return best;
}

export function extractEnvelopeByAttestationHash(
  input: unknown,
  targetHash: string,
  depth = 0,
  budget = { remaining: 5000 }
): Record<string, unknown> | null {
  const normalizedTarget = normalizeHex(targetHash);
  if (!normalizedTarget) return null;
  return findSignedEnvelope(input, normalizedTarget, depth, budget)?.envelope || null;
}

export function buildVerifierInput(envelope: Record<string, unknown>, fallbackHash: string) {
  const verification = isPlainObject(envelope.verification) ? envelope.verification : {};
  const teeAttestation =
    (isPlainObject(verification.tee_attestation) ? verification.tee_attestation : null) ||
    (isPlainObject(envelope.tee_attestation) ? envelope.tee_attestation : null) ||
    (isPlainObject(envelope.attestation) ? envelope.attestation : null) ||
    null;

  const safeAttestation = teeAttestation
    ? Object.fromEntries(
        ['report_data', 'compose_hash', 'app_id', 'instance_id', 'device_id', 'app_name']
          .map((key) => [key, safeString(teeAttestation[key])])
          .filter(([, value]) => value)
      )
    : null;
  const attestationDocument =
    safeString(envelope.attestation_document, 192 * 1024) ||
    safeString(teeAttestation?.attestation_document, 192 * 1024);
  const outputHash = safeString(verification.output_hash || envelope.output_hash, 128);
  const attestationHash =
    safeString(verification.attestation_hash || envelope.attestation_hash, 128) ||
    `0x${fallbackHash}`;
  const safeEnvelope = {
    verification: {
      output_hash: outputHash,
      attestation_hash: attestationHash,
      tee_attestation: safeAttestation,
    },
    ...(attestationDocument ? { attestation_document: attestationDocument } : {}),
  };

  return {
    envelope: safeEnvelope,
    attestation: safeAttestation,
    expected_output_hash: outputHash,
    expected_attestation_hash: attestationHash,
    expected_compose_hash:
      String((teeAttestation as Record<string, unknown> | null)?.compose_hash || '').trim() || null,
    expected_app_id:
      String((teeAttestation as Record<string, unknown> | null)?.app_id || '').trim() || null,
    expected_instance_id:
      String((teeAttestation as Record<string, unknown> | null)?.instance_id || '').trim() || null,
  };
}
