import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from '../components/Icon'
import { SaveStatus } from '../components/SaveStatus'
import { Management } from '../features/management/Management'
import { RecordingPage } from '../features/recording/RecordingPage'
import { History } from '../features/history/History'
import { downloadFile, exportCsv, exportJson } from '../lib/export'
import { repository, type Repository } from '../lib/repository'
import { emptyData } from '../lib/types'
import { useCommands } from '../lib/useCommands'

type Tab = 'record' | 'manage' | 'history'
const tabs: { value: Tab; label: string; icon: IconName }[] = [
  { value: 'record', label: '出卡紀錄', icon: 'cards' },
  { value: 'manage', label: '店家與機台', icon: 'shop' },
  { value: 'history', label: '歷史紀錄', icon: 'history' },
]
export function App({ email, onLogout, repo = repository }: { email: string; onLogout: () => Promise<void>; repo?: Repository }) {
  const [data, setData] = useState(emptyData)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [tab, setTab] = useState<Tab>('record')
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
  function selectSegment(id: string) { if (canLeave()) { setSegmentId(id); setDirty(false) } }
  async function exportData(format: 'csv' | 'json') {
    setExporting(true)
    try {
      const fresh = await repo.load()
      setData(fresh)
      const stamp = new Date().toISOString().replaceAll(':', '-')
      downloadFile(format === 'csv' ? exportCsv(fresh) : exportJson(fresh), `card-research-${stamp}.${format}`, format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8')
    } catch (error) { setLoadError(`匯出前讀取失敗：${error instanceof Error ? error.message : '請重試'}`) }
    finally { setExporting(false) }
  }
  async function logout() {
    if (!canLeave()) return
    setLoggingOut(true); setAuthError('')
    try { await onLogout() } catch (error) { setAuthError(error instanceof Error ? error.message : '登出失敗，請重試') }
    finally { setLoggingOut(false) }
  }
  const feedback = <SaveStatus message={commands.message} error={commands.error} loading={loading} sending={commands.sending} needsRetry={commands.needsRetry} retry={commands.retry} refresh={() => void refresh().catch(() => {})} refreshDisabled={commands.busy || exporting || loading} />
  return <>
    <header className="page-header"><a className="brand" href="#main-content" aria-label="Card Research"><span className="brand-mark"><Icon name="cards" size={29} /></span><div><h1>Card Research</h1><p>我的卡片收藏手帳</p></div></a><div className="account-area"><span title={email}>{email}</span><button className="icon-button" aria-label="登出" title="登出" disabled={commands.busy || exporting || loggingOut} onClick={() => void logout()}><Icon name="logout" /></button></div></header>
    <nav className="tabs" aria-label="主要功能">{tabs.map(({ value, label, icon }) => <button key={value} disabled={commands.busy || exporting} aria-pressed={tab === value} className={tab === value ? 'selected' : ''} onClick={() => { if (value !== tab && canLeave()) { setTab(value); setDirty(false) } }}><Icon name={icon} size={21} /><span>{label}</span></button>)}</nav>
    <main className="page-main" id="main-content">
      {(loadError || authError) && <div role="alert" className="error"><p>{loadError || authError}</p>{loadError && <p>暫時無法更新紀錄，請確認連線後按重新讀取。畫面可能是上次讀取的資料。</p>}</div>}
      {tab !== 'record' && feedback}
      {tab === 'manage' && <Management data={data} mutate={commands.mutate} busy={busy} onMachine={id => { setMachineId(id); setSegmentId('') }} />}
      {tab === 'record' && <RecordingPage data={data} machine={machine} segment={segment} game={game} segments={segments} mutate={commands.mutate} busy={busy} dirty={dirty} feedback={feedback} loading={loading} onDirty={setDirty} onMachine={selectMachine} onSegment={selectSegment} onManage={() => setTab('manage')} />}
      {tab === 'history' && <>
        <section className="panel"><h2>匯出我的資料</h2><p className="muted">匯出前重新讀取全部分頁。CSV 包含已撤銷列及原始序號；JSON 另含完整關聯及操作歷史。CSV 為試算表安全會處理公式開頭文字，原文以 JSON 為準。</p><div className="actions mt-3"><button disabled={busy} onClick={() => void exportData('csv')}>匯出 CSV</button><button disabled={busy} onClick={() => void exportData('json')}>匯出 JSON</button></div></section>
        <History data={data} mutate={commands.mutate} busy={busy} />
      </>}
    </main>
    <footer>Card Research <span>✧</span> 收藏每張卡，也留下每次相遇。</footer>
  </>
}
