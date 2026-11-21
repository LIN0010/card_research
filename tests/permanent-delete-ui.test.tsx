// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import { DrawList } from '../src/features/history/DrawList'
import { LegacyCleanup } from '../src/features/history/LegacyCleanup'
import { SequenceGaps } from '../src/features/history/SequenceGaps'
import { emptyData, type Draw } from '../src/lib/types'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
function fixture() {
  const data = emptyData()
  data.observation_segments = [{ id: 'segment', owner_id: 'owner', created_at: '', machine_id: 'machine', game_version: 'AP6', label: '原始紀錄', notes: '', started_at: '', ended_at: null, last_draw_index: 3 }]
  data.draws = [{ id: 'draw', owner_id: 'owner', created_at: '', segment_id: 'segment', game_id: 'game', draw_index: 3, side: 'left', cartridge_id: null, recorded_side: 'left', recorded_cartridge_id: null, side_index: 3, card_number: '049', card_number_unknown: false, rarity: 'normal', recorded_at: '', updated_at: '', revision: 2, deleted_at: null } satisfies Draw]
  return data
}
it('retains original visible indices and confirms a permanent delete before sending identifiers only', async () => {
  const user = userEvent.setup(); const data = fixture()
  const mutate = vi.fn().mockResolvedValue({ id: 'draw' })
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
  render(<DrawList draws={data.draws} data={data} mutate={mutate} busy={false} compact />)
  expect(screen.getByLabelText('原始序號 3')).toHaveTextContent('03')
  await user.click(screen.getByLabelText('卡片 049 的更多操作'))
  await user.click(screen.getByRole('button', { name: '刪除' }))
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('永久刪除'))
  expect(mutate).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '刪除' }))
  expect(mutate).toHaveBeenCalledExactlyOnceWith('delete_draw', { id: 'draw', segment_id: 'segment', revision: 2, confirmed: true })
})
it('requires confirmation before one-time legacy cleanup and keeps active records outside that request', async () => {
  const user = userEvent.setup(); const data = fixture()
  data.draws.push({ ...data.draws[0], id: 'old', deleted_at: '2026-11-21T00:00:00Z' })
  const mutate = vi.fn().mockResolvedValue({ id: 'cleanup' })
  vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
  render(<LegacyCleanup data={data} mutate={mutate} busy={false} />)
  await user.click(screen.getByRole('button', { name: '永久清理舊撤銷紀錄' }))
  expect(mutate).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '永久清理舊撤銷紀錄' }))
  expect(mutate).toHaveBeenCalledExactlyOnceWith('purge_legacy_voids', { confirmed: true, expected_count: 1 })
})
it('reports real missing positions while an unknown card occupies its original slot', () => {
  const data = fixture()
  data.draws.unshift({ ...data.draws[0], id: 'unknown', draw_index: 1, side_index: 1, card_number: null, card_number_unknown: true })
  render(<SequenceGaps data={data} segmentId="segment" />)
  expect(screen.getByRole('note')).toHaveTextContent('缺口：#2')
  expect(screen.getByRole('note')).toHaveTextContent('不可視為連續卡序')
})
