-- Route history: rebuild public.route_tiles from the stored walks with the
-- current classifier. *_detours.sql backfilled route_tiles from walk_points
-- with the old speed test, which counted GPS jumps on a walk as fast, and
-- without the vehicle buffer. On a database that gets both migrations in one
-- run, that backfill runs before *_gps_accuracy.sql, so the history it
-- leaves behind disagrees with what claim_settled writes from now on.
--
-- This recomputes the route tiles exactly as private.claim_settled records
-- them: the ends and middle of every claimable shape (settled, vehicle-free
-- walking segments, and isolated points), on the game day of its end, in the
-- player's current time zone. Claimed cells, pay, and detour offers are left
-- as they are.
--
-- For each player with stored points, the tiles from the game day of their
-- earliest stored point onward are replaced. Older tiles, whose points
-- private.purge_walk_points() already deleted, are kept. Running this again
-- gives the same result.

do $$
declare
  r record;
  dr record;
  u record;
  v_w interval;
  v_reset interval := make_interval(hours => (private.economy_rules() ->> 'dailyResetHour')::int);
begin
  select * into r from private.claim_rules();
  select * into dr from private.detour_rules();
  v_w := make_interval(secs => r.vehicle_buffer_s);

  for u in
    select w.user_id, coalesce(e.time_zone, 'UTC') as tz, min(w.recorded_at) as first_t
    from public.walk_points w
    left join public.player_economy e on e.user_id = w.user_id
    group by w.user_id, e.time_zone
  loop
    delete from public.route_tiles t
    where t.user_id = u.user_id
      and t.game_day >= ((u.first_t at time zone u.tz) - v_reset)::date;

    insert into public.route_tiles (user_id, tile, game_day)
    with pts as (
      -- Every stored point of the player, all sessions. Neighbors and spans
      -- stay within a session.
      select c.session_id, c.recorded_at, c.geom, c.prev_t, c.prev_geom, c.kind as in_kind,
        lead(c.kind) over (partition by c.session_id order by c.recorded_at) as out_kind
      from private.classified_points(u.user_id, null, '-infinity', 'infinity') c
    ),
    shapes as (
      -- Walking segments, as [t0, t1] = [t_p, t_q].
      select p.session_id, extensions.st_makeline(p.prev_geom, p.geom) as g,
        p.prev_t as t0, p.recorded_at as t1, true as is_segment
      from pts p
      where p.in_kind = 'walk'
      union all
      -- Points with no neighbor in reach.
      select p.session_id, p.geom, p.recorded_at, p.recorded_at, false
      from pts p
      where coalesce(p.in_kind, 'gap') = 'gap' and coalesce(p.out_kind, 'gap') = 'gap'
    ),
    fast as (
      -- Fast segments in any of the player's sessions.
      select p.prev_t as t0, p.recorded_at as t1
      from pts p
      where p.in_kind = 'fast'
    ),
    sessions as (
      select p.session_id, max(p.recorded_at) as last_t, bool_or(ws.closed_at is not null) as closed
      from pts p
      left join public.walk_sessions ws on ws.user_id = u.user_id and ws.session_id = p.session_id
      group by p.session_id
    ),
    claimable as (
      select s.*
      from shapes s
      join sessions ss on ss.session_id = s.session_id
      where (ss.closed or s.t1 + v_w <= ss.last_t)
        and not exists (
          select 1 from fast f
          where f.t0 <= s.t1 + v_w and f.t1 >= s.t0 - v_w)
    )
    select distinct u.user_id, private.tile_of(extensions.st_transform(p.pt, 3857), dr.route_zoom),
      ((s.t1 at time zone u.tz) - v_reset)::date
    from claimable s
    cross join lateral (
      select (extensions.st_dumppoints(s.g)).geom as pt
      union all
      select extensions.st_lineinterpolatepoint(s.g, 0.5) where s.is_segment
    ) p
    on conflict do nothing;
  end loop;
end
$$;
