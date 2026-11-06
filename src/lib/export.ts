import { effectiveOrders } from './sequences'
import { rarityLabels, sideLabels, type DataSet } from './types'

// Quote every cell and neutralize spreadsheet formulas, preserving raw text in JSON.
function csvCell(value: unknown): string {
  let text = value == null ? '' : String(value)
  if (/^[\s\uFEFF]*[=+@\-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}
export function exportJson(data: DataSet): string {
  return JSON.stringify({ schema_version: 1, exported_at: new Date().toISOString(), ...data }, null, 2)
}
export function exportCsv(data: DataSet): string {
  const header = ['store', 'machine', 'game_version', 'segment_id', 'segment', 'game', 'draw_id', 'original_draw_index', 'effective_display_index', 'side', 'effective_side_display_index', 'cartridge_id', 'cartridge_batch', 'batch_certainty', 'recorded_side', 'recorded_cartridge_id', 'recorded_cartridge_batch', 'original_side_index', 'card_number', 'rarity', 'recorded_at', 'deleted_at', 'revision']
  const rows: unknown[][] = [header]
  for (const segment of data.observation_segments) {
    const machine = data.machines.find(m => m.id === segment.machine_id)
    const store = data.stores.find(s => s.id === machine?.store_id)
    const draws = data.draws.filter(d => d.segment_id === segment.id).sort((a, b) => a.draw_index - b.draw_index)
    const orders = effectiveOrders(draws)
    for (const d of draws) {
      const cartridge = data.cartridges.find(c => c.id === d.cartridge_id)
      const recordedCartridge = data.cartridges.find(c => c.id === d.recorded_cartridge_id)
      rows.push([store?.name, machine?.machine_name, segment.game_version, segment.id, segment.label,
        data.games.find(g => g.id === d.game_id)?.game_index, d.id, d.draw_index, orders.overall.get(d.id), sideLabels[d.side], orders.side.get(d.id),
        d.cartridge_id, cartridge?.batch_index, cartridge?.certainty, sideLabels[d.recorded_side], d.recorded_cartridge_id, recordedCartridge?.batch_index, d.side_index,
        d.card_number, rarityLabels[d.rarity], d.recorded_at, d.deleted_at, d.revision])
    }
  }
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n')
}
export function downloadFile(content: string, fileName: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }))
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = fileName; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
