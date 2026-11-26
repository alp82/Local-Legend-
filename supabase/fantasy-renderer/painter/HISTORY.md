# Fantasy map painter: design history

How the painter's look and rules were reached, round by round, while it lived in a local
prototype (November 2026). It's kept as it was written, for the reasoning behind the rules.
Since round 11 the painter lives here, in `supabase/fantasy-renderer/painter/`; see
[README.md](README.md) for how to change it now.

References in this history to the prototype's viewer (`app.js`, `chunks.js`,
`chunkworker.js`, `index.html`, `serve.py`), its check tools (`tools/checks.mjs`,
`tools/purity.mjs`) and the raw concept art (`concept/`) point at files that aren't in the
repository. `sprites5/` is now `assets/`, and `tools/sprites5.py`, `tools/cutout.py` and
`tools/sidebyside.py` are now in `art/tools/`. The renderer's tests took over the purity proof
(`test/renderer.test.mjs`, `test/neighbours.test.mjs`).

## Round 2: variant B as the direction

The owners chose B. A's far-zoom atlas look and terrain stay underneath it. B
now opens by default. Instead of a grid of field cells, `world.js` generates an
organic landscape for each view:

- **Patches**: Voronoi cells on a jittered grid. Every shared edge is wobbled
  the same way from both sides, so outlines are irregular and still meet. Cells
  are cut out of the real water polygons, so nothing on land crosses a canal or
  a river.
- **Land types**: chosen from the real landcover, landuse and parks; the distance
  to water; elevation and slope from the terrain tiles; building density and the
  tier of the nearest settlement; and two scales of noise anchored to the world.
- **Patch groups**: types and texture variants are drawn once per warped group
  of cells, so neighbouring cells merge into one patch.
- **Detail**:
  - Hedgerows (with hedge trees), dry-stone walls or fences between patches.
  - About 50 scatter symbols, chosen per land type.
  - Walled towns with houses, gates and wall towers.
  - Quays, boats, cranes and mills along the water.
  - Real points of interest drawn as landmarks.
- **Stats**: the state panel lists the share of land types on screen,
  including "% plain fields".

## Round 3: the walking zoom is painted

From z14.5, variant B is painted by `painter.js` onto one 2D canvas (art in
`art3.js`). MapLibre shows that canvas as a `canvas` source under the labels and
the game overlays. Below z14.5, the round 2 vector layers still draw the atlas.
The guiding principles are in `RESEARCH-beautiful-game-maps.md`.

Everything drawn comes from real data at that spot, anchored to world
coordinates:

- **Town houses**: terraced houses line the real streets wherever the smoothed
  density of real buildings is high. Their ridges run parallel to the street,
  with back gardens behind them.
- **Village cottages**: real buildings, grouped on a fixed district grid.
- **Trees**: real woods, parks, cemeteries and orchards.
- **Water**: real water and waterways. Quays and boats appear only along water
  in towns, and reeds only on the wild banks.
- **Landmarks**: real points of interest with real names.
- **Markets**: real shop clusters.
- **Bridges**: real bridges.
- **Fields**: real farmland, plus a few hedged blocks next to each village.

A paint takes about 1 s on a desktop GPU.

## Round 4: connected villages in open country

The city no longer fills the screen with houses. From z14.5, `painter.js` turns it
into a few villages, set in countryside whose shape comes from the real streets and
buildings. Everything is placed deterministically from real data; there is no random
placement.

The hero zoom is **z16**. That is `DEFAULT_ZOOM` in
`mobile/src/hooks/use-follow-camera.ts`, which the walking camera holds. Judge it at
phone size: `shoot.mjs` takes `r4-<loc>-phone-z16` at 390×844 CSS px, 3×, with
`ui=0`.

### Villages

- **Where**: building mass is computed on a 20 m grid and smoothed over about
  250 m. The strongest cell in each 160 m block is a candidate. The spacing
  between villages depends on density: 230 m at the densest, about 330 m
  elsewhere. A candidate next to a real church only has to keep 150 m from other
  villages, so every church gets a village of its own.
- **Size**: the tier (0–3) sets the radius (30–74 m) and the house count (2, 4,
  7, 11).
- **Anchor**: a village moves onto a real church, town hall, station or market
  square if one is within 110 m.
- **Name**: the nearest real suburb, quarter, neighbourhood or village label
  within 420 m. A village label sits below its houses. Acronyms and names near the
  screen edge are dropped.
- **Houses**: they stand on both sides of the village's real main street (the
  real street with the most length inside it), facing it. The types are thatched
  cottage, timber-frame, stone, barn, long house and tower house. Line weights
  scale with the house, with outlined eaves, tiled or thatched roofs, a stone
  footing and framed windows, so the houses sit closer to the painted sprites.
- **Village heart**: a village with no painted building, church or market gets a
  green with a well and trees.

### Painted buildings (`assets/`, cut out by `tools/cutout.py`)

These are copies of the UI Assets paintings with the white background removed.
The originals are not touched. Each village gets at most one painted building,
taken from what is really around it (within 2.2× its radius):

| Painted building | Real thing | Level |
|---|---|---|
| Castle | Town hall, castle or palace POI (in a village of tier 1 or more), or the densest village on screen (tier 3) | 3 for the densest, 2 for tier 2, else 1 |
| Fantasy Tavern | 4 or more bars, pubs, restaurants, fast food places or cafés | 3 for 14 or more, 2 for 8 or more, else 1 |
| Stables | Railway or bus station | 3 for 3 or more, 2 for 2, else 1 |
| Barracks | Military POI, or a name with barracks or Kaserne | Village tier |
| Watchtower | Police, fire station, or a tower, obelisk or column monument | Village tier |
| Archery | Stadium, sports centre, pitch, swimming pool or golf course | Village tier |
| Stone mine | Quarry landuse within 250 m | Village tier |
| Sawmill | Industrial landuse next to woods, or a small village at a wood edge | Village tier |
| Gold mine | Industrial landuse away from woods | Village tier |

Caps keep the same building at least 0.9 × the longer screen side away from its
twin, and any two painted buildings at least 0.32 × the shorter side apart. A
painted building also needs at least two houses round it, or it is dropped.
Churches remain drawn landmarks with their real names, and markets appear where
12 or more real shops cluster.

### Where it stands

Five rounds of independent critique scored the phone views at an average of
3.0, 3.8, 3.5, 3.7 and 3.3 out of 10, against a target of 8. What holds it back:

- **Emptiness.** About 70–90% of each phone screen is grass between the
  villages.
- **Clashing styles.** The flat code-drawn cottages and trees sit beside the
  glossy painted buildings.
- **Wrong focal buildings.** The rules pick some odd ones: a sawmill as the
  biggest sprite at Andechs, and a castle in a suburb.
- **Roads.** There are still gaps and dead ends.
- **Mountains.** Nothing yet reads as a mountain at z16.

### Countryside

