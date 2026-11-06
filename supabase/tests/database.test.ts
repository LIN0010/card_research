import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'

const USER_A = '00000000-0000-4000-8000-000000000001'
const USER_B = '00000000-0000-4000-8000-000000000002'
let db: PGlite
async function user(id = USER_A) { await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]) }
async function command(action: string, payload: object, operationId = randomUUID()) {
  const result = await db.query<{ value: Record<string, any> }>('select public.apply_command($1::uuid, $2, $3::jsonb) as value', [operationId, action, JSON.stringify(payload)])
  return result.rows[0].value
}
async function fixture(name = '店內左台') {
  const store = await command('create_store', { name: '測試店家', location: '台北' })
  const machine = await command('create_machine', { store_id: store.id, machine_name: name, game_version: 'AP6' })
  const segment = await command('create_segment', { machine_id: machine.id, label: '連續觀測' })
  const games = await db.query<{ id: string }>('select id from public.games where segment_id = $1', [segment.id])
  return { store, machine, segment, game: games.rows[0] }
}
async function append(segment: string, game: string, side: string, card: string, rarity = 'normal', op = randomUUID(), id = randomUUID()) {
  return command('append_draw', { id, segment_id: segment, game_id: game, side, card_number: card, rarity }, op)
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, public to anon, authenticated;
    insert into auth.users values ('${USER_A}'), ('${USER_B}');
  `)
  await db.exec(readFileSync(new URL('../migrations/202611060001_mvp.sql', import.meta.url), 'utf8'))
})
beforeEach(async () => {
  await db.exec('reset role; truncate public.stores, public.machines, public.observation_segments, public.games, public.cartridges, public.draws, public.audit_events, app_private.operations cascade; set role authenticated;')
  await user()
})
afterAll(async () => { await db.close() })

describe('actual PostgreSQL migration and online commands (local PGlite)', () => {
  it('preserves the supplied A/B sequences across games while isolating machines', async () => {
    const a = await fixture('店內左台')
    const b = await fixture('店內右台')
    for (const card of ['049', '022', '14P']) await append(a.segment.id, a.game.id, 'left', card, card === '14P' ? 'signature' : 'normal')
    const a2 = await command('start_game', { segment_id: a.segment.id })
    await append(a.segment.id, a2.id, 'right', '001', 'four_star')
    for (const [side, card] of [['left', '050'], ['right', '046'], ['right', '034'], ['left', '030'], ['right', '049']]) await append(b.segment.id, b.game.id, side, card)
    const b2 = await command('start_game', { segment_id: b.segment.id })
    for (const card of ['033', '016', '035']) await append(b.segment.id, b2.id, 'right', card, card === '016' ? 'four_star' : 'normal')
    const aRows = (await db.query<any>('select * from public.draws where segment_id = $1 order by draw_index', [a.segment.id])).rows
    const bRows = (await db.query<any>('select * from public.draws where segment_id = $1 order by draw_index', [b.segment.id])).rows
    expect(aRows.map(d => d.card_number)).toEqual(['049', '022', '14P', '001'])
    expect(aRows.map(d => d.draw_index)).toEqual([1, 2, 3, 4])
    expect(aRows.filter(d => d.side === 'left').map(d => d.side_index)).toEqual([1, 2, 3])
    expect(aRows.at(-1)).toMatchObject({ game_id: a2.id, side_index: 1, rarity: 'four_star' })
    expect(bRows.map(d => d.card_number)).toEqual(['050', '046', '034', '030', '049', '033', '016', '035'])
    expect(bRows.map(d => d.draw_index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(bRows.filter(d => d.side === 'left').map(d => [d.card_number, d.side_index])).toEqual([['050', 1], ['030', 2]])
    expect(bRows.filter(d => d.side === 'right').map(d => [d.card_number, d.side_index])).toEqual([['046', 1], ['034', 2], ['049', 3], ['033', 4], ['016', 5], ['035', 6]])
    expect(bRows.filter(d => d.game_id === b2.id).map(d => d.draw_index)).toEqual([6, 7, 8])
    // A fresh read models reload/relogin: no process-local store is used for business data.
    await user(USER_B)
    expect((await db.query('select * from public.draws')).rows).toHaveLength(0)
    await user(USER_A)
    expect((await db.query('select * from public.draws')).rows).toHaveLength(12)
  })
  it('makes retries idempotent and rejects reused operation IDs with different content', async () => {
    const f = await fixture(); const op = randomUUID(); const id = randomUUID()
    const first = await append(f.segment.id, f.game.id, 'left', 'AP6-049', 'normal', op, id)
    expect(await append(f.segment.id, f.game.id, 'left', 'AP6-049', 'normal', op, id)).toEqual(first)
    expect((await db.query('select * from public.draws')).rows).toHaveLength(1)
    await expect(append(f.segment.id, f.game.id, 'left', 'AP6-022', 'normal', op, id)).rejects.toThrow('不同內容')
  })
  it('retains raw indices, original source and full audit snapshots after corrections and undo', async () => {
    const f = await fixture()
    const d = await append(f.segment.id, f.game.id, 'left', 'AP6-14P', 'signature')
    const edited = await command('update_draw', { segment_id: f.segment.id, id: d.id, revision: d.revision, side: 'right', card_number: 'A06-001', rarity: 'four_star' })
    expect(edited).toMatchObject({ draw_index: 1, side_index: 1, recorded_side: 'left', side: 'right', revision: 2 })
    const op = randomUUID(); const payload = { segment_id: f.segment.id, id: d.id, revision: 2 }
    const deleted = await command('void_draw', payload, op)
    expect(deleted.deleted_at).toBeTruthy()
    expect(await command('void_draw', payload, op)).toEqual(deleted)
    const next = await append(f.segment.id, f.game.id, 'left', '022')
    expect(next).toMatchObject({ draw_index: 2, side_index: 2 })
    const events = (await db.query<any>('select * from public.audit_events where entity_id = $1 order by created_at', [d.id])).rows
    expect(events.map(e => e.action)).toEqual(['append_draw', 'update_draw', 'void_draw'])
    expect(events[1].old_data.card_number).toBe('AP6-14P')
    expect(events[1].new_data.card_number).toBe('A06-001')
    expect(events[2].new_data.draw_index).toBe(1)
  })
  it('creates a distinct uncertain cartridge batch without joining its sequence', async () => {
    const f = await fixture()
    const first = await append(f.segment.id, f.game.id, 'left', '049')
    await command('replace_cartridge', { segment_id: f.segment.id, side: 'left', certainty: 'uncertain', note: '離開機台後無法確認' })
    const second = await append(f.segment.id, f.game.id, 'left', '022')
    expect(second.cartridge_id).not.toBe(first.cartridge_id)
    expect(second).toMatchObject({ draw_index: 2, side_index: 1 })
    expect((await db.query<any>('select * from public.cartridges where id = $1', [second.cartridge_id])).rows[0].certainty).toBe('uncertain')
  })
  it('keeps unknown sources unassigned and stores card number text verbatim', async () => {
    const f = await fixture()
    for (const card of ['AP6-049', 'A06-001', 'AP6-14P', ' 049 ']) {
      const d = await append(f.segment.id, f.game.id, 'unknown', card, 'unknown')
      expect(d).toMatchObject({ card_number: card, side_index: null, cartridge_id: null, recorded_side: 'unknown' })
    }
    const d = await append(f.segment.id, f.game.id, 'left', 'AP6-14P', 'normal')
    expect(d.rarity).toBe('normal') // P is a UI hint, not a database assumption.
  })
  it('denies other users, anonymous calls, direct writes and private operation access', async () => {
    const f = await fixture()
    await user(USER_B)
    expect((await db.query('select * from public.stores')).rows).toEqual([])
    await expect(command('create_machine', { store_id: f.store.id, machine_name: '侵入', game_version: 'AP6' })).rejects.toThrow()
    await expect(command('start_game', { segment_id: f.segment.id })).rejects.toThrow('沒有權限')
    await expect(db.query("insert into public.stores(name) values('直接寫入')")).rejects.toThrow('permission denied')
    await expect(db.query('select * from app_private.operations')).rejects.toThrow('permission denied')
    await db.exec('set role anon')
    await expect(db.query('select * from public.draws')).rejects.toThrow('permission denied')
    await expect(command('start_game', { segment_id: f.segment.id })).rejects.toThrow('permission denied')
  })
  it('rejects invalid data atomically and does not consume an index', async () => {
    const f = await fixture()
    await expect(append(f.segment.id, f.game.id, 'left', '   ')).rejects.toThrow()
    await expect(append(f.segment.id, f.game.id, 'left', '049', 'impossible')).rejects.toThrow()
    const d = await append(f.segment.id, f.game.id, 'left', '049')
    expect(d.draw_index).toBe(1)
    expect((await db.query('select * from public.draws')).rows).toHaveLength(1)
  })
  it('rejects stale games, mismatched machines/segments and stale edits', async () => {
    const f = await fixture(); const other = await fixture('不同機台')
    await expect(append(f.segment.id, other.game.id, 'left', '049')).rejects.toThrow('局數已改變')
    const d = await append(f.segment.id, f.game.id, 'left', '049')
    await command('update_draw', { segment_id: f.segment.id, id: d.id, revision: 1, side: 'unknown', card_number: '049', rarity: 'unknown' })
    await expect(command('void_draw', { segment_id: f.segment.id, id: d.id, revision: 1 })).rejects.toThrow('已更新')
    await command('start_game', { segment_id: f.segment.id })
    await expect(append(f.segment.id, f.game.id, 'left', '022')).rejects.toThrow('局數已改變')
  })
  it('blocks appending to closed observations and starts a separate sequence for a new segment', async () => {
    const f = await fixture()
    const d = await append(f.segment.id, f.game.id, 'left', '049')
    await command('close_segment', { segment_id: f.segment.id })
    await expect(append(f.segment.id, f.game.id, 'left', '022')).rejects.toThrow('已結束')
    await command('void_draw', { segment_id: f.segment.id, id: d.id, revision: 1 })
    const next = await command('create_segment', { machine_id: f.machine.id, label: '重新觀測' })
    const game = (await db.query<any>('select * from public.games where segment_id = $1', [next.id])).rows[0]
    expect((await append(next.id, game.id, 'left', '022')).draw_index).toBe(1)
  })
  it('snapshots the observed game version instead of relabeling history after a machine update', async () => {
    const f = await fixture()
    await command('update_machine', { id: f.machine.id, machine_name: '店內左台', game_version: 'A06' })
    const later = await command('create_segment', { machine_id: f.machine.id, label: '版本更新後' })
    expect(later.game_version).toBe('A06')
    const old = (await db.query<any>('select * from public.observation_segments where id = $1', [f.segment.id])).rows[0]
    expect(old.game_version).toBe('AP6')
  })
  it('enforces raw order uniqueness and segment/game integrity even below the RPC layer', async () => {
    const f = await fixture(); const other = await fixture('另一台')
    await append(f.segment.id, f.game.id, 'unknown', '049')
    await db.exec('reset role')
    try {
      const sql = `insert into public.draws(owner_id, segment_id, game_id, draw_index, side, recorded_side, card_number, rarity)
        values($1,$2,$3,$4,'unknown','unknown','022','normal')`
      await expect(db.query(sql, [USER_A, f.segment.id, f.game.id, 1])).rejects.toThrow('unique constraint')
      await expect(db.query(sql, [USER_A, f.segment.id, other.game.id, 2])).rejects.toThrow('foreign key constraint')
    } finally { await db.exec('set role authenticated') }
  })
})
