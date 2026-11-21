import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { digest, expectedCatalog, assertCatalog } from '../../scripts/deploy/catalog.mjs'
import { baselineVersions, migrations, migrationPlan, needsReview, planDigest, validateContext } from '../../scripts/deploy/plan.mjs'
import { databaseConfig, assertVercelProject, assertNoActiveDeployments, prepareOutput } from '../../scripts/deploy/production.mjs'
import { validateFrontend } from '../../scripts/deploy/frontend.mjs'
import { release } from '../../scripts/deploy/release.mjs'

const baseline = migrations().filter(item => baselineVersions.includes(item.version))
const versions = baseline.map(item => item.version)
const commit = 'a'.repeat(40)
const project = 'a'.repeat(20)
const addition = { version: '299912310001', sha256: digest('index'), sql: 'create index draws_rarity_idx on public.draws (owner_id, rarity);' }
const risky = { ...addition, sql: 'alter table public.draws drop column rarity;' }

function harness({ pending = [], remote = versions, fail = '' } = {}) {
  let state = [...remote]
  const events = []
  const options = {
    mode: 'deploy', local: [...baseline,...pending], commit, project,
    remoteHistory: async () => [...state],
    verify: async local => { events.push(`verify:${local.length}`); if (fail === 'verify') throw new Error('structure mismatch') },
    cli: async (action, repair) => { events.push(action); if (fail === action) throw new Error(`failed ${action}`); if (action === 'repair') state = [...new Set([...state,...repair])].sort(); if (action === 'push') state = options.local.map(item => item.version) },
    preflight: async () => { events.push('preflight'); if (fail === 'preflight') throw new Error('Git is connected') },
    deploy: async () => { events.push('deploy') }, log: () => {},
  }
  return { options, events }
}

test('pending migration planning requires baseline, contiguous history and immutable baseline hashes', () => {
  assert.deepEqual(migrationPlan([...baseline,addition],versions),[addition])
  assert.throws(() => migrationPlan(baseline,[]),/Baseline/)
  assert.throws(() => migrationPlan(baseline,['unknown']),/Unknown/)
  assert.throws(() => migrationPlan([...baseline,addition],[...versions,versions[1]]),/duplicate/)
  assert.throws(() => migrationPlan([...baseline,addition],[versions[0],addition.version]),/Baseline/)
  assert.deepEqual(migrationPlan(baseline,[],{ bootstrap: true }),baseline)
  assert.throws(() => migrationPlan([...baseline,addition],[addition.version],{ bootstrap: true }),/Baseline synchronization/)
  const directory = mkdtempSync(join(tmpdir(),'card-research-baseline-'))
  try {
    cpSync('supabase/migrations',directory,{ recursive: true })
    const file = join(directory,baseline[0].file)
    writeFileSync(file,readFileSync(file,'utf8')+'\n-- changed old migration\n')
    assert.throws(() => migrations(directory),/Immutable baseline changed/)
  } finally { rmSync(directory,{ recursive: true,force: true }) }
})

test('only narrow additive SQL is automatic; DML, permissions, expressions and dynamic SQL require extra review', () => {
  assert.equal(needsReview(addition.sql),false)
  assert.equal(needsReview('begin; alter table public.draws add column memo text; commit;'),false)
  for (const sql of [risky.sql,'truncate public.draws;', 'delete from public.draws;', 'grant all on public.draws to anon;', 'do $$ begin execute x; end $$;', 'create or replace function public.x() returns void as $$ begin end $$ language plpgsql;', 'create table public.x as select dangerous();', 'create index x on public.draws (dangerous());', 'alter table public.draws add column x text default dangerous();', 'create table public.x(id uuid);']) assert.equal(needsReview(sql),true,sql)
})

test('verify-history reads structure before reporting fingerprint and never repairs or deploys', async () => {
  const { options, events } = harness({ remote: [] })
  const result = await release({ ...options, mode: 'verify-history' })
  assert.equal(result.fingerprint,planDigest(commit,baseline,project))
  assert.deepEqual(events,['preflight','verify:2'])
})

test('sync-history is confirmed, verifies actual structure and only repairs missing versions', async () => {
  const { options, events } = harness({ remote: [versions[0]] })
  await assert.rejects(() => release({ ...options,mode: 'sync-history',approval: 'wrong' }),/fingerprint/)
  assert.ok(!events.includes('repair'))
  events.length = 0
  await release({ ...options,mode: 'sync-history',approval: planDigest(commit,baseline,project) })
  assert.deepEqual(events,['preflight','verify:2','repair','verify:2'])
  events.length = 0
  await release({ ...options,mode: 'sync-history',approval: planDigest(commit,baseline,project) })
  assert.deepEqual(events,['preflight','verify:2','verify:2'])
})

