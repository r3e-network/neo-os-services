create table if not exists morpheus_relayer_runs (
  id uuid primary key default gen_random_uuid(),
  network text not null,
  status text not null default 'completed',
  started_at timestamptz,
  completed_at timestamptz,
  duration_ms integer,
  metrics jsonb not null default '{}'::jsonb,
  checkpoints jsonb not null default '{}'::jsonb,
  runtime jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists morpheus_relayer_jobs (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  chain text not null check (chain in ('neo_n3')),
  request_id text not null,
  request_type text not null,
  tx_hash text,
  block_number bigint,
  route text,
  status text not null,
  attempts integer not null default 0,
  last_error text,
  next_retry_at timestamptz,
  worker_status integer,
  worker_response jsonb,
  fulfill_tx jsonb,
  event jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_morpheus_relayer_runs_created_at on morpheus_relayer_runs(created_at desc);
create index if not exists idx_morpheus_relayer_jobs_status on morpheus_relayer_jobs(status, updated_at desc);
create index if not exists idx_morpheus_relayer_jobs_chain on morpheus_relayer_jobs(chain, updated_at desc);
create index if not exists idx_morpheus_relayer_jobs_request on morpheus_relayer_jobs(request_id);

alter table morpheus_relayer_runs enable row level security;
alter table morpheus_relayer_jobs enable row level security;

drop policy if exists morpheus_relayer_runs_select_authenticated on morpheus_relayer_runs;
create policy morpheus_relayer_runs_select_authenticated on morpheus_relayer_runs
for select to authenticated
using (true);

drop policy if exists morpheus_relayer_jobs_select_authenticated on morpheus_relayer_jobs;
create policy morpheus_relayer_jobs_select_authenticated on morpheus_relayer_jobs
for select to authenticated
using (true);
