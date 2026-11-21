# 第一階段本機驗證紀錄

日期：2026-11-06（台北）。執行於本次雲端工作環境。

| 檢查 | 結果 | 範圍 |
| --- | --- | --- |
| npm run typecheck | 通過 | TypeScript 應用程式及測試型別 |
| npm run build | 通過 | Vite 正式建置；未設定 Supabase 時顯示設定提示 |
| npm test | 18 通過、0 失敗 | 11 PostgreSQL／RLS／交易、5 表單及寫入狀態、2 匯出／序號 |
| Chromium E2E | 2 通過、0 失敗 | 使用獨立正式編譯輸出、390×844 視窗與本機資料庫 |
| 開發伺服器啟動 | 通過 | HTTP 200、設定提示、360px 無橫向溢位、無瀏覽器執行錯誤 |
| git diff --check／新增檔空白檢查 | 通過 | 未發現空白格式錯誤 |

E2E 指令：`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:e2e`。

## 指定樣本

- 機台 A：第 1 局 049／022／14P；第 2 局 001。原始全域序號 1～4，左側原始序號 1～3，右側 1。14P 簽名、001 四星。
- 機台 B：第 1 局 050／046／034／030／049；第 2 局 033／016／035。原始全域序號 1～8；左側 050／030（1～2）；右側 046／034／049／033／016／035（1～6）。016 四星。
- 換局未重設卡序；兩台機台／兩段觀測各自獨立。
- 手機瀏覽器測試涵蓋新增店家機台、兩段觀測、上述樣本、刷新、登出再登入、修改、撤銷、JSON／CSV 真正下載與內容檢查。
- 額外測試在資料庫已提交新增後中斷 HTTP 回應，確認表單保留卡號，重試後資料庫仍只有 1 筆出卡與 1 筆新增事件。

## 尚未驗證

沒有設定實際 Supabase URL／publishable key，因此尚未驗證 Supabase 託管 Auth／PostgREST、驗證信、密碼重設信、實際託管資料持久化或 Vercel 發布。

PostgreSQL 測試使用 PGlite 執行真實 migration、PL/pgSQL、約束及 RLS，Auth 由最小測試 schema 提供。瀏覽器使用測試 HTTP adapter，並非對正式 Supabase 發送請求。未執行真正多資料庫連線的併發壓力測試。

請完成 docs/setup.md 的手動設定與實際 Supabase 驗收，再判定是否可以正式使用。

## 2026-11-20 來源修正與 migration 複查（台北）

- `npm test`：23 項通過、0 失敗（14 PostgreSQL／權限／交易、5 表單／寫入狀態、2 匯出、2 序列／稽核顯示）。
- `npm run build`：通過，包含 TypeScript 檢查。
- Chromium E2E：3 項通過、0 失敗；新增左改右後左右清單、重新整理與 JSON 稽核匯出驗證。
- 在空白本機 PostgreSQL 中重新執行原 migration。驗證同段跨局、修正到歷史右批次而非後來的新批次、反覆改為不明／左右、原始序號及來源保持不變。
- 驗證其他使用者讀不到出卡與操作歷史，也不能修正來源；authenticated 不可直接改寫 draws 或刪除 audit_events，沒有登入身分不能呼叫寫入。
- 重現並修正一項前端問題：操作時間戳相同時，舊排序可能把「修改」排在「新增」之前。現在按出卡 revision 排列，另明示來源修正與原始側序僅供稽核。
- 未發現指定來源修正路徑的 SQL 執行錯誤或 RLS 漏洞；`side_index` 本來就是原始配置，不能視為修正後側序。沒有修改 SQL schema，也沒有新增 patch migration。

全新且尚未執行 SQL 的 Supabase 專案，正式應執行 **supabase/migrations/202611060001_mvp.sql 的全部內容一次**。不要執行舊 draft。

這次仍使用 PGlite 與測試用 Auth／HTTP adapter，未連到使用者新建的 Supabase 專案；其託管 Auth、API 與實際資料儲存仍需依設定教學驗收。

