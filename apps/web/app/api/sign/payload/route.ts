import { createHash } from 'node:crypto';
import { proxyToNitro } from '@/lib/nitro';
import { recordOperationLog } from '@/lib/operation-logs';
import { isAuthorizedAdminRequest } from '@/lib/server-supabase';
import { trimString } from '@/lib/strings';
import { isUpstashConfigured, upstashPipeline } from '@/lib/upstash';

// SECURITY (S8): the /sign/payload lane lets an authorized caller blind-sign
// arbitrary bytes. A short-lived one-time nonce window prevents a captured
// request from being replayed to mint an extra signature. DEPRECATED: this
// endpoint is slated for removal once signing is fully bound through
// /oracle/fulfill (in-TEE digest binding); keep the nonce gate until then.
const SIGN_NONCE_TTL_MS = 5 * 60_000;

// In-memory fallback (single instance / non-production). Production should
// configure Upstash so the window is shared across instances.
const signNonceCache = new Map<string, number>();

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function pruneSignNonceCache() {
  if (signNonceCache.size <= 10_000) return;
  const now = Date.now();
  for (const [key, expiresAt] of signNonceCache) {
    if (expiresAt <= now) signNonceCache.delete(key);
  }
}

async function claimSignNonce(nonce: string): Promise<boolean> {
  const key = `morpheus:web-sign-nonce:${sha256Hex(nonce)}`;
  if (isUpstashConfigured()) {
    const [setResult] = await upstashPipeline([
      ['SET', key, '1', 'EX', String(Math.ceil(SIGN_NONCE_TTL_MS / 1000)), 'NX'],
    ]);
    return setResult?.result === 'OK';
  }
  const now = Date.now();
  const existing = signNonceCache.get(nonce);
  if (existing !== undefined && existing > now) return false;
  signNonceCache.set(nonce, now + SIGN_NONCE_TTL_MS);
  pruneSignNonceCache();
  return true;
}

export async function POST(request: Request) {
  if (!isAuthorizedAdminRequest(request, 'sign_payload')) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = await request.text();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = { raw_body: body };
  }
  const targetChain =
    parsed && typeof parsed === 'object'
      ? trimString(
          (parsed as Record<string, unknown>).target_chain ||
            (parsed as Record<string, unknown>).targetChain ||
            ''
        )
      : '';
  if (targetChain && targetChain !== 'neo_n3') {
    await recordOperationLog({
      route: '/api/sign/payload',
      method: 'POST',
      category: 'signing',
      requestPayload: parsed,
      responsePayload: { error: 'target_chain must be neo_n3' },
      httpStatus: 400,
      error: 'target_chain must be neo_n3',
    });
    return Response.json({ error: 'target_chain must be neo_n3' }, { status: 400 });
  }

  // SECURITY (S8): require a caller-supplied one-time nonce and reject replays
  // within the window. Without this, a captured request (or a leaky idempotent
  // retry) could mint an extra signature over the same bytes.
  const nonce =
    parsed && typeof parsed === 'object'
      ? trimString(
          (parsed as Record<string, unknown>).request_id ||
            (parsed as Record<string, unknown>).requestId ||
            (parsed as Record<string, unknown>).nonce ||
            ''
        )
      : '';
  if (!nonce || nonce.length < 8) {
    await recordOperationLog({
      route: '/api/sign/payload',
      method: 'POST',
      category: 'signing',
      requestPayload: parsed,
      responsePayload: { error: 'request_id (nonce) is required for signing replay protection' },
      httpStatus: 400,
      error: 'missing signing nonce',
    });
    return Response.json(
      { error: 'request_id (nonce) is required for signing replay protection' },
      { status: 400 }
    );
  }
  let nonceAccepted = false;
  try {
    nonceAccepted = await claimSignNonce(nonce);
  } catch {
    // Replay backend unavailable: fail closed rather than signing twice.
    nonceAccepted = false;
  }
  if (!nonceAccepted) {
    await recordOperationLog({
      route: '/api/sign/payload',
      method: 'POST',
      category: 'signing',
      requestPayload: { request_id: nonce },
      responsePayload: { error: 'request replay detected or nonce already used' },
      httpStatus: 409,
      error: 'signing nonce replay',
    });
    return Response.json(
      { error: 'request replay detected or nonce already used' },
      { status: 409 }
    );
  }

  return proxyToNitro(
    '/sign/payload',
    { method: 'POST', body },
    {
      route: '/api/sign/payload',
      category: 'signing',
      requestPayload: parsed,
    }
  );
}
