import { beforeEach, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc } }))
import { CommandError, repository } from '../src/lib/repository'

beforeEach(() => { rpc.mockReset() })
it('rejects a stale append acknowledgement for a deleted draw, while accepting an idempotent delete acknowledgement', async () => {
  rpc.mockResolvedValue({ data: { id: 'deleted-id', deleted: true }, error: null })
  try {
    await repository.command('append-op', 'append_draw', { id: 'deleted-id' })
    throw new Error('A deleted append must not be reported as saved')
  } catch (error) {
    expect(error).toBeInstanceOf(CommandError)
    expect(error).toMatchObject({ uncertain: false })
    expect((error as Error).message).toContain('已永久刪除')
  }
  expect(await repository.command('delete-op', 'delete_draw', { id: 'deleted-id', confirmed: true })).toMatchObject({ id: 'deleted-id', deleted: true })
})
