-- Additive cutover. Legacy morpheus_relayer_jobs is never executed by v2.
-- Import/reconcile legacy work explicitly before selecting deliveryProtocol=v2.
create table public.morpheus_delivery_jobs (
  job_key text primary key,
  network text not null check(network in ('mainnet','testnet')),
  chain text not null check(chain in ('neo_n3','neox')),
  kind text not null default 'request' check(kind in ('request','feed','xcm')),
  contract text not null, request_id text not null, account_scope text not null,
  event jsonb not null check(jsonb_typeof(event)='object'),
  status text not null default 'queued' check(status in ('queued','processing','prepared','signed','broadcast_unknown','retry_scheduled','completed','dead_letter','reconcile_required')),
  attempts integer not null default 0, max_attempts integer not null default 6 check(max_attempts between 1 and 1000),
  generation bigint not null default 0, lease_owner text, lease_until timestamptz,
  next_attempt_at timestamptz not null default clock_timestamp(),
  journal jsonb not null default '{}', last_error text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(), completed_at timestamptz,
  unique(network,chain,contract,kind,request_id)
);
create index morpheus_delivery_ready on public.morpheus_delivery_jobs(network,chain,account_scope,next_attempt_at,created_at)
  where status not in ('completed','dead_letter','reconcile_required');
create table public.morpheus_delivery_cursors (
  network text not null, chain text not null, contract text not null,
  cursor numeric(78,0) not null, updated_at timestamptz not null default clock_timestamp(),
  primary key(network,chain,contract)
);
create table public.morpheus_delivery_replays (
  id bigint generated always as identity primary key, job_key text not null,
  actor text not null, reason text not null, prior jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
create table public.morpheus_delivery_feed_baselines (
  network text not null,chain text not null,contract text not null,payload jsonb not null,
  primary key(network,chain,contract)
);
create table public.morpheus_delivery_lane_turns (
  network text not null,chain text not null,account_scope text not null,kind text not null,last_claim_at timestamptz not null,
  primary key(network,chain,account_scope,kind)
);
create table public.morpheus_delivery_imports (
  job_key text not null references public.morpheus_delivery_jobs(job_key),
  source_digest text not null,payload jsonb not null,decision text not null,
  created_at timestamptz not null default clock_timestamp(),primary key(job_key,source_digest)
);
alter table public.morpheus_delivery_imports enable row level security;
grant select,insert on public.morpheus_delivery_imports to service_role;
alter table public.morpheus_delivery_jobs enable row level security;
alter table public.morpheus_delivery_cursors enable row level security;
alter table public.morpheus_delivery_replays enable row level security;
alter table public.morpheus_delivery_feed_baselines enable row level security;
alter table public.morpheus_delivery_lane_turns enable row level security;
grant select,insert,update on public.morpheus_delivery_feed_baselines,public.morpheus_delivery_lane_turns to service_role;
revoke all on public.morpheus_delivery_jobs,public.morpheus_delivery_cursors,public.morpheus_delivery_replays from public;
grant select,insert,update on public.morpheus_delivery_jobs,public.morpheus_delivery_cursors to service_role;
grant select,insert on public.morpheus_delivery_replays to service_role;
grant usage on sequence public.morpheus_delivery_replays_id_seq to service_role;

create function public.morpheus_delivery_enqueue(p_network text,p_chain text,p_contract text,p_request_id text,p_account text,p_event jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare j public.morpheus_delivery_jobs; k text; job_kind text:=coalesce(p_event->>'kind','request');
begin
  if p_contract='' or p_account='' or p_request_id !~ '^([0-9]+|0x[0-9a-f]{64})$' or p_event->>'requestId' is distinct from p_request_id then
    raise exception 'invalid delivery identity';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_network,p_chain,p_account)::text,42));
  if job_kind='feed' then
    select * into j from public.morpheus_delivery_jobs where network=p_network and chain=p_chain and contract=lower(p_contract)
      and kind='feed' and status not in ('completed','dead_letter') order by created_at limit 1;
    if found then return to_jsonb(j); end if;
  end if;
  k := jsonb_build_array(p_network,p_chain,lower(p_contract),job_kind,p_request_id)::text;
  insert into public.morpheus_delivery_jobs(job_key,network,chain,contract,kind,request_id,account_scope,event,max_attempts)
    values(k,p_network,p_chain,lower(p_contract),job_kind,p_request_id,p_account,p_event,coalesce((p_event->>'max_attempts')::integer,6))
    on conflict(job_key) do nothing;
  select * into strict j from public.morpheus_delivery_jobs where job_key=k;
  if j.account_scope<>p_account then raise exception 'delivery account changed; explicit cutover required'; end if;
  if (j.event->'payload') is distinct from (p_event->'payload') or (j.event->'payload_digest') is distinct from (p_event->'payload_digest') then raise exception 'delivery payload changed for existing request'; end if;
  return to_jsonb(j);
