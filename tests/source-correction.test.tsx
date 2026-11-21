// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import { SequenceView } from '../src/features/history/DrawList'
import { emptyData, type Draw } from '../src/lib/types'

afterEach(cleanup)
const timestamp = '2026-11-20T01:00:00.000Z'
function fixture() {
  const data = emptyData()
  const owned = { owner_id: 'owner', created_at: timestamp }
  data.stores = [{ ...owned, id: 'store', name: '店家', location: '' }]
  data.machines = [{ ...owned, id: 'machine', store_id: 'store', machine_name: '左台', game_version: 'AP6' }]
  data.observation_segments = [{ ...owned, id: 'segment', machine_id: 'machine', game_version: 'AP6', label: '連續觀測', notes: '', started_at: timestamp, ended_at: null, last_draw_index: 3 }]
  data.games = [1, 2].map(index => ({ ...owned, id: `game-${index}`, segment_id: 'segment', game_index: index, started_at: timestamp, ended_at: null }))
  data.cartridges = (['left', 'right'] as const).map(side => ({ ...owned, id: `${side}-batch`, segment_id: 'segment', side, batch_index: 1, starts_at_index: 1, last_side_index: side === 'left' ? 2 : 1, certainty: 'uncertain', note: '' }))
  function draw(values: Partial<Draw>): Draw {
    return { ...owned, id: 'moved', segment_id: 'segment', game_id: 'game-1', draw_index: 1,
      side: 'right', cartridge_id: 'right-batch', recorded_side: 'left', recorded_cartridge_id: 'left-batch', side_index: 1,
      card_number: 'AP6-049', card_number_unknown: false, rarity: 'normal', recorded_at: timestamp, updated_at: timestamp, revision: 2, deleted_at: null, ...values }
  }
  // The corrected first draw must precede an existing right draw, despite both
  // having original side_index=1 allocated on different original cartridges.
  const moved = draw({})
  data.draws = [
    draw({ id: 'remaining-left', game_id: 'game-2', draw_index: 3, side: 'left', cartridge_id: 'left-batch', side_index: 2, card_number: 'AP6-022', revision: 1 }),
    draw({ id: 'existing-right', draw_index: 2, recorded_side: 'right', recorded_cartridge_id: 'right-batch', card_number: 'A06-001', revision: 1 }),
    moved,
  ]
  const original = { ...moved, side: 'left', cartridge_id: 'left-batch', revision: 1 }
  // Transaction timestamps can tie; REST pagination returns UUID order, not
  // revision order. Put revision 2 first to reproduce the misleading audit order.
  data.audit_events = [
    { ...owned, id: 'a-edit', operation_id: 'edit', entity_type: 'draws', entity_id: moved.id, action: 'update_draw', old_data: original, new_data: { ...moved } },
    { ...owned, id: 'b-create', operation_id: 'create', entity_type: 'draws', entity_id: moved.id, action: 'append_draw', old_data: null, new_data: original },
  ]
  return data
}

it('shows corrected left/right order while retaining original-source audit fields', async () => {
  const user = userEvent.setup()
  const data = fixture()
  const { container } = render(<SequenceView segmentId="segment" data={data} mutate={vi.fn()} busy={false} />)
  const left = screen.getByRole('region', { name: '左卡匣序列' })
  const right = screen.getByRole('region', { name: '右卡匣序列' })
  expect([...left.querySelectorAll('.card-number')].map(el => el.textContent)).toEqual(['AP6-022'])
  expect([...right.querySelectorAll('.card-number')].map(el => el.textContent)).toEqual(['AP6-049', 'A06-001'])
  expect(right.querySelector('.sequence-no')).toHaveTextContent('01')
  expect(right.querySelector('.source-correction')).not.toBeVisible()
  await user.click(screen.getByLabelText('卡片 AP6-049 的更多操作'))
  await user.click(right.querySelector('.draw-details > summary')!)
  expect(left.querySelector('.draw-item')).toHaveTextContent('原始 #3 · 第 2 局 · 目前來源：左')
  expect(right.querySelectorAll('.draw-item')[0]).toHaveTextContent('原始 #1 · 第 1 局 · 目前來源：右')
  expect(right.querySelectorAll('.draw-item')[1]).toHaveTextContent('原始 #2 · 第 1 局 · 目前來源：右')
  expect(right.querySelectorAll('.draw-item')[0]).toHaveTextContent('原始側序：左批次 1 #1')
  expect(right.querySelector('.source-correction')).toBeVisible()
  expect(data.draws.find(d => d.id === 'moved')).toMatchObject({ draw_index: 1, recorded_side: 'left', side_index: 1, side: 'right' })
})

it('orders source-correction audit entries by revision when timestamps tie', () => {
  const { container } = render(<SequenceView segmentId="segment" data={fixture()} mutate={vi.fn()} busy={false} />)
  const events = container.querySelectorAll('[data-draw-id="moved"] .audit > ul > li')
  expect(events).toHaveLength(2)
  expect(events[0]).toHaveTextContent('新增出卡')
  expect(events[1]).toHaveTextContent('修改出卡')
})
