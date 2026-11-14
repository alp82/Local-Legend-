-- One row of saved game state per player.
-- Players sign in anonymously, so every player has a real auth.users row.

create table public.player_state (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  display_name text null
    constraint player_state_display_name_length
    check (display_name is null or char_length(btrim(display_name)) between 1 and 32),
  state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.player_state is 'Saved game state, one row per player. Owner-only access through RLS.';
comment on column public.player_state.state is 'Opaque game state owned by the client. Kept schemaless until tracking requirements are clearer.';

-- Keep updated_at current and make user_id immutable after insert.
create function public.player_state_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'player_state.user_id cannot be changed'
      using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger player_state_before_update
before update on public.player_state
for each row execute function public.player_state_before_update();

-- Privileges: anon gets nothing; authenticated gets only what the client needs.
revoke all on table public.player_state from anon, authenticated;
grant select, insert, update on table public.player_state to authenticated;
revoke execute on function public.player_state_before_update() from public, anon, authenticated;

-- Row level security: each player can read and write only their own row.
alter table public.player_state enable row level security;

create policy "Players can read their own state"
on public.player_state
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Players can create their own state"
on public.player_state
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "Players can update their own state"
on public.player_state
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
