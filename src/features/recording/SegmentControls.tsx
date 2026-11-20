import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { Dialog } from '../../components/Dialog'
import { Icon } from '../../components/Icon'
import type { Cartridge, DataSet, Segment } from '../../lib/types'
import type { Mutate } from '../../lib/useCommands'
import { activeCartridge } from '../../lib/sequences'

export function NewSegment({ machineId, mutate, busy, onCreated, feedback }: { machineId: string; mutate: Mutate; busy: boolean; onCreated: (id: string) => void; feedback?: ReactNode }) {
  const [open, setOpen] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const values = new FormData(form)
    try {
      const result = await mutate('create_segment', { machine_id: machineId, label: String(values.get('label')), notes: String(values.get('notes')),
        left_certainty: String(values.get('left_certainty')), right_certainty: String(values.get('right_certainty')) })
      onCreated(result.id); setOpen(false)
    } catch { /* Keep all fields available for a retry. */ }
  }
  return <><button className="primary start-session" disabled={busy} onClick={() => setOpen(true)}><Icon name="plus" size={18} />開始抽卡</button>
    {open && <Dialog title="開始抽卡" busy={busy} onClose={() => setOpen(false)}>
      <p className="muted">為這次抽卡開一頁新手帳。換局不需要另開場次。</p>
      <form onSubmit={submit}><fieldset disabled={busy}>
        <label>場次名稱<input name="label" required maxLength={100} defaultValue={`${new Date().toLocaleDateString('zh-TW')} 的抽卡紀錄`} /></label>
        <label>備註（選填）<textarea name="notes" maxLength={5000} placeholder="記下今天的小發現…" /></label>
        <details className="advanced-inline"><summary>進階設定</summary><p className="muted">無法確認是否同一批時，保留「不確定」，不會假設卡序延續。</p>
          <div className="grid grid-cols-2 gap-3">{(['left', 'right'] as const).map(side => <label key={side}>{side === 'left' ? '左' : '右'}卡匣批次狀態<select name={`${side}_certainty`} defaultValue="uncertain"><option value="uncertain">不確定（獨立批次）</option><option value="confirmed">已確認裝填批次</option></select></label>)}</div>
        </details>
        <button className="primary dialog-submit"><Icon name="cards" size={18} />開始第 1 局</button>
      </fieldset></form>{feedback}
    </Dialog>}
  </>
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
  return <div className={`batch ${side}`}>
    <p><strong>{side === 'left' ? '左' : '右'}卡匣</strong> · 批次 {cartridge?.batch_index ?? '—'} · {cartridge?.certainty === 'confirmed' ? '已確認' : '不確定'}</p>
    <small>自原始 #{cartridge?.starts_at_index ?? '—'} 起；不確定批次不代表已確認延續。</small>
    {!segment.ended_at && <button className="mt-2" disabled={busy} onClick={() => setOpen(!open)}>{open ? '取消更換' : '更換／標記不確定'}</button>}
    {open && <form onSubmit={submit}><fieldset disabled={busy}>
      <label>批次狀態<select name="certainty" defaultValue="uncertain"><option value="uncertain">無法確認是否更換</option><option value="confirmed">確認已更換／補充</option></select></label>
      <label>原因（選填）<input name="note" maxLength={1000} /></label><button>建立新批次</button>
    </fieldset></form>}
  </div>
}
export function SegmentControls({ segment, data, mutate, busy }: { segment: Segment; data: DataSet; mutate: Mutate; busy: boolean }) {
  return <details className="panel advanced-settings"><summary><Icon name="settings" /><span>進階設定<small>卡匣更換、批次與不確定狀態</small></span><Icon name="chevron" size={16} /></summary>
    <div className="grid gap-3 sm:grid-cols-2">{(['left', 'right'] as const).map(side => <BatchControl key={`${segment.id}-${side}`} side={side} segment={segment} cartridge={activeCartridge(data.cartridges, segment.id, side)} mutate={mutate} busy={busy} />)}</div>
    <p className="muted mt-3">不同場次不直接串接。補卡、更換或無法確認時，請建立新的卡匣批次。</p>
  </details>
}
export function SessionActions({ segment, mutate, busy }: { segment: Segment; mutate: Mutate; busy: boolean }) {
  const helpId = useId()
  if (segment.ended_at) return <span className="muted ended-label">本次紀錄已結束，紀錄會好好保留。</span>
  return <><div className="session-action-guide"><button className="primary" aria-label="下一局（卡序延續）" aria-describedby={`${helpId}-next`} disabled={busy} onClick={() => { void mutate('start_game', { segment_id: segment.id }).catch(() => {}) }}><Icon name="plus" size={17} /><span>下一局<span className="action-qualifier">（卡序延續）</span></span></button>
      <small id={`${helpId}-next`}>同一台機器繼續遊玩，中間沒有其他人抽卡。</small>
    </div>
    <div className="session-action-guide"><button className="end-session" aria-describedby={`${helpId}-end`} disabled={busy} onClick={() => { if (window.confirm('確定要結束本次紀錄嗎？\n離開、換機台或其他玩家接手時使用。\n所有紀錄會保留；若同一台機器繼續遊玩且中間沒有其他人抽卡，請選「下一局（卡序延續）」。')) void mutate('close_segment', { segment_id: segment.id }).catch(() => {}) }}>結束本次紀錄</button>
      <small id={`${helpId}-end`}>離開、換機台或其他玩家接手時使用。</small>
    </div></>
}
