-- Online MVP. Execute once on a new Supabase development project.
-- Business writes are atomic, authenticated and idempotent through apply_command.
begin;

create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;

create table public.stores (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 100),
  location text not null default '' check (char_length(location) <= 300),
  created_at timestamptz not null default now(),
  unique(id, owner_id)
);
create table public.machines (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  store_id uuid not null,
  machine_name text not null check (char_length(btrim(machine_name)) between 1 and 100),
  game_version text not null check (char_length(btrim(game_version)) between 1 and 100),
  created_at timestamptz not null default now(),
  foreign key(store_id, owner_id) references public.stores(id, owner_id),
  unique(id, owner_id)
);
create table public.observation_segments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  machine_id uuid not null,
  game_version text not null check (char_length(btrim(game_version)) between 1 and 100),
  label text not null check (char_length(btrim(label)) between 1 and 100),
  notes text not null default '' check (char_length(notes) <= 5000),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  last_draw_index integer not null default 0 check(last_draw_index >= 0),
  created_at timestamptz not null default now(),
  foreign key(machine_id, owner_id) references public.machines(id, owner_id),
  check(ended_at is null or ended_at >= started_at),
  unique(id, owner_id)
);
create table public.games (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  segment_id uuid not null,
  game_index integer not null check(game_index > 0),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  foreign key(segment_id, owner_id) references public.observation_segments(id, owner_id),
  unique(segment_id, game_index),
  unique(id, owner_id, segment_id)
);
create table public.cartridges (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  segment_id uuid not null,
  side text not null check(side in ('left', 'right')),
  batch_index integer not null check(batch_index > 0),
  starts_at_index integer not null check(starts_at_index > 0),
  certainty text not null check(certainty in ('confirmed', 'uncertain')),
  note text not null default '' check(char_length(note) <= 1000),
  created_at timestamptz not null default now(),
  foreign key(segment_id, owner_id) references public.observation_segments(id, owner_id),
  unique(segment_id, side, batch_index),
  unique(id, owner_id, segment_id, side)
);
create table public.draws (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  segment_id uuid not null,
  game_id uuid not null,
  draw_index integer not null check(draw_index > 0),
  -- Current corrected source; original allocation below never changes.
  side text not null check(side in ('left', 'right', 'unknown')),
  cartridge_id uuid,
  recorded_side text not null check(recorded_side in ('left', 'right', 'unknown')),
  recorded_cartridge_id uuid,
  side_index integer,
  card_number text not null check(char_length(btrim(card_number)) between 1 and 64),
  rarity text not null check(rarity in ('normal', 'four_star', 'signature', 'unknown')),
  recorded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revision integer not null default 1 check(revision > 0),
  deleted_at timestamptz,
  foreign key(segment_id, owner_id) references public.observation_segments(id, owner_id),
  foreign key(game_id, owner_id, segment_id) references public.games(id, owner_id, segment_id),
  foreign key(cartridge_id, owner_id, segment_id, side)
    references public.cartridges(id, owner_id, segment_id, side),
  foreign key(recorded_cartridge_id, owner_id, segment_id, recorded_side)
    references public.cartridges(id, owner_id, segment_id, side),
  check((side = 'unknown' and cartridge_id is null)
    or (side in ('left', 'right') and cartridge_id is not null)),
  check((recorded_side = 'unknown' and recorded_cartridge_id is null and side_index is null)
    or (recorded_side in ('left', 'right') and recorded_cartridge_id is not null
      and side_index is not null and side_index > 0)),
  unique(segment_id, draw_index),
  unique(recorded_cartridge_id, side_index)
);
create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  operation_id uuid not null,
  entity_type text not null,
  entity_id uuid not null,
  action text not null,
  old_data jsonb,
  new_data jsonb not null,
  created_at timestamptz not null default now()
);
create table app_private.operations (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  request jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(owner_id, id)
);

