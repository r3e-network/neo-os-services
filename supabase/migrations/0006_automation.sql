create table if not exists morpheus_automation_jobs (
  id uuid primary key default gen_random_uuid(),
  automation_id text not null unique,
  registration_request_id text not null,
  project_id uuid references morpheus_projects(id) on delete set null,
  project_slug text,
  chain text not null check (chain in ('neo_n3')),
  requester text not null,
  callback_contract text not null,
  callback_method text not null,
  execution_request_type text not null,
  execution_payload jsonb not null default '{}'::jsonb,
  trigger_type text not null check (trigger_type in ('one_shot', 'interval', 'price_threshold')),
  trigger_config jsonb not null default '{}'::jsonb,
  trigger_state jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active', 'paused', 'cancelled', 'completed', 'error')),
  next_run_at timestamptz,
  last_run_at timestamptz,
  execution_count integer not null default 0,
  max_executions integer,
  last_queued_request_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists morpheus_automation_runs (
  id uuid primary key default gen_random_uuid(),
  automation_id text not null references morpheus_automation_jobs(automation_id) on delete cascade,
  queued_request_id text,
  chain text not null check (chain in ('neo_n3')),
  status text not null check (status in ('queued', 'skipped', 'failed')),
  trigger_reason text,
  observed_value text,
  queue_tx jsonb,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists idx_morpheus_automation_jobs_status on morpheus_automation_jobs(status, next_run_at, updated_at desc);
create index if not exists idx_morpheus_automation_jobs_chain on morpheus_automation_jobs(chain, status, updated_at desc);
create index if not exists idx_morpheus_automation_runs_automation_id on morpheus_automation_runs(automation_id, created_at desc);

alter table morpheus_automation_jobs enable row level security;
alter table morpheus_automation_runs enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'morpheus_automation_jobs'
      and policyname = 'morpheus_automation_jobs_select_authenticated'
  ) then
    create policy morpheus_automation_jobs_select_authenticated on morpheus_automation_jobs
    for select to authenticated
    using (true);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'morpheus_automation_runs'
      and policyname = 'morpheus_automation_runs_select_authenticated'
  ) then
    create policy morpheus_automation_runs_select_authenticated on morpheus_automation_runs
    for select to authenticated
    using (true);
  end if;
end $$;
