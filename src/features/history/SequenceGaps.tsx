import { missingDrawRanges } from '../../lib/sequences'
import type { DataSet } from '../../lib/types'

export function SequenceGaps({ data, segmentId }: { data: DataSet; segmentId: string }) {
  const segment = data.observation_segments.find(item => item.id === segmentId)
  const gaps = missingDrawRanges(data.draws, segmentId, segment?.last_draw_index ?? 0)
  if (!gaps.length) return null
  return <p className="sequence-gap-notice" role="note">{segment?.label} · 原始序號缺口：{gaps.map(gap => gap.from === gap.to ? `#${gap.from}` : `#${gap.from}–#${gap.to}`).join('、')}。缺口前後不可視為連續卡序。</p>
}
