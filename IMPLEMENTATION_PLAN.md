# Initial implementation plan

Build a working walking-and-territory prototype in four steps.

1. **Expo setup and test distribution**
   - Install the app on Android and iPhone.
   - Configure development builds, standalone preview builds, and OTA updates.
   - Verify a visible change reaches both phones through OTA. Native dependencies and permission changes require a new build.

2. **Minimal database**
   - Set up Supabase, migrations, authentication, and access rules.
   - Verify each player can save and reload their own state.
   - Keep the schema small until tracking requirements are clearer.

3. **Map and GPS tracking**
   - Render the map and current location.
   - Record walks in the background with the screen locked.
   - Queue uploads offline and prevent duplicate processing.
   - Persist claimed territory and show it after reopening the app.
   - Add rough fog and reveal effects to assess tracking quality and the exploration experience.
   - Begin real commute tests on both platforms, measuring missed walks and battery impact.

4. **Game asset overlays**
   - Add placeholder territory, landmark, and building overlays.
   - Check geographic alignment and performance while panning and zooming.
   - Introduce painted assets once the overlays work reliably.

## First milestone

Install → walk with the phone locked → reopen → see new land → restart and still own it.

# Phase 2: the core game loop

Phase 1 answered whether tracking and territory work. Phase 2 tests the design document's core bet: players take detours, and the daily reveal → spend → plan loop keeps them coming back. Build the smallest version of that loop, then put it in front of testers.

Commute tests from step 3 continue alongside this work and don't block it. Record their results (missed walks, battery impact) in `docs/` as they come in.

## Scope

In: rules as data, resources, the kingdom screen with a few buildings, Pikemen, Ruler XP, detour offers, the weekly Mist surge, and analytics.

Out until the loop works: place cards, mines, bosses, spells, other unit lines, friends, the chronicle, the store, and painted kingdom art.

## Steps

1. **Rules as data**
   - Generate a rules file from `Local Legend_Economy.xlsx` (buildings, costs, effects, income, XP, the Mist) with a script, so rebalancing needs no code changes.
   - Use the same rules on the server and in the app. The server stays the authority for every reward.
   - Verify that changing a cost in the spreadsheet and regenerating changes it in the app.

2. **Resources and Ruler XP**
   - Add gold, wood, stone, crystal, and gems to player state, starting at 2,000 gold, 20 wood, and 20 stone.
   - Pay the daily Keep tax.
   - Pay for walking by terrain: new ground and walks on your own land, at the rates and daily caps in the design document. Classify terrain (built-up, park, waterside, hills) from the OpenFreeMap data the `sites` function already reads.
   - Award Ruler XP and levels, since they gate buildings.
   - Verify that a walk pays the expected resources on the server, once, even when batches are retried.

3. **The kingdom screen**
   - Add a kingdom screen with plots for the Keep, Treasury, Walls, and Barracks. Placeholder art is fine.
   - Build instantly, one construction a day, resetting at 4 a.m. No building can exceed the Keep's level.
   - Barracks recruit Pikemen into a garrison.
   - Verify that building and recruiting spend the right amounts and that the daily limit holds across restarts and time zones.

4. **Detour offers**
   - Each morning, generate 2 to 5 offers just off routes the player walks often, labeled with the added time. Estimate the time from distance (about 30% more than a straight line).
   - Place offers only at public, walkable spots.
   - Collect an offer by walking within about 30 m of it, decided on the server from uploaded points.
   - Verify that offers appear near real routes and that collecting one pays out exactly once.

5. **The weekly Mist surge**
   - Run the surge every Sunday night on the server: strength from the Keep draw and frontier length, defense from Walls and the garrison.
   - Apply the results: rewards when it holds; lost frontier land (at most 5% a week) and garrison losses when it breaks through.
   - Make a new player's first surge gentle (half pressure) and add Rest days.
   - Show the result in the app on Monday morning.
   - Verify with a test player that a surge can hold and can break through, and that home and roads are never lost.

6. **Analytics**
   - Record app opens, walks captured, detours offered and taken, buildings built, and surge results.
   - Verify that you can compute the beta targets from the data: 4+ days a week retention after three weeks, and the share of active players taking at least one detour a week.

## Phase 2 milestone

Walk to work → collect a detour → reopen in the evening → spend what you earned in the kingdom → survive the Sunday surge → see the result on Monday.
