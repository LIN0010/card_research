import { useRef, useState } from 'react'
import { CommandError, type Repository } from './repository'
import type { CommandAction, Payload } from './types'

export type Mutate = (action: CommandAction, payload: Payload) => Promise<{ id: string }>
interface Pending {
  id: string; action: CommandAction; payload: Payload
  resolve: (value: { id: string }) => void; reject: (error: Error) => void
}
export function useCommands(repo: Repository, refresh: () => Promise<void>) {
  const current = useRef<Pending | null>(null)
  const inFlight = useRef(false)
  const [sending, setSending] = useState(false)
  const [needsRetry, setNeedsRetry] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function send(pending: Pending) {
    if (inFlight.current) return
    inFlight.current = true; setSending(true); setNeedsRetry(false); setError(''); setMessage('儲存中…')
    try {
      const result = await repo.command(pending.id, pending.action, pending.payload)
      current.current = null
      setMessage('已儲存至 Supabase')
      // A refresh failure after commit is not a write failure. Never resubmit it.
      try { await refresh() } catch { setMessage('已儲存至 Supabase，但清單更新失敗，請按「重新讀取」。') }
      pending.resolve(result)
    } catch (cause) {
      const failure = cause instanceof Error ? cause : new Error('儲存失敗')
      setError(failure.message)
      if (!(failure instanceof CommandError) || failure.uncertain) {
        setMessage('無法確認是否已儲存。輸入仍保留，請重試同一筆操作。')
        setNeedsRetry(true)
        // Keep the original caller awaiting. A successful retry resolves that caller,
        // so its form clears exactly once, including an indeterminate first response.
      } else {
        current.current = null; setMessage('未儲存，請修正後再送出。'); pending.reject(failure)
      }
    } finally { inFlight.current = false; setSending(false) }
  }
  const mutate: Mutate = (action, payload) => {
    if (current.current) return Promise.reject(new Error('請先確認上一筆儲存結果'))
    return new Promise((resolve, reject) => {
      const pending = { id: crypto.randomUUID(), action, payload, resolve, reject }
      current.current = pending
      void send(pending)
    })
  }
  return {
    mutate, sending, needsRetry, message, error,
    retry: () => { if (current.current) void send(current.current) },
    busy: sending || needsRetry,
  }
}
