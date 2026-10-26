-- SQL acceptance source only. Claim GUCs model a trusted gateway input;
-- they do not verify a JWT signature. Run only in the existing disposable DB suite.
begin;
do $$ begin
  if exists(select 1 from pg_roles where rolname='neoos_relayer_caller'
      and (rolcanlogin or rolsuper or rolbypassrls or rolcreaterole or rolcreatedb)) then
    raise exception 'caller role has excessive authority';
  end if;
  if has_table_privilege('neoos_relayer_caller','public.morpheus_delivery_jobs','SELECT')
     or has_table_privilege('neoos_relayer_caller','public.morpheus_delivery_jobs','INSERT')
     or has_function_privilege('neoos_relayer_caller','public.morpheus_delivery_replay(text,text,text)','EXECUTE') then
    raise exception 'caller gained direct data or maintenance authority';
  end if;
end $$;
-- Only the DB test owner writes synthetic grants. Migration admits no callers.
insert into neoos_relayer_private.caller_grants(issuer,caller_id,network,grant_epoch,enabled,migration_ready)
values('https://issuer.invalid','mainnet-relayer','mainnet',1,true,true);
set local role neoos_relayer_caller;
select set_config('request.jwt.claims','{"role":"neoos_relayer_caller","aud":"authenticated","iss":"https://issuer.invalid","sub":"mainnet-relayer","neoos_network":"mainnet","scope":"neoos/relayer-delivery/v2","neoos_epoch":1,"exp":4102444800}',true);
do $$ begin
  -- This direct SQL session is not the trusted gateway and must be rejected.
  perform neoos_relayer_v2.morpheus_delivery_account_health('mainnet','neo_n3','oracle-updater');
  raise exception 'direct SQL claims were accepted as gateway verification';
exception when insufficient_privilege then null;
end $$;
reset role;
rollback;
