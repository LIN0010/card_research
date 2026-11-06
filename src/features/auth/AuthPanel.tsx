import { useState, type FormEvent } from 'react'
import { supabase } from '../../lib/supabase'

export function AuthPanel() {
  const [mode, setMode] = useState<'login' | 'signup' | 'forgot'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!supabase) return
    setBusy(true); setMessage('')
    try {
      const { error } = mode === 'login'
        ? await supabase.auth.signInWithPassword({ email, password })
        : mode === 'signup'
          ? await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } })
          : await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/?recovery=1` })
      if (error) throw error
      if (mode === 'signup') setMessage('註冊申請已送出；若啟用信箱驗證，請先收信完成驗證。')
      if (mode === 'forgot') setMessage('若此信箱已註冊，將收到密碼重設信。')
    } catch (error) { setMessage(error instanceof Error ? error.message : '登入服務暫時無法使用，請重試') }
    finally { setBusy(false) }
  }
  return <section className="panel mx-auto max-w-md"><h2>{mode === 'login' ? '登入私人紀錄' : mode === 'signup' ? '建立帳號' : '重設密碼'}</h2>
    <p className="muted">資料預設僅本人可查看。請先登入再開始紀錄。</p>
    <form onSubmit={submit}>
      <label>電子郵件<input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} disabled={busy} /></label>
      {mode !== 'forgot' && <label>密碼<input type="password" minLength={8} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required value={password} onChange={e => setPassword(e.target.value)} disabled={busy} /></label>}
      <button className="primary" disabled={busy}>{busy ? '處理中…' : mode === 'login' ? '登入' : mode === 'signup' ? '註冊' : '寄送重設信'}</button>
    </form>
    {message && <p role="status" className="notice">{message}</p>}
    <div className="flex flex-wrap gap-2 mt-4">
      <button onClick={() => { setMode(mode === 'signup' ? 'login' : 'signup'); setMessage('') }}>{mode === 'signup' ? '回到登入' : '註冊帳號'}</button>
      <button onClick={() => { setMode(mode === 'forgot' ? 'login' : 'forgot'); setMessage('') }}>{mode === 'forgot' ? '回到登入' : '忘記密碼'}</button>
    </div>
  </section>
}
export function PasswordReset({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true)
    try {
      const { error } = await supabase!.auth.updateUser({ password })
      if (error) throw error
      window.history.replaceState(null, '', '/')
      onDone()
    } catch (error) { setMessage(error instanceof Error ? error.message : '密碼更新失敗，請重試') }
    finally { setBusy(false) }
  }
  return <section className="panel"><h2>設定新密碼</h2><form onSubmit={submit}>
    <label>新密碼<input type="password" required minLength={8} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} disabled={busy} /></label>
    <button className="primary" disabled={busy}>更新密碼</button>
  </form>{message && <p role="alert">{message}</p>}</section>
}
