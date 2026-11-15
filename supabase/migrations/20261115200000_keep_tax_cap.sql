-- The Keep tax for missed days piles up for at most 7 days.
--
-- Before this migration, private.settle_keep_tax paid every game day since the
-- last payment, with no limit. A player who returns after more than 7 game
-- days now gets 7 days' tax. The 7 isn't in the economy sheet, so it lives in
-- private.economy_placeholders() until the sheet has a cell for it.
--
-- Every owed day pays at the Keep level it had. The Keep level changes only
-- through private.build, which settles the tax first, so every day since the
-- last payment had the current Keep level.

-- Values that neither the economy sheet nor the plan gives, in one place.
create function private.economy_placeholders(
  out keep_tax_max_days int  -- PLACEHOLDER (the user's decision): missed Keep tax piles up for at most this many game days.
)
language sql
immutable
parallel safe
set search_path = ''
as $$
  select 7
$$;

comment on function private.economy_placeholders() is
  'Economy values that are not in the economy sheet yet. Move them into the sheet when it has cells for them.';

-- Pays the Keep tax for the game days from the last one paid up to the day of
-- p_at: one day for the first payment, then one per day since, but at most
-- keep_tax_max_days. Days the player didn't open the app still pay. Paying
-- again on the same day pays nothing. Returns {days, gold}, where days is the
-- number of days paid; details.owedDays in the ledger has the days owed before
-- the cap.
create or replace function private.settle_keep_tax(p_user uuid, p_at timestamptz)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v public.player_economy := private.ensure_economy(p_user);
  v_level int := private.keep_level(p_user);
  v_today date := private.game_day(p_at, v.time_zone);
  v_owed int;
  v_days int;
  v_per_day numeric;
begin
  v_owed := case when v.keep_tax_paid_through is null then 1
                 else greatest(0, v_today - v.keep_tax_paid_through) end;
  v_days := least(v_owed, (select p.keep_tax_max_days from private.economy_placeholders() p));
  if v_days = 0 then
    return jsonb_build_object('days', 0, 'gold', 0);
  end if;
  v_per_day := (private.economy_rules() -> 'buildings' -> 'keep' -> 'levels' -> (v_level - 1) -> 'effects' ->> 'goldTaxPerDay')::numeric;
  update public.player_economy set keep_tax_paid_through = v_today where user_id = p_user;
  perform private.credit(p_user, 'keep_tax', v_today::text, v_days * v_per_day, 0, 0, 0, 0, 0,
    jsonb_build_object('days', v_days, 'owedDays', v_owed, 'keepLevel', v_level, 'perDay', v_per_day));
  return jsonb_build_object('days', v_days, 'gold', v_days * v_per_day);
end;
$$;

revoke all on all functions in schema private from public, anon, authenticated;
