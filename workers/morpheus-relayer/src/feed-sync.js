import { callNitro } from './nitro.js';
import { incrementMetric, saveRelayerState } from './state.js';

export function getFeedSyncDelayMs(config, state, nowMs = Date.now()) {
  if (!config.feedSync?.enabled) return Number.POSITIVE_INFINITY;
  const intervalMs = Math.max(Number(config.feedSync.intervalMs) || 0, 0);
  if (intervalMs <= 0) return 0;

  const lastAttemptAt = [
    state.metrics.last_feed_sync_completed_at,
    state.metrics.last_feed_sync_started_at,
    state.metrics.last_feed_sync_success_at,
  ]
    .map((value) => (value ? new Date(value).getTime() : 0))
    .find((value) => Number.isFinite(value) && value > 0);
  if (!lastAttemptAt) return 0;

  return Math.max(lastAttemptAt + intervalMs - nowMs, 0);
}

export function buildFeedSyncPayload(config, targetChain) {
  const payload = {
    target_chain: targetChain,
    network: config.network,
    symbols: config.feedSync.symbols,
    feed_change_threshold_bps: config.feedSync.changeThresholdBps,
    feed_min_update_interval_ms: config.feedSync.minUpdateIntervalMs,
    feed_stale_after_ms: config.feedSync.staleAfterMs,
    refresh_onchain_baseline: true,
    wait: Boolean(config.feedSync.waitForSubmission),
  };

  if (payload.wait) {
    payload.feed_submission_wait_timeout_ms = config.feedSync.timeoutMs;
  }

  if (config.feedSync.provider) {
    payload.provider = config.feedSync.provider;
  } else if (Array.isArray(config.feedSync.providers) && config.feedSync.providers.length > 0) {
    payload.providers = config.feedSync.providers;
  }

  // The automatic pricefeed runner already carries explicit provider/symbol
  // config from the signed runtime env. Keeping project config opt-in prevents
  // Supabase control-plane quota or downtime from blocking mainnet feed updates.
  if (config.feedSync.projectConfigEnabled && config.feedSync.projectSlug) {
    payload.project_slug = config.feedSync.projectSlug;
  }

  // Do not inject relayer/updater signer material into feed sync payloads.
  // Feed publication is executed by the worker, whose Neo N3 context resolves
  // the DataFeed-authorized worker signer. Passing relayer/updater material here
  // can override that worker signer and make mainnet DataFeed calls fail as
  // unauthorized.
  return payload;
}

function isFeedSyncChainSuccessful(response, summary) {
  return Boolean(response?.ok) && Number(summary?.error_count || 0) === 0;
}

function resolvePublicationState({ errorCount, accepted, submittedPairs, skippedPairs }) {
  if (errorCount > 0) return 'error';
  if (accepted) return 'accepted';
  if (submittedPairs > 0) return 'submitted';
  if (skippedPairs > 0) return 'skipped';
  return 'idle';
}

export function summarizeFeedSyncChainResult(chainResult = {}) {
  const body = chainResult?.body && typeof chainResult.body === 'object' ? chainResult.body : {};
  const syncResults = Array.isArray(body.sync_results) ? body.sync_results : [];
  const errors = Array.isArray(body.errors) ? body.errors : [];
  const skippedReasons = {};

  let submittedPairs = 0;
  let skippedPairs = 0;

  for (const result of syncResults) {
    const relayStatus = String(result?.relay_status || '')
      .trim()
      .toLowerCase();
    if (relayStatus === 'submitted') {
      submittedPairs += 1;
      continue;
    }
    if (relayStatus === 'skipped') {
      skippedPairs += 1;
      const reason = String(result?.skip_reason || '').trim() || 'unknown';
      skippedReasons[reason] = (skippedReasons[reason] || 0) + 1;
    }
  }

  const errorCount =
    errors.length +
    (chainResult?.ok === false && typeof body.error === 'string' && body.error.trim() ? 1 : 0);

  return {
    target_chain: String(chainResult?.target_chain || ''),
    api_url: String(chainResult?.api_url || ''),
    network: String(body?.network || ''),
    publication_state: resolvePublicationState({
      errorCount,
      accepted: Boolean(body?.accepted),
      submittedPairs,
      skippedPairs,
    }),
    batch_submitted: Boolean(body?.batch_submitted),
    batch_count: Number(body?.batch_count || 0),
    submitted_pairs: submittedPairs,
    skipped_pairs: skippedPairs,
    error_count: errorCount,
    skipped_reasons: skippedReasons,
  };
}

export async function processFeedSync(config, state, logger) {
  if (!config.feedSync?.enabled) {
    return { enabled: false, chains: [] };
  }

  const now = Date.now();
  const feedSyncDelayMs = getFeedSyncDelayMs(config, state, now);
  if (feedSyncDelayMs > 0) {
    incrementMetric(state, 'feed_sync_skipped_total');
    return { enabled: true, skipped: true, chains: [] };
  }

  state.metrics.last_feed_sync_started_at = new Date(now).toISOString();
  incrementMetric(state, 'feed_sync_runs_total');
  saveRelayerState(config.stateFile, state);

  const targetChains =
    Array.isArray(config.activeChains) && config.activeChains.length > 0
      ? config.activeChains
      : ['neo_n3'];
  const chains = [];
  for (const targetChain of targetChains) {
    try {
      const payload = buildFeedSyncPayload(config, targetChain);

      const timeoutAwareResponse = await callNitro(config, '/oracle/feed', payload, {
        timeoutMs: config.feedSync.timeoutMs,
        maxTimeoutMs: config.feedSync.timeoutMs,
        allowFallback: false,
      });
      const publicationSummary = summarizeFeedSyncChainResult({
        target_chain: targetChain,
        api_url: timeoutAwareResponse.api_url,
        ok: timeoutAwareResponse.ok,
        status: timeoutAwareResponse.status,
        body: timeoutAwareResponse.body,
      });
      chains.push({
        target_chain: targetChain,
        api_url: timeoutAwareResponse.api_url,
        ok: timeoutAwareResponse.ok,
        status: timeoutAwareResponse.status,
        body: timeoutAwareResponse.body,
        publication_summary: publicationSummary,
      });
      incrementMetric(
        state,
        isFeedSyncChainSuccessful(timeoutAwareResponse, publicationSummary)
          ? 'feed_sync_success_total'
          : 'feed_sync_error_total'
      );
    } catch (error) {
      chains.push({
        target_chain: targetChain,
        ok: false,
        status: 500,
        body: { error: normalizeErrorMessage(error) },
        publication_summary: summarizeFeedSyncChainResult({
          target_chain: targetChain,
          ok: false,
          status: 500,
          body: { error: normalizeErrorMessage(error) },
        }),
      });
      incrementMetric(state, 'feed_sync_error_total');
      logger.warn({ target_chain: targetChain, error }, 'Feed sync tick failed');
    }
  }

  state.metrics.last_feed_sync_completed_at = new Date().toISOString();
  state.metrics.last_feed_sync_duration_ms = Date.now() - now;
  if (
    chains.some((entry) =>
      isFeedSyncChainSuccessful(
        entry,
        entry.publication_summary || summarizeFeedSyncChainResult(entry)
      )
    )
  ) {
    state.metrics.last_feed_sync_success_at = state.metrics.last_feed_sync_completed_at;
  }
  saveRelayerState(config.stateFile, state);
  return { enabled: true, skipped: false, chains };
}

export function normalizeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
