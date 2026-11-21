import pg from 'pg'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { assertCatalog, catalog, digest, expectedCatalog } from './catalog.mjs'
import { sourceFingerprint } from './function-policy.mjs'
import { baselineVersions, migrations, validateContext } from './plan.mjs'
import { databaseConfig } from './production.mjs'
import { DeploymentError } from './error.mjs'

const key = row => JSON.stringify([row.schema,row.name,row.arguments])
const sorted = rows => rows.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b),'en'))
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b)
const hashValue = value => ({ sha256: digest(typeof value === 'string' ? value : JSON.stringify(value)), ...(typeof value === 'string' ? { utf8_bytes: Buffer.byteLength(value) } : {}) })

function safeFunction(row) {
  if (!row) return null
  const { prosrc,proconfig,...metadata } = row
  return { ...metadata,source: sourceFingerprint(prosrc),configuration: hashValue(proconfig),empty_search_path: proconfig?.includes('search_path=""') ?? false }
}

// Report raw differences and the result of the separately reviewed comparison
// policy. Diagnostics never generate a history approval or invoke release.
// Raw source and GUC values may contain embedded secrets, so only hashes are printed.
export function functionReport(expected,actual) {
  let catalogMatches = false
  let comparisonFailure = null
  try { assertCatalog(expected,actual);catalogMatches = true } catch (error) {
    if (!(error instanceof DeploymentError)) throw error
    comparisonFailure = error.message
  }
  const before = new Map(expected.functions.map(row => [key(row),row]))
  const after = new Map(actual.functions.map(row => [key(row),row]))
  const changed = []
  for (const identity of [...new Set([...before.keys(),...after.keys()])].sort()) {
    const left = before.get(identity); const right = after.get(identity)
    if (same(left,right)) continue
    changed.push({ identity: JSON.parse(identity),status: !left ? 'unexpected' : !right ? 'missing' : 'changed',
      fields: left && right ? Object.keys(left).filter(field => !same(left[field],right[field])) : [],
      expected: safeFunction(left),actual: safeFunction(right) })
  }
  return {
    expected_function_count: before.size,actual_function_count: after.size,
    exact_functions_match: same(expected.functions,actual.functions),
    exact_function_grants_match: same(expected.functionGrants,actual.functionGrants),
    catalog_matches_verified_policy: catalogMatches,catalog_comparison_failure: comparisonFailure,
    function_differences: changed,
    function_grants_added: actual.functionGrants.filter(row => !expected.functionGrants.some(item => same(row,item))),
    function_grants_missing: expected.functionGrants.filter(row => !actual.functionGrants.some(item => same(row,item))),
    expected_functions: expected.functions.map(safeFunction),expected_function_grants: expected.functionGrants,
    verdict: 'DIAGNOSTIC ONLY: repair, migration and deployment are not approved by this report.',
  }
}

export async function collectDiagnostics(db,expected) {
  // Set both the session default and the explicit snapshot transaction read-only.
  // No RPC, advisory-lock function, application-row query or DDL is executed here.
  await db.query('set default_transaction_read_only = on')
  await db.query('begin isolation level repeatable read read only')
  try {
    const environment = (await db.query(`select current_setting('server_version') as server_version,
      current_setting('transaction_read_only') as transaction_read_only`)).rows[0]
    if (environment.transaction_read_only !== 'on') throw new DeploymentError('Diagnostic transaction is not read-only')
    const actual = await catalog(db)
    const defaultFunctionPrivileges = (await db.query(`select pg_get_userbyid(d.defaclrole) as owner,
      coalesce(n.nspname,'(global)') as schema,
      case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as role,
      a.privilege_type,a.is_grantable
      from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace,
      lateral aclexplode(d.defaclacl) a
      where d.defaclobjtype='f' and (d.defaclnamespace=0 or n.nspname in ('public','app_private'))`)).rows
    const functionPrivileges = (await db.query(`select n.nspname as schema,p.proname as name,
      pg_get_function_identity_arguments(p.oid) as arguments,oidvectortypes(p.proargtypes) as argument_types,
      case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as role,
      a.privilege_type,a.is_grantable
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace,
      lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where n.nspname in ('public','app_private') and not exists
      (select 1 from pg_depend e where e.classid='pg_proc'::regclass and e.objid=p.oid and e.deptype='e')`)).rows
    const effectiveExecute = (await db.query(`select n.nspname as schema,p.proname as name,
      pg_get_function_identity_arguments(p.oid) as arguments,r.rolname as role,
      has_function_privilege(r.oid,p.oid,'EXECUTE') as can_execute,
      has_schema_privilege(r.oid,n.oid,'USAGE') as has_schema_usage
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join pg_roles r
      where r.rolname in ('anon','authenticated') and n.nspname in ('public','app_private') and not exists
      (select 1 from pg_depend e where e.classid='pg_proc'::regclass and e.objid=p.oid and e.deptype='e')`)).rows
    const extensions = (await db.query(`select e.extname,e.extversion,n.nspname as schema
      from pg_extension e join pg_namespace n on n.oid=e.extnamespace order by e.extname`)).rows
    return { ...functionReport(expected,actual),environment,
      event_trigger_bindings: actual.eventTriggers,platform_function_properties: actual.platformFunctionProperties,
      platform_function_privileges: actual.platformFunctionPrivileges,
      default_function_privileges: sorted(defaultFunctionPrivileges),
      all_role_function_privileges: sorted(functionPrivileges),effective_execute: sorted(effectiveExecute),extensions }
  } finally { await db.query('rollback') }
}

async function main() {
  const env = process.env
  // Reuse only the context/TLS guards, never the production release entry point.
  validateContext(env,'verify-history')
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch') throw new DeploymentError('Diagnostics require an explicit manual run on main')
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/git/ref/heads/main`,{
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}` },signal: AbortSignal.timeout(20000) })
  if (!response.ok || (await response.json()).object.sha !== env.GITHUB_SHA) throw new DeploymentError('Diagnostic commit must still be main HEAD')
  const expected = await expectedCatalog(migrations().filter(item => baselineVersions.includes(item.version)))
  const db = new pg.Client(databaseConfig(env))
  db.on('error',() => {}) // driver errors must not print credentials or raw SQL
  try {
    await db.connect()
    const report = await collectDiagnostics(db,expected)
    const text = JSON.stringify({ baseline_commit: env.GITHUB_SHA,...report },null,2)
    console.log(text)
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY,`Read-only function diagnostic (no source bodies or raw GUC values).\n\n\`\`\`json\n${text}\n\`\`\`\n`)
  } finally { await db.end() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof DeploymentError ? error.message : 'Read-only function diagnostic failed; raw driver/network errors are suppressed. No repair, migration or deployment was requested.')
    process.exitCode = 1
  })
}