## 2026-11-20 Card Research UI／UX 重構（台北）

- `npm test`：27 項通過、0 失敗。原有 PostgreSQL、權限、跨局順序、稽核及冪等重試測試保留；新增明確選擇來源、前綴快捷及完整卡號保留的驗證。
- `npm run build`：通過，包含 TypeScript 檢查。
- Chromium E2E：4 項通過、0 失敗。原有兩機台樣本、重新整理、重新登入、修改、撤銷、來源修正及 CSV／JSON 下載仍通過。
- 新增紀錄頁操作驗證：目前狀態、開始抽卡、左右雙欄、無預選來源、稀有度按鈕、P 字尾手動覆寫、成功後清空卡號與來源、不明來源、進階換批、下一局及結束抽卡。
- 在 320、360、390、768、1440px 寬度檢查無橫向溢位、左右雙欄與手機底部／桌面頂部導覽。已讀取並檢查手機及桌面截圖。
- 修正測試中發現的手機切換面板遮住關閉入口問題，並提供「完成切換」按鈕。
- 比對確認 schema／RLS／RPC、登入初始化、AuthPanel、資料載入／儲存、稽核排序與套件依賴均未變更。此次不需新增 migration。

上述瀏覽器測試仍使用本機 PGlite 與測試 HTTP adapter，不等於已部署至正式網站或已對託管 Supabase 完成驗證。

## 2026-11-21 底部操作提示（台北）

- 「下一局（卡序延續）」與「結束本次紀錄」各自附上使用時機；手機版說明置於對應按鈕下方，維持淡紫／淡藍／奶白配色。
- 結束前的確認視窗會提醒何時應使用下一局；單元測試與實際瀏覽器確認「取消」不會送出結束指令、改變 ended_at 或新增結束操作紀錄，確認後才結束。
- `npm test`：29 項通過；`npm run build`：通過；Chromium E2E：4 項通過。
- 檢查 320、360、390、768、1440px 的說明排列及無橫向溢位，並讀取手機截圖；兩段說明均位於各自按鈕下方。
- 原卡序邏輯、寫入指令、資料庫、登入及其他功能未變更，不需 migration。瀏覽器測試仍使用本機 PGlite／測試傳輸層，未發布正式網站。

## 2026-11-21 店家地點與機台辨識（台北）

- `npm test`：35 項通過；`npm run build`：通過；Chromium E2E：5 項通過。
- 新增同名不同地點、未設定地點、同名同地點仍保留各自 ID 的分組／選取測試，並驗證建立機台傳送原 store ID。
- 驗證可能重複建立店家時可取消、保留輸入或確認繼續；不同地點的同名店家可直接新增。空白地點只顯示提示，不回寫提示文字。
- 瀏覽器以三家同名店家驗證目前狀態、分組選單、管理頁、歷史紀錄及篩選；實際查詢本機資料庫確認新增出卡與機台指向正確分店 ID。
- 檢查 320、390、1440px 下地點可見且無橫向溢位。既有 320–1440px 紀錄頁回歸流程仍通過。
- 未修改 schema、RLS、RPC、持久化、登入、原始序號、稽核排序及匯出格式；不需新的 SQL。

上述測試仍為本機 PGlite 與測試 Auth／HTTP adapter，並非託管 Supabase 或正式部署驗證。

## 2026-11-21 永久刪除與卡號未知（台北）

