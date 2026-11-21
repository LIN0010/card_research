-- READ ONLY: verify source line endings and the exact RLS event-trigger binding.
-- No application RPCs, user rows, source bodies, repair, migration or deployment.
begin isolation level repeatable read read only;
set local statement_timeout = '20s';
set local lock_timeout = '3s';

with expected(schema,name,lf_sha256,crlf_sha256) as (values
  ('app_private','erase_draw_history','d59466c049019812e456e254a895ea4aa2c859c222a12de9eb1e19a922988140','cc69ff0b38ddb5911ebb96146ebfca12a53ea4d4eb4dd09c328d766466ff129b'),
  ('app_private','prevent_deleted_draw_reuse','f8714453c8713e662d20cec2a166f1c7f64a03734d089d0a4b52097ba41c1c19','e762672d6963f62dff166f0a854459bb70ed41688d7e478ae4a4e5908b7963f4'),
  ('public','apply_command','321f79a4780a7d9037a40bd854f42ae752b0cfa9b4611ef72dd73bece716a17b','e3fdb2ad8010fcfde84c2924dda892ddbd0b51ae493be94a3972c5c53820c148')
), sources as (
  select n.nspname as schema,p.proname as name,pg_catalog.pg_get_function_identity_arguments(p.oid) as arguments,
    pg_catalog.octet_length(p.prosrc) as raw_bytes,
    pg_catalog.octet_length(pg_catalog.replace(p.prosrc,E'\r\n',E'\n')) as lf_bytes,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex') as raw_sha256,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex') as lf_sha256,
    pg_catalog.position(E'\r' in pg_catalog.replace(p.prosrc,E'\r\n',E'\n'))>0 as has_lone_cr
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where (n.nspname,p.proname) in (select schema,name from expected)
), source_checks as (
  select s.*,s.lf_sha256=e.lf_sha256 as matches_baseline_after_crlf_only,
    s.raw_sha256=e.crlf_sha256 as raw_matches_exact_crlf_baseline
  from sources s join expected e using(schema,name)
), platform as (
  select p.oid,p.proowner,p.proacl,n.nspname as schema,p.proname as name,
    pg_catalog.pg_get_function_identity_arguments(p.oid) as arguments,
    pg_catalog.pg_get_function_result(p.oid) as result,pg_catalog.pg_get_userbyid(p.proowner) as owner,
    l.lanname,p.prosecdef,p.provolatile,p.proisstrict,p.proleakproof,p.proparallel,p.proconfig,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex') as raw_sha256,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex') as lf_sha256
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  join pg_catalog.pg_language l on l.oid=p.prolang where n.nspname='public' and p.proname='rls_auto_enable'
), platform_grants as (
  select p.schema,p.name,p.arguments,
    case when a.grantee=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(a.grantee) end as role,
    pg_catalog.pg_get_userbyid(a.grantor) as grantor,a.privilege_type,a.is_grantable
  from platform p,lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
), bindings as (
  select e.evtname,e.evtevent,e.evtenabled,pg_catalog.pg_get_userbyid(e.evtowner) as owner,
    n.nspname as function_schema,p.proname as function_name,pg_catalog.pg_get_function_identity_arguments(p.oid) as arguments,
    array(select t::text from pg_catalog.unnest(e.evttags) t order by 1) as tags
  from pg_catalog.pg_event_trigger e join pg_catalog.pg_proc p on p.oid=e.evtfoid
  join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where e.evtname='ensure_rls' or (n.nspname='public' and p.proname='rls_auto_enable')
)
select pg_catalog.jsonb_build_object(
  'transaction_read_only',pg_catalog.current_setting('transaction_read_only'),
  'source_checks',coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(s) order by s.schema,s.name,s.arguments) from source_checks s),'[]'::jsonb),
  'platform_function',coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p)-array['oid','proowner','proacl','proconfig'] order by p.arguments) from platform p),'[]'::jsonb),
  'platform_search_path_is_pg_catalog',coalesce((select pg_catalog.bool_and(p.proconfig=array['search_path=pg_catalog']) from platform p),false),
  'platform_grants',coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(g) order by g.role,g.grantor) from platform_grants g),'[]'::jsonb),
  'event_trigger_bindings',coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(b) order by b.evtname) from bindings b),'[]'::jsonb)
) as readonly_verification;

rollback;
