import { trimString } from './lib/strings.js';

const queue = [];
let flushTimer = null;
let inFlight = false;
let queueLocked = false;
// F7: count silently-dropped log records (queue-lock races, overflow shedding,
// failed POST batches) so log loss during an incident is observable instead of
// invisible. Exposed via getLogSinkDroppedTotal() and rendered as
// morpheus_relayer_log_sink_dropped_total.
let droppedTotal = 0;

export function getLogSinkDroppedTotal() {
  return droppedTotal;
}

export function resetLogSinkDroppedTotalForTests() {
  droppedTotal = 0;
}

// Test-only: drain the in-memory queue and clear any pending flush timer so the
// module singleton does not leak state across tests.
export function clearLogSinkQueueForTests() {
  queue.length = 0;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  inFlight = false;
  queueLocked = false;
  droppedTotal = 0;
}

function isErrorLevelRecord(record) {
  return String(record?.level || '').toLowerCase() === 'error';
}

function resolveConfig() {
  const ingestingHost = trimString(process.env.MORPHEUS_BETTERSTACK_LOG_INGESTING_HOST);
  const sourceToken = trimString(process.env.MORPHEUS_BETTERSTACK_LOG_SOURCE_TOKEN);
  if (!ingestingHost || !sourceToken) return null;
  return {
    url: `https://${ingestingHost}`,
    sourceToken,
    batchSize: Math.max(Number(process.env.MORPHEUS_BETTERSTACK_LOG_BATCH_SIZE || 20), 1),
    flushIntervalMs: Math.max(
      Number(process.env.MORPHEUS_BETTERSTACK_LOG_FLUSH_INTERVAL_MS || 2000),
      250
    ),
    timeoutMs: Math.max(Number(process.env.MORPHEUS_BETTERSTACK_LOG_TIMEOUT_MS || 2000), 250),
    maxQueue: Math.max(Number(process.env.MORPHEUS_BETTERSTACK_LOG_MAX_QUEUE || 500), 10),
  };
}

async function flush() {
  const config = resolveConfig();
  if (!config || inFlight || queue.length === 0) return;
  inFlight = true;
  queueLocked = true;
  const batch = queue.splice(0, config.batchSize);
  queueLocked = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.sourceToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(batch),
      signal: controller.signal,
      cache: 'no-store',
    });
    // A non-2xx response means the batch was rejected (lost) — count it (F7).
    if (!response.ok) droppedTotal += batch.length;
  } catch {
    // Best effort only. Drop failures instead of blocking relayer execution, but
    // count the lost batch so the drop is observable (F7).
    droppedTotal += batch.length;
  } finally {
    clearTimeout(timer);
    inFlight = false;
    if (queue.length > 0) {
      scheduleFlush();
    }
  }
}

function scheduleFlush() {
  const config = resolveConfig();
  if (!config) return;
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    await flush();
  }, config.flushIntervalMs);
}

export function enqueueBetterStackLog(record) {
  const config = resolveConfig();
  if (!config) return;

  if (queueLocked) {
    // Drop logs during flush batch extraction to prevent a race condition; count
    // the drop (F7) so silent loss during a flush is observable.
    droppedTotal += 1;
    return;
  }

  queue.push({
    dt: new Date().toISOString(),
    ...record,
  });

  if (queue.length > config.maxQueue) {
    const overflow = queue.length - config.maxQueue;
    if (isErrorLevelRecord(record)) {
      // F7: the incoming record is error-level — keep it (drop the newest
      // NON-error records instead of the oldest) so error logs survive an
      // overflow during an incident. Scan from the tail (newest), skipping the
      // just-pushed record at the very end, removing non-error entries first;
      // fall back to dropping the oldest if every entry is error-level.
      let removed = 0;
      for (let i = queue.length - 2; i >= 0 && removed < overflow; i -= 1) {
        if (!isErrorLevelRecord(queue[i])) {
          queue.splice(i, 1);
          removed += 1;
        }
      }
      if (removed < overflow) {
        // All remaining were error-level: drop the oldest to enforce the cap.
        queue.splice(0, overflow - removed);
      }
      droppedTotal += overflow;
    } else {
      // Default: drop the oldest to enforce the cap (prior behavior) + count.
      queue.splice(0, overflow);
      droppedTotal += overflow;
    }
  }

  if (queue.length >= config.batchSize) {
    void flush();
    return;
  }

  scheduleFlush();
}
