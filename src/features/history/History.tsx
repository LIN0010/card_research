import { useState } from 'react'
import type { DataSet } from '../../lib/types'
import type { Mutate } from '../../lib/useCommands'
import { DrawList } from './DrawList'

export function History({ data, mutate, busy }: { data: DataSet; mutate: Mutate; busy: boolean }) {
  const [machine, setMachine] = useState('')
  const [segment, setSegment] = useState('')
  const [game, setGame] = useState('')
  const [query, setQuery] = useState('')
  const [includeVoided, setIncludeVoided] = useState(true)
  const segments = data.observation_segments.filter(s => !machine || s.machine_id === machine)
  const segmentIds = new Set(segments.filter(s => !segment || s.id === segment).map(s => s.id))
  const draws = data.draws.filter(d => segmentIds.has(d.segment_id) && (!game || d.game_id === game) && (includeVoided || !d.deleted_at) && d.card_number.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => a.segment_id.localeCompare(b.segment_id) || a.draw_index - b.draw_index)
  return <section className="panel"><h2>歷史紀錄</h2>
    <div className="grid gap-3 sm:grid-cols-2">
      <label>機台篩選<select value={machine} onChange={e => { setMachine(e.target.value); setSegment(''); setGame('') }}><option value="">全部機台（各段分開）</option>{data.machines.map(m => <option key={m.id} value={m.id}>{data.stores.find(s => s.id === m.store_id)?.name}／{m.machine_name}</option>)}</select></label>
      <label>觀測段篩選<select value={segment} onChange={e => { setSegment(e.target.value); setGame('') }}><option value="">全部觀測段</option>{segments.map(s => <option key={s.id} value={s.id}>{s.label} · {new Date(s.started_at).toLocaleString('zh-TW')}</option>)}</select></label>
      {segment && <label>遊戲局數篩選<select value={game} onChange={e => setGame(e.target.value)}><option value="">全部局數</option>{data.games.filter(g => g.segment_id === segment).sort((a, b) => a.game_index - b.game_index).map(g => <option key={g.id} value={g.id}>第 {g.game_index} 局</option>)}</select></label>}
      <label>搜尋卡號<input value={query} onChange={e => setQuery(e.target.value)} placeholder="保留前綴或以部分卡號搜尋" /></label>
    </div>
    <label className="inline-check"><input type="checkbox" checked={includeVoided} onChange={e => setIncludeVoided(e.target.checked)} />包含已撤銷紀錄</label>
    <p className="muted mb-3">符合 {draws.length} 筆；每筆序號只屬於自己的觀測段，不跨機台串接。</p>
    <DrawList draws={draws} data={data} mutate={mutate} busy={busy} context />
  </section>
}
