create table if not exists morpheus_policy_decisions (
  id uuid primary key default gen_random_uuid(),
  network morpheus_network not null default 'mainnet',
  workflow_id text,
  execution_id text,
  scope text not null,
  decision text not null check (decision in ('allow', 'deny', 'review')),
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists morpheus_risk_events (
  id uuid primary key default gen_random_uuid(),
  network morpheus_network not null default 'mainnet',
  scope text not null,
  scope_id text not null,
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  action text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_morpheus_policy_decisions_network_workflow
  on morpheus_policy_decisions(network, workflow_id, created_at desc);

create index if not exists idx_morpheus_risk_events_network_scope
  on morpheus_risk_events(network, scope, scope_id, created_at desc);

alter table morpheus_policy_decisions enable row level security;
alter table morpheus_risk_events enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'morpheus_policy_decisions'
      and policyname = 'morpheus_policy_decisions_select_authenticated'
  ) then
    create policy morpheus_policy_decisions_select_authenticated on morpheus_policy_decisions
      for select
      to authenticated
      using (true);
  end if;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'morpheus_risk_events'
      and policyname = 'morpheus_risk_events_select_authenticated'
  ) then
    create policy morpheus_risk_events_select_authenticated on morpheus_risk_events
      for select
      to authenticated
      using (true);
  end if;
exception
  when duplicate_object then null;
end $$;
