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
