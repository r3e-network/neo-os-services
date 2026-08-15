import { isAuthorizedControlPlaneRequest } from '@/lib/control-plane-auth';
import { runFeedSyncJob } from '@/lib/feed-sync';
import { sendHeartbeat } from '@/lib/heartbeat';
import { badRequest } from '@/lib/api-helpers';
import { trimString } from '@/lib/strings';

export const runtime = 'nodejs';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolveNetwork(value: unknown) {
  return trimString(value) === 'mainnet' ? 'mainnet' : 'testnet';
}

function resolveNeoN3UpdaterMaterial(network: 'mainnet' | 'testnet') {
  const candidates =
    network === 'mainnet'
      ? [
          ['private_key', process.env.MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_MAINNET],
          ['wif', process.env.MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET],
          ['private_key', process.env.MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY_MAINNET],
          ['wif', process.env.MORPHEUS_RELAYER_NEO_N3_WIF_MAINNET],
          ['private_key', process.env.MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY],
          ['wif', process.env.MORPHEUS_UPDATER_NEO_N3_WIF],
          ['private_key', process.env.MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY],
          ['wif', process.env.MORPHEUS_RELAYER_NEO_N3_WIF],
        ]
      : [
          ['private_key', process.env.MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_TESTNET],
          ['wif', process.env.MORPHEUS_UPDATER_NEO_N3_WIF_TESTNET],
          ['private_key', process.env.MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY_TESTNET],
          ['wif', process.env.MORPHEUS_RELAYER_NEO_N3_WIF_TESTNET],
          ['private_key', process.env.MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY],
          ['wif', process.env.MORPHEUS_UPDATER_NEO_N3_WIF],
          ['private_key', process.env.MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY],
          ['wif', process.env.MORPHEUS_RELAYER_NEO_N3_WIF],
        ];

  for (const [kind, value] of candidates) {
    const trimmed = trimString(value);
    if (trimmed) {
      return kind === 'wif' ? { wif: trimmed } : { private_key: trimmed };
    }
  }
  return {};
}

export async function POST(request: Request) {
  if (!isAuthorizedControlPlaneRequest(request)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  if (!isPlainObject(body)) return badRequest('invalid JSON body');

  const network = resolveNetwork(body.network);
  const signer = resolveNeoN3UpdaterMaterial(network);
  if (!signer.private_key && !signer.wif) {
    return Response.json(
      { error: `Neo N3 updater signer is not configured for ${network}` },
      { status: 500 }
    );
  }

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
    ...signer,
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
