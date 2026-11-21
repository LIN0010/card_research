import type { DataSet } from '../../lib/types'
import type { Mutate } from '../../lib/useCommands'

export function LegacyCleanup({ data, mutate, busy }: { data: DataSet; mutate: Mutate; busy: boolean }) {
  const count = data.draws.filter(draw => !!draw.deleted_at).length
  if (!count) return null
  return <section className="legacy-cleanup" aria-label="舊撤銷紀錄清理"><h3>舊撤銷紀錄待清理 · {count} 筆</h3>
    <p>舊版保留的撤銷資料不列入歷史清單。確認清理後，將永久刪除這些出卡、專屬稽核與重試快取中的卡片資料；有效紀錄不受影響。</p>
    <button disabled={busy} onClick={() => {
      if (window.confirm(`確認永久清理本人 ${count} 筆舊撤銷紀錄？\n出卡紀錄、專屬操作歷史及快取中的卡片資料將永久移除，無法復原；不會刪除有效紀錄。`)) {
        void mutate('purge_legacy_voids', { confirmed: true, expected_count: count }).catch(() => {})
      }
    }}>永久清理舊撤銷紀錄</button>
  </section>
}
