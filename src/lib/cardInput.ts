// Input assistance only: never infer a game's card format or rewrite stored data.
export function versionPrefix(version: string): string {
  const text = version.trim()
  return /^[a-z][a-z0-9]{0,15}-?$/i.test(text) ? `${text.replace(/-$/, '')}-` : ''
}
export function applyCardPrefix(card: string, prefix: string): string {
  if (!prefix) return card
  if (!card) return prefix
  // Explicitly preserve full numbers, arbitrary text, and intentional whitespace.
  const result = /^\d[a-z0-9]*$/i.test(card) ? `${prefix}${card}` : card
  return result.length <= 64 ? result : card
}
