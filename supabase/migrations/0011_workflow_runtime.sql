create table if not exists morpheus_workflow_executions (
  id uuid primary key default gen_random_uuid(),
  network morpheus_network not null default 'mainnet',
  workflow_id text not null,
  execution_id text not null unique,
  ingress_route text,
  status text not null default 'queued' check (
    status in ('queued', 'dispatched', 'processing', 'succeeded', 'failed', 'cancelled', 'paused')
  ),
  result_envelope_version text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_morpheus_workflow_executions_network_workflow
  on morpheus_workflow_executions(network, workflow_id, created_at desc);

create index if not exists idx_morpheus_workflow_executions_network_status
  on morpheus_workflow_executions(network, status, created_at desc);

alter table morpheus_workflow_executions enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'morpheus_workflow_executions'
      and policyname = 'morpheus_workflow_executions_select_authenticated'
  ) then
    create policy morpheus_workflow_executions_select_authenticated on morpheus_workflow_executions
      for select
      to authenticated
      using (true);
  end if;
exception
  when duplicate_object then null;
end $$;