test('schema mismatch prevents history repair and production deployment', async () => {
  for (const mode of ['sync-history','deploy']) {
    const { options, events } = harness({ remote: mode === 'sync-history' ? [] : versions, fail: 'verify' })
    await assert.rejects(() => release({ ...options,mode,approval: planDigest(commit,baseline,project) }),/structure mismatch/)
    assert.ok(!events.includes('repair') && !events.includes('push') && !events.includes('deploy'))
  }
})

test('migration failure stops production deployment; success verifies history and structure first', async () => {
  for (const fail of ['preflight','dry-run','push']) {
    const { options, events } = harness({ pending: [addition],fail })
    await assert.rejects(() => release(options))
    assert.ok(!events.includes('deploy'))
  }
  const { options, events } = harness({ pending: [addition] })
  await release(options)
  assert.deepEqual(events,['preflight','verify:2','dry-run','push','verify:3','preflight','deploy'])
})

test('post-migration history/schema mismatch and a changed deployment preflight prevent website publication', async () => {
  const missing = harness({ pending: [addition] })
  await assert.rejects(() => release({ ...missing.options,remoteHistory: async () => versions }),/Migration history/)
  assert.ok(!missing.events.includes('deploy'))
  const changed = harness({ pending: [addition] })
  let verificationCount = 0
  await assert.rejects(() => release({ ...changed.options,verify: async () => { if (++verificationCount === 2) throw new Error('after migration mismatch') } }),/after migration/)
  assert.ok(!changed.events.includes('deploy'))
  const race = harness({ pending: [addition] })
  let preflightCount = 0
  await assert.rejects(() => release({ ...race.options,preflight: async () => { if (++preflightCount === 2) throw new Error('Git reconnected') } }),/Git reconnected/)
  assert.ok(!race.events.includes('deploy'))
})

test('already-applied migrations are skipped, so retrying a website deployment never reruns SQL', async () => {
  const { options, events } = harness()
  await release(options)
  assert.deepEqual(events,['preflight','verify:2','verify:2','preflight','deploy'])
})

test('destructive migration needs another exact-plan approval; resets remain forbidden', async () => {
  const { options, events } = harness({ pending: [risky] })
  await assert.rejects(() => release(options),/additional review/)
  assert.ok(!events.includes('push'))
  await assert.rejects(() => release({ ...options, mode: 'deploy-reviewed', approval: planDigest('b'.repeat(40),[risky],project) }),/additional review/)
  await release({ ...options,mode: 'deploy-reviewed',approval: planDigest(commit,[risky],project) })
  assert.ok(events.includes('push') && events.includes('deploy'))
  const reset = { ...risky, sql: 'drop schema public cascade;' }
  const blocked = harness({ pending: [reset] })
  await assert.rejects(() => release({ ...blocked.options,mode: 'deploy-reviewed',approval: planDigest(commit,[reset],project) }),/forbidden/)
  assert.ok(!blocked.events.includes('push'))
})

test('production rejects PR events, non-main branches and stale manual commit confirmations', () => {
  const env = { GITHUB_REF: 'refs/heads/main',GITHUB_EVENT_NAME: 'push',AUTOMATION_ENABLED: 'true',GITHUB_SHA: commit }
  validateContext(env,'deploy')
  for (const patch of [{ GITHUB_REF: 'refs/heads/feature' },{ GITHUB_EVENT_NAME: 'pull_request' },{ AUTOMATION_ENABLED: 'false' }]) assert.throws(() => validateContext({ ...env,...patch },'deploy'))
  assert.throws(() => validateContext({ ...env,GITHUB_EVENT_NAME: 'workflow_dispatch',EXPECTED_COMMIT: 'wrong' },'sync-history'))
  validateContext({ ...env,GITHUB_EVENT_NAME: 'workflow_dispatch',EXPECTED_COMMIT: commit },'sync-history')
})

test('connection targets project/session pooler and always verifies certificates', () => {
  const env = { SUPABASE_PROJECT_REF: project,SUPABASE_DB_URL: `postgres://postgres:test@db.${project}.supabase.co:5432/postgres?sslmode=disable` }
  const config = databaseConfig(env)
  assert.equal(config.ssl.rejectUnauthorized,true)
  assert.ok(!config.connectionString.includes('sslmode'))
  assert.equal(databaseConfig({ ...env,SUPABASE_DB_URL: `postgres://postgres.${project}:test@aws-0-region.pooler.supabase.com:5432/postgres` }).ssl.rejectUnauthorized,true)
  for (const url of [`postgres://postgres:test@db.${'b'.repeat(20)}.supabase.co/postgres`,`postgres://postgres.${project}:test@aws-0-region.pooler.supabase.com:6543/postgres`,'postgres://postgres:test@localhost/postgres']) assert.throws(() => databaseConfig({ ...env,SUPABASE_DB_URL: url }))
})

