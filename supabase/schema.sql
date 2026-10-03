-- Bridge signup (Rehovot, Wednesday guided game) - database schema.
-- All writes go through SECURITY DEFINER functions; anon can only read.

create extension if not exists pgcrypto with schema extensions;

-- ---------- tables ----------

create table public.settings (
  id int primary key default 1 check (id = 1),
  session_dow int not null default 3 check (session_dow between 0 and 6),        -- 3 = Wednesday
  deadline_days_before int not null default 0 check (deadline_days_before between 0 and 6),
  deadline_time time not null default '07:00',
  rollover_time time not null default '13:00',                                   -- after this, page moves to next week
  max_tables int not null default 8
);
insert into public.settings default values;

create table public.admin_secret (
  id int primary key default 1 check (id = 1),
  code_hash text not null
);

create table public.known_players (
  name text primary key,
  games int not null default 0,
  created_at timestamptz not null default now()
);

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  session_date date not null,
  kind text not null check (kind in ('table', 'waiting')),
  created_at timestamptz not null default now()
);
create index groups_session_idx on public.groups (session_date);

create table public.players (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  session_date date not null,
  name text not null,
  created_at timestamptz not null default now(),
  unique (session_date, name)
);
create index players_group_idx on public.players (group_id);

-- ---------- row level security: read-only for everyone ----------

alter table public.settings enable row level security;
alter table public.admin_secret enable row level security;
alter table public.known_players enable row level security;
alter table public.groups enable row level security;
alter table public.players enable row level security;

create policy "read settings" on public.settings for select using (true);
create policy "read known players" on public.known_players for select using (true);
create policy "read groups" on public.groups for select using (true);
create policy "read players" on public.players for select using (true);

revoke insert, update, delete, truncate on all tables in schema public from anon, authenticated;
revoke all on public.admin_secret from anon, authenticated;

-- ---------- internal helpers ----------

