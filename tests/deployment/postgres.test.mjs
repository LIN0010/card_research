import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import pg from 'pg'
import { migrations } from '../../scripts/deploy/plan.mjs'
import { catalog, assertCatalog, expectedCatalog, history, readCatalog } from '../../scripts/deploy/catalog.mjs'
import { withLock } from '../../scripts/deploy/production.mjs'
import { collectDiagnostics } from '../../scripts/deploy/function-diagnostics.mjs'

const connection = process.env.CI_DATABASE_URL
if (process.env.REQUIRE_CLI_TESTS === 'true' && !connection) throw new Error('CI_DATABASE_URL is required; never substitute a production URL')

test('real PostgreSQL + Supabase CLI: baseline verification, history-only repair, pending-only push and cross-session lock', { skip: !connection, timeout: 120000 }, async () => {
  const url = new URL(connection)
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname) && url.pathname === '/ci_test','Integration tests accept only the disposable loopback ci_test service')
  url.searchParams.set('sslmode','disable') // disposable local service only; production forces verify-full
  const admin = new pg.Client({ connectionString: connection })
  await admin.connect()
  const name = `ci_deployment_${randomUUID().replaceAll('-','')}`
  const directory = mkdtempSync(join(tmpdir(),'card-research-cli-test-'))
  let db
  let second
  try {
    await admin.query(`create database ${name}`)
    url.pathname = `/${name}`
    db = new pg.Client({ connectionString: url.toString() })
    second = new pg.Client({ connectionString: url.toString() })
    await db.connect(); await second.connect()
    const roles = (await admin.query("select rolname from pg_roles where rolname in ('anon','authenticated')")).rows.map(row => row.rolname)
    for (const role of ['anon','authenticated']) if (!roles.includes(role)) await admin.query(`create role ${role}`)
    await db.query(`create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;`)
    const local = migrations()
    for (const migration of local) await db.query(migration.sql)
    const user = randomUUID()
    await db.query('insert into auth.users values($1)',[user])
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user])
    await db.query("select public.apply_command($1,'create_store',$2::jsonb)",[randomUUID(),JSON.stringify({ name: 'Keep existing data',location: 'Test only' })])
    const before = (await db.query('select * from public.stores')).rows
    const expected = await expectedCatalog(local)
    assertCatalog(expected,await readCatalog(db))
    assert.deepEqual(await history(db),[])
    mkdirSync(join(directory,'supabase'),{ recursive: true })
    cpSync('supabase/config.toml',join(directory,'supabase/config.toml'))
    cpSync('supabase/migrations',join(directory,'supabase/migrations'),{ recursive: true })
    function cli(args) {
      const result = spawnSync('supabase',['--workdir',directory,...args,'--db-url',url.toString(),'--yes'],{ env: { ...process.env, PGSSLMODE: 'disable' },encoding: 'utf8',timeout: 30000 })
      assert.equal(result.status,0,`Local Supabase CLI failed: ${result.error?.message ?? result.stderr}`)
      return result.stdout
    }
    await withLock(db,async () => {
      await assert.rejects(() => withLock(second,async () => {}),/Another production/)
      cli(['migration','repair',...local.map(item => item.version),'--status','applied'])
      assert.deepEqual(await history(db),local.map(item => item.version))
      assertCatalog(expected,await readCatalog(db))
      assert.deepEqual((await db.query('select * from public.stores')).rows,before)
      const next = { version: '299912310001',sql: 'create index ci_draw_rarity_idx on public.draws (rarity);' }
      writeFileSync(join(directory,`supabase/migrations/${next.version}_ci_index.sql`),next.sql)
      cli(['db','push','--dry-run'])
      assert.deepEqual(await history(db),local.map(item => item.version))
      cli(['db','push'])
      assert.deepEqual(await history(db),[...local.map(item => item.version),next.version])
      assertCatalog(await expectedCatalog([...local,next]),await readCatalog(db))
      cli(['db','push']) // already-applied SQL must be skipped, not replayed
      assert.deepEqual((await db.query('select * from public.stores')).rows,before)
      assert.equal((await db.query('select count(*)::int as count from auth.users')).rows[0].count,1)
    })
    await withLock(second,async () => {}) // lock is released on success
    await assert.rejects(() => withLock(db,async () => { throw new Error('simulated failure') }),/simulated failure/)
    await withLock(second,async () => {}) // and on failure
    const current = await readCatalog(db)
    for (const change of ['alter table public.draws disable row level security','grant insert on public.draws to authenticated','drop trigger erase_draw_history on public.draws', "create or replace function public.apply_command(p_operation_id uuid,p_action text,p_payload jsonb) returns jsonb language sql security definer set search_path='' as $$ select '{}'::jsonb $$"]) {
      await db.query('begin')
      try {
        await db.query(change)
        const changed = await catalog(db)
        assert.throws(() => assertCatalog(current,changed),/Database structure/)
      } finally { await db.query('rollback') }
    }
    const diagnostic = await collectDiagnostics(db,expected)
    assert.equal(diagnostic.environment.transaction_read_only,'on')
    assert.equal(diagnostic.exact_functions_match,true)
    assert.equal(diagnostic.exact_function_grants_match,true)
    await assert.rejects(() => db.query("insert into public.stores(name) values('must fail')"),error => error.code === '25006')
    assert.deepEqual((await db.query('select * from public.stores')).rows,before)
  } finally {
    await second?.end(); await db?.end()
    await admin.query(`drop database if exists ${name}`)
    await admin.end()
    rmSync(directory,{ recursive: true,force: true })
  }
})
