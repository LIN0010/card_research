import { DeploymentError } from './error.mjs'
import { PGlite } from '@electric-sql/pglite'
import { createHash } from 'node:crypto'
import { comparisonCatalog, containsPlatformFunction } from './function-policy.mjs'

const scope = `n.nspname in ('public','app_private') and not exists
  (select 1 from pg_depend e where e.classid='pg_class'::regclass and e.objid=c.oid and e.deptype='e')`
const functionScope = `n.nspname in ('public','app_private') and not exists
  (select 1 from pg_depend e where e.classid='pg_proc'::regclass and e.objid=p.oid and e.deptype='e')`
const roles = `(a.grantee = 0 or a.grantee in (select oid from pg_roles where rolname in ('anon','authenticated')))`
const roleName = `case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end`

// Only catalog metadata is read: never export production rows, accounts or snapshots.
// Include unexpected private objects and policies/triggers on application tables.
const queries = {
  tables: `select n.nspname as schema, c.relname as name, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
    pg_get_userbyid(c.relowner) as owner from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where c.relkind in ('r','p','v','m','S','f') and (${scope})`,
  columns: `select n.nspname as schema, c.relname as name, t.attnum, t.attname, format_type(t.atttypid,t.atttypmod) as type,
    t.attnotnull, t.attidentity, t.attgenerated, pg_get_expr(d.adbin,d.adrelid) as default_value,
    coalesce(t.attacl::text,'') as column_acl
    from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute t on t.attrelid=c.oid
    left join pg_attrdef d on d.adrelid=c.oid and d.adnum=t.attnum
    where t.attnum>0 and not t.attisdropped and (${scope})`,
  constraints: `select n.nspname as schema, c.relname as name, x.conname, x.contype, x.convalidated,
    pg_get_constraintdef(x.oid,false) as definition from pg_constraint x join pg_class c on c.oid=x.conrelid
    join pg_namespace n on n.oid=c.relnamespace where ${scope}`,
  indexes: `select n.nspname as schema, c.relname as name, i.relname as index_name, x.indisvalid, x.indisready,
    pg_get_indexdef(x.indexrelid,0,false) as definition from pg_index x join pg_class c on c.oid=x.indrelid
    join pg_class i on i.oid=x.indexrelid join pg_namespace n on n.oid=c.relnamespace where ${scope}`,
  policies: `select n.nspname as schema, c.relname as name, p.polname, p.polcmd, p.polpermissive,
    array(select (case when r=0 then 'PUBLIC' else pg_get_userbyid(r) end)::text from unnest(p.polroles) r order by 1) as roles,
    pg_get_expr(p.polqual,p.polrelid) as using_expression, pg_get_expr(p.polwithcheck,p.polrelid) as check_expression
    from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where ${scope}`,
  triggers: `select n.nspname as schema, c.relname as name, t.tgname, t.tgenabled,
    pg_get_triggerdef(t.oid,false) as definition from pg_trigger t join pg_class c on c.oid=t.tgrelid
    join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and (${scope})`,
  tableGrants: `select n.nspname as schema, c.relname as name, ${roleName} as role, a.privilege_type, a.is_grantable
    from pg_class c join pg_namespace n on n.oid=c.relnamespace,
    lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where (${scope}) and ${roles}`,
  effectiveTablePrivileges: `select n.nspname as schema, c.relname as name, r.rolname, v.privilege,
    has_table_privilege(r.oid,c.oid,v.privilege) as allowed
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    cross join pg_roles r cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) v(privilege)
    where c.relkind in ('r','p') and r.rolname in ('anon','authenticated') and (${scope})`,
  clientRoleSecurity: `select rolname, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
    from pg_roles where rolname in ('anon','authenticated')`,
  functions: `select n.nspname as schema, p.proname as name, pg_get_function_identity_arguments(p.oid) as arguments,
    pg_get_function_result(p.oid) as result, l.lanname, p.prosecdef, p.provolatile, p.proisstrict, p.proleakproof, p.proparallel,
    p.proconfig, p.prosrc, pg_get_userbyid(p.proowner) as owner
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
    where ${functionScope}`,
  functionGrants: `select n.nspname as schema, p.proname as name, pg_get_function_identity_arguments(p.oid) as arguments,
    ${roleName} as role, a.privilege_type, a.is_grantable
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace,
    lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where (${functionScope}) and ${roles}`,
  platformFunctionPrivileges: `select n.nspname as schema,p.proname as name,pg_get_function_identity_arguments(p.oid) as arguments,
    ${roleName} as role,pg_get_userbyid(a.grantor) as grantor,a.privilege_type,a.is_grantable
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace,
    lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where n.nspname='public' and p.proname='rls_auto_enable'`,
  platformFunctionProperties: `select n.nspname as schema,p.proname as name,pg_get_function_identity_arguments(p.oid) as arguments,
    p.prokind,p.pronargs,p.proretset,p.provariadic<>0 as has_variadic,p.prosupport::oid<>0 as has_support_function,
    p.proargdefaults is null as no_defaults,p.probin is null as no_external_binary,p.procost,p.prorows
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='rls_auto_enable'`,
  eventTriggers: `select e.evtname,e.evtevent,e.evtenabled,pg_get_userbyid(e.evtowner) as owner,
    n.nspname as function_schema,p.proname as function_name,pg_get_function_identity_arguments(p.oid) as arguments,
    array(select t::text from unnest(e.evttags) t order by 1) as tags
    from pg_event_trigger e join pg_proc p on p.oid=e.evtfoid join pg_namespace n on n.oid=p.pronamespace
    where e.evtname='ensure_rls' or n.nspname in ('public','app_private')`,
  privateSchemaGrants: `select n.nspname as schema, ${roleName} as role, a.privilege_type, a.is_grantable
    from pg_namespace n, lateral aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
    where n.nspname='app_private' and ${roles}`,
}

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')

export async function catalog(db) {
  const snapshot = {}
  for (const [name, sql] of Object.entries(queries)) {
    const rows = (await db.query(sql)).rows
    snapshot[name] = rows.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'))
  }
  return snapshot
}

export async function expectedCatalog(migrations) {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;`)
    for (const migration of migrations) await db.exec(migration.sql)
    return await catalog(db)
  } finally { await db.close() }
}

export function assertCatalog(expected, actual) {
  // A helper explicitly introduced by an application migration is still required
  // on the server; only a platform-only helper is optional relative to the MVP.
  const preservePlatform = containsPlatformFunction(expected)
  const before = comparisonCatalog(expected,{ preservePlatform })
  const after = comparisonCatalog(actual,{ preservePlatform })
  const differences = [...new Set([...Object.keys(before),...Object.keys(after)])].filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
  if (differences.length) throw new DeploymentError(`Database structure differs in: ${differences.join(', ')}. Stop; do not repair history or rerun old SQL. Investigate catalog drift manually.`)
}

export async function readCatalog(db) {
  await db.query('begin isolation level repeatable read read only')
  try {
    const result = await catalog(db)
    await db.query('commit')
    return result
  } catch (error) { await db.query('rollback'); throw error }
}

export async function history(db) {
  const exists = await db.query("select to_regclass('supabase_migrations.schema_migrations') as relation")
  if (!exists.rows[0].relation) return []
  return (await db.query('select version from supabase_migrations.schema_migrations order by version')).rows.map(row => row.version)
}