create index stores_owner_idx on public.stores(owner_id, created_at);
create index machines_owner_store_idx on public.machines(owner_id, store_id);
create index segments_owner_machine_idx on public.observation_segments(owner_id, machine_id, started_at);
create index games_owner_segment_idx on public.games(owner_id, segment_id);
create index cartridges_owner_segment_idx on public.cartridges(owner_id, segment_id, side, starts_at_index);
create index draws_owner_segment_idx on public.draws(owner_id, segment_id, draw_index);
create index draws_game_idx on public.draws(game_id);
create index draws_cartridge_idx on public.draws(cartridge_id, draw_index);
create index draws_card_idx on public.draws(owner_id, card_number);
create index audit_owner_entity_idx on public.audit_events(owner_id, entity_id, created_at);

alter table public.stores enable row level security;
alter table public.machines enable row level security;
alter table public.observation_segments enable row level security;
alter table public.games enable row level security;
alter table public.cartridges enable row level security;
alter table public.draws enable row level security;
alter table public.audit_events enable row level security;
alter table app_private.operations enable row level security;
create policy read_own on public.stores for select to authenticated using((select auth.uid()) = owner_id);
create policy read_own on public.machines for select to authenticated using((select auth.uid()) = owner_id);
create policy read_own on public.observation_segments for select to authenticated using((select auth.uid()) = owner_id);
create policy read_own on public.games for select to authenticated using((select auth.uid()) = owner_id);
create policy read_own on public.cartridges for select to authenticated using((select auth.uid()) = owner_id);
create policy read_own on public.draws for select to authenticated using((select auth.uid()) = owner_id);
create policy read_own on public.audit_events for select to authenticated using((select auth.uid()) = owner_id);
revoke all on public.stores, public.machines, public.observation_segments, public.games,
  public.cartridges, public.draws, public.audit_events from public, anon, authenticated;
grant select on public.stores, public.machines, public.observation_segments, public.games,
  public.cartridges, public.draws, public.audit_events to authenticated;

create function public.apply_command(p_operation_id uuid, p_action text, p_payload jsonb)
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
begin
  if v_user is null then raise exception '請先登入'; end if;
  if p_operation_id is null or p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception '操作參數不完整';
  end if;
  -- Serialize retries before checking the operation log; all side effects commit together.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text || p_operation_id::text, 0));
  select * into v_previous from app_private.operations where owner_id = v_user and id = p_operation_id;
  if found then
    if v_previous.request <> v_request then raise exception '同一操作識別碼不可用於不同內容'; end if;
    return v_previous.result;
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
  elsif p_action in ('start_game', 'close_segment', 'replace_cartridge', 'append_draw', 'update_draw', 'void_draw') then
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
        select coalesce(max(side_index), 0) + 1 into v_side_index from public.draws
          where recorded_cartridge_id = v_cartridge.id;
      end if;
      insert into public.draws(id, owner_id, segment_id, game_id, draw_index, side, cartridge_id,
        recorded_side, recorded_cartridge_id, side_index, card_number, rarity)
      values((p_payload->>'id')::uuid, v_user, v_segment.id, v_game.id, v_index, v_side, v_cartridge.id,
        v_side, v_cartridge.id, v_side_index, p_payload->>'card_number', p_payload->>'rarity')
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
      if v_draw.deleted_at is not null then raise exception '此紀錄已撤銷'; end if;
      v_before := to_jsonb(v_draw);
      if p_action = 'void_draw' then
        update public.draws set deleted_at = now(), updated_at = now(), revision = revision + 1
          where id = v_draw.id returning id, to_jsonb(draws.*) into v_id, v_after;
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
          card_number = p_payload->>'card_number', rarity = p_payload->>'rarity',
          updated_at = now(), revision = revision + 1
          where id = v_draw.id returning id, to_jsonb(draws.*) into v_id, v_after;
      end if;
      v_table := 'draws';
    end if;
  else
    raise exception '不支援的操作';
  end if;
  insert into public.audit_events(owner_id, operation_id, entity_type, entity_id, action, old_data, new_data)
    values(v_user, p_operation_id, v_table, v_id, p_action, v_before, v_after);
  insert into app_private.operations(owner_id, id, request, result) values(v_user, p_operation_id, v_request, v_after);
  return v_after;
end;
$$;
revoke all on function public.apply_command(uuid, text, jsonb) from public, anon;
grant execute on function public.apply_command(uuid, text, jsonb) to authenticated;

commit;
