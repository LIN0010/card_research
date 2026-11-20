-- Apply ONCE after 202611060001_mvp.sql. Do not rerun the MVP migration.
-- No legacy soft-deleted rows are erased by this migration: cleanup requires
-- authenticated, explicit confirmation through purge_legacy_voids.
begin;

alter table public.cartridges add column last_side_index integer not null default 0 check(last_side_index >= 0);
update public.cartridges c set last_side_index = coalesce((select max(d.side_index)
  from public.draws d where d.recorded_cartridge_id = c.id), 0);

alter table public.draws add column card_number_unknown boolean not null default false;
alter table public.draws alter column card_number drop not null;
alter table public.draws drop constraint draws_card_number_check;
alter table public.draws add constraint draws_card_number_state_check check(
  (card_number_unknown and card_number is null) or
  (not card_number_unknown and card_number is not null and char_length(btrim(card_number)) between 1 and 64)
);

alter table app_private.operations add column request_digest text;
alter table app_private.operations add column draw_id uuid;
update app_private.operations set
  request_digest = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(request::text, 'UTF8')), 'hex'),
  draw_id = case when request->>'action' in ('append_draw', 'update_draw', 'void_draw') then (result->>'id')::uuid else null end;
alter table app_private.operations alter column request_digest set not null;
-- Preserve retry fingerprints and responses, but discard all old raw requests.
update app_private.operations set request = jsonb_build_object('action', request->>'action', 'entity_id', result->>'id');
create index operations_owner_draw_idx on app_private.operations(owner_id, draw_id);

-- UUID-only tombstones prevent recreating a deleted draw through a delayed retry.
-- They contain no card text, rarity, source, position or complete record snapshots.
create table app_private.deleted_draw_ids (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade
);
alter table app_private.deleted_draw_ids enable row level security;
revoke all on app_private.deleted_draw_ids from public, anon, authenticated;

create function app_private.erase_draw_history() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('draw-id:' || old.id::text, 0));
  -- During auth.users ON DELETE CASCADE, the parent user is already gone.
  if exists (select 1 from auth.users where id = old.owner_id) then
    insert into app_private.deleted_draw_ids(id, owner_id) values(old.id, old.owner_id) on conflict(id) do nothing;
  end if;
  delete from public.audit_events where owner_id = old.owner_id and entity_type = 'draws' and entity_id = old.id;
  update app_private.operations set result = jsonb_build_object('id', old.id, 'deleted', true)
    where owner_id = old.owner_id and draw_id = old.id;
  return old;
end;
$$;
revoke all on function app_private.erase_draw_history() from public, anon, authenticated;
create trigger erase_draw_history after delete on public.draws
  for each row execute function app_private.erase_draw_history();

create function app_private.prevent_deleted_draw_reuse() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('draw-id:' || new.id::text, 0));
  if exists (select 1 from app_private.deleted_draw_ids where id = new.id) then
    raise exception '此紀錄已永久刪除，不可重用識別碼';
  end if;
  return new;
end;
$$;
revoke all on function app_private.prevent_deleted_draw_reuse() from public, anon, authenticated;
create trigger prevent_deleted_draw_reuse before insert on public.draws
  for each row execute function app_private.prevent_deleted_draw_reuse();

