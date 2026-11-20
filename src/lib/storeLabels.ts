import type { Machine, Store } from './types'

export function storeLocation(location: string | null | undefined): string {
  return location?.trim() || '未設定地點'
}
export function storeLabel(store?: Pick<Store, 'name' | 'location'>): string {
  return `${store?.name ?? '未知店家'} · ${storeLocation(store?.location)}`
}
export function machineLabel(machine: Machine, store?: Store): string {
  return `${storeLabel(store)}／${machine.machine_name} · ${machine.game_version}`
}
function duplicateComparison(text: string): string {
  return text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
}
// A creation warning only. Never use this comparison for joins, grouping or IDs,
// and never normalize the actual values sent to the database.
export function findPotentialDuplicateStore(stores: Store[], name: string, location: string): Store | undefined {
  return stores.find(store => duplicateComparison(store.name) === duplicateComparison(name)
    && duplicateComparison(store.location ?? '') === duplicateComparison(location))
}
