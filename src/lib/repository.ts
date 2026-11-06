import { supabase } from './supabase'
import type { CommandAction, DataSet, Json, Payload } from './types'

export class CommandError extends Error {
  constructor(message: string, public readonly uncertain: boolean) { super(message) }
}
export interface Repository {
  load: () => Promise<DataSet>
  command: (operationId: string, action: CommandAction, payload: Payload) => Promise<{ id: string }>
}

async function readAll<K extends keyof DataSet>(table: K): Promise<DataSet[K]> {
  if (!supabase) throw new Error('尚未設定 Supabase')
  const rows: unknown[] = []
  // PostgREST limits each response. Never silently export only the first page.
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await supabase.from(table).select('*').order('id').range(offset, offset + 499)
    if (error) throw new Error(error.message)
    rows.push(...data)
    if (data.length < 500) break
  }
  return rows as DataSet[K]
}
export const repository: Repository = {
  async load() {
    const [stores, machines, observation_segments, games, cartridges, draws, audit_events] = await Promise.all([
      readAll('stores'), readAll('machines'), readAll('observation_segments'), readAll('games'), readAll('cartridges'), readAll('draws'), readAll('audit_events'),
    ])
    return { stores, machines, observation_segments, games, cartridges, draws, audit_events }
  },
  async command(operationId, action, payload) {
    if (!supabase) throw new CommandError('尚未設定 Supabase', false)
    const { data, error } = await supabase.rpc('apply_command', { p_operation_id: operationId, p_action: action, p_payload: payload as Json })
    if (error) {
      // A SQL/PostgREST rejection has a structured code. A transport failure may have
      // occurred after commit; preserve the same operation ID for safe retries.
      throw new CommandError(error.message, !error.code || !/^(?:[0-9A-Z]{5}|PGRST\d+)$/.test(error.code))
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.id !== 'string') {
      throw new CommandError('回應格式不完整，請重試確認儲存結果', true)
    }
    return data as { id: string }
  },
}
