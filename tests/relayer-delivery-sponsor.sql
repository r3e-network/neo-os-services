-- CU-91 storage acceptance on real PostgreSQL. All identities and transaction
-- bytes are synthetic: no signer, RPC endpoint or broadcaster is contacted, and
-- no remote database is used. The reserving transaction is the one that creates
-- the intent, debits every budget and enqueues the bound delivery job.
\set ON_ERROR_STOP on
begin;
create function pg_temp.refused(command text, expected_state text, expected_message text default null)
returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when others then
    if sqlstate <> expected_state or (expected_message is not null and sqlerrm <> expected_message) then
      raise exception 'wrong refusal: % / %, expected % / %', sqlstate, sqlerrm, expected_state, expected_message;
    end if;
    return;
  end;
  raise exception 'unsafe command accepted: %', command;
end $$;

create function pg_temp.reserve(k text, fee bigint default 1000000,
  principal uuid default '00000000-0000-0000-0000-000000000001',
  intent jsonb default '{"operation":"claim"}')
returns jsonb language sql as $$
  select public.morpheus_delivery_sponsor_reserve('testnet', principal, k,
    '0x1111111111111111111111111111111111111111', 'sponsor-account', intent, fee)
$$;

do $$
declare r text; t text;
begin
  foreach r in array array['anon','authenticated','service_role'] loop
    foreach t in array array['morpheus_sponsor_intents','morpheus_sponsor_lifetime_budgets',
      'morpheus_sponsor_daily_budgets','morpheus_sponsor_global_budgets'] loop
      if has_table_privilege(r, 'public.' || t, 'INSERT,UPDATE,DELETE,TRUNCATE') then
        raise exception '% can bypass reservation on %', r, t;
      end if;
      if r <> 'service_role' and has_table_privilege(r, 'public.' || t, 'SELECT') then
        raise exception '% can read private intents/budgets', r;
      end if;
      if not (select relrowsecurity from pg_class where oid=('public.' || t)::regclass) then
        raise exception 'RLS missing on %', t;
      end if;
    end loop;
    if has_function_privilege(r, 'public.morpheus_delivery_sponsor_reserve(text,uuid,text,text,text,jsonb,bigint)', 'EXECUTE')
      is distinct from (r='service_role') then raise exception 'wrong reservation privilege for %', r; end if;
  end loop;
