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

-- Exercise the exact migration source, not a copied configuration guard. The
-- disposable runner supplies this local fixture path; this is not a cloud read.
\getenv caller_scope_migration NEOOS_CALLER_SCOPE_MIGRATION_FIXTURE
begin;
create temporary table caller_scope_migration_fixture(source text not null) on commit drop;
insert into caller_scope_migration_fixture values (pg_read_file(:'caller_scope_migration'));

create function pg_temp.check_caller_schema_preimage(
  database_preimage text, global_preimage text, prior_hook text,
  expected_error text, expected_schemas text
) returns void language plpgsql as $$
declare
  source text; migration_body text; actual_schemas text;
  original_settings jsonb; final_settings jsonb;
  original_objects oid[];
  prefix text:=E'-- Source contract only until independently admitted. No principal is enrolled.\nbegin;\n';
  suffix text:=E'commit;\n';
begin
  select f.source into strict source from pg_temp.caller_scope_migration_fixture f;
  if left(source,length(prefix))<>prefix or right(source,length(suffix))<>suffix then
    raise exception 'migration fixture transaction framing changed';
  end if;
  migration_body:=substr(source,length(prefix)+1,length(source)-length(prefix)-length(suffix));
  select jsonb_agg(to_jsonb(s) order by setdatabase) into original_settings
    from pg_db_role_setting s where setrole=(select oid from pg_roles where rolname='authenticator');
  original_objects:=array[
    to_regnamespace('neoos_relayer_private')::oid,
    to_regnamespace('neoos_relayer_v2')::oid,
    to_regprocedure('public.neoos_relayer_pre_request()')::oid,
    (select oid from pg_roles where rolname='neoos_relayer_caller')
  ];
  begin
    -- All destructive fixture setup and the entire migration run in this
    -- subtransaction. Both expected refusals and accepted cases roll it back.
    drop schema neoos_relayer_v2 cascade;
    drop schema neoos_relayer_private cascade;
    drop function public.neoos_relayer_pre_request();
    drop role neoos_relayer_caller;
    alter role authenticator reset pgrst.db_schemas;
    alter role authenticator reset pgrst.db_pre_request;
    execute format('alter role authenticator in database %I reset pgrst.db_schemas',current_database());
    execute format('alter role authenticator in database %I reset pgrst.db_pre_request',current_database());
    if global_preimage is not null then
      execute format('alter role authenticator set pgrst.db_schemas=%L',global_preimage);
    end if;
    if database_preimage is not null then
      execute format('alter role authenticator in database %I set pgrst.db_schemas=%L',current_database(),database_preimage);
    end if;
    if prior_hook is not null then
      execute format('alter role authenticator in database %I set pgrst.db_pre_request=%L',current_database(),prior_hook);
    end if;
    execute migration_body;
    if expected_error is not null then
      raise exception 'migration unexpectedly accepted unknown configuration';
    end if;
    select substr(setting,length('pgrst.db_schemas=')+1) into actual_schemas
      from pg_db_role_setting s cross join lateral unnest(s.setconfig) setting
      where s.setrole=(select oid from pg_roles where rolname='authenticator')
        and s.setdatabase=(select oid from pg_database where datname=current_database())
        and setting like 'pgrst.db_schemas=%';
    if actual_schemas is distinct from expected_schemas then
      raise exception 'schema preimage/order/duplicate preservation failed: %',actual_schemas;
    end if;
    raise exception using errcode='ZX001',message='rollback accepted migration fixture';
  exception
    when sqlstate 'ZX001' then
      if sqlerrm<>'rollback accepted migration fixture' then raise; end if;
    when others then
      if expected_error is null or sqlerrm<>expected_error then raise; end if;
  end;
  select jsonb_agg(to_jsonb(s) order by setdatabase) into final_settings
    from pg_db_role_setting s where setrole=(select oid from pg_roles where rolname='authenticator');
  if final_settings is distinct from original_settings or array[
      to_regnamespace('neoos_relayer_private')::oid,
      to_regnamespace('neoos_relayer_v2')::oid,
      to_regprocedure('public.neoos_relayer_pre_request()')::oid,
      (select oid from pg_roles where rolname='neoos_relayer_caller')
    ] is distinct from original_objects then
    raise exception 'migration refusal/test rollback changed role settings or objects';
  end if;
end $$;

select pg_temp.check_caller_schema_preimage(null,null,null,
  'known role-scoped PostgREST db_schemas preimage required; admission held',null);
select pg_temp.check_caller_schema_preimage('',null,null,
  'known role-scoped PostgREST db_schemas preimage required; admission held',null);
select pg_temp.check_caller_schema_preimage(E' \t\n ',null,null,
  'known role-scoped PostgREST db_schemas preimage required; admission held',null);
-- A present-but-empty database override must not fall back to a global value.
select pg_temp.check_caller_schema_preimage('','public,graphql_public',null,
  'known role-scoped PostgREST db_schemas preimage required; admission held',null);
select pg_temp.check_caller_schema_preimage(null,'public,graphql_public',null,
  null,'public,graphql_public,neoos_relayer_v2');
select pg_temp.check_caller_schema_preimage('graphql_public,public','public,graphql_public',null,
  null,'graphql_public,public,neoos_relayer_v2');
select pg_temp.check_caller_schema_preimage('graphql_public, neoos_relayer_v2 ,public',null,null,
  null,'graphql_public, neoos_relayer_v2 ,public');
select pg_temp.check_caller_schema_preimage(E'public,\tneoos_relayer_v2\t,graphql_public',null,null,
  null,E'public,\tneoos_relayer_v2\t,graphql_public');
select pg_temp.check_caller_schema_preimage(E'public,\fneoos_relayer_v2\f,graphql_public',null,null,
  null,E'public,\fneoos_relayer_v2\f,graphql_public');
select pg_temp.check_caller_schema_preimage('public,graphql_public',null,'public.existing_owner_hook',
  'existing PostgREST hook requires explicit composition admission',null);
rollback;
