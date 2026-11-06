import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Session } from '@supabase/supabase-js'
import { App } from './app/App'
import { AuthPanel, PasswordReset } from './features/auth/AuthPanel'
import { supabase } from './lib/supabase'
import './styles.css'

function Root() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(!!supabase)
  const [error, setError] = useState('')
  const [recovery, setRecovery] = useState(new URLSearchParams(location.search).has('recovery'))
  useEffect(() => {
    if (!supabase) return
    let active = true
    let authChanged = false
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, next) => {
      authChanged = true
      if (active) { setSession(next); setLoading(false); if (event === 'PASSWORD_RECOVERY') setRecovery(true) }
    })
    void supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return
      if (error) setError(error.message)
      if (!authChanged) { setSession(data.session); setLoading(false) }
    }).catch(() => { if (active) { setError('無法讀取登入狀態，請重新載入。'); setLoading(false) } })
    return () => { active = false; subscription.unsubscribe() }
  }, [])
  if (!supabase) return <main className="page-main"><section className="panel"><h1>偶像學園雙卡匣卡序研究系統</h1><h2>尚未設定 Supabase</h2><p>請依 README 與 docs/setup.md 建立 Supabase 專案、執行 migration，並將以下公開設定填入 .env.local 後重新啟動：</p><pre>VITE_SUPABASE_URL{ '\n' }VITE_SUPABASE_PUBLISHABLE_KEY</pre><p>此畫面不使用假資料，也不代表已連線成功。</p></section></main>
  if (loading) return <main className="page-main"><p role="status">讀取登入狀態…</p></main>
  if (session && recovery) return <main className="page-main"><PasswordReset onDone={() => setRecovery(false)} /></main>
  if (session) return <App key={session.user.id} email={session.user.email ?? '已登入'} onLogout={async () => { const { error } = await supabase!.auth.signOut(); if (error) throw error }} />
  return <main className="page-main"><h1 className="text-center mb-6">偶像學園雙卡匣卡序研究系統</h1>{error && <p role="alert" className="error">{error}</p>}<AuthPanel /></main>
}
createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>)
