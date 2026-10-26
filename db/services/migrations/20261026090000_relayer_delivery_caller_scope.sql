-- Source contract only until independently admitted. No principal is enrolled.
begin;
do $$ begin
  if not exists(select 1 from pg_roles where rolname='neoos_relayer_caller') then
    create role neoos_relayer_caller nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
  if exists(select 1 from pg_roles where rolname='neoos_relayer_caller'
      and (rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls))
     or exists(select 1 from pg_auth_members where member=(select oid from pg_roles where rolname='neoos_relayer_caller')) then
    raise exception 'relayer caller role has unexpected privileges or membership';
  end if;
end $$;

create schema neoos_relayer_private;
create schema neoos_relayer_v2;
revoke all on schema neoos_relayer_private,neoos_relayer_v2 from public;
grant usage on schema neoos_relayer_v2 to neoos_relayer_caller;
grant usage on schema neoos_relayer_private to service_role;
create table neoos_relayer_private.caller_grants (
  issuer text not null check(length(issuer) between 1 and 2048),
  caller_id text not null check(length(caller_id) between 1 and 128),
  network text not null check(network in ('mainnet','testnet')),
  grant_epoch bigint not null check(grant_epoch>0),
  enabled boolean not null default false,
  migration_ready boolean not null default false,
  primary key(issuer,caller_id,network)
);
revoke all on neoos_relayer_private.caller_grants from public,neoos_relayer_caller;
-- Existing maintenance authority admits metadata only after issuer/cutover review.
grant select,insert,update,delete on neoos_relayer_private.caller_grants to service_role;

create function neoos_relayer_private.assert_scope(p_network text) returns void
language plpgsql security definer set search_path='' as $$
declare c jsonb; epoch bigint; expires bigint; not_before bigint;
begin
  -- Claims are trusted ONLY after the gateway's signature verifier and SET ROLE.
  -- A direct SQL login with a caller-supplied claims GUC is not that boundary.
  if session_user<>'authenticator' or current_setting('role',true)<>'neoos_relayer_caller' then
    raise exception using errcode='42501',message='verified relayer gateway role required';
  end if;
  begin
    c:=current_setting('request.jwt.claims',true)::jsonb;
    epoch:=(c->>'neoos_epoch')::bigint;
    expires:=(c->>'exp')::bigint;
    not_before:=coalesce((c->>'nbf')::bigint,0);
  exception when others then
    raise exception using errcode='42501',message='invalid relayer claims';
  end;
  if jsonb_typeof(c) is distinct from 'object'
     or c->>'role' is distinct from 'neoos_relayer_caller'
     or c->>'aud' is distinct from 'authenticated'
     or c->>'scope' is distinct from 'neoos/relayer-delivery/v2'
     or jsonb_typeof(c->'iss') is distinct from 'string'
     or jsonb_typeof(c->'sub') is distinct from 'string'
     or jsonb_typeof(c->'neoos_network') is distinct from 'string'
     or jsonb_typeof(c->'neoos_epoch') is distinct from 'number'
     or jsonb_typeof(c->'exp') is distinct from 'number'
     or (c ? 'nbf' and jsonb_typeof(c->'nbf') is distinct from 'number')
     or p_network not in ('mainnet','testnet') or p_network is null
     or c->>'neoos_network' is distinct from p_network
     or epoch is null or epoch<1 or expires is null
     or expires<=extract(epoch from clock_timestamp())
     or not_before>extract(epoch from clock_timestamp()) then
    raise exception using errcode='42501',message='relayer claim scope mismatch';
  end if;
  if not exists(select 1 from neoos_relayer_private.caller_grants g
      where g.issuer=c->>'iss' and g.caller_id=c->>'sub' and g.network=p_network
        and g.grant_epoch=epoch and g.enabled and g.migration_ready) then
    raise exception using errcode='42501',message='relayer caller or migration is not admitted';
  end if;
end $$;
revoke all on function neoos_relayer_private.assert_scope(text) from public;

