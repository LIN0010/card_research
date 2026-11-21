import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { parse } from 'yaml'
import { catalog, expectedCatalog, assertCatalog } from '../../scripts/deploy/catalog.mjs'
import { baselineVersions, migrations } from '../../scripts/deploy/plan.mjs'
import { collectDiagnostics, functionReport } from '../../scripts/deploy/function-diagnostics.mjs'

const local = migrations().filter(item => baselineVersions.includes(item.version))
const expected = await expectedCatalog(local)
async function fixture(defaults = '') {
  const db = new PGlite()
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;`)
    if (defaults) await db.exec(defaults)
    for (const item of local) await db.exec(item.sql)
    return db
  } catch (error) { await db.close();throw error }
}

test('public-schema and global default EXECUTE grants alone do not change the three app functions or compared grants', async () => {
  for (const scope of ['in schema public','']) {
    const db = await fixture(`alter default privileges ${scope} grant all on functions to postgres,anon,authenticated,service_role;`)
    try {
      const actual = await catalog(db)
      assert.deepEqual(actual.functions,expected.functions)
      assert.deepEqual(actual.functionGrants,expected.functionGrants)
      const report = functionReport(expected,actual)
      assert.equal(report.exact_functions_match,true)
      assert.equal(report.exact_function_grants_match,true)
    } finally { await db.close() }
  }
})

test('extra non-extension functions explain both categories but remain rejected by the unchanged guard', async () => {
  const db = await fixture()
  try {
    await db.exec('create function public.unexpected_helper() returns text language sql as $$ select current_user::text $$;')
    const actual = await catalog(db)
    const report = functionReport(expected,actual)
    assert.equal(report.exact_functions_match,false)
    assert.equal(report.exact_function_grants_match,false)
    assert.equal(report.function_differences.length,1)
    assert.equal(report.function_differences[0].status,'unexpected')
    assert.equal(report.function_grants_added[0].role,'PUBLIC')
    assert.throws(() => assertCatalog(expected,actual),/functions, functionGrants/)
  } finally { await db.close() }
})

test('diagnostics report changed definition/configuration hashes without printing body literals or GUC values', () => {
  const actual = structuredClone(expected)
  const sentinel = 'embedded-sensitive-literal-must-not-be-logged'
  actual.functions[0].prosrc = `begin raise exception '${sentinel}';end;`
  actual.functions[0].proconfig = [`custom.token=${sentinel}`]
  actual.functions[0].owner = 'supabase_admin'
  const report = functionReport(expected,actual)
  assert.deepEqual(report.function_differences[0].fields,['proconfig','prosrc','owner'])
  assert.ok(!JSON.stringify(report).includes(sentinel))
  assert.ok(!JSON.stringify(report).includes('raise exception'))
  assert.equal(report.function_differences[0].actual.empty_search_path,false)
  assert.throws(() => assertCatalog(expected,actual),/functions/)
})

test('grant-option or private EXECUTE drift is visible and never treated as approved', () => {
  const actual = structuredClone(expected)
  actual.functionGrants[0].is_grantable = true
  const report = functionReport(expected,actual)
  assert.equal(report.function_grants_added[0].is_grantable,true)
  assert.equal(report.function_grants_missing[0].is_grantable,false)
  assert.match(report.verdict,/not approved/)
  assert.throws(() => assertCatalog(expected,actual),/functionGrants/)
})

test('collector uses a read-only transaction and leaves no writable session or application-row queries', async () => {
  const db = await fixture('alter default privileges in schema public grant all on functions to anon,authenticated,service_role;')
  const commands = []
  const tracked = { query: (sql,...args) => { commands.push(sql);return db.query(sql,...args) } }
  try {
    const report = await collectDiagnostics(tracked,expected)
    assert.equal(report.environment.transaction_read_only,'on')
    assert.equal(report.exact_functions_match,true)
    assert.equal(report.exact_function_grants_match,true)
    assert.ok(report.default_function_privileges.some(row => row.role === 'anon'))
    assert.ok(report.all_role_function_privileges.some(row => row.role === 'service_role'))
    assert.equal(commands[0],'set default_transaction_read_only = on')
    assert.equal(commands[1],'begin isolation level repeatable read read only')
    assert.equal(commands.at(-1),'rollback')
    assert.ok(commands.every(sql => !/\b(?:from|join)\s+(?:public|app_private|auth)\./i.test(sql)))
    await assert.rejects(() => db.query("insert into public.stores(name) values('must fail')"),error => error.code === '25006')
  } finally { await db.close() }
})

test('diagnostic workflow is manual, main-only and has no CLI, repair, deployment tokens or automatic trigger', () => {
  const source = readFileSync('.github/workflows/function-diagnostics.yml','utf8')
  const workflow = parse(source)
  assert.deepEqual(Object.keys(workflow.on),['workflow_dispatch'])
  assert.match(workflow.jobs.diagnostics.if,/refs\/heads\/main/)
  assert.equal(workflow.permissions.contents,'read')
  assert.equal(workflow.jobs.diagnostics.environment,'production')
  assert.equal(workflow.concurrency.group,'card-research-production')
  assert.ok(!/VERCEL|setup-cli|migration repair|db push/.test(source))
  for (const step of workflow.jobs.diagnostics.steps) if (step.uses) assert.match(step.uses,/@[a-f0-9]{40}$/)
})

test('SQL Editor diagnostic executes read-only and its source hashes agree with the Actions report', async () => {
  const db = await fixture()
  try {
    const statements = await db.exec(readFileSync('docs/diagnostics/function-catalog.sql','utf8'))
    const report = statements.flatMap(result => result.rows).find(row => row.readonly_diagnostic)?.readonly_diagnostic
    assert.equal(report.transaction_read_only,'on')
    assert.equal(report.functions.length,3)
    const baseline = functionReport(expected,expected)
    for (const fn of report.functions) {
      const ref = baseline.expected_functions.find(item => item.schema === fn.schema && item.name === fn.name)
      assert.equal(fn.source_sha256,ref.source.sha256)
      assert.equal(fn.configuration_sha256,ref.configuration.sha256)
      assert.equal(fn.source_utf8_bytes,ref.source.utf8_bytes)
    }
    assert.ok(!JSON.stringify(report).includes('v_operation'))
  } finally { await db.close() }
})