create or replace function public.apply_command(p_operation_id uuid, p_action text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_id uuid;
  v_segment public.observation_segments%rowtype;
  v_game public.games%rowtype;
  v_draw public.draws%rowtype;
  v_cartridge public.cartridges%rowtype;
  v_side text;
  v_index integer;
  v_side_index integer;
  v_before jsonb;
  v_after jsonb;
  v_table text;
  v_request jsonb := jsonb_build_object('action', p_action, 'payload', p_payload);
  v_previous app_private.operations%rowtype;
  v_digest text;
  v_card_unknown boolean;
  v_card_number text;
begin
  if v_user is null then raise exception '請先登入'; end if;
  if p_operation_id is null or p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception '操作參數不完整';
  end if;
  -- Serialize this owner's commands, including cache reads, deletes and cleanup.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('card-research-owner:' || v_user::text, 0));
  v_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_request::text, 'UTF8')), 'hex');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text || p_operation_id::text, 0));
  select * into v_previous from app_private.operations where owner_id = v_user and id = p_operation_id;
  if found then
    if v_previous.request_digest <> v_digest then raise exception '同一操作識別碼不可用於不同內容'; end if;
    return v_previous.result;
  end if;

  if p_action = 'void_draw' then
    raise exception '舊版撤銷已停用，請重新整理後使用永久刪除';
  end if;
  if p_action in ('append_draw', 'update_draw') then
    v_card_unknown := coalesce((p_payload->>'card_number_unknown')::boolean, false);
    v_card_number := p_payload->>'card_number';
    if v_card_unknown and v_card_number is not null then
      raise exception '卡號未知時請勿同時提供卡號';
    end if;
  end if;
  if p_action = 'create_store' then
    insert into public.stores(owner_id, name, location)
    values(v_user, p_payload->>'name', coalesce(p_payload->>'location', ''))
    returning id, to_jsonb(stores.*) into v_id, v_after;
    v_table := 'stores';
  elsif p_action = 'update_store' then
    v_id := (p_payload->>'id')::uuid;
    select to_jsonb(s.*) into v_before from public.stores s where id = v_id and owner_id = v_user for update;
    if not found then raise exception '找不到店家或沒有權限'; end if;
    update public.stores set name = p_payload->>'name', location = coalesce(p_payload->>'location', '')
      where id = v_id returning to_jsonb(stores.*) into v_after;
    v_table := 'stores';
  elsif p_action = 'create_machine' then
    insert into public.machines(owner_id, store_id, machine_name, game_version)
    values(v_user, (p_payload->>'store_id')::uuid, p_payload->>'machine_name', p_payload->>'game_version')
    returning id, to_jsonb(machines.*) into v_id, v_after;
    v_table := 'machines';
  elsif p_action = 'update_machine' then
    v_id := (p_payload->>'id')::uuid;
    select to_jsonb(m.*) into v_before from public.machines m where id = v_id and owner_id = v_user for update;
    if not found then raise exception '找不到機台或沒有權限'; end if;
    update public.machines set machine_name = p_payload->>'machine_name', game_version = p_payload->>'game_version'
      where id = v_id returning to_jsonb(machines.*) into v_after;
    v_table := 'machines';
  elsif p_action = 'create_segment' then
    -- Snapshot the observed version; later machine configuration changes must not
    -- relabel old observations as belonging to the new game version.
    insert into public.observation_segments(owner_id, machine_id, game_version, label, notes)
    select v_user, m.id, m.game_version, p_payload->>'label', coalesce(p_payload->>'notes', '')
    from public.machines m where m.id = (p_payload->>'machine_id')::uuid and m.owner_id = v_user
    returning * into v_segment;
    if not found then raise exception '找不到機台或沒有權限'; end if;
    insert into public.games(owner_id, segment_id, game_index) values(v_user, v_segment.id, 1);
    insert into public.cartridges(owner_id, segment_id, side, batch_index, starts_at_index, certainty, note)
    values(v_user, v_segment.id, 'left', 1, 1, coalesce(p_payload->>'left_certainty', 'uncertain'), '觀測起點'),
          (v_user, v_segment.id, 'right', 1, 1, coalesce(p_payload->>'right_certainty', 'uncertain'), '觀測起點');
    v_id := v_segment.id; v_after := to_jsonb(v_segment); v_table := 'observation_segments';
  elsif p_action = 'purge_legacy_voids' then
    if (p_payload->>'confirmed')::boolean is distinct from true then raise exception '請先確認永久清理'; end if;
    perform 1 from public.observation_segments where owner_id = v_user order by id for update;
    select count(*) into v_index from public.draws where owner_id = v_user and deleted_at is not null;
    if v_index is distinct from (p_payload->>'expected_count')::integer then
      raise exception '待清理筆數已改變，請重新讀取後確認';
    end if;
    delete from public.draws where owner_id = v_user and deleted_at is not null;
    v_id := p_operation_id;
    v_after := jsonb_build_object('id', v_id, 'deleted_count', v_index);
    v_table := 'legacy_cleanup';
  elsif p_action in ('start_game', 'close_segment', 'replace_cartridge', 'append_draw', 'update_draw', 'delete_draw') then
    -- The segment row is the serialization point across games and both cartridges.
    select * into v_segment from public.observation_segments
      where id = (p_payload->>'segment_id')::uuid and owner_id = v_user for update;
    if not found then raise exception '找不到觀測段或沒有權限'; end if;
    if v_segment.ended_at is not null and p_action in ('start_game', 'replace_cartridge', 'append_draw', 'close_segment') then
      raise exception '觀測段已結束，請建立新的觀測段';
    end if;
    if p_action = 'start_game' then
      select * into v_game from public.games where segment_id = v_segment.id order by game_index desc limit 1;
      update public.games set ended_at = now() where id = v_game.id;
      insert into public.games(owner_id, segment_id, game_index) values(v_user, v_segment.id, v_game.game_index + 1)
        returning id, to_jsonb(games.*) into v_id, v_after;
      v_table := 'games';
    elsif p_action = 'close_segment' then
      v_before := to_jsonb(v_segment);
      update public.observation_segments set ended_at = now() where id = v_segment.id
        returning id, to_jsonb(observation_segments.*) into v_id, v_after;
      update public.games set ended_at = now() where segment_id = v_segment.id and ended_at is null;
      v_table := 'observation_segments';
    elsif p_action = 'replace_cartridge' then
      v_side := p_payload->>'side';
      select coalesce(max(batch_index), 0) + 1 into v_index from public.cartridges
        where segment_id = v_segment.id and side = v_side;
      insert into public.cartridges(owner_id, segment_id, side, batch_index, starts_at_index, certainty, note)
      values(v_user, v_segment.id, v_side, v_index, v_segment.last_draw_index + 1,
        p_payload->>'certainty', coalesce(p_payload->>'note', ''))
        returning id, to_jsonb(cartridges.*) into v_id, v_after;
      v_table := 'cartridges';
    elsif p_action = 'append_draw' then
      if exists (select 1 from app_private.deleted_draw_ids where id = (p_payload->>'id')::uuid) then
        raise exception '此紀錄已永久刪除，不可重用識別碼';
      end if;
      select * into v_game from public.games where segment_id = v_segment.id order by game_index desc limit 1;
      if v_game.id is distinct from (p_payload->>'game_id')::uuid then
        raise exception '目前局數已改變，請重新整理後確認局數';
      end if;
      v_side := p_payload->>'side';
      v_index := v_segment.last_draw_index + 1;
      if v_side in ('left', 'right') then
        select * into v_cartridge from public.cartridges where segment_id = v_segment.id and side = v_side
          order by batch_index desc limit 1;
        if not found then raise exception '找不到卡匣批次'; end if;
        update public.cartridges set last_side_index = last_side_index + 1 where id = v_cartridge.id
          returning last_side_index into v_side_index;
      end if;
      insert into public.draws(id, owner_id, segment_id, game_id, draw_index, side, cartridge_id,
        recorded_side, recorded_cartridge_id, side_index, card_number, card_number_unknown, rarity)
      values((p_payload->>'id')::uuid, v_user, v_segment.id, v_game.id, v_index, v_side, v_cartridge.id,
        v_side, v_cartridge.id, v_side_index, v_card_number, v_card_unknown, p_payload->>'rarity')
        returning id, to_jsonb(draws.*) into v_id, v_after;
      update public.observation_segments set last_draw_index = v_index where id = v_segment.id;
      v_table := 'draws';
    else
      select * into v_draw from public.draws
        where id = (p_payload->>'id')::uuid and segment_id = v_segment.id and owner_id = v_user for update;
      if not found then raise exception '找不到紀錄或沒有權限'; end if;
      if v_draw.revision is distinct from (p_payload->>'revision')::integer then
        raise exception '紀錄已更新，請重新整理後再修改';
      end if;
      if v_draw.deleted_at is not null and p_action <> 'delete_draw' then raise exception '舊撤銷紀錄僅可永久清理'; end if;
      v_before := to_jsonb(v_draw);
      if p_action = 'delete_draw' then
        if (p_payload->>'confirmed')::boolean is distinct from true then raise exception '請先確認永久刪除'; end if;
        delete from public.draws where id = v_draw.id;
        v_id := v_draw.id;
        v_after := jsonb_build_object('id', v_id, 'deleted', true);
      else
        v_side := p_payload->>'side';
        if v_side in ('left', 'right') then
          select * into v_cartridge from public.cartridges
            where segment_id = v_segment.id and side = v_side and starts_at_index <= v_draw.draw_index
            order by batch_index desc limit 1;
          if not found then raise exception '找不到原始位置對應的卡匣批次'; end if;
        end if;
        -- Preserve original draw_index, recorded source and side_index, even after corrections.
        update public.draws set side = v_side, cartridge_id = v_cartridge.id,
          card_number = v_card_number, card_number_unknown = v_card_unknown, rarity = p_payload->>'rarity',
          updated_at = now(), revision = revision + 1
          where id = v_draw.id returning id, to_jsonb(draws.*) into v_id, v_after;
      end if;
      v_table := 'draws';
    end if;
  else
    raise exception '不支援的操作';
  end if;
  -- Deleted draws have no dedicated public audit record, including the delete itself.
  if p_action not in ('delete_draw', 'purge_legacy_voids') then
    insert into public.audit_events(owner_id, operation_id, entity_type, entity_id, action, old_data, new_data)
      values(v_user, p_operation_id, v_table, v_id, p_action, v_before, v_after);
  end if;
  -- Only a digest is needed to validate retries; never cache raw request bodies.
  insert into app_private.operations(owner_id, id, request, request_digest, draw_id, result)
    values(v_user, p_operation_id, jsonb_build_object('action', p_action, 'entity_id', v_id), v_digest,
      case when p_action in ('append_draw', 'update_draw', 'delete_draw') then v_id else null end, v_after);
  return v_after;
end;
$$;
revoke all on function public.apply_command(uuid, text, jsonb) from public, anon;
grant execute on function public.apply_command(uuid, text, jsonb) to authenticated;

commit;
