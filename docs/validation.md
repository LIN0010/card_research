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
