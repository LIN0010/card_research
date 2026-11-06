import { useState, type FormEvent } from 'react'
import type { DataSet, Machine, Store } from '../../lib/types'
import type { Mutate } from '../../lib/useCommands'

interface Props { data: DataSet; mutate: Mutate; busy: boolean; onMachine: (id: string) => void }
export function Management({ data, mutate, busy, onMachine }: Props) {
  const [storeEdit, setStoreEdit] = useState<Store | null>(null)
  const [machineEdit, setMachineEdit] = useState<Machine | null>(null)
  async function saveStore(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const values = new FormData(form)
    try {
      await mutate(storeEdit ? 'update_store' : 'create_store', { ...(storeEdit ? { id: storeEdit.id } : {}), name: String(values.get('name')), location: String(values.get('location')) })
      setStoreEdit(null); form.reset()
    } catch { /* Keep user input. The command status is displayed by App. */ }
  }
  async function saveMachine(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const values = new FormData(form)
    try {
      const result = await mutate(machineEdit ? 'update_machine' : 'create_machine', {
        ...(machineEdit ? { id: machineEdit.id } : { store_id: String(values.get('store_id')) }),
        machine_name: String(values.get('machine_name')), game_version: String(values.get('game_version')),
      })
      setMachineEdit(null); form.reset(); onMachine(result.id)
    } catch { /* Keep user input. */ }
  }
  return <div className="grid gap-4 md:grid-cols-2">
    <section className="panel"><h2>店家管理</h2>
      <ul className="list">{data.stores.map(store => <li key={store.id}><span>{store.name}<small>{store.location}</small></span><button disabled={busy} onClick={() => setStoreEdit(store)}>編輯</button></li>)}</ul>
      <h3>{storeEdit ? '修改店家' : '新增店家'}</h3>
      <form key={storeEdit?.id ?? 'new-store'} onSubmit={saveStore}><fieldset disabled={busy}>
        <label>店家名稱<input name="name" required maxLength={100} defaultValue={storeEdit?.name} /></label>
        <label>店家位置（選填）<input name="location" maxLength={300} defaultValue={storeEdit?.location} /></label>
        <div className="actions"><button className="primary">{storeEdit ? '儲存店家' : '新增店家'}</button>{storeEdit && <button type="button" onClick={() => setStoreEdit(null)}>取消</button>}</div>
      </fieldset></form>
    </section>
    <section className="panel"><h2>機台管理</h2>
      <ul className="list">{data.machines.map(machine => <li key={machine.id}><span>{data.stores.find(s => s.id === machine.store_id)?.name}／{machine.machine_name}<small>{machine.game_version}</small></span><button disabled={busy} onClick={() => setMachineEdit(machine)}>編輯</button></li>)}</ul>
      <h3>{machineEdit ? '修改機台' : '新增機台'}</h3>
      {!data.stores.length && <p className="notice">請先新增店家。</p>}
      <form key={machineEdit?.id ?? 'new-machine'} onSubmit={saveMachine}><fieldset disabled={busy || !data.stores.length}>
        {!machineEdit && <label>所屬店家<select name="store_id" required defaultValue={data.stores[0]?.id}>{data.stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}
        <label>機台名稱<input name="machine_name" placeholder="例如：店內左台" required maxLength={100} defaultValue={machineEdit?.machine_name} /></label>
        <label>遊戲版本<input name="game_version" placeholder="例如：AP6" required maxLength={100} defaultValue={machineEdit?.game_version} /></label>
        <div className="actions"><button className="primary">{machineEdit ? '儲存機台' : '新增機台'}</button>{machineEdit && <button type="button" onClick={() => setMachineEdit(null)}>取消</button>}</div>
      </fieldset></form>
    </section>
  </div>
}