- **Parcels**: every real block between streets becomes one parcel, and what the
  block holds decides what it becomes:

  | Block | Parcel |
  |---|---|
  | Big buildings, next to a village | Ploughed field (furrows on the block's own axis) |
  | Many small houses, next to a village | Orchard (rows along the block's axis) |
  | Small houses elsewhere | Garden meadow |
  | Half built up | Hay meadow (haystacks by block size) |
  | Lightly built up | Meadow |
  | No buildings | Pasture |

- **Trees**: the biggest real building in a block becomes a copse of the same
  shape. Other large buildings leave one tree, at most one per 34 m. The surviving
  main roads are lined with trees.
- **Roads**: motorway, trunk, primary and secondary roads survive as modest earth
  tracks, and tertiary roads as narrow lanes. A dual carriageway is merged into
  one track.
- **Terrain**: the real slope (from the AWS terrain tiles at z14, sampled
  bilinearly) shades the whole painting, lit from the north-west. Steep ground
  gets boulders, and real summits are drawn as peaks.
- **Forests**: real forest trails stay open through the trees.
- **Water**: real water polygons are filled one at a time. Overlapping tile
  pieces cancelled each other under an even-odd fill. Gaps where a bridge cuts the
  water are closed on a coarse raster. The shoreline comes from the land mask, so
  tile seams inside the water stay invisible.

## Round 5: painted sprites, painted textures, world-anchored chunks

From z14.5, everything on the map is a painted sprite from `concept/objects*` (made
by another agent with image generation, matched to the six target pictures in
`concept/targets/`). Only the ground is painted in code, and it is painted with the
`concept/textures/` tiles. `tools/sprites5.py` copies the art into `sprites5/`, so
the concept folder is never written.

### What the real data turns into

- **Village hearts** ("Village heart" mode, the default): one per fixed 420 m world
  cell (700 m in "Open country" mode). Each sits at the cell's strongest real
  place: a square or market, an important church, the town hall or a station,
  preferring the cell's middle. It gets a cobbled square with a fountain (towns) or
  a well (villages), and the church sprite (cathedral, monastery or chapel) at the
  real church. Market stalls appear where real shops are, an inn where there are
  real pubs, and the town hall at the real town hall. Houses of mixed types stand
  along the real streets and at real building positions, with yards, gardens and
  trees between them.
- **Blocks between the real streets**:
  - Fields (wheat, ploughed earth, vegetable rows) next to villages.
  - Orchards and gardens where real small houses stand.
  - Groves elsewhere.
  - Sheep, cows and paddocks on real empty blocks.
- **Woods**: forest masses (pine higher up). Parks get shade trees, cemeteries
  graveyard patches, real monuments a statue.
- **Slopes**: pines on real slopes, with cliff bands, rock and scree on steep
  ground. Real summits become peak or massif sprites.
- **Canals**: canal row houses (in the Low Countries only), stone walls, and arched
  bridges where real bridges cross. River bridges longer than 48 m become painted
  stone decks.
- **Rivers**: reeds on wild banks, and a watermill where a stream passes a village.

### Textures

| Texture | Where |
|---|---|
| Meadow (soft, sunlit, cool, wildflower) | Everywhere, blended in world space; cool with elevation |
| Pasture | Parks and large real farmland |
| Wheat field, ploughed earth, vegetable rows | Real farmland and the fields of a village, rotated to the block |
| Forest floor | Under real woods |
| Dirt path | Every real street, and real paths in woods |
| Cobbled road | Main roads inside a village heart, long bridge decks |
| Cobbled square | Village squares, canal walls |
| River water, lake water, shallow water | Rivers and canals; still water; a band along every shore |
| Sand, scree | Wild riverbanks in the lowlands; in the mountains |
| Rock, scree, snow | Real rock and steep slopes; moderate mountain slopes; above about 1,900 m |

### Where it stands (round 5)

- **Scores**: independent critics compared phone screens with the targets in five
  passes. Average scores: 3.7, 4.0, 4.2, 4.2 and 4.25 out of 10 (best: Andechs 5, the
  Innsbruck slope 6, Manhattan 5).
- **What holds it back**: everything between the sprites. The ground still reads
  as a fill, houses have no lots or fences, the squares are plain, the water edges
  are soft, and a few sprites repeat. A good part of the remaining gap is missing
  art: oriented fences, hedges and quays, canal bridges for every direction,
  regional churches, boats, decals and town-core terraces.

### Speed: world-anchored chunks (`chunks.js`, `chunkworker.js`, `tiledata.js`)

- **Chunks**: the picture is made of fixed 320 m world chunks per zoom band
  (half-zoom steps). A pool of Web Workers paints them on OffscreenCanvas, visible
  chunks first, then the margin, then a ring around the view at low priority.
- **Composing**: the main thread only composes finished chunks with drawImage, and
  the previous picture stays up until the new one is composed.
- **Plans**: each chunk has a plan (the sprites anchored in it), computed from a
  fixed window around the chunk. The plans are shared between workers. A chunk's
  sprites are drawn from the plans of its 3×3 neighbourhood, so sprites crossing a
  chunk border match on both sides.
- **Data**: the painter decodes the OpenMapTiles z14 tiles itself
  (`vendor/vt.mjs`, through the pass-through). The same place therefore always
  paints the same picture, whatever the map shows and however the view got there.
  A test of a fresh load against arriving by a 600 m pan gave identical pixels.

## Round 6: village heart, geometry, set-three art

Village heart is the direction; open country stays as a comparison only.

### What changed

- **Oriented modules** (`concept/objects3`, four directions each): fences, hedges, stone walls,
  canal quays, rocky banks, square kerbs and bridges are laid along real lines. A run takes the
  nearest drawn direction and turns the rest of the angle (at most 22.5°). Modules sit on a fixed
  world grid along each line (`alongW`), so the same line gives the same modules whichever tile
  delivered it.
- **Bridges**: every real crossing (a bridge line over water, dry ground at both ends) gets a deck
  painted from its own geometry: the road carries on between two stone parapets. An arched canal
  bridge (short crossings) or modular three-arch river spans (long ones) stand on the deck only
  where the crossing is within 17° of a drawn direction. One crossing, one bridge.
- **Water edges**: built quays in towns and along canals, rocky banks on rivers, foam at piers and
  here and there along rivers, ripples on running water, lily pads at quiet edges, boats moored at
  canal quays (one per 45 m cell at most).
- **Houses on parcels**: each house outside the square stands on a plot along its street, its garden
  or yard beside it, fenced (wood, hedge or stone wall by region) with a gate gap by the house,
  something growing or stored in it, and a path to the street. In city cores the plots are gardens
  only. Until iteration 6 the yard test hit the house's own footprint and almost no plot was drawn.
- **Village squares**: larger, cobbled, with radial paving round the fountain, a herringbone kerb,
  stalls along one edge, banners and lanterns at the corners, the tavern where real pubs are, and
  houses standing back so their roofs do not cover the paving. Dense hearts use smaller sprites
  (0.62 in Amsterdam, 0.68 elsewhere for the biggest hearts, 0.76 for the next tier) and terraced
  or stepped-gable rows along streets that run in a drawn direction.
- **Churches** by region and place: onion domes in the Alps, a tall spire or the cathedral in towns,
  the parish church in villages, the monastery for abbeys. Neighbouring churches (within 1.2 km) get
  different drawings, decided over the whole composition window so every chunk agrees.
- **Roof and chimney variants** for the set-one houses (red tile, grey slate, moss, thatch; smoke on
  about a third), weighted by region.
- **Ground**: the set-three meadows blended at large scale (swales as the base, sunlit, deep green
  and dry patches over it), broad light and shade, decals (flowers, tufts, clover, pebbles, leaf
  litter) in drifts, flowers at the foot of houses, forest floor only under drawn trees, strip
  farming on big real farmland, a soil margin round fields. Contrast and tint are baked into the
  tiles at build time (`tools/sprites5.py`).
- **Labels**: real names only; a church is named only when it is drawn, and a label stays within
  110 m (village) or 60 m (landmark) of what it names, or is not shown.

### Where it stands (round 6)

- **Scores** (eight critic passes, average of the six phone screens; the Innsbruck slope in
  brackets): 2.8 (4), 3.3 (5), 3.5 (5), 3.5 (5), 3.3 (5), 4.2 (5), 3.4 (4), 4.0 (5).
- **What holds it back**: the meadow still reads as olive-mustard texture to the critics, the
  village cores do not hold together as one dense place, rivers are clean flat bands without
  current, roads are uniform strips with round end caps, and sprites still repeat (one church
  drawing per kind, few house types). Squares and churches cut by the screen edge are real
  positions and stay.

### Speed (round 6)

| Manhattan, visible / complete ms | Round 5 | Round 6 |
| --- | --- | --- |
| Phone, first view | 2473 / 2665 | 2525 / 4133 |
| Phone, pan one screen | 1160 / 1899 | 1256 / 2908 |
| Phone, zoom +0.5 | 1397 / 2767 | 897 / 3068 |
| Desktop, first view | 2303 / 3659 | 2688 / 5695 |
| Desktop, pan one screen | 948 / 1757 | 1220 / 2889 |
| Reload (stored chunks) | none | 838 / 1012 |

Before the set-three art, the round-6 speed work had the phone first view at 1.4–1.7 s and a
one-screen pan at 0.94 s: geometry decoded straight to mercator, a WebP atlas, a half-density first
pass, chunks and plans stored in IndexedDB, travel-direction prefetch. The new art (three times
the objects, decals, a bigger atlas) took that back. Since then: texture finish baked at build time,
a smaller atlas, shadows from one pre-made falloff instead of a canvas blur, lazy feature
conversion, two workers kept free for what comes into view, and a quick pass that does not wait for
the atlas or the elevation tiles. A first view still spends about 0.6 s per worker loading assets
and 0.3 s decoding tiles before it paints.

**Purity**: a chunk is a function of its coordinates. A fresh load and arriving by a pan gave
identical pixels (separate browser contexts, so nothing came from storage). Placement runs on world
grids and world-anchored line points. Occupancy between objects still depends on the order inside
the chunk's window, but every sprite belongs to exactly one chunk's plan, so borders never double or
cut one.

## Round 7: painted set pieces, placed by code

Composing a village out of single houses in code was the wrong tool. The art agent now paints whole
places (set four: `concept/setpieces`, `concept/scenery`, anchors and entrances in
`concept/setpieces/placements.json`); the code only decides where each one goes.

### What the painter does now

- **Hearts**: one per 480 m world cell at its strongest real place (a real church or square pulls it
  in). It is drawn as ONE set piece chosen by setting and tier: a canal piece (water west or south,
  mirrored for east) where it borders real water in a canal city or within 60 m elsewhere; the
  fishing hamlet by a lake; the alpine pieces in the Alps; a walled or open town, a village or a
  hamlet by density; the monastery where the heart is a real abbey. The same piece is not repeated
  within 1.5 km. Sizes are symbolic, as in the targets: 200 to 270 m across (half to two thirds of a
  phone screen at z16). The anchor (well, green or market) stands on the heart; a piece that would
  touch water slides away from it. Real roads fade out under the piece and a short lane joins each
  painted entrance to the nearest drawn road. The real name is the label, just below the piece.
- **Between hearts**: no single houses. Farmstead compounds (five painted variants; a watermill on a
  real stream, a sawmill at a wood's edge, a vineyard estate on real vineyards) where real buildings
  cluster away from the hearts, about 88 m across, some with a field quilt or paddock beside them.
  Round each heart three to five paddocks, quilts, orchards or tree clumps; in the open ground a
  sparse world grid of the same; painted forest masses on real woods (single trees fill the gaps);
  field quilts on real farmland; orchard and vineyard blocks on real orchards and vineyards;
  forested slope bands, scree fans, cliff bands and snow ridges on real slopes. Only abbeys stand
  alone as churches; the castle (UI Assets) only at a real palace.
- **Ground**: one meadow base and a second in very broad drifts, broad light and shade, a warm golden
  grade (green/red about 0.9 as in the targets), fine flower flecks, the pieces' own grass tone washed
  in round each piece so it fades in.
- **Water**: the painted river (turned along the real flow) and canal surfaces, with the painted
  shoreline strips: stone quays in towns, rocky banks on Alpine rivers, reeds on still water, grassy
  banks elsewhere.
- **Roads**: main roads everywhere; lanes only in town, round a heart or leading to a compound; dead
  ends shorter than 200 m are dropped. Road, canal and river names are placed by the painter along
  their line, fully on screen and off the pieces (the base style's names are hidden at walking zoom).

### Where it stands (round 7)

- **Scores** (fresh critics, against the targets and paint-overs; average of the six phone screens, the
  Innsbruck slope in brackets): 3.7 (3), 3.0 (5), 3.7 (6). The trend is flat: the set pieces and the
  forests score as "same game" (Sankt Nikolaus, the Berlin walled town, the slope), while the open
  ground between them is still judged empty and the water flat.
- **Hearts at the test cameras**: the cell rule puts the heart at the real strongest place, which for
  four of the six cameras lies at the screen edge or just outside (Amsterdam's canal-ring camera has
  none; its hearts are in the old centre round the Nieuwmarkt and the Royal Palace).

### Speed (round 7, Manhattan; visible / complete ms; machine load average about 20 on 32 threads)

| | Round 6 final | Round 7 final |
| --- | --- | --- |
| Phone, first view | 2525 / 4133 | 1381 / 2667 |
| Phone, pan one screen | 1256 / 2908 | 692 / 2522 |
| Phone, zoom +0.5 | 897 / 3068 | 438 / 1905 |
| Desktop, first view | 2688 / 5695 | 937 / 2894 |
| Desktop, pan one screen | 1220 / 2889 | 869 / 2045 |
| Desktop, zoom +0.5 | 1117 / 3235 | 420 / 1700 |
| Reload (stored chunks) | 838 / 1012 | 621 / 711 |

What did it: the sprite atlases and textures are fetched once by the main thread and handed to each
worker as bytes (each decodes its own copy on the CPU; bitmaps decoded on the main thread live on the
GPU and every worker had to read them back), sprites are drawn as rectangles of the shared sheet
(no per-sprite bitmaps), worker canvases stay on the CPU, soft masks are drawn small and scaled up
instead of canvas blurs, buildings count only as mass from their bounding boxes (no polygon decoding
for the composition window), the quick first pass needs neither the atlas nor the elevation, one
worker is always kept free for the quick pass, and there are far fewer objects. MapLibre itself is
ready at about 0.85 s here, so the first painted view (1.2 to 1.4 s on the phone) follows it by
0.35 to 0.5 s.

**Purity**: a fresh load and arriving by a pan still give identical pixels (separate browser
contexts).

## Round 8: the land filled, a concrete list

### What changed

- **Land**: the real streets are lined with straight-sided block fillers (set five, `concept/fillers`,
  40/80/160 m in four directions, placed by their ground quads in `placement-templates.json`), side
  by side and up to two rows deep, aligned with the street and turned by the rest of its angle. The
  kind comes from what is there: gardens, allotments, orchards and pastures near a heart; wheat, hay,
  flax and plough further out; orchard and vineyard rows on real orchards; the walled churchyard on
  cemeteries; painted tree clumps (3 to 12 crowns) in parks and between parcels; about one stretch in
  seven is left as open meadow on purpose. A strip never repeats more than twice within 300 m.
- **Roads**: in town cores only every third parallel lane survives (a world-anchored band across its
  direction); main roads, heart entrances and compound links stay. Every lane or short main-road
  piece with a free end is dropped (three passes), so a road ends at a junction, a set piece or the
  edge of the world.
- **Settlement**: where it is dense, compounds become painted hamlets (about 190 m apart), elsewhere
  farmsteads (about 300 m). Hearts: one per 480 m cell, at least 400 m apart, scored up on main roads,
  at crossings and by water; never on water (the water index now reaches 300 m round each chunk).
- **Water**: wide stone mooring quays on canals and in towns, painted rocky banks and gravel bars
  along real rivers (chosen by the water polygon's own class), lily pads, bridges at every crossing.
- **Ground**: the sunlit meadows (set five) blended at large scale, with flower drifts, light cloud
  shadow and damp-grass overlays; no tone wash under fillers (it made chunk seams).
- **Landmarks**: abbeys as the painted monastery compound; the castle and lone churches on the
  walled churchyard base.
- **Mountains**: crags and outcrops on steep real slopes, boulder fields on moderate ones, painted
  forest bands and pine groups higher up.
- **Open country**: hearts every 900 m at 62 % size, parcels as fields and pastures only.
- **Labels**: thinner halo (no pill), set pieces block their whole footprint, bridges block labels.

### Acceptance checks (`tools/checks.mjs`, phone 390×844 at z16)

Each place at its fixed camera and at a camera centred on its nearest drawn heart. "Bare" is the
owner's measure (share of the screen more than 60 m from any painted object or filler); "open meadow"
is a stricter companion (meadow-coloured pixels under no object, piece or filler footprint).

| Camera | Bare > 60 m | Open meadow | Pieces fully / partly visible | Stubs | Sprites > 3× |
| --- | ---: | ---: | --- | ---: | ---: |
| r8-manhattan-phone-z16 | 1 % | 55 % | 43 / 11 | 0 | 0 |
| r8-manhattan-heart-phone-z16 | 0 % | 54 % | 26 / 15 | 0 | 0 |
| r8-berlin-phone-z16 | 0 % | 46 % | 27 / 5 | 0 | 0 |
| r8-berlin-heart-phone-z16 | 0 % | 46 % | 19 / 12 | 0 | 0 |
| r8-amsterdam-phone-z16 | 0 % | 47 % | 24 / 5 | 0 | 2 |
| r8-amsterdam-heart-phone-z16 | 0 % | 43 % | 16 / 2 | 0 | 0 |
| r8-innsbruck-phone-z16 | 0 % | 33 % | 29 / 7 | 0 | 0 |
| r8-innsbruck-heart-phone-z16 | 0 % | 42 % | 17 / 5 | 0 | 0 |
| r8-village-phone-z16 | 0 % | 54 % | 22 / 9 | 0 | 0 |
| r8-village-heart-phone-z16 | 0 % | 48 % | 23 / 3 | 0 | 0 |
| r8-suburb-phone-z16 | 0 % | 65 % | 37 / 14 | 2 | 0 |
| r8-suburb-heart-phone-z16 | 0 % | 64 % | 52 / 6 | 2 | 0 |

### Speed (Manhattan; visible / complete ms; machine load average 16 to 24 on 32 threads)

| | Round 7 final | Round 8 final |
| --- | --- | --- |
| Phone, first view | 1381 / 2667 | 1341–1386 / 2697–2835 |
| Phone, pan one screen | 692 / 2522 | 542–619 / 2226–2250 |
| Phone, zoom +0.5 | 438 / 1905 | 228–375 / 1785–2066 |
| Desktop, first view | 937 / 2894 | 780–787 / 2747–2911 |
| Desktop, pan one screen | 869 / 2045 | 81–84 / 1000–1141 |
| Desktop, pan 1/3 screen | — | 132–139 |
| Desktop, zoom +0.5 | 420 / 1700 | 383–408 / 1722–2158 |
| Reload (stored chunks) | 621 / 711 | 423 / 586 |

What did it this round: the frame is shown as soon as the visible chunks are there (it used to wait
for the margin whenever they all came from the cache), a quick pass is also started for visible chunks
still queued as prefetch, the last free worker is kept for quick passes only, the quick pass composes
nothing (ground, water and main roads), and the prefetch ring reaches two chunks round the margin.

**Purity**: a fresh load and arriving by a pan still give identical pixels (separate browser contexts).

## Round 9: defects

- **Canals**: the quay is a continuous painted stone band with a light cap along the real bank (no
  modules, so no gaps, offsets or steps); the canal water is the lily-pad surface; a bridge is drawn
  only where drawn roads meet both its ends, parallel twins count once. In a canal city a heart near
  water takes a canal-side set piece with its painted quay line put on the real bank (a bug had made
  every canal choice fall back to an inland town).
- **Rivers**: a continuous stony bank band following the real bank, a gravel bar now and then; boats
  only on canals. Hearts score higher by water and bridges.
- **Roads**: every chunk decides its lanes from a window 250 m wider (lanes no longer stop at chunk
  borders); lanes survive only to a piece's entrance or by the every-third band rule in towns and
  suburbs; entrance lanes join the nearest drawn road; a main road ending in meadow is followed by
  the real lane it continues into; no cobbles round painted hearts.
- **Ground**: a fixed valley base (the per-chunk lowest point made seams), no forest-floor haze, no
  cloud-shadow smears, no stray ditches or short stream fragments; cemeteries as yew graveyards.
- **Labels**: one per heart, at the first spot beside its piece that is clear of roads, pieces,
  fillers and water.
- **Repeats**: enforced in the placer by a world rule (each kind of tree, clump or filler may stand
  in about a third of the 160 m cells, once per cell); set pieces keep their own uniqueness.
- **Edges**: tree avenues in town and hedgerows with standard trees in the country along the
  surviving roads; parcels start a verge's width back, three rows deep along hidden lanes.
- **Open country**: hamlets and farmsteads only, fields and pastures.
- **Checker**: road ends are measured as a viewer sees them (each chunk's own drawn roads, an end is a
  stub unless it meets a drawn road, a piece or the screen edge); the heart camera re-centres until a
  drawn heart is in the middle.

Before and after crops: `~/.local/share/ghostex/i/fantasy-map-r9-crop-*.png`.

## Round 10: purity, and the handover

Every decision is now a pure function of the world. A tile painted today on one machine and its neighbour
painted next month on another meet without a seam, because nothing a tile paints depends on the view or
on which window computed it.

### How purity is built

- **One constant for the world.** `KF = 1.4` mercator units per map metre (`fmcore.js`) replaces the
  latitude factor that each view used to compute for itself.
- **The data never answers from a partial window.** Asking `tiledata.js` for a data tile that is not
  loaded throws `NeedTiles`. `withData()` loads those tiles and runs the whole computation again.
  So no decision, and no cached result, ever comes from half a window.
- **The world plan (`fmworld.js`).** Every decision that more than one tile can see is made once, per
  fixed world cell, from a fixed window of real data, and memoised:
  - Point queries (water, wood, park, farmland, buildings, streets) read indexes built per z14 data tile.
    A building counts once, in the data tile that holds the centre of its box.
  - **Village hearts.** Each 480 m cell has one candidate: the densest real spot, or an important church
    or square. It wins unless a stronger candidate (by building mass, then position) within 400–460 m
    is itself a heart. That is the old greedy pass, computed locally.
    - The name is the nearest real place that no stronger heart within 1.3 km has taken.
    - The set piece is never the same drawing as a stronger heart's within 1.5 km.
    - Size, flip, quay shift, the slide off the water, the entrances and the label spot all come from
      the heart's own cell.
  - **Farmstead compounds.** These are decided on the 160 m block grid in the same way, against the
    hearts and the stronger compounds nearby. Their field quilt or paddock is decided the same way too.
    Lone abbeys stand at their real church.
  - **Roads.** Survival is decided per real road piece, by these rules:
    - Main roads always survive. Country tertiary roads survive. Town lanes survive on the every-third
      band, and any lane that leads to an entrance survives.
    - A lane that meets no drawn road or set piece is dropped. This runs three rounds, by recursion,
      so the result does not depend on a window edge.
    - The same road delivered twice by two data tiles no longer counts as meeting itself. That was
      what kept real stubs alive.
    - A drawn through road that ends in the meadow or at a bank is led on along the shortest chain of
      real lanes (at most 400 m) to the next drawn road. That puts both sides of a bridge into the
      network. A road ending within 90 m of a set piece is led to its nearest entrance.
  - **Bridges.** A bridge is decided per real bridge (water under it, land and a drawn road at both
    ends). Of two within 40 m, the lower-keyed one is drawn.
  - **Water style, per pixel.** Town water (cobbled bank and stone cap) is canal-city water, a city core,
    or water near a heart. The canal texture is used within 300 m of a real canal in the Low Countries.
    Scree banks are used by real rivers and above 400 m; sand elsewhere. Rivers no longer turn to a
    chunk's average flow.
  - **Labels.** Each heart's name sits at its fixed spot. Names along canals, rivers and main roads get
    one label per name per 480 m cell, at the grid point nearest the cell's middle, never over a set
    piece.
  - **Repeat rule.** The repeat-rule cells are a third of a tile, so a cell is never shared by two plans.
- **Plans per tile.** The objects anchored in a z16 tile are that tile's plan. It is computed from the
  tile plus a fixed 60 m window. Fillers, clumps and scenery use the plan's own occupancy, so a filler at
  a tile border is decided by the tile that holds its anchor, the same whoever asks. The ground of a
  region reads the finished plans of the tiles round it, never its own placement run.
- **Ground on the world lattice.** Low-resolution masks, soft masks, relief and the gap closing under
  bridges sit on grids anchored to world pixels.
  - Textures repeat a whole number of pixels from world pixel 0. A turned texture is anchored at the
    thing it fills.
  - Geometry and sprite offsets are snapped to 1/64 px of the world lattice.
  - Steep, snow and cool-meadow masks are computed for every pixel, with no per-chunk "is this chunk
    steep" gate.
  - The meadow washes now use the lattice too: they were the last window-dependent layer.
  - Rock and scree need a slope measured over 80 m that also holds over 320 m, so a valley-floor
    embankment or a step in the terrain data no longer reads as a mountainside. That was the grey haze on
    the Innsbruck heart camera; the Nordkette slopes keep theirs.
- **Same frame, same pixels.** A world pixel is always painted in its own tile's frame: tile + 160 px
  margin at 1024 px per tile. The viewer's chunks use that exact frame, so a viewer chunk *is* the
  server's tile.
- **Per-screen caps are gone.** There is no "two big, two small, three line labels per view" and no
  spiral search for a free spot. The plans give every label at a fixed world spot, and the map's own
  symbol placement hides collisions, as it will on the phone. The repeat limit is the world-cell rule
  above.
- **Removed.** The open-country switch (`comp`, `OPEN`) is gone. So are the quick low-resolution first
  pass and the lossy stored chunks, because a stored WebP is not the same pixels.

### The proof (`tools/purity.mjs`)

For Manhattan, Amsterdam and Valencia, the harness picks the z16 tile holding the set piece of the heart
nearest the location's centre. It paints that tile along these arrival paths, each in a fresh painter
with empty caches, and compares every pixel:

- the tile alone;
- after its east, south and south-east neighbours;
- after its west, north and north-west neighbours;
- in the viewer, jumping in from 700 m north-west;
- in the viewer, in another browser, jumping in from 700 m south-east.

The four tiles round the tile's south-east corner (where four chunks meet) are compared between the
tile painter and the viewer.

Then a 4 × 4 block of tile plans, split over two painters, is checked: every heart (position, piece,
size, flip, name, label spot), compound, road piece's survival, bridge and line-label cell must be
identical in every tile that sees it.

| | Manhattan (Midtown East) | Amsterdam (Jordaan) | Valencia (Valencia) |
|---|---|---|---|
| Tile | 16/19301/24628 | 16/33657/21536 | 16/11185/26088 |
| After E, S, SE / after W, N, NW | identical / identical | identical / identical | identical / identical |
| Viewer from the NW / from the SE | identical / identical | identical / identical | identical / identical |
| Four tiles round the corner, tile painter vs viewer (4.2 M px) | identical | identical | identical |
| Hearts seen by several tiles, disagreements | 17, 0 | 18, 0 | 18, 0 |
| Road pieces, disagreements | 213, 0 | 257, 0 | 96, 0 |
| Compounds / bridges / line-label cells, disagreements | 34 / 1 / 21, 0 | 2 / 6 / 21, 0 | 0 / 0 / 21, 0 |

As a stress test, the tile is also painted inside three other windows (2048 px round it, 1536 px with it
top-left, an odd offset). Those windows put the same world pixels in another canvas frame. All decisions
are identical there too. The pixels differ only by the float rounding of Skia's rasteriser, which
depends on the frame: 0 to 3.1 % of the pixels, by at most 7 levels (21 along Amsterdam's water edges). That is why the paint unit is fixed (the tile and its margin) and
never a free window.

Sheets: `~/.local/share/ghostex/i/fantasy-map-r10-purity-{manhattan,amsterdam,suburb}.png`.
- Top row: the heart, along each arrival path, with the difference.
- Middle row: the corner where four tiles meet, tile painter against viewer.
- Bottom row: the stress windows.

### Defects fixed

- **Stubs.** 0 on all twelve phone cameras (fixed and heart-centred, six places). The fixes are the
  "a road copy joins itself" bug and the continuation chains.
- **Midtown.** The main road no longer ends short of the Midtown heart.
- **Innsbruck.** The road ends on both cameras are gone.
- **Amsterdam.** The tertiary road now crosses Prinsengracht on its bridge (it had been drawn on one bank
  only).
- **Grey haze.** The haze on the Innsbruck heart camera is gone.
- **Valencia.** Its heart camera is centred on the Valencia heart.
- **Ghost roads.** Roads go under a set piece's body and stay whole up to its walls; a wide soft fade had
  left ghosts of roads beside pieces.

Acceptance checks (`tools/checks.mjs`, phone 390 × 844 at z16):

| Place | Camera | Bare > 60 m | Open meadow | Pieces full / part | Stubs | Labels |
|---|---|---|---|---|---|---|
| Manhattan | fixed / heart | 0 / 0 % | 49 / 44 % | 17/7, 20/5 | 0 / 0 | 12 / 7 |
| Berlin | fixed / heart | 0 / 0 % | 50 / 49 % | 33/8, 26/9 | 0 / 0 | 4 / 2 |
| Amsterdam | fixed / heart | 0 / 0 % | 44 / 36 % | 22/10, 13/7 | 0 / 0 | 8 / 7 |
| Innsbruck | fixed / heart | 0 / 0 % | 42 / 40 % | 15/4, 16/5 | 0 / 0 | 9 / 7 |
| Andechs | fixed / heart | 1 / 1 % | 54 / 57 % | 17/3, 9/9 | 0 / 0 | 0 / 1 |
| Valencia | fixed / heart | 1 / 1 % | 60 / 46 % | 22/5, 18/9 | 0 / 0 | 3 / 1 |

Screenshots: `~/.local/share/ghostex/i/fantasy-map-r10-<place>-heart-phone-z16.png`.

### Handover: the painter, exactly

**Files.** These files, and nothing else from this folder:

| File | What it is |
|---|---|
| `fmcore.js` | World constants (`KF`, `NET`), projection, hash and noise, elevation (`demAt`, throws `NeedDem`), geometry helpers |
| `tiledata.js` | z14 vector tile loader and decoder; throws `NeedTiles`; `withData()` (loads missing vector and elevation tiles and runs again) |
| `vendor/vt.mjs` | Vector tile / protobuf reader (used by `tiledata.js`) |
| `fmworld.js` | The world plan: point queries, terrain (valley floor, mountain ground), hearts and their names, compounds, abbeys, road survival, bridges, town and canal water, labels, and every ground piece (fillers, quilts, paddocks, orchards, the clumps round hearts) |
| `painter5.js` | Ground painter, tile planner (`paintRegion`), sprite bake (`bake`), asset intake (`provide`) |
| `tilepainter.js` | The entry point: `loadAssets`, `paintTile`, `planTile`, `paintWindow` |
| `sprites5/bundle.json`, `sprites5/index.json`, `sprites5/atlas.webp`, `sprites5/atlas2.webp`, `sprites5/atlas3.webp`, `sprites5/tex-*.webp` (the 31 names in `bundle.json`) | The art; `bundle.json` lists the sheets. The `sprites5/*.png` files are build leftovers and `sprites5/drawn-max.json` is an input of the atlas build; neither is needed at run time. |

**Inputs.**

- **Vector tiles.** OpenMapTiles schema, zoom 14 only, from the TileJSON at `NET.ofm + 'planet'`
  (OpenFreeMap). Layers used:
  - `landcover`, `park`, `landuse`: wood, farmland, orchard/vineyard, park/garden grass, wetland, sand,
    rock, cemetery;
  - `water`, `waterway`;
  - `building` (bounding boxes only);
  - `poi`: churches, squares and markets, town halls, stations, castles/palaces;
  - `place`: names;
  - `transportation`: roads, bridges, paths and tracks;
  - `transportation_name`;
  - `mountain_peak`.
- **Terrain.** Terrarium PNG at zoom 14 from `NET.dem` (AWS `elevation-tiles-prod/terrarium/`).
- **Data reach.** The painter loads whatever the world plan's windows reach: the z14 data tile under the
  z16 tile and its neighbours, often a ring further (a village's entrances are joined to the road network
  up to 2 km away, the valley floor looks 1.5 km round, a heart's name avoids the names of stronger hearts
  within 1.5 km). `withData` fetches vector and elevation tiles on demand.
- **Memory.** The decoded atlas sheets take about 190 MB per painter instance (round 11 packs every sprite
  at its drawn size); paint with a few instances, not one per core.
- **Data URLs.** Set `NET.ofm` and `NET.dem` before painting if the data comes from elsewhere (the
  prototype uses `serve.py`'s proxy).

**The world grid**, every constant that fixes where something can be (`fmcore.js`, `fmworld.js`,
`painter5.js`). Distances are map metres × `KF`, in web-mercator units.

| What | Value |
|---|---|
| Map metre | `KF` = 1.4 mercator units |
| Paint and plan unit | the z16 tile, `TILE` = 40075016.686 / 2¹⁶ ≈ 611.5 m mercator; 1024 px; ground margin 160 px; plan window: tile + 60 m |
| Building-mass grid | `DG` = 20 m; mass blurred by a 13-cell box twice |
| Heart cells | `HCELL` = 24 × `DG` = 480 m |
| Compound blocks | `BLOCK` = 8 × `DG` = 160 m (3 × 3 per heart cell) |
| Repeat-rule cells | `RC` = `TILE` / 3 |
| Label cells | `LCELL` = `HCELL` |
| City core cache, town water, canal water | 40 m grid |
| Street and drawn-road samples | every 4 m in 12 m buckets; main-road samples every 15 m in 40 m buckets |
| Parcels and scenery (jittered world grids) | 72 m (fillers), 44 m (tree groups), 82 m (forest masses), 92 m (field quilts), 70 m (orchards), 34 m (mountains, cemeteries), 32 m (woods), 22 m (parks), 130 m (meadow overlays), 8.5 m (ground decals), 6 m (lilies) |
| Points along real lines (`alongW`, keyed by the map metre) | 94 m (street parcels), 88 m (avenues and hedgerows), 32 m (street trees), 34 / 24 m (quays), 90 m (line labels) |
| Ground masks | 24 / 32 / 16 px world-pixel lattices; soft masks at their feather in px; textures repeat a whole number of px from world pixel 0 |
| Valley floor | lowest ground (≥ sea level) within 1.5 km, sampled every 250 m round the nodes of a 400 m grid, blended between nodes |
| Mountain ground (no fields; pines, crags) | slope over 80 m > 0.22, or more than 120 m over the valley floor; 20 m grid |
| Ground cells (fillers, quilts, paddocks, orchards) | 320 m (2 × 2 blocks) in a four-colour checkerboard; candidates on the drawn roads (94 m), on farmland (92 m), orchards (70 m), the open-land grid (72 m) and round each heart |
| Road piece index | 100 m buckets per data tile |

**The entry point.** It needs OffscreenCanvas, createImageBitmap, DOMMatrix and fetch: a browser page, a
Web Worker or headless Chromium. Use CPU canvases (`willReadFrequently`), as `tools/tileworker.js` does.

```js
import { loadAssets, paintTile } from './tilepainter.js';
import { NET } from './fmcore.js';
// NET.ofm = '…/'; NET.dem = '…/';                      // optional: your own data URLs
await loadAssets(new URL('./sprites5/', import.meta.url)); // once
const { pixels, labels } = await paintTile(16, x, y);    // x east, y south, as in the tile URL
// pixels: ImageData 1024 × 1024 (RGBA); labels: [{ name, wx, wy (mercator), big, line, rot, pr }]
```

- **z15** is four z16 tiles scaled down.
- **Neighbour plans.** `paintTile` computes the plans of the eight neighbouring tiles itself and keeps
  them in memory. A batch over neighbouring tiles therefore shares them; each plan never changes.
- **Labels.** The labels are the ones whose spot lies inside the tile. The phone draws them as symbols.
  Heart names have `pr` 3, so they sort first.
- **Bit-identical.** A tile painted twice (any order, any cache state, any process) is bit-identical in
  the same browser engine.

### What is pure, and what is not

- **Pure, and proved by the harness:**
  - The decisions: hearts (place, piece, size, name, label spot), compounds and their quilts,
    surviving roads (entrance ways, continuations, gap links), bridges, line labels, and every ground
    piece (fillers, quilts, paddocks, orchards, the clumps round hearts), which also never overlap.
  - Every pixel of a tile, whatever the arrival path.
  - Entrance lanes and fillers at tile borders: they show up as pixels in the tile and corner
    comparisons.
- **Pure by construction, not separately measured:** abbeys, castles, town and canal water,
  scree/sand/snow/rock masks, the repeat rule.
- **Not pure in the strict sense:**
  - The same world pixel painted inside a different canvas frame (an arbitrary window) differs by float
    rounding (up to 3.1 % of pixels, at most 7 levels, 21 along Amsterdam's water edges). The paint unit is therefore fixed, and the server must
    not paint free windows.
  - The pixels depend on the browser engine's rasteriser. A different Chromium/Skia version or CPU
    feature path may round differently, so pin the engine when tiles painted at different times must
    sit side by side.
  - Trees, clumps, forest masses and mountain scenery are still decided by the plan of the tile that holds
    their anchor (pure: the same whoever asks); two such trees from neighbouring tiles can touch at the
    shared edge. The ground pieces (fillers, quilts, paddocks, orchards) no longer can: they are the world
    plan's (round 11).

## Round 11: the approved look back, still pure

The round 10 painter had lost parts of the round 8 look the owner approved. Each fix below is a world rule (in
`fmworld.js` unless noted), so the round 10 purity holds; the proof is re-run at the end. The handover section in
round 10 above is kept current.

### What was restored

- **Roads** (round 9 had cut them to entrance lanes only):
  - The backbone always survives: motorway to secondary roads, and every tertiary road.
  - Every painted entrance of every heart, hamlet, compound and lone abbey is joined to the backbone by the
    shortest way along real streets, up to 2 km (Dijkstra over whole road pieces, ties by key). With no
    backbone in reach, it is joined to the nearest other heart's entrances: the link between two hearts.
    The first lane of such a way is drawn from the point nearest the entrance on, so a long lane running
    past a farmstead does not dangle.
  - As in round 8, the lanes within 1.6 heart radii of a heart and within 110 m of a compound are kept.
  - Thinning applies only to minor streets in a city core (the every-third band).
  - A road may end only at a set piece, a junction or a bridge. An end in the meadow is led on along the
    shortest chain of real lanes (up to 400 m). A gap in the data between two drawn roads (a tunnel
    section) of up to 30 m is closed. Only a lane that still cannot be connected is left out, over eight
    rounds, so nothing hangs on a lane that was left out.
  - Two data-level fixes:
    - A short oneway link at a junction is not a second carriageway, unless it continues one that is.
    - Road pieces are indexed in 100 m buckets (Manhattan has thousands per data tile).
- **Mountains:**
  - The valley floor is a world rule: the lowest ground within 1.5 km, on a 400 m grid. It replaces the
    fixed 600 m, which made the Innsbruck valley (575 m) read as flat.
  - Mountain ground (slope over 80 m above 0.22, or 120 m over the floor) carries no field, garden,
    pasture, orchard or paddock. Tree groups and grid clumps there are pine and larch groups; woods there
    are conifers.
  - Elevation is now a synchronous world query (`fmcore.demAt`), loaded on demand like the vector tiles
    (`NeedDem`).
- **Sharp trees:**
  - `tools/drawn-sizes.mjs` measures the largest width every sprite is drawn at when a tile is painted
    (5 × 5 tiles round each of the six places).
  - `tools/sprites5.py` packs every sprite at least that wide (+10 %). Set pieces are packed at the
    largest heart (270 m) and scenery at its ground width × 1.3, never above the drawing's own size.
  - The four landmark trees went from 40 to 116 px; the hamlet pieces from about 150 to 633 px.
  - No sprite is now drawn above its packed size (0 of 279, against 235 before).
  - Atlas 2 is split into `atlas2.webp` and `atlas3.webp` (4096 px wide, at most 8192 high).
  - A landmark tree may stand in one repeat cell in eight (it was three in ten); painted tree clumps (seven
    drawings) in a little over half, still once per cell.
- **Fillers** (and field quilts, orchard blocks, paddocks, the clumps round each heart):
  - They are the world plan's now (`groundIn`), never a tile's.
  - Candidates, best first:
    1. round each heart;
    2. parcels lining every drawn road, two rows deep, 160 m strips first, turned with the road;
    3. quilts and orchard blocks on real farmland and orchards;
    4. a 72 m grid over open land near the drawn roads, turned with the nearest road.
  - They are decided in 320 m ground cells in a four-colour checkerboard. A cell takes its candidates best
    first, keeping clear of everything it took and everything its lower-coloured neighbours took.
    Same-coloured cells are a whole cell apart, so no two ground pieces overlap, also across tile edges.
    A decision depends on at most four cells.
  - There are no strips along hidden lanes any more. Grid cells with no ground piece get a tree clump.
- **Names:** every heart has one, never a name a stronger heart within 1.5 km carries. The order:
  1. the nearest real neighbourhood or village label within 650 m;
  2. the square or church it stands on;
  3. a suburb or quarter within 2 km;
  4. a square, church or station within 400 m;
  5. a main street within 300 m;
  6. the nearest place within 2 km with the heart's side of it ("North Luisenstadt").

  A name sits below its piece even over a road, as in round 8. Beside the piece it fell off a phone screen.

### Round 8 against round 11, every difference (six heart cameras)

Every difference I found between each round 8 heart shot and its round 11 counterpart:

| # | Difference | Kept or restored |
|---|---|---|
| 1 | Roads round the hearts and between the fields (Berlin, Innsbruck, Andechs had lost them) | Restored (world rules above) |
| 2 | Pine groups and slope scenery north of Sankt Nikolaus | Restored: valley-floor rule, no fields on mountain ground, conifer groups exempt from the once-per-cell rule |
| 3 | Soft, washed-out landmark trees and hamlets | Restored: packed at drawn size |
| 4 | Small strips at mixed angles with no road beside them | Restored: ground pieces line the drawn roads, 160 m first |
| 5 | Hearts without a name (Berlin and Manhattan heart cameras) | Restored: every heart is named |
| 6 | The Berlin camera's heart is called Kreuzberg, not Luisenstadt | Kept. The camera now centres the heart nearest the place's fixed camera, a neighbour of round 8's; Luisenstadt still names its own heart 340 m away. A name is never repeated within 1.5 km. |
| 7 | Amsterdam: a canal-side set piece on its quay instead of an inland walled town; its name is Centrum | Kept. This is round 9's canal rule: the heart stands on its canal with its painted quay line on the real bank. Jordaan is a stronger heart's name within sight. |
| 8 | Amsterdam quays: one continuous stone band with a light cap instead of wall modules | Kept. This is round 9's fix: no gaps, steps or offsets at bends. |
| 9 | Tree avenues and hedgerows along the surviving roads (Manhattan, Berlin) | Kept. Round 9 added them; they make the road edges read as in the targets. |
| 10 | Fewer free-standing tree clumps than round 8 (Manhattan, Berlin, Andechs) | Partly restored. The repeat rule (round 9, now a world rule) limits each drawing per cell. Painted clumps now get a little over half the cells; round 8 had no repeat limit at all. |
| 11 | Hearts sit at slightly different spots (Manhattan's camera centres Midtown East) | Kept. Hearts are the world plan's, decided per 480 m cell (round 10 purity). |
| 12 | Valencia's camera centres on a heart (round 8's had none in view); it is named Citrus Street | Kept. The heart-centred camera now finds its heart. Valencia is a stronger heart's name within 1.5 km, so this one takes the nearest named street. |
| 13 | River water no longer turns with each chunk's average flow; lake banks are sand, river banks scree | Kept. Round 10 purity: a per-chunk direction made seams. |
| 14 | Roads run solid up to a set piece's walls instead of fading beside it | Kept. Round 10: the fade left ghosts of roads. |
| 15 | Line labels at fixed world spots, no per-screen cap | Kept. Round 10 purity. |


### Checks and proof

Acceptance checks (`tools/checks.mjs`, phone 390 × 844 at z16; a road end counts unless it meets another drawn
road, a set piece's box with 12 m round it (its entrances) or the screen edge):

| Place | Camera | Bare > 60 m | Open meadow | Pieces full / part | Stubs | Labels | Repeats > 3 |
|---|---|---|---|---|---|---|---|
| Manhattan | fixed / heart | 0 / 0 % | 48 / 44 % | 20/5, 16/6 | 0 / 0 | 11 / 8 | 0 / 0 |
| Berlin | fixed / heart | 2 / 0 % | 71 / 51 % | 13/4, 30/4 | 0 / 0 | 4 / 3 | 0 / 0 |
| Amsterdam | fixed / heart | 3 / 0 % | 60 / 47 % | 13/5, 15/3 | 0 / 0 | 8 / 7 | 1 / 1 (rowing boats) |
| Innsbruck | fixed / heart | 0 / 0 % | 45 / 46 % | 16/3, 22/1 | 0 / 0 | 10 / 8 | 0 / 0 |
| Andechs | fixed / heart | 0 / 0 % | 56 / 52 % | 19/4, 14/5 | 0 / 0 | 0 / 1 | 1 (pines in a real wood) / 0 |
| Valencia | fixed / heart | 0 / 0 % | 69 / 65 % | 23/3, 19/4 | 0 / 0 | 3 / 1 | 0 / 0 |

The five-path purity test (`tools/purity.mjs`, the same as round 10, on the final code), and the plan agreement over
a 4 × 4 block of tile plans in two painters:

| | Manhattan (Midtown East) | Amsterdam (Centrum) | Valencia (Citrus Street) |
|---|---|---|---|
| Tile | 16/19301/24628 | 16/33657/21536 | 16/11185/26088 |
| After E, S, SE / after W, N, NW | identical / identical | identical / identical | identical / identical |
| Viewer from the NW / from the SE | identical / identical | identical / identical | identical / identical |
| Four tiles round the corner, tile painter vs viewer (4.2 M px) | identical | identical | identical |
| Hearts, disagreements | 17, 0 | 18, 0 | 18, 0 |
| Road pieces, disagreements | 227, 0 | 257, 0 | 103, 0 |
| Compounds / bridges / line-label cells, disagreements | 34 / 1 / 21, 0 | 2 / 30 / 21, 0 | 0 / 0 / 21, 0 |
| Ground pieces seen by several tiles, disagreements | 351, 0 | 272, 0 | 231, 0 |
| Overlapping ground pieces in the block | 0 of 411 | 0 of 314 | 0 of 271 |
| Stress: the tile inside other windows (float rounding of the frame only) | ≤ 2.7 % px, ≤ 7 levels | ≤ 1.4 % px, ≤ 21 levels | ≤ 3.5 % px, ≤ 6 levels |

Side-by-sides: `~/.local/share/ghostex/i/fantasy-map-r11-sbs-{berlin,manhattan,innsbruck,amsterdam}.png`
(round 8 left, round 11 right); the heart cameras: `fantasy-map-r11-<place>-heart-phone-z16.png`; the purity
sheets: `fantasy-map-r11-purity-{manhattan,amsterdam,suburb}.png`.

### What the vendored copy must pick up

Re-sync these files (sha-256, first 16 hex):

| File | Changed in round 11 | Hash |
|---|---|---|
| `fmcore.js` | elevation as a synchronous world query (`demAt`, `NeedDem`, `loadDem`, `demTilesIn`) | `05b62fa9ccb0fbd2` |
| `tiledata.js` | `withData` also loads elevation tiles; a guarded load-log hook (added after the proof run, no effect on painting) | `7123a8725aeae46b` |
| `fmworld.js` | terrain, roads, ground pieces, names, piece index; `roadWhy` for debugging | `93bd099cba05bae4` |
| `painter5.js` | places the world plan's ground pieces; mountain conifers; repeat shares | `e4883ac753c1ff3b` |
| `tilepainter.js` | `loadAssets` waits until the atlas is decoded and known to the world plan | `38a5e03021f05123` |
| `vendor/vt.mjs` | unchanged | `1a97c81fb53218ae` |
| `sprites5/atlas.webp` | rebuilt (same sizes) | `4d6abfe7b20547c7` |
| `sprites5/atlas2.webp` | rebuilt larger (4096 × 7974) | `17f4846624a69429` |
| `sprites5/atlas3.webp` | **new** (4096 × 1832) | `a2b40867d882ba00` |
| `sprites5/index.json` | new sizes and sheet numbers | `0b4e5dd9108873b2` |
| `sprites5/bundle.json` | lists the three sheets | `dcd414733ae88b56` |
| `sprites5/tex-*.webp` | unchanged (byte for byte) | |

- **Assets must change together.** The atlas, `index.json` and `bundle.json` are one set; a mix of round 10
  and round 11 files paints wrong sprites.
- **Load before planning.** `loadAssets` must finish before any plan: the world plan now refuses to answer
  while the atlas is not in. Before, a plan made too early would have been made without set pieces and
  cached.
- **Memory.** Decoded sheets take about 190 MB per painter instance.

