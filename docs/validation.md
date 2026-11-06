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
