import type { Cartridge, Draw, Rarity, Side } from './types'

export function suggestRarity(cardNumber: string): Rarity {
  return /p\s*$/i.test(cardNumber) ? 'signature' : 'normal'
}
export function orderedDraws(draws: Draw[], segmentId: string): Draw[] {
  return draws.filter(d => d.segment_id === segmentId).sort((a, b) => a.draw_index - b.draw_index)
}
export function activeCartridge(cartridges: Cartridge[], segmentId: string, side: 'left' | 'right') {
  return cartridges.filter(c => c.segment_id === segmentId && c.side === side).sort((a, b) => b.batch_index - a.batch_index)[0]
}

export function cardLabel(draw: Pick<Draw, 'card_number' | 'card_number_unknown'>): string {
  return draw.card_number_unknown || draw.card_number === null ? '卡號未知' : draw.card_number
}
export interface DrawGap { from: number; to: number }
export function missingDrawRanges(draws: Draw[], segmentId: string, lastIndex: number): DrawGap[] {
  const gaps: DrawGap[] = []
  let next = 1
  for (const draw of orderedDraws(draws, segmentId).filter(draw => !draw.deleted_at)) {
    if (draw.draw_index > next) gaps.push({ from: next, to: draw.draw_index - 1 })
    next = Math.max(next, draw.draw_index + 1)
  }
  if (next <= lastIndex) gaps.push({ from: next, to: lastIndex })
  return gaps
}
