import { isAuthorizedControlPlaneRequest } from '@/lib/control-plane-auth';
import { sendHeartbeat } from '@/lib/heartbeat';
import { fulfillNeoN3RequestViaBackend, resolveControlPlaneNetwork } from '@/lib/neo-control-plane';
import { badRequest } from '@/lib/api-helpers';
import { trimString } from '@/lib/strings';

export const runtime = 'nodejs';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readSignerMaterial(body: Record<string, unknown>) {
  const wif = trimString(body.wif || '');
  const private_key = trimString(body.private_key || body.privateKey || '');
  return {
    ...(wif ? { wif } : {}),
    ...(private_key ? { private_key } : {}),
  };
}

function resolveErrorStatus(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes('request not found')) return 400;
  return 500;
}

export async function POST(request: Request) {
  if (!isAuthorizedControlPlaneRequest(request)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!isPlainObject(body)) return badRequest('invalid JSON body');

  const network = resolveControlPlaneNetwork(trimString(body.network || 'testnet'));
  const targetChain = trimString(body.target_chain || body.chain || '');
  const requestId = trimString(body.request_id || '');
  const verificationSignature = trimString(
    body.verification_signature || body.signature || body.oracle_verifier_signature || ''
  );
  const errorText = trimString(body.error || '');
  const resultText = body.result === null || body.result === undefined ? '' : String(body.result);
  const resultBytesBase64 = trimString(body.result_bytes_base64 || '');

  if (!requestId) return badRequest('request_id is required');
  if (!verificationSignature) return badRequest('verification_signature is required');
  if (targetChain !== 'neo_n3') return badRequest('target_chain must be neo_n3');

  const success =
    typeof body.success === 'boolean'
      ? body.success
      : trimString(body.success).toLowerCase() === 'true';

  try {
    const result = await fulfillNeoN3RequestViaBackend({
      network,
      requestId,
      success,
      result: resultText,
      error: errorText,
      verificationSignature,
      resultBytesBase64,
      ...readSignerMaterial(body),
    });

    return Response.json({
      ok: true,
      network,
      target_chain: targetChain,
      request_id: requestId,
      broadcast: result,
    });
  } catch (error) {
    void sendHeartbeat(process.env.MORPHEUS_BETTERSTACK_CONTROL_CALLBACK_FAILURE_URL || '', {
      route: '/api/internal/control-plane/callback-broadcast',
      network,
      target_chain: targetChain,
      request_id: requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      { status: resolveErrorStatus(error) }
    );
  }
}