end $$;
set local role anon;
select pg_temp.refused($q$select pg_temp.reserve('unauthorized')$q$, '42501');
set local role authenticated;
select pg_temp.refused($q$select pg_temp.reserve('unauthorized')$q$, '42501');
set local role service_role;
set local timezone = 'Etc/GMT+12';
do $$
declare j jsonb; again jsonb; invalid jsonb; value text;
begin
  j := pg_temp.reserve('same');
  again := pg_temp.reserve('same');
  if j is distinct from again or j->>'kind' <> 'sponsor' then raise exception 'idempotency changed job'; end if;
  if (select reserved_fee_units from public.morpheus_sponsor_lifetime_budgets) <> 1000000
    or (select reserved_actions from public.morpheus_sponsor_daily_budgets) <> 1
    or (select reserved_fee_units from public.morpheus_sponsor_global_budgets) <> 1000000 then
    raise exception 'retry double charged budget';
  end if;
  if (select budget_day from public.morpheus_sponsor_intents) <> (clock_timestamp() at time zone 'UTC')::date then
    raise exception 'reservation day is not database UTC';
  end if;
  if public.morpheus_delivery_claim('testnet','neo_n3','sponsor-account','worker',60000) is not null then
    raise exception 'default worker claimed sponsor';
  end if;
  perform pg_temp.refused($q$select pg_temp.reserve('same',2)$q$, '22023', 'sponsor idempotency conflict');
  perform pg_temp.refused($q$select pg_temp.reserve('same',1000000,intent=>'{}')$q$, '22023', 'sponsor idempotency conflict');
  perform pg_temp.refused($q$select public.morpheus_delivery_sponsor_reserve('testnet','00000000-0000-0000-0000-000000000001',
    'same','0x2222222222222222222222222222222222222222','sponsor-account','{"operation":"claim"}',1000000)$q$,
    '22023', 'sponsor idempotency conflict');
  perform pg_temp.refused($q$select public.morpheus_delivery_sponsor_reserve('testnet','00000000-0000-0000-0000-000000000001',
    'same','0x1111111111111111111111111111111111111111','other-account','{"operation":"claim"}',1000000)$q$,
    '22023', 'sponsor idempotency conflict');
  perform pg_temp.refused($q$select pg_temp.reserve('zero',0)$q$, '22023');
  perform pg_temp.refused($q$select pg_temp.reserve('negative',-1)$q$, '22023');
  perform pg_temp.refused($q$select pg_temp.reserve('huge',20000001)$q$, '22023');
  perform pg_temp.refused($q$select pg_temp.reserve('null',null)$q$, '22023');
  perform pg_temp.refused($q$select pg_temp.reserve('null',principal=>null)$q$, '22023');
  perform pg_temp.refused($q$select pg_temp.reserve(' ')$q$, '22023');
  perform pg_temp.refused($q$select pg_temp.reserve(null)$q$, '22023');
  perform pg_temp.refused($q$select pg_temp.reserve(repeat('x',129))$q$, '22023');
  foreach invalid in array array[null::jsonb,'null','[]','true','"text"'] loop
    perform pg_temp.refused(format('select pg_temp.reserve(''invalid'',intent=>%L::jsonb)',invalid), '22023');
  end loop;
  foreach value in array array[null::text,'','invalid'] loop
    perform pg_temp.refused(format($q$select public.morpheus_delivery_sponsor_reserve(%L,
      '00000000-0000-0000-0000-000000000001','bad-network',
      '0x1111111111111111111111111111111111111111','account','{}',1)$q$,value), '22023');
    perform pg_temp.refused(format($q$select public.morpheus_delivery_sponsor_reserve('testnet',
      '00000000-0000-0000-0000-000000000001','bad-contract',%L,'account','{}',1)$q$,value), '22023');
  end loop;
  foreach value in array array[null::text,'',' ',' padded '] loop
    perform pg_temp.refused(format($q$select public.morpheus_delivery_sponsor_reserve('testnet',
      '00000000-0000-0000-0000-000000000001','bad-account',
      '0x1111111111111111111111111111111111111111',%L,'{}',1)$q$,value), '22023');
  end loop;
  perform pg_temp.refused($q$update public.morpheus_sponsor_lifetime_budgets set reserved_fee_units=0$q$, '42501');
  perform pg_temp.refused($q$delete from public.morpheus_sponsor_intents$q$, '42501');
  if (select count(*) from public.morpheus_sponsor_intents) <> 1 then raise exception 'refusal left intent'; end if;
  -- Reaching the lifetime ceiling is allowed; crossing it rolls every counter back.
  perform pg_temp.reserve('lifetime',19000000);
  perform pg_temp.refused($q$select pg_temp.reserve('over-life',1)$q$, 'P0001', 'sponsor lifetime budget exceeded');
  if (select reserved_fee_units from public.morpheus_sponsor_global_budgets) <> 20000000
    or (select reserved_actions from public.morpheus_sponsor_daily_budgets) <> 2 then
    raise exception 'lifetime refusal partially charged';
  end if;
  for n in 1..10 loop
    perform pg_temp.reserve('daily-' || n,1,'00000000-0000-0000-0000-000000000002');
  end loop;
  perform pg_temp.refused($q$select pg_temp.reserve('daily-11',1,'00000000-0000-0000-0000-000000000002')$q$,
    'P0001', 'sponsor daily action budget exceeded');
  if (select reserved_fee_units from public.morpheus_sponsor_global_budgets) <> 20000010 then
    raise exception 'daily refusal partially charged';
  end if;
  -- Separate principal and network namespaces do not collide on the same key.
  perform pg_temp.reserve('same',1,'00000000-0000-0000-0000-000000000003');
  perform public.morpheus_delivery_sponsor_reserve('mainnet','00000000-0000-0000-0000-000000000001',
    'same','0x1111111111111111111111111111111111111111','sponsor-account','{}',1);
