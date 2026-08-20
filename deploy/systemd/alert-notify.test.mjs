import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  EXIT_DELIVERY_FAILED,
  EXIT_NOT_CONFIGURED,
  EXIT_OK,
  buildAlertPayload,
  collectUnitContext,
  notify,
  parseWebhookTargets,
  postAlert,
  readFeedStatusSnapshot,
} from './alert-notify.mjs';

// These cover the second half of the 2026-07/08 feed outage: the units already
// exited non-zero, but no OnFailure= target existed, so the exit code went
// nowhere. This notifier is that target.

test('parses a comma-separated webhook list and tolerates whitespace and blanks', () => {
  assert.deepEqual(parseWebhookTargets(' https://a.test/hook , ,https://b.test/hook '), [
    'https://a.test/hook',
    'https://b.test/hook',
  ]);
  assert.deepEqual(parseWebhookTargets(''), []);
  assert.deepEqual(parseWebhookTargets(undefined), []);
});

test('an unconfigured alert path exits EX_CONFIG instead of silently succeeding', async () => {
  const code = await notify('morpheus-feed-monitor.service', {
    webhooks: '',
    context: {},
    snapshot: null,
  });
  assert.equal(code, EXIT_NOT_CONFIGURED);
});

test('carries the failing pair and age out of the monitor snapshot', () => {
  const payload = buildAlertPayload(
    'morpheus-feed-monitor.service',
    { Result: 'exit-code', ExecMainStatus: '1', recent_log: ['ALERT: FEED STALE BTC-USD'] },
    {
      ts: '2026-08-17T03:49:28.000Z',
      ok: false,
      updater_gas: 0.00083,
      feed_age_min: 27542,
      problems: ['FEED STALE BTC-USD age=27542min', 'LOW GAS updater=0.0'],
    },
    { source: 'oracle-box', now: Date.UTC(2026, 7, 17, 3, 49, 28) }
  );

  assert.equal(payload.severity, 'critical');
  assert.equal(payload.unit, 'morpheus-feed-monitor.service');
  assert.equal(payload.source, 'oracle-box');
  assert.equal(payload.exec_main_status, '1');
  assert.match(payload.text, /FEED STALE BTC-USD age=27542min/);
  assert.match(payload.text, /LOW GAS/);
  assert.equal(payload.feed_status.updater_gas, 0.00083);
  assert.equal(payload.timestamp, '2026-08-17T03:49:28.000Z');
});

test('falls back to a generic summary when no snapshot is available', () => {
  const payload = buildAlertPayload('morpheus-feed-pusher.service', {}, null);
  assert.match(payload.text, /morpheus-feed-pusher\.service FAILED: unit failed/);
  assert.deepEqual(payload.problems, []);
  assert.equal(payload.feed_status, null);
});

test('delivers to the first healthy endpoint and reports success', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
    return { ok: url.endsWith('/good') };
  };

  const code = await notify('morpheus-feed-monitor.service', {
    webhooks: 'https://a.test/bad,https://a.test/good',
    context: {},
    snapshot: { ts: null, ok: false, updater_gas: 0, feed_age_min: 1, problems: ['FEED STALE X'] },
    fetchImpl,
    attempts: 1,
    token: 'sekret',
  });

  assert.equal(code, EXIT_OK);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].auth, 'Bearer sekret');
  assert.match(seen[1].body.text, /FEED STALE X/);
});

test('a webhook that never accepts the post exits non-zero rather than pretending', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: false, status: 500 };
  };
  const code = await notify('morpheus-feed-monitor.service', {
    webhooks: 'https://a.test/hook',
    context: {},
    snapshot: null,
    fetchImpl,
    attempts: 3,
  });
  assert.equal(code, EXIT_DELIVERY_FAILED);
  assert.equal(calls, 3, 'each attempt should be retried before giving up');
});

test('a throwing transport is retried and then reported as failed', async () => {
  let calls = 0;
  const ok = await postAlert(
    'https://a.test/hook',
    { text: 'x' },
    {
      attempts: 2,
      fetchImpl: async () => {
        calls += 1;
        throw new Error('ECONNRESET');
      },
    }
  );
  assert.equal(ok, false);
  assert.equal(calls, 2);
});

test('reads the monitor snapshot file and ignores a missing or corrupt one', () => {
  const snapshot = readFeedStatusSnapshot('/ignored', {
    read: () => JSON.stringify({ ts: 't', ok: false, updater_gas: 1.5, problems: ['A'] }),
  });
  assert.deepEqual(snapshot, {
    ts: 't',
    ok: false,
    updater_gas: 1.5,
    feed_age_min: null,
    problems: ['A'],
  });

  assert.equal(
    readFeedStatusSnapshot('/ignored', {
      read: () => {
        throw new Error('ENOENT');
      },
    }),
    null
  );
  assert.equal(readFeedStatusSnapshot('/ignored', { read: () => 'not json' }), null);
});

// The gate that would have caught the original hole: before 2026-08 a repo-wide
// `grep -rn OnFailure` over every .service file returned zero hits, so the feed
// units' non-zero exits had no subscriber at all.
test('every feed unit routes its failure to the alert notifier', () => {
  const feedPusherDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'feed-pusher'
  );
  for (const unit of [
    'morpheus-feed-monitor.service',
    'morpheus-feed-pusher.service',
    'morpheus-feed-topup.service',
  ]) {
    const text = readFileSync(path.join(feedPusherDir, unit), 'utf8');
    assert.match(text, /^OnFailure=morpheus-alert@%n\.service$/m, `${unit} must set OnFailure=`);
  }
});

test('the monitor unit loads the env file its documented knobs live in', () => {
  // MAX_AGE_SEC / MONITOR_PROM_TEXTFILE / TRADFI_* are all documented in
  // feed-pusher.env.example, but only the pusher unit used to load that file,
  // so every documented monitor knob was inert on the box.
  const text = readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'feed-pusher',
      'morpheus-feed-monitor.service'
    ),
    'utf8'
  );
  assert.match(text, /^EnvironmentFile=-?\/opt\/morpheus\/nitro\/feed-pusher\.env$/m);
});

test('unit context collection never throws when systemctl/journalctl are unavailable', () => {
  const context = collectUnitContext('morpheus-feed-monitor.service', {
    run: (command) => {
      if (command === 'systemctl') return 'Result=exit-code\nExecMainStatus=2\n';
      throw new Error('journalctl missing');
    },
  });
  assert.equal(context.Result, 'exit-code');
  assert.equal(context.ExecMainStatus, '2');
});
