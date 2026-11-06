import { describe, expect, it } from 'vitest'
import { exportCsv, exportJson } from '../src/lib/export'
import { effectiveOrders, orderedDraws } from '../src/lib/sequences'
import { emptyData, type Draw } from '../src/lib/types'

function fixture() {
  const data = emptyData()
  data.stores.push({ id: 'store', owner_id: 'user', created_at: '', name: '=HYPERLINK("bad")', location: '' })
  data.machines.push({ id: 'machine', owner_id: 'user', created_at: '', store_id: 'store', machine_name: '店內左台', game_version: 'AP6' })
  data.observation_segments.push({ id: 'segment', owner_id: 'user', created_at: '', machine_id: 'machine', game_version: 'AP6', label: '觀測', notes: '', started_at: '', ended_at: null, last_draw_index: 3 })
  data.games.push({ id: 'game', owner_id: 'user', created_at: '', segment_id: 'segment', game_index: 1, started_at: '', ended_at: null })
  data.draws = [1, 2, 3].map(index => ({ id: `d${index}`, owner_id: 'user', created_at: '', segment_id: 'segment', game_id: 'game', draw_index: index,
    side: 'left', recorded_side: 'left', cartridge_id: null, recorded_cartridge_id: null, side_index: index, card_number: index === 3 ? 'AP6-14P' : '049',
    rarity: 'normal', recorded_at: '', updated_at: '', revision: 1, deleted_at: index === 2 ? '2026-11-06T00:00:00Z' : null })) as Draw[]
  return data
}
describe('exports and reading-only display numbers', () => {
  it('keeps original indices and gives active entries separate display numbers', () => {
    const data = fixture()
    const { overall, side } = effectiveOrders(data.draws)
    expect([...overall.entries()]).toEqual([['d1', 1], ['d3', 2]])
    expect([...side.entries()]).toEqual([['d1', 1], ['d3', 2]])
    expect(data.draws.map(d => d.draw_index)).toEqual([1, 2, 3])
    expect(orderedDraws([...data.draws, { ...data.draws[0], id: 'other', segment_id: 'other' }], 'segment')).toHaveLength(3)
  })
  it('exports deleted rows, escapes spreadsheet formulas, and retains raw text in JSON', () => {
    const data = fixture()
    const csv = exportCsv(data)
    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(csv.split('\r\n')).toHaveLength(4)
    expect(csv).toContain(`"'=HYPERLINK(""bad"")"`)
    expect(csv).toContain('2026-11-06T00:00:00Z')
    const json = JSON.parse(exportJson(data))
    expect(json.schema_version).toBe(1)
    expect(json.draws).toHaveLength(3)
    expect(json.draws[2].card_number).toBe('AP6-14P')
    expect(json.stores[0].name).toBe('=HYPERLINK("bad")')
    expect(json).toHaveProperty('audit_events')
  })
})
