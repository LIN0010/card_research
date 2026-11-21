# Production #2 函式差異的唯讀診斷

Run [44930592951](https://github.com/LIN0010/card_research/actions/runs/44930592951)，production job 136926592262，main commit `7dbcdada162ed550e69a7baf7af338a15655d5fa`，於台北時間 2026-11-22 的 verify-history 回報 functions、functionGrants 不同。

## 已確認與尚未確認

- GitHub 顯示前置 Checks 全數成功，正式網站建置跳過，production 在結構驗證失敗。依該 commit 的執行順序，錯誤發生在任何 repair／push／deploy 前。
- 目前錯誤只有類別名稱，沒有逐函式或 ACL 差異。雲端工作區沒有正式 Supabase 憑證／connector；不能從既有紀錄確認哪個正式函式不同。完整 job log 的下載端點另受目前網路政策限制，但原程式本來就不會記錄逐項資料。
- 比對範圍涵蓋 public／app_private 的所有非 extension 成員函式，並不只有這三個應用函式。額外函式、同名不同 signature、參數名稱、owner、函式內容、language、security definer、search_path、其他 flags 都可能使 functions 不符。
- functionGrants 比較 PUBLIC／anon／authenticated 的權限與 grant option；service_role 單獨多出的 grant 不在該比較範圍，不能單靠它解釋此錯誤。
- [Supabase 公開初始化程式](https://github.com/supabase/postgres/blob/c85422318302fae317c8eb25d47b9abc810d61f0/migrations/db/init-scripts/00000000000000-initial-schema.sql#L39) 確實設定 public schema 的預設函式 grants；這是公開版本的背景資料，不代表正式專案一定使用該版本。
- 本機已分別重現 public-schema 及 global 的常見 default EXECUTE grants，再執行兩份原 migration。三個應用函式與受比較的 grants 均符合 baseline：明確 REVOKE／GRANT 會收斂這些預設權限。因此「只有常見預設 grants」不足以重現此次失敗。
- 在本機新增一個不屬於 extension 的 public helper，則可同時重現 functions、functionGrants 失敗；這只是可能機制，不能推論正式庫確實多了 helper，更不能自動視為安全。

## baseline 應有的函式與權限

| 函式 | 回傳 | Owner | Security definer | search_path | 比對中的 EXECUTE grants |
| --- | --- | --- | --- | --- | --- |
| public.apply_command(p_operation_id uuid, p_action text, p_payload jsonb) | jsonb | postgres | true | 空 | authenticated；無 grant option |
| app_private.erase_draw_history() | trigger | postgres | true | 空 | 無 PUBLIC／anon／authenticated |
| app_private.prevent_deleted_draw_reuse() | trigger | postgres | true | 空 | 無 PUBLIC／anon／authenticated |

三者的 language 為 plpgsql，volatile=v、strict=false、leakproof=false、parallel=u。內容須符合第二份 migration 的最終定義，不是最初 MVP 版的 apply_command。

## 方案 A：不需合併就能使用的 SQL Editor 唯讀查詢

在正確 Supabase 專案，以 postgres 執行 [function-catalog.sql](diagnostics/function-catalog.sql) 全文。這不是 migration，只有 READ ONLY 交易、系統 catalog SELECT 與 ROLLBACK，不會呼叫應用 RPC、讀取卡片／帳號列或改 history。

輸出包含正式 server version、函式 signature、owner、安全 flags、source／configuration SHA256，以及所有角色 grants 與 default privileges。原始 source／GUC 值不會輸出。可先據此比對上表與 repository 定義，尤其檢查額外函式及參數名稱／型別。

若 source hash 不同而需看完整內容，可在**私人 SQL Editor** 另執行下列唯讀查詢，與 repository 中第二份 migration 比較。不要直接把未知 source 放到公開 Actions log／issue 或聊天，因為函式有可能內嵌敏感字串。

```sql
begin read only;
select n.nspname, p.proname, pg_catalog.pg_get_functiondef(p.oid) as definition
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid=p.pronamespace
where (n.nspname,p.proname) in (
  ('public','apply_command'),
  ('app_private','erase_draw_history'),
  ('app_private','prevent_deleted_draw_reuse')
);
rollback;
```

## 方案 B：GitHub Actions 對照報告

本 PR 新增獨立的 **Read-only function diagnostics** workflow；沒有改動 Production workflow 或既有 catalog 比對器。

1. 審查並合併此 PR 後，在 Actions 選 Read-only function diagnostics → Run workflow，branch 選 main，expected_commit 填當時完整 main SHA。
2. 使用既有 production environment 的 SUPABASE_DB_URL／PROJECT_REF／CA_CERT；不新增憑證，不需要貼出任何金鑰，也不傳 Vercel token。
3. workflow 限定手動、main 與最新 SHA，與 Production 共用 concurrency group，連線仍嚴格驗證 TLS。只有本機 PGlite 空白參考庫執行既有 SQL 來建立 baseline；正式 session 與明確 snapshot 交易都設成 read-only，最後 ROLLBACK，正式連線沒有 Supabase CLI、repair、push、部署或業務 RPC 呼叫。
4. Job Summary 顯示 expected／actual 函式數、逐項 unexpected／missing／changed、changed fields、source／config 雜湊、權限 added／missing、有效 EXECUTE／schema USAGE、default privileges 及 extension 版本。
5. 本 workflow 成功只代表報告採集成功；即使顯示 drift，也不會產生 Verified plan 或任何可用來同步 history 的 approval，更不會將差異列入允許清單。Actions log 在公開 repo 可被閱讀；預設只輸出 metadata 與 hash，不上傳完整 source artifact。

## 如何判斷下一步

| 實際報告 | 判讀與後續 |
| --- | --- |
| 三個應用函式全相同，僅多出其他非 extension 函式 | 先逐一核對它們的來源、owner、signature、版本與權限。不能只因 owner 是 postgres／supabase_admin 或名稱像平台函式就忽略。確認來源後另提受審查的處理方案。 |
| source 或 arguments 不同 | 私下比對第二份 migration 最終定義，區分手動格式／版本差異、舊 RPC 或真正內容變更；hash 不同本身不證明是格式差異。不要重播 migration。 |
| security definer、owner、proconfig 或 flags 不同 | 屬於實際 metadata 差異，需安全審查，不以「平台預設」概括。 |
| anon／PUBLIC 或 private helper 的 EXECUTE、grant option 不同 | 確認明確 REVOKE／GRANT、繼承權限與 schema USAGE。這次不會自動 REVOKE／GRANT 或修復正式庫。 |
| 只有 service_role 額外 grant | 該角色本來不在 functionGrants 的比較範圍；繼續找真正影響範圍內的差異。 |

調查期間維持自動化開關為 false，暫不執行 sync-history 或 deploy-reviewed。取得事實後再決定是否需要獨立修正 PR；本次不重跑舊 SQL、不改正式函式／權限、不放寬比對、不強制 applied，保留所有資料與帳號。
