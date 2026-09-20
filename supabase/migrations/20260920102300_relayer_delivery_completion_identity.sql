-- Completion identity hardening for the durable delivery journal.
--
-- The v2 transition function accepted a `completed` receipt for a job whose
-- journal never recorded a signed transaction, and accepted RECONCILED on the
-- generic completion path. Delivery success must never stand in for chain
-- confirmation, so this migration replaces public.morpheus_delivery_transition
-- with the same state machine plus these rules:
--   * every validation refusal raises SQLSTATE 22023 (invalid_parameter_value)
--     and leaves the job row untouched; lease loss keeps SQLSTATE P0002;
--   * journal stages must be JSON objects; SQL NULL and scalar payloads are refused;
--   * a signed stage must carry non-blank string `tx_hash` and `raw` values;
--   * `completed` requires the durable signed identity: the journal must hold a
--     signed stage, the receipt `tx_hash` must equal the signed hash exactly and
--     the receipt `vm_state` must be HALT. RECONCILED settlement remains reachable
--     only through the `reconciled` operation for unsigned request jobs, and a
--     finalized fault only through `faulted` against the signed hash.
-- The status vocabulary, grants and every other delivery function are unchanged.
-- Rollback: re-run the create function statement for morpheus_delivery_transition
-- from 20260908040427_relayer_delivery_v2.sql.
create or replace function public.morpheus_delivery_transition(p_job text,p_owner text,p_generation bigint,p_op text,p_data jsonb,p_lease_ms bigint)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare j public.morpheus_delivery_jobs; t timestamptz:=clock_timestamp(); delay_ms bigint;
begin
  select * into j from public.morpheus_delivery_jobs where job_key=p_job for update;
  t:=clock_timestamp();
  if not found or j.lease_owner is distinct from p_owner or j.generation is distinct from p_generation or j.lease_until<=t
    or j.lease_until is null then raise exception using errcode='P0002',message='delivery lease lost'; end if;
  if coalesce(p_lease_ms,0)<1000 or p_lease_ms>300000 then raise exception using errcode='22023',message='invalid lease'; end if;
  if p_op='renew' then
    j.lease_until:=t+p_lease_ms*interval '1 millisecond';
  elsif p_op in ('prepared','signed') then
    if p_data is null or jsonb_typeof(p_data)<>'object' then raise exception using errcode='22023',message='journal must be an object'; end if;
    if j.journal ? p_op and j.journal->p_op<>p_data then raise exception using errcode='22023',message='immutable journal conflict'; end if;
    if p_op='signed' and (not(j.journal ? 'prepared')
      or jsonb_typeof(p_data->'tx_hash') is distinct from 'string' or btrim(p_data->>'tx_hash')=''
      or jsonb_typeof(p_data->'raw') is distinct from 'string' or btrim(p_data->>'raw')='') then
      raise exception using errcode='22023',message='signed journal incomplete'; end if;
    j.journal:=j.journal||jsonb_build_object(p_op,p_data); j.status:=p_op;
  elsif p_op='no_update' then
    if j.kind<>'feed' or j.journal ? 'signed' then raise exception using errcode='22023',message='no-update is only an unsigned feed decision'; end if;
    j.journal:=j.journal||jsonb_build_object('no_update',p_data);j.status:='completed';j.completed_at:=t;j.lease_owner:=null;j.lease_until:=null;
  elsif p_op='faulted' then
    if not(j.journal ? 'signed') or p_data->>'vm_state' is distinct from 'FAULT' or jsonb_typeof(p_data->'tx_hash') is distinct from 'string'
      or p_data->>'tx_hash' is distinct from j.journal->'signed'->>'tx_hash' then
      raise exception using errcode='22023',message='exact finalized fault receipt required'; end if;
    j.journal:=j.journal||jsonb_build_object('receipt',p_data);j.status:='dead_letter';j.completed_at:=t;j.lease_owner:=null;j.lease_until:=null;
  elsif p_op='expired' then
    if not public.morpheus_delivery_expiry_valid(to_jsonb(j),p_data) then raise exception using errcode='22023',message='expiry requires bound archive evidence'; end if;
    insert into public.morpheus_delivery_replays(job_key,actor,reason,prior) values(p_job,p_owner,'archive-proven expiry: '||p_data::text,to_jsonb(j));
    j.journal:='{}';j.status:=case when j.attempts>=j.max_attempts then 'dead_letter' else 'retry_scheduled' end;j.next_attempt_at:=t+interval '1 second';j.lease_owner:=null;j.lease_until:=null;
  elsif p_op='reconciled' then
    if j.kind<>'request' or j.journal ? 'signed' or p_data->'onchain_state'->>'request_id' is distinct from j.request_id
      or lower(p_data->'onchain_state'->>'contract') is distinct from j.contract or p_data->>'vm_state' is distinct from 'RECONCILED'
      or (coalesce(p_data->'onchain_state'->>'status','') not in ('2','3') and coalesce(p_data->'onchain_state'->>'fulfilled_at','0') !~ '^[1-9][0-9]*$') then
      raise exception using errcode='22023',message='bound settled request-state evidence required'; end if;
    j.journal:=j.journal||jsonb_build_object('receipt',p_data);j.status:='completed';j.completed_at:=t;j.lease_owner:=null;j.lease_until:=null;
  elsif p_op='completed' then
    if not(j.journal ? 'signed') or jsonb_typeof(p_data) is distinct from 'object'
      or p_data->>'vm_state' is distinct from 'HALT'
      or jsonb_typeof(p_data->'tx_hash') is distinct from 'string'
      or p_data->>'tx_hash' is distinct from j.journal->'signed'->>'tx_hash' then
      raise exception using errcode='22023',message='completion requires the exact signed transaction identity and a HALT receipt'; end if;
    j.journal:=j.journal||jsonb_build_object('receipt',p_data); j.status:='completed'; j.completed_at:=t;
    j.lease_owner:=null; j.lease_until:=null;
    if j.kind='feed' and jsonb_typeof(j.journal->'prepared'->'feed_baseline_patch')='object' then
      insert into public.morpheus_delivery_feed_baselines(network,chain,contract,payload)
        values(j.network,j.chain,j.contract,j.journal->'prepared'->'feed_baseline_patch')
        on conflict(network,chain,contract) do update set payload=public.morpheus_delivery_feed_baselines.payload||excluded.payload;
    end if;
  elsif p_op in ('retry','terminal') then
    j.last_error:=left(p_data->>'error',1000);
    if p_op='terminal' then j.status:=case when j.journal ? 'signed' then 'reconcile_required' else 'dead_letter' end;
    elsif j.journal ? 'signed' then j.status:='broadcast_unknown';
    elsif j.attempts>=j.max_attempts then j.status:='dead_letter';
    else j.status:='retry_scheduled'; end if;
    delay_ms:=least(300000,(1000*power(2,least(j.attempts,8)))::bigint);
    j.next_attempt_at:=t+delay_ms*interval '1 millisecond';
    j.lease_owner:=null; j.lease_until:=null;
    if j.status in ('dead_letter','reconcile_required') then j.completed_at:=t; end if;
  else raise exception using errcode='22023',message='unsupported delivery transition'; end if;
  update public.morpheus_delivery_jobs set journal=j.journal,status=j.status,last_error=j.last_error,
    lease_owner=j.lease_owner,lease_until=j.lease_until,next_attempt_at=j.next_attempt_at,completed_at=j.completed_at,updated_at=t
    where job_key=p_job returning * into j;
  return to_jsonb(j);
end $$;
