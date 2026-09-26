create table if not exists morpheus_provider_configs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references morpheus_projects(id) on delete cascade,
  provider_id text not null,
  enabled boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, provider_id)
);

alter table morpheus_provider_configs enable row level security;

drop policy if exists morpheus_provider_configs_select_own on morpheus_provider_configs;
create policy morpheus_provider_configs_select_own on morpheus_provider_configs
for select to authenticated
using (
  exists (
    select 1 from morpheus_projects p
    where p.id = project_id and p.owner_user_id = auth.uid()
  )
);

drop policy if exists morpheus_provider_configs_insert_own on morpheus_provider_configs;
create policy morpheus_provider_configs_insert_own on morpheus_provider_configs
for insert to authenticated
with check (
  exists (
    select 1 from morpheus_projects p
    where p.id = project_id and p.owner_user_id = auth.uid()
  )
);

drop policy if exists morpheus_provider_configs_update_own on morpheus_provider_configs;
create policy morpheus_provider_configs_update_own on morpheus_provider_configs
for update to authenticated
using (
  exists (
    select 1 from morpheus_projects p
    where p.id = project_id and p.owner_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from morpheus_projects p
    where p.id = project_id and p.owner_user_id = auth.uid()
  )
);

drop policy if exists morpheus_provider_configs_delete_own on morpheus_provider_configs;
create policy morpheus_provider_configs_delete_own on morpheus_provider_configs
for delete to authenticated
using (
  exists (
    select 1 from morpheus_projects p
    where p.id = project_id and p.owner_user_id = auth.uid()
  )
);
