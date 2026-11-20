import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'

const A = '00000000-0000-4000-8000-000000000001'
const B = '00000000-0000-4000-8000-000000000002'
let db: PGlite
const upgradeSql = readFileSync(new URL('../migrations/202611210001_permanent_delete_unknown_cards.sql', import.meta.url), 'utf8')
async function setUser(id = A) { await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]) }
async function command(action: string, payload: object, op = randomUUID()) {
  return (await db.query<{ value: Record<string, any> }>('select public.apply_command($1::uuid,$2,$3::jsonb) as value', [op, action, JSON.stringify(payload)])).rows[0].value
}
async function fixture() {
  const store = await command('create_store', { name: '新店家' })
  const machine = await command('create_machine', { store_id: store.id, machine_name: '左台', game_version: 'AP6' })
  const segment = await command('create_segment', { machine_id: machine.id, label: '連續紀錄' })
  const game = (await db.query<{ id: string }>('select id from public.games where segment_id=$1', [segment.id])).rows[0]
  return { store, machine, segment, game }
}
async function append(f: Awaited<ReturnType<typeof fixture>>, values: object = {}, op = randomUUID()) {
  const payload = { id: randomUUID(), segment_id: f.segment.id, game_id: f.game.id, side: 'left', card_number: 'AP6-049', rarity: 'normal', ...values }
  return { row: await command('append_draw', payload, op), payload, op }
}
async function remove(row: Record<string, any>, op = randomUUID()) {
  return command('delete_draw', { id: row.id, segment_id: row.segment_id, revision: row.revision, confirmed: true }, op)
}
async function admin<T>(read: () => Promise<T>): Promise<T> {
  await db.exec('reset role')
  try { return await read() } finally { await db.exec('set role authenticated') }
}
beforeAll(async () => {
  db = new PGlite()
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public, auth to authenticated, anon;
    insert into auth.users values('${A}'),('${B}');`)
  await db.exec(readFileSync(new URL('../migrations/202611060001_mvp.sql', import.meta.url), 'utf8'))
  // Upgrade an existing project: preserve a live row and an old soft-deleted row.
  await setUser()
  const f = await fixture()
  const active = await append(f)
  const legacy = await append(f, { card_number: 'OLD-SECRET' })
  await command('void_draw', { segment_id: f.segment.id, id: legacy.row.id, revision: 1 })
  await db.exec(upgradeSql)
  expect((await db.query('select * from public.draws')).rows).toHaveLength(2)
  expect((await db.query<any>('select * from public.draws where id=$1', [active.row.id])).rows[0].card_number).toBe('AP6-049')
  expect((await db.query<any>('select * from public.draws where id=$1', [legacy.row.id])).rows[0].deleted_at).toBeTruthy()
  expect((await db.query<any>('select * from public.cartridges where id=$1', [legacy.row.recorded_cartridge_id])).rows[0].last_side_index).toBe(2)
  expect(await command('append_draw', active.payload, active.op)).toEqual(active.row)
  await command('purge_legacy_voids', { confirmed: true, expected_count: 1 })
  expect(JSON.stringify((await db.query('select request,result from app_private.operations')).rows)).not.toContain('OLD-SECRET')
  expect(await command('append_draw', legacy.payload, legacy.op)).toEqual({ id: legacy.row.id, deleted: true })
})
beforeEach(async () => {
  await db.exec('reset role; truncate public.stores, public.machines, public.observation_segments, public.games, public.cartridges, public.draws, public.audit_events, app_private.operations, app_private.deleted_draw_ids cascade; set role authenticated;')
  await setUser()
})
afterAll(async () => { await db.close() })

it('hard-deletes a draw, all of its audit snapshots and cached copies, without deleting other records', async () => {
  const f = await fixture()
  const deleted = await append(f, { card_number: 'PRIVATE-OLD' })
  const edited = await command('update_draw', { id: deleted.row.id, segment_id: f.segment.id, revision: 1, side: 'right', card_number: 'PRIVATE-NEW', rarity: 'signature' })
  const kept = await append(f, { card_number: 'KEEP-ME' })
  await remove(edited)
  expect((await db.query('select * from public.draws where id=$1', [deleted.row.id])).rows).toHaveLength(0)
  expect((await db.query('select * from public.audit_events where entity_id=$1', [deleted.row.id])).rows).toHaveLength(0)
  expect((await db.query('select * from public.draws where id=$1', [kept.row.id])).rows).toHaveLength(1)
  await admin(async () => {
    const logs = (await db.query<any>('select request,result from app_private.operations')).rows
    expect(JSON.stringify(logs)).not.toContain('PRIVATE-OLD')
    expect(JSON.stringify(logs)).not.toContain('PRIVATE-NEW')
    expect(JSON.stringify(logs)).toContain('KEEP-ME')
    const tombstone = (await db.query<any>('select * from app_private.deleted_draw_ids where id=$1', [deleted.row.id])).rows[0]
    expect(Object.keys(tombstone).sort()).toEqual(['id', 'owner_id'])
  })
})
it('prevents stale retries and new operation IDs from restoring deleted card data', async () => {
  const f = await fixture()
  const original = await append(f)
  const deleteOp = randomUUID()
  expect(await remove(original.row, deleteOp)).toEqual({ id: original.row.id, deleted: true })
  expect(await remove(original.row, deleteOp)).toEqual({ id: original.row.id, deleted: true })
  expect(await command('append_draw', original.payload, original.op)).toEqual({ id: original.row.id, deleted: true })
  await expect(command('append_draw', original.payload)).rejects.toThrow('不可重用')
  await admin(async () => {
    await expect(db.query('insert into public.draws select * from jsonb_populate_record(null::public.draws,$1::jsonb)', [JSON.stringify(original.row)])).rejects.toThrow('不可重用')
  })
  await expect(command('append_draw', { ...original.payload, card_number: 'CHANGED' }, original.op)).rejects.toThrow('不同內容')
  expect((await db.query('select * from public.draws')).rows).toHaveLength(0)
})
it('does not consume, recycle or renumber global and original side positions after deleting the last or all draws', async () => {
  const f = await fixture()
  const first = await append(f)
  const second = await append(f, { card_number: '022' })
  await remove(second.row)
  const third = await append(f, { card_number: '030' })
  expect(third.row).toMatchObject({ draw_index: 3, side_index: 3 })
  await remove(first.row); await remove(third.row)
  const fourth = await append(f, { card_number: '034' })
  expect(fourth.row).toMatchObject({ draw_index: 4, side_index: 4 })
  expect((await db.query<any>('select * from public.observation_segments where id=$1', [f.segment.id])).rows[0].last_draw_index).toBe(4)
})
it('requires confirmation and the current revision before deleting, and rejects new soft deletes', async () => {
  const f = await fixture(); const original = await append(f)
  await expect(command('delete_draw', { id: original.row.id, segment_id: f.segment.id, revision: 1 })).rejects.toThrow('確認')
  await expect(command('delete_draw', { id: original.row.id, segment_id: f.segment.id, revision: 0, confirmed: true })).rejects.toThrow('已更新')
  await expect(command('void_draw', { id: original.row.id, segment_id: f.segment.id, revision: 1 })).rejects.toThrow('已停用')
  expect((await db.query('select * from public.draws')).rows).toHaveLength(1)
})
it('keeps unknown card numbers as NULL at an actual draw position and supports later correction', async () => {
  const f = await fixture(); await append(f)
  const unknown = await append(f, { card_number: null, card_number_unknown: true, rarity: 'unknown' })
  const last = await append(f, { card_number: '022' })
  expect(unknown.row).toMatchObject({ card_number: null, card_number_unknown: true, draw_index: 2, side_index: 2 })
  expect(last.row.draw_index).toBe(3)
  const known = await command('update_draw', { id: unknown.row.id, segment_id: f.segment.id, revision: 1, side: 'left', card_number: 'AP6-14P', card_number_unknown: false, rarity: 'signature' })
  expect(known).toMatchObject({ draw_index: 2, side_index: 2, card_number: 'AP6-14P', card_number_unknown: false })
  await expect(append(f, { card_number: null, card_number_unknown: false })).rejects.toThrow()
  await expect(append(f, { card_number: 'CONFLICT', card_number_unknown: true })).rejects.toThrow('請勿同時')
})
it('isolates delete/cleanup/cache access from other users and anonymous callers', async () => {
  const f = await fixture(); const original = await append(f)
  await setUser(B)
  await expect(remove(original.row)).rejects.toThrow('沒有權限')
  await expect(db.query('delete from public.draws')).rejects.toThrow('permission denied')
  await expect(db.query('select * from app_private.deleted_draw_ids')).rejects.toThrow('permission denied')
  await expect(command('purge_legacy_voids', { confirmed: true, expected_count: 1, owner_id: A })).rejects.toThrow('筆數')
  await db.exec('set role anon')
  await expect(command('purge_legacy_voids', { confirmed: true, expected_count: 0 })).rejects.toThrow('permission denied')
  await db.exec('set role authenticated'); await setUser(A)
  expect((await db.query('select * from public.draws')).rows).toHaveLength(1)
})
it('cleans only confirmed legacy rows for the current owner, with scrubbed caches and preserved counters', async () => {
  const f = await fixture(); const kept = await append(f, { card_number: 'KEEP' })
  const old = await append(f, { card_number: 'LEGACY-PRIVATE' })
  await admin(() => db.query('update public.draws set deleted_at=now() where id=$1', [old.row.id]))
  await setUser(B)
  const other = await fixture(); const otherOld = await append(other, { card_number: 'OTHER-OWNER' })
  await admin(() => db.query('update public.draws set deleted_at=now() where id=$1', [otherOld.row.id]))
  await setUser(A)
  await expect(command('purge_legacy_voids', { expected_count: 1 })).rejects.toThrow('確認')
  await expect(command('purge_legacy_voids', { confirmed: true, expected_count: 2 })).rejects.toThrow('筆數')
  const op = randomUUID(); const payload = { confirmed: true, expected_count: 1 }
  expect(await command('purge_legacy_voids', payload, op)).toMatchObject({ deleted_count: 1 })
  expect(await command('purge_legacy_voids', payload, op)).toMatchObject({ deleted_count: 1 })
  expect((await db.query('select * from public.draws')).rows.map((row: any) => row.id)).toEqual([kept.row.id])
  await admin(async () => {
    expect(JSON.stringify((await db.query('select request,result from app_private.operations where owner_id=$1', [A])).rows)).not.toContain('LEGACY-PRIVATE')
    expect((await db.query('select * from public.draws where id=$1', [otherOld.row.id])).rows).toHaveLength(1)
  })
  expect((await append(f)).row).toMatchObject({ draw_index: 3, side_index: 3 })
})
it('also scrubs application snapshots when a database administrator deletes a draw directly', async () => {
  const f = await fixture(); const original = await append(f, { card_number: 'ADMIN-PRIVATE' })
  await admin(() => db.query('delete from public.draws where id=$1', [original.row.id]))
  await admin(async () => {
    expect(JSON.stringify((await db.query('select request,result from app_private.operations')).rows)).not.toContain('ADMIN-PRIVATE')
    expect((await db.query('select * from public.audit_events where entity_id=$1', [original.row.id])).rows).toHaveLength(0)
  })
})
it('does not erase unrelated records with a shared UUID or the same card text', async () => {
  const f = await fixture()
  const first = await append(f, { id: f.store.id, card_number: 'SAME-NUMBER' })
  const other = await append(f, { card_number: 'SAME-NUMBER' })
  await remove(first.row)
  expect((await db.query('select * from public.audit_events where entity_type=$1 and entity_id=$2', ['stores', f.store.id])).rows).toHaveLength(1)
  expect((await db.query('select * from public.draws where id=$1', [other.row.id])).rows).toHaveLength(1)
  expect((await db.query('select * from public.audit_events where entity_type=$1 and entity_id=$2', ['draws', other.row.id])).rows).toHaveLength(1)
})
it('preserves account deletion cascades without retaining tombstones for deleted accounts', async () => {
  const user = randomUUID()
  await admin(() => db.query('insert into auth.users(id) values($1)', [user]))
  await setUser(user)
  const f = await fixture()
  const first = await append(f)
  await remove(first.row)
  await append(f)
  await admin(async () => {
    await db.query('delete from auth.users where id=$1', [user])
    expect((await db.query('select * from public.draws where owner_id=$1', [user])).rows).toHaveLength(0)
    expect((await db.query('select * from app_private.deleted_draw_ids where owner_id=$1', [user])).rows).toHaveLength(0)
    expect((await db.query('select * from app_private.operations where owner_id=$1', [user])).rows).toHaveLength(0)
  })
  await setUser(A)
})
