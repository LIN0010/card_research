# 換行與官方 RLS helper 的精確比對方案（待正式驗證）

目前沒有修改 catalog 比對器、production workflow 或任何 migration，也沒有建立啟用比較例外的 PR。Run 44935940210 的成功狀態與使用者提供的 metadata 已確認；完整 Actions 報告下載仍受 results-receiver 主機 403 限制，尚缺正式 SHA256、完整 ACL 與 event trigger 綁定。

## 已可重現的換行特徵

| 函式 | LF bytes | 換行數 | 模擬 CRLF bytes | 使用者提供的正式 bytes |
| --- | --- | --- | --- | --- |
| erase_draw_history | 664 | 12 | 676 | 676 |
| prevent_deleted_draw_reuse | 292 | 8 | 300 | 300 |
| apply_command | 11519 | 189 | 11708 | 11708 |

差值完全吻合 CRLF，但 byte 數不能取代 SHA256 證據。[唯讀查詢](diagnostics/verify-function-format.sql) 同時計算 raw SHA256、僅 CRLF→LF 後 SHA256、raw／LF bytes、lone CR 與 baseline 是否相等，不移除空白、註解或其他字元。三份 raw／LF SHA256 參考值已固定在查詢中。

正式報告必須確認三者的 matches_baseline_after_crlf_only=true，且 has_lone_cr=false；raw_matches_exact_crlf_baseline=true 可額外證明是完整 CRLF 版本。

## 官方機制與來源

Supabase Studio 的 [AUTO_ENABLE_RLS_EVENT_TRIGGER_SQL](https://github.com/supabase/supabase/blob/4ead4b092ee7e5ad4def2cd295b14492db12720b/apps/studio/components/interfaces/Database/Triggers/EventTriggersList/EventTriggers.constants.ts) 建立 public.rls_auto_enable() 與 ensure_rls。這是官方提供的可選功能模板，不代表所有 Supabase 專案都自動內建，也不應只依名稱或 owner 推定來源。

此 pinned Studio 模板的 prosrc 在 LF 下為 1055 bytes，SHA256：

`325ae266d9b166715ef5230ceaf7ff9d523e483cf5610dfb9779ab3f183f4af9`

本機確認它會對新建 public table 啟用 RLS、對 app_private table 不啟用；具有 PUBLIC EXECUTE 的 event_trigger 函式仍不能由一般 SELECT 直接呼叫，PostgreSQL 會拒絕為 SQLSTATE 0A000。這些測試不證明正式函式一定等於模板，正式 source hash 仍須核對。

## 預定規則：所有條件成立才辨識該單一 helper

- 精確 identity：public.rls_auto_enable()、沒有參數／額外 overload，回傳 event_trigger，language plpgsql，owner postgres。
- 完整安全 metadata：SECURITY DEFINER=true、search_path 僅 pg_catalog，volatile=v、strict=false、leakproof=false、parallel=u。
- source 僅做 CRLF→LF，SHA256 必須等於經審查的固定官方版本；不能把現有正式雜湊直接寫成信任來源，不能用名稱、正則關鍵字、trim 或移除註解辨識。
- 唯一綁定：ensure_rls、owner postgres、ddl_command_end、enabled=O；函式 identity 精確相符，tags 恰為 CREATE TABLE／CREATE TABLE AS／SELECT INTO。缺少、停用、改名、重複或額外綁定都拒絕。
- 檢查完整 ACL（包括 grantor／grant option），不是只看 PUBLIC 那一列。僅考慮能由官方模板與官方 default privileges 重現的完整權限集合；實際 profile 要等正式唯讀結果與官方來源核對後固定，未知角色或 grant option 一律拒絕。
- 以上證據全部通過，才可從業務函式差異中辨識這一個已確認的模板物件及其權限。其他額外函式、其他角色 grants、應用函式 metadata／內容變動仍逐項拒絕，不排除整個 public schema 或所有 event_trigger 函式。

若正式 source 不符合這個官方版本，先核對確切官方歷史版本，不先新增任意 hash 白名單。若 binding／ACL 不符，也不應自動修正正式庫。

## 驗證後才建立比較修正 PR

需要的正式證據已集中於一次性的唯讀 SQL 結果，不需提供任何金鑰、函式原文或業務列。確認後才會修改比較邏輯，並測試：LF／CRLF 等價、實質字元／空白／metadata 變更仍失敗、未知 helper／改 owner／改 body／改 search_path／額外 grant／grant option／錯誤或缺少綁定均失敗。

調查及驗證期間不執行 repair、db push、舊 migration 或正式部署，不更動資料、帳號與權限。
