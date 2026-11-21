import { useState, type FormEvent, type ReactNode } from 'react'
import { SourceFields } from '../../components/FormFields'
import { Icon } from '../../components/Icon'
import { cardLabel, orderedDraws } from '../../lib/sequences'
import { drawAuditHistory } from '../../lib/audit'
import { rarityLabels, sideLabels, type DataSet, type Draw, type Rarity, type Side } from '../../lib/types'
import type { Mutate } from '../../lib/useCommands'
import { SequenceGaps } from './SequenceGaps'
import { storeLabel } from '../../lib/storeLabels'

function DrawEditor({ draw, mutate, busy, onClose }: { draw: Draw; mutate: Mutate; busy: boolean; onClose: () => void }) {
  const [card, setCard] = useState(draw.card_number ?? '')
  const [cardUnknown, setCardUnknown] = useState(draw.card_number_unknown)
  const [side, setSide] = useState<Side>(draw.side)
  const [rarity, setRarity] = useState<Rarity>(draw.rarity)
  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      await mutate('update_draw', { segment_id: draw.segment_id, id: draw.id, revision: draw.revision, side, card_number: cardUnknown ? null : card, card_number_unknown: cardUnknown, rarity })
      onClose()
    } catch { /* Keep the original editing fields visible on rejection. */ }
  }
  return <form onSubmit={submit} className="edit-form"><fieldset disabled={busy}>
    <label>修改卡片編號<input required={!cardUnknown} disabled={cardUnknown} maxLength={64} value={card} onChange={e => setCard(e.target.value)} /></label>
    <label className="inline-check"><input type="checkbox" checked={cardUnknown} onChange={e => setCardUnknown(e.target.checked)} />卡號未知（確實有出卡）</label>
    <SourceFields side={side} onSide={setSide} rarity={rarity} onRarity={setRarity} />
    <p className="muted">來源修正依原始位置對應當時批次，保留原始側序及操作紀錄。</p>
    <div className="actions"><button className="primary" disabled={!cardUnknown && !card.trim()}>儲存修改</button><button type="button" onClick={onClose}>取消修改</button></div>
  </fieldset></form>
}
const actionNames: Record<string, string> = { append_draw: '新增出卡', update_draw: '修改出卡' }
export function DrawList({ draws, data, mutate, busy, context = false, compact = false }: {
  draws: Draw[]; data: DataSet; mutate: Mutate; busy: boolean; context?: boolean; compact?: boolean
}) {
  const [editing, setEditing] = useState<string | null>(null)
  draws = draws.filter(draw => !draw.deleted_at)
  if (!draws.length) return <div className="empty"><Icon name="cards" size={26} /><p>{compact ? '等待下一張小收藏' : '尚無符合的紀錄。'}</p></div>
  return <ol className={`draw-list ${compact ? 'compact-list' : ''}`}>{draws.map(d => {
    const game = data.games.find(g => g.id === d.game_id)
    const segment = data.observation_segments.find(s => s.id === d.segment_id)
    const machine = data.machines.find(m => m.id === segment?.machine_id)
    const store = data.stores.find(s => s.id === machine?.store_id)
    const batch = data.cartridges.find(c => c.id === d.cartridge_id)
    const originalBatch = data.cartridges.find(c => c.id === d.recorded_cartridge_id)
    const events = drawAuditHistory(data.audit_events, d.id)
    const detailCopy = <>
      <p>原始 #{d.draw_index} · 第 {game?.game_index} 局 · 目前來源：{sideLabels[d.side]}</p>
      {d.side !== d.recorded_side && <p className="hint source-correction">來源已修正：{sideLabels[d.recorded_side]} → {sideLabels[d.side]}；清單依修正後來源排列。</p>}
      <small>原始側序：{d.side_index == null ? '來源不明' : `${sideLabels[d.recorded_side]}批次 ${originalBatch?.batch_index} #${d.side_index}`}（僅供稽核）
        {batch && ` · 目前歸屬${sideLabels[d.side]}批次 ${batch.batch_index}（${batch.certainty === 'confirmed' ? '已確認' : '不確定'}）`}</small>
      <small>{new Date(d.recorded_at).toLocaleString('zh-TW')}</small>
    </>
    const audit = <details className="audit"><summary>操作紀錄（{events.length}）</summary><ul>{events.map(e => <li key={e.id}>
      {new Date(e.created_at).toLocaleString('zh-TW')} · {actionNames[e.action] ?? e.action}
      <details><summary>查看前後資料</summary><pre>{JSON.stringify({ before: e.old_data, after: e.new_data }, null, 2)}</pre></details>
    </li>)}</ul></details>
    const actions = <div className="actions"><button disabled={busy} onClick={() => setEditing(editing === d.id ? null : d.id)}>修改</button>
      <button disabled={busy} onClick={() => { if (window.confirm(`確認永久刪除原始 #${d.draw_index}「${cardLabel(d)}」？\n出卡紀錄與專屬操作歷史將永久移除，無法復原；原始序號不會重排。`)) void mutate('delete_draw', { segment_id: d.segment_id, id: d.id, revision: d.revision, confirmed: true }).catch(() => {}) }}>刪除</button></div>
    const editor = editing === d.id && <DrawEditor key={`${d.id}-${d.revision}`} draw={d} mutate={mutate} busy={busy} onClose={() => setEditing(null)} />
    const displayOrder = d.draw_index
    return <li key={d.id} className={`draw-item ${compact ? 'compact-draw' : ''}`} data-side={d.side} data-draw-id={d.id}>
      {context && <p className="muted history-context">{storeLabel(store)}／{machine?.machine_name} · {segment?.game_version ?? machine?.game_version} · {segment?.label}</p>}
      {compact ? <>
        <div className="card-face"><span className="sequence-no" aria-label={`原始序號 ${displayOrder}`}>{String(displayOrder).padStart(2, '0')}</span>
          <div className="card-summary"><strong className="card-number">{cardLabel(d)}</strong><span className={`rarity rarity-${d.rarity}`}>{d.rarity !== 'unknown' && <Icon name="star" size={11} />}{rarityLabels[d.rarity]}</span></div>
          <details className="card-menu"><summary aria-label={`卡片 ${cardLabel(d)} 的更多操作`} title="更多操作"><Icon name="more" size={20} /></summary>
            <div className="card-menu-content">{actions}{editor}<details className="draw-details"><summary>詳細資料</summary>{detailCopy}{audit}</details></div>
          </details>
        </div>
      </> : <>
        <div><span className={`side-tag ${d.side}`}>{sideLabels[d.side]}</span><strong className="card-number">{cardLabel(d)}</strong><span className="rarity">{rarityLabels[d.rarity]}</span></div>
        {detailCopy}<div className="mt-2">{actions}</div>{editor}{audit}
      </>}
    </li>
  })}</ol>
}
export function SequenceView({ segmentId, data, mutate, busy, sessionActions }: { segmentId: string; data: DataSet; mutate: Mutate; busy: boolean; sessionActions?: ReactNode }) {
  const [view, setView] = useState<'split' | 'timeline' | 'unknown'>('split')
  const draws = orderedDraws(data.draws, segmentId)
  const valid = draws.filter(d => !d.deleted_at)
  const last = valid.at(-1)
  const list = (items: Draw[]) => <DrawList draws={items} data={data} mutate={mutate} busy={busy} compact />
  return <section className="panel sequence-section"><div className="section-heading"><div><p className="eyebrow">TODAY'S COLLECTION</p><h2>本次卡序 <span className="heading-count">{valid.length} 張</span></h2></div><Icon name="book" size={25} /></div>
    <SequenceGaps data={data} segmentId={segmentId} />
    <div className="sequence-tabs" role="group" aria-label="卡序檢視">{([['split', '左右卡匣'], ['timeline', '整體時間順序'], ['unknown', '不明來源']] as const).map(([value, label]) => <button aria-pressed={view === value} className={view === value ? 'selected' : ''} key={value} onClick={() => setView(value)}>{label}{value === 'unknown' && <span className="tab-count">{valid.filter(d => d.side === 'unknown').length}</span>}</button>)}</div>
    {view === 'split' ? <div className="cartridge-columns">{(['left', 'right'] as const).map(side => <section className={`cartridge-column ${side}`} key={side} data-side={side} aria-label={`${sideLabels[side]}卡匣序列`}>
      <div className="column-heading"><span className="column-letter">{side === 'left' ? 'L' : 'R'}</span><h3>{sideLabels[side]}卡匣</h3><span>{valid.filter(d => d.side === side).length} 張</span></div>{list(valid.filter(d => d.side === side))}
    </section>)}</div> : <div className="single-sequence">{list(view === 'timeline' ? valid : valid.filter(d => d.side === 'unknown'))}</div>}
    <p className="sequence-footnote">卡片以原始全域序號顯示，不重排或填補缺口；卡號未知代表確實有出卡。來源修正與原始側序可在詳細資料查看。</p>
    <div className="session-actions"><button disabled={busy || !last} onClick={() => { if (last && window.confirm(`確認永久刪除上一筆「${cardLabel(last)}」（原始 #${last.draw_index}）？\n出卡紀錄與專屬操作歷史將永久移除，無法復原。`)) void mutate('delete_draw', { segment_id: last.segment_id, id: last.id, revision: last.revision, confirmed: true }).catch(() => {}) }}><Icon name="trash" size={17} />刪除上一筆</button>{sessionActions}</div>
  </section>
}
