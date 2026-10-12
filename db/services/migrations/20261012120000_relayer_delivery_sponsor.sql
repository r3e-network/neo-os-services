-- CU-91: sponsor kind, intent journal and budget tables for the relayer
-- delivery schema. Additive, local storage only: no sponsor worker, HTTP route,
-- signer or chain client is enabled, and default delivery claim kinds remain
-- request/feed/xcm. Apply only through the later reviewed release process
-- (OP-12 / DEC-CU-30); nothing here contacts a remote database.
--
-- Fees are integer GAS datoshi (100000000 per GAS). Reservations are
-- conservative charges taken at admission: no outcome refunds them in this
-- slice, deliberately, so an uncertain broadcast can never be re-spent.
-- Reconciliation and any release/refund path belong to the later sponsor API
-- slice and must not release uncertain spend.
--
-- Rollback while no sponsor job exists: drop trigger
-- morpheus_delivery_sponsor_guard on public.morpheus_delivery_jobs; drop
-- function public.morpheus_delivery_sponsor_guard(); drop function
-- public.morpheus_delivery_sponsor_reserve(text,uuid,text,text,text,jsonb,bigint);
-- drop table public.morpheus_sponsor_intents, public.morpheus_sponsor_lifetime_budgets,
-- public.morpheus_sponsor_daily_budgets, public.morpheus_sponsor_global_budgets;
-- then restore the kind check to check (kind in ('request','feed','xcm')).
begin;

alter table public.morpheus_delivery_jobs drop constraint morpheus_delivery_jobs_kind_check;
alter table public.morpheus_delivery_jobs add constraint morpheus_delivery_jobs_kind_check
  check (kind in ('request','feed','xcm','sponsor'));

-- Immutable intent identity, bound to the delivery job it reserves. The future
-- authenticated API supplies the principal and the future intent validator
-- checks transaction shape and actual fees; neither belongs to this slice.
create table public.morpheus_sponsor_intents (
  job_key text primary key references public.morpheus_delivery_jobs(job_key)
    deferrable initially deferred,
  network text not null check (network in ('mainnet','testnet')),
  principal uuid not null,
  idempotency_key text not null check (length(idempotency_key) between 1 and 128 and btrim(idempotency_key) <> ''),
  contract text not null check (contract ~ '^0x[0-9a-f]{40}$'),
  account_scope text not null check (btrim(account_scope) <> ''),
  intent jsonb not null check (jsonb_typeof(intent) = 'object'),
  fee_ceiling_units bigint not null check (fee_ceiling_units between 1 and 20000000),
  budget_day date not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (network,principal,idempotency_key)
);
create table public.morpheus_sponsor_lifetime_budgets (
  network text not null check (network in ('mainnet','testnet')),
  principal uuid not null,
  reserved_fee_units bigint not null check (reserved_fee_units between 0 and 20000000),
  primary key (network,principal)
);
create table public.morpheus_sponsor_daily_budgets (
  network text not null check (network in ('mainnet','testnet')),
  principal uuid not null,
  budget_day date not null,
  reserved_actions integer not null check (reserved_actions between 0 and 10),
  primary key (network,principal,budget_day)
);
create table public.morpheus_sponsor_global_budgets (
  network text not null check (network in ('mainnet','testnet')),
  budget_day date not null,
  reserved_fee_units bigint not null check (reserved_fee_units between 0 and 500000000),
  primary key (network,budget_day)
);
alter table public.morpheus_sponsor_intents enable row level security;
alter table public.morpheus_sponsor_lifetime_budgets enable row level security;
alter table public.morpheus_sponsor_daily_budgets enable row level security;
alter table public.morpheus_sponsor_global_budgets enable row level security;

