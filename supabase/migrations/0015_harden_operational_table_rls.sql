-- Harden RLS / table grants flagged by the 2026-06 security audit.
--
-- Two problems:
--
--   1. morpheus_system_backups (0007) stores secret material — backup_kind
--      includes 'oracle_keystore' and env snapshots — in a jsonb `payload`, but
--      RLS was NEVER enabled on it. Access was governed only by table grants, and
--      Supabase default-grants SELECT to anon/authenticated on public tables, so
--      the anon key could read keystore/env secrets. (audit finding 43)
--
--   2. Nine operational tables grant SELECT to the `authenticated` role with
--      `using (true)` — an unscoped, cross-tenant read of operation logs, relayer
--      jobs, automation, policy/risk events and workflow executions if Supabase
--      Auth is ever (or already) enabled on the project. (audit findings
--      22,23,25,27,28,32,34,35,41)
--
-- The web app reads all of these tables only through the SERVICE-ROLE key
-- (apps/web/lib/server-supabase.ts), which bypasses RLS and is unaffected by
-- anon/authenticated grants. There is no anon/end-user Supabase client in the
-- codebase. So the safe hardening is: enable RLS on the backups table (no
-- permissive policy -> service-role only), drop the unscoped authenticated
-- SELECT policies, and revoke anon/authenticated grants on every flagged table.
-- (Per-user access, if introduced later, should use owner-scoped policies like
-- 0014 — never `using (true)`.)

-- Enable RLS on the secret-bearing backups table (no policy => only the
-- service-role/owner can read; anon/authenticated denied).
do $$
begin
  if to_regclass('public.morpheus_system_backups') is not null then
    execute 'alter table public.morpheus_system_backups enable row level security';
  end if;
end $$;

-- Drop the unscoped `for select to authenticated using (true)` policies.
do $$
declare
  pair text[];
  policies text[][] := array[
    array['morpheus_control_plane_jobs', 'morpheus_control_plane_jobs_select_authenticated'],
    array['morpheus_operation_logs', 'morpheus_operation_logs_select_authenticated'],
    array['morpheus_relayer_runs', 'morpheus_relayer_runs_select_authenticated'],
    array['morpheus_relayer_jobs', 'morpheus_relayer_jobs_select_authenticated'],
    array['morpheus_automation_jobs', 'morpheus_automation_jobs_select_authenticated'],
    array['morpheus_automation_runs', 'morpheus_automation_runs_select_authenticated'],
    array['morpheus_policy_decisions', 'morpheus_policy_decisions_select_authenticated'],
    array['morpheus_risk_events', 'morpheus_risk_events_select_authenticated'],
    array['morpheus_workflow_executions', 'morpheus_workflow_executions_select_authenticated']
  ];
begin
  foreach pair slice 1 in array policies loop
    if to_regclass('public.' || pair[1]) is not null then
      execute format('drop policy if exists %I on public.%I', pair[2], pair[1]);
    end if;
  end loop;
end $$;

-- Revoke direct anon/authenticated access on the secret/operational tables.
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
    'morpheus_workflow_executions'
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
