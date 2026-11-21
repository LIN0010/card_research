import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { assertCatalog, catalog, expectedCatalog } from '../../scripts/deploy/catalog.mjs'
import { migrations, baselineVersions } from '../../scripts/deploy/plan.mjs'
import { sourceFingerprint } from '../../scripts/deploy/function-policy.mjs'
import { functionReport } from '../../scripts/deploy/function-diagnostics.mjs'

const local = migrations().filter(item => baselineVersions.includes(item.version))
const expected = await expectedCatalog(local)
async function fixture({ crlf = false,platformCrlf = false } = {}) {
  const db = new PGlite()
  try {
    await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql as $$select null::uuid$$;`)
    for (const item of local) await db.exec(crlf ? item.sql.replaceAll('\n','\r\n') : item.sql)
    const template = readFileSync('tests/fixtures/supabase-auto-rls.sql','utf8')
    await db.exec(platformCrlf ? template.replaceAll('\n','\r\n') : template)
    return db
  } catch (error) { await db.close();throw error }
}
const db = await fixture({ crlf: true })
let verified
try { verified = await catalog(db) } finally { await db.close() }
const helper = snapshot => snapshot.functions.find(row => row.name === 'rls_auto_enable')

test('verified production shape: CRLF app bodies and the exact official helper pass without mutating evidence', () => {
  const before = structuredClone(verified)
  assertCatalog(expected,verified)
  assert.deepEqual(verified,before)
  assertCatalog(expected,expected) // optional helper is not required by MVP migrations
  const report = functionReport(expected,verified)
  assert.equal(report.exact_functions_match,false)
  assert.equal(report.exact_function_grants_match,false)
  assert.equal(report.catalog_matches_verified_policy,true)
  assert.equal(report.catalog_comparison_failure,null)
  const lfHashes = report.expected_functions.map(row => row.source.sha256)
  assert.deepEqual(report.function_differences.filter(row => row.status === 'changed').map(row => row.actual.source.lf_sha256),lfHashes)
})

test('the pinned official helper also supports CRLF only; no source trimming or normalization beyond CRLF', async () => {
  const database = await fixture({ platformCrlf: true })
  try { assertCatalog(expected,await catalog(database)) } finally { await database.close() }
  const changed = structuredClone(verified)
  helper(changed).prosrc += ' '
  assert.throws(() => assertCatalog(expected,changed),/source hash/)
})

test('an explicitly migrated helper remains required, rather than being erased from both sides', () => {
  assertCatalog(verified,verified)
  assert.throws(() => assertCatalog(verified,expected),/functions/)
})

for (const [name,change] of [
  ['real application content change',snapshot => { snapshot.functions[0].prosrc += '-- changed\r\n' }],
  ['application whitespace change',snapshot => { snapshot.functions[0].prosrc += ' ' }],
  ['application lone CR',snapshot => { snapshot.functions[0].prosrc += '\r' }],
  ['application owner change',snapshot => { snapshot.functions[0].owner = 'authenticated' }],
  ['application search_path change',snapshot => { snapshot.functions[0].proconfig = ['search_path=public'] }],
  ['application privilege change',snapshot => { snapshot.functionGrants.find(row => row.name === 'apply_command').is_grantable = true }],
  ['unknown extra function',snapshot => { snapshot.functions.push({ ...snapshot.functions[0],name: 'unrecognized_helper' }) }],
  ['other extra event-trigger function',snapshot => { snapshot.functions.push({ ...helper(snapshot),name: 'unrecognized_event_helper' }) }],
  ['missing application function',snapshot => { snapshot.functions.shift() }],
  ['RLS policy change',snapshot => { snapshot.policies[0].using_expression = 'true' }],
  ['table privilege change',snapshot => { snapshot.tableGrants[0].privilege_type = 'INSERT' }],
  ['unrelated same-name signature grant',snapshot => { snapshot.functionGrants.push({schema:'public',name:'rls_auto_enable',arguments:'value text',role:'PUBLIC',privilege_type:'EXECUTE',is_grantable:false}) }],
]) {
  test(`still rejects ${name}`, () => {
    const changed = structuredClone(verified);change(changed)
    assert.throws(() => assertCatalog(expected,changed))
  })
}

for (const [name,change] of [
  ['same name with wrong source',snapshot => { helper(snapshot).prosrc = 'begin return;end;' }],
  ['wrong owner',snapshot => { helper(snapshot).owner = 'supabase_admin' }],
  ['wrong signature',snapshot => { helper(snapshot).arguments = 'value text' }],
  ['extra overload',snapshot => { snapshot.functions.push({ ...helper(snapshot),arguments: 'value text' }) }],
  ['wrong return type',snapshot => { helper(snapshot).result = 'trigger' }],
  ['wrong language',snapshot => { helper(snapshot).lanname = 'sql' }],
  ['wrong search_path',snapshot => { helper(snapshot).proconfig = ['search_path=public'] }],
  ['extra configuration',snapshot => { helper(snapshot).proconfig.push('row_security=off') }],
  ['security invoker',snapshot => { helper(snapshot).prosecdef = false }],
  ['parallel flag change',snapshot => { helper(snapshot).proparallel = 's' }],
  ['planner-support function',snapshot => { snapshot.platformFunctionProperties[0].has_support_function = true }],
  ['missing properties',snapshot => { snapshot.platformFunctionProperties = [] }],
  ['extra role grant',snapshot => { snapshot.platformFunctionPrivileges.push({ ...snapshot.platformFunctionPrivileges[0],role: 'service_role' }) }],
  ['grant option',snapshot => { snapshot.platformFunctionPrivileges[0].is_grantable = true }],
  ['wrong grantor',snapshot => { snapshot.platformFunctionPrivileges[0].grantor = 'authenticated' }],
  ['missing ACL entry',snapshot => { snapshot.platformFunctionPrivileges.pop() }],
  ['inconsistent filtered ACL',snapshot => { snapshot.functionGrants.find(row => row.name === 'rls_auto_enable').is_grantable = true }],
  ['missing binding',snapshot => { snapshot.eventTriggers = [] }],
  ['disabled binding',snapshot => { snapshot.eventTriggers[0].evtenabled = 'D' }],
  ['always-enabled binding',snapshot => { snapshot.eventTriggers[0].evtenabled = 'A' }],
  ['wrong binding name',snapshot => { snapshot.eventTriggers[0].evtname = 'other_name' }],
  ['wrong binding owner',snapshot => { snapshot.eventTriggers[0].owner = 'authenticated' }],
  ['wrong event',snapshot => { snapshot.eventTriggers[0].evtevent = 'sql_drop' }],
  ['wrong bound function',snapshot => { snapshot.eventTriggers[0].function_name = 'other_helper' }],
  ['missing tag',snapshot => { snapshot.eventTriggers[0].tags.pop() }],
  ['extra tag',snapshot => { snapshot.eventTriggers[0].tags.push('ALTER TABLE') }],
  ['extra binding',snapshot => { snapshot.eventTriggers.push({ ...snapshot.eventTriggers[0],evtname: 'other_binding' }) }],
  ['incomplete catalog evidence',snapshot => { delete snapshot.platformFunctionPrivileges }],
]) {
  test(`rejects platform lookalike: ${name}`, () => {
    const changed = structuredClone(verified);change(changed)
    assert.throws(() => assertCatalog(expected,changed),/Platform|Missing required catalog/)
  })
}

test('unknown functions and future approved bodies still compare byte-for-byte', () => {
  const baseline = structuredClone(expected)
  baseline.functions.push({ ...baseline.functions[0],name: 'future_function',prosrc: 'begin\nreturn;\nend;\n' })
  const actual = structuredClone(baseline)
  actual.functions.at(-1).prosrc = actual.functions.at(-1).prosrc.replaceAll('\n','\r\n')
  assert.throws(() => assertCatalog(baseline,actual),/functions/)
  const futureBaseline = structuredClone(expected)
  futureBaseline.functions[0].prosrc += '-- future reviewed body\n'
  const futureActual = structuredClone(futureBaseline)
  futureActual.functions[0].prosrc = futureActual.functions[0].prosrc.replaceAll('\n','\r\n')
  assert.throws(() => assertCatalog(futureBaseline,futureActual),/functions/)
  const copied = structuredClone(expected)
  copied.functions.push({ ...copied.functions[0],name:'copied_known_body' })
  const copiedActual = structuredClone(copied)
  copiedActual.functions.at(-1).prosrc = copiedActual.functions.at(-1).prosrc.replaceAll('\n','\r\n')
  assert.throws(() => assertCatalog(copied,copiedActual),/functions/)
})

test('fingerprints preserve raw evidence and normalize neither lone CR, spaces nor comments', () => {
  assert.equal(sourceFingerprint('a\r\nb').lf_sha256,sourceFingerprint('a\nb').sha256)
  assert.notEqual(sourceFingerprint('a\rb').lf_sha256,sourceFingerprint('a\nb').sha256)
  assert.notEqual(sourceFingerprint('a\nb ').lf_sha256,sourceFingerprint('a\nb').sha256)
  assert.notEqual(sourceFingerprint('a\nb--comment').lf_sha256,sourceFingerprint('a\nb').sha256)
})
