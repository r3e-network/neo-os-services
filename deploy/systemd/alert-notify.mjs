import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';

// systemd OnFailure= notifier.
//
// Why this exists: every oneshot unit on the oracle box already failed loudly —
// feed-monitor.mjs exits 1 on a stale feed or low updater GAS and 2 on RPC
// failure — but nothing was subscribed to those exit codes. `grep -rn OnFailure`
// over this repo returned zero systemd hits, and RUNBOOK.md named the detection
// mechanism as a human running `systemctl is-failed`. That is why the mainnet
// price feed sat dead from 2026-07-29 to 2026-08-17 (19 days) with nobody
// paged.
//
// Invoked as: node alert-notify.mjs <failed-unit-name>
// Wired via:  OnFailure=morpheus-alert@%n.service
//
// Delivery is intentionally fail-loud. If no webhook is configured, or every
// configured endpoint rejects the post, this exits non-zero so
// `systemctl is-failed morpheus-alert@<unit>` shows an undelivered alert
// instead of silently swallowing the second failure in a row.

export const EXIT_OK = 0;
export const EXIT_DELIVERY_FAILED = 1;
export const EXIT_NOT_CONFIGURED = 78; // EX_CONFIG

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_ATTEMPTS = 3;

export function parseWebhookTargets(raw) {
  return String(raw || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Best-effort local context for the failed unit. Never throws: an alert with a
 * missing detail block is still worth far more than no alert.
 */
export function collectUnitContext(unit, { run = defaultRun } = {}) {
  const context = {};
  // Each collector is individually guarded: enriching the alert must never be
  // able to suppress it. A box where journalctl is absent or systemctl is
  // slow still gets the alert, just with a thinner detail block.
  const safeRun = (command, args) => {
    try {
      return run(command, args) || '';
    } catch {
      return '';
    }
  };

  const status = safeRun('systemctl', [
    'show',
    unit,
    '--property=Result,ExecMainStatus,InvocationID',
  ]);
  for (const line of status.split('\n')) {
    const match = line.match(/^([A-Za-z]+)=(.*)$/);
    if (match) context[match[1]] = match[2];
  }
  const journal = safeRun('journalctl', ['-u', unit, '-n', '20', '--no-pager', '-o', 'cat']);
  if (journal) context.recent_log = journal.trim().split('\n').slice(-20);
  return context;
}

function defaultRun(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout: 8_000 });
  } catch {
    return '';
  }
}

/**
 * The feed monitor writes a machine-readable per-pair snapshot every run. When
 * it is the unit that failed, inline that snapshot so the alert says WHICH pair
 * is stale and how old, not merely "a unit failed".
 */
export function readFeedStatusSnapshot(
  path = process.env.MONITOR_STATUS || '/opt/morpheus/nitro/feed-status.json',
  { read = readFileSync } = {}
) {
  try {
    const parsed = JSON.parse(read(path, 'utf8'));
    return {
      ts: parsed.ts ?? null,
      ok: parsed.ok ?? null,
      updater_gas: parsed.updater_gas ?? null,
      feed_age_min: parsed.feed_age_min ?? null,
      problems: Array.isArray(parsed.problems) ? parsed.problems : [],
    };
  } catch {
    return null;
  }
}

export function buildAlertPayload(unit, context = {}, snapshot = null, { source, now } = {}) {
  const scrub = (value) => String(value)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/\b[KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/g, '[REDACTED-WIF]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => {
      try { return new URL(url).origin + '/[redacted-path]'; } catch { return '[redacted-url]'; }
    })
    .replace(/(["']?(?:api[_-]?key|private[_-]?key|secret|token|password|authorization|mnemonic|seed|passphrase)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .slice(0, 1000);
  const problems = Array.isArray(snapshot?.problems) ? snapshot.problems.slice(0, 20).map(scrub) : [];
  const scalar = (value) => value == null ? null : typeof value === 'number' && Number.isFinite(value) ? value : scrub(value);
  const summary = problems.length ? problems.join(' | ') : `unit failed (${unit})`;
  return {
    severity: 'critical',
    source: scrub(source || process.env.ALERT_SOURCE || hostname()),
    unit: scrub(unit),
    title: `[NeoOS oracle] ${scrub(unit)} FAILED`,
    text: `[NeoOS oracle] ${scrub(unit)} FAILED: ${summary}`,
    timestamp: (now ? new Date(now) : new Date()).toISOString(),
    exec_main_status: scalar(context.ExecMainStatus),
    result: scalar(context.Result),
    problems,
    feed_status: snapshot ? {
      ts: scalar(snapshot.ts), ok: snapshot.ok == null ? null : snapshot.ok === true,
      updater_gas: scalar(snapshot.updater_gas), feed_age_min: scalar(snapshot.feed_age_min), problems,
    } : null,
    recent_log: Array.isArray(context.recent_log) ? context.recent_log.slice(-20).map(scrub) : [],
  };
}

export async function postAlert(
  url,
  payload,
  { fetchImpl = fetch, attempts = DEFAULT_ATTEMPTS, timeoutMs = DEFAULT_TIMEOUT_MS, token } = {}
) {
  const headers = { 'content-type': 'application/json' };
  const bearer = token ?? process.env.ALERT_WEBHOOK_TOKEN ?? '';
  if (bearer) headers.authorization = `Bearer ${bearer}`;

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
      // Do not leave unconsumed responses occupying connections across retries.
      void response.body?.cancel().catch(() => {});
      if (response.ok) return true;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) {
    // Webhook paths/query strings are often credentials (Slack/Discord etc.).
    // Transport errors may repeat them; report only a safe destination origin.
    let destination = 'invalid target';
    try { destination = new URL(url).origin; } catch { /* Keep generic label. */ }
    console.error(`alert delivery to ${destination} failed: delivery unavailable`);
  }
  return false;
}

export async function notify(unit, options = {}) {
  const targets = parseWebhookTargets(options.webhooks ?? process.env.ALERT_WEBHOOK_URL);
  const context = options.context ?? collectUnitContext(unit, options);
  const snapshot = options.snapshot ?? (unit.includes('feed') ? readFeedStatusSnapshot() : null);
  const payload = buildAlertPayload(unit, context, snapshot, options);

  // Always emit to the journal first: even with no webhook, the operator gets a
  // single greppable line carrying the actual problem.
  console.error(`ALERT ${JSON.stringify(payload.text)}`);

  if (!targets.length) {
    console.error(
      'ALERT_WEBHOOK_URL is not set — no alert was delivered off-box. ' +
        'Set it in /opt/morpheus/nitro/alert-notify.env (see deploy/feed-pusher/FEED-OUTAGE-RUNBOOK.md).'
    );
    return EXIT_NOT_CONFIGURED;
  }

  const results = await Promise.all(
    targets.map((url) => postAlert(url, payload, { ...options, fetchImpl: options.fetchImpl }))
  );
  return results.some(Boolean) ? EXIT_OK : EXIT_DELIVERY_FAILED;
}

// Run the delivery only when node was pointed at THIS file (the systemd
// ExecStart). An `import` from the test suite must not fire a real alert.
// Deliberately the standard ESM entrypoint check rather than an env-var guard:
// `import` statements are hoisted, so a test setting an env var at the top of
// its own module would still evaluate this file's main path first.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const unit = process.argv[2] || 'unknown.service';
  process.exit(await notify(unit));
}