- `npm test`：50 項通過、0 失敗。包含 14 項原始 MVP migration 基準測試、10 項新 migration／永久刪除資料庫測試及 26 項前端／匯出測試。
- `npm run build`：通過，包含 TypeScript 檢查。
- Chromium E2E：7 項通過、0 失敗。原有操作、分店辨識、跨局順序及資料讀回回歸保留；新增刪除確認／回應斷線後重試、未知卡號佔位／補號、舊資料升級與確認清理流程。
- 在已有有效及舊撤銷資料的 PostgreSQL 執行新 migration，確認升級不自動刪除資料；確認清理後只移除本人舊資料，其他使用者與有效卡片保留。
- 驗證刪除後 draws 列與專屬 audit_events 消失，private request 不再保存原文，結果快照只保留 deleted metadata；重播原新增／修改請求不能取回卡片或還原同一 UUID。
- 驗證全域／側序在刪除最後一筆、全部紀錄及舊資料清理後均不回退；UI 保留 01、03 等原始位置並明示缺口，未知卡號以 NULL 與標記佔位。
- 驗證跨使用者／匿名權限、直接寫入拒絕、同號其他卡片與不同類型同 UUID 資料保留，以及 auth.users 刪除 cascade 不受新增 trigger 影響。
- 已讀取手機缺口提示截圖；原有 320–1440px 版面檢查保留。未改動最初的 MVP migration 或登入邏輯。

既有專案需手動執行 **202611210001_permanent_delete_unknown_cards.sql** 全文一次，不能重跑原 migration。新 migration 本身不自動清除舊撤銷資料；操作與刪除範圍詳見 [永久刪除與卡號未知](permanent-deletion.md)。

驗證使用本機 PGlite 與測試傳輸層，未執行託管 Supabase migration 或正式部署；也不代表已做多連線併發壓力測試。平台備份／既有下載檔不在此應用刪除範圍。

## 2026-11-21 歷史頁空場次顯示（台北）

- 僅調整前端 History 的顯示條件；空場次不顯示缺口警告，已結束的空場次不列入篩選選單，尚在進行的空場次仍可選取。
- 卡號未知仍是有效紀錄；舊撤銷列不計入有效卡片。仍有有效卡片的場次保留原始序號缺口，搜尋無結果不會產生假的缺口。
- 全部歷史都沒有有效卡片時，歷史區僅顯示「尚無抽卡紀錄」，不顯示篩選、筆數、缺口或維護工具；仍有有效紀錄時保留原本的舊撤銷清理入口。
- 刪除最後一張卡後，若原先選取的已結束場次從選單消失，畫面回到全部場次並忽略原遊戲局數篩選，避免篩選卡住。
- `npm test`：55 項通過；`npm run build`：通過；Chromium E2E：8 項通過。新增 5 項 History 元件測試與 1 項瀏覽器流程，驗證空場次隱藏、真實缺口保留、空白提示及重新整理；另確認出卡刪除前後場次、局數及原始計數資料完全相同。
- 未修改資料庫、RPC、RLS 或 migration；本次不需要執行 SQL。瀏覽器回歸使用本機 PGlite 與測試 Auth／HTTP adapter，未部署正式網站或操作託管 Supabase。

## 2026-11-21 自動部署流程（台北）

- `npm ci --ignore-scripts` 與獨立 Vercel native 工具的乾淨安裝通過。原有 55 項測試於 Vitest 5.1.1 通過，`npm run build` 含 TypeScript 檢查通過，Chromium E2E 8 項通過。
- `npm run test:deployment` 完整 17 項通過、0 略過：包含真 PostgreSQL 17 容器及固定 Supabase CLI 2.67.1，先驗證兩份既有 migration 結構，再 repair history，確認原本店家與帳號資料不變；dry-run 不改 history，push 僅新增測試用 migration，第二次 push 不重播舊 SQL。
- 驗證跨連線 advisory lock 互斥與成功／失敗後釋放；實際變更 RLS、直接寫入權限、trigger 與 RPC 內容時，catalog 比對會拒絕。所有操作只發生於本機隨機測試資料庫。
- 部署單元測試確認 baseline 缺漏、未知／不連續 history、結構差異、未額外審查、高風險計畫變更、migration 失敗、後驗證失敗、Vercel Git／未完成部署及 main 檢查失敗時阻止後續網站發布；確認已有 migration 會略過，sync-history 不會呼叫 db push。
- root 全部依賴及獨立 native 部署工具 `npm audit --audit-level=high` 均通過，掃描結果均為 0 vulnerabilities；升級測試工具以排除舊 dev 依賴已公告漏洞。沒有隱藏 dev audit 或啟用付費掃描服務。
- migration／常見憑證安全檢查、actionlint 1.7.12 workflow 語法檢查通過。Actions 固定 commit，CLI／工具固定版本及鎖檔；正式步驟預設不啟用。
- 此變更未修改 src、兩份既有 migration、Auth 或 RLS，亦未建立新應用 SQL migration。未對正式 Supabase 執行 verify／repair／push、未啟用正式 workflow、未修改外部 Vercel 設定或部署。

