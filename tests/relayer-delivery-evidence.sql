-- Exercise the service-role RPC boundary on real PostgreSQL, not source text.
begin;
set local role service_role;

create function pg_temp.assert_delivery_refused(job jsonb, operation text, payload jsonb)
returns void language plpgsql as $$
declare before_row jsonb; after_row jsonb; accepted boolean := false;
begin
  before_row := public.morpheus_delivery_lookup(job->>'job_key');
  begin
    perform public.morpheus_delivery_transition(job->>'job_key', 'evidence-worker',
      (job->>'generation')::bigint, operation, payload, 60000);
    -- Roll back any erroneously accepted mutation before reporting the failure.
    raise exception using errcode='PZ001', message='unexpected acceptance';
  exception
    when sqlstate '22023' then null;
    when sqlstate 'PZ001' then accepted := true;
  end;
  after_row := public.morpheus_delivery_lookup(job->>'job_key');
  if after_row is distinct from before_row then
    raise exception 'rejected operation changed job: %', operation;
  end if;
  if accepted then raise exception 'unsafe delivery transition accepted: % (%)', operation, payload; end if;
end $$;

do $$
declare j jsonb; payload jsonb;
begin
  perform morpheus_delivery_enqueue('testnet','neo_n3','evidence-oracle','701',
    'evidence-account','{"requestId":"701"}');
  j := morpheus_delivery_claim('testnet','neo_n3','evidence-account','evidence-worker',60000);

  -- A receipt label without a durable signed identity cannot complete a job.
  perform pg_temp.assert_delivery_refused(j,'completed','{"tx_hash":"tx-a","vm_state":"HALT"}');
  foreach payload in array array[null::jsonb,'null'::jsonb,'[]'::jsonb,'true'::jsonb,'"text"'::jsonb] loop
    perform pg_temp.assert_delivery_refused(j,'prepared',payload);
  end loop;
  perform morpheus_delivery_transition(j->>'job_key','evidence-worker',
    (j->>'generation')::bigint,'prepared','{}',60000);
  foreach payload in array array[
    '{"tx_hash":42,"raw":"bytes"}'::jsonb,
    '{"tx_hash":"tx-a","raw":{}}'::jsonb,
    '{"tx_hash":" ","raw":"bytes"}'::jsonb,
    '{"tx_hash":"tx-a","raw":" "}'::jsonb,
    '{"tx_hash":"tx-a"}'::jsonb
  ] loop
    perform pg_temp.assert_delivery_refused(j,'signed',payload);
  end loop;
  perform morpheus_delivery_transition(j->>'job_key','evidence-worker',
    (j->>'generation')::bigint,'signed','{"tx_hash":"tx-a","raw":"signed-bytes"}',60000);

  foreach payload in array array[
    '{"tx_hash":"tx-b","vm_state":"HALT"}'::jsonb,
    '{"tx_hash":"tx-a","vm_state":"RECONCILED"}'::jsonb,
    '{"tx_hash":"tx-a","vm_state":"FAULT"}'::jsonb,
    '{"vm_state":"HALT"}'::jsonb
  ] loop
    perform pg_temp.assert_delivery_refused(j,'completed',payload);
  end loop;
  j := morpheus_delivery_transition(j->>'job_key','evidence-worker',
    (j->>'generation')::bigint,'completed','{"tx_hash":"tx-a","vm_state":"HALT"}',60000);
  if j->>'status' is distinct from 'completed' or j->'journal'->'receipt'->>'tx_hash' is distinct from 'tx-a' then
    raise exception 'exact signed HALT receipt was not preserved';
  end if;
end $$;
rollback;