test('Git integration must be disconnected and Vercel project/team IDs must match', () => {
  const env = { VERCEL_PROJECT_ID: 'project',VERCEL_ORG_ID: 'team' }
  assertVercelProject({ id: 'project',accountId: 'team' },env)
  assert.throws(() => assertVercelProject({ id: 'project',accountId: 'team',link: { type: 'github' } },env),/Disconnect/)
  assert.throws(() => assertVercelProject({ id: 'other',accountId: 'team' },env),/does not match/)
  assertNoActiveDeployments({ deployments: [] })
  assert.throws(() => assertNoActiveDeployments({ deployments: [{ state: 'BUILDING' }] }),/unfinished/)
  assert.throws(() => assertNoActiveDeployments({}),/invalid/)
})

test('Vercel Build Output contains only compiled static files, SPA routes and project metadata', () => {
  const directory = mkdtempSync(join(tmpdir(),'card-research-static-'))
  try {
    mkdirSync(join(directory,'dist/assets'),{ recursive: true })
    writeFileSync(join(directory,'dist/index.html'),'<div>Card Research</div>')
    writeFileSync(join(directory,'dist/assets/app.js'),'compiled')
    writeFileSync(join(directory,'.env.local'),'must not upload')
    prepareOutput({ VERCEL_ORG_ID: 'team',VERCEL_PROJECT_ID: 'project' },directory)
    const output = join(directory,'.vercel/output')
    assert.equal(readFileSync(join(output,'static/index.html'),'utf8'),'<div>Card Research</div>')
    assert.equal(existsSync(join(output,'static/.env.local')),false)
    assert.deepEqual(JSON.parse(readFileSync(join(output,'config.json'),'utf8')),{ version: 3,routes: [{ handle: 'filesystem' },{ src: '/((?!assets/).*)',dest: '/index.html' }] })
    writeFileSync(join(output,'static/stale.js'),'old')
    prepareOutput({ VERCEL_ORG_ID: 'team',VERCEL_PROJECT_ID: 'project' },directory)
    assert.equal(existsSync(join(output,'static/stale.js')),false)
  } finally { rmSync(directory,{ recursive: true,force: true }) }
})

test('production build accepts only public keys for the expected Supabase project', () => {
  const env = { SUPABASE_PROJECT_REF: project,VITE_SUPABASE_URL: `https://${project}.supabase.co`,VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' }
  validateFrontend(env)
  assert.throws(() => validateFrontend({ ...env,VITE_SUPABASE_URL: 'https://other.supabase.co' }))
  assert.throws(() => validateFrontend({ ...env,VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_test' }))
  const jwt = role => `header.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.signature`
  validateFrontend({ ...env,VITE_SUPABASE_PUBLISHABLE_KEY: jwt('anon') })
  assert.throws(() => validateFrontend({ ...env,VITE_SUPABASE_PUBLISHABLE_KEY: jwt('service_role') }))
})

test('workflows separate unprivileged PR checks from serialized main-only production', () => {
  const checks = parse(readFileSync('.github/workflows/checks.yml','utf8'))
  const production = parse(readFileSync('.github/workflows/production.yml','utf8'))
  assert.ok(checks.on.pull_request && 'workflow_call' in checks.on)
  assert.equal(checks.on.pull_request_target,undefined)
  assert.ok(!readFileSync('.github/workflows/checks.yml','utf8').includes('secrets.'))
  assert.deepEqual(production.on.push.branches,['main'])
  assert.equal(production.concurrency['cancel-in-progress'],false)
  assert.equal(production.jobs.production.environment,'production')
  assert.deepEqual(production.jobs.production.needs,['checks','reviewed-migrations'])
  assert.equal(production.jobs['reviewed-migrations'].environment,'production-migration-review')
  assert.ok(production.jobs.production.if.includes("refs/heads/main"))
  assert.ok(production.jobs.production.if.includes('!cancelled()'))
  assert.equal(production.permissions.contents,'read')
  for (const workflow of [checks,production]) for (const job of Object.values(workflow.jobs)) for (const step of job.steps ?? []) if (step.uses) assert.match(step.uses,/@[a-f0-9]{40}$/)
  assert.equal(JSON.parse(readFileSync('vercel.json','utf8')).git.deploymentEnabled,false)
})

test('reference catalog covers RLS, privileges and exact function/trigger bodies, and detects drift', async () => {
  const expected = await expectedCatalog(baseline)
  assert.equal(expected.tables.length,9)
  assert.ok(expected.tables.every(table => table.relrowsecurity))
  assert.equal(expected.functions.length,3)
  assert.equal(expected.triggers.length,2)
  assert.equal(expected.privateSchemaGrants.length,0)
  assert.ok(expected.tableGrants.every(grant => grant.role === 'authenticated' && grant.privilege_type === 'SELECT'))
  assertCatalog(expected,structuredClone(expected))
  for (const key of ['columns','constraints','indexes','policies','triggers','tableGrants','functions','functionGrants']) {
    const changed = structuredClone(expected); changed[key] = []
    assert.throws(() => assertCatalog(expected,changed),new RegExp(key))
  }
})
