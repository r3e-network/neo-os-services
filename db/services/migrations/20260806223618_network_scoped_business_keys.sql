-- Business identifiers originate on multiple Neo networks and can legitimately
-- repeat. Keep every parent/child lookup network-scoped so a testnet record can
-- never shadow, update, or authorize access to a mainnet record (or vice versa).

do $$
begin
  if exists (
    select 1
    from morpheus_requests
    group by network, request_id
    having count(*) > 1
  ) then
    raise exception 'cannot scope morpheus_requests: duplicate (network, request_id) rows exist';
  end if;

  if exists (
    select 1
    from morpheus_compute_jobs child
    left join morpheus_requests parent on parent.request_id = child.request_id
    where child.request_id is not null
      and parent.id is null
  ) then
    raise exception 'cannot scope morpheus_compute_jobs: orphan request_id rows exist';
  end if;

  if exists (
    select 1
    from morpheus_relayer_jobs
    group by network, event_key
    having count(*) > 1
  ) then
    raise exception 'cannot scope morpheus_relayer_jobs: duplicate (network, event_key) rows exist';
  end if;

  if exists (
    select 1
    from morpheus_automation_jobs
    group by network, automation_id
    having count(*) > 1
  ) then
    raise exception 'cannot scope morpheus_automation_jobs: duplicate (network, automation_id) rows exist';
  end if;

  if exists (
    select 1
    from morpheus_automation_runs child
    left join morpheus_automation_jobs parent on parent.automation_id = child.automation_id
    where parent.id is null
  ) then
    raise exception 'cannot scope morpheus_automation_runs: orphan automation_id rows exist';
  end if;

  if exists (
    select 1
    from morpheus_workflow_executions
    group by network, execution_id
    having count(*) > 1
  ) then
    raise exception 'cannot scope morpheus_workflow_executions: duplicate (network, execution_id) rows exist';
  end if;
end $$;

-- The former globally unique parent keys make these backfills unambiguous.
-- Perform them before removing the old foreign keys; never infer ownership from
-- a default network value on a child row.
update morpheus_compute_jobs child
set network = parent.network
from morpheus_requests parent
where child.request_id = parent.request_id
  and child.network is distinct from parent.network;

update morpheus_automation_runs child
set network = parent.network
from morpheus_automation_jobs parent
where child.automation_id = parent.automation_id
  and child.network is distinct from parent.network;

alter table morpheus_compute_jobs
  drop constraint if exists morpheus_compute_jobs_request_id_fkey;

alter table morpheus_automation_runs
  drop constraint if exists morpheus_automation_runs_automation_id_fkey;

alter table morpheus_requests
  drop constraint if exists morpheus_requests_request_id_key;

alter table morpheus_relayer_jobs
  drop constraint if exists morpheus_relayer_jobs_event_key_key;

alter table morpheus_automation_jobs
  drop constraint if exists morpheus_automation_jobs_automation_id_key;

alter table morpheus_workflow_executions
  drop constraint if exists morpheus_workflow_executions_execution_id_key;

alter table morpheus_requests
  add constraint morpheus_requests_network_request_id_key
  unique (network, request_id);

alter table morpheus_compute_jobs
  add constraint morpheus_compute_jobs_network_request_id_fkey
  foreign key (network, request_id)
  references morpheus_requests(network, request_id)
  on delete cascade;

alter table morpheus_relayer_jobs
  add constraint morpheus_relayer_jobs_network_event_key_key
  unique (network, event_key);

alter table morpheus_automation_jobs
  add constraint morpheus_automation_jobs_network_automation_id_key
  unique (network, automation_id);

alter table morpheus_automation_runs
  add constraint morpheus_automation_runs_network_automation_id_fkey
  foreign key (network, automation_id)
  references morpheus_automation_jobs(network, automation_id)
  on delete cascade;

alter table morpheus_workflow_executions
  add constraint morpheus_workflow_executions_network_execution_id_key
  unique (network, execution_id);

-- Recreate the effective compute-job policy from migration 0014 with the
-- composite parent identity. Without the network predicate, an owned request on
-- one network could authorize a same-named job on the other network.
drop policy if exists morpheus_compute_jobs_select_own on morpheus_compute_jobs;
create policy morpheus_compute_jobs_select_own on morpheus_compute_jobs
for select to authenticated
using (
  exists (
    select 1
    from morpheus_requests request
    join morpheus_projects project on project.id = request.project_id
    where request.network = morpheus_compute_jobs.network
      and request.request_id = morpheus_compute_jobs.request_id
      and project.owner_user_id = auth.uid()
  )
);
