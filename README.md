# 偶像學園雙卡匣卡序研究系統

手機優先的 React + TypeScript + Vite + Tailwind 線上紀錄 MVP，使用 Supabase Auth／PostgreSQL 保存私人資料。

提供店家機台管理、連續觀測段、跨局出卡、左／右／來源不明、卡匣批次與不確定狀態、修改撤銷及操作歷史、搜尋、CSV／JSON 匯出。未包含離線同步、匯入、預測、機器學習或複雜統計。

## 啟動

需要 Node.js 22.12 以上（建議 24 LTS）。先依 [設定教學](docs/setup.md) 建立 Supabase 專案，於 SQL Editor 執行 [migration](supabase/migrations/202611060001_mvp.sql)。

```bash
npm ci
cp .env.example .env.local
# 填入 VITE_SUPABASE_URL、VITE_SUPABASE_PUBLISHABLE_KEY
npm run dev
```

未設定 Supabase 時會顯示設定說明，不假裝已連線。正式建置：`npm run build`；Vercel 設定步驟見設定教學。

## 測試

```bash
npm test
npm run typecheck
npm run build
npx playwright install chromium
npm run test:e2e
```

單元及資料庫測試不需要遠端憑證。資料庫測試在本機 PGlite 執行 PostgreSQL SQL／RLS／RPC；E2E 使用測試 HTTP adapter 與手機尺寸 Chromium。兩者均不能替代實際 Supabase 的登入、寄信與 API 驗收。此次執行結果見 [驗證紀錄](docs/validation.md)。

## 指定樣本的預期結果

| 機台 | 全域原始順序（跨局持續） | 左側原始順序 | 右側原始順序 |
| --- | --- | --- | --- |
| A 店內左台 | 1:049、2:022、3:14P；第2局 4:001 | 1:049、2:022、3:14P | 1:001 |
| B 店內右台 | 1:050、2:046、3:034、4:030、5:049；第2局 6:033、7:016、8:035 | 1:050、2:030 | 1:046、2:034、3:049、4:033、5:016、6:035 |

14P 為簽名，001 與 016 為四星。卡號為文字，保留前綴、零與 P 後綴；P 只提供可手動覆寫的稀有度提示。

## 資料正確性

- 店家 → 機台 → 連續觀測段 → 遊戲局數；換局不重設卡序，不跨機台／觀測段串接。
- 卡匣以裝填批次辨識；不確定是否更換時另開 uncertain 批次。
- 原始序號不重排，撤銷採軟刪除並保留操作前後資料。
- 有效顯示編號只方便閱讀，不作為原始序號或完整連續性證據。
- 線上寫入由 PostgreSQL 原子配號並依操作 ID 防止重試重複新增。
- 儲存失敗保留表單；沒有離線持久化，未儲存輸入關閉頁面仍可能遺失。
- RLS 與複合外鍵隔離私人資料，前端不能直接修改資料表。

詳見 [架構文件](docs/architecture.md)。原 `docs/database-schema.draft.sql` 已改為遷移來源說明，不再是可執行的舊 schema。
