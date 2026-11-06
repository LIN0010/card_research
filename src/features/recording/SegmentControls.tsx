import { useState, type FormEvent } from 'react'
import type { Cartridge, DataSet, Segment } from '../../lib/types'
import type { Mutate } from '../../lib/useCommands'
import { activeCartridge } from '../../lib/sequences'

export function NewSegment({ machineId, mutate, busy, onCreated }: { machineId: string; mutate: Mutate; busy: boolean; onCreated: (id: string) => void }) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const values = new FormData(form)
    try {
      const result = await mutate('create_segment', { machine_id: machineId, label: String(values.get('label')), notes: String(values.get('notes')),
        left_certainty: String(values.get('left_certainty')), right_certainty: String(values.get('right_certainty')) })
      form.reset(); onCreated(result.id)
    } catch { /* Inputs are retained on failure. */ }
  }
  return <details className="panel"><summary>建立新的連續觀測段</summary>
    <p className="muted">換局請按「下一局」。只有觀測中斷、無法確認完整連續性時才開新段；不同機台不串接。</p>
    <form onSubmit={submit}><fieldset disabled={busy}>
      <label>觀測段名稱<input name="label" required maxLength={100} placeholder="例如：週五下午連續觀測" /></label>
      <label>備註<textarea name="notes" maxLength={5000} /></label>
      <div className="grid grid-cols-2 gap-3">{(['left', 'right'] as const).map(side => <label key={side}>{side === 'left' ? '左' : '右'}卡匣批次狀態<select name={`${side}_certainty`} defaultValue="uncertain"><option value="uncertain">不確定（獨立批次）</option><option value="confirmed">已確認裝填批次</option></select></label>)}</div>
      <button className="primary">建立觀測段及第 1 局</button>
    </fieldset></form>
  </details>
}
function BatchControl({ side, segment, cartridge, mutate, busy }: { side: 'left' | 'right'; segment: Segment; cartridge?: Cartridge; mutate: Mutate; busy: boolean }) {
  const [open, setOpen] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = new FormData(event.currentTarget)
    try {
      await mutate('replace_cartridge', { segment_id: segment.id, side, certainty: String(values.get('certainty')), note: String(values.get('note')) })
      setOpen(false)
    } catch { /* Keep the form. */ }
  }
  return <div className="batch">
    <p><strong>{side === 'left' ? '左' : '右'}卡匣</strong> · 批次 {cartridge?.batch_index ?? '—'} · {cartridge?.certainty === 'confirmed' ? '已確認' : '不確定'}</p>
    <small>自原始 #{cartridge?.starts_at_index ?? '—'} 起；不確定批次不視為已證實延續。</small>
    {!segment.ended_at && <button className="mt-2" disabled={busy} onClick={() => setOpen(!open)}>{open ? '取消更換' : '更換／標記不確定'}</button>}
    {open && <form onSubmit={submit}><fieldset disabled={busy}>
      <label>批次狀態<select name="certainty" defaultValue="uncertain"><option value="uncertain">無法確認是否更換</option><option value="confirmed">確認已更換／補充</option></select></label>
      <label>原因（選填）<input name="note" maxLength={1000} /></label><button>建立新批次</button>
    </fieldset></form>}
  </div>
}
export function SegmentControls({ segment, data, mutate, busy }: { segment: Segment; data: DataSet; mutate: Mutate; busy: boolean }) {
  const games = data.games.filter(g => g.segment_id === segment.id).sort((a, b) => a.game_index - b.game_index)
  const current = games.at(-1)
  return <section className="panel"><h2>{segment.label}</h2><p className="muted">{new Date(segment.started_at).toLocaleString('zh-TW')} · {segment.game_version} · {segment.ended_at ? '已結束' : '觀測中'}{segment.notes && ` · ${segment.notes}`}</p>
    <div className="actions my-3"><strong>目前第 {current?.game_index ?? '—'} 局 · 原始紀錄 {segment.last_draw_index} 筆</strong>
      {!segment.ended_at && <><button disabled={busy} onClick={() => { void mutate('start_game', { segment_id: segment.id }).catch(() => {}) }}>下一局（卡序繼續）</button>
        <button disabled={busy} onClick={() => { if (window.confirm('結束此觀測段？之後新增出卡需另開觀測段，原紀錄會保留。')) void mutate('close_segment', { segment_id: segment.id }).catch(() => {}) }}>結束觀測段</button></>}
    </div>
    <div className="grid gap-3 sm:grid-cols-2">{(['left', 'right'] as const).map(side => <BatchControl key={`${segment.id}-${side}`} side={side} segment={segment} cartridge={activeCartridge(data.cartridges, segment.id, side)} mutate={mutate} busy={busy} />)}</div>
  </section>
}