-- Existing service-role delivery RPCs are invokers and the role can write jobs.
-- Bind every sponsor write to the RPC-only reservation, including direct DML.
create function public.morpheus_delivery_sponsor_guard()
returns trigger language plpgsql security definer set search_path='' as $$
declare i public.morpheus_sponsor_intents;
begin
  if tg_op = 'DELETE' then
    if old.kind = 'sponsor' then
      raise exception using errcode='22023', message='sponsor journal cannot be deleted';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and old.kind = 'sponsor' and new.kind is distinct from old.kind then
    raise exception using errcode='22023', message='sponsor identity is immutable';
  end if;
  if new.kind <> 'sponsor' then return new; end if;
  select * into i from public.morpheus_sponsor_intents where job_key = new.job_key;
  if not found then
    raise exception using errcode='22023', message='sponsor intent reservation required';
  end if;
  if new.network is distinct from i.network or new.chain is distinct from 'neo_n3'
    or new.contract is distinct from i.contract or new.account_scope is distinct from i.account_scope
    or new.event is distinct from jsonb_build_object('kind','sponsor','requestId',new.request_id,'payload',i.intent)
    or (tg_op = 'UPDATE' and (new.job_key,new.kind,new.request_id) is distinct from (old.job_key,old.kind,old.request_id)) then
    raise exception using errcode='22023', message='sponsor identity is immutable';
  end if;
  if jsonb_typeof(new.journal) is distinct from 'object' then
    raise exception using errcode='22023', message='sponsor journal must be an object';
  end if;
  if tg_op = 'UPDATE' and (
    (old.journal ? 'prepared' and new.journal->'prepared' is distinct from old.journal->'prepared') or
    (old.journal ? 'signed' and new.journal->'signed' is distinct from old.journal->'signed')) then
    raise exception using errcode='22023', message='sponsor transaction journal is immutable';
  end if;
  if new.journal ? 'prepared' and (
    jsonb_typeof(new.journal->'prepared') is distinct from 'object' or
    new.journal->'prepared'->'fee_ceiling_units' is distinct from to_jsonb(i.fee_ceiling_units)) then
    raise exception using errcode='22023', message='sponsor prepared journal requires reserved fee ceiling';
  end if;
  if new.journal ? 'signed' and (
    not (new.journal ? 'prepared') or jsonb_typeof(new.journal->'signed') is distinct from 'object' or
    jsonb_typeof(new.journal->'signed'->'tx_hash') is distinct from 'string' or
    coalesce(btrim(new.journal->'signed'->>'tx_hash'),'') = '' or
    jsonb_typeof(new.journal->'signed'->'raw') is distinct from 'string' or
    coalesce(btrim(new.journal->'signed'->>'raw'),'') = '') then
    raise exception using errcode='22023', message='sponsor signed journal incomplete';
  end if;
  if new.status in ('signed','broadcast_unknown','reconcile_required','completed') and not (new.journal ? 'signed') then
    raise exception using errcode='22023', message='sponsor signed journal required';
  end if;
  if new.status = 'completed' and (
    new.journal->'receipt'->>'vm_state' is distinct from 'HALT' or
    new.journal->'receipt'->>'tx_hash' is distinct from new.journal->'signed'->>'tx_hash') then
    raise exception using errcode='22023', message='sponsor completion requires matching HALT receipt';
  end if;
  return new;
end $$;
create trigger morpheus_delivery_sponsor_guard before insert or update or delete
  on public.morpheus_delivery_jobs for each row execute function public.morpheus_delivery_sponsor_guard();