create or replace function public._norm(p text) returns text
language sql immutable set search_path = public as $$
  select nullif(regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g'), '')
$$;

create or replace function public._current_session() returns date
language plpgsql stable set search_path = public as $$
declare
  s public.settings;
  l timestamp := now() at time zone 'Asia/Jerusalem';
  d date := l::date;
  diff int;
begin
  select * into s from public.settings where id = 1;
  diff := (s.session_dow - extract(dow from d)::int + 7) % 7;
  if diff = 0 and l::time >= s.rollover_time then diff := 7; end if;
  return d + diff;
end $$;

create or replace function public._deadline(p_session date) returns timestamptz
language sql stable set search_path = public as $$
  select ((p_session - s.deadline_days_before) + s.deadline_time) at time zone 'Asia/Jerusalem'
  from public.settings s where s.id = 1
$$;

create or replace function public._assert_open(p_session date) returns void
language plpgsql stable set search_path = public as $$
begin
  if now() >= public._deadline(p_session) then
    raise exception 'registration_closed';
  end if;
end $$;

create or replace function public._check_code(p_code text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not exists (select 1 from public.admin_secret
                 where code_hash = extensions.crypt(coalesce(p_code, ''), code_hash)) then
    perform pg_sleep(1);
    raise exception 'bad_code';
  end if;
end $$;

create or replace function public._validate_names(p_names text[], p_max int) returns text[]
language plpgsql immutable set search_path = public as $$
declare
  n text;
  result text[] := '{}';
begin
  foreach n in array coalesce(p_names, '{}') loop
    n := public._norm(n);
    if n is null then continue; end if;
    if char_length(n) > 60 then raise exception 'name_too_long'; end if;
    if n = any (result) then raise exception 'duplicate_name:%', n; end if;
    result := result || n;
  end loop;
  if cardinality(result) = 0 then raise exception 'no_names'; end if;
  if cardinality(result) > p_max then raise exception 'too_many'; end if;
  return result;
end $$;

-- Adds names to a group. A name sitting on the waiting list moves into the table.
create or replace function public._add_names(p_group uuid, p_session date, p_names text[]) returns void
language plpgsql security definer set search_path = public as $$
declare
  n text;
  g_kind text;
  ex record;
begin
  select kind into g_kind from public.groups where id = p_group;
  foreach n in array p_names loop
    select p.id, p.group_id, g.kind into ex
      from public.players p join public.groups g on g.id = p.group_id
     where p.session_date = p_session and p.name = n;
    if found then
      if ex.kind = 'waiting' and g_kind = 'table' then
        update public.players set group_id = p_group where id = ex.id;
        delete from public.groups g
         where g.id = ex.group_id
           and not exists (select 1 from public.players where group_id = g.id);
      else
        raise exception 'already_registered:%', n;
      end if;
    else
      insert into public.players (group_id, session_date, name) values (p_group, p_session, n);
    end if;
    insert into public.known_players (name) values (n) on conflict do nothing;
  end loop;
end $$;

create or replace function public._open_group(p_kind text, p_names text[], p_enforce boolean) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  sd date := public._current_session();
  v text[];
  gid uuid;
begin
  if p_enforce then perform public._assert_open(sd); end if;
  v := public._validate_names(p_names, case when p_kind = 'table' then 4 else 2 end);
  insert into public.groups (session_date, kind) values (sd, p_kind) returning id into gid;
  perform public._add_names(gid, sd, v);
  return gid;
end $$;

create or replace function public._join(p_group uuid, p_names text[], p_enforce boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  g public.groups;
  v text[];
begin
  select * into g from public.groups where id = p_group for update;
  if not found or g.kind <> 'table' then raise exception 'table_not_found'; end if;
  if g.session_date <> public._current_session() then raise exception 'table_not_found'; end if;
  if p_enforce then perform public._assert_open(g.session_date); end if;
  v := public._validate_names(p_names, 4);
  perform public._add_names(g.id, g.session_date, v);
  if (select count(*) from public.players where group_id = g.id) > 4 then
    raise exception 'table_full';
  end if;
end $$;

create or replace function public._remove(p_player uuid, p_any_session boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  p public.players;
begin
  select * into p from public.players where id = p_player;
  if not found then return; end if;
  if not p_any_session and p.session_date <> public._current_session() then
    raise exception 'player_not_found';
  end if;
  delete from public.players where id = p.id;
  delete from public.groups g
   where g.id = p.group_id
     and not exists (select 1 from public.players where group_id = g.id);
end $$;

-- ---------- public API (anon) ----------

create or replace function public.get_state() returns json
language plpgsql stable security definer set search_path = public as $$
declare
  sd date := public._current_session();
  dl timestamptz := public._deadline(sd);
  s public.settings;
begin
  select * into s from public.settings where id = 1;
  return json_build_object(
    'session_date', sd,
    'deadline', dl,
    'is_open', now() < dl,
    'server_now', now(),
    'max_tables', s.max_tables,
    'deadline_days_before', s.deadline_days_before,
    'deadline_time', to_char(s.deadline_time, 'HH24:MI'),
    'groups', coalesce((
      select json_agg(json_build_object(
               'id', g.id, 'kind', g.kind, 'created_at', g.created_at,
               'players', (select coalesce(json_agg(json_build_object('id', p.id, 'name', p.name)
                                                    order by p.created_at, p.name), '[]'::json)
                             from public.players p where p.group_id = g.id))
             order by g.created_at)
        from public.groups g where g.session_date = sd), '[]'::json)
  );
end $$;

create or replace function public.open_table(p_names text[]) returns uuid
language sql security definer set search_path = public as $$
  select public._open_group('table', p_names, true)
$$;

create or replace function public.add_waiting(p_names text[]) returns uuid
language sql security definer set search_path = public as $$
  select public._open_group('waiting', p_names, true)
$$;

create or replace function public.join_table(p_group uuid, p_names text[]) returns void
language sql security definer set search_path = public as $$
  select public._join(p_group, p_names, true)
$$;

-- Cancelling is allowed even after the deadline (someone falls ill in the morning).
create or replace function public.remove_player(p_player uuid) returns void
language sql security definer set search_path = public as $$
  select public._remove(p_player, false)
$$;

-- ---------- admin API (shared code) ----------

create or replace function public.admin_check(p_code text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform public._check_code(p_code);
  return true;
end $$;

create or replace function public.admin_open_table(p_code text, p_names text[]) returns uuid
language plpgsql security definer set search_path = public as $$
begin
  perform public._check_code(p_code);
  return public._open_group('table', p_names, false);
end $$;

create or replace function public.admin_add_waiting(p_code text, p_names text[]) returns uuid
language plpgsql security definer set search_path = public as $$
begin
  perform public._check_code(p_code);
  return public._open_group('waiting', p_names, false);
end $$;

create or replace function public.admin_join_table(p_code text, p_group uuid, p_names text[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._check_code(p_code);
  perform public._join(p_group, p_names, false);
end $$;

create or replace function public.admin_remove_player(p_code text, p_player uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._check_code(p_code);
  perform public._remove(p_player, true);
end $$;

create or replace function public.admin_move_player(p_code text, p_player uuid, p_target uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  p public.players;
  t public.groups;
begin
  perform public._check_code(p_code);
  select * into p from public.players where id = p_player;
  if not found then raise exception 'player_not_found'; end if;
  select * into t from public.groups where id = p_target for update;
  if not found or t.kind <> 'table' or t.session_date <> p.session_date then
    raise exception 'table_not_found';
  end if;
  if p.group_id = t.id then return; end if;
  if (select count(*) from public.players where group_id = t.id) >= 4 then
    raise exception 'table_full';
  end if;
  update public.players set group_id = t.id where id = p.id;
  delete from public.groups g
   where g.id = p.group_id
     and not exists (select 1 from public.players where group_id = g.id);
end $$;

create or replace function public.admin_update_settings(p_code text, p_days_before int, p_deadline_time text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._check_code(p_code);
  update public.settings
     set deadline_days_before = p_days_before,
         deadline_time = p_deadline_time::time
   where id = 1;
end $$;

create or replace function public.admin_set_code(p_code text, p_new_code text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public._check_code(p_code);
  if char_length(coalesce(btrim(p_new_code), '')) < 4 then raise exception 'code_too_short'; end if;
  update public.admin_secret set code_hash = extensions.crypt(btrim(p_new_code), extensions.gen_salt('bf')) where id = 1;
end $$;

create or replace function public.admin_add_known(p_code text, p_name text) returns void
language plpgsql security definer set search_path = public as $$
declare
  n text := public._norm(p_name);
begin
  perform public._check_code(p_code);
  if n is null then raise exception 'no_names'; end if;
  if char_length(n) > 60 then raise exception 'name_too_long'; end if;
  insert into public.known_players (name) values (n) on conflict do nothing;
end $$;

create or replace function public.admin_remove_known(p_code text, p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._check_code(p_code);
  delete from public.known_players where name = p_name;
end $$;

-- ---------- function permissions ----------

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.get_state(),
  public.open_table(text[]),
  public.add_waiting(text[]),
  public.join_table(uuid, text[]),
  public.remove_player(uuid),
  public.admin_check(text),
  public.admin_open_table(text, text[]),
  public.admin_add_waiting(text, text[]),
  public.admin_join_table(text, uuid, text[]),
  public.admin_remove_player(text, uuid),
  public.admin_move_player(text, uuid, uuid),
  public.admin_update_settings(text, int, text),
  public.admin_set_code(text, text),
  public.admin_add_known(text, text),
  public.admin_remove_known(text, text)
to anon, authenticated;

-- ---------- realtime ----------

alter publication supabase_realtime add table public.groups, public.players;

-- ---------- migration: keep typing order within one registration ----------
alter table public.players alter column created_at set default clock_timestamp();
alter table public.groups alter column created_at set default clock_timestamp();

-- ---------- migration: admin access to past sessions ----------
create or replace function public._groups_json(p_session date) returns json
language sql stable security definer set search_path = public as $$
  select coalesce((
    select json_agg(json_build_object(
             'id', g.id, 'kind', g.kind, 'created_at', g.created_at,
             'players', (select coalesce(json_agg(json_build_object('id', p.id, 'name', p.name)
                                                  order by p.created_at, p.name), '[]'::json)
                           from public.players p where p.group_id = g.id))
           order by g.created_at)
      from public.groups g where g.session_date = p_session), '[]'::json)
$$;

create or replace function public.admin_sessions(p_code text) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform public._check_code(p_code);
  return coalesce((
    select json_agg(json_build_object('session_date', d, 'players', n) order by d desc)
      from (select session_date d, count(*) n from public.players
             where session_date < public._current_session()
             group by session_date) s), '[]'::json);
end $$;

create or replace function public.admin_session_groups(p_code text, p_session date) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform public._check_code(p_code);
  return public._groups_json(p_session);
end $$;

revoke execute on function public._groups_json(date) from public, anon, authenticated;
grant execute on function public.admin_sessions(text), public.admin_session_groups(text, date) to anon, authenticated;

-- ---------- migration: participants only submit; registrations visible to admins only ----------
create or replace function public.get_session() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('session_date', public._current_session(),
                           'is_open', now() < public._deadline(public._current_session()))
$$;

create or replace function public.admin_state(p_code text) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform public._check_code(p_code);
  return public.get_state();
end $$;

drop policy if exists "read groups" on public.groups;
drop policy if exists "read players" on public.players;
alter publication supabase_realtime drop table public.groups, public.players;

revoke execute on function public.get_state(), public.join_table(uuid, text[]), public.remove_player(uuid) from anon, authenticated;
grant execute on function public.get_session(), public.admin_state(text) to anon, authenticated;

-- ---------- migration: strip invisible direction marks from names ----------
create or replace function public._norm(p text) returns text
language sql immutable set search_path = public as $$
  select nullif(regexp_replace(btrim(regexp_replace(coalesce(p, ''), '[‎‏‪-‮⁦-⁩]', '', 'g')), '\s+', ' ', 'g'), '')
$$;
