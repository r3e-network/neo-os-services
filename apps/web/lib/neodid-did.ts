import 'server-only';

import { createHash, ECDH } from 'node:crypto';
import { appConfig } from './config';
import { NETWORKS } from './onchain-data';
import {
  DEFAULT_NEODID_SERVICE_DID,
  MORPHEUS_DID_METHOD,
  MORPHEUS_NEODID_DID_CONTEXT,
  MORPHEUS_NEODID_NETWORK,
  MORPHEUS_NEODID_SERVICE,
  buildNeoDidServiceDid,
} from './neodid-did-common';

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

function parseMorpheusDid(rawDid: string): ParsedMorpheusDid | null {
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
  if (!normalizedAccountId || Buffer.byteLength(normalizedAccountId, 'utf8') > 160) return null;
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

function compressedP256ToJwk(compressedHex: string) {
  const normalized = String(compressedHex || '')
    .replace(/^0x/i, '')
    .trim();
  if (!/^(02|03)[0-9a-fA-F]{64}$/.test(normalized)) return null;

  const compressed = Buffer.from(normalized, 'hex');
  const converted = ECDH.convertKey(compressed, 'prime256v1', undefined, undefined, 'uncompressed');
  const uncompressed = Buffer.isBuffer(converted) ? converted : Buffer.from(converted, 'binary');
  const x = uncompressed.subarray(1, 33);
  const y = uncompressed.subarray(33, 65);

  return {
    kty: 'EC',
    crv: 'P-256',
    x: base64Url(x),
    y: base64Url(y),
    kid: base64Url(createHash('sha256').update(compressed).digest()),
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
    deactivated: false,
    versionId: runtime?.compose_hash || 'unversioned',
    updated: new Date().toISOString(),
    network: parsed.network,
    anchorContract: NETWORKS.neo_n3.neodid,
  };
}

function buildServiceDidDocument(
  parsed: ParsedMorpheusDid,
  runtime: NeoDidRuntimeSnapshot | null,
  origin: string
) {
  const did = parsed.did;
  const publicRuntimeUrl = appConfig.publicNitroApiUrls[0] || appConfig.nitroApiUrl;
  const resolverUrl = `${origin}/api/neodid/resolve?did=${encodeURIComponent(did)}`;
  const verificationJwk = compressedP256ToJwk(runtime?.verification_public_key || '');
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
          read_methods: ['getBinding', 'isMasterNullifierUsed', 'isActionNullifierUsed'],
          write_methods: ['registerBinding', 'revokeBinding', 'useActionTicket'],
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
          app_id: runtime?.app_id || null,
          compose_hash: runtime?.compose_hash || null,
          verification_public_key: runtime?.verification_public_key || null,
          verifier_curve: runtime?.verifier_curve || 'secp256r1',
          web3auth: runtime?.web3auth || null,
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

export async function resolveMorpheusDid(
  did: string,
  options: ResolveDidOptions
): Promise<ResolveDidResult> {
  const parsed = parseMorpheusDid(did);
  if (!parsed) {
    return {
      status: 400,
      contentType: DID_RESOLUTION_CONTENT_TYPE,
      body: {
        didResolutionMetadata: {
          error: 'invalidDid',
          message:
            'Expected did:morpheus:neo_n3:service:neodid, did:morpheus:neo_n3:vault:<hash160>, or did:morpheus:neo_n3:aa:<account-id>.',
          contentType: DID_RESOLUTION_CONTENT_TYPE,
        },
        didDocument: null,
        didDocumentMetadata: {},
      },
    };
  }

  const runtime = await fetchNeoDidRuntimeSnapshot();
  const origin = normalizeOrigin(options.origin);
  const wantsDocument = prefersDidDocument(options.accept, options.format);
  const contentType = wantsDocument ? DID_DOCUMENT_CONTENT_TYPE : DID_RESOLUTION_CONTENT_TYPE;
  const didDocument =
    parsed.kind === 'service'
      ? buildServiceDidDocument(parsed, runtime, origin)
      : buildSubjectDidDocument(parsed, origin);

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
