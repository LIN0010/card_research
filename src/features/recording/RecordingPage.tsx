import { useRef, type ReactNode } from 'react'
import { Icon } from '../../components/Icon'
import { MachineOptions } from '../../components/MachineOptions'
import { storeLocation } from '../../lib/storeLabels'
import type { DataSet, Game, Machine, Segment } from '../../lib/types'
import type { Mutate } from '../../lib/useCommands'
import { SequenceView } from '../history/DrawList'
import { DrawForm } from './DrawForm'
import { NewSegment, SegmentControls, SessionActions } from './SegmentControls'

export function RecordingPage({ data, machine, segment, game, segments, mutate, busy, dirty, feedback, loading, onDirty, onMachine, onSegment, onManage }: {
  data: DataSet; machine?: Machine; segment?: Segment; game?: Game; segments: Segment[]; mutate: Mutate; busy: boolean; dirty: boolean
  feedback: ReactNode; loading: boolean; onDirty: (dirty: boolean) => void; onMachine: (id: string) => void; onSegment: (id: string) => void; onManage: () => void
}) {
  const store = data.stores.find(s => s.id === machine?.store_id)
  const switcher = useRef<HTMLDetailsElement>(null)
  const count = data.draws.filter(d => d.segment_id === segment?.id && !d.deleted_at).length
  return <div className="recording-page">
    <div className="journal-intro"><div><p className="eyebrow">MY CARD JOURNAL</p><h2>今天，也收下一張喜歡的卡。</h2><p>把每一次出卡的順序，慢慢記在這裡。</p></div><span className="journal-stamp"><Icon name="book" size={32} /><span>ONE CARD<br />AT A TIME</span></span></div>
    {!machine ? <section className="panel welcome-card"><div className="welcome-art"><Icon name="cards" size={48} /></div><h2>{loading ? '正在翻開你的手帳…' : '第一張卡，從這裡開始'}</h2><p className="muted">先留下店家與機台，下一步就能開始抽卡。</p>{!loading && <button className="primary" onClick={onManage}><Icon name="plus" size={18} />前往管理</button>}{feedback}</section> : <>
      <section className="panel session-status" aria-label="目前抽卡狀態">
        <div className="session-top"><div className="machine-title"><span className="store-name"><Icon name="shop" size={15} /><span>{store?.name}</span></span><p className="store-location">{storeLocation(store?.location)}</p><h3>{machine.machine_name}<span className={`live-tag ${segment && !segment.ended_at ? 'active' : ''}`}>{segment ? segment.ended_at ? '已結束' : '抽卡中' : '尚未開始'}</span></h3></div>
          <div className="session-entry-actions"><details ref={switcher} className="session-switch" onKeyDown={event => { if (event.key === 'Escape' && switcher.current) switcher.current.open = false }}><summary><Icon name="swap" size={16} />切換<span className="desktop-only">機台／場次</span></summary><div className="switch-fields">
            <label>目前機台<select disabled={busy} value={machine.id} onChange={e => onMachine(e.target.value)}><MachineOptions machines={data.machines} stores={data.stores} /></select></label>
            <label>抽卡場次<select disabled={busy || !segments.length} value={segment?.id ?? ''} onChange={e => onSegment(e.target.value)}>{!segments.length && <option value="">尚無場次</option>}{segments.map(s => <option key={s.id} value={s.id}>{s.label} · {s.ended_at ? '已結束' : '抽卡中'} · {new Date(s.started_at).toLocaleDateString('zh-TW')}</option>)}</select></label>
            <button className="quiet-button" type="button" onClick={() => { if (switcher.current) switcher.current.open = false }}>完成切換</button>
          </div></details>
            <NewSegment key={machine.id} machineId={machine.id} mutate={mutate} busy={busy || dirty} onCreated={onSegment} feedback={feedback} />
          </div>
        </div>
        <div className="session-metrics"><div><span>遊戲版本</span><strong>{segment?.game_version ?? machine.game_version}</strong></div><div><span>目前局數</span><strong>{game ? <>第 <b>{game.game_index}</b> 局</> : '—'}</strong></div><div><span>已記錄</span><strong><b>{count}</b> 張</strong></div><div className="current-session-name"><span>抽卡場次</span><strong>{segment?.label ?? '準備好就開始吧'}</strong></div></div>
      </section>
      {segment && game && !segment.ended_at ? <DrawForm key={segment.id} segmentId={segment.id} gameId={game.id} gameIndex={game.game_index} gameVersion={segment.game_version} mutate={mutate} busy={busy} onDirty={onDirty} feedback={feedback} /> : <section className="panel ready-card"><Icon name="cards" size={36} /><div><h2>{segment ? '這次抽卡，已經收進手帳' : '準備記下第一張卡片？'}</h2><p className="muted">{segment ? '下方仍可查看、修改與匯出紀錄。開始新場次，繼續下一次收藏。' : '點選上方「開始抽卡」，建立場次後就能快速紀錄。'}</p></div>{feedback}</section>}
      {segment && <><SequenceView key={segment.id} segmentId={segment.id} data={data} mutate={mutate} busy={busy || dirty} sessionActions={<SessionActions segment={segment} mutate={mutate} busy={busy || dirty} />} />
        <SegmentControls key={`settings-${segment.id}`} segment={segment} data={data} mutate={mutate} busy={busy || dirty} /></>}
    </>}
  </div>
}
