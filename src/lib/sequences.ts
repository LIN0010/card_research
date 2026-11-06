import type { Cartridge, Draw, Rarity, Side } from './types'

export function suggestRarity(cardNumber: string): Rarity {
  return /p\s*$/i.test(cardNumber) ? 'signature' : 'normal'
}
export function orderedDraws(draws: Draw[], segmentId: string): Draw[] {
  return draws.filter(d => d.segment_id === segmentId).sort((a, b) => a.draw_index - b.draw_index)
}
export function effectiveOrders(draws: Draw[]) {
  const overall = new Map<string, number>()
  const side = new Map<string, number>()
  const counts: Record<Side, number> = { left: 0, right: 0, unknown: 0 }
  let count = 0
  for (const d of [...draws].sort((a, b) => a.draw_index - b.draw_index)) {
    if (d.deleted_at) continue
    overall.set(d.id, ++count)
    side.set(d.id, ++counts[d.side])
  }
  return { overall, side }
}
export function activeCartridge(cartridges: Cartridge[], segmentId: string, side: 'left' | 'right') {
  return cartridges.filter(c => c.segment_id === segmentId && c.side === side).sort((a, b) => b.batch_index - a.batch_index)[0]
}
