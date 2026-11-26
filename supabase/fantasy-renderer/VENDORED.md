# Where the painter came from

The painter (`painter/`) and its art (`assets/`) are no longer vendored: since November 26,
2026 this repository is their source of truth. Change them here
([painter/README.md](painter/README.md), [art/README.md](art/README.md)); the old sync script is
gone.

They began as a local prototype (`prototypes/fantasy-map/`, never committed), copied here up to
its round 11. On November 26, 2026 the rest of what a contributor needs came along:

- the art build tools (`art/tools/`: `sprites5.py`, `cutout.py`, `sidebyside.py`, and
  `drawn-sizes.mjs`, rewritten to run on the renderer instead of the prototype's viewer);
- the small inputs that decide placement (`art/meta/`: footprints, set piece placements,
  filler templates, drawn sizes, the generation log);
- the painter's design notes (`painter/HISTORY.md`) and the map research (`painter/RESEARCH.md`).

Left out on purpose: the prototype's viewer and its check tools (a throwaway; the renderer's
tests cover determinism and seams), and the raw concept art (658 MB, of which the atlas build
reads about 560 MB), which stays on the owner's machine. A rebuild from that art reproduced
all 36 committed art files byte for byte.

The last copy from the prototype, on 2026-11-26T02:28:49Z (art: 18.1 MB in 36 files):

| Here | Prototype file | SHA-256 (first 16) |
| --- | --- | --- |
| painter/tilepainter.js | tilepainter.js | 38a5e03021f05123 |
| painter/painter5.js | painter5.js | e4883ac753c1ff3b |
| painter/fmworld.js | fmworld.js | 93bd099cba05bae4 |
| painter/fmcore.js | fmcore.js | 05b62fa9ccb0fbd2 |
| painter/tiledata.js | tiledata.js | 7123a8725aeae46b |
| painter/vendor/vt.mjs | vendor/vt.mjs | 1a97c81fb53218ae |
| assets/bundle.json | sprites5/bundle.json | dcd414733ae88b56 |
| assets/index.json | sprites5/index.json | 0b4e5dd9108873b2 |
| assets/atlas.webp | sprites5/atlas.webp | 4d6abfe7b20547c7 |
| assets/atlas2.webp | sprites5/atlas2.webp | 17f4846624a69429 |
| assets/atlas3.webp | sprites5/atlas3.webp | a2b40867d882ba00 |
| assets/tex-canal-reflection-painted.webp | sprites5/tex-canal-reflection-painted.webp | f9d93b192c164d36 |
| assets/tex-canal-sun-sweeps.webp | sprites5/tex-canal-sun-sweeps.webp | b6d233f96c8569d7 |
| assets/tex-cobbled-road.webp | sprites5/tex-cobbled-road.webp | db66997a58c7c401 |
| assets/tex-cobbled-square.webp | sprites5/tex-cobbled-square.webp | c348ac1783ad53f4 |
| assets/tex-dirt-path.webp | sprites5/tex-dirt-path.webp | cdc64aae7f6b4921 |
| assets/tex-forest-floor.webp | sprites5/tex-forest-floor.webp | 79d49f013f19757e |
| assets/tex-lake-water.webp | sprites5/tex-lake-water.webp | 87aadb58d72ee3f6 |
| assets/tex-meadow-cool.webp | sprites5/tex-meadow-cool.webp | b496551e7a0ceca2 |
| assets/tex-meadow-deep-green.webp | sprites5/tex-meadow-deep-green.webp | 6a5ba925601ec2e8 |
| assets/tex-meadow-dry-patches.webp | sprites5/tex-meadow-dry-patches.webp | 3ab31f8e580dd859 |
| assets/tex-meadow-soft.webp | sprites5/tex-meadow-soft.webp | b3f38641e6a39a19 |
| assets/tex-meadow-sunlit.webp | sprites5/tex-meadow-sunlit.webp | d63a80257bd976e7 |
| assets/tex-meadow-sunlit-clover.webp | sprites5/tex-meadow-sunlit-clover.webp | b5e63b2148a48db7 |
| assets/tex-meadow-sunlit-copper.webp | sprites5/tex-meadow-sunlit-copper.webp | 65d68b7e9b3084ce |
| assets/tex-meadow-sunlit-gold.webp | sprites5/tex-meadow-sunlit-gold.webp | cc8abed26f6fb620 |
| assets/tex-meadow-sunlit-lowland.webp | sprites5/tex-meadow-sunlit-lowland.webp | 4d143b2cf1c2a854 |
| assets/tex-meadow-swales.webp | sprites5/tex-meadow-swales.webp | 1d715a6438969d90 |
| assets/tex-pasture.webp | sprites5/tex-pasture.webp | b9c9ddd823fbe9e2 |
| assets/tex-paving-herringbone.webp | sprites5/tex-paving-herringbone.webp | 2216676866fe89a5 |
| assets/tex-ploughed-earth.webp | sprites5/tex-ploughed-earth.webp | 4eef1cc2322f1ba5 |
| assets/tex-river-bright-current.webp | sprites5/tex-river-bright-current.webp | c4f73c6539643948 |
| assets/tex-river-current-painted.webp | sprites5/tex-river-current-painted.webp | e9f0fa185b6e4cc7 |
| assets/tex-river-water.webp | sprites5/tex-river-water.webp | 70a7b717614584be |
| assets/tex-rock.webp | sprites5/tex-rock.webp | 75230599d3b69402 |
| assets/tex-sand.webp | sprites5/tex-sand.webp | 3dba5a404edebaac |
| assets/tex-scree.webp | sprites5/tex-scree.webp | 881b8e9a7d34a6cd |
| assets/tex-shallow-water.webp | sprites5/tex-shallow-water.webp | 58778306f8998102 |
| assets/tex-snow.webp | sprites5/tex-snow.webp | fb525c02226f00ac |
| assets/tex-vegetable-rows.webp | sprites5/tex-vegetable-rows.webp | 9484c849cbd47e90 |
| assets/tex-wheat-field.webp | sprites5/tex-wheat-field.webp | 15b314820aa59216 |
| assets/tex-wildflower-meadow.webp | sprites5/tex-wildflower-meadow.webp | 29f50379611edb91 |
| assets/fonts/IMFeENsc28P.ttf | fonts/IMFeENsc28P.ttf | 102324fb5434bb5d |
| assets/fonts/OFL.txt | fonts/OFL.txt | 2a3ca501fc4d5efc |
