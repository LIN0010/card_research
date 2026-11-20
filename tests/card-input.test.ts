import { expect, it } from 'vitest'
import { applyCardPrefix, versionPrefix } from '../src/lib/cardInput'

it('offers prefixes only for explicit code-like versions', () => {
  expect(versionPrefix('AP6')).toBe('AP6-')
  expect(versionPrefix('A06-')).toBe('A06-')
  expect(versionPrefix('第六彈')).toBe('')
  expect(versionPrefix('')).toBe('')
})
it('preserves full codes and original whitespace when using a shortcut', () => {
  expect(applyCardPrefix('', 'AP6-')).toBe('AP6-')
  expect(applyCardPrefix('14P', 'AP6-')).toBe('AP6-14P')
  expect(applyCardPrefix('AP6-049', 'AP6-')).toBe('AP6-049')
  expect(applyCardPrefix('A06-001', 'AP6-')).toBe('A06-001')
  expect(applyCardPrefix(' 049 ', 'AP6-')).toBe(' 049 ')
  expect(applyCardPrefix('0'.repeat(64), 'AP6-')).toBe('0'.repeat(64))
})
