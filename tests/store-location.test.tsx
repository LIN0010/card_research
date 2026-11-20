// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import { MachineOptions } from '../src/components/MachineOptions'
import { Management } from '../src/features/management/Management'
import { findPotentialDuplicateStore, storeLabel, storeLocation } from '../src/lib/storeLabels'
import { emptyData, type Store } from '../src/lib/types'

const owned = { owner_id: 'owner', created_at: '2026-11-21T01:00:00Z' }
function fixture() {
  const data = emptyData()
  data.stores = [
    { ...owned, id: 'store-taipei', name: '星光館', location: '台北信義' },
    { ...owned, id: 'store-kaohsiung', name: '星光館', location: '高雄左營' },
    { ...owned, id: 'store-unspecified', name: '星光館', location: '   ' },
  ]
  data.machines = data.stores.map(store => ({ ...owned, id: `machine-${store.id}`, store_id: store.id, machine_name: '店內左台', game_version: 'AP6' }))
  return data
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('labels empty or whitespace-only locations without changing stored text', () => {
  const store = fixture().stores[2]
  expect(storeLocation(null)).toBe('未設定地點')
  expect(storeLocation(undefined)).toBe('未設定地點')
  expect(storeLocation('')).toBe('未設定地點')
  expect(storeLabel(store)).toBe('星光館 · 未設定地點')
  expect(store.location).toBe('   ')
})
it('compares both name and location only for a duplicate warning', () => {
  const stores: Store[] = [{ ...owned, id: 'original-id', name: ' Card Shop ', location: '台北 信義' }]
  expect(findPotentialDuplicateStore(stores, 'Ｃａｒｄ Ｓｈｏｐ', ' 台北   信義 ')).toBe(stores[0])
  expect(findPotentialDuplicateStore(stores, 'Card Shop', '高雄')).toBeUndefined()
  const unspecified = fixture().stores[2]
  expect(findPotentialDuplicateStore([unspecified], '星光館', '')).toBe(unspecified)
  expect(stores[0]).toMatchObject({ id: 'original-id', name: ' Card Shop ', location: '台北 信義' })
})
it('keeps separate ID groups and option values even when names and locations collide', async () => {
  const user = userEvent.setup()
  const data = fixture()
  const duplicate = { ...data.stores[0], id: 'another-id' }
  data.stores.push(duplicate)
  data.machines.push({ ...data.machines[0], id: 'another-machine-id', store_id: duplicate.id })
  const onChange = vi.fn()
  const { container } = render(<select aria-label="測試機台" onChange={event => onChange(event.target.value)}><MachineOptions stores={data.stores} machines={data.machines} /></select>)
  expect(container.querySelectorAll('optgroup')).toHaveLength(4)
  expect(screen.getAllByRole('option', { name: '星光館 · 台北信義／店內左台 · AP6' })).toHaveLength(2)
  expect(screen.getByRole('option', { name: '星光館 · 高雄左營／店內左台 · AP6' })).toHaveValue('machine-store-kaohsiung')
  expect(screen.getByRole('option', { name: '星光館 · 未設定地點／店內左台 · AP6' })).toBeInTheDocument()
  await user.selectOptions(screen.getByLabelText('測試機台'), 'another-machine-id')
  expect(onChange).toHaveBeenCalledExactlyOnceWith('another-machine-id')
})
it('warns before creating the same branch, keeps cancelled input and allows explicit confirmation', async () => {
  const user = userEvent.setup()
  const mutate = vi.fn().mockResolvedValue({ id: 'new-id' })
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
  render(<Management data={fixture()} mutate={mutate} busy={false} onMachine={vi.fn()} />)
  await user.type(screen.getByLabelText('店家名稱'), ' 星光館 ')
  await user.type(screen.getByLabelText('店家位置（選填）'), ' 台北信義 ')
  await user.click(screen.getByRole('button', { name: '新增店家' }))
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('可能重複建立'))
  expect(mutate).not.toHaveBeenCalled()
  expect(screen.getByLabelText('店家名稱')).toHaveValue(' 星光館 ')
  await user.click(screen.getByRole('button', { name: '新增店家' }))
  expect(mutate).toHaveBeenCalledExactlyOnceWith('create_store', { name: ' 星光館 ', location: ' 台北信義 ' })
})
it('allows a same-name store in a different location without a duplicate confirmation', async () => {
  const user = userEvent.setup()
  const mutate = vi.fn().mockResolvedValue({ id: 'taichung-id' })
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  render(<Management data={fixture()} mutate={mutate} busy={false} onMachine={vi.fn()} />)
  await user.type(screen.getByLabelText('店家名稱'), '星光館')
  await user.type(screen.getByLabelText('店家位置（選填）'), '台中西屯')
  await user.click(screen.getByRole('button', { name: '新增店家' }))
  expect(confirm).not.toHaveBeenCalled()
  expect(mutate).toHaveBeenCalledExactlyOnceWith('create_store', { name: '星光館', location: '台中西屯' })
})
it('creates machines using the selected store ID, not its shared name', async () => {
  const user = userEvent.setup()
  const mutate = vi.fn().mockResolvedValue({ id: 'new-machine' })
  const onMachine = vi.fn()
  render(<Management data={fixture()} mutate={mutate} busy={false} onMachine={onMachine} />)
  await user.selectOptions(screen.getByLabelText('所屬店家'), 'store-kaohsiung')
  await user.type(screen.getByLabelText('機台名稱'), '店內右台')
  await user.type(screen.getByLabelText('遊戲版本'), 'AP6')
  await user.click(screen.getByRole('button', { name: '新增機台' }))
  expect(mutate).toHaveBeenCalledExactlyOnceWith('create_machine', { store_id: 'store-kaohsiung', machine_name: '店內右台', game_version: 'AP6' })
  expect(onMachine).toHaveBeenCalledWith('new-machine')
})
