import { useCallback, useEffect, useRef, useState } from 'react'
import { Management } from '../features/management/Management'
import { NewSegment, SegmentControls } from '../features/recording/SegmentControls'
import { DrawForm } from '../features/recording/DrawForm'
import { SequenceView } from '../features/history/DrawList'
import { History } from '../features/history/History'
import { downloadFile, exportCsv, exportJson } from '../lib/export'
import { repository, type Repository } from '../lib/repository'
import { emptyData } from '../lib/types'
import { useCommands } from '../lib/useCommands'

export function App({ email, onLogout, repo = repository }: { email: string; onLogout: () => Promise<void>; repo?: Repository }) {
  const [data, setData] = useState(emptyData)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [tab, setTab] = useState<'record' | 'manage' | 'history'>('record')
  const [machineId, setMachineId] = useState(() => new URLSearchParams(location.search).get('machine') ?? '')
  const [segmentId, setSegmentId] = useState(() => new URLSearchParams(location.search).get('segment') ?? '')
  const [dirty, setDirty] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [authError, setAuthError] = useState('')
  const [loggingOut, setLoggingOut] = useState(false)
  const generation = useRef(0)
  const mounted = useRef(true)
  const refresh = useCallback(async () => {
    const run = ++generation.current
    setLoading(true); setLoadError('')
    try {
      const result = await repo.load()
      if (mounted.current && run === generation.current) setData(result)
    } catch (error) {
      if (mounted.current && run === generation.current) setLoadError(error instanceof Error ? error.message : '無法讀取資料')
      throw error
    } finally { if (mounted.current && run === generation.current) setLoading(false) }
  }, [repo])
  useEffect(() => { mounted.current = true; void refresh().catch(() => {}); return () => { mounted.current = false; generation.current++ } }, [refresh])
  const commands = useCommands(repo, refresh)
  const busy = commands.busy || loading || exporting || loggingOut || !!loadError
  const machine = data.machines.find(m => m.id === machineId) ?? data.machines[0]
  const segments = data.observation_segments.filter(s => s.machine_id === machine?.id).sort((a, b) => b.started_at.localeCompare(a.started_at))
  const segment = segments.find(s => s.id === segmentId) ?? segments[0]
  const game = data.games.filter(g => g.segment_id === segment?.id).sort((a, b) => b.game_index - a.game_index)[0]
  useEffect(() => {
    if (!machine) return
    const params = new URLSearchParams()
    params.set('machine', machine.id)
    if (segment) params.set('segment', segment.id)
    window.history.replaceState(null, '', `?${params}`)
  }, [machine?.id, segment?.id])
  useEffect(() => {
    function guard(event: BeforeUnloadEvent) { if (dirty || commands.busy) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty, commands.busy])
  function canLeave() { return !dirty || window.confirm('有尚未送出的卡號，切換後會清除輸入。確定切換？') }
  function selectMachine(id: string) { if (canLeave()) { setMachineId(id); setSegmentId(''); setDirty(false) } }
  async function exportData(format: 'csv' | 'json') {
    setExporting(true)
    try {
      const fresh = await repo.load()
      setData(fresh)
      const stamp = new Date().toISOString().replaceAll(':', '-')
      downloadFile(format === 'csv' ? exportCsv(fresh) : exportJson(fresh), `aikatsu-${stamp}.${format}`, format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8')
    } catch (error) { setLoadError(`匯出前讀取失敗：${error instanceof Error ? error.message : '請重試'}`) }
    finally { setExporting(false) }
  }
  async function logout() {
    if (!canLeave()) return
    setLoggingOut(true); setAuthError('')
    try { await onLogout() } catch (error) { setAuthError(error instanceof Error ? error.message : '登出失敗，請重試') }
    finally { setLoggingOut(false) }
  }
  return <>
    <header className="page-header"><div><h1>偶像學園雙卡匣卡序研究系統</h1><p>線上紀錄 MVP · {email}</p></div><button disabled={commands.busy || exporting || loggingOut} onClick={() => void logout()}>登出</button></header>
    <main className="page-main">
      <nav className="tabs" aria-label="主要功能">{([['record', '出卡紀錄'], ['manage', '店家與機台'], ['history', '歷史與匯出']] as const).map(([value, label]) => <button key={value} disabled={commands.busy || exporting} aria-pressed={tab === value} className={tab === value ? 'selected' : ''} onClick={() => { if (value !== tab && canLeave()) { setTab(value); setDirty(false) } }}>{label}</button>)}</nav>
      <section className="status-bar" aria-live="polite">
        <span>{commands.message || (loading ? '正在從 Supabase 讀取…' : '資料已讀取，等待紀錄。')}</span>
        {commands.needsRetry && <button className="primary" disabled={commands.sending} onClick={commands.retry}>重試確認儲存</button>}
        <button disabled={commands.busy || exporting || loading} onClick={() => void refresh().catch(() => {})}>重新讀取</button>
      </section>
      {(loadError || commands.error || authError) && <div role="alert" className="error"><p>{loadError || commands.error || authError}</p>{loadError && <p>請確認網路、Supabase 環境變數與 migration 是否已設定。畫面可能是上次讀取資料。</p>}</div>}
      {tab === 'manage' && <Management data={data} mutate={commands.mutate} busy={busy} onMachine={id => { setMachineId(id); setSegmentId('') }} />}
      {tab === 'record' && <>
        {!data.machines.length && !loading && <section className="panel"><h2>先建立店家與機台</h2><p>完成後即可建立連續觀測段。尚未收到伺服器確認的輸入不會顯示為已儲存。</p><button className="primary mt-3" onClick={() => setTab('manage')}>前往管理</button></section>}
        {machine && <>
          <section className="panel"><div className="grid gap-3 sm:grid-cols-2"><label>目前機台<select disabled={busy} value={machine.id} onChange={e => selectMachine(e.target.value)}>{data.machines.map(m => <option key={m.id} value={m.id}>{data.stores.find(s => s.id === m.store_id)?.name}／{m.machine_name} · {m.game_version}</option>)}</select></label>
            <label>連續觀測段<select disabled={busy || !segments.length} value={segment?.id ?? ''} onChange={e => { if (canLeave()) { setSegmentId(e.target.value); setDirty(false) } }}>{!segments.length && <option value="">請建立觀測段</option>}{segments.map(s => <option key={s.id} value={s.id}>{s.label} · {s.ended_at ? '已結束' : '觀測中'} · {new Date(s.started_at).toLocaleDateString('zh-TW')}</option>)}</select></label></div></section>
          <NewSegment key={machine.id} machineId={machine.id} mutate={commands.mutate} busy={busy || dirty} onCreated={setSegmentId} />
          {segment && <><SegmentControls key={segment.id} segment={segment} data={data} mutate={commands.mutate} busy={busy || dirty} />
            {!segment.ended_at && game && <DrawForm key={segment.id} segmentId={segment.id} gameId={game.id} gameIndex={game.game_index} mutate={commands.mutate} busy={busy} onDirty={setDirty} />}
            <SequenceView key={segment.id} segmentId={segment.id} data={data} mutate={commands.mutate} busy={busy || dirty} /></>}
        </>}
      </>}
      {tab === 'history' && <>
        <section className="panel"><h2>匯出我的資料</h2><p className="muted">匯出前重新讀取全部分頁。CSV 包含已撤銷列及原始序號；JSON 另含完整關聯及操作歷史。CSV 為試算表安全會處理公式開頭文字，原文以 JSON 為準。</p><div className="actions mt-3"><button disabled={busy} onClick={() => void exportData('csv')}>匯出 CSV</button><button disabled={busy} onClick={() => void exportData('json')}>匯出 JSON</button></div></section>
        <History data={data} mutate={commands.mutate} busy={busy} />
      </>}
    </main>
    <footer>原始序號保留歷史；有效顯示編號只供閱讀。本階段不進行卡序預測。</footer>
  </>
}