create function public.neoos_relayer_pre_request() returns void
language plpgsql security definer set search_path='' as $$
declare c jsonb; h jsonb; route text;
begin
  if current_setting('role',true)<>'neoos_relayer_caller' then return; end if;
  begin
    c:=current_setting('request.jwt.claims',true)::jsonb;
    h:=current_setting('request.headers',true)::jsonb;
  exception when others then
    raise exception using errcode='42501',message='invalid relayer gateway context';
  end;
  perform neoos_relayer_private.assert_scope(c->>'neoos_network');
  route:=current_setting('request.path',true);
  if current_setting('request.method',true) is distinct from 'POST'
     or h->>'content-profile' is distinct from 'neoos_relayer_v2'
     or h->>'accept-profile' is distinct from 'neoos_relayer_v2'
     or route is null or route not in (
       '/rpc/morpheus_delivery_enqueue','/rpc/morpheus_delivery_claim',
       '/rpc/morpheus_delivery_transition','/rpc/morpheus_delivery_checkpoint',
       '/rpc/morpheus_delivery_feed_baseline','/rpc/morpheus_delivery_account_health') then
    raise exception using errcode='42501',message='relayer gateway route is not permitted';
  end if;
end $$;
-- This is the server hook, not an additional caller RPC. Its own route is denied.
grant execute on function public.neoos_relayer_pre_request() to public;

