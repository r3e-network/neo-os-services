import { appConfig } from './config';
import { parseFeedProviders, parseFeedSymbols } from './feed-defaults';
import { isRetryableStatus } from './nitro';
import { resolveProviderAwarePayload } from './provider-configs';
import { trimString } from './strings';

function describeError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error);
    } catch {
      return 'feed sync failed';
    }
  }
  return String(error);
}

type FeedSyncOptions = {
  target_chain?: string | null;
  project_slug?: string | null;
  provider?: string | null;
  providers?: string[] | null;
  symbols?: string[] | null;
};

export async function runFeedSyncJob(options: FeedSyncOptions = {}) {
  const configuredCandidateUrls =
    Array.isArray(appConfig.nitroApiUrls) && appConfig.nitroApiUrls.length > 0
      ? appConfig.nitroApiUrls
      : appConfig.nitroApiUrl
        ? [appConfig.nitroApiUrl]
        : [];
  // Feed publication is mutating/signing work. A production retry against
  // another host would silently move the trust boundary, so only the primary
  // explicit endpoint is eligible.
  const candidateUrls =
    process.env.NODE_ENV === 'production'
      ? configuredCandidateUrls.slice(0, 1)
      : configuredCandidateUrls;
  if (candidateUrls.length === 0) {
    throw new Error('MORPHEUS_RUNTIME_URL is not configured');
  }

  const explicitTargetChain = trimString(options.target_chain || '');
  if (explicitTargetChain && explicitTargetChain !== 'neo_n3') {
    throw new Error('target_chain must be neo_n3');
  }

  const targetChains = ['neo_n3'];
  const configuredProjectSlug = trimString(options.project_slug || appConfig.feedProjectSlug || '');
  const configuredProvider = trimString(options.provider || appConfig.feedProvider || '');
  const configuredProviders =
    Array.isArray(options.providers) && options.providers.length > 0
      ? options.providers.map((entry) => trimString(entry)).filter(Boolean)
      : parseFeedProviders(process.env.MORPHEUS_FEED_PROVIDERS || '');
  const symbols =
    Array.isArray(options.symbols) && options.symbols.length > 0
      ? options.symbols.map((entry) => trimString(entry)).filter(Boolean)
      : parseFeedSymbols(process.env.MORPHEUS_FEED_SYMBOLS);

  const headers = new Headers({ 'content-type': 'application/json' });
  if (appConfig.nitroToken) {
    headers.set('authorization', `Bearer ${appConfig.nitroToken}`);
    headers.set('x-nitro-token', appConfig.nitroToken);
  }

  const results = await Promise.all(
    targetChains.map(async (targetChain) => {
      try {
        const payload: Record<string, unknown> = {
          symbols,
          target_chain: targetChain,
          wait: false,
          project_slug: configuredProjectSlug || undefined,
        };
        if (configuredProvider) {
          payload.provider = configuredProvider;
        } else {
          payload.providers = configuredProviders;
        }

        const resolved = await resolveProviderAwarePayload(payload, {
          projectSlug: configuredProjectSlug || undefined,
          fallbackProviderId: configuredProvider || undefined,
        });

        let lastStatus = 503;
        let lastBody: unknown = { error: 'upstream unavailable' };
        for (const apiBaseUrl of candidateUrls) {
          try {
            const response = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/oracle/feed`, {
              method: 'POST',
              headers,
              body: JSON.stringify(resolved.payload),
              cache: 'no-store',
              // Per-candidate timeout so a stalled endpoint fails over to the
              // next URL instead of hanging the request.
              signal: AbortSignal.timeout(15000),
            });
            const text = await response.text();
            let body: unknown = text;
            try {
              body = text ? JSON.parse(text) : {};
            } catch {}
            lastStatus = response.status;
            lastBody = body;
            if (response.ok || !isRetryableStatus(response.status)) {
              break;
            }
          } catch (error) {
            // Transport error/timeout: record and try the next candidate URL
            // instead of aborting the whole failover loop.
            lastStatus = 503;
            lastBody = { error: error instanceof Error ? error.message : 'fetch failed' };
          }
        }
        return { target_chain: targetChain, status: lastStatus, body: lastBody };
      } catch (error) {
        return {
          target_chain: targetChain,
          status: 400,
          body: { error: describeError(error) },
        };
      }
    })
  );

  const ok = results.every((entry) => Number(entry.status || 500) < 400);
  return {
    ok,
    project_slug: configuredProjectSlug || null,
    provider: configuredProvider || null,
    providers: configuredProviders,
    symbols,
    results,
  };
}
