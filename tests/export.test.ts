import { describe, expect, it } from 'vitest'
import { exportCsv, exportJson } from '../src/lib/export'
import { missingDrawRanges, orderedDraws } from '../src/lib/sequences'
import { emptyData, type Draw } from '../src/lib/types'

function fixture() {
  const data = emptyData()
  data.stores.push({ id: 'store', owner_id: 'user', created_at: '', name: '=HYPERLINK("bad")', location: '' })
  data.machines.push({ id: 'machine', owner_id: 'user', created_at: '', store_id: 'store', machine_name: '店內左台', game_version: 'AP6' })
  data.observation_segments.push({ id: 'segment', owner_id: 'user', created_at: '', machine_id: 'machine', game_version: 'AP6', label: '觀測', notes: '', started_at: '', ended_at: null, last_draw_index: 4 })
  data.games.push({ id: 'game', owner_id: 'user', created_at: '', segment_id: 'segment', game_index: 1, started_at: '', ended_at: null })
  data.draws = [1, 2, 3].map(index => ({ id: `d${index}`, owner_id: 'user', created_at: '', segment_id: 'segment', game_id: 'game', draw_index: index,
    side: 'left', recorded_side: 'left', cartridge_id: null, recorded_cartridge_id: null, side_index: index, card_number: index === 3 ? null : '049', card_number_unknown: index === 3,
    rarity: 'normal', recorded_at: '', updated_at: '', revision: 1, deleted_at: index === 2 ? '2026-11-06T00:00:00Z' : null })) as Draw[]
  data.audit_events.push({ id: 'old', owner_id: 'user', created_at: '', operation_id: 'op', entity_type: 'draws', entity_id: 'd2', action: 'void_draw', old_data: null, new_data: { card_number: 'PRIVATE-OLD' } })
  return data
}
describe('original positions and export privacy', () => {
  it('identifies middle and trailing gaps without compressing or mixing segments', () => {
    const data = fixture()
    expect(missingDrawRanges(data.draws, 'segment', 4)).toEqual([{ from: 2, to: 2 }, { from: 4, to: 4 }])
    expect(data.draws.map(d => d.draw_index)).toEqual([1, 2, 3])
    expect(orderedDraws([...data.draws, { ...data.draws[0], id: 'other', segment_id: 'other' }], 'segment')).toHaveLength(3)
    expect(missingDrawRanges([], 'segment', 3)).toEqual([{ from: 1, to: 3 }])
  })
  it('exports unknown positions and raw indices without legacy rows or orphaned draw audits', () => {
    const data = fixture()
    const csv = exportCsv(data)
    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(csv.split('\r\n')).toHaveLength(3)
    expect(csv).toContain(`"'=HYPERLINK(""bad"")"`)
    expect(csv).toContain('"sequence_gap_before"')
    expect(csv).toContain('"card_number_unknown"')
    expect(csv).not.toContain('2026-11-06T00:00:00Z')
    const json = JSON.parse(exportJson(data))
    expect(json.schema_version).toBe(2)
    expect(json.draws.map((d: Draw) => d.draw_index)).toEqual([1, 3])
    expect(json.draws[1]).toMatchObject({ card_number: null, card_number_unknown: true })
    expect(json.audit_events).toHaveLength(0)
    expect(JSON.stringify(json)).not.toContain('PRIVATE-OLD')
    expect(json.stores[0].name).toBe('=HYPERLINK("bad")')
  })
})
