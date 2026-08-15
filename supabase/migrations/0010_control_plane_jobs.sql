create table if not exists morpheus_control_plane_jobs (
  id uuid primary key default gen_random_uuid(),
  network morpheus_network not null default 'mainnet',
  queue text not null check (
    queue in (
      'oracle_request',
      'feed_tick',
      'callback_broadcast',
      'automation_execute'
    )
  ),
  route text not null,
  target_chain text check (target_chain in ('neo_n3')),
  project_slug text,
  request_id text,
  status text not null default 'queued' check (
    status in (
      'queued',
      'dispatching',
      'dispatched',
      'processing',
      'succeeded',
      'failed',
      'dead_lettered',
      'cancelled'
    )
  ),
  dedupe_key text,
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  error text,
  retry_count integer not null default 0,
  run_after timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_morpheus_control_plane_jobs_network_status
  on morpheus_control_plane_jobs(network, status, created_at desc);

create index if not exists idx_morpheus_control_plane_jobs_network_queue_status
  on morpheus_control_plane_jobs(network, queue, status, created_at desc);

create index if not exists idx_morpheus_control_plane_jobs_request_id
  on morpheus_control_plane_jobs(request_id);

create unique index if not exists ux_morpheus_control_plane_jobs_network_dedupe
  on morpheus_control_plane_jobs(network, dedupe_key)
  where dedupe_key is not null and btrim(dedupe_key) <> '';

alter table morpheus_control_plane_jobs enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'morpheus_control_plane_jobs'
      and policyname = 'morpheus_control_plane_jobs_select_authenticated'
  ) then
    create policy morpheus_control_plane_jobs_select_authenticated on morpheus_control_plane_jobs
      for select
      to authenticated
      using (true);
  end if;
exception
  when duplicate_object then null;
end $$;
