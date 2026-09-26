-- 0020: harden remaining RLS — sweep residual unscoped policies.
--
-- Complements 0015_harden_operational_table_rls.sql. 0015 dropped a fixed list
-- of `for select to authenticated using (true)` policies behind per-table
-- guard clauses (`to_regclass` / `pg_roles`); in a partially-applied or
-- drifted environment those guards can skip rows, leaving a window where an
-- authenticated (or anon) user can read operational/secret data
-- (operation logs, relayer jobs, automation, encrypted secrets, backups).
--
-- This migration is belt-and-braces:
--   1. a DYNAMIC sweep drops every policy that grants unscoped SELECT to the
--      `authenticated` role with `using (true)` on a `morpheus_*` table,
--      regardless of name (covers 0004/0005/0006/0010/0011/0012 and any drift);
--   2. RLS is re-asserted (idempotently) on every secret-bearing and
--      operational table;
--   3. anon/authenticated grants are revoked on those tables (fail closed).
--
-- `morpheus_feed_snapshots` keeps its deliberate public read (price data is
-- public by design); it holds no credentials or operational state.

-- 1. Dynamic sweep: drop every unscoped authenticated SELECT policy.
do $$
declare
  rec record;
begin
  for rec in
    select tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename like 'morpheus\_%'
      and array['authenticated']::name[] <@ roles
      and cmd = 'SELECT'
      and qual is not null
      and lower(qual) in ('true', '(true)')
  loop
    execute format('drop policy %I on public.%I', rec.policyname, rec.tablename);
  end loop;
end $$;

-- 2. Re-assert RLS on the secret-bearing / operational tables (idempotent).
do $$
declare
  t text;
  tables text[] := array[
    'morpheus_system_backups',
    'morpheus_control_plane_jobs',
    'morpheus_operation_logs',
    'morpheus_relayer_runs',
    'morpheus_relayer_jobs',
    'morpheus_automation_jobs',
    'morpheus_automation_runs',
    'morpheus_policy_decisions',
    'morpheus_risk_events',
    'morpheus_workflow_executions',
    'morpheus_requests',
    'morpheus_compute_jobs',
    'morpheus_projects',
    'morpheus_encrypted_secrets',
    'morpheus_provider_configs',
    'morpheus_workflow_registry'
  ];
begin
  foreach t in array tables loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
    end if;
  end loop;
end $$;

-- 3. Revoke anon/authenticated access on the same tables (fail closed; the
--    role-existence guards keep this safe on projects without Supabase Auth).
do $$
declare
  t text;
  tables text[] := array[
    'morpheus_system_backups',
    'morpheus_control_plane_jobs',
    'morpheus_operation_logs',
    'morpheus_relayer_runs',
    'morpheus_relayer_jobs',
    'morpheus_automation_jobs',
    'morpheus_automation_runs',
    'morpheus_policy_decisions',
    'morpheus_risk_events',
    'morpheus_workflow_executions',
    'morpheus_requests',
    'morpheus_compute_jobs',
    'morpheus_projects',
    'morpheus_encrypted_secrets',
    'morpheus_provider_configs',
    'morpheus_workflow_registry'
  ];
begin
  foreach t in array tables loop
    if to_regclass('public.' || t) is not null then
      if exists (select 1 from pg_roles where rolname = 'anon') then
        execute format('revoke all on public.%I from anon', t);
      end if;
      if exists (select 1 from pg_roles where rolname = 'authenticated') then
        execute format('revoke all on public.%I from authenticated', t);
      end if;
    end if;
  end loop;
end $$;
