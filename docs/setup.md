# 本機／Supabase／Vercel 設定

## 目前的驗證界線

程式可建置並執行本機測試。沒有設定實際 Supabase 專案 URL／publishable key 時，應用程式顯示設定提示，不使用假資料替代。託管 Supabase 登入、郵件與 Vercel 發布須完成以下設定後另行驗證。

## 1. 安裝與啟動

使用 Node.js 22.12 以上，建議 Node 24 LTS。npm 版本與完整套件版本見 package-lock.json。

```bash
cd /workspace/card_research
npm ci
cp .env.example .env.local
# 編輯 .env.local，填入自己 Supabase 專案的公開設定
npm run dev
```

Vite 固定使用 5173；若埠被占用會報錯，不會默默改到其他埠。雲端任務已經隔離，直接使用現有 checkout，不建立 Git worktree。

## 2. 手動建立 Supabase 開發專案

1. 在 Supabase Dashboard 建立新專案，選擇合適區域，安全保存資料庫密碼。
2. 開啟 **SQL Editor**，新增查詢，貼入並執行 `supabase/migrations/202611060001_mvp.sql` 的全部內容。
3. 確認執行成功，public 下有 stores、machines、observation_segments、games、cartridges、draws、audit_events，並有 apply_command 函式。app_private 不要加到 API 的 Exposed schemas。
4. 此 migration 用於新專案，已成功執行就不重貼；它不是可反覆 DROP/CREATE 的腳本。如果曾自行執行過舊 draft，先備份資料並使用獨立新開發專案，不能直接覆蓋同名資料表。
5. 從 Project Settings／Connect 的 API 設定複製 Project URL；從 API Keys 取得 publishable key。舊版專案可使用 anon key。
6. 將下列兩個設定填入本機 `.env.local`（此檔被 Git 忽略）：

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLIC_PUBLISHABLE_KEY
```

所有 VITE_ 變數會進入前端 bundle，因此只能放公開設定。**不要放 service_role、secret key、資料庫密碼或 SMTP 密碼。** 權限隔離靠 RLS 與 RPC，不靠隱藏公開 key。

7. 修改變數後重新啟動 Vite。Vercel 則需重新部署。

## 3. 設定登入與郵件

1. 在 Authentication → Providers 啟用 Email/Password。應用程式提供註冊、登入、忘記密碼及新密碼設定。
2. 建議開啟 Email confirmation；註冊後先收驗證信，再登入。
3. Authentication → URL Configuration：Site URL 設為正式站址；Redirect URLs 加入實際本機／開發網址的根路徑，以及 `/?recovery=1` 密碼重設網址。正式站址亦加入這兩個網址。
4. 使用者按驗證信或重設信會回到同一個 SPA；SDK 處理登入 callback，密碼重設則顯示新密碼表單。
5. 正式服務建議配置自有 SMTP；開發寄信配額及速率限制以 Supabase 專案設定為準。

不要把使用者密碼或 SMTP 憑證貼進聊天。先使用已有的可用認證，不因看不到 token 環境變數就新增秘密要求。

## 4. 測試與建置

```bash
npm run typecheck
npm test
npm run build
```

`npm test` 不需 Supabase 憑證：在 PGlite 中執行真實 PostgreSQL migration、RPC 與 RLS，另外執行表單及匯出測試。auth.users/auth.uid 由測試夾具提供，不是託管 Auth 測試。

瀏覽器整合測試：

```bash
npx playwright install chromium
npm run test:e2e
```

若已有系統 Chromium，可指定路徑（本雲端環境使用此方式）：

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:e2e
```

E2E 先以測試公開設定正式編譯到獨立的 `.e2e-dist`，再使用 390×844 視窗、5174 專用 preview 埠及測試用 Supabase HTTP adapter，連接真實 migration 的本機 PGlite。它會測登入畫面、管理、兩組樣本、刷新、重新登入、修改撤銷與實際下載匯出。測試專案網址及 key 都是假測試設定，請勿拿來當正式環境變數。它不連接 Supabase 託管服務，也不覆蓋 `dist` 的一般建置輸出。

## 5. 實際 Supabase 驗收

1. 註冊測試帳號 A／B、完成驗證並登入。
2. A 建立店家、兩台機台與觀測段，依 README 的兩組資料逐局輸入。
3. 確認按「下一局」後原始全域與側序繼續；切換機台不混合紀錄。
4. 重新整理、登出再登入 A，確認資料仍從 Supabase 讀取。
5. 登入 B，確認看不到 A 的店家、機台、出卡與操作歷史。
6. 修改卡號或來源、撤銷上一筆，檢查原始序號與操作前後快照保留。
7. 測試更換及「不確定」批次；新批次原始側序重新從 1 起，全域序號繼續。
8. 瀏覽器切成離線後送出一筆，確認輸入未被清空、沒有假成功提示；恢復連線後按重試確認，資料只有一筆。此版本沒有離線暫存或背景同步。
9. 匯出 CSV／JSON，確認包含原始序號、已撤銷列及完整資料；JSON 另包含操作快照。

## 6. Vercel 部署

1. 將程式變更提交並推到 GitHub 後，在 Vercel 匯入 `LIN0010/card_research`。
2. Framework 選 Vite；Build Command `npm run build`；Output Directory `dist`。
3. Preview／Production 各自加入上面兩個公開變數，建議使用分離的 Supabase 開發／正式專案。
4. repo 的 vercel.json 已設定 SPA rewrite。
5. 將實際 Vercel 網域及密碼重設回呼加到對應 Supabase 的 Redirect URLs；避免對未知網域放寬正式認證。
6. 部署後完成上一節實際驗收。本次程式實作不等於已發布 Vercel。

## 7. 雲端網路

安裝需 npm registry。執行應用程式需實際 Supabase 專案的 HTTPS 網域；若雲端網路採 allowlist，請在環境設定加入**自己的專案網域**，不要用字面上的 YOUR_PROJECT_REF。瀏覽器也必須能連到該網域。

SQL Editor 可在 Supabase Dashboard 執行 migration，不要求在此前端專案提供原始 PostgreSQL TCP 連線。若未來用 CLI 執行 migration，再依實際連線路徑設定所需權限與網路。本階段不需要 Realtime、VPN、部署 token 或 AI API key。
