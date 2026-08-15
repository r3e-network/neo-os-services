create table if not exists morpheus_system_backups (
  id uuid primary key default gen_random_uuid(),
  backup_kind text not null check (backup_kind in ('local_env', 'phala_env', 'cvm_runtime_config', 'oracle_keystore')),
  backup_scope text not null,
  checksum text not null,
  payload jsonb not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_morpheus_system_backups_scope on morpheus_system_backups(backup_scope, created_at desc);
create index if not exists idx_morpheus_system_backups_kind on morpheus_system_backups(backup_kind, created_at desc);