end $$;
\echo PASS: sponsor permissions, input validation, idempotency and budget limits

do $$
declare j jsonb; k text; g bigint; invalid jsonb;
  signed jsonb := jsonb_build_object('tx_hash','0x' || repeat('a',64),'raw','00ab');
begin
  perform pg_temp.refused($q$select public.morpheus_delivery_enqueue('testnet','neo_n3',
    '0x1111111111111111111111111111111111111111','999','unreserved','{"requestId":"999","kind":"sponsor"}')$q$,
    '22023', 'sponsor intent reservation required');
  j := public.morpheus_delivery_claim('testnet','neo_n3','sponsor-account','worker',60000,array['sponsor']);
  k := j->>'job_key'; g := (j->>'generation')::bigint;
  if k is null then raise exception 'explicit sponsor claim missing'; end if;
  perform pg_temp.refused(format('update public.morpheus_delivery_jobs set kind=''request'' where job_key=%L',k), '22023');
  perform pg_temp.refused(format('delete from public.morpheus_delivery_jobs where job_key=%L',k), '42501');
  perform pg_temp.refused(format('update public.morpheus_delivery_jobs set account_scope=''other'' where job_key=%L',k), '22023');
  perform pg_temp.refused(format('update public.morpheus_delivery_jobs set chain=''neox'' where job_key=%L',k), '22023');
  perform pg_temp.refused(format('update public.morpheus_delivery_jobs set event=''{}'' where job_key=%L',k), '22023');
  perform pg_temp.refused(format('update public.morpheus_delivery_jobs set journal=''[]'' where job_key=%L',k), '22023');
  perform pg_temp.refused(format('update public.morpheus_delivery_jobs set status=''broadcast_unknown'' where job_key=%L',k), '22023');
  perform pg_temp.refused(format('select public.morpheus_delivery_transition(%L,''worker'',%s,''signed'',%L,60000)', k,g,signed), '22023');
  perform pg_temp.refused(format('select public.morpheus_delivery_transition(%L,''worker'',%s,''prepared'',''{}'',60000)',k,g), '22023');
  perform pg_temp.refused(format('select public.morpheus_delivery_transition(%L,''worker'',%s,''prepared'',''{"fee_ceiling_units":20000001}'',60000)',k,g), '22023');
  perform public.morpheus_delivery_transition(k,'worker',g,'prepared',jsonb_build_object('fee_ceiling_units',1000000),60000);
  foreach invalid in array array['null'::jsonb,'[]','{}','{"tx_hash":42,"raw":"bytes"}',
    '{"tx_hash":"hash","raw":{}}','{"tx_hash":" ","raw":"bytes"}','{"tx_hash":"hash","raw":" "}'] loop
    perform pg_temp.refused(format('update public.morpheus_delivery_jobs set journal=jsonb_set(journal,''{signed}'',%L) where job_key=%L',invalid,k), '22023');
  end loop;
  perform public.morpheus_delivery_transition(k,'worker',g,'signed',signed,60000);
  perform pg_temp.refused(format('update public.morpheus_delivery_jobs set journal=''{}'' where job_key=%L',k), '22023');
  perform pg_temp.refused(format('update public.morpheus_delivery_jobs set journal=''{}'',status=''processing'' where job_key=%L',k), '22023');
  perform pg_temp.refused(format('update public.morpheus_delivery_jobs set journal=jsonb_set(journal,''{prepared,changed}'',''true'') where job_key=%L',k), '22023');
  perform pg_temp.refused(format('update public.morpheus_delivery_jobs set status=''completed'' where job_key=%L',k), '22023');
  perform pg_temp.refused(format('select public.morpheus_delivery_transition(%L,''worker'',%s,''completed'',''{"tx_hash":"wrong","vm_state":"HALT"}'',60000)',k,g), '22023');
  perform pg_temp.refused(format('select public.morpheus_delivery_transition(%L,''worker'',%s,''renew'',''{}'',60000)',k,g+1), 'P0002');
  j := public.morpheus_delivery_transition(k,'worker',g,'retry','{"error":"submission unknown"}',60000);
  if j->>'status' <> 'broadcast_unknown' or j->'journal'->'signed' is distinct from signed then
    raise exception 'uncertain transaction lost durable identity';
  end if;
  -- Simulate the next scheduled observation and lease takeover, without broadcasting.
  update public.morpheus_delivery_jobs set next_attempt_at=clock_timestamp() where job_key=k;
  j := public.morpheus_delivery_claim('testnet','neo_n3','sponsor-account','next-worker',60000,array['sponsor']);
  if j->>'job_key' <> k or j->'journal'->'signed' is distinct from signed then raise exception 'takeover lost signed journal'; end if;
  perform public.morpheus_delivery_transition(k,'next-worker',(j->>'generation')::bigint,'completed',
    jsonb_build_object('tx_hash',signed->>'tx_hash','vm_state','HALT'),60000);
  j := pg_temp.reserve('same');
  if j->>'status' <> 'completed' then raise exception 'retry after completion made new job'; end if;
  perform pg_temp.refused(format('select public.morpheus_delivery_replay(%L,''operator'',''retry'')',k), 'P0001');
