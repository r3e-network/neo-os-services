-- Workflow registry: developer-owned workflow definitions (P0-1 milestone).
--
-- Platform workflows live in the static public catalog (morpheus-runtime-catalog.json).
-- This table is the developer self-serve registry: owners can create, update,
-- activate/pause, and soft-delete their own workflow definitions without platform
-- involvement. Execution wiring (trigger scheduling + TEE execution) reads from here
-- once a workflow is `active`; the MVP ships the registry + lifecycle API first.

create table if not exists morpheus_workflow_registry (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references morpheus_projects(id) on delete cascade,
  workflow_id text not null unique,
  name text not null,
  version integer not null default 1,
  status text not null default 'draft' check (
    status in ('draft', 'active', 'paused', 'deleted')
  ),
  trigger_kind text not null check (trigger_kind in ('request', 'cron', 'http', 'chain_event')),
  trigger_config jsonb not null default '{}'::jsonb,
  handler_source text,
  target_chain text not null default 'neo_n3' check (target_chain in ('neo_n3')),
  network morpheus_network not null default 'mainnet',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Registry rows always live in the user namespace so they can never collide
  -- with platform workflow ids (oracle.query, compute.execute, ...), even when
  -- written by a direct authenticated client rather than the app layer.
  constraint morpheus_workflow_registry_user_namespace check (workflow_id like 'user.%')
);

create index if not exists idx_morpheus_workflow_registry_project
  on morpheus_workflow_registry(project_id, created_at desc);

create index if not exists idx_morpheus_workflow_registry_network_status
  on morpheus_workflow_registry(network, status, created_at desc);

alter table morpheus_workflow_registry enable row level security;

-- Owners manage their own rows through the owning project, matching the
-- morpheus_encrypted_secrets / morpheus_requests pattern.
drop policy if exists morpheus_workflow_registry_select_own on morpheus_workflow_registry;
create policy morpheus_workflow_registry_select_own on morpheus_workflow_registry
for select to authenticated
using (
  exists (
    select 1 from morpheus_projects p
    where p.id = project_id and p.owner_user_id = auth.uid()
  )
);

drop policy if exists morpheus_workflow_registry_insert_own on morpheus_workflow_registry;
create policy morpheus_workflow_registry_insert_own on morpheus_workflow_registry
for insert to authenticated
with check (
  exists (
    select 1 from morpheus_projects p
    where p.id = project_id and p.owner_user_id = auth.uid()
  )
);

drop policy if exists morpheus_workflow_registry_update_own on morpheus_workflow_registry;
create policy morpheus_workflow_registry_update_own on morpheus_workflow_registry
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

drop policy if exists morpheus_workflow_registry_delete_own on morpheus_workflow_registry;
create policy morpheus_workflow_registry_delete_own on morpheus_workflow_registry
for delete to authenticated
using (
  exists (
    select 1 from morpheus_projects p
    where p.id = project_id and p.owner_user_id = auth.uid()
  )
);
