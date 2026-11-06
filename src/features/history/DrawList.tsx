import { useState, type FormEvent } from 'react'
import { SourceFields } from '../../components/FormFields'
import { effectiveOrders, orderedDraws } from '../../lib/sequences'
import { rarityLabels, sideLabels, type DataSet, type Draw, type Rarity, type Side } from '../../lib/types'
import type { Mutate } from '../../lib/useCommands'

function DrawEditor({ draw, mutate, busy, onClose }: { draw: Draw; mutate: Mutate; busy: boolean; onClose: () => void }) {
  const [card, setCard] = useState(draw.card_number)
  const [side, setSide] = useState<Side>(draw.side)
  const [rarity, setRarity] = useState<Rarity>(draw.rarity)
  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      await mutate('update_draw', { segment_id: draw.segment_id, id: draw.id, revision: draw.revision, side, card_number: card, rarity })
      onClose()
    } catch { /* Keep the original editing fields visible on rejection. */ }
  }
  return <form onSubmit={submit} className="edit-form"><fieldset disabled={busy}>
    <label>修改卡片編號<input required maxLength={64} value={card} onChange={e => setCard(e.target.value)} /></label>
    <SourceFields side={side} onSide={setSide} rarity={rarity} onRarity={setRarity} />
    <p className="muted">來源修正依原始位置對應當時批次，保留原始側序及操作紀錄。</p>
    <div className="actions"><button className="primary" disabled={!card.trim()}>儲存修改</button><button type="button" onClick={onClose}>取消修改</button></div>
  </fieldset></form>
}
const actionNames: Record<string, string> = { append_draw: '新增出卡', update_draw: '修改出卡', void_draw: '撤銷出卡' }
export function DrawList({ draws, data, mutate, busy, context = false }: { draws: Draw[]; data: DataSet; mutate: Mutate; busy: boolean; context?: boolean }) {
  const [editing, setEditing] = useState<string | null>(null)
  const orderCache = new Map<string, ReturnType<typeof effectiveOrders>>()
  for (const d of draws) if (!orderCache.has(d.segment_id)) orderCache.set(d.segment_id, effectiveOrders(orderedDraws(data.draws, d.segment_id)))
  if (!draws.length) return <p className="empty">尚無符合的紀錄。</p>
  return <ol className="draw-list">{draws.map(d => {
    const orders = orderCache.get(d.segment_id)!
    const game = data.games.find(g => g.id === d.game_id)
    const segment = data.observation_segments.find(s => s.id === d.segment_id)
    const machine = data.machines.find(m => m.id === segment?.machine_id)
    const store = data.stores.find(s => s.id === machine?.store_id)
    const batch = data.cartridges.find(c => c.id === d.cartridge_id)
    const originalBatch = data.cartridges.find(c => c.id === d.recorded_cartridge_id)
    const events = data.audit_events.filter(e => e.entity_id === d.id).sort((a, b) => a.created_at.localeCompare(b.created_at))
    return <li key={d.id} className={`draw-item ${d.deleted_at ? 'voided' : ''}`}>
      {context && <p className="muted">{store?.name}／{machine?.machine_name} · {segment?.label}</p>}
      <div className="flex justify-between gap-2 items-start"><div>
        <span className={`side-tag ${d.side}`}>{sideLabels[d.side]}</span><strong className="card-number">{d.card_number}</strong><span className="rarity">{rarityLabels[d.rarity]}</span>
        <p>原始 #{d.draw_index} · 第 {game?.game_index} 局{d.deleted_at ? ' · 已撤銷' : ` · 有效顯示 #${orders.overall.get(d.id)}／${sideLabels[d.side]} #${orders.side.get(d.id)}`}</p>
        <small>原始側序：{d.side_index == null ? '來源不明' : `${sideLabels[d.recorded_side]}批次 ${originalBatch?.batch_index} #${d.side_index}`}
          {batch && ` · 目前歸屬${sideLabels[d.side]}批次 ${batch.batch_index}（${batch.certainty === 'confirmed' ? '已確認' : '不確定'}）`}</small>
      </div></div>
      <small>{new Date(d.recorded_at).toLocaleString('zh-TW')}</small>
      {!d.deleted_at && <div className="actions mt-2"><button disabled={busy} onClick={() => setEditing(editing === d.id ? null : d.id)}>修改</button>
        <button disabled={busy} onClick={() => { if (window.confirm(`撤銷原始 #${d.draw_index}「${d.card_number}」？原序號與歷史會保留。`)) void mutate('void_draw', { segment_id: d.segment_id, id: d.id, revision: d.revision }).catch(() => {}) }}>撤銷</button></div>}
      {editing === d.id && !d.deleted_at && <DrawEditor key={`${d.id}-${d.revision}`} draw={d} mutate={mutate} busy={busy} onClose={() => setEditing(null)} />}
      <details className="audit"><summary>操作紀錄（{events.length}）</summary><ul>{events.map(e => <li key={e.id}>
        {new Date(e.created_at).toLocaleString('zh-TW')} · {actionNames[e.action] ?? e.action}
        <details><summary>查看前後資料</summary><pre>{JSON.stringify({ before: e.old_data, after: e.new_data }, null, 2)}</pre></details>
      </li>)}</ul></details>
    </li>
  })}</ol>
}
export function SequenceView({ segmentId, data, mutate, busy }: { segmentId: string; data: DataSet; mutate: Mutate; busy: boolean }) {
  const [view, setView] = useState<'timeline' | 'left' | 'right' | 'unknown'>('timeline')
  const draws = orderedDraws(data.draws, segmentId)
  const valid = draws.filter(d => !d.deleted_at)
  const last = valid.at(-1)
  return <section className="panel"><h2>觀測段出卡紀錄</h2>
    <p className="muted">「原始」序號永不重排；「有效顯示」只為閱讀方便，不代表完整連續卡序。換局不重設；換批次的原始側序從 1 起。</p>
    <div className="actions my-3">{(['timeline', 'left', 'right', 'unknown'] as const).map(value => <button aria-pressed={view === value} className={view === value ? 'selected' : ''} key={value} onClick={() => setView(value)}>{value === 'timeline' ? '整體時間順序' : `${sideLabels[value]}側`}</button>)}
      <button disabled={busy || !last} onClick={() => { if (last && window.confirm(`撤銷最後一筆有效紀錄：原始 #${last.draw_index}？`)) void mutate('void_draw', { segment_id: last.segment_id, id: last.id, revision: last.revision }).catch(() => {}) }}>撤銷上一筆</button>
    </div>
    <DrawList draws={view === 'timeline' ? draws : draws.filter(d => d.side === view)} data={data} mutate={mutate} busy={busy} />
  </section>
}
