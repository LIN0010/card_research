# 偶像學園雙卡匣卡序研究系統：第一階段 MVP

此文件取代先前將場次與連續序列混用的提案。實作以 `supabase/migrations/202611060001_mvp.sql` 為資料庫定義；尚未配置的遠端服務不視為已驗證。

## 資料關聯

```text
auth.users（私人資料擁有者）
└── stores 店家
    └── machines 機台
        └── observation_segments 連續觀測段
            ├── games 遊戲局數
            ├── cartridges 分側裝填／更換批次
            └── draws 出卡（同時參照所屬遊戲局數與卡匣批次）

audit_events 保存操作前後快照
app_private.operations 保存寫入操作 ID 與結果，供安全重試
```

- 同一機台可有多個觀測段，每段各自從原始 #1 開始，不跨段推斷連續性。
- 觀測段保存建立當時的 game_version 快照；更新機台版本不回頭改寫歷史觀測的版本。
- 同段可含多局遊戲；按「下一局」不重設全域或卡匣順序。
- 機台間不串接。同店左右兩台是兩個 machine，不是同台的兩個卡匣。
- 卡匣批次屬於觀測段及某一側。更換、補卡，或不確定有無更換時，都建立新 UUID 批次。
- certainty 可為 confirmed／uncertain；不確定批次不是同一批延續的證據。觀測起點預設不確定。
- 無法辨認左右來源時用 unknown，沒有 cartridge_id 或原始側序。
- 店家、機台提供新增及基本資料編輯；不提供會破壞歷史關聯的硬刪除。

## 原始順序與顯示順序

- `draw_index`：觀測段全域原始序號；永久保留，換局不重設，撤銷不回收。
- `recorded_side`、`recorded_cartridge_id`、`side_index`：新增當時的原始側序配置；卡匣換批才重新從 1 起。
- `side`、`cartridge_id`：目前修正後的來源；編輯來源時按照原始 draw_index 對應當時該側有效的批次，不誤指到後來的新卡匣。
- 修改不重排原始序號。原始輸入及所有修正保存在 audit_events。
- `deleted_at`：撤銷採軟刪除；資料、序號、操作紀錄都保留。撤銷上一筆是選擇最後一筆有效紀錄，並以固定操作 ID 寫入。
- 介面「有效顯示 #N」與「左／右 #N」是有效列排序後的閱讀編號，並非資料庫原始側序，也不代表已證實完整連續。
- 原始與有效編號、批次資訊均於畫面／CSV 區分；JSON 保留完整資料。

## 寫入與權限

前端使用 Supabase Auth Email/Password。所有公開資料表啟用 RLS，只允許本人讀取。anon 無資料讀寫權限；authenticated 沒有直接 insert/update/delete 權限。

所有寫入走 `apply_command(operation_id, action, payload)`：

1. SECURITY DEFINER 使用空 search_path、完整限定物件名稱與 auth.uid()；每次查詢限定本人。
2. 含 owner_id 的複合外鍵防止跨使用者／跨觀測段參照；games 和 cartridges 必須屬於相同觀測段。
3. 對觀測段取得行鎖，原子分配全域及原始側序；唯一約束再防止重複。
4. 檢查目前遊戲局數，拒絕過期頁面把新卡寫入舊局。
5. 寫入資料、audit_events 及私有操作結果同一交易提交。
6. 相同操作 ID／相同內容重試返回原結果；相同 ID 不同內容拒絕。
7. 單筆修改及撤銷比對 revision，防止舊畫面覆蓋較新的修改。這是線上基本一致性檢查，不是離線衝突合併功能。

支援 create/update_store、create/update_machine、create_segment、start_game、close_segment、replace_cartridge、append/update/void_draw。

## 線上儲存狀態

第一階段沒有 IndexedDB、離線佇列、背景同步或衝突合併。

