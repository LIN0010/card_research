import { useEffect, useRef, useState, type FormEvent } from 'react'
import { SourceFields } from '../../components/FormFields'
import { suggestRarity } from '../../lib/sequences'
import type { Rarity, Side } from '../../lib/types'
import type { Mutate } from '../../lib/useCommands'

export function DrawForm({ segmentId, gameId, gameIndex, mutate, busy, onDirty }: {
  segmentId: string; gameId: string; gameIndex: number; mutate: Mutate; busy: boolean; onDirty?: (dirty: boolean) => void
}) {
  const [card, setCard] = useState('')
  const [side, setSide] = useState<Side>('unknown')
  const [rarity, setRarity] = useState<Rarity>('normal')
  const [id, setId] = useState(() => crypto.randomUUID())
  const manualRarity = useRef(false)
  const submitting = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { onDirty?.(card.length > 0); return () => onDirty?.(false) }, [card, onDirty])
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (submitting.current || busy || !card.trim()) return
    submitting.current = true
    try {
      await mutate('append_draw', { id, segment_id: segmentId, game_id: gameId, side, card_number: card, rarity })
      setCard(''); setRarity('normal'); manualRarity.current = false; setId(crypto.randomUUID())
      requestAnimationFrame(() => input.current?.focus())
    } catch { /* A rejected online write must never erase unsent input. */ }
    finally { submitting.current = false }
  }
  return <section className="panel"><h2>紀錄出卡 · 第 {gameIndex} 局</h2>
    <form onSubmit={submit}><fieldset disabled={busy}>
      <label>卡片編號<input ref={input} autoComplete="off" autoCapitalize="off" spellCheck={false} required maxLength={64} placeholder="AP6-049、A06-001、AP6-14P" value={card}
        onChange={e => { const raw = e.target.value; setCard(raw); if (!manualRarity.current) setRarity(suggestRarity(raw)) }} /></label>
      {/p\s*$/i.test(card) && <p className="hint">P 後綴提示可能是簽名卡；可手動更改稀有度。</p>}
      <SourceFields side={side} onSide={setSide} rarity={rarity} onRarity={value => { manualRarity.current = true; setRarity(value) }} />
      <button className="primary w-full" disabled={!card.trim() || busy}>{busy ? '儲存處理中…' : `儲存${side === 'unknown' ? '來源不明' : side === 'left' ? '左卡匣' : '右卡匣'}出卡`}</button>
    </fieldset></form>
    <p className="muted mt-3">卡號保留原始文字。來源無法辨認時請選「不明」。此版本需要連線，尚未儲存的輸入不會自動備份。</p>
  </section>
}
