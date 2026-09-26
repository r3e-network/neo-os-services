-- Tighten RLS so rows with a NULL project_id are not world-readable by any
-- authenticated user (cross-tenant leak), and replace the invalid
-- `create policy if not exists` DDL (unsupported by Postgres) with a valid
-- guarded `drop policy if exists` + `create policy` pair.
--
-- Affected tables:
--   - morpheus_requests (select policy)
--   - morpheus_compute_jobs (select policy)
--
-- NULL project_id rows are system/anonymous records that have no owning project
-- and therefore no owner_user_id to scope to. They remain fully accessible to the
-- service-role key (which bypasses RLS) used by the control-plane backend; they
-- are simply no longer visible to arbitrary end-user (authenticated) sessions.

-- Ensure RLS stays enabled (idempotent; matches 0002).
alter table morpheus_requests enable row level security;
alter table morpheus_compute_jobs enable row level security;

-- morpheus_requests: scope SELECT to owned projects only (drop the
-- `project_id is null or ...` escape hatch that exposed untenanted rows).
drop policy if exists morpheus_requests_select_own on morpheus_requests;
create policy morpheus_requests_select_own on morpheus_requests
for select to authenticated
using (
  exists (
    select 1 from morpheus_projects p
    where p.id = project_id and p.owner_user_id = auth.uid()
  )
);

-- morpheus_compute_jobs: scope SELECT through the parent request's owned
-- project only (drop the `r.project_id is null` escape hatch). Use an inner
-- join so jobs whose request has a NULL project_id are excluded.
drop policy if exists morpheus_compute_jobs_select_own on morpheus_compute_jobs;
create policy morpheus_compute_jobs_select_own on morpheus_compute_jobs
for select to authenticated
using (
  exists (
    select 1 from morpheus_requests r
    join morpheus_projects p on p.id = r.project_id
    where r.request_id = morpheus_compute_jobs.request_id
      and p.owner_user_id = auth.uid()
  )
);