end $$;
\echo PASS: reserved journal, default-off claims, fencing and immutable signed replay
rollback;

-- An independent transaction reaches the exact global ceiling.
begin;
set local role service_role;
do $$
begin
  for n in 1..25 loop
    perform public.morpheus_delivery_sponsor_reserve('testnet', lpad(n::text,32,'0')::uuid,'global',
      '0x1111111111111111111111111111111111111111','global-account','{}',20000000);
  end loop;
  begin
    perform public.morpheus_delivery_sponsor_reserve('testnet',lpad('26',32,'0')::uuid,'global',
      '0x1111111111111111111111111111111111111111','global-account','{}',1);
    raise exception 'global cap accepted overspend';
  exception when raise_exception then
    if sqlerrm <> 'sponsor global budget exceeded' then raise; end if;
  end;
  if (select reserved_fee_units from public.morpheus_sponsor_global_budgets) <> 500000000
    or (select count(*) from public.morpheus_sponsor_intents) <> 25 then
    raise exception 'global refusal partially charged';
  end if;
end $$;
rollback;
\echo PASS: global budget ceiling and rollback

-- A failure creating the job occurs after all budget/intent writes. It must
-- roll them all back, just as a storage outage must never fall back to enqueue.
begin;
alter table public.morpheus_delivery_jobs add constraint acceptance_insert_failure check(kind <> 'sponsor') not valid;
set local role service_role;
do $$
begin
  begin
    perform public.morpheus_delivery_sponsor_reserve('testnet','00000000-0000-0000-0000-000000000001',
      'failed-insert','0x1111111111111111111111111111111111111111','account','{}',1);
    raise exception 'planted insert failure accepted';
  exception when check_violation then null;
  end;
  if exists(select 1 from public.morpheus_sponsor_intents)
    or exists(select 1 from public.morpheus_sponsor_global_budgets)
    or exists(select 1 from public.morpheus_sponsor_lifetime_budgets)
    or exists(select 1 from public.morpheus_sponsor_daily_budgets) then
    raise exception 'failed enqueue leaked reservation';
  end if;
end $$;
rollback;
begin;
drop table public.morpheus_sponsor_global_budgets;
set local role service_role;
do $$
begin
  begin
    perform public.morpheus_delivery_sponsor_reserve('testnet','00000000-0000-0000-0000-000000000001',
      'unavailable-budget','0x1111111111111111111111111111111111111111','account','{}',1);
    raise exception 'missing budget accepted';
  exception when undefined_table then null;
  end;
  if exists(select 1 from public.morpheus_sponsor_intents)
    or exists(select 1 from public.morpheus_delivery_jobs where kind='sponsor') then
    raise exception 'missing budget enqueued sponsor';
  end if;
end $$;
rollback;
\echo PASS: planted storage failures leave no intent, job or budget debit