end $$;

create function public.morpheus_delivery_claim(p_network text,p_chain text,p_account text,p_owner text,p_lease_ms bigint,p_kinds text[] default array['request','feed','xcm'])
returns jsonb language plpgsql security invoker set search_path='' as $$
declare j public.morpheus_delivery_jobs; t timestamptz := clock_timestamp();
begin
  if coalesce(p_owner,'')='' or coalesce(p_lease_ms,0)<1000 or p_lease_ms>300000 then raise exception 'invalid lease'; end if;
  -- Serialize the account decision, including the no-active-owner predicate.
  perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_network,p_chain,p_account)::text,42));
  t:=clock_timestamp();
  if exists(select 1 from public.morpheus_delivery_jobs where network=p_network and chain=p_chain and account_scope=p_account
      and lease_until>t and status not in ('completed','dead_letter')) then return null; end if;
  -- An unknown signed transaction reserves its nonce until reconciled, even
  -- when its worker lease expires or its next observation is not due yet.
  if exists(select 1 from public.morpheus_delivery_jobs where network=p_network and chain=p_chain and account_scope=p_account
      and status='reconcile_required') then return null; end if;
  select * into j from public.morpheus_delivery_jobs where network=p_network and chain=p_chain and account_scope=p_account
    and kind=any(p_kinds)
    and status not in ('completed','dead_letter','reconcile_required')
    and next_attempt_at<=t and (lease_until is null or lease_until<=t)
    and (journal ? 'signed' or not exists(select 1 from public.morpheus_delivery_jobs pending
      where pending.network=p_network and pending.chain=p_chain and pending.account_scope=p_account
      and pending.journal ? 'signed' and pending.status not in ('completed','dead_letter')))
    order by (journal ? 'signed') desc,
      (select last_claim_at from public.morpheus_delivery_lane_turns turns where turns.network=p_network and turns.chain=p_chain
        and turns.account_scope=p_account and turns.kind=morpheus_delivery_jobs.kind) asc nulls first,
      next_attempt_at,created_at,job_key for update skip locked limit 1;
  if not found then return null; end if;
  if j.attempts>=j.max_attempts and not(j.journal ? 'signed') then
    update public.morpheus_delivery_jobs set status='dead_letter',lease_owner=null,lease_until=null,updated_at=t,completed_at=t where job_key=j.job_key returning * into j;
    return to_jsonb(j);
  end if;
  update public.morpheus_delivery_jobs set status=case when journal ? 'signed' then 'broadcast_unknown' else 'processing' end,
    generation=generation+1,lease_owner=p_owner,lease_until=t+p_lease_ms*interval '1 millisecond',
    attempts=attempts+case when journal ? 'signed' then 0 else 1 end,updated_at=t
    where job_key=j.job_key returning * into j;
  insert into public.morpheus_delivery_lane_turns(network,chain,account_scope,kind,last_claim_at)
    values(p_network,p_chain,p_account,j.kind,t) on conflict(network,chain,account_scope,kind) do update set last_claim_at=excluded.last_claim_at;
  return to_jsonb(j);
end $$;

