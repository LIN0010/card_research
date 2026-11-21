import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { migrations } from '../../scripts/deploy/plan.mjs'

test('read-only probe proves exact CRLF hashes and inventories the official Studio RLS binding',async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql as $$select null::uuid$$;`)
    for (const migration of migrations()) await db.exec(migration.sql.replaceAll('\n','\r\n'))
    await db.exec(readFileSync('tests/fixtures/supabase-auto-rls.sql','utf8'))
    const probe = async () => (await db.exec(readFileSync('docs/diagnostics/verify-function-format.sql','utf8')))
      .flatMap(result => result.rows).find(row => row.readonly_verification).readonly_verification
    const result = await probe()
    assert.equal(result.transaction_read_only,'on')
    assert.deepEqual(result.source_checks.map(row => [row.raw_bytes,row.lf_bytes]),[[676,664],[300,292],[11708,11519]])
    assert.ok(result.source_checks.every(row => row.raw_matches_exact_crlf_baseline && row.matches_baseline_after_crlf_only && !row.has_lone_cr))
    assert.equal(result.platform_matches_official_studio_after_crlf,true)
    assert.equal(result.platform_search_path_is_pg_catalog,true)
    assert.deepEqual(result.event_trigger_bindings,[{
      evtname: 'ensure_rls',evtevent: 'ddl_command_end',evtenabled: 'O',owner: 'postgres',
      function_schema: 'public',function_name: 'rls_auto_enable',arguments: '',tags: ['CREATE TABLE','CREATE TABLE AS','SELECT INTO'],
    }])
    await db.exec('create table public.rls_scope_public(id integer);create table app_private.rls_scope_private(id integer);')
    const scope = (await db.query("select n.nspname as schema,c.relrowsecurity as enabled from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relname in ('rls_scope_public','rls_scope_private') order by n.nspname")).rows
    assert.deepEqual(scope,[{schema:'app_private',enabled:false},{schema:'public',enabled:true}])
    await db.exec('set role authenticated')
    await assert.rejects(() => db.query('select public.rls_auto_enable()'),error => error.code === '0A000')
    await db.exec('reset role')
    await db.exec("create or replace function public.apply_command(p_operation_id uuid,p_action text,p_payload jsonb) returns jsonb language sql as $$select '{}'::jsonb$$;")
    const changed = (await probe()).source_checks.find(row => row.name === 'apply_command')
    assert.equal(changed.matches_baseline_after_crlf_only,false)
    assert.equal(changed.raw_matches_exact_crlf_baseline,false)
  } finally { await db.close() }
})
