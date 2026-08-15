#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const KNOWN_RUNTIME_TABLES = [
  'morpheus_relayer_runs',
  'morpheus_feed_snapshots',
  'morpheus_control_plane_jobs',
  'morpheus_relayer_jobs',
  'morpheus_operation_logs',
  'morpheus_automation_runs',
  'morpheus_workflow_executions',
];

function parseArgs(argv) {
  const options = {
    envFile: '.env',
    apply: false,
    vacuum: false,
    vacuumFull: false,
    relayerRunHours: 24,
    feedDays: 7,
    feedKeepPerPair: 3,
    terminalJobDays: 14,
    operationLogDays: 7,
    automationRunDays: 30,
    workflowDays: 14,
    directHost: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--vacuum') options.vacuum = true;
    else if (arg === '--vacuum-full') {
      options.vacuum = true;
      options.vacuumFull = true;
    } else if (arg === '--env-file') {
      options.envFile = argv[++index];
    } else if (arg.startsWith('--env-file=')) {
      options.envFile = arg.slice('--env-file='.length);
    } else if (arg === '--relayer-run-hours') {
      options.relayerRunHours = positiveInt(argv[++index], 'relayer-run-hours');
    } else if (arg === '--feed-days') {
      options.feedDays = positiveInt(argv[++index], 'feed-days');
    } else if (arg === '--feed-keep-per-pair') {
      options.feedKeepPerPair = positiveInt(argv[++index], 'feed-keep-per-pair');
    } else if (arg === '--terminal-job-days') {
      options.terminalJobDays = positiveInt(argv[++index], 'terminal-job-days');
    } else if (arg === '--operation-log-days') {
      options.operationLogDays = positiveInt(argv[++index], 'operation-log-days');
    } else if (arg === '--automation-run-days') {
      options.automationRunDays = positiveInt(argv[++index], 'automation-run-days');
    } else if (arg === '--workflow-days') {
      options.workflowDays = positiveInt(argv[++index], 'workflow-days');
    } else if (arg === '--direct-host') {
      options.directHost = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function positiveInt(value, name) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  node scripts/cleanup-supabase-runtime-data.mjs
  node scripts/cleanup-supabase-runtime-data.mjs --apply --vacuum

Options:
  --env-file <path>              Dotenv file with POSTGRES_URL_NON_POOLING/POSTGRES_URL
  --apply                        Delete expired runtime rows
  --vacuum                       VACUUM ANALYZE cleaned runtime tables after delete
  --vacuum-full                  VACUUM FULL cleaned runtime tables after delete
  --relayer-run-hours <n>        Keep relayer run telemetry for n hours (default: 24)
  --feed-days <n>                Keep feed snapshots for n days (default: 7)
  --feed-keep-per-pair <n>       Always keep latest n snapshots per network/symbol/chain (default: 3)
  --terminal-job-days <n>        Keep terminal queue/control jobs for n days (default: 14)
  --operation-log-days <n>       Keep operation logs for n days (default: 7)
  --automation-run-days <n>      Keep skipped/failed automation runs for n days (default: 30)
  --workflow-days <n>            Keep terminal workflow executions for n days (default: 14)
  --direct-host                  Rewrite Supabase pooler host to db.<project-ref>.supabase.co`);
}

function loadDotenv(filePath) {
  const env = { ...process.env };
  const absolute = resolve(filePath);
  if (!existsSync(absolute)) return env;

  for (const line of readFileSync(absolute, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in env)) env[key] = value;
  }
  return env;
}

function resolveDatabaseEnv(rawEnv, options = {}) {
  const connectionString =
    rawEnv.POSTGRES_URL_NON_POOLING ||
    rawEnv.POSTGRES_URL ||
    rawEnv.morpheus_POSTGRES_URL_NON_POOLING ||
    rawEnv.morpheus_POSTGRES_URL ||
    rawEnv.DATABASE_URL;

  if (!connectionString) {
    throw new Error('Missing POSTGRES_URL_NON_POOLING, POSTGRES_URL, or DATABASE_URL');
  }

  const parsed = new URL(connectionString);
  const projectRef = /^postgres\.([a-z0-9]+)$/i.exec(decodeURIComponent(parsed.username))?.[1];
  if (options.directHost && projectRef) {
    parsed.hostname = `db.${projectRef}.supabase.co`;
    parsed.port = '5432';
  }
  return {
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || '5432',
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: decodeURIComponent(parsed.pathname.replace(/^\//, '') || 'postgres'),
    PGSSLMODE: parsed.searchParams.get('sslmode') || 'require',
    PGCONNECT_TIMEOUT: rawEnv.PGCONNECT_TIMEOUT || '12',
  };
}

function findPsql() {
  const candidates = [
    process.env.PSQL_BIN,
    'psql',
    '/opt/homebrew/opt/libpq/bin/psql',
    '/opt/homebrew/bin/psql',
    '/usr/local/opt/libpq/bin/psql',
    '/usr/local/bin/psql',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.includes('/')) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    for (const dir of String(process.env.PATH || '').split(':')) {
      const resolved = resolve(dir, candidate);
      if (existsSync(resolved)) return candidate;
    }
  }

  throw new Error('psql is not installed; install libpq/postgresql or set PSQL_BIN');
}

function runPsql(sql, dbEnv) {
  const psql = findPsql();
  const child = spawn(
    psql,
    [
      '--no-psqlrc',
      '--set',
      'ON_ERROR_STOP=1',
      '--quiet',
      '--tuples-only',
      '--no-align',
      '-f',
      '-',
    ],
    {
      env: {
        ...process.env,
        ...dbEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  child.stdin.end(sql);

  return new Promise((resolvePromise, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`psql failed with exit code ${code}: ${stderr.trim()}`));
        return;
      }
      resolvePromise({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function analyzeSql() {
  const known = KNOWN_RUNTIME_TABLES.map((name) => `'${name}'`).join(', ');
  return `
with table_stats as (
  select
    schemaname,
    relname,
    n_live_tup,
    n_dead_tup,
    pg_total_relation_size(format('%I.%I', schemaname, relname)::regclass) as bytes,
    pg_size_pretty(pg_total_relation_size(format('%I.%I', schemaname, relname)::regclass)) as total_size,
    pg_relation_size(format('%I.%I', schemaname, relname)::regclass) as table_bytes,
    pg_indexes_size(format('%I.%I', schemaname, relname)::regclass) as index_bytes
  from pg_stat_user_tables
  where schemaname = 'public'
),
top_tables as (
  select * from table_stats order by bytes desc limit 30
),
runtime_tables as (
  select * from table_stats where relname in (${known}) order by bytes desc
)
select jsonb_build_object(
  'mode', 'analyze',
  'generated_at', now(),
  'database', current_database(),
  'top_tables', coalesce((select jsonb_agg(to_jsonb(top_tables) order by bytes desc) from top_tables), '[]'::jsonb),
  'runtime_tables', coalesce((select jsonb_agg(to_jsonb(runtime_tables) order by bytes desc) from runtime_tables), '[]'::jsonb)
)::text;
`;
}

function cleanupSql(options) {
  const terminalStatuses = [
    'succeeded',
    'completed',
    'failed',
    'cancelled',
    'dead_lettered',
    'fulfilled',
  ];
  const terminalList = terminalStatuses.map((status) => `'${status}'`).join(', ');
  const vacuumMode = options.vacuumFull ? 'FULL, ANALYZE' : 'ANALYZE';
  const vacuumSql = options.vacuum
    ? KNOWN_RUNTIME_TABLES.map(
        (tableName) => `
do $$
begin
  if to_regclass('public.${tableName}') is not null then
    execute 'vacuum (${vacuumMode}) public.${tableName}';
  end if;
end $$;`
      ).join('\n')
    : '';

  return `
create temp table cleanup_counts (
  table_name text not null,
  rule text not null,
  rows_deleted bigint not null
) on commit drop;

do $$
declare
  deleted bigint;
  has_network boolean;
begin
  if to_regclass('public.morpheus_relayer_runs') is not null then
    delete from public.morpheus_relayer_runs
    where created_at < now() - interval '${options.relayerRunHours} hours';
    get diagnostics deleted = row_count;
    insert into cleanup_counts values ('morpheus_relayer_runs', 'created_at older than ${options.relayerRunHours} hours', deleted);
  end if;

  if to_regclass('public.morpheus_feed_snapshots') is not null then
    select exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'morpheus_feed_snapshots'
        and column_name = 'network'
    ) into has_network;

    if has_network then
      execute $feed$
        with ranked as (
          select
            id,
            row_number() over (
              partition by network, symbol, target_chain
              order by created_at desc
            ) as snapshot_rank
          from public.morpheus_feed_snapshots
        )
        delete from public.morpheus_feed_snapshots snapshots
        using ranked
        where snapshots.id = ranked.id
          and ranked.snapshot_rank > ${options.feedKeepPerPair}
          and snapshots.created_at < now() - interval '${options.feedDays} days'
      $feed$;
    else
      execute $feed$
        with ranked as (
          select
            id,
            row_number() over (
              partition by symbol, target_chain
              order by created_at desc
            ) as snapshot_rank
          from public.morpheus_feed_snapshots
        )
        delete from public.morpheus_feed_snapshots snapshots
        using ranked
        where snapshots.id = ranked.id
          and ranked.snapshot_rank > ${options.feedKeepPerPair}
          and snapshots.created_at < now() - interval '${options.feedDays} days'
      $feed$;
    end if;
    get diagnostics deleted = row_count;
    insert into cleanup_counts values (
      'morpheus_feed_snapshots',
      'older than ${options.feedDays} days while keeping latest ${options.feedKeepPerPair} per pair',
      deleted
    );
  end if;

  if to_regclass('public.morpheus_control_plane_jobs') is not null then
    delete from public.morpheus_control_plane_jobs
    where status in (${terminalList})
      and coalesce(completed_at, updated_at, created_at) < now() - interval '${options.terminalJobDays} days';
    get diagnostics deleted = row_count;
    insert into cleanup_counts values ('morpheus_control_plane_jobs', 'terminal older than ${options.terminalJobDays} days', deleted);
  end if;

  if to_regclass('public.morpheus_relayer_jobs') is not null then
    delete from public.morpheus_relayer_jobs
    where status in (${terminalList})
      and coalesce(completed_at, updated_at, created_at) < now() - interval '${options.terminalJobDays} days';
    get diagnostics deleted = row_count;
    insert into cleanup_counts values ('morpheus_relayer_jobs', 'terminal older than ${options.terminalJobDays} days', deleted);
  end if;

  if to_regclass('public.morpheus_operation_logs') is not null then
    delete from public.morpheus_operation_logs
    where created_at < now() - interval '${options.operationLogDays} days';
    get diagnostics deleted = row_count;
    insert into cleanup_counts values ('morpheus_operation_logs', 'created_at older than ${options.operationLogDays} days', deleted);
  end if;

  if to_regclass('public.morpheus_automation_runs') is not null then
    delete from public.morpheus_automation_runs
    where status in ('skipped', 'failed')
      and created_at < now() - interval '${options.automationRunDays} days';
    get diagnostics deleted = row_count;
    insert into cleanup_counts values ('morpheus_automation_runs', 'terminal older than ${options.automationRunDays} days', deleted);
  end if;

  if to_regclass('public.morpheus_workflow_executions') is not null then
    delete from public.morpheus_workflow_executions
    where status in (${terminalList})
      and coalesce(completed_at, updated_at, created_at) < now() - interval '${options.workflowDays} days';
    get diagnostics deleted = row_count;
    insert into cleanup_counts values ('morpheus_workflow_executions', 'terminal older than ${options.workflowDays} days', deleted);
  end if;
end $$;

select jsonb_build_object(
  'mode', 'cleanup',
  'generated_at', now(),
  'retention', jsonb_build_object(
    'relayer_run_hours', ${options.relayerRunHours},
    'feed_days', ${options.feedDays},
    'feed_keep_per_pair', ${options.feedKeepPerPair},
    'terminal_job_days', ${options.terminalJobDays},
    'operation_log_days', ${options.operationLogDays},
    'automation_run_days', ${options.automationRunDays},
    'workflow_days', ${options.workflowDays},
    'vacuum', ${options.vacuum},
    'vacuum_full', ${options.vacuumFull}
  ),
  'deleted', coalesce((select jsonb_agg(to_jsonb(cleanup_counts) order by table_name) from cleanup_counts), '[]'::jsonb)
)::text;

${vacuumSql}
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rawEnv = loadDotenv(options.envFile);
  const dbEnv = resolveDatabaseEnv(rawEnv, options);
  const result = await runPsql(options.apply ? cleanupSql(options) : analyzeSql(), dbEnv);
  if (result.stderr) {
    console.error(result.stderr);
  }
  console.log(result.stdout);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