GitHub hosted runner 與實際 Supabase TLS／Session pooler、Vercel token 權限及線上發佈仍待使用者依 [部署設定](deployment.md) 完成。測試不能宣稱已對正式環境連線成功。

## 2026-11-22 functions／functionGrants 唯讀診斷（台北）

- 檢查 Production run 44930592951、job 136926592262 的 metadata 及對應 commit 執行順序；前置 Checks 成功，結構比對失敗在 repair／push／deploy 之前。既有錯誤沒有逐函式差異，尚未取得正式庫逐項診斷結果。
- 本機分別模擬 public-schema／global 的常見預設 EXECUTE grants，三個應用函式與受比對 ACL 仍完全符合 baseline；另以額外非 extension helper 重現兩類失敗，原 guard 持續拒絕，未把重現案例當成正式庫事實。
- 24 項部署測試通過、0 略過，含新增 7 項診斷測試。真 PostgreSQL 17 及 PGlite 均驗證 read-only session／snapshot、診斷後 INSERT 被 SQLSTATE 25006 拒絕；既有測試資料保留。
- SQL Editor 版本經本機實際執行驗證，source／configuration SHA256 與 Actions 報告一致；報告不輸出原始 source 或 GUC 值。修改內容、owner、grant option 或新增函式仍被原比對器拒絕。
- build／TypeScript 與 actionlint 通過；未更動 Production workflow、catalog 比對、release、TLS／context guards、baseline hashes、應用 migration、src、Auth 或正式資料庫。
- 新增 workflow 僅手動／main，沿用 production Secrets 與嚴格 TLS；沒有正式 repair、migration 或 Vercel token／部署。調查說明與安全 SQL 查詢見 [唯讀診斷](function-diagnostics.md)。

## 2026-11-22 已驗證 CRLF 與官方 RLS 模板的比較修正（台北）

- 使用者提供的正式唯讀 JSON 確認三個 raw SHA256 精確符合 CRLF baseline，僅換 CRLF→LF 後精確符合原 LF SHA256，且沒有 lone CR；rls_auto_enable 的來源雜湊、metadata、完整 PUBLIC／postgres ACL 與 ensure_rls 綁定亦符合固定官方模板。
- 實作僅限三個已驗證 body hash 的換行相容，以及一個需完整來源／ACL／屬性／唯一綁定同時通過的平台模板物件。未知函式、新 body、實質空白／內容、安全 flags 或 grant／binding 變動仍拒絕，不學習 live hash。
- `npm test`：55 項通過；`npm run build`：TypeScript 與 Vite 通過。完整 `npm run test:deployment`：70 項通過、0 失敗、0 略過；包含 45 項精確規則及拒絕案例。
- 真 PostgreSQL 17＋Supabase CLI 在隔離的 loopback 測試庫重現 CRLF bodies 與官方 event trigger，完整 catalog 比對通過；額外明確 grant 會被拒絕；原資料保留，唯讀 session 仍拒絕 INSERT。原 history-only／pending-only／鎖測試保留。
- 診斷保留 raw hash／bytes 與 exact flags，另列 LF hash／bytes、經驗證規則的比較結果、拒絕原因及 helper 完整 evidence，不輸出 source 原文或 history approval。
- 沒有改動 Production workflow、context／TLS guards、release、原 migration hashes／SQL、src、Auth 或正式資料庫；沒有執行正式 workflow、repair、migration 或部署。新唯讀查詢與規則詳見 [比較規則](function-comparison-plan.md)。
