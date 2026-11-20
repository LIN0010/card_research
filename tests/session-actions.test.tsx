// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionActions } from '../src/features/recording/SegmentControls'
import type { Segment } from '../src/lib/types'

const segment: Segment = {
  id: 'existing-segment', owner_id: 'owner', machine_id: 'machine', game_version: 'AP6', label: '既有紀錄', notes: '',
  started_at: '2026-11-21T01:00:00Z', created_at: '2026-11-21T01:00:00Z', ended_at: null, last_draw_index: 12,
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('describes continuity and retains the existing next-game command', async () => {
  const user = userEvent.setup()
  const mutate = vi.fn().mockResolvedValue({ id: 'next-game' })
  render(<SessionActions segment={segment} mutate={mutate} busy={false} />)
  const next = screen.getByRole('button', { name: '下一局（卡序延續）' })
  expect(next).toHaveAccessibleDescription('同一台機器繼續遊玩，中間沒有其他人抽卡。')
  expect(screen.getByRole('button', { name: '結束本次紀錄' })).toHaveAccessibleDescription('離開、換機台或其他玩家接手時使用。')
  await user.click(next)
  expect(mutate).toHaveBeenCalledExactlyOnceWith('start_game', { segment_id: segment.id })
})

it('does not end a record when confirmation is cancelled and sends the existing command only after approval', async () => {
  const user = userEvent.setup()
  const mutate = vi.fn().mockResolvedValue({ id: segment.id })
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
  render(<SessionActions segment={segment} mutate={mutate} busy={false} />)
  await user.click(screen.getByRole('button', { name: '結束本次紀錄' }))
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('確定要結束本次紀錄嗎？'))
  expect(mutate).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '結束本次紀錄' }))
  expect(mutate).toHaveBeenCalledExactlyOnceWith('close_segment', { segment_id: segment.id })
})
