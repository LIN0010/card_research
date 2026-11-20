# 永久刪除、舊資料清理與卡號未知

## 必須手動執行的 SQL

**已經使用 MVP 資料庫的專案，只執行這個新檔案全文一次：**

`supabase/migrations/202611210001_permanent_delete_unknown_cards.sql`

1. 在 Supabase SQL Editor 使用 `postgres` 角色。
2. 確認是正確專案，依一般資料庫變更流程保留必要備份，再執行上述新 migration 的全文。
3. 不要重新執行 `202611060001_mvp.sql`，也不要執行舊 draft。若新 migration 出錯，交易會回滾；先檢查錯誤，不能只貼一部分繼續。
4. 建議先執行新 migration，再部署／合併新版前端並重新整理頁面。舊版頁面的新撤銷操作會被伺服器拒絕，提示重新整理，避免再產生 soft delete。
5. **migration 不會自動永久清掉舊撤銷紀錄。** 套用後，登入各自帳號，在「歷史紀錄」的清理區檢查筆數，按「永久清理舊撤銷紀錄」並確認後才會刪除。清完即不再顯示此入口。

若是真正全新的空白專案，先執行最初的 MVP migration 一次，再執行本次 migration 一次。已套用舊 migration 的專案不可重跑初始化。

## 刪除的資料範圍

- 卡片的「刪除」及「刪除上一筆」都會先要求確認，明示永久刪除、無法復原。API 另外要求 confirmed=true、本人身分及正確 revision。
- 真正執行 DELETE，移除 draws 資料列、此筆卡片的所有公開 audit_events，以及私有操作結果中的完整卡片快照。
- 私有重試紀錄不再保存原始 request body，只保存摘要及必要識別資訊；升級時也會將舊 request body 改為摘要／metadata。
- 刪除後，過去新增／修改請求的快取結果只剩 ID 與 deleted=true，不能再取得原卡號、稀有度、來源等完整資料。
- 已刪 UUID 的最小 private tombstone 只有 id、owner_id，用於阻止延遲請求或換 operation ID 還原同一筆紀錄。它不是出卡紀錄或可供閱讀的稽核快照。帳號刪除時此 metadata 亦會 cascade 清除。
- 刪除本身不新增帶卡片內容的公開稽核事件；清理舊資料的結果只保留筆數等最小重試回應。
- 對 draws 設 DELETE trigger，管理員直接 DELETE 時也會清除對應的應用快照。沒有授權 authenticated／anon 直接寫入資料表或讀取 private schema。
- 所有刪除依 UUID／owner_id，不能以卡號或店名刪除，其他同卡號紀錄及不同類型的同 UUID 資料不受影響。

這裡的永久刪除指線上業務資料表、應用稽核與重試快取。它不是磁碟安全抹除；Supabase 的備份、WAL／平台日誌保留由平台管理，先前已下載的匯出檔也不會被遠端撤回。

## 序號與缺口

- 原始 draw_index 永不重新編號，場次 last_draw_index 不回退。
- 新增 cartridges.last_side_index，升級時從包括舊撤銷列在內的原始側序初始化；之後原子遞增，不再使用現存資料 max()+1，因此刪除最後一筆或全部紀錄都不會重用側序。
- 清單主序號統一顯示原始全域位置。原始側序與修正來源仍可在詳細資料查看，不混當成目前的連續排名。
- 例如原始 1、2、3 刪除 2 後，顯示 1、3 並提示缺口 #2，不能把兩筆拼成連續序列。尾端或整段已刪也會依 last_draw_index 顯示缺口。
- 舊 deleted_at 欄位只保留作為尚未確認清理的舊資料標記，新 API 不再提供 soft delete。歷史頁沒有「包含已撤銷紀錄」選項，也不列出這些舊卡片內容。

## 卡號未知

「卡號未知」代表確定有出卡、只是忘記編號。它會建立正常 draws 列，`card_number_unknown=true`、`card_number=NULL`，佔用真正的 draw_index／side_index，不使用假的卡號文字。

來源及稀有度仍可依實際情況選擇；來源不明與卡號未知是不同概念。之後可以修改並補回卡號，原始出卡位置不變。未知卡號不是可跳過的空白，後續分析也不能把它兩側的已知卡片當成完整相鄰樣本。本次沒有新增任何拼接或預測功能。

## 匯出與驗證

JSON schema_version 升為 2，保留 card_number_unknown 及 NULL。CSV 新增未知標記、sequence_gap_before、segment_last_draw_index，僅保留原始位置，移除會壓縮序列的有效顯示編號。尾端缺口可由原始位置與場次計數辨識。

舊撤銷列不包含在一般匯出；JSON 亦排除不對應有效卡片的專屬稽核，避免孤立快照外洩。有效卡片的操作歷史仍保留。

測試包含舊 MVP → 新 migration 的升級、未確認不清理、刪除後快照抹除、同號其他卡片不受影響、UUID 重用防護、斷線重試、資料隔離、帳號 cascade、原始序號不重用及未知卡號位置。E2E 使用本機 PGlite／測試 Auth 與 HTTP adapter，不能代替託管 Supabase 驗收。
