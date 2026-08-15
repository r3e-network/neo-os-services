import { apiError } from '@/lib/api-helpers';
import { createRateLimitedHandler, type RateLimitOptions } from '@/lib/rate-limit';
import { requireUser, resolveOwnedSecretRow, SECRET_FULL_SELECT } from '@/lib/registry-access';
import { trimString } from '@/lib/strings';
import type { Database } from '@/lib/supabase-types';
import {
  sanitizeSecretName,
  toPublicSecretRecord,
  validateSecretCiphertext,
  validateSecretExpiry,
  type SecretRegistryRow,
} from '@/lib/secret-registry';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const SECRET_WRITE_LIMIT: RateLimitOptions = {
  scope: 'secret_registry_write',
  maxRequests: 60,
  windowMs: 60_000,
};

async function rotateSecret(request: Request, secretId: string) {
  const auth = await requireUser(request, SECRET_WRITE_LIMIT);
  if (!auth.ok) return auth.response;
  const { userId, supabase } = auth;

  const row = await resolveOwnedSecretRow(supabase, userId, secretId);
  if (!row) return apiError('secret not found', 'SECRET_NOT_FOUND', 404);

  const body = await request.json().catch(() => ({}));
  const patch: Database['public']['Tables']['morpheus_encrypted_secrets']['Update'] = {};

  if (body?.ciphertext !== undefined) {
    const ciphertextError = validateSecretCiphertext(body.ciphertext);
    if (ciphertextError) return apiError(ciphertextError, 'INVALID_CIPHERTEXT', 400);
    patch.ciphertext = body.ciphertext;
    patch.key_version = row.key_version + 1; // rotation bumps the version
  }

  if (body?.name !== undefined) {
    const newName = sanitizeSecretName(body.name);
    if (!newName) return apiError('name must be a non-empty string', 'INVALID_NAME', 400);
    patch.name = newName;
  }

  if (body?.metadata !== undefined) {
    if (
      typeof body.metadata !== 'object' ||
      body.metadata === null ||
      Array.isArray(body.metadata)
    ) {
      return apiError('metadata must be a JSON object', 'INVALID_METADATA', 400);
    }
    patch.metadata = { ...(row.metadata || {}), ...body.metadata };
  }

  if (body?.expires_at !== undefined) {
    const expiryError = validateSecretExpiry(body.expires_at);
    if (expiryError) return apiError(expiryError, 'INVALID_EXPIRES_AT', 400);
    patch.expires_at = body.expires_at || null;
  }

  if (Object.keys(patch).length === 0) {
    return apiError('no updatable fields provided', 'EMPTY_PATCH', 400);
  }

  patch.updated_at = new Date().toISOString();

  const secrets = supabase.from('morpheus_encrypted_secrets');
  const { data, error } = await secrets
    .update(patch)
    .eq('id', secretId)
    .select(SECRET_FULL_SELECT)
    .single();
  if (error) return apiError(error.message, 'SECRET_UPDATE_FAILED', 500);

  return Response.json(toPublicSecretRecord(data as SecretRegistryRow));
}

async function deleteSecret(request: Request, secretId: string) {
  const auth = await requireUser(request, SECRET_WRITE_LIMIT);
  if (!auth.ok) return auth.response;
  const { userId, supabase } = auth;

  const row = await resolveOwnedSecretRow(supabase, userId, secretId);
  if (!row) return apiError('secret not found', 'SECRET_NOT_FOUND', 404);

  // Hard delete: ciphertext refs are sensitive and ephemeral by nature, so
  // retention buys nothing and risks leaving stale material around.
  const secrets = supabase.from('morpheus_encrypted_secrets');
  const { error } = await secrets.delete().eq('id', secretId);
  if (error) return apiError(error.message, 'SECRET_DELETE_FAILED', 500);

  return Response.json({ secret_ref: secretId, deleted: true });
}

export async function PATCH(request: Request, context: { params: Promise<{ secretId: string }> }) {
  const { secretId: rawSecretId } = await context.params;
  const secretId = trimString(rawSecretId);
  if (!secretId) return apiError('secret id is required', 'INVALID_SECRET_ID', 400);
  const limited = createRateLimitedHandler(
    async (req: Request) => rotateSecret(req, secretId),
    SECRET_WRITE_LIMIT
  );
  return limited(request);
}

export async function DELETE(request: Request, context: { params: Promise<{ secretId: string }> }) {
  const { secretId: rawSecretId } = await context.params;
  const secretId = trimString(rawSecretId);
  if (!secretId) return apiError('secret id is required', 'INVALID_SECRET_ID', 400);
  const limited = createRateLimitedHandler(
    async (req: Request) => deleteSecret(req, secretId),
    SECRET_WRITE_LIMIT
  );
  return limited(request);
}