create function neoos_relayer_v2.morpheus_delivery_enqueue(p_network text,p_chain text,p_contract text,p_request_id text,p_account text,p_event jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  perform neoos_relayer_private.assert_scope(p_network);
  if p_chain is null or p_chain not in ('neo_n3','neox') or p_account is distinct from 'oracle-updater'
     or coalesce(p_event->>'kind','request') not in ('request','feed','xcm') then
    raise exception using errcode='42501',message='relayer delivery lane is not permitted';
  end if;
  result:=public.morpheus_delivery_enqueue(p_network,p_chain,p_contract,p_request_id,p_account,p_event);
  -- The existing feed-dedup fast path can return a row from another account.
  if result->>'network' is distinct from p_network or result->>'chain' is distinct from p_chain
     or result->>'account_scope' is distinct from 'oracle-updater'
     or result->>'kind' not in ('request','feed','xcm') then
    raise exception using errcode='42501',message='returned delivery lane is not permitted';
  end if;
  return result;
end $$;
create function neoos_relayer_v2.morpheus_delivery_claim(p_network text,p_chain text,p_account text,p_owner text,p_lease_ms bigint,p_kinds text[] default array['request','feed','xcm'])
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform neoos_relayer_private.assert_scope(p_network);
  if p_chain is null or p_chain not in ('neo_n3','neox') or p_account is distinct from 'oracle-updater'
     or p_kinds is null or cardinality(p_kinds)=0 or array_position(p_kinds,null) is not null
     or not(p_kinds<@array['request','feed','xcm']::text[]) then
    raise exception using errcode='42501',message='relayer claim lane is not permitted';
  end if;
  return public.morpheus_delivery_claim(p_network,p_chain,p_account,p_owner,p_lease_ms,p_kinds);
end $$;
create function neoos_relayer_v2.morpheus_delivery_transition(p_network text,p_job text,p_owner text,p_generation bigint,p_op text,p_data jsonb,p_lease_ms bigint default 30000)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.morpheus_delivery_jobs;
begin
  perform neoos_relayer_private.assert_scope(p_network);
  select * into j from public.morpheus_delivery_jobs where job_key=p_job and network=p_network
    and account_scope='oracle-updater' and kind in ('request','feed','xcm') for update;
  if not found then raise exception using errcode='42501',message='delivery job is outside caller scope'; end if;
  -- Delegate to the latest completion-identity implementation and its fencing.
  return public.morpheus_delivery_transition(p_job,p_owner,p_generation,p_op,p_data,p_lease_ms);
end $$;
create function neoos_relayer_v2.morpheus_delivery_checkpoint(p_network text,p_chain text,p_contract text,p_cursor text default null)
returns text language plpgsql security definer set search_path='' as $$
begin
  perform neoos_relayer_private.assert_scope(p_network);
  if p_chain is null or p_chain not in ('neo_n3','neox') then raise exception using errcode='42501',message='invalid relayer chain'; end if;
  return public.morpheus_delivery_checkpoint(p_network,p_chain,p_contract,p_cursor);
end $$;
create function neoos_relayer_v2.morpheus_delivery_feed_baseline(p_network text,p_chain text,p_contract text,p_snapshot jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform neoos_relayer_private.assert_scope(p_network);
  if p_chain is null or p_chain not in ('neo_n3','neox') or p_snapshot is not null then
    raise exception using errcode='42501',message='feed baseline seeding requires maintenance';
  end if;
  return public.morpheus_delivery_feed_baseline(p_network,p_chain,p_contract,null);
end $$;
create function neoos_relayer_v2.morpheus_delivery_account_health(p_network text,p_chain text,p_account text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform neoos_relayer_private.assert_scope(p_network);
  if p_chain is null or p_chain not in ('neo_n3','neox') or p_account is distinct from 'oracle-updater' then
    raise exception using errcode='42501',message='invalid relayer account lane';
  end if;
  return public.morpheus_delivery_account_health(p_network,p_chain,p_account);
end $$;

revoke all on all functions in schema neoos_relayer_v2 from public;
grant execute on function neoos_relayer_v2.morpheus_delivery_enqueue(text,text,text,text,text,jsonb),
  neoos_relayer_v2.morpheus_delivery_claim(text,text,text,text,bigint,text[]),
  neoos_relayer_v2.morpheus_delivery_transition(text,text,text,bigint,text,jsonb,bigint),
  neoos_relayer_v2.morpheus_delivery_checkpoint(text,text,text,text),
  neoos_relayer_v2.morpheus_delivery_feed_baseline(text,text,text,jsonb),
  neoos_relayer_v2.morpheus_delivery_account_health(text,text,text) to neoos_relayer_caller;

-- Preserve unknown hook composition rather than silently replacing it.
do $$ declare hook text; schemas text; database_oid oid;
begin
  if not exists(select 1 from pg_roles where rolname='authenticator') then
    raise exception 'trusted PostgREST gateway role required; admission held';
  end if;
  database_oid:=(select oid from pg_database where datname=current_database());
  select substr(setting,length('pgrst.db_pre_request=')+1) into hook
    from pg_db_role_setting s cross join lateral unnest(s.setconfig) setting
    where s.setrole=(select oid from pg_roles where rolname='authenticator')
      and s.setdatabase in (0,database_oid) and setting like 'pgrst.db_pre_request=%'
    order by s.setdatabase desc limit 1;
  if hook is not null and hook<>'public.neoos_relayer_pre_request' then
    raise exception 'existing PostgREST hook requires explicit composition admission';
  end if;
  select substr(setting,length('pgrst.db_schemas=')+1) into schemas
    from pg_db_role_setting s cross join lateral unnest(s.setconfig) setting
    where s.setrole=(select oid from pg_roles where rolname='authenticator')
      and s.setdatabase in (0,database_oid) and setting like 'pgrst.db_schemas=%'
    order by s.setdatabase desc limit 1;
  schemas:=coalesce(nullif(schemas,''),'public');
  if not('neoos_relayer_v2'=any(string_to_array(replace(schemas,' ',''),','))) then schemas:=schemas||',neoos_relayer_v2'; end if;
  execute format('alter role authenticator in database %I set pgrst.db_pre_request=%L',current_database(),'public.neoos_relayer_pre_request');
  execute format('alter role authenticator in database %I set pgrst.db_schemas=%L',current_database(),schemas);
end $$;
-- No role membership or principal grant is installed. Actual gateway signature
-- verification, effective hook/schema configuration and issuance remain admission gates.
notify pgrst,'reload config';
notify pgrst,'reload schema';
commit;
