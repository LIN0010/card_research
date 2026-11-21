# 已驗證的函式換行與官方 RLS helper 比對規則

使用者於台北時間 2026-11-22 提供正式唯讀結果，確認 transaction_read_only=on。三個應用函式的 raw SHA256 完全等於 baseline 的 CRLF 版本；僅 CRLF→LF 後，又完全等於原始 LF baseline，且沒有 lone CR。官方 helper 的來源、metadata、完整 ACL 與綁定也符合以下固定規格。

此 PR 只修正讀取 catalog 後的比較方式。未修改正式資料、帳號、函式或權限，未新增應用 migration，未執行 repair、db push 或部署；migration 檔案本身的不可變 hash 規則不變。

## 三個已確認的應用函式

| 函式 | LF bytes | 換行數 | 模擬 CRLF bytes | 使用者提供的正式 bytes |
| --- | --- | --- | --- | --- |
| erase_draw_history | 664 | 12 | 676 | 676 |
| prevent_deleted_draw_reuse | 292 | 8 | 300 | 300 |
| apply_command | 11519 | 189 | 11708 | 11708 |

正式 [唯讀查詢](diagnostics/verify-function-format.sql) 已確認三者的 raw_matches_exact_crlf_baseline、matches_baseline_after_crlf_only 均為 true，has_lone_cr=false。完整 raw／LF SHA256 在該查詢中；function-policy.mjs 固定 identity 與已驗證 LF hash。

僅這三個 schema／name／參數 signature 加上固定內容 hash 可以轉換 CRLF→LF 比較。不 trim、不移除註解或其他空白、不轉換 lone CR，其他 metadata 與權限仍完整比較。未來新 body 即使沿用同名 RPC，也不自動獲得例外；未知函式與未審查的 body 仍逐 byte 比較。資料庫 prosrc 不會被改寫。

## 官方機制與來源

Supabase Studio 的 [AUTO_ENABLE_RLS_EVENT_TRIGGER_SQL](https://github.com/supabase/supabase/blob/4ead4b092ee7e5ad4def2cd295b14492db12720b/apps/studio/components/interfaces/Database/Triggers/EventTriggersList/EventTriggers.constants.ts) 建立 public.rls_auto_enable() 與 ensure_rls。這是官方提供的可選功能模板，不代表所有 Supabase 專案都自動內建，也不應只依名稱或 owner 推定來源。

此 pinned Studio 模板的 prosrc 在 LF 下為 1055 bytes，SHA256：

`325ae266d9b166715ef5230ceaf7ff9d523e483cf5610dfb9779ab3f183f4af9`

正式 helper 的 raw／LF source SHA256 已確認都與上述官方 hash 相同。本機也確認它會對新建 public table 啟用 RLS、對 app_private table 不啟用；具有 PUBLIC EXECUTE 的 event_trigger 函式仍不能由一般 SELECT 直接呼叫，PostgreSQL 拒絕為 SQLSTATE 0A000。沒有為了消除差異去修改正式 ACL。

## 實作規則：所有條件成立才辨識該單一 helper

- 精確 identity：public.rls_auto_enable()、沒有參數／額外 overload，回傳 event_trigger，language plpgsql，owner postgres。
- 完整安全 metadata：SECURITY DEFINER=true、search_path 僅 pg_catalog，volatile=v、strict=false、leakproof=false、parallel=u。
- source 僅做 CRLF→LF，SHA256 必須等於經審查的固定官方版本；不能把現有正式雜湊直接寫成信任來源，不能用名稱、正則關鍵字、trim 或移除註解辨識。
- 唯一綁定：ensure_rls、owner postgres、ddl_command_end、enabled=O；函式 identity 精確相符，tags 恰為 CREATE TABLE／CREATE TABLE AS／SELECT INTO。缺少、停用、改名、重複或額外綁定都拒絕。
- 完整 ACL 恰為 PUBLIC／postgres 各一筆 EXECUTE，grantor 都是 postgres、grant option 都為 false。這是使用者提供、可由官方 CREATE FUNCTION 模板重現的完整 profile；包含 anon／authenticated／service_role 的任何額外明確 grant 都拒絕。
- 額外查驗 function kind=f、零參數、非 SETOF／variadic、無 planner support hook／default args／外部 binary，以及模板預設 cost=100、rows=0。缺少欄位不得補成預設；這些屬性會於新唯讀驗證時真正從 catalog 取得。
- 以上證據全部通過，才可從業務函式差異中辨識這一個已確認的模板物件及其權限。其他額外函式、其他角色 grants、應用函式 metadata／內容變動仍逐項拒絕，不排除整個 public schema 或所有 event_trigger 函式。

若正式 source 不符合這個官方版本，先核對確切官方歷史版本，不先新增任意 hash 白名單。若 binding／ACL 不符，也不應自動修正正式庫。

## 範圍與回歸

只有完整證據通過的這一個平台模板物件會被辨識，其餘函式、event trigger、RLS、表權限繼續嚴格比較。若未來應用 migration 明確建立此 helper，正式庫也必須有它，不能把兩邊投影後藏掉缺少物件。

回歸測試涵蓋 LF／CRLF 等價、實質字元／空白／metadata 變更失敗、未知 helper／改 owner／改 body／改 search_path／額外 grant／grant option／錯誤或缺少綁定失敗。診斷保留 raw exact_functions_match／exact_function_grants_match，另列 catalog_matches_verified_policy、拒絕原因及 LF hash／bytes，不產生 history approval。

PR 審查合併後先在 main 執行 Production verify-history，填當時完整 SHA，確認新規則讀取的完整 catalog 通過。這次不代為執行正式 workflow，不強制同步 history；舊兩份 migration 不可重播。
