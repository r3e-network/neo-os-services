import { readFileSync, appendFileSync } from 'node:fs';
const ENV_FILE = process.env.RELAYER_ENV_FILE || '/opt/morpheus/nitro/morpheus-relayer.env';
const env = {};
// Keep this parser byte-identical with feed-topup.mjs (each box script is deployed
// as a standalone file): [A-Z0-9_] key charset + matched surrounding-quote strip.
for (const l of readFileSync(ENV_FILE, 'utf8').split('\n')) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
}
const URL = env.SUPABASE_URL,
  KEY = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
const LOG = '/opt/morpheus/nitro/db-prune.log';
const log = (m) => {
  const line = `[${new Date().toISOString()}] ${m}`;
  try {
    appendFileSync(LOG, line + '\n');
  } catch {}
  console.log(line);
};
if (!URL || !KEY) {
  log('FATAL: no Supabase creds in relayer env');
  process.exit(1);
}
const RETAIN_DAYS = Number(process.env.RETAIN_DAYS || 30);
const cutoff = new Date(Date.now() - RETAIN_DAYS * 86400 * 1000).toISOString();
const tables = [
  'morpheus_relayer_runs',
  'morpheus_operation_logs',
  'morpheus_feed_snapshots',
  'morpheus_automation_runs',
  'morpheus_relayer_jobs',
  'morpheus_policy_decisions',
  'morpheus_risk_events',
];
let total = 0;
const failures = [];
const skipped = [];
for (const t of tables) {
  try {
    const r = await fetch(`${URL}/rest/v1/${t}?created_at=lt.${encodeURIComponent(cutoff)}`, {
      method: 'DELETE',
      headers: { apikey: KEY, authorization: 'Bearer ' + KEY, Prefer: 'count=exact' },
      signal: AbortSignal.timeout(60000),
    });
    const cr = r.headers.get('content-range') || '';
    const n = cr.includes('/') ? cr.split('/')[0].split('-').pop() : '?';
    if (r.ok) total += Number(n) || 0;
    // A 404 means the table is absent from this database's schema — there is
    // nothing to prune and no re-bloat risk, so skip it without failing the run.
    else if (r.status === 404) skipped.push(t);
    else failures.push(`${t}: HTTP ${r.status}`);
    log(`${t}: HTTP ${r.status} range=${cr || '-'}`);
  } catch (e) {
    failures.push(`${t}: ${e.message}`);
    log(`${t}: ERROR ${e.message}`);
  }
}
log(
  `prune complete (retain ${RETAIN_DAYS}d, cutoff ${cutoff}); ~${total} rows removed` +
    (skipped.length ? `; skipped absent tables: ${skipped.join(', ')}` : '')
);
// Fail visibly (systemd is-failed) when any DELETE did not land: a silently
// broken prune lets the table re-bloat past the Supabase quota again.
if (failures.length) {
  log(`FATAL: ${failures.length}/${tables.length} tables failed to prune — ${failures.join('; ')}`);
  process.exit(1);
}
