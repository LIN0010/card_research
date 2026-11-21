-- READ-ONLY DIAGNOSTIC, NOT A MIGRATION. Run as postgres in SQL Editor.
-- Reads system catalogs only; never invokes an application function or reads user rows.
begin isolation level repeatable read read only;
set local statement_timeout = '20s';
set local lock_timeout = '3s';

with inventory as (
  select p.oid,p.proowner,p.proacl,n.nspname as schema,p.proname as name,
    pg_catalog.pg_get_function_identity_arguments(p.oid) as arguments,
    pg_catalog.oidvectortypes(p.proargtypes) as argument_types,
    pg_catalog.pg_get_function_result(p.oid) as result,l.lanname,
    pg_catalog.pg_get_userbyid(p.proowner) as owner,
    p.prosecdef,p.provolatile,p.proisstrict,p.proleakproof,p.proparallel,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex') as source_sha256,
    pg_catalog.octet_length(p.prosrc) as source_utf8_bytes,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(pg_catalog.array_to_json(p.proconfig)::text,'null'),'UTF8')),'hex') as configuration_sha256,
    coalesce('search_path=""'=any(p.proconfig),false) as empty_search_path
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  join pg_catalog.pg_language l on l.oid=p.prolang
  where n.nspname in ('public','app_private') and not exists (
    select 1 from pg_catalog.pg_depend e where e.classid='pg_catalog.pg_proc'::regclass and e.objid=p.oid and e.deptype='e'
  )
), grants as (
  select i.schema,i.name,i.arguments,
    case when a.grantee=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(a.grantee) end as role,
    a.privilege_type,a.is_grantable
  from inventory i, lateral pg_catalog.aclexplode(coalesce(i.proacl,pg_catalog.acldefault('f',i.proowner))) a
), defaults as (
  select pg_catalog.pg_get_userbyid(d.defaclrole) as owner,coalesce(n.nspname,'(global)') as schema,
    case when a.grantee=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(a.grantee) end as role,
    a.privilege_type,a.is_grantable
  from pg_catalog.pg_default_acl d left join pg_catalog.pg_namespace n on n.oid=d.defaclnamespace,
    lateral pg_catalog.aclexplode(d.defaclacl) a
  where d.defaclobjtype='f' and (d.defaclnamespace=0 or n.nspname in ('public','app_private'))
)
select pg_catalog.jsonb_build_object(
  'server_version',pg_catalog.current_setting('server_version'),
  'transaction_read_only',pg_catalog.current_setting('transaction_read_only'),
  'functions',coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(i)-array['oid','proowner','proacl'] order by i.schema,i.name,i.arguments) from inventory i),'[]'::jsonb),
  'all_role_function_grants',coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(g) order by g.schema,g.name,g.arguments,g.role) from grants g),'[]'::jsonb),
  'default_function_privileges',coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) order by d.owner,d.schema,d.role) from defaults d),'[]'::jsonb)
) as readonly_diagnostic;

rollback;
