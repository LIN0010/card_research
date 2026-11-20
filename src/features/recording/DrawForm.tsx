import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Icon } from '../../components/Icon'
import { suggestRarity } from '../../lib/sequences'
import { applyCardPrefix, versionPrefix } from '../../lib/cardInput'
import type { Rarity, Side } from '../../lib/types'
import type { Mutate } from '../../lib/useCommands'
import { QuickFields, RarityPicker } from './QuickFields'

export function DrawForm({ segmentId, gameId, gameIndex, gameVersion = '', mutate, busy, onDirty, feedback }: {
  segmentId: string; gameId: string; gameIndex: number; gameVersion?: string; mutate: Mutate; busy: boolean
  onDirty?: (dirty: boolean) => void; feedback?: ReactNode
}) {
  const [card, setCard] = useState('')
  const [side, setSide] = useState<Side | null>(null)
  const [rarity, setRarity] = useState<Rarity>('normal')
  const [prefix, setPrefix] = useState(() => versionPrefix(gameVersion))
  const [id, setId] = useState(() => crypto.randomUUID())
  const manualRarity = useRef(false)
  const submitting = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { onDirty?.(card.length > 0); return () => onDirty?.(false) }, [card, onDirty])
  function changeCard(raw: string) { setCard(raw); if (!manualRarity.current) setRarity(suggestRarity(raw)) }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (submitting.current || busy || !card.trim() || side === null) return
    submitting.current = true
    try {
      await mutate('append_draw', { id, segment_id: segmentId, game_id: gameId, side, card_number: card, rarity })
      setCard(''); setSide(null); setRarity('normal'); manualRarity.current = false; setId(crypto.randomUUID())
      requestAnimationFrame(() => input.current?.focus())
    } catch { /* Keep the exact unsaved input and selected source on failure. */ }
    finally { submitting.current = false }
  }
  return <section className="panel draw-entry"><div className="section-heading"><div><p className="eyebrow">ONE MORE CARD</p><h2>快速出卡紀錄</h2></div><span className="soft-tag">第 {gameIndex} 局</span></div>
    <form onSubmit={submit}><fieldset disabled={busy} className="quick-form-layout">
      <QuickFields side={side} onSide={setSide} disabled={busy} />
      <div className="card-input-area"><label className="card-input-label">卡片編號<input ref={input} autoComplete="off" autoCapitalize="off" spellCheck={false} required maxLength={64} placeholder={prefix ? `${prefix}049` : '輸入完整卡號或先帶入前綴'} value={card} onChange={e => changeCard(e.target.value)} /></label>
        <div className="prefix-tools">{versionPrefix(prefix) && <button type="button" className="prefix-chip" onClick={() => { changeCard(applyCardPrefix(card, versionPrefix(prefix))); input.current?.focus() }}><Icon name="plus" size={14} />{versionPrefix(prefix)} 帶入</button>}
          <details className="prefix-custom"><summary>自訂前綴</summary><label>前綴文字<input value={prefix} maxLength={17} placeholder="例如 AP6-" onChange={e => setPrefix(e.target.value)} /></label></details>
        </div>
        <p className="muted input-hint">點選快捷才帶入前綴，完整卡號保留原樣。</p>
        {/p\s*$/i.test(card) && <p className="hint">P 字尾提示：可能是簽名卡，仍可手動修改。</p>}
        <RarityPicker rarity={rarity} onChange={value => { manualRarity.current = true; setRarity(value) }} disabled={busy} />
        <div className="record-submit"><button className="primary save-draw" disabled={!card.trim() || busy || side === null}><Icon name="plus" />{busy ? '儲存處理中…' : side === null ? '選擇來源後儲存' : `儲存${side === 'unknown' ? '來源不明' : side === 'left' ? '左卡匣' : '右卡匣'}出卡`}</button>
          <small>{side === null ? '先選來源，不確定時可選「來源不明」。' : '儲存後清空卡號與來源，準備記錄下一張。'}</small></div>
      </div>
    </fieldset></form>
    {feedback}
  </section>
}
