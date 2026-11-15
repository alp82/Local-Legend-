# Game rules as data

The game's numbers (buildings, costs, effects, income, XP, units, spells,
trading, and the Mist) come from `Local Legend_Economy.xlsx`. A script turns
the workbook into one TypeScript file, so rebalancing needs no code changes.

## Where the rules live

The script writes the same file to two places:

| File | Used by |
| ---- | ------- |
| `mobile/src/lib/rules.generated.ts` | The app. Import it as `@/lib/rules.generated`. |
| `supabase/functions/_shared/rules.generated.ts` | Edge Functions. Import it as `../_shared/rules.generated.ts`. |

Each file holds the `Rules` type and a `rules` constant with no imports, so
Metro, Node, and Deno all load it as is. Two copies avoid configuring Metro to
read files outside `mobile/`, and keep Edge Function imports inside
`supabase/functions/`, in the `_shared` folder that Supabase recommends for code
shared between functions. Supabase doesn't deploy folders whose names start
with an underscore as functions.

Don't edit either file by hand. `node scripts/generate-rules.mjs --check` fails
if either copy no longer matches the workbook.

The server stays the authority for every reward. The app reads the rules to
show costs and previews.

## Regenerate the rules after editing the spreadsheet

1. Edit `Local Legend_Economy.xlsx` in LibreOffice Calc or Excel. Change the
   blue input cells; everything else is a formula.
1. Save the workbook in `.xlsx` format. The script reads the values the
   spreadsheet app calculated when it saved, so don't edit the file with a
   tool that doesn't recalculate formulas.
1. From the repository root, run:

   ```sh
   node scripts/generate-rules.mjs
   ```

   Or, from `mobile/`, run `npm run rules`.

1. Review the diff of the two generated files, then run the checks:

   ```sh
   cd mobile && npm run typecheck && npm test -- rules
   ```

1. Commit the workbook and both generated files together.

To check that the generated files match the workbook without writing them, run
`node scripts/generate-rules.mjs --check` (or `npm run rules:check`). To
generate from another copy of the workbook, add `--xlsx <path>`.

The script needs Node 22 or later and uses only built-in modules.

## When the script stops

The script refuses to write anything when the workbook doesn't look like it
expects, and lists every problem with its cell. Common causes:

- **A new named input cell or effect column.** The script never drops a value
  silently. Map the new value in `scripts/generate-rules.mjs` and add it to the
  `Rules` type in the same file. If the value only feeds a formula whose result
  is already in a table, add it to `INPUTS_IN_TABLES` instead.
- **A new building, mine, unit, or spell.** Add its name and id to the id
  tables at the top of the script, and the id to the matching type.
- **Stale values.** If a base cost on **Buildings** doesn't match level 1 on
  **Building Costs**, the workbook was saved without recalculating. Open it in
  a spreadsheet app, recalculate (in Calc, **Data** > **Calculate** >
  **Recalculate Hard**), and save it.

## What the script reads

| Sheet | Becomes |
| ----- | ------- |
| **Buildings**, **Building Costs** | `buildings`: unlock level, max level, and every level's cost, construction XP, and Keep and Ruler requirements |
| **Building Effects** | `buildings.<id>.levels[n].effects` |
| **Mines**, **Building Costs** | `mines.types` |
| **Units** | `units` (the recruitment calculator is ignored) |
| **Spells** | `spells` |
| **Trading** | `trading.levels` |
| **XP** level table | `xp.rulerLevels` |
| **Inputs** named cells | Walking pay and caps, detour rewards, XP sources, the Mist, seasons, and starting resources |

The **Players** and **Income** sheets, the weekly XP estimates, the surge and
siege calculators, and the terrain-share inputs model typical players. They
aren't rules, so the script skips them.
