import { isAuthorizedWorkflowRequest } from '@/lib/control-plane-auth';
import { runFeedSyncJob } from '@/lib/feed-sync';
import { sendHeartbeat } from '@/lib/heartbeat';
import { badRequest } from '@/lib/api-helpers';
import { findHostSignerMaterialPaths } from '@/lib/host-key-guard';
import { trimString } from '@/lib/strings';

export const runtime = 'nodejs';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolveNetwork(value: unknown) {
  return trimString(value) === 'mainnet' ? 'mainnet' : 'testnet';
}

export async function POST(request: Request) {
  if (!isAuthorizedWorkflowRequest(request)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  if (!isPlainObject(body)) return badRequest('invalid JSON body');
  if (findHostSignerMaterialPaths(body).length > 0) {
    return badRequest(
      'raw signer material (wif/private_key) is not accepted; signing is custody-side in the enclave'
    );
  }

  const network = resolveNetwork(body.network);

  // No signer material is resolved or forwarded. This compatibility trigger
  // can only call the host's observe/plan surface; production publication is
  // self-scheduled by the Rust relayer and therefore this path fails closed
  // whenever an on-chain update would be required.
  const result = await runFeedSyncJob({
    target_chain: trimString(body.target_chain || 'neo_n3'),
    project_slug: trimString(body.project_slug || '') || undefined,
    provider: trimString(body.provider || '') || undefined,
    providers: Array.isArray(body.providers)
      ? body.providers.map((entry) => trimString(entry)).filter(Boolean)
      : undefined,
    symbols: Array.isArray(body.symbols)
      ? body.symbols.map((entry) => trimString(entry)).filter(Boolean)
      : undefined,
  });

  if (result.ok) {
    void sendHeartbeat(process.env.MORPHEUS_BETTERSTACK_CONTROL_FEED_HEARTBEAT_URL || '', {
      route: '/api/internal/control-plane/feed-tick',
      network,
      ok: true,
    });
  } else {
    void sendHeartbeat(process.env.MORPHEUS_BETTERSTACK_CONTROL_FEED_FAILURE_URL || '', {
      route: '/api/internal/control-plane/feed-tick',
      network,
      ok: false,
    });
  }

  return Response.json(result, { status: result.ok ? 200 : 502 });
}