- 表單保留輸入直到伺服器確認成功；只在確認後顯示「已儲存至 Supabase」並清空輸入。
- 資料庫明確拒絕時顯示錯誤，可修正後重送；輸入不會清空。
- 傳輸錯誤可能發生於提交之後；保留原操作 ID 與表單，鎖住其他寫入，提供「重試確認儲存」。重試成功後原表單才清空。
- 已提交但重新讀取失敗時，清楚顯示「已儲存，但清單更新失敗」，不重送同筆新增。
- 未送出的卡號切換頁籤／機台／觀測段或登出前提示；離開網頁時也提示。此提示不能取代持久化，未儲存輸入關閉後可能遺失。
- 按重新讀取、重新整理或重新登入時從 Supabase 查詢；業務資料不以瀏覽器暫存冒充持久化。
- Auth session 由 Supabase SDK 儲存於瀏覽器，登出後清除畫面；與出卡離線資料儲存是不同用途。

## 卡號與稀有度

card_number 使用 text，驗證非空及最大長度，不將卡號轉為數字、強制補零或刪除前綴。AP6-049、A06-001、AP6-14P、049 都可保存，保留原始文字。

稀有度：normal 普通、four_star 四星、signature 簽名、unknown 未知。P 後綴只在新增表單提供簽名提示，手動選擇優先；資料庫不依卡號推定稀有度。

## 前端結構

```text
src/
├── app/App.tsx                   # 登入後頁籤、選取狀態、讀取與錯誤提示
├── components/FormFields.tsx      # 共用來源與稀有度欄位
├── features/
│   ├── auth/AuthPanel.tsx         # 登入、註冊、密碼重設
│   ├── management/Management.tsx # 店家與機台管理
│   ├── recording/                # 觀測段、換局、換批、出卡表單
│   └── history/                  # 整體／分側順序、修改、撤銷、歷史搜尋
├── lib/                          # 型別、Supabase、repository、寫入生命週期、匯出
├── main.tsx
└── styles.css                    # Tailwind + 簡單手機樣式
supabase/migrations/              # 真正執行的 SQL
supabase/tests/                   # PGlite PostgreSQL 交易、RLS 與樣本測試
tests/                           # 表單、狀態與匯出測試
tests/e2e/                       # Chromium 手機尺寸完整流程
```

本階段只需要少量頁籤，因此採 React state，未加入 React Router、TanStack Query 或 Dexie。URL 保留已選機台及觀測段，重新整理後可回到原紀錄。

## 歷史與匯出

歷史可依機台、觀測段、遊戲局數、卡號及撤銷狀態篩選。CSV 包含全部出卡含撤銷列、原始與有效編號、卡匣狀態；JSON 帶 schema_version，包含店家、機台、觀測段、局數、卡匣、出卡與操作紀錄。

匯出前重新抓取全部分頁，避免只取 Supabase 預設第一頁。CSV 使用 BOM、引號跳脫與公式開頭防護；精確原文與完整操作歷史使用 JSON。多個 REST 查詢不是跨表資料庫快照，匯出時應避免其他裝置同時修改。

## 第一階段驗證與界線

必要驗證：正式建置、表單儲存失敗保留、冪等重試、RLS、跨使用者外鍵、原始序號不變、卡匣不確定切批、兩組指定跨局樣本、手機完整流程、重新載入與重新登入後重讀、CSV／JSON 內容。

PGlite 執行真正 PostgreSQL migration 與 PL/pgSQL，但以測試用 auth.users/auth.uid 代替 Supabase Auth。瀏覽器 E2E 以測試用 HTTP adapter 連接該資料庫；不能替代 Supabase 託管環境的 Auth、PostgREST、寄信或網路驗證。單連線 PGlite 也不代表已做多連線併發壓力測試。

未開發：離線同步、匯入、卡序預測、AI、滑動視窗分析、複雜統計與回測。待本階段可在實際 Supabase 專案完成驗收後，再確認後續開發。
