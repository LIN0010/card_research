import { machineLabel, storeLabel } from '../lib/storeLabels'
import type { Machine, Store } from '../lib/types'

export function MachineOptions({ machines, stores }: { machines: Machine[]; stores: Store[] }) {
  const storesById = new Map(stores.map(store => [store.id, store]))
  const groups = new Map<string, Machine[]>()
  for (const machine of machines) {
    const group = groups.get(machine.store_id) ?? []
    group.push(machine)
    groups.set(machine.store_id, group)
  }
  // Same names, locations or machine labels never collapse distinct records.
  return <>{[...groups].map(([storeId, group]) => <optgroup key={storeId} label={storeLabel(storesById.get(storeId))}>
    {group.map(machine => <option key={machine.id} value={machine.id}>{machineLabel(machine, storesById.get(storeId))}</option>)}
  </optgroup>)}</>
}
