do $$
begin
  if not exists (
    select 1 from pg_type where typname = 'morpheus_network'
  ) then
    create type morpheus_network as enum ('mainnet', 'testnet');
  end if;
exception
  when duplicate_object then null;
end $$;

alter table morpheus_projects
  add column if not exists network morpheus_network not null default 'mainnet';

alter table morpheus_encrypted_secrets
  add column if not exists network morpheus_network not null default 'mainnet';

alter table morpheus_requests
  add column if not exists network morpheus_network not null default 'mainnet';

alter table morpheus_compute_jobs
  add column if not exists network morpheus_network not null default 'mainnet';

alter table morpheus_feed_snapshots
  add column if not exists network morpheus_network not null default 'mainnet';

alter table morpheus_provider_configs
  add column if not exists network morpheus_network not null default 'mainnet';

alter table morpheus_relayer_runs
  alter column network type morpheus_network
  using (
    case
      -- Cast first so this remains idempotent when a drifted production schema
      -- already uses morpheus_network. Coalescing the enum directly with ''
      -- attempts to parse the empty string as an enum value (SQLSTATE 22P02).
      when trim(coalesce(network::text, '')) = 'mainnet' then 'mainnet'::morpheus_network
      else 'testnet'::morpheus_network
    end
  );

alter table morpheus_relayer_jobs
  add column if not exists network morpheus_network not null default 'mainnet';

alter table morpheus_operation_logs
  add column if not exists network morpheus_network not null default 'mainnet';

alter table morpheus_automation_jobs
  add column if not exists network morpheus_network not null default 'mainnet';

alter table morpheus_automation_runs
  add column if not exists network morpheus_network not null default 'mainnet';

alter table morpheus_system_backups
  add column if not exists network morpheus_network not null default 'mainnet';

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'morpheus_projects_slug_key'
      and conrelid = 'morpheus_projects'::regclass
  ) then
    alter table morpheus_projects drop constraint morpheus_projects_slug_key;
  end if;
exception
  when undefined_object then null;
end $$;

create unique index if not exists ux_morpheus_projects_network_slug on morpheus_projects(network, slug);

create index if not exists idx_morpheus_projects_network on morpheus_projects(network, created_at desc);
create index if not exists idx_morpheus_encrypted_secrets_network on morpheus_encrypted_secrets(network, created_at desc);
create index if not exists idx_morpheus_requests_network on morpheus_requests(network, created_at desc);
create index if not exists idx_morpheus_compute_jobs_network on morpheus_compute_jobs(network, created_at desc);
create index if not exists idx_morpheus_feed_snapshots_network on morpheus_feed_snapshots(network, symbol, created_at desc);
create index if not exists idx_morpheus_provider_configs_network on morpheus_provider_configs(network, updated_at desc);
create index if not exists idx_morpheus_relayer_runs_network on morpheus_relayer_runs(network, created_at desc);
create index if not exists idx_morpheus_relayer_jobs_network on morpheus_relayer_jobs(network, updated_at desc);
create index if not exists idx_morpheus_operation_logs_network on morpheus_operation_logs(network, created_at desc);
create index if not exists idx_morpheus_automation_jobs_network on morpheus_automation_jobs(network, updated_at desc);
create index if not exists idx_morpheus_automation_runs_network on morpheus_automation_runs(network, created_at desc);
create index if not exists idx_morpheus_system_backups_network on morpheus_system_backups(network, created_at desc);

update morpheus_system_backups
set network = coalesce(nullif(metadata->>'network', ''), 'mainnet')::morpheus_network
where network is null or network::text = 'mainnet';

update morpheus_operation_logs
set network = 'testnet'
where network = 'mainnet'
  and (
    coalesce(request_payload->>'network', '') = 'testnet'
    or coalesce(request_payload->>'morpheus_network', '') = 'testnet'
    or coalesce(metadata->>'network', '') = 'testnet'
    or coalesce(metadata->>'morpheus_network', '') = 'testnet'
    or coalesce(response_payload->>'network', '') = 'testnet'
  );