-- The only writer of sponsor intents and budget counters. One database
-- transaction journals the intent, debits all three budgets and enqueues the
-- bound delivery job, so a job can never exist unreserved and a reservation can
-- never survive a failed enqueue.
create function public.morpheus_delivery_sponsor_reserve(p_network text,p_principal uuid,
  p_idempotency_key text,p_contract text,p_account text,p_intent jsonb,p_fee_ceiling_units bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare i public.morpheus_sponsor_intents; d date; request_id text; k text;
begin
  if p_network is null or p_network not in ('mainnet','testnet') or p_principal is null
    or p_idempotency_key is null or btrim(p_idempotency_key) = '' or length(p_idempotency_key) > 128
    or p_contract is null or lower(p_contract) !~ '^0x[0-9a-f]{40}$'
    or p_account is null or btrim(p_account) = '' or p_account <> btrim(p_account)
    or jsonb_typeof(p_intent) is distinct from 'object'
    or p_fee_ceiling_units is null or p_fee_ceiling_units not between 1 and 20000000 then
    raise exception using errcode='22023', message='invalid sponsor reservation';
  end if;
  -- Canary volume is small: serialize per network, including idempotency and
  -- day rollover. Atomic counter updates also refuse stale-snapshot overspend.
  perform pg_advisory_xact_lock(hashtextextended(p_network,91091));
  select * into i from public.morpheus_sponsor_intents
    where network=p_network and principal=p_principal and idempotency_key=p_idempotency_key;
  if found then
    if i.contract is distinct from lower(p_contract) or i.account_scope is distinct from p_account
      or i.intent is distinct from p_intent or i.fee_ceiling_units is distinct from p_fee_ceiling_units then
      raise exception using errcode='22023', message='sponsor idempotency conflict';
    end if;
    return public.morpheus_delivery_lookup(i.job_key);
  end if;
  d := (clock_timestamp() at time zone 'UTC')::date;
  insert into public.morpheus_sponsor_global_budgets(network,budget_day,reserved_fee_units)
    values(p_network,d,p_fee_ceiling_units)
    on conflict(network,budget_day) do update
      set reserved_fee_units=public.morpheus_sponsor_global_budgets.reserved_fee_units+excluded.reserved_fee_units
      where public.morpheus_sponsor_global_budgets.reserved_fee_units <= 500000000-excluded.reserved_fee_units;
  if not found then raise exception 'sponsor global budget exceeded'; end if;
  insert into public.morpheus_sponsor_lifetime_budgets(network,principal,reserved_fee_units)
    values(p_network,p_principal,p_fee_ceiling_units)
    on conflict(network,principal) do update
      set reserved_fee_units=public.morpheus_sponsor_lifetime_budgets.reserved_fee_units+excluded.reserved_fee_units
      where public.morpheus_sponsor_lifetime_budgets.reserved_fee_units <= 20000000-excluded.reserved_fee_units;
  if not found then raise exception 'sponsor lifetime budget exceeded'; end if;
  insert into public.morpheus_sponsor_daily_budgets(network,principal,budget_day,reserved_actions)
    values(p_network,p_principal,d,1)
    on conflict(network,principal,budget_day) do update
      set reserved_actions=public.morpheus_sponsor_daily_budgets.reserved_actions+1
      where public.morpheus_sponsor_daily_budgets.reserved_actions < 10;
  if not found then raise exception 'sponsor daily action budget exceeded'; end if;
  request_id := '0x' || encode(sha256(convert_to(jsonb_build_array(p_network,p_principal,p_idempotency_key)::text,'UTF8')),'hex');
  k := jsonb_build_array(p_network,'neo_n3',lower(p_contract),'sponsor',request_id)::text;
  insert into public.morpheus_sponsor_intents(job_key,network,principal,idempotency_key,contract,account_scope,intent,fee_ceiling_units,budget_day)
    values(k,p_network,p_principal,p_idempotency_key,lower(p_contract),p_account,p_intent,p_fee_ceiling_units,d);
  return public.morpheus_delivery_enqueue(p_network,'neo_n3',p_contract,request_id,p_account,
    jsonb_build_object('kind','sponsor','requestId',request_id,'payload',p_intent));
end $$;

-- New intent/budget tables are RPC-write-only. RLS alone is not an RPC
-- permission policy, so explicit Supabase default grants to API roles are
-- removed as well as PUBLIC's defaults.
revoke all on public.morpheus_sponsor_intents, public.morpheus_sponsor_lifetime_budgets,
  public.morpheus_sponsor_daily_budgets, public.morpheus_sponsor_global_budgets from public;
revoke all on function public.morpheus_delivery_sponsor_guard(),
  public.morpheus_delivery_sponsor_reserve(text,uuid,text,text,text,jsonb,bigint) from public;
do $$
declare r text;
begin
  for r in select rolname from pg_roles where rolname in ('anon','authenticated','service_role') loop
    execute format('revoke all on public.morpheus_sponsor_intents, public.morpheus_sponsor_lifetime_budgets, public.morpheus_sponsor_daily_budgets, public.morpheus_sponsor_global_budgets from %I',r);
    execute format('revoke all on function public.morpheus_delivery_sponsor_guard(), public.morpheus_delivery_sponsor_reserve(text,uuid,text,text,text,jsonb,bigint) from %I',r);
  end loop;
end $$;
grant select on public.morpheus_sponsor_intents, public.morpheus_sponsor_lifetime_budgets,
  public.morpheus_sponsor_daily_budgets, public.morpheus_sponsor_global_budgets to service_role;
grant execute on function public.morpheus_delivery_sponsor_reserve(text,uuid,text,text,text,jsonb,bigint) to service_role;
commit;
