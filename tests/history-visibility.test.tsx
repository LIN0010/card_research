// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import { History } from '../src/features/history/History'
import { emptyData, type Draw } from '../src/lib/types'

afterEach(cleanup)
const owned = { owner_id: 'owner', created_at: '2026-11-21T00:00:00Z' }
function fixture() {
  const data = emptyData()
  data.observation_segments = [
    { ...owned, id: 'populated', machine_id: 'machine', game_version: 'AP6', label: '仍有卡片', notes: '', started_at: owned.created_at, ended_at: owned.created_at, last_draw_index: 3 },
    { ...owned, id: 'closed-empty', machine_id: 'machine', game_version: 'AP6', label: '已結束空場次', notes: '', started_at: owned.created_at, ended_at: owned.created_at, last_draw_index: 5 },
    { ...owned, id: 'open-empty', machine_id: 'machine', game_version: 'AP6', label: '進行中空場次', notes: '', started_at: owned.created_at, ended_at: null, last_draw_index: 2 },
  ]
  data.games = [{ ...owned, id: 'game', segment_id: 'populated', game_index: 1, started_at: owned.created_at, ended_at: owned.created_at }]
  const draw: Draw = { ...owned, id: 'first', segment_id: 'populated', game_id: 'game', draw_index: 1, side: 'left', cartridge_id: null, recorded_side: 'left', recorded_cartridge_id: null, side_index: 1, card_number: 'AP6-049', card_number_unknown: false, rarity: 'normal', recorded_at: owned.created_at, updated_at: owned.created_at, revision: 1, deleted_at: null }
  data.draws = [draw, { ...draw, id: 'third', draw_index: 3, side_index: 3, card_number: null, card_number_unknown: true }]
  return data
}

it('hides empty-session warnings and closed empty options while retaining real gaps and unknown cards', async () => {
  const data = fixture()
  // Legacy revoked rows do not make an empty session populated.
  data.draws.push({ ...data.draws[0], id: 'legacy', segment_id: 'closed-empty', deleted_at: owned.created_at })
  const before = structuredClone(data)
  const mutate = vi.fn()
  render(<History data={data} mutate={mutate} busy={false} />)
  expect(screen.queryByRole('option', { name: /已結束空場次/ })).not.toBeInTheDocument()
  expect(screen.getByRole('option', { name: /進行中空場次/ })).toBeInTheDocument()
  expect(screen.getByRole('option', { name: /仍有卡片/ })).toBeInTheDocument()
  expect(screen.getAllByRole('note')).toHaveLength(1)
  expect(screen.getByRole('note')).toHaveTextContent('仍有卡片 · 原始序號缺口：#2。')
  expect(screen.getByText('卡號未知', { exact: true })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '永久清理舊撤銷紀錄' })).toBeInTheDocument()
  expect(data).toEqual(before)
  expect(mutate).not.toHaveBeenCalled()
})

it('shows only the history empty message when no valid draws remain', () => {
  const data = fixture()
  data.draws = []
  render(<History data={data} mutate={vi.fn()} busy={false} />)
  expect(screen.getByText('尚無抽卡紀錄', { exact: true })).toBeInTheDocument()
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  expect(screen.queryByRole('note')).not.toBeInTheDocument()
  expect(screen.queryByText(/符合.*筆/)).not.toBeInTheDocument()
  expect(screen.queryByText('尚無符合的紀錄。')).not.toBeInTheDocument()
  expect(screen.queryByText(/已結束空場次|進行中空場次|仍有卡片/)).not.toBeInTheDocument()
})

it('shows the same empty state when all remaining rows are legacy revoked cards', () => {
  const data = fixture()
  data.draws = data.draws.map(draw => ({ ...draw, deleted_at: owned.created_at }))
  render(<History data={data} mutate={vi.fn()} busy={false} />)
  expect(screen.getByText('尚無抽卡紀錄', { exact: true })).toBeInTheDocument()
  expect(screen.queryByRole('note')).not.toBeInTheDocument()
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  expect(screen.queryByText('AP6-049', { exact: true })).not.toBeInTheDocument()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})

it('does not mistake card-number search misses for deleted gaps or globally empty history', async () => {
  const user = userEvent.setup()
  render(<History data={fixture()} mutate={vi.fn()} busy={false} />)
  await user.type(screen.getByLabelText('搜尋卡號'), 'NO-MATCH')
  expect(screen.getByText('尚無符合的紀錄。')).toBeInTheDocument()
  expect(screen.queryByText('尚無抽卡紀錄')).not.toBeInTheDocument()
  expect(screen.getAllByRole('note')).toHaveLength(1)
  expect(screen.getByRole('note')).toHaveTextContent('原始序號缺口：#2。')
})

it('recovers session and game filters when deleting the last card hides a selected closed session', async () => {
  const user = userEvent.setup()
  const data = fixture()
  const mutate = vi.fn()
  const { rerender } = render(<History data={data} mutate={mutate} busy={false} />)
  await user.selectOptions(screen.getByLabelText('抽卡場次篩選'), 'populated')
  await user.selectOptions(screen.getByLabelText('遊戲局數篩選'), 'game')
  const updated = structuredClone(data)
  updated.draws = [{ ...data.draws[0], id: 'other', segment_id: 'open-empty', game_id: 'other-game', draw_index: 2, card_number: 'AP6-022' }]
  rerender(<History data={updated} mutate={mutate} busy={false} />)
  expect(screen.getByLabelText('抽卡場次篩選')).toHaveValue('')
  expect(screen.queryByLabelText('遊戲局數篩選')).not.toBeInTheDocument()
  expect(screen.queryByRole('option', { name: /仍有卡片/ })).not.toBeInTheDocument()
  expect(screen.getByText('AP6-022', { exact: true })).toBeInTheDocument()
  expect(screen.getByRole('note')).toHaveTextContent('進行中空場次 · 原始序號缺口：#1。')
  expect(mutate).not.toHaveBeenCalled()
})
