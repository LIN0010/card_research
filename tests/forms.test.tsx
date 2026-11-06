// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DrawForm } from '../src/features/recording/DrawForm'
import { CommandError, type Repository } from '../src/lib/repository'
import { useCommands } from '../src/lib/useCommands'

afterEach(cleanup)
const formProps = { segmentId: 'segment', gameId: 'game', gameIndex: 1, busy: false }
it('preserves card text, suggests signature and allows a manual rarity override', async () => {
  const user = userEvent.setup()
  const mutate = vi.fn().mockResolvedValue({ id: 'saved' })
  render(<DrawForm {...formProps} mutate={mutate} />)
  await user.type(screen.getByLabelText('卡片編號'), 'AP6-14P')
  expect(screen.getByLabelText('稀有度')).toHaveValue('signature')
  await user.selectOptions(screen.getByLabelText('稀有度'), 'four_star')
  await user.click(screen.getByRole('radio', { name: '右卡匣' }))
  await user.click(screen.getByRole('button', { name: '儲存右卡匣出卡' }))
  expect(mutate).toHaveBeenCalledWith('append_draw', expect.objectContaining({ card_number: 'AP6-14P', side: 'right', rarity: 'four_star' }))
  await waitFor(() => expect(screen.getByLabelText('卡片編號')).toHaveValue(''))
})
it('retains the exact input and rarity after a rejected save', async () => {
  const user = userEvent.setup()
  const mutate = vi.fn().mockRejectedValue(new CommandError('測試拒絕', false))
  render(<DrawForm {...formProps} mutate={mutate} />)
  await user.type(screen.getByLabelText('卡片編號'), ' A06-001 ')
  await user.selectOptions(screen.getByLabelText('稀有度'), 'four_star')
  await user.click(screen.getByRole('button', { name: '儲存來源不明出卡' }))
  await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1))
  expect(screen.getByLabelText('卡片編號')).toHaveValue(' A06-001 ')
  expect(screen.getByLabelText('稀有度')).toHaveValue('four_star')
})
it('prevents double submission while the original write is still pending', async () => {
  const mutate = vi.fn(() => new Promise<{ id: string }>(() => {}))
  render(<DrawForm {...formProps} mutate={mutate} />)
  fireEvent.change(screen.getByLabelText('卡片編號'), { target: { value: '049' } })
  fireEvent.click(screen.getByRole('button', { name: '儲存來源不明出卡' }))
  fireEvent.click(screen.getByRole('button', { name: '儲存來源不明出卡' }))
  expect(mutate).toHaveBeenCalledTimes(1)
})
function RetryHarness({ repo, refresh }: { repo: Repository; refresh: () => Promise<void> }) {
  const commands = useCommands(repo, refresh)
  return <><DrawForm {...formProps} busy={commands.busy} mutate={commands.mutate} />
    <p role="status">{commands.message}</p>{commands.needsRetry && <button onClick={commands.retry}>重試確認</button>}</>
}
describe('online write lifecycle', () => {
  it('retries an indeterminate result with identical operation ID and clears the form only after acknowledgement', async () => {
    const user = userEvent.setup()
    const command = vi.fn().mockRejectedValueOnce(new CommandError('fetch failed', true)).mockResolvedValueOnce({ id: 'draw' })
    const repo = { command, load: vi.fn() }
    render(<RetryHarness repo={repo} refresh={vi.fn().mockResolvedValue(undefined)} />)
    await user.type(screen.getByLabelText('卡片編號'), '049')
    await user.click(screen.getByRole('button', { name: '儲存來源不明出卡' }))
    expect(screen.getByLabelText('卡片編號')).toHaveValue('049')
    expect(screen.getByLabelText('卡片編號')).toBeDisabled()
    await user.click(await screen.findByRole('button', { name: '重試確認' }))
    await waitFor(() => expect(screen.getByLabelText('卡片編號')).toHaveValue(''))
    expect(command).toHaveBeenCalledTimes(2)
    expect(command.mock.calls[0]).toEqual(command.mock.calls[1])
  })
  it('does not resubmit a committed write when refreshing the list fails', async () => {
    const user = userEvent.setup()
    const command = vi.fn().mockResolvedValue({ id: 'draw' })
    render(<RetryHarness repo={{ command, load: vi.fn() }} refresh={vi.fn().mockRejectedValue(new Error('read failed'))} />)
    await user.type(screen.getByLabelText('卡片編號'), '049')
    await user.click(screen.getByRole('button', { name: '儲存來源不明出卡' }))
    await waitFor(() => expect(screen.getByLabelText('卡片編號')).toHaveValue(''))
    expect(screen.getByRole('status')).toHaveTextContent('已儲存至 Supabase，但清單更新失敗')
    expect(command).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: '重試確認' })).not.toBeInTheDocument()
  })
})
