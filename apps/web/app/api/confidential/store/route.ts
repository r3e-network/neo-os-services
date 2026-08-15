import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import { apiError } from '@/lib/api-helpers';
import { recordOperationLog } from '@/lib/operation-logs';
import { createRateLimitedHandler } from '@/lib/rate-limit';
import { authorizeProjectAccess } from '@/lib/registry-access';
import { resolveSupabaseNetwork } from '@/lib/server-supabase';
import { trimString } from '@/lib/strings';

type EncryptedSecretInsertRow = {
  project_id: string | null;
  network: string;
  name: string;
  target_chain: string;
  encryption_algorithm: string;
  key_version: number;
  ciphertext: string;
  metadata: Record<string, unknown>;
};

type EncryptedSecretInsertResult = {
  id: string;
  name: string;
  target_chain: string;
  encryption_algorithm: string;
  created_at: string | null;
};

function normalizeHash160(value: unknown) {
  const raw = trimString(value).replace(/^0x/i, '').toLowerCase();
  return /^[0-9a-f]{40}$/.test(raw) ? `0x${raw}` : '';
}

const handlePost = createRateLimitedHandler(
  async function POST(request: Request) {
    const body = await request.json().catch(() => ({}));
    const ciphertext = trimString(body?.ciphertext);
    const targetChain = trimString(body?.target_chain || body?.targetChain || 'neo_n3');
    const network = resolveSupabaseNetwork(String(body?.network || body?.morpheus_network || ''));
    const projectSlug = trimString(body?.project_slug || body?.projectSlug || '');
    const name = trimString(body?.name || '') || `cipher-ref:${randomUUID()}`;
    const algorithm = trimString(
      body?.encryption_algorithm || body?.algorithm || 'client-supplied-ciphertext'
    );
    const metadata = typeof body?.metadata === 'object' && body?.metadata ? body.metadata : {};
    const boundRequester = normalizeHash160(body?.requester || body?.requester_script_hash);
    const boundCallbackContract = normalizeHash160(
      body?.callback_contract || body?.callbackContract
    );

    if (!ciphertext) {
      return apiError('ciphertext is required', 'MISSING_CIPHERTEXT', 400);
    }
    if (targetChain !== 'neo_n3') {
      return apiError('target_chain must be neo_n3', 'UNSUPPORTED_CHAIN', 400);
    }
    if (!projectSlug) {
      return apiError('project_slug is required', 'MISSING_PROJECT_SLUG', 400);
    }

    // SECURITY (S12): project owner (JWT) or operator (provider_config admin
    // key). A bare admin key previously wrote ciphertext rows into any project
    // with no project-level isolation.
    const access = await authorizeProjectAccess(request, projectSlug, network, 'provider_config');
    if (!access.ok) {
      await recordOperationLog({
        route: '/api/confidential/store',
        method: 'POST',
        category: 'system',
        requestPayload: {
          project_slug: projectSlug,
          network,
          target_chain: targetChain,
        },
        responsePayload: { error: 'unauthorized' },
        httpStatus: 401,
        error: 'unauthorized',
      });
      return apiError('unauthorized', 'UNAUTHORIZED', 401);
    }
    const { projectId, supabase } = access;

    try {
      const row: EncryptedSecretInsertRow = {
        project_id: projectId,
        network,
        name,
        target_chain: targetChain,
        encryption_algorithm: algorithm,
        key_version: 1,
        ciphertext,
        metadata: {
          source: 'api.confidential.store',
          network,
          ...(boundRequester ? { bound_requester: boundRequester } : {}),
          ...(boundCallbackContract ? { bound_callback_contract: boundCallbackContract } : {}),
          ...metadata,
        },
      };

      const encryptedSecrets = supabase.from('morpheus_encrypted_secrets') as any;
      const { data, error } = await encryptedSecrets
        .insert(row)
        .select('id,name,target_chain,encryption_algorithm,created_at')
        .single();
      if (error) throw error;
      const inserted = data as EncryptedSecretInsertResult;

      const responsePayload = {
        secret_ref: inserted.id,
        network,
        name: inserted.name,
        target_chain: inserted.target_chain,
        encryption_algorithm: inserted.encryption_algorithm,
        created_at: inserted.created_at,
        ...(boundRequester ? { bound_requester: boundRequester } : {}),
        ...(boundCallbackContract ? { bound_callback_contract: boundCallbackContract } : {}),
      };

      await recordOperationLog({
        route: '/api/confidential/store',
        method: 'POST',
        category: 'system',
        // The client-supplied ciphertext is intentionally omitted: it can wrap
        // sensitive secrets, so it must never be written to the operation log
        // (Supabase + BetterStack). Only non-sensitive request metadata is kept.
        requestPayload: {
          project_slug: projectSlug || null,
          network,
          target_chain: targetChain,
        },
        responsePayload,
        httpStatus: 200,
        metadata: {
          secret_name: inserted.name,
          secret_ref: inserted.id,
        },
      });

      return NextResponse.json(responsePayload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordOperationLog({
        route: '/api/confidential/store',
        method: 'POST',
        category: 'system',
        // Omit ciphertext from logs even on failure (see success-path note).
        requestPayload: {
          project_slug: projectSlug || null,
          network,
          target_chain: targetChain,
        },
        responsePayload: { error: message },
        httpStatus: 500,
        error: message,
      });
      // SECURITY (S21): fixed generic message to the caller; detail stays in the
      // (redacted) operation log.
      return apiError('internal error', 'SECRET_STORE_FAILED', 500);
    }
  },
  { scope: 'confidential_store', maxRequests: 20, windowMs: 60_000 }
);

export async function POST(request: Request) {
  return handlePost(request);
}
