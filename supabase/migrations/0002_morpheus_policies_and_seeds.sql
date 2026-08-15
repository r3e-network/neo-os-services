alter table morpheus_projects add column if not exists owner_user_id uuid;

create table if not exists morpheus_compute_functions (
  id uuid primary key default gen_random_uuid(),
  function_name text unique not null,
  category text not null,
  description text not null,
  input_schema jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

alter table morpheus_projects enable row level security;
alter table morpheus_encrypted_secrets enable row level security;
alter table morpheus_requests enable row level security;
alter table morpheus_compute_jobs enable row level security;
alter table morpheus_feed_snapshots enable row level security;
alter table morpheus_compute_functions enable row level security;

drop policy if exists morpheus_projects_select_own on morpheus_projects;
create policy morpheus_projects_select_own on morpheus_projects
for select to authenticated
using (owner_user_id = auth.uid());

drop policy if exists morpheus_projects_insert_own on morpheus_projects;
create policy morpheus_projects_insert_own on morpheus_projects
for insert to authenticated
with check (owner_user_id = auth.uid());

drop policy if exists morpheus_projects_update_own on morpheus_projects;
create policy morpheus_projects_update_own on morpheus_projects
for update to authenticated
using (owner_user_id = auth.uid())
with check (owner_user_id = auth.uid());

drop policy if exists morpheus_secrets_select_own on morpheus_encrypted_secrets;
create policy morpheus_secrets_select_own on morpheus_encrypted_secrets
for select to authenticated
using (
  exists (
    select 1 from morpheus_projects p
    where p.id = project_id and p.owner_user_id = auth.uid()
  )
);

drop policy if exists morpheus_secrets_insert_own on morpheus_encrypted_secrets;
create policy morpheus_secrets_insert_own on morpheus_encrypted_secrets
for insert to authenticated
with check (
  exists (
    select 1 from morpheus_projects p
    where p.id = project_id and p.owner_user_id = auth.uid()
  )
);

drop policy if exists morpheus_requests_select_own on morpheus_requests;
create policy morpheus_requests_select_own on morpheus_requests
for select to authenticated
using (
  project_id is null or exists (
    select 1 from morpheus_projects p
    where p.id = project_id and p.owner_user_id = auth.uid()
  )
);

drop policy if exists morpheus_requests_insert_own on morpheus_requests;
create policy morpheus_requests_insert_own on morpheus_requests
for insert to authenticated
with check (
  project_id is null or exists (
    select 1 from morpheus_projects p
    where p.id = project_id and p.owner_user_id = auth.uid()
  )
);

drop policy if exists morpheus_compute_jobs_select_own on morpheus_compute_jobs;
create policy morpheus_compute_jobs_select_own on morpheus_compute_jobs
for select to authenticated
using (
  exists (
    select 1 from morpheus_requests r
    left join morpheus_projects p on p.id = r.project_id
    where r.request_id = morpheus_compute_jobs.request_id
      and (p.owner_user_id = auth.uid() or r.project_id is null)
  )
);

drop policy if exists morpheus_feed_snapshots_public_read on morpheus_feed_snapshots;
create policy morpheus_feed_snapshots_public_read on morpheus_feed_snapshots
for select to anon, authenticated
using (true);

drop policy if exists morpheus_compute_functions_public_read on morpheus_compute_functions;
create policy morpheus_compute_functions_public_read on morpheus_compute_functions
for select to anon, authenticated
using (enabled = true);

insert into morpheus_compute_functions (function_name, category, description, input_schema)
values
  ('hash.sha256', 'hash', 'Hashes any JSON-serializable payload.', '{"type":"object"}'),
  ('crypto.rsa_verify', 'crypto', 'Verifies an RSA-SHA256 signature (expensive on-chain).', '{"type":"object","required":["public_key","signature","payload"]}'),
  ('math.modexp', 'math', 'Performs big integer modular exponentiation.', '{"type":"object","required":["base","exponent","modulus"]}'),
  ('math.polynomial', 'math', 'Evaluates a polynomial of arbitrary degree.', '{"type":"object","required":["coefficients","x"]}'),
  ('matrix.multiply', 'linear_algebra', 'Multiplies two dense matrices.', '{"type":"object","required":["left","right"]}'),
  ('vector.cosine_similarity', 'linear_algebra', 'Computes cosine similarity between two vectors.', '{"type":"object","required":["left","right"]}'),
  ('zkp.public_signal_hash', 'zkp', 'Computes a deterministic digest over circuit public signals.', '{"type":"object","required":["signals"]}'),
  ('zkp.proof_digest', 'zkp', 'Computes a deterministic digest over a proof object.', '{"type":"object"}'),
  ('fhe.batch_plan', 'fhe', 'Builds a packing plan for ciphertext batching.', '{"type":"object"}'),
  ('fhe.noise_budget_estimate', 'fhe', 'Estimates a rough FHE noise budget from planning parameters.', '{"type":"object"}'),
  ('privacy.mask', 'privacy', 'Masks a sensitive string, leaving edges visible.', '{"type":"object","required":["value"]}'),
  ('privacy.add_noise', 'privacy', 'Adds simulated Laplace noise for differential privacy.', '{"type":"object","required":["value"]}')
on conflict (function_name) do update set
  category = excluded.category,
  description = excluded.description,
  input_schema = excluded.input_schema,
  enabled = true;
