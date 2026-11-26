# Research: what makes strategy and builder game maps beautiful

Purpose: rendering rules for the canvas "fantasy redraw" of OSM at walking zoom (one screen ≈ 400–800 m).
Throwaway research for the prototype. No game art was copied into the repo. Only text findings are kept here.

## Method and legend

I looked at official screenshots from the Steam store pages (fetched through the Steam `appdetails` API) and from the GOG catalog. They were saved to `/tmp/fmap-ref/`, outside the repo.
- **HoMM 2, 3 and 5**: [HoMM3 HD](https://store.steampowered.com/app/297000), [HoMM3 Complete](https://www.gog.com/game/heroes_of_might_and_magic_3_complete_edition), [HoMM2 Gold](https://www.gog.com/game/heroes_of_might_and_magic_2_gold_edition), [HoMM5](https://www.gog.com/game/heroes_of_might_and_magic_5_bundle)
- **Anno**: [Anno 1404 History Edition](https://store.steampowered.com/app/1281630), [Anno 1800](https://store.steampowered.com/app/916440)
- **The Settlers**: [Settlers 2](https://www.gog.com/game/the_settlers_2_gold_edition), [3](https://www.gog.com/game/the_settlers_3_ultimate_collection), [4](https://www.gog.com/game/the_settlers_4_gold_edition), [7](https://store.steampowered.com/app/965320)
- **Others**: [AoE2 DE](https://store.steampowered.com/app/813780), [Northgard](https://store.steampowered.com/app/466560), [Kingdom Rush](https://store.steampowered.com/app/246420), [Tiny Glade](https://store.steampowered.com/app/2198150), [Dorfromantik](https://store.steampowered.com/app/1455840), [Townscaper](https://store.steampowered.com/app/1291340), [Manor Lords](https://store.steampowered.com/app/1363080)

Each claim carries a tag:
- **[S]**: my own reading of a screenshot.
- **[M]**: measured from screenshot pixels with a small PIL script. I classified pixels by hue, saturation and value and took the median colour per class. These numbers are rough: the images are JPEGs, and the classes are crude. The "ochre" class also catches the yellow-olive grass of Anno and AoE2.
- **[D]**: stated by the developers or publisher, with a link.

## 1. Ground: how many types, what dominates, how they blend

**Measured shares per screen [M]** (map area only, UI cropped):

| Screenshot | green (grass + forest) | ochre/brown (dirt, roads, plots) | blue (water) | other |
|---|---|---|---|---|
| HoMM3 HD, grassland map | 51% | 22% | 5% | 15% very dark (forest shadow), 4% grey rock |
| HoMM5 adventure map | 69% | 18% | 3% | 6% grey |
| Anno 1404, river valley | 55% | 32% (pasture, roads, plots) | 1% | 7% grey rock |
| Settlers 2 | 80% | 13% | 1% | 4% |
| Settlers 4 | 69% | 15% | 2% | 11% dark |
| Kingdom Rush, level | 58% | 35% (the path is the gameplay) | 1% | |
| Northgard | 53% | 9% | 16% | 21% pale trampled ground and rock |
| Manor Lords, village | 41% | 12% | | 23% grey (roads, roofs) |

- **One ground type always dominates [S][M].** Green covers 50–80% of the screen. Behind it sit 2–4 secondary types: dirt or sand, water, rock, and fields. I never saw more than 5 distinct ground types on one screen. Even in the HoMM3 grassland view, which is very busy, the ground is just grass, dirt patches, a sand beach, water and rough mountain.
- **Transitions are painted, never polygon edges [S].**
  - HoMM3 is built on tiles, but its grass→dirt and grass→sand edges are hand-drawn ragged transition tiles. The beach around the lake is a 1–2 tile sand band with an irregular, crumbly edge.
  - Settlers 3 and 4 put a dirt "footprint" under each building. These footprints have ragged, noisy edges that fade into the grass over roughly 10–20 px.
  - Kingdom Rush outlines the edge between path and grass with a darker grass rim and a saw-tooth fringe of grass blades. The edge is stylised, not feathered, but it is never a straight line.
  - Northgard puts a pale, irregular "trampled" blob under every building. The edge is soft and has grass tufts poking through.
- **Relief lighting is a second, low-frequency layer [S].** In Settlers 2, the grass changes from bright yellow-green to deep green in broad bands with light and shadow from the heightmap. This hill shading alone keeps 80% grass from reading as a flat fill.

## 2. The lush base: how grass is painted

- **The colour sits in a narrow band [M].** Median grass colours: HoMM3 `#2b4517`, HoMM5 `#405525`, Anno 1404 `#3c4827` (forest and meadow) with pasture `#726833`, Settlers 2 `#4c7717`, Settlers 4 `#41681a`, Kingdom Rush `#6e8c23` (world map `#8ca115`), Northgard `#749450`, Manor Lords `#58602b`.
  - In HSV terms, grass hue sits at **60–90°** (yellow-green, almost never pure 120° green), saturation at 40–75%, and value at 25–55%.
  - The stylised and cozy games (Kingdom Rush, Northgard) are lighter. The "serious" ones (HoMM3, Anno, Manor Lords) are darker and more olive.
- **There is a lot of fine value noise, and it stays within one hue [M].** Within a grass patch, the 10th–90th percentile of value spans 17–64% in HoMM3, 26–59% in Kingdom Rush, 31–60% on Anno pasture and 41–69% in Settlers 2. That is a lot of high-frequency texture, but the hue stays inside roughly ±20°. The texture reads as "grass" rather than as noise because only value and a little saturation vary.
- **Low-frequency variation rides on top [S].**
  - HoMM3 has whole lighter or yellower meadow zones, such as the bright `#465405` glade next to darker grass.
  - Anno 1404 alternates olive-yellow pastures with darker green near forests.
  - Dorfromantik and Manor Lords show large soft patches of slightly different tints.
  - None of these games has a uniform field of one colour bigger than about a quarter of the screen.
- **Small decals add life [S].** HoMM3 scatters small crumbly dirt patches (about 20–40 px), flower clumps in 2–3 colours (orange, lilac, white), mushrooms, rocks and log piles on the grass. Settlers 4 and Tiny Glade sprinkle flowers in pink, white and blue. The decals are sparse and clustered, never evenly spread.

## 3. Objects: scale, grouping and anchoring

- **Scale is symbolic, not true [S].**
  - HoMM3 HD (map viewport about 1180 px wide): small sites like mines, huts and dwellings are 60–100 px (5–8% of the width), and a town is about 250 px (about 20%).
  - Anno 1404 at full zoom-out: houses are 3–4% of the width, and a large hall about 8–9%.
  - Settlers 2: buildings are about 5% of the width.
  - In every case, buildings are several times larger than true scale relative to roads and fields.
- **Objects come in clusters, with empty space between [S].**
  - HoMM3 puts a mine with its ore piles and cart in one group, log piles in pairs, and a hut beside its trees. Groups are separated by 2–4 object-widths of plain grass.
  - In Anno 1404 and Manor Lords, houses cluster along roads with meadow or forest gaps between hamlets.
  - Dorfromantik's villages are tight clumps of 5–15 tiny houses inside forest or fields.
- **Every object is anchored to the ground [S].** This was the most consistent rule I found.
  - **Ground decal / footprint under the building**: Settlers 3/4 (dirt pad), Northgard (pale trampled blob), Anno 1404 (dirt or paved plot slightly larger than the building), HoMM3 (the town stands on a brown rock-and-earth mound, and the mine on a dug-up dirt patch).
  - **Shadow**: every sprite in HoMM3, AoE2 DE and Anno 1404 casts a soft, semi-transparent dark shadow onto the ground.
  - **Contact darkening**: the ground is darker right where the object meets it. Townscaper's ambient occlusion is the extreme case.
- **Objects stand upright on a ground seen from above [S].** HoMM2/3, Settlers 2–4, AoE2, Anno and Kingdom Rush all show the ground nearly top-down, but draw objects at a 3/4 elevation with the front face and roof visible. Each object's base sits on its footprint, and objects lower on the screen overlap the ones above (y-sorting).
- **Outlines depend on the style [S].**
  - Kingdom Rush uses dark outlines about 2–3 px wide (dark green on foliage, near-black on buildings).
  - Dorfromantik draws outlines with generated outline textures [D: [80.lv](https://80.lv/articles/how-dorfromantik-expands-its-cozy-world-through-minimalist-design)].
  - HoMM3, Anno and AoE2 have no outlines. They separate objects from the ground through value contrast and shadow.
  - Red Blob Games' mapgen4 added outlines on purpose because "in standard 3D rendering you don't get this", and the author says they made a large difference to the hand-drawn look [D: [mapgen4 outlines](https://simblob.blogspot.com/2018/10/mapgen4-outlines.html)].

## 4. Light

- **There is one light direction, used everywhere [S].**
  - HoMM3: shadows fall to the left and lower-left of trees, the windmill and the hero, so the light comes from the right or upper-right.
  - Anno 1404 and AoE2 DE: shadows fall to the left or lower-left. In AoE2 the cypress shadows lie on the ground to the left.
  - Kingdom Rush: tree crowns are lit from above. Each crown is light on top and dark underneath, with a dark trunk band along the bottom edge of the forest.
  - So the direction differs between games. Within one game it never changes.
- **Cartographic default [D]**: the standard hillshade light is azimuth 315° (north-west, upper-left) at 45° altitude ([Esri, How Hillshade works](https://doc.esri.com/en/arcgis-pro/latest/tool-reference/3d-analyst/how-hillshade-works.html)). Upper-left light is the convention map readers expect for relief.
- **Dorfromantik uses a single main sun [D]**: "a single main sunlight in the scene, which remains largely unchanged apart from lifting the darkness of shadows", plus "a very subtle fog", and colour is used "to define the overall mood" ([80.lv](https://80.lv/articles/how-dorfromantik-expands-its-cozy-world-through-minimalist-design)). In other words, shadows are lifted and never black.
- **Shading on objects [S]**: the sunlit face is about 15–25% brighter than the shaded face. HoMM3 and Anno roofs show a clear light/dark split along the ridge.
- **Ambient occlusion and contact shadow [S]**: Townscaper has deep occlusion in corners and where houses meet the ground. HoMM3 and Settlers 4 darken the ground at forest edges and under clusters.

## 5. Roads and paths

- **They are trodden earth, lighter and warmer than the grass [M][S].**
  - Colours: Anno 1404 road `#a5874a`, Kingdom Rush path `#d1b756`, HoMM3 dirt `#695030`, Manor Lords pale dirt-grey.
  - Value is 10–30 points above the surrounding grass, and the hue sits at 35–50°.
- **Width [S]**:
  - Anno 1404 village roads are about 0.35–0.5 of a house width. Manor Lords roads are about a third of a house length.
  - Settlers 2 roads are 2–3 px lines, because roads there are a game network.
  - HoMM3 cobbled roads are about half a tile wide (about 12–16 px) with a dark edge.
- **Edges and wear [S]**:
  - Manor Lords roads have soft, feathered edges, worn tracks and grass in the middle. They widen into open worn areas at junctions and in front of buildings.
  - Anno 1404 roads fade into the dirt plots of the houses they serve.
  - In Tiny Glade the player "draw[s] a path", and the game turns meadow into worn path [D: [Steam page](https://store.steampowered.com/app/2198150)].
- **Connection [S]**: roads end at a building's door or plot, never at a wall. Manor Lords builds its village as a road loop with houses facing it, and the plots lie behind the houses.

## 6. Forests

- **Crowns overlap [S].** Kingdom Rush draws a forest as stacked round crowns. Each is outlined, lit on top and darker below. Rows further down the screen overlap the rows behind, and the bottom edge of the mass shows a band of dark trunks with bushes. HoMM3 forests are dense clumps of 3–6 sprite trees that overlap, with no ground showing between them.
- **Species and colour accents [S].**
  - Anno 1404 mixes conifers and broadleaf trees, with roughly 5–10% orange or red autumn accents scattered through.
  - HoMM3 mixes dark conifers, mid-green deciduous trees and occasional yellow or orange crowns.
  - Dorfromantik uses 4–5 crown tints, including pink and grey accents, and 2–3 shapes (cone, ball, column).
  - The accents stay a small fraction of the forest. The mass reads as one dark green.
- **Edges [S].** Edges are ragged, with single outlier trees and bushes 1–3 crown-widths outside the mass (Anno 1404, Manor Lords). A shadow falls on the grass along the forest edge facing away from the light (HoMM3). Forest is the darkest large area on screen: HoMM3 conifer forest mean value is about 17% against grass at about 30% [M].

## 7. Water

- **HoMM3 [S][M]**:
  - The lake is deep navy (`#143654`) with a fine, light wave texture.
  - A sand beach band, about 1–2 tiles wide, runs between the water and the grass.
  - A thin light line marks the waterline, and rocks in the water have white foam rings.
  - Rivers are blue ribbons about 10–14 px wide with a brown bank outline on both sides.
- **Kingdom Rush world map [S][M]**:
  - The water is light teal (`#77b5bd`).
  - A bright foam line follows every shore, with a second, fainter line offset outward.
  - Darker low-frequency patches suggest depth further out.
  - Small rocks sit along the coast, and there is a visible bank or cliff edge.
- **Anno 1404 [S]**: the river is grey-blue, darker in its middle, and has worn, sandy banks.
- **Fantasy cartography [D]**:
  - Coast hatching uses ripple lines 2–3 px thick, distorted and roughened.
  - "Historically it was common to apply the same hatching to inland waterways", but rivers are the exception ([K.M. Alexander tutorial](https://www.goodreads.com/author_blog_posts/18661617-tutorial-creating-18th-century-coastlines-for-fantasy-maps)).
  - Martin O'Leary's generator draws hand-drawn fantasy maps from an eroded heightmap with routed rivers and stroke-based hill shading ([Atlas Obscura](https://www.atlasobscura.com/articles/uncharted-atlas-twitter-bot); code at [github.com/mewo2/terrain](https://github.com/mewo2/terrain)).
- **Shared rule [S]**: the shore is always a band of 2–3 layers (bank or sand, a light waterline or foam, shallow water), and deep water is darker and calmer, with little texture.

## 8. Settlements

- **Manor Lords [D][S]**: the developer describes town growth "inspired by the growth of real medieval towns and villages", spreading "outward from a central marketplace", with homes built "in accordance with the historical burgage plot system", where each area is "subdivided based on your roads" ([Steam page](https://store.steampowered.com/app/1363080)). In the screenshot [S]:
  - Houses face the road with their gable or eaves side.
  - Long narrow plots run behind them with vegetable beds, fences and sheds.
  - The church is the only white, taller building, set slightly apart as the focal landmark.
  - Groups of trees stand inside the village, and open meadow surrounds everything.
- **Anno 1404 [S]**: farmsteads stand alone, each with its fenced pasture grid attached. Production buildings sit at forest clearings. The large hall stands on a paved plot and is the focal point.
- **HoMM3 [S]**: the town is the largest and highest-contrast object on screen (grey stone against green, with red flags). Everything else is a third of its size or smaller.
- **Dorfromantik [S]**: villages are clumps of 5–15 houses around a small square or well, inside forest or fields, with smoke puffs. The space between clusters is plain grass or fields.
- **Rest areas [S]**: in every game, 20–40% of the screen is "boring" ground: meadow, pasture, open field. That plainness is what makes the clusters read as clusters.

## 9. Palette and value structure

- **Value first [D]**: the Dorfromantik team says "we regularly check everything in grayscale to validate the value structure", and describes their method as "Readability through value and then add atmosphere and emotion through hue and saturation." Biome palettes are "carefully handcraft[ed]", and they warn that "more colors within a small asset would create too much noise" ([80.lv](https://80.lv/articles/how-dorfromantik-expands-its-cozy-world-through-minimalist-design)).
- **Readable at overview distance [D]**: Anno artists "check how the colors and texture look when you watch your city zoomed out", and a building must look "great and harmonize at a larger scale" while the player can "identify its purpose in the blink of an eye" ([Anno Union DevBlog](https://www.anno-union.com/devblog-of-3d-architects-and-construction-workers/)).
- **Structure I observed [S][M]**:
  - The ground is mid-to-low value and moderately saturated (grass value 25–55%).
  - Roads and plots are lighter and warmer.
  - Forests are the darkest band.
  - Focal objects (roofs, landmarks, flags) carry the highest saturation and the strongest local contrast. Examples: red-brown roofs (medians `#592f25`–`#6c403a`, value 35–45%), HoMM3 red flags, Townscaper and Dorfromantik orange roofs, the Manor Lords white church.
  - Saturated colour therefore covers under 5% of the screen [M: "red/roof" class 0–4% everywhere except HoMM2's red dirt].
- **Harmony [S]**: grass, dirt, fields and roofs all lie on the warm side (hue 20–90°), and water is the single cool counterweight. Dorfromantik and Townscaper add a cool tint to the shadows and fog, so the whole frame shares one atmosphere.
- **Typical ranges** (taken from the medians above):

| Element | Colour range |
|---|---|
| Grass | `#3c4827`–`#8ca115` (olive to yellow-green) |
| Meadow or pasture accent | `#726833` |
| Forest mass | `#202c0e`–`#414427` |
| Dirt or road | `#695030`–`#a5874a`, sandy paths up to `#d1b756` |
| Deep water | `#143654`–`#2e4562` |
| Shallow water | `#5a878a`–`#77b5bd` |
| Roofs | `#592f25` (brown-red) to `#c0603a` (terracotta), plus thatch ochre |

## 10. Level of detail and readability

- **Repetition with variation [S]**: HoMM3 and Anno reuse a few tree sprites thousands of times, but vary tint, size (±15%), clumping and accent species, so nothing tiles visibly. Dorfromantik builds everything from "very basic shapes, but carefully composed", and "the silhouette needs to be clear" [D: [80.lv](https://80.lv/articles/how-dorfromantik-expands-its-cozy-world-through-minimalist-design)].
- **Hierarchy [S]**: every screen has one or two focal objects (a town, a church, a hall), about 5–15 secondary objects (houses, mines, mills), and many small details (rocks, flowers, logs). Detail is concentrated around the focal points and thins out over the rest areas.
- **Noise budget [D]**: in Dorfromantik, an asset can be rejected with "This is creating too much visual noise", and the medieval pack allows "slightly more detail in some areas, but without breaking the overall visual language" ([80.lv](https://80.lv/articles/how-dorfromantik-expands-its-cozy-world-through-minimalist-design)).
- **Small size [S]**: at the smallest scale (Dorfromantik and Settlers houses about 10–20 px), a house is just a roof shape in one saturated colour, a lighter or darker wall face, and a shadow. Windows and other detail disappear, and nothing is lost.

## 11. Tilt and perspective

- **Projection [S]**: HoMM2/3, Settlers 2–4, AoE2, Anno 1404 and Kingdom Rush all use a ground that is close to top-down, with objects in 3/4 elevation. Their bases sit on their map position, and they extend upward on screen. Shadows are drawn on the ground plane. Anno, Northgard and Manor Lords use a true perspective camera, but at strategy zoom the effect is similar.
- **Plan-oblique [D]**: Red Blob Games renders mapgen4 with an oblique projection built from a blend of rotation and shear, so the map can move smoothly between top-down and oblique views ([mapgen4 oblique](https://simblob.blogspot.com/2018/09/mapgen4-oblique-projection.html)). This suits us: keep the OSM geometry top-down, and draw only buildings and trees as upright sprites anchored at the bottom-centre of their footprint.
- **Non-photorealistic relief [D]**: mapgen4 multiplies the biome colour by an outline-plus-lighting factor between 0 and 1, so outlines and shading darken the base colour rather than replacing it. Its lighting is deliberately non-photorealistic, to "look more like maps and less like a 3D rendering" ([mapgen4 outlines](https://simblob.blogspot.com/2018/10/mapgen4-outlines.html)).

## Recipe for our prototype (HTML canvas, one screen ≈ 400–800 m)

1. **Grass budget.** Grass, meadow and pasture cover **≥ 60%** of every screen (≥ 70% outside dense city centres). Use at most **3 other ground types** per screen, chosen from dirt/plots, water, field and rock. Forest counts as an object layer on top of grass. If the OSM data would give more types, merge the minor ones into grass.

2. **Grass is never one fill.**
   - Base hue 70–90°, saturation 40–65%, value 30–50%. Start around `#4a5a2a` (olive) to `#5f7a2c`.
   - Add 2–3 octaves of value noise anchored to world coordinates (not the screen):
     - a low-frequency layer with a wavelength of 150–300 m, ±8% value and ±10° hue toward yellow-olive;
     - a mid-frequency layer at 20–40 m, ±5% value;
     - a fine grain at 2–4 px, ±6% value, at the same hue.
   - Optionally multiply by a hillshade from the terrain tiles (azimuth 315°, ±10% value).

3. **Feathered transitions.** Every boundary between ground types is drawn through a noise-displaced mask (displacement 4–10 px) and a feather of **6–16 px**. Dirt-on-grass edges get small grass "bites". No ground polygon should ever show a straight, hard, anti-aliased edge.

4. **One light, upper-left.** The light comes from azimuth 315°. Every upright object casts a soft shadow:
   - offset toward the lower-right by about 0.3–0.5× the object's height;
   - colour a cool dark tone (`rgba(20,30,40,0.25–0.35)`), never black;
   - blurred 2–4 px.
   Add a tighter contact shadow at the base (ellipse, alpha 0.35–0.45). Sunlit faces of roofs and walls are 15–25% lighter than shaded faces.

5. **Anchor every building with a footprint decal.** Under each cottage or landmark, paint a worn dirt or trampled patch:
   - 1.3–1.8× the sprite's width, colour `#8a7446`–`#a5874a` at 50–80% alpha;
   - an irregular, noise-wobbled edge, feathered over 4–8 px;
   - draw it before the shadow, and the shadow before the sprite.
   Landmarks get a paved or cobbled plot instead.

6. **Symbolic scale.**
   - Cottages are drawn **2.5–4× true scale**, about 16–28 px or 4–7% of the screen width.
   - Landmarks (church, castle, tower) are about 10–15%, and only **1–2 per screen**.
   - When footprints overlap at this scale, thin them: keep one cottage per cluster cell (about 25–40 m) rather than one per OSM building.

7. **Cluster, then rest.**
   - Group cottages into hamlets of 3–12, facing a road or a small open square.
   - Attach 1–3 elements to each farmstead: a garden plot, a fenced paddock or a field strip behind the house, burgage-style.
   - Keep **≥ 25% of the screen** as plain rest ground (meadow, field, water) with only sparse decals.

8. **Roads are trodden earth.**
   - Colour `#9c8350`–`#b59a5c`, 10–25 value points lighter than the grass.
   - Width about 0.35–0.5× a cottage width (about 6–12 px). Main roads up to 1.5×, footpaths about 3 px.
   - Soft edges: a 3–5 px feather plus noise. Optionally draw a faint darker rim 1 px outside the edge.
   - Widen into worn blobs at junctions and in front of doors. Each road segment that serves a house ends at its footprint decal.

9. **Forests are overlapping crowns.**
   - Fill the forest polygon with a darker underlayer (value about 20–30%).
   - Then stamp crowns from back to front (top to bottom on screen):
     - in 2–3 shapes (round deciduous, cone conifer, small bush);
     - in 3 green tints ±10% around `#3d5524`;
     - with 5–10% autumn or yellow accents;
     - with crown radius ±15%;
     - each lit on its upper-left and darker on its lower-right.
   - The edge is ragged: scatter 1–5 outlier trees per 100 m of edge, up to 2 crown-widths outside. Cast one combined soft shadow from the mass onto the grass on the lower-right side.

10. **Water has a layered shore.**
    - Deep water `#1f4860`–`#2e5a74`, calm, with very faint wave strokes.
    - Shallow band: lighter teal (`#5a8a8c`), 8–20 px wide along all shores.
    - A 1.5–2.5 px light foam or waterline (`rgba(235,240,225,0.7)`) on the shore, plus an optional second faint ripple line 4–6 px further out.
    - On land: a thin sand or earth bank (3–8 px) or a dark reed or grass edge.
    - Rivers and canals: a ribbon with a 1–2 px brown bank line on both sides, and no foam.

11. **Value structure first.** Check the canvas in grayscale (a debug toggle that applies `filter: grayscale(1)`):
    - forest is darkest (value about 20–30%);
    - grass is mid (30–50%);
    - roads, plots and fields are lighter (50–70%);
    - water is darker than grass in deep areas and lighter in the shallows;
    - roofs and landmarks have the strongest local contrast against their own footprint.
    If two neighbouring categories merge in grayscale, change their values, not their hues.

12. **Saturation budget.** Saturated colour covers **under 5% of the pixels**: roofs (terracotta `#b85a36`, brick `#8c3b2a`, thatch `#b08a4a`), flags, and flower decals. Ground colours stay at 40–65% saturation. Keep everything warm except the water and the shadows, which are the only cool elements.

13. **Decals in clumps, not confetti.** Scatter 2–4 decal types (flower patches in 2–3 colours, rocks, tufts, small dirt crumbs) with a clustered distribution, such as Poisson clusters of 3–7 items. Aim for about 10–30 clusters per screen, denser near settlements and road edges, and nearly none on rest areas.

14. **Upright sprites on top-down ground.**
    - Ground layers stay strictly top-down in OSM geometry.
    - Cottages, trees and landmarks are 3/4 sprites anchored at bottom-centre on the footprint centroid, drawn in y-sorted order.
    - Show the roof plus one front wall face (wall height about 0.4–0.6 of the roof depth).
    - Use no outlines, or a uniform 1–1.5 px dark, desaturated outline on every sprite. Never mix the two.

15. **Variety without noise.** Every repeated element (tree, cottage, decal) gets a seeded random variant chosen from 3–5 shapes, a tint ±8%, a size ±15% and a mirror flip. Seed by world position, so a place looks the same on every visit.

## Sources (developer or publisher statements)

- Toukana Interactive (Dorfromantik): [80.lv interview](https://80.lv/articles/how-dorfromantik-expands-its-cozy-world-through-minimalist-design), [Game Developer](https://www.gamedeveloper.com/disciplines/sparking-joy-through-tile-placement-in-idyllic-village-builder-i-dorfromantik-i-) (mood boards from landscape painting, "an ideal and harmonic interpretation of the real-world landscapes").
- Ubisoft Blue Byte: [Anno Union, Of 3D Architects and Construction Workers](https://www.anno-union.com/devblog-of-3d-architects-and-construction-workers/).
- Manor Lords and Tiny Glade: official Steam descriptions ([Manor Lords](https://store.steampowered.com/app/1363080), [Tiny Glade](https://store.steampowered.com/app/2198150)). The [80.lv Tiny Glade interview](https://80.lv/articles/exclusive-tiny-glade-developers-discuss-bevy-proceduralism-publishers-cozy-games) has no concrete rendering rules. The developers stress hand-curated procedural rules: "we curate exactly the experience you will get out of it".
- HoMM3: [David Mullich, Remembering Erathia](https://www.gamedeveloper.com/production/heroes-of-might-magic-iii-remembering-erathia-15-years-later). Art direction moved to "extreme fantasy", led by Phelan Sykes. The article says nothing concrete about the map. All HoMM findings above are [S].
- Amit Patel (Red Blob Games): [outlines](https://simblob.blogspot.com/2018/10/mapgen4-outlines.html), [oblique projection](https://simblob.blogspot.com/2018/09/mapgen4-oblique-projection.html).
- Cartography: [Esri hillshade defaults](https://doc.esri.com/en/arcgis-pro/latest/tool-reference/3d-analyst/how-hillshade-works.html), [K.M. Alexander coastline hatching](https://www.goodreads.com/author_blog_posts/18661617-tutorial-creating-18th-century-coastlines-for-fantasy-maps), [mewo2/terrain](https://github.com/mewo2/terrain).

**Gaps**:
- I found no primary developer source for Kingdom Rush, AoE2 DE, Settlers or Townscaper rendering rules. A widely repeated Townscaper palette quote could not be traced to a source, so I left it out. Findings for those games are screenshot readings only.
- [mewo2.com/notes/terrain](https://mewo2.com/notes/terrain) now returns 404.
