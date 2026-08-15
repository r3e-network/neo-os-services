create table if not exists morpheus_operation_logs (
  id uuid primary key default gen_random_uuid(),
  operation_id text not null unique,
  route text not null,
  method text not null,
  category text not null check (category in ('oracle', 'compute', 'feed', 'provider_config', 'relayer', 'signing', 'relay', 'runtime', 'attestation', 'network', 'system')),
  project_id uuid references morpheus_projects(id) on delete set null,
  project_slug text,
  request_id text,
  target_chain text check (target_chain in ('neo_n3')),
  status text not null,
  http_status integer,
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb,
  error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_morpheus_operation_logs_created_at on morpheus_operation_logs(created_at desc);
create index if not exists idx_morpheus_operation_logs_category on morpheus_operation_logs(category, created_at desc);
create index if not exists idx_morpheus_operation_logs_route on morpheus_operation_logs(route, created_at desc);
create index if not exists idx_morpheus_operation_logs_request on morpheus_operation_logs(request_id, created_at desc);

alter table morpheus_operation_logs enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'morpheus_operation_logs'
      and policyname = 'morpheus_operation_logs_select_authenticated'
  ) then
    create policy morpheus_operation_logs_select_authenticated on morpheus_operation_logs
    for select to authenticated
    using (true);
  end if;
end $$;