create function public.morpheus_delivery_transition(p_job text,p_owner text,p_generation bigint,p_op text,p_data jsonb,p_lease_ms bigint)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare j public.morpheus_delivery_jobs; t timestamptz:=clock_timestamp(); delay_ms bigint;
begin
  select * into j from public.morpheus_delivery_jobs where job_key=p_job for update;
  t:=clock_timestamp();
  if not found or j.lease_owner is distinct from p_owner or j.generation is distinct from p_generation or j.lease_until<=t
    or j.lease_until is null then raise exception using errcode='P0002',message='delivery lease lost'; end if;
  if coalesce(p_lease_ms,0)<1000 or p_lease_ms>300000 then raise exception 'invalid lease'; end if;
  if p_op='renew' then
    j.lease_until:=t+p_lease_ms*interval '1 millisecond';
  elsif p_op in ('prepared','signed') then
    if jsonb_typeof(p_data)<>'object' then raise exception 'journal must be an object'; end if;
    if j.journal ? p_op and j.journal->p_op<>p_data then raise exception 'immutable journal conflict'; end if;
    if p_op='signed' and (not(j.journal ? 'prepared') or coalesce(p_data->>'tx_hash','')='' or coalesce(p_data->>'raw','')='') then raise exception 'signed journal incomplete'; end if;
    j.journal:=j.journal||jsonb_build_object(p_op,p_data); j.status:=p_op;
  elsif p_op='no_update' then
    if j.kind<>'feed' or j.journal ? 'signed' then raise exception 'no-update is only an unsigned feed decision'; end if;
    j.journal:=j.journal||jsonb_build_object('no_update',p_data);j.status:='completed';j.completed_at:=t;j.lease_owner:=null;j.lease_until:=null;
  elsif p_op='faulted' then
    if p_data->>'vm_state' is distinct from 'FAULT' or coalesce(p_data->>'tx_hash','')='' or p_data->>'tx_hash' is distinct from j.journal->'signed'->>'tx_hash' then raise exception 'exact finalized fault receipt required'; end if;
    j.journal:=j.journal||jsonb_build_object('receipt',p_data);j.status:='dead_letter';j.completed_at:=t;j.lease_owner:=null;j.lease_until:=null;
  elsif p_op='expired' then
    if not public.morpheus_delivery_expiry_valid(to_jsonb(j),p_data) then raise exception 'expiry requires bound archive evidence'; end if;
    insert into public.morpheus_delivery_replays(job_key,actor,reason,prior) values(p_job,p_owner,'archive-proven expiry: '||p_data::text,to_jsonb(j));
    j.journal:='{}';j.status:=case when j.attempts>=j.max_attempts then 'dead_letter' else 'retry_scheduled' end;j.next_attempt_at:=t+interval '1 second';j.lease_owner:=null;j.lease_until:=null;
  elsif p_op='reconciled' then
    if j.kind<>'request' or j.journal ? 'signed' or p_data->'onchain_state'->>'request_id' is distinct from j.request_id
      or lower(p_data->'onchain_state'->>'contract') is distinct from j.contract or p_data->>'vm_state' is distinct from 'RECONCILED'
      or (coalesce(p_data->'onchain_state'->>'status','') not in ('2','3') and coalesce(p_data->'onchain_state'->>'fulfilled_at','0') !~ '^[1-9][0-9]*$') then raise exception 'bound settled request-state evidence required'; end if;
    j.journal:=j.journal||jsonb_build_object('receipt',p_data);j.status:='completed';j.completed_at:=t;j.lease_owner:=null;j.lease_until:=null;
  elsif p_op='completed' then
    if coalesce(p_data->>'vm_state','') not in ('HALT','RECONCILED') or coalesce(p_data->>'tx_hash','')='' then raise exception 'confirmation evidence required'; end if;
    if j.journal ? 'signed' and j.journal->'signed'->>'tx_hash'<>p_data->>'tx_hash' then raise exception 'confirmation hash mismatch'; end if;
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
  else raise exception 'unsupported delivery transition'; end if;
  update public.morpheus_delivery_jobs set journal=j.journal,status=j.status,last_error=j.last_error,
    lease_owner=j.lease_owner,lease_until=j.lease_until,next_attempt_at=j.next_attempt_at,completed_at=j.completed_at,updated_at=t
    where job_key=p_job returning * into j;
  return to_jsonb(j);
end $$;

