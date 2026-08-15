import { appConfig } from '@/lib/config';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';
import { dispatchToControlPlane, shouldDispatchToControlPlane } from '@/lib/control-plane';
import { parseFeedProviders, parseFeedSymbols } from '@/lib/feed-defaults';
import { runFeedSyncJob } from '@/lib/feed-sync';
import { sendHeartbeat } from '@/lib/heartbeat';
import { recordOperationLog } from '@/lib/operation-logs';

// Example: replace the console.warn below with the shared structured logger:
// import { createLogger } from '@r3e-network/neo-os-services-shared/logger';
// const logger = createLogger({ service: 'morpheus-web-cron-feed' });
// logger.warn('unauthorized request', { ...safe diagnostics });

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function jsonNoStore(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set('cache-control', 'no-store');
  return Response.json(body, { ...init, headers });
}

function getSafeAuthDiagnostics(request: Request) {
  const bearer = request.headers.get('authorization') || '';
  const headerSecret =
    request.headers.get('x-morpheus-cron') || request.headers.get('x-cron-token') || '';
  return {
    headerNames: Array.from(request.headers.keys()).sort(),
    hasAuthorizationHeader: Boolean(request.headers.get('authorization')),
    hasCronHeaderSecret: Boolean(headerSecret),
    hasVercelSecureComputeHeaders: Boolean(request.headers.get('x-vercel-sc-headers')),
    authHeaderLength: bearer.length,
    cronHeaderSecretLength: headerSecret.length,
    userAgent: request.headers.get('user-agent') || '',
  };
}

function isFeedControlPlaneEnabled() {
  const raw = String(process.env.MORPHEUS_CONTROL_PLANE_ENABLE_FEED || '')
    .trim()
    .toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return process.env.NODE_ENV === 'production';
}

function shouldFallbackFromFeedControlPlane(response: Response) {
  if (![401, 403].includes(response.status)) return false;
  const raw = String(process.env.MORPHEUS_CONTROL_PLANE_FEED_FALLBACK_ON_AUTH || '')
    .trim()
    .toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    const routeUrl = new URL(request.url);
    console.warn('[morpheus-cron-feed] unauthorized request', {
      hasAuthorizationHeader: Boolean(request.headers.get('authorization')),
      hasCronHeaderSecret: Boolean(request.headers.get('x-morpheus-cron')),
      searchParamCount: Array.from(routeUrl.searchParams.keys()).length,
      userAgent: request.headers.get('user-agent') || '',
    });
    const body = { error: 'Unauthorized' };
    await recordOperationLog({
      route: '/api/cron/feed',
      method: 'GET',
      category: 'feed',
      requestPayload: Object.fromEntries(new URL(request.url).searchParams.entries()),
      responsePayload: body,
      httpStatus: 401,
      error: 'Unauthorized',
      metadata: {
        auth: getSafeAuthDiagnostics(request),
      },
    });
    return jsonNoStore(body, { status: 401 });
  }

  if (!appConfig.nitroApiUrl) {
    const body = { error: 'MORPHEUS_RUNTIME_URL is not configured' };
    await recordOperationLog({
      route: '/api/cron/feed',
      method: 'GET',
      category: 'feed',
      requestPayload: Object.fromEntries(new URL(request.url).searchParams.entries()),
      responsePayload: body,
      httpStatus: 500,
      error: body.error,
    });
    return jsonNoStore(body, { status: 500 });
  }

  const routeUrl = new URL(request.url);
  const symbols = parseFeedSymbols(process.env.MORPHEUS_FEED_SYMBOLS);
  const explicitTargetChain = (routeUrl.searchParams.get('target_chain') || '').trim();
  if (explicitTargetChain && explicitTargetChain !== 'neo_n3') {
    const body = { error: 'target_chain must be neo_n3' };
    await recordOperationLog({
      route: '/api/cron/feed',
      method: 'GET',
      category: 'feed',
      requestPayload: Object.fromEntries(routeUrl.searchParams.entries()),
      responsePayload: body,
      httpStatus: 400,
      error: body.error,
    });
    return jsonNoStore(body, { status: 400 });
  }
  const configuredProjectSlug = (
    routeUrl.searchParams.get('project_slug') ||
    process.env.MORPHEUS_FEED_PROJECT_SLUG ||
    ''
  ).trim();
  const configuredProvider = (
    routeUrl.searchParams.get('provider') ||
    process.env.MORPHEUS_FEED_PROVIDER ||
    ''
  ).trim();
  const configuredProviders = parseFeedProviders(
    routeUrl.searchParams.get('providers') || process.env.MORPHEUS_FEED_PROVIDERS || ''
  );
  const feedTickPayload = {
    target_chain: explicitTargetChain || 'neo_n3',
    project_slug: configuredProjectSlug || undefined,
    provider: configuredProvider || undefined,
    providers: configuredProviders,
    symbols,
  };

  if (isFeedControlPlaneEnabled() && shouldDispatchToControlPlane('/feeds/tick')) {
    const controlPlaneResponse = await dispatchToControlPlane(
      '/feeds/tick',
      {
        method: 'POST',
        body: JSON.stringify(feedTickPayload),
      },
      {
        route: '/api/cron/feed',
        category: 'feed',
        requestPayload: feedTickPayload,
        metadata: {
          source: 'cron',
        },
      }
    );
    if (!shouldFallbackFromFeedControlPlane(controlPlaneResponse)) {
      await sendHeartbeat(
        controlPlaneResponse.ok
          ? process.env.MORPHEUS_BETTERSTACK_CRON_FEED_HEARTBEAT_URL || ''
          : process.env.MORPHEUS_BETTERSTACK_CRON_FEED_FAILURE_URL || '',
        {
          route: '/api/cron/feed',
          ok: controlPlaneResponse.ok,
          target_chain: 'neo_n3',
          symbols: symbols.length,
          via: 'control_plane',
        }
      );
      return controlPlaneResponse;
    }
  }

  const finalBody = await runFeedSyncJob(feedTickPayload);
  const heartbeatPayload = {
    route: '/api/cron/feed',
    ok: Boolean(finalBody.ok),
    target_chain: 'neo_n3',
    symbols: symbols.length,
  };
  if (finalBody.ok) {
    await sendHeartbeat(
      process.env.MORPHEUS_BETTERSTACK_CRON_FEED_HEARTBEAT_URL || '',
      heartbeatPayload
    );
  } else {
    await sendHeartbeat(
      process.env.MORPHEUS_BETTERSTACK_CRON_FEED_FAILURE_URL || '',
      heartbeatPayload
    );
  }
  await recordOperationLog({
    route: '/api/cron/feed',
    method: 'GET',
    category: 'feed',
    requestPayload: {
      ...Object.fromEntries(routeUrl.searchParams.entries()),
      project_slug: configuredProjectSlug || undefined,
      provider: configuredProvider || undefined,
      providers: configuredProviders,
      symbols,
      target_chains: ['neo_n3'],
    },
    responsePayload: finalBody,
    httpStatus: finalBody.ok ? 200 : 502,
  });
  return jsonNoStore(finalBody, { status: finalBody.ok ? 200 : 502 });
}
