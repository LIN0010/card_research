import { Icon } from './Icon'

export function SaveStatus({ message, error, loading, sending, retry, needsRetry, refresh, refreshDisabled }: {
  message: string; error: string; loading: boolean; sending: boolean; needsRetry: boolean
  retry: () => void; refresh: () => void; refreshDisabled: boolean
}) {
  const text = message.replaceAll('至 Supabase', '') || (loading ? '正在讀取你的紀錄…' : '儲存後會立即更新卡片手帳')
  return <div className={`save-feedback ${error ? 'has-error' : ''}`}>
    <div className="feedback-copy" role={error ? 'alert' : 'status'} aria-live="polite"><Icon name={error ? 'history' : 'check'} size={17} /><span>{text}{error && <small>{error}</small>}</span></div>
    <div className="feedback-actions">{needsRetry && <button className="primary" disabled={sending} onClick={retry}>重試確認儲存</button>}
      <button className="icon-button" aria-label="重新讀取" title="重新讀取" disabled={refreshDisabled} onClick={refresh}><Icon name="refresh" size={17} /></button>
    </div>
  </div>
}
