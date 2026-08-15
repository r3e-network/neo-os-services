create extension if not exists pgcrypto;

create table if not exists morpheus_projects (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  owner_wallet text,
  created_at timestamptz not null default now()
);

create table if not exists morpheus_encrypted_secrets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references morpheus_projects(id) on delete cascade,
  name text not null,
  target_chain text not null check (target_chain in ('neo_n3')),
  encryption_algorithm text not null,
  key_version bigint not null default 1,
  ciphertext text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists morpheus_requests (
  id uuid primary key default gen_random_uuid(),
  request_id text unique not null,
  project_id uuid references morpheus_projects(id) on delete set null,
  module text not null check (module in ('privacy_oracle', 'compute', 'datafeed', 'vrf', 'relay')),
  target_chain text not null check (target_chain in ('neo_n3')),
  callback_contract text,
  callback_method text,
  status text not null default 'accepted',
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists morpheus_compute_jobs (
  id uuid primary key default gen_random_uuid(),
  request_id text references morpheus_requests(request_id) on delete cascade,
  mode text not null,
  function_name text,
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  status text not null default 'queued',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists morpheus_feed_snapshots (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  target_chain text not null check (target_chain in ('neo_n3')),
  price numeric,
  payload jsonb not null default '{}'::jsonb,
  signature text,
  public_key text,
  attestation_hash text,
  created_at timestamptz not null default now()
);

create index if not exists idx_morpheus_requests_status on morpheus_requests(status);
create index if not exists idx_morpheus_requests_module on morpheus_requests(module);
create index if not exists idx_morpheus_feed_snapshots_symbol on morpheus_feed_snapshots(symbol, created_at desc);
