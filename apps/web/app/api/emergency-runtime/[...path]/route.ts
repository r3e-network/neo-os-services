export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{
    path?: string[];
  }>;
};

type Network = 'mainnet' | 'testnet';

function trimString(value: unknown) {
  return String(value || '').trim();
}

function normalizePath(parts: string[] | undefined) {
  const clean = (parts || []).map((part) => part.trim()).filter(Boolean);
  return `/${clean.join('/')}`.replace(/\/+$/, '') || '/';
}

function resolveNetwork(path: string, request: Request): Network {
  const firstSegment = path.split('/').filter(Boolean)[0]?.toLowerCase();
  if (firstSegment === 'mainnet' || firstSegment === 'testnet') return firstSegment;
  const header = trimString(request.headers.get('x-morpheus-network')).toLowerCase();
  return header === 'mainnet' ? 'mainnet' : 'testnet';
}

function stripNetworkPrefix(path: string, network: Network) {
  const prefix = `/${network}`;
  if (path === prefix) return '/';
  return path.startsWith(`${prefix}/`) ? path.slice(prefix.length) || '/' : path;
}

function json(status: number, payload: Record<string, unknown>) {
  return Response.json(payload, {
    status,
    headers: {
      'cache-control': status === 200 ? 'public, max-age=15' : 'no-store',
      'x-morpheus-runtime': 'emergency-vercel-runtime',
    },
  });
}

function health(network: Network) {
  return json(200, {
    status: 'ok',
    runtime: 'emergency-vercel-runtime',
    network,
    oracle: {
      privacy_oracle: false,
      target_chains: ['neo_n3'],
      pricefeed_chain: 'neo_n3',
      compute_merged_into_oracle: false,
    },
    degraded: true,
    reason: 'runtime_control_plane_disabled',
  });
}

function info(network: Network) {
  return json(200, {
    runtime: {
      status: 'degraded',
      mode: 'emergency-vercel-runtime',
      network,
      tee_attestation_available: false,
      origin: 'vercel',
    },
    dstack: {
      available: false,
      reason: 'runtime_unavailable',
    },
    overload: {
      inflight: 0,
    },
  });
}

async function handle(request: Request, context: RouteContext) {
  const params = await context.params;
  const path = normalizePath(params.path);
  const network = resolveNetwork(path, request);
  const routePath = stripNetworkPrefix(path, network);

  if (request.method === 'GET' && (routePath === '/health' || routePath === '/')) {
    return health(network);
  }
  if (request.method === 'GET' && routePath === '/info') {
    return info(network);
  }

  return json(503, {
    error: 'runtime_temporarily_degraded',
    runtime: 'emergency-vercel-runtime',
    network,
    path: routePath,
    message: 'Runtime origin is unavailable; only health and info probes are restored.',
  });
}

export async function GET(request: Request, context: RouteContext) {
  return handle(request, context);
}

export async function POST(request: Request, context: RouteContext) {
  return handle(request, context);
}

export async function PUT(request: Request, context: RouteContext) {
  return handle(request, context);
}

export async function PATCH(request: Request, context: RouteContext) {
  return handle(request, context);
}

export async function DELETE(request: Request, context: RouteContext) {
  return handle(request, context);
}