create function public.morpheus_delivery_feed_baseline(p_network text,p_chain text,p_contract text,p_snapshot jsonb default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
  if p_snapshot is not null then
    if jsonb_typeof(p_snapshot)<>'object' then raise exception 'feed seed must be a symbol map'; end if;
    insert into public.morpheus_delivery_feed_baselines(network,chain,contract,payload) values(p_network,p_chain,lower(p_contract),p_snapshot)
      on conflict(network,chain,contract) do nothing;
  end if;
  select payload into result from public.morpheus_delivery_feed_baselines where network=p_network and chain=p_chain and contract=lower(p_contract);
  return result;
end
$$;
revoke execute on function public.morpheus_delivery_feed_baseline(text,text,text,jsonb) from public;
grant execute on function public.morpheus_delivery_feed_baseline(text,text,text,jsonb) to service_role;

-- Legacy rows with any prior execution are quarantined, never assumed unsent.
-- This is also the offline state-file import target used during cutover.
create function public.morpheus_delivery_import_legacy(p_network text,p_chain text,p_contract text,p_request_id text,p_account text,p_event jsonb,p_legacy jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare j public.morpheus_delivery_jobs; imported jsonb; legacy_digest text; uncertain boolean;
begin
  imported:=public.morpheus_delivery_enqueue(p_network,p_chain,p_contract,p_request_id,p_account,p_event);
  select * into strict j from public.morpheus_delivery_jobs where job_key=imported->>'job_key' for update;
  legacy_digest:=encode(sha256(convert_to(p_legacy::text,'UTF8')),'hex');
  if exists(select 1 from public.morpheus_delivery_imports history where history.job_key=j.job_key and history.source_digest=legacy_digest) then return to_jsonb(j); end if;
  if j.status='completed' then
    insert into public.morpheus_delivery_imports(job_key,source_digest,payload,decision) values(j.job_key,legacy_digest,p_legacy,'already_completed');
    return to_jsonb(j);
  end if;
  uncertain:=coalesce((p_legacy->>'attempts')::bigint,0)>0 or coalesce(p_legacy->>'tx_hash','')<>'' or coalesce(p_legacy->>'status','unknown') not in ('queued','queued_backpressure');
  insert into public.morpheus_delivery_imports(job_key,source_digest,payload,decision) values(j.job_key,legacy_digest,p_legacy,case when uncertain then 'reconcile_required' else 'never_attempted' end);
  if j.generation>0 and not uncertain then return to_jsonb(j); end if;
  j.journal:=j.journal||jsonb_build_object('legacy',p_legacy);
  if uncertain then j.status:='reconcile_required';j.generation:=j.generation+1;j.lease_owner:=null;j.lease_until:=null; end if;
  update public.morpheus_delivery_jobs set journal=j.journal,status=j.status,generation=j.generation,lease_owner=j.lease_owner,lease_until=j.lease_until,updated_at=clock_timestamp() where job_key=j.job_key returning * into j;
  return to_jsonb(j);
end $$;

create function public.morpheus_delivery_resolve_legacy(p_job text,p_actor text,p_reason text)
returns void language plpgsql security invoker set search_path='' as $$
declare j public.morpheus_delivery_jobs;
begin
  if btrim(p_actor)='' or btrim(p_reason)='' then raise exception 'reconciliation provenance required'; end if;
  select * into strict j from public.morpheus_delivery_jobs where job_key=p_job for update;
  if j.status<>'reconcile_required' or not(j.journal ? 'legacy') or j.journal ? 'signed' then raise exception 'only imported unsigned legacy uncertainty can be released'; end if;
  insert into public.morpheus_delivery_replays(job_key,actor,reason,prior) values(p_job,p_actor,p_reason,to_jsonb(j));
  update public.morpheus_delivery_jobs set status='queued',attempts=0,generation=generation+1,next_attempt_at=clock_timestamp(),
    lease_owner=null,lease_until=null,last_error=null,completed_at=null,updated_at=clock_timestamp() where job_key=p_job;
end $$;

create function public.morpheus_delivery_account_health(p_network text,p_chain text,p_account text)
returns jsonb language sql security invoker set search_path='' as $$
  select jsonb_build_object('reconcile_required',count(*) filter(where status='reconcile_required'),
    'ready',count(*) filter(where status in ('queued','retry_scheduled','broadcast_unknown') and next_attempt_at<=clock_timestamp()),
    'dead_letters',count(*) filter(where status='dead_letter'))
  from public.morpheus_delivery_jobs where network=p_network and chain=p_chain and account_scope=p_account
$$;
revoke execute on function public.morpheus_delivery_import_legacy(text,text,text,text,text,jsonb,jsonb),
  public.morpheus_delivery_resolve_legacy(text,text,text),public.morpheus_delivery_account_health(text,text,text) from public;
grant execute on function public.morpheus_delivery_import_legacy(text,text,text,text,text,jsonb,jsonb),
  public.morpheus_delivery_resolve_legacy(text,text,text),public.morpheus_delivery_account_health(text,text,text) to service_role;

create function public.morpheus_delivery_replay(p_job text,p_actor text,p_reason text)
returns void language plpgsql security invoker set search_path='' as $$
declare j public.morpheus_delivery_jobs;
begin
  if btrim(p_actor)='' or btrim(p_reason)='' then raise exception 'replay provenance required'; end if;
  select * into strict j from public.morpheus_delivery_jobs where job_key=p_job for update;
  if j.status<>'dead_letter' or ((j.journal ? 'signed') and (coalesce(j.journal->'receipt'->>'vm_state','') not in ('FAULT','EXPIRED_UNSEEN')
    or j.journal->'receipt'->>'tx_hash' is distinct from j.journal->'signed'->>'tx_hash')) then raise exception 'only unsigned or proven-faulted dead letters may replay'; end if;
  insert into public.morpheus_delivery_replays(job_key,actor,reason,prior) values(p_job,p_actor,p_reason,to_jsonb(j));
  update public.morpheus_delivery_jobs set status='queued',journal='{}',attempts=0,generation=generation+1,lease_owner=null,lease_until=null,
    next_attempt_at=clock_timestamp(),completed_at=null,last_error=null,updated_at=clock_timestamp() where job_key=p_job;
end $$;

create function public.morpheus_delivery_lookup(p_job text)
returns jsonb language sql security invoker set search_path='' as $$
  select to_jsonb(j) from public.morpheus_delivery_jobs j where job_key=p_job
$$;
create function public.morpheus_delivery_reconcile(p_job text,p_generation bigint,p_receipt jsonb,p_actor text,p_reason text)
returns void language plpgsql security invoker set search_path='' as $$
declare j public.morpheus_delivery_jobs; expected_hash text;
begin
  if btrim(p_actor)='' or btrim(p_reason)='' then raise exception 'reconciliation provenance required'; end if;
  select * into strict j from public.morpheus_delivery_jobs where job_key=p_job for update;
  expected_hash:=coalesce(j.journal->'signed'->>'tx_hash',j.journal->'legacy'->>'tx_hash');
  if j.status<>'reconcile_required' or j.generation is distinct from p_generation or j.lease_until>clock_timestamp()
    or coalesce(expected_hash,'')='' or p_receipt->>'tx_hash' is distinct from expected_hash
    or coalesce(p_receipt->>'vm_state','') not in ('HALT','FAULT','EXPIRED_UNSEEN') then raise exception 'reconciliation requires unchanged terminal job and exact transaction evidence'; end if;
  if p_receipt->>'vm_state'='EXPIRED_UNSEEN' and not public.morpheus_delivery_expiry_valid(to_jsonb(j),p_receipt) then raise exception 'expiry requires bound archive evidence'; end if;
  insert into public.morpheus_delivery_replays(job_key,actor,reason,prior) values(p_job,p_actor,p_reason,to_jsonb(j));
  update public.morpheus_delivery_jobs set journal=journal||jsonb_build_object('receipt',p_receipt),
    status=case when p_receipt->>'vm_state'='HALT' then 'completed' else 'dead_letter' end,
    lease_owner=null,lease_until=null,completed_at=clock_timestamp(),updated_at=clock_timestamp() where job_key=p_job;
  if p_receipt->>'vm_state'='HALT' and j.kind='feed' and jsonb_typeof(j.journal->'prepared'->'feed_baseline_patch')='object' then
    insert into public.morpheus_delivery_feed_baselines(network,chain,contract,payload) values(j.network,j.chain,j.contract,j.journal->'prepared'->'feed_baseline_patch')
      on conflict(network,chain,contract) do update set payload=public.morpheus_delivery_feed_baselines.payload||excluded.payload;
  end if;
end $$;
revoke execute on function public.morpheus_delivery_lookup(text),public.morpheus_delivery_reconcile(text,bigint,jsonb,text,text) from public;
grant execute on function public.morpheus_delivery_lookup(text),public.morpheus_delivery_reconcile(text,bigint,jsonb,text,text) to service_role;

create function public.morpheus_delivery_expiry_valid(p_job jsonb,p_receipt jsonb)
returns boolean language sql immutable security invoker set search_path='' as $$
  select case when jsonb_typeof(p_receipt->'onchain_state'->'archive_checks')='array' then coalesce(
    p_job->>'chain'='neo_n3' and p_receipt->>'vm_state'='EXPIRED_UNSEEN'
    and p_receipt->>'tx_hash'=p_job->'journal'->'signed'->>'tx_hash'
    and p_receipt->'onchain_state'->>'valid_until_block'=p_job->'journal'->'signed'->>'valid_until_block'
    and (select count(distinct item->>'rpc_id')>=2 and count(distinct item->>'expiry_hash')=1
      and bool_and(coalesce((item->>'tip')::numeric>(p_job->'journal'->'signed'->>'valid_until_block')::numeric
        and item->>'rpc_id' ~ '^[0-9a-f]{64}$' and item->>'expiry_hash' ~ '^0x[0-9a-fA-F]{64}$',false))
      from jsonb_array_elements(p_receipt->'onchain_state'->'archive_checks') item),false) else false end
$$;
revoke execute on function public.morpheus_delivery_expiry_valid(jsonb,jsonb) from public;
grant execute on function public.morpheus_delivery_expiry_valid(jsonb,jsonb) to service_role;

create function public.morpheus_delivery_checkpoint(p_network text,p_chain text,p_contract text,p_cursor text default null)
returns text language plpgsql security invoker set search_path='' as $$
declare result text;
begin
  if p_cursor is not null then
    if p_cursor !~ '^[0-9]+$' then raise exception 'invalid cursor'; end if;
    insert into public.morpheus_delivery_cursors(network,chain,contract,cursor) values(p_network,p_chain,lower(p_contract),p_cursor::numeric)
    on conflict(network,chain,contract) do update set cursor=greatest(public.morpheus_delivery_cursors.cursor,excluded.cursor),updated_at=clock_timestamp();
  end if;
  select cursor::text into result from public.morpheus_delivery_cursors where network=p_network and chain=p_chain and contract=lower(p_contract);
  return result;
end $$;

revoke execute on function public.morpheus_delivery_enqueue(text,text,text,text,text,jsonb),
  public.morpheus_delivery_claim(text,text,text,text,bigint,text[]), public.morpheus_delivery_transition(text,text,bigint,text,jsonb,bigint),
  public.morpheus_delivery_replay(text,text,text), public.morpheus_delivery_checkpoint(text,text,text,text) from public;
grant execute on function public.morpheus_delivery_enqueue(text,text,text,text,text,jsonb),
  public.morpheus_delivery_claim(text,text,text,text,bigint,text[]), public.morpheus_delivery_transition(text,text,bigint,text,jsonb,bigint),
  public.morpheus_delivery_replay(text,text,text), public.morpheus_delivery_checkpoint(text,text,text,text) to service_role;

-- Supabase projects may have explicit default grants to API roles in addition
-- to PUBLIC. Remove those grants too; RLS alone is not an RPC permission policy.
do $$
declare api_role text; routine regprocedure;
begin
  for api_role in select rolname from pg_roles where rolname in ('anon','authenticated') loop
    execute format('revoke all on public.morpheus_delivery_jobs,public.morpheus_delivery_cursors,public.morpheus_delivery_replays,public.morpheus_delivery_feed_baselines,public.morpheus_delivery_lane_turns,public.morpheus_delivery_imports from %I',api_role);
    execute format('revoke all on sequence public.morpheus_delivery_replays_id_seq from %I',api_role);
    for routine in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'morpheus_delivery_%' loop
      execute format('revoke execute on function %s from %I',routine,api_role);
    end loop;
  end loop;
end $$;
