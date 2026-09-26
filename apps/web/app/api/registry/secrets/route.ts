import { randomUUID } from 'node:crypto';

import { apiError } from '@/lib/api-helpers';
import { createRateLimitedHandler } from '@/lib/rate-limit';
import { requireProjectOwner, SECRET_LIST_SELECT } from '@/lib/registry-access';
import { resolveRequestNetwork } from '@/lib/request-network';
import { trimString } from '@/lib/strings';
import type { Json } from '@/lib/supabase-types';
import {
  buildSecretMetadata,
  sanitizeSecretName,
  toPublicSecretRecord,
  validateEncryptionAlgorithm,
  validateSecretBinding,
  validateSecretCiphertext,
  validateSecretExpiry,
  type SecretRegistryRow,
} from '@/lib/secret-registry';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Developer-owned secret listing (self-serve, P0-2). Ciphertext never listed. */
export const GET = createRateLimitedHandler(
  async (request: Request) => {
    const url = new URL(request.url);
    const projectSlug = trimString(url.searchParams.get('project_slug') || '');
    if (!projectSlug) return apiError('project_slug is required', 'MISSING_PROJECT_SLUG', 400);

    const requestedNetwork = resolveRequestNetwork(url.searchParams.get('network') || '');
    if (!requestedNetwork.ok) return requestedNetwork.response;
    const network = requestedNetwork.network;
    const owned = await requireProjectOwner(request, projectSlug, network, {
      scope: 'secret_registry_read',
      maxRequests: 60,
      windowMs: 60_000,
    });
    if (!owned.ok) return owned.response;
    const { projectId, supabase } = owned;

    const secrets = supabase.from('morpheus_encrypted_secrets');
    const { data, error } = await secrets
      .select(SECRET_LIST_SELECT)
      .eq('project_id', projectId)
      .or('expires_at.is.null,expires_at.gt.now')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) return apiError(error.message, 'SECRET_LIST_FAILED', 500);

    const rows = (data || []) as SecretRegistryRow[];
    return Response.json({
      project_slug: projectSlug,
      network,
      secrets: rows.map(toPublicSecretRecord),
    });
  },
  { scope: 'secret_registry_read', maxRequests: 60, windowMs: 60_000 }
);

export const POST = createRateLimitedHandler(
  async (request: Request) => {
    const body = await request.json().catch(() => ({}));
    const projectSlug = trimString(body?.project_slug || '');
    const rawName = typeof body?.name === 'string' ? body.name : '';
    const name = sanitizeSecretName(rawName) || `cipher-ref:${randomUUID()}`;
    const ciphertext = body?.ciphertext ?? '';
    const targetChain = trimString(body?.target_chain || 'neo_n3');
    const requestedNetwork = resolveRequestNetwork(String(body?.network || ''));
    if (!requestedNetwork.ok) return requestedNetwork.response;
    const network = requestedNetwork.network;
    const algorithm = trimString(body?.encryption_algorithm || 'client-supplied-ciphertext');
    const algorithmError = validateEncryptionAlgorithm(algorithm);
    if (algorithmError) {
      return apiError(algorithmError, 'INVALID_ENCRYPTION_ALGORITHM', 400);
    }
    if (
      body?.metadata !== undefined &&
      (typeof body.metadata !== 'object' || body.metadata === null || Array.isArray(body.metadata))
    ) {
      return apiError('metadata must be a JSON object', 'INVALID_METADATA', 400);
    }
    // SECURITY (SVC-C-5): this self-serve lane wrote every row with no
    // requester/callback binding at all, so any leaked `secret_ref` was
    // spendable from any context. Bindings are now first-class inputs, are
    // server-normalized, and the caller's metadata can never set them.
    const {
      metadata: storedMetadata,
      boundRequester,
      boundCallbackContract,
    } = buildSecretMetadata({
      callerMetadata: body?.metadata,
      source: 'api.registry.secrets.post',
      requester: body?.requester ?? body?.requester_script_hash,
      callbackContract: body?.callback_contract ?? body?.callbackContract,
    });
    const expiresAt = body?.expires_at ?? null;

    if (!projectSlug) return apiError('project_slug is required', 'MISSING_PROJECT_SLUG', 400);
    if (targetChain !== 'neo_n3') {
      return apiError('target_chain must be neo_n3', 'UNSUPPORTED_CHAIN', 400);
    }
    const ciphertextError = validateSecretCiphertext(ciphertext);
    if (ciphertextError) return apiError(ciphertextError, 'INVALID_CIPHERTEXT', 400);
    const expiryError = validateSecretExpiry(expiresAt);
    if (expiryError) return apiError(expiryError, 'INVALID_EXPIRES_AT', 400);
    const bindingError = validateSecretBinding(network, boundRequester, boundCallbackContract);
    if (bindingError) return apiError(bindingError, 'MISSING_SECRET_BINDING', 400);

    const owned = await requireProjectOwner(request, projectSlug, network, {
      scope: 'secret_registry_write',
      maxRequests: 60,
      windowMs: 60_000,
    });
    if (!owned.ok) return owned.response;
    const { projectId, supabase } = owned;

    const row = {
      project_id: projectId,
      name,
      target_chain: targetChain,
      encryption_algorithm: algorithm,
      key_version: 1,
      ciphertext,
      // The values come straight off a parsed JSON body plus two normalized
      // 0x-hash160 strings, so this is JSON by construction.
      metadata: storedMetadata as Json,
      network,
      expires_at: expiresAt || null,
    };

    const secrets = supabase.from('morpheus_encrypted_secrets');
    const { data, error } = await secrets.insert(row).select(SECRET_LIST_SELECT).single();
    if (error) return apiError(error.message, 'SECRET_STORE_FAILED', 500);

    return Response.json(toPublicSecretRecord(data as SecretRegistryRow), { status: 201 });
  },
  { scope: 'secret_registry_write', maxRequests: 60, windowMs: 60_000 }
);
