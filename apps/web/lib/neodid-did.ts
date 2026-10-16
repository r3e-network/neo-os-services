import 'server-only';

import { createHash, ECDH } from 'node:crypto';
import { appConfig } from './config';
import { NETWORKS } from './onchain-data';
import {
  DEFAULT_NEODID_SERVICE_DID,
  DID_RESOLUTION_ERROR_INVALID_DID,
  DID_RESOLUTION_ERROR_INVALID_VERIFICATION_KEY,
  MORPHEUS_DID_METHOD,
  MORPHEUS_NEODID_DID_CONTEXT,
  MORPHEUS_NEODID_NETWORK,
  MORPHEUS_NEODID_SERVICE,
  buildNeoDidServiceDid,
} from './neodid-did-common';
import type { DidResolutionErrorCode } from './neodid-did-common';

export {
  DID_RESOLUTION_ERROR_INVALID_DID,
  DID_RESOLUTION_ERROR_INVALID_VERIFICATION_KEY,
} from './neodid-did-common';
export type { DidResolutionErrorCode } from './neodid-did-common';

const DID_DOCUMENT_CONTENT_TYPE = 'application/did+ld+json';
const DID_RESOLUTION_CONTENT_TYPE = 'application/ld+json;profile="https://w3id.org/did-resolution"';

type DidKind = 'service' | 'vault' | 'aa';

type ParsedMorpheusDid = {
  did: string;
  kind: DidKind;
  network: string;
  subject: string;
};

type NeoDidRuntimeSnapshot = {
  app_id?: string | null;
  compose_hash?: string | null;
  verification_public_key?: string | null;
  verifier_curve?: string | null;
  web3auth?: {
    jwks_url?: string | null;
    audience_configured?: boolean;
    derives_provider_uid_in_tee?: boolean;
  } | null;
};

type ResolveDidOptions = {
  accept?: string | null;
  format?: string | null;
  origin: string;
};

type ResolveDidResult = {
  body: Record<string, unknown>;
  contentType: string;
  status: number;
};

function base64Url(buffer: Buffer) {
  return buffer.toString('base64url');
}

// SECURITY (S13): DID documents must never reflect the request Host header into
// their absolute URLs (an attacker-supplied Host would let the "trusted"
// resolver/viewer URLs point at their own domain). The canonical origin is
// always appConfig.appUrl; a caller-supplied origin is accepted only when its
// hostname matches the configured app URL host.
function normalizeOrigin(origin: string) {
  const canonical = appConfig.appUrl.replace(/\/$/, '');
  const trimmed = String(origin || '')
    .trim()
    .replace(/\/$/, '');
  if (!trimmed) return canonical;
  try {
    const requestedHost = new URL(trimmed).hostname.toLowerCase();
    const canonicalHost = new URL(canonical).hostname.toLowerCase();
    if (requestedHost === canonicalHost) return trimmed;
  } catch {
    // Unparseable origin: fall through to the canonical app URL.
  }
  return canonical;
}

function decodeDidSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// The runtime snapshot arrives as JSON from another service. Keep the declared
// types only, so a malformed response cannot leak an object or a number into
// the resolution metadata or into the document's runtime endpoint.
function runtimeText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function runtimeRecord(value: unknown): unknown {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

// Pre-coerced display fields for the #runtime service endpoint. The service
// builder takes this narrow shape rather than the raw snapshot, so it cannot
// read `runtime.verification_public_key` and derive anything from key material
// the guard has not already accepted as a JWK.
type RuntimeEcho = {
  app_id: string | null;
  compose_hash: string | null;
  verification_public_key: string | null;
  verifier_curve: string | null;
  web3auth: unknown;
};

function toRuntimeEcho(runtime: NeoDidRuntimeSnapshot | null): RuntimeEcho {
  return {
    app_id: runtimeText(runtime?.app_id),
    compose_hash: runtimeText(runtime?.compose_hash),
    verification_public_key: runtimeText(runtime?.verification_public_key),
    verifier_curve: runtimeText(runtime?.verifier_curve) ?? 'secp256r1',
    web3auth: runtimeRecord(runtime?.web3auth),
  };
}

// Check UTF-16 code units without requiring the newer String.isWellFormed API.
// A high surrogate must consume exactly one following low surrogate.
function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (!(trailing >= 0xdc00 && trailing <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function parseMorpheusDid(rawDid: string): ParsedMorpheusDid | null {
  if (typeof rawDid !== 'string') return null;
  const trimmed = String(rawDid || '').trim();
  if (!trimmed) return null;

  const parts = trimmed.split(':');
  if (parts.length < 5 || parts[0] !== 'did' || parts[1] !== MORPHEUS_DID_METHOD) {
    return null;
  }

  const network = String(parts[2] || '').toLowerCase();
  const kind = String(parts[3] || '').toLowerCase() as DidKind;
  const subject = decodeDidSegment(parts.slice(4).join(':'));

  if (network !== MORPHEUS_NEODID_NETWORK) return null;
  if (!['service', 'vault', 'aa'].includes(kind)) return null;

  if (kind === 'service') {
    const normalizedService = subject.toLowerCase();
    if (normalizedService !== MORPHEUS_NEODID_SERVICE) return null;
    return {
      did: buildNeoDidServiceDid(normalizedService),
      kind,
      network,
      subject: normalizedService,
    };
  }

  if (kind === 'vault') {
    const normalizedHash = subject.replace(/^0x/i, '').toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(normalizedHash)) return null;
    return {
      did: `did:${MORPHEUS_DID_METHOD}:${network}:vault:${normalizedHash}`,
      kind,
      network,
      subject: normalizedHash,
    };
  }

  const normalizedAccountId = subject.trim();
  if (
    !normalizedAccountId ||
    !isWellFormedUtf16(normalizedAccountId) ||
    Buffer.byteLength(normalizedAccountId, 'utf8') > 160
  )
    return null;
  return {
    did: `did:${MORPHEUS_DID_METHOD}:${network}:aa:${encodeURIComponent(normalizedAccountId)}`,
    kind,
    network,
    subject: normalizedAccountId,
  };
}

async function fetchNeoDidRuntimeSnapshot(): Promise<NeoDidRuntimeSnapshot | null> {
  const runtimeUrl = appConfig.publicNitroApiUrls[0] || appConfig.nitroApiUrl;
  if (!runtimeUrl) return null;
  const headers = new Headers({ accept: 'application/json' });
  if (appConfig.nitroToken) {
    headers.set('authorization', `Bearer ${appConfig.nitroToken}`);
    headers.set('x-nitro-token', appConfig.nitroToken);
  }

  try {
    const response = await fetch(`${runtimeUrl.replace(/\/$/, '')}/neodid/runtime`, {
      method: 'GET',
      headers,
      cache: 'no-store',
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

type VerificationJwk = {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  kid: string;
};

// Three-way outcome of the single verification-key derivation. 'absent' means
// no key is configured (declared-types policy: missing, null, or a non-string
// is not a key); 'accepted' carries the only JWK any builder may publish;
// 'refused' is the DEC-DS-17 typed refusal for key material that is present
// but unusable — including a present empty string, which is a declaration of
// a key that cannot work, not an absent one.
type VerificationKeyOutcome =
  | { status: 'absent' }
  | { status: 'accepted'; jwk: VerificationJwk }
  | {
      status: 'refused';
      code: typeof DID_RESOLUTION_ERROR_INVALID_VERIFICATION_KEY;
      message: string;
    };

const COMPRESSED_P256_POINT = /^(02|03)[0-9a-fA-F]{64}$/;
const INVALID_KEY_MESSAGE =
  'verification_public_key must be a compressed P-256 point that lies on the curve.';

// Guard around the curve derivation (DEC-DS-17). A present key that is not a
// usable compressed P-256 point — malformed encoding, off the curve, or empty
// after normalization — is bad data: refuse it with a stable code instead of
// throwing out of the document builder or silently dropping the key and serving
// a weaker document. The conversion call is bounded (one regex, one
// ECDH.convertKey on 33 bytes), and every failure of that call maps to the same
// refusal code.
function compressedP256ToJwk(compressedHex: unknown): VerificationKeyOutcome {
  // Declared-types policy: only a string is a key.
  if (typeof compressedHex !== 'string') {
    return { status: 'absent' };
  }
  // Normalize with the intent to accept: trim incidental whitespace first so
  // the conventional 0x prefix is still seen, then strip it, then trim again
  // in case whitespace hid behind the prefix.
  const normalized = compressedHex.trim().replace(/^0x/i, '').trim();
  // An empty or whitespace-only string (and the prefix-only form) is a present
  // declaration of a key that cannot work — the "present but unusable" class.
  // Refuse it; never fall through to ECDH.convertKey on an empty buffer, which
  // does not throw and would mint a garbage JWK.
  if (!normalized) {
    return {
      status: 'refused',
      code: DID_RESOLUTION_ERROR_INVALID_VERIFICATION_KEY,
      message: INVALID_KEY_MESSAGE,
    };
  }
  if (!COMPRESSED_P256_POINT.test(normalized)) {
    return {
      status: 'refused',
      code: DID_RESOLUTION_ERROR_INVALID_VERIFICATION_KEY,
      message: INVALID_KEY_MESSAGE,
    };
  }

  const compressed = Buffer.from(normalized, 'hex');
  let converted;
  try {
    converted = ECDH.convertKey(compressed, 'prime256v1', undefined, undefined, 'uncompressed');
  } catch {
    // A syntactically well-formed compressed point that is not on the curve.
    return {
      status: 'refused',
      code: DID_RESOLUTION_ERROR_INVALID_VERIFICATION_KEY,
      message: INVALID_KEY_MESSAGE,
    };
  }
  const uncompressed = Buffer.isBuffer(converted) ? converted : Buffer.from(converted, 'binary');
  const x = uncompressed.subarray(1, 33);
  const y = uncompressed.subarray(33, 65);

  return {
    status: 'accepted',
    jwk: {
      kty: 'EC',
      crv: 'P-256',
      x: base64Url(x),
      y: base64Url(y),
      kid: base64Url(createHash('sha256').update(compressed).digest()),
    },
  };
}

function buildResolutionMetadata(contentType: string) {
  return {
    contentType,
  };
}

function buildCommonDocumentMetadata(
  parsed: ParsedMorpheusDid,
  runtime: NeoDidRuntimeSnapshot | null
) {
  return {
    canonicalId: parsed.did,
    versionId: runtimeText(runtime?.compose_hash) ?? 'unversioned',
    network: parsed.network,
    anchorContract: NETWORKS.neo_n3.neodid,
  };
}

function buildServiceDidDocument(
  parsed: ParsedMorpheusDid,
  runtimeEcho: RuntimeEcho,
  origin: string,
  verificationJwk: VerificationJwk | null
) {
  const did = parsed.did;
  const publicRuntimeUrl = appConfig.publicNitroApiUrls[0] || appConfig.nitroApiUrl;
  const resolverUrl = `${origin}/api/neodid/resolve?did=${encodeURIComponent(did)}`;
  // The JWK is derived once, at the guard, and only an accepted key reaches
  // this builder. This function takes a narrow display echo rather than the
  // raw runtime snapshot, so nothing downstream can derive from key material.
  const verificationMethodId = `${did}#tee-verifier`;
  const verificationMethod = verificationJwk
    ? [
        {
          id: verificationMethodId,
          type: 'JsonWebKey2020',
          controller: did,
          publicKeyJwk: verificationJwk,
        },
      ]
    : [];
  const verificationReferences = verificationMethod.length > 0 ? [verificationMethodId] : [];

  return {
    '@context': [...MORPHEUS_NEODID_DID_CONTEXT],
    id: did,
    controller: [did],
    verificationMethod,
    authentication: verificationReferences,
    assertionMethod: verificationReferences,
    service: [
      {
        id: `${did}#resolver`,
        type: 'DIDResolutionService',
        serviceEndpoint: resolverUrl,
      },
      {
        id: `${did}#registry`,
        type: 'MorpheusNeoDIDRegistry',
        serviceEndpoint: {
          network: parsed.network,
          contract: NETWORKS.neo_n3.neodid,
          nns: NETWORKS.neo_n3.domains.neodid,
          read_methods: [
            'getBinding',
            'getClaimCommitment',
            'isMasterNullifierUsed',
            'isActionNullifierUsed',
          ],
          write_methods: ['registerBindingCommitment', 'revokeBinding', 'useActionTicket'],
        },
      },
      {
        id: `${did}#oracle-entry`,
        type: 'MorpheusOracleGateway',
        serviceEndpoint: {
          network: parsed.network,
          contract: NETWORKS.neo_n3.oracle,
          nns: NETWORKS.neo_n3.domains.oracle,
          request_types: ['neodid_bind', 'neodid_action_ticket', 'neodid_recovery_ticket'],
          fee_model: '0.01 GAS prepaid credit per request',
        },
      },
      {
        id: `${did}#runtime`,
        type: 'MorpheusNeoDIDRuntime',
        serviceEndpoint: {
          runtime_url: publicRuntimeUrl
            ? `${publicRuntimeUrl.replace(/\/$/, '')}/neodid/runtime`
            : '',
          viewer_url: `${origin}/launchpad/neodid-resolver?did=${encodeURIComponent(did)}`,
          documentation_url: `${origin}/docs/neodid`,
          app_id: runtimeEcho.app_id,
          compose_hash: runtimeEcho.compose_hash,
          verification_public_key: runtimeEcho.verification_public_key,
          verifier_curve: runtimeEcho.verifier_curve,
          web3auth: runtimeEcho.web3auth,
        },
      },
    ],
  };
}

function buildSubjectDidDocument(parsed: ParsedMorpheusDid, origin: string) {
  const did = parsed.did;
  const subjectKind = parsed.kind;
  const subjectDescriptor =
    subjectKind === 'vault'
      ? { vault_hash160: `0x${parsed.subject}` }
      : { account_id: parsed.subject };

  return {
    '@context': [...MORPHEUS_NEODID_DID_CONTEXT],
    id: did,
    controller: [DEFAULT_NEODID_SERVICE_DID],
    service: [
      {
        id: `${did}#resolver`,
        type: 'DIDResolutionService',
        serviceEndpoint: `${origin}/api/neodid/resolve?did=${encodeURIComponent(did)}`,
      },
      {
        id: `${did}#binding-model`,
        type: 'MorpheusNeoDIDSubject',
        serviceEndpoint: {
          network: parsed.network,
          subject_kind: subjectKind,
          ...subjectDescriptor,
          privacy_model:
            'public DID document only exposes subject namespace and service endpoints; provider_uids, master nullifiers, and encrypted inputs stay off-chain or encrypted',
          registry_contract: NETWORKS.neo_n3.neodid,
          registry_nns: NETWORKS.neo_n3.domains.neodid,
          oracle_contract: NETWORKS.neo_n3.oracle,
          oracle_nns: NETWORKS.neo_n3.domains.oracle,
          resolution_hint:
            'Use neodid_bind, neodid_action_ticket, or neodid_recovery_ticket through MorpheusOracle.request; do not expect raw identity claims in DID resolution output.',
        },
      },
      {
        id: `${did}#recovery`,
        type: 'MorpheusAARecovery',
        serviceEndpoint: {
          aa_contract: NETWORKS.neo_n3.aa,
          aa_nns: NETWORKS.neo_n3.domains.aa,
          recovery_spec: `${origin}/docs/r/AA_SOCIAL_RECOVERY`,
          did_method_spec: `${origin}/docs/r/NEODID_DID_METHOD`,
        },
      },
    ],
  };
}

function prefersDidDocument(accept: string | null | undefined, format: string | null | undefined) {
  const normalizedFormat = String(format || '')
    .trim()
    .toLowerCase();
  if (normalizedFormat === 'document') return true;
  return String(accept || '')
    .toLowerCase()
    .includes(DID_DOCUMENT_CONTENT_TYPE);
}

function buildResolutionRefusal(error: DidResolutionErrorCode, message: string): ResolveDidResult {
  return {
    status: 400,
    contentType: DID_RESOLUTION_CONTENT_TYPE,
    body: {
      didResolutionMetadata: {
        error,
        message,
        contentType: DID_RESOLUTION_CONTENT_TYPE,
      },
      didDocument: null,
      didDocumentMetadata: {},
    },
  };
}

export async function resolveMorpheusDid(
  did: string,
  options: ResolveDidOptions
): Promise<ResolveDidResult> {
  const parsed = parseMorpheusDid(did);
  if (!parsed) {
    return buildResolutionRefusal(
      DID_RESOLUTION_ERROR_INVALID_DID,
      'Expected did:morpheus:neo_n3:service:neodid, did:morpheus:neo_n3:vault:<hash160>, or did:morpheus:neo_n3:aa:<account-id>.'
    );
  }

  const runtime = await fetchNeoDidRuntimeSnapshot();
  const origin = normalizeOrigin(options.origin);
  const wantsDocument = prefersDidDocument(options.accept, options.format);
  const contentType = wantsDocument ? DID_DOCUMENT_CONTENT_TYPE : DID_RESOLUTION_CONTENT_TYPE;

  let didDocument: Record<string, unknown>;
  if (parsed.kind === 'service') {
    // Derive once, at the guard. An unusable key refuses the whole resolution:
    // nothing that depends on the key is derived or served (DEC-DS-17).
    const keyOutcome = compressedP256ToJwk(runtime?.verification_public_key);
    if (keyOutcome.status === 'refused') {
      return buildResolutionRefusal(keyOutcome.code, keyOutcome.message);
    }
    didDocument = buildServiceDidDocument(
      parsed,
      toRuntimeEcho(runtime),
      origin,
      keyOutcome.status === 'accepted' ? keyOutcome.jwk : null
    );
  } else {
    didDocument = buildSubjectDidDocument(parsed, origin);
  }

  if (wantsDocument) {
    return {
      status: 200,
      contentType,
      body: didDocument,
    };
  }

  return {
    status: 200,
    contentType,
    body: {
      didResolutionMetadata: buildResolutionMetadata(contentType),
      didDocument,
      didDocumentMetadata: buildCommonDocumentMetadata(parsed, runtime),
    },
  };
}
