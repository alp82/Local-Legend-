# Legend map assets

Footprints are starting values for map placement, measured along the object’s ground axes. They describe the feature at ground level. Anchor upright sprites at the ground-contact centre and preserve aspect ratio when sizing the PNG. For fences, walls and quays, the first dimension runs along the segment. Overlap alpine silhouettes at their low shoulders.

Tiles repeat over the stated square in world coordinates. Mask the road, path, and water fills to the feature geometry. Rotate crop rows with their parcel, and blend between the three meadow tiles in world space to reduce repetition at larger scales.

Set two uses built-in image generation with the original concept art as the style reference. Sprites use native alpha with transparent padding. Tile edges use opposing-strip overlap and phase alignment on the crop rows.

## Set two · terrain

| File | Contents | Pixels | Ground footprint (m) |
| --- | --- | ---: | ---: |
| `textures/meadow-soft.png` | Lush olive-yellow meadow A | 512 × 512 | 32 × 32 |
| `textures/meadow-sunlit.png` | Lush golden-green meadow B | 512 × 512 | 32 × 32 |
| `textures/meadow-cool.png` | Lush cool-green meadow C | 512 × 512 | 32 × 32 |
| `textures/wildflower-meadow.png` | Grass with scattered small wildflowers | 512 × 512 | 36 × 36 |
| `textures/pasture.png` | Short grazed pasture with worn grass | 512 × 512 | 36 × 36 |
| `textures/wheat-field.png` | Parallel ripe wheat rows | 512 × 512 | 24 × 24 |
| `textures/ploughed-earth.png` | Fine ploughed furrows | 512 × 512 | 20 × 20 |
| `textures/vegetable-rows.png` | Low rows of vegetables in worked loam | 512 × 512 | 18 × 18 |
| `textures/forest-floor.png` | Dark woodland litter and moss | 512 × 512 | 28 × 28 |
| `textures/cobbled-square.png` | Irregular dressed square paving | 512 × 512 | 12 × 12 |
| `textures/cobbled-road.png` | Weathered fine road setts | 512 × 512 | 12 × 12 |
| `textures/dirt-path.png` | Packed warm footpath earth | 512 × 512 | 16 × 16 |
| `textures/river-water.png` | Deep teal canal or running river water | 512 × 512 | 32 × 32 |
| `textures/lake-water.png` | Calm slate-teal lake water | 512 × 512 | 40 × 40 |
| `textures/shallow-water.png` | Light translucent shore water | 512 × 512 | 24 × 24 |
| `textures/sand.png` | Fine warm shore sand | 512 × 512 | 25 × 25 |
| `textures/rock.png` | Weathered exposed alpine bedrock | 512 × 512 | 26 × 26 |
| `textures/scree.png` | Dense small alpine scree | 512 × 512 | 26 × 26 |
| `textures/snow.png` | Soft alpine snow ground | 512 × 512 | 32 × 32 |

## Set two · objects

| File | Contents | Pixels | Ground footprint (m) |
| --- | --- | ---: | ---: |
| `objects2/house-limewash.png` | Limewashed house | 934 × 1234 | 12 × 9 |
| `objects2/house-stepped-gable.png` | Stepped-gable brick house | 802 × 1288 | 11 × 10 |
| `objects2/house-cross-gable.png` | Cross-gabled timber house | 1186 × 1232 | 13 × 12 |
| `objects2/house-hipped-cottage.png` | Hipped-roof field house | 1228 × 1199 | 12 × 10 |
| `objects2/rowhouses-canal.png` | Three attached canal-side row houses | 1293 × 1054 | 30 × 12 |
| `objects2/rowhouses-street.png` | Four attached street-front houses | 1338 × 935 | 30 × 13 |
| `objects2/farmstead-yard.png` | Farmstead with shared working yard | 1318 × 1076 | 34 × 28 |
| `objects2/fence-straight.png` | Straight timber post-and-rail fence | 1408 × 902 | 12 × 1 |
| `objects2/fence-corner.png` | L-shaped timber fence corner | 1419 × 764 | 8 × 8 |
| `objects2/hedge-segment.png` | Straight clipped field hedge | 1118 × 777 | 14 × 2 |
| `objects2/low-stone-wall.png` | Straight dry-stone field wall | 1121 × 707 | 12 × 1.5 |
| `objects2/town-gate.png` | Fortified town gatehouse | 1117 × 1046 | 20 × 10 |
| `objects2/town-wall-segment.png` | Straight crenellated town wall | 1255 × 904 | 18 × 3 |
| `objects2/town-corner-tower.png` | Town wall corner tower | 1039 × 1133 | 10 × 10 |
| `objects2/fountain.png` | Round limestone village fountain | 958 × 790 | 6 × 6 |
| `objects2/monument-statue.png` | Small weathered carved civic statue | 753 × 1297 | 5 × 5 |
| `objects2/standing-stones.png` | Small irregular standing-stone site | 1255 × 818 | 16 × 14 |
| `objects2/graveyard-patch.png` | Small medieval graveyard patch | 1445 × 867 | 24 × 20 |
| `objects2/cathedral.png` | Large landmark church | 1367 × 1267 | 35 × 22 |
| `objects2/monastery.png` | Monastery and cloister | 1410 × 1043 | 44 × 32 |
| `objects2/inn.png` | Wayside inn with porch | 1221 × 1041 | 20 × 14 |
| `objects2/town-hall.png` | Medieval guild or town hall | 1032 × 1213 | 22 × 17 |
| `objects2/watermill.png` | Riverside watermill with exposed wheel | 975 × 1188 | 20 × 14 |
| `objects2/quay-boats.png` | Straight stone quay and two moored boats | 1374 × 992 | 36 × 8 |
| `objects2/sheep-group.png` | Flock of five sheep | 1256 × 929 | 13 × 10 |
| `objects2/cow-group.png` | Group of three cows | 1239 × 897 | 16 × 11 |
| `objects2/horse-paddock.png` | Fenced small horse paddock | 1252 × 869 | 27 × 21 |
| `objects2/flower-garden.png` | Low ornamental flower beds | 1275 × 863 | 15 × 12 |
| `objects2/forest-deciduous-round.png` | Compact rounded deciduous woodland clump | 1284 × 1170 | 24 × 22 |
| `objects2/forest-deciduous-belt.png` | Long narrow deciduous woodland belt | 1592 × 959 | 40 × 18 |
| `objects2/forest-deciduous-hook.png` | Large hooked deciduous woodland clump | 1290 × 1039 | 36 × 30 |
| `objects2/forest-pine-small.png` | Small triangular conifer clump | 1029 × 1212 | 23 × 19 |
| `objects2/forest-pine-large.png` | Large irregular pine woodland clump | 1354 × 1085 | 42 × 29 |
| `objects2/bush-hawthorn.png` | Single low rounded hawthorn bush | 935 × 771 | 3 × 3 |
| `objects2/bush-juniper.png` | Single sprawling juniper bush | 1431 × 716 | 4 × 3 |
| `objects2/reeds.png` | Small bank reed tuft | 1086 × 1129 | 5 × 3 |
| `objects2/massif-ridge.png` | Long asymmetric alpine ridge massif | 1716 × 1037 | 170 × 105 |
| `objects2/massif-double-peak.png` | Twin-peak alpine massif | 1633 × 1126 | 130 × 105 |
| `objects2/massif-plateau.png` | Broad flat-shouldered alpine massif | 2103 × 812 | 155 × 110 |
| `objects2/cliff-band.png` | Long layered limestone escarpment | 1788 × 809 | 86 × 23 |
| `objects2/snowy-summit.png` | Pale snowy alpine summit accent | 1211 × 1145 | 70 × 55 |

## Set one · objects

| File | Contents | Pixels | Ground footprint (m) |
| --- | --- | ---: | ---: |
| `objects/thatched-cottage.png` | Thatched cottage | 1081 × 1142 | 11 × 9 |
| `objects/timber-frame-house.png` | Timber frame house | 1022 × 1156 | 12 × 10 |
| `objects/stone-house.png` | Stone house | 1243 × 1188 | 13 × 10 |
| `objects/barn.png` | Barn | 1264 × 999 | 15 × 12 |
| `objects/long-house.png` | Long house | 1337 × 961 | 19 × 9 |
| `objects/tower-house.png` | Tower house | 947 × 1370 | 8 × 8 |
| `objects/chapel.png` | Chapel | 998 × 1260 | 18 × 12 |
| `objects/market-stalls.png` | Market stalls | 1255 × 928 | 13 × 10 |
| `objects/well.png` | Well | 885 × 1191 | 5 × 5 |
| `objects/windmill.png` | Windmill | 916 × 1180 | 10 × 10 |
| `objects/wooden-bridge.png` | Wooden bridge | 1406 × 901 | 12 × 4 |
| `objects/stone-bridge.png` | Stone bridge | 1410 × 950 | 15 × 5 |
| `objects/deciduous-oak.png` | Deciduous oak | 1209 × 1136 | 9 × 9 |
| `objects/deciduous-birch.png` | Deciduous birch | 911 × 1453 | 5 × 5 |
| `objects/deciduous-autumn-maple.png` | Deciduous autumn maple | 1166 × 1151 | 8 × 8 |
| `objects/pine-tall.png` | Pine tall | 715 × 1282 | 5 × 5 |
| `objects/pine-spreading.png` | Pine spreading | 1330 × 1158 | 9 × 8 |
| `objects/forest-clump.png` | Forest clump | 1290 × 1199 | 22 × 20 |
| `objects/orchard-patch.png` | Orchard patch | 1140 × 1075 | 25 × 22 |
| `objects/crop-field-patch.png` | Crop field patch | 1404 × 865 | 22 × 18 |
| `objects/vegetable-garden.png` | Vegetable garden | 1338 × 904 | 12 × 9 |
| `objects/haystack.png` | Haystack | 895 × 844 | 4 × 4 |
| `objects/rock-mossy.png` | Rock mossy | 1042 × 828 | 4 × 3 |
| `objects/rock-angular.png` | Rock angular | 806 × 955 | 3 × 3 |
| `objects/rock-flat.png` | Rock flat | 1186 × 602 | 5 × 2 |
| `objects/rocky-cliff.png` | Rocky cliff | 1188 × 1118 | 26 × 12 |
| `objects/mountain-peak.png` | Mountain peak | 1213 × 1192 | 60 × 45 |
| `objects/jetty-and-boat.png` | Jetty and boat | 1207 × 1027 | 13 × 6 |

## Reference views

| File | Contents | Pixels | Ground footprint (m) |
| --- | --- | ---: | ---: |
| `targets/amsterdam-open-country.png` | Painted target composition | 853 × 1844 | ≈ 399 × 864 |
| `targets/amsterdam-village-heart.png` | Painted target composition | 852 × 1846 | ≈ 399 × 864 |
| `targets/innsbruck-open-country.png` | Painted target composition | 880 × 1787 | ≈ 392 × 849 |
| `targets/innsbruck-village-heart.png` | Painted target composition | 853 × 1844 | ≈ 392 × 849 |
| `targets/manhattan-open-country.png` | Painted target composition | 852 × 1846 | ≈ 400 × 867 |
| `targets/manhattan-village-heart.png` | Painted target composition | 852 × 1846 | ≈ 400 × 867 |
| `references/amsterdam-real.png` | Real-map geometry reference | 960 × 2080 | ≈ 399 × 864 |
| `references/innsbruck-real.png` | Real-map geometry reference | 960 × 2080 | ≈ 392 × 849 |
| `references/manhattan-real.png` | Real-map geometry reference | 960 × 2080 | ≈ 400 × 867 |
| `references/manhattan-reframed-real.png` | Real-map geometry reference | 960 × 2080 | ≈ 400 × 867 |

## Preview sheets

| File | Contents | Pixels | Ground footprint (m) |
| --- | --- | ---: | ---: |
| `contact-sheet.png` | Set-one object contact sheet | 1766 × 1094 | — |
| `set2-object-sheet.png` | Set-two object contact sheet | 1670 × 1463 | — |
| `set2-texture-tiling.png` | All set-two textures repeated in a 3 × 3 grid each | 1636 × 1445 | — |

`generation.json` records the set-one prompts and reference cameras.

## Set three

Linear filenames encode the screen ground axis in the north-up renderer. `ew` runs horizontally, `ns` vertically, `ne-sw` rises to the right, and `nw-se` falls to the right. Architectural angles are buckets, so align to the painted ground contacts. Ground length and width stay constant across each family. Align by the ground-contact line and slightly overlap adjacent ends to hide the join. Bridge span dimensions include the deck ends. For water edges, place the visible bank face on the water side.

Roof pairs use the set-one ground footprint in both chimney states. Decals sit on the ground surface at low opacity as needed. Set-three textures are 512-pixel periodic tiles. Rutted roads use a common 4:1 ground aspect and periodic short ends. All artwork came from the built-in image generator, with local trimming and periodic edge finishing.

## Oriented modules

| File | Contents | Pixels | Ground footprint (m) |
| --- | --- | ---: | ---: |
| `objects3/fence-ew.png` | Two-rail oak fence, east–west | 1909 × 600 | 12 × 1 |
| `objects3/fence-ns.png` | Two-rail oak fence, north–south | 306 × 1496 | 12 × 1 |
| `objects3/fence-ne-sw.png` | Two-rail oak fence, northeast–southwest | 1037 × 933 | 12 × 1 |
| `objects3/fence-nw-se.png` | Two-rail oak fence, northwest–southeast | 1023 × 924 | 12 × 1 |
| `objects3/hedge-ew.png` | Clipped mixed hawthorn hedge, east–west | 2073 × 435 | 14 × 2 |
| `objects3/hedge-ns.png` | Clipped mixed hawthorn hedge, north–south | 309 × 1497 | 14 × 2 |
| `objects3/hedge-ne-sw.png` | Clipped mixed hawthorn hedge, northeast–southwest | 1063 × 1009 | 14 × 2 |
| `objects3/hedge-nw-se.png` | Clipped mixed hawthorn hedge, northwest–southeast | 1016 × 1055 | 14 × 2 |
| `objects3/stone-wall-ew.png` | Low dry limestone wall, east–west | 1782 × 373 | 12 × 1.5 |
| `objects3/stone-wall-ns.png` | Low dry limestone wall, north–south | 274 × 1025 | 12 × 1.5 |
| `objects3/stone-wall-ne-sw.png` | Low dry limestone wall, northeast–southwest | 1075 × 895 | 12 × 1.5 |
| `objects3/stone-wall-nw-se.png` | Low dry limestone wall, northwest–southeast | 973 × 842 | 12 × 1.5 |
| `objects3/canal-quay-ew.png` | Built stone canal quay with cap, east–west | 2045 × 498 | 18 × 3 |
| `objects3/canal-quay-ns.png` | Built stone canal quay with cap, north–south | 281 × 1492 | 18 × 3 |
| `objects3/canal-quay-ne-sw.png` | Built stone canal quay with cap, northeast–southwest | 1016 × 1089 | 18 × 3 |
| `objects3/canal-quay-nw-se.png` | Built stone canal quay with cap, northwest–southeast | 1120 × 1125 | 18 × 3 |
| `objects3/riverbank-rocky-ew.png` | Natural stony riverbank edge, east–west | 2170 × 385 | 17 × 3 |
| `objects3/riverbank-rocky-ns.png` | Natural stony riverbank edge, north–south | 371 × 1496 | 17 × 3 |
| `objects3/riverbank-rocky-ne-sw.png` | Natural stony riverbank edge, northeast–southwest | 1163 × 1087 | 17 × 3 |
| `objects3/riverbank-rocky-nw-se.png` | Natural stony riverbank edge, northwest–southeast | 1182 × 1025 | 17 × 3 |
| `objects3/canal-bridge-arch-ew.png` | Short single arch stone canal bridge, east–west | 1984 × 704 | 14 × 5 |
| `objects3/canal-bridge-arch-ns.png` | Short single arch stone canal bridge, north–south | 416 × 1349 | 14 × 5 |
| `objects3/canal-bridge-arch-ne-sw.png` | Short single arch stone canal bridge, northeast–southwest | 1113 × 1069 | 14 × 5 |
| `objects3/canal-bridge-arch-nw-se.png` | Short single arch stone canal bridge, northwest–southeast | 1020 × 964 | 14 × 5 |
| `objects3/river-bridge-multiarch-ew.png` | Modular three-arch stone river bridge, east–west | 2286 × 659 | 39 × 7 |
| `objects3/river-bridge-multiarch-ns.png` | Modular three-arch stone river bridge, north–south | 497 × 1812 | 39 × 7 |
| `objects3/river-bridge-multiarch-ne-sw.png` | Modular three-arch stone river bridge, northeast–southwest | 1208 × 1155 | 39 × 7 |
| `objects3/river-bridge-multiarch-nw-se.png` | Modular three-arch stone river bridge, northwest–southeast | 1156 × 1057 | 39 × 7 |
| `objects3/terraced-row-ew.png` | Attached terraced street houses, east–west | 1724 × 854 | 30 × 12 |
| `objects3/terraced-row-ns.png` | Attached terraced street houses, north–south | 901 × 1649 | 30 × 12 |
| `objects3/terraced-row-ne-sw.png` | Attached terraced street houses, northeast–southwest | 1228 × 1221 | 30 × 12 |
| `objects3/terraced-row-nw-se.png` | Attached terraced street houses, northwest–southeast | 1205 × 1073 | 30 × 12 |
| `objects3/canal-stepped-row-ew.png` | Attached stepped-gable canal houses, east–west | 1266 × 913 | 28 × 11 |
| `objects3/canal-stepped-row-ns.png` | Attached stepped-gable canal houses, north–south | 894 × 1502 | 28 × 11 |
| `objects3/canal-stepped-row-ne-sw.png` | Attached stepped-gable canal houses, northeast–southwest | 1080 × 1246 | 28 × 11 |
| `objects3/canal-stepped-row-nw-se.png` | Attached stepped-gable canal houses, northwest–southeast | 1138 × 1260 | 28 × 11 |
| `objects3/paving-kerb-ew.png` | Herringbone square kerb edging, east–west | 1971 × 298 | 12 × 1 |
| `objects3/paving-kerb-ns.png` | Herringbone square kerb edging, north–south | 182 × 1083 | 12 × 1 |
| `objects3/paving-kerb-ne-sw.png` | Herringbone square kerb edging, northeast–southwest | 998 × 1000 | 12 × 1 |
| `objects3/paving-kerb-nw-se.png` | Herringbone square kerb edging, northwest–southeast | 938 × 943 | 12 × 1 |
| `objects3/rutted-road-ew.png` | Rutted earth road with two grass verges, east–west | 872 × 272 | 20 × 5 |
| `objects3/rutted-road-ns.png` | Rutted earth road with two grass verges, north–south | 272 × 872 | 20 × 5 |
| `objects3/rutted-road-ne-sw.png` | Rutted earth road with two grass verges, northeast–southwest | 773 × 772 | 20 × 5 |
| `objects3/rutted-road-nw-se.png` | Rutted earth road with two grass verges, northwest–southeast | 767 × 770 | 20 × 5 |

## Objects and roof variants

| File | Contents | Pixels | Ground footprint (m) |
| --- | --- | ---: | ---: |
| `objects3/rowing-boat-ne.png` | Oak rowboat pointing upper right | 1136 × 817 | 5 × 2 |
| `objects3/rowing-boat-se.png` | Trim rowboat pointing lower right | 1063 × 864 | 5 × 2 |
| `objects3/rowing-boat-s.png` | Broad rowboat pointing down screen | 605 × 935 | 5 × 2 |
| `objects3/lily-pads-small.png` | Loose cluster of five small lily pads | 1130 × 736 | 3 × 3 |
| `objects3/lily-pads-large.png` | Wide lily pad cluster with ivory bloom | 1062 × 822 | 5 × 3 |
| `objects3/river-foam.png` | Broken foam at a water obstacle | 1329 × 484 | 7 × 3 |
| `objects3/river-ripple.png` | Subtle ripple and wake stroke decal | 1479 × 305 | 8 × 4 |
| `objects3/church-baroque-onion.png` | Tyrolean Baroque onion-dome church | 1074 × 1334 | 25 × 18 |
| `objects3/church-tall-spire.png` | Church with one tall Gothic spire | 1083 × 1467 | 27 × 17 |
| `objects3/church-parish.png` | Small rural parish church | 1065 × 1037 | 17 × 11 |
| `objects3/tavern-hanging-sign.png` | Tavern with a hanging carved tankard | 1234 × 1227 | 19 × 14 |
| `objects3/market-stall-fish.png` | Fishmonger stall with striped canvas | 824 × 999 | 5 × 4 |
| `objects3/market-stall-textile.png` | Textile stall with muted rust awning | 846 × 1056 | 5 × 4 |
| `objects3/market-stall-produce.png` | Produce stall with blue canvas | 777 × 1021 | 5 × 4 |
| `objects3/banner-pole-blue.png` | Slate-blue heraldic banner on one pole | 613 × 1378 | 2 × 2 |
| `objects3/banner-pole-ochre.png` | Rust-and-gold pennant on one pole | 776 × 1195 | 2 × 2 |
| `objects3/lantern-post-wood.png` | Timber post with one amber lantern | 692 × 1268 | 2 × 2 |
| `objects3/lantern-post-stone.png` | Carved stone-and-iron lantern post | 597 × 1167 | 2 × 2 |
| `objects3/hedged-planter-long.png` | Long box-hedge planter | 1517 × 517 | 8 × 3 |
| `objects3/hedged-planter-knot.png` | Small square knot-garden planter | 1159 × 953 | 6 × 5 |
| `objects3/alpine-hut.png` | Small timber alpine hut | 1023 × 1180 | 10 × 8 |
| `objects3/blossom-tree-pink.png` | Round tree with pale pink blossoms | 1134 × 1164 | 8 × 8 |
| `objects3/blossom-tree-white.png` | Round tree with ivory blossoms | 1338 × 1143 | 8 × 8 |
| `objects3/columnar-cypress.png` | Narrow upright cypress tree | 517 × 1661 | 5 × 5 |
| `objects3/round-tree-beech.png` | Broad rounded beech tree | 1325 × 1211 | 10 × 9 |
| `objects3/round-tree-linden.png` | Light olive heart-crowned linden | 1056 × 1076 | 8 × 8 |
| `objects3/round-tree-elm.png` | Wide asymmetric rounded elm | 1440 × 995 | 11 × 9 |
| `objects3/round-tree-young-oak.png` | Small rounded young oak | 960 × 1012 | 6 × 6 |
| `objects3/slope-outcrop-shelf.png` | Large horizontal fractured rock shelf | 1537 × 898 | 20 × 12 |
| `objects3/slope-outcrop-spur.png` | Large angular limestone spur | 966 × 954 | 16 × 13 |
| `objects3/slope-boulder-pair.png` | Two large weathered slope boulders | 1287 × 845 | 10 × 7 |
| `objects3/timber-frame-roof-thatch-clear.png` | timber frame with thatch roof, clear chimney | 1073 × 1067 | 12 × 10 |
| `objects3/timber-frame-roof-thatch-smoke.png` | timber frame with thatch roof, chimney smoke | 1026 × 1177 | 12 × 10 |
| `objects3/timber-frame-roof-red-tile-clear.png` | timber frame with red tile roof, clear chimney | 1085 × 1069 | 12 × 10 |
| `objects3/timber-frame-roof-red-tile-smoke.png` | timber frame with red tile roof, chimney smoke | 1081 × 1164 | 12 × 10 |
| `objects3/timber-frame-roof-grey-slate-clear.png` | timber frame with grey slate roof, clear chimney | 1098 × 1083 | 12 × 10 |
| `objects3/timber-frame-roof-grey-slate-smoke.png` | timber frame with grey slate roof, chimney smoke | 1051 × 1187 | 12 × 10 |
| `objects3/timber-frame-roof-mossy-clear.png` | timber frame with mossy roof, clear chimney | 1202 × 1166 | 12 × 10 |
| `objects3/timber-frame-roof-mossy-smoke.png` | timber frame with mossy roof, chimney smoke | 1039 × 1181 | 12 × 10 |
| `objects3/stone-house-roof-thatch-clear.png` | stone house with thatch roof, clear chimney | 1289 × 1117 | 13 × 10 |
| `objects3/stone-house-roof-thatch-smoke.png` | stone house with thatch roof, chimney smoke | 1288 × 1166 | 13 × 10 |
| `objects3/stone-house-roof-red-tile-clear.png` | stone house with red tile roof, clear chimney | 1291 × 1114 | 13 × 10 |
| `objects3/stone-house-roof-red-tile-smoke.png` | stone house with red tile roof, chimney smoke | 1291 × 1151 | 13 × 10 |
| `objects3/stone-house-roof-grey-slate-clear.png` | stone house with grey slate roof, clear chimney | 1287 × 1113 | 13 × 10 |
| `objects3/stone-house-roof-grey-slate-smoke.png` | stone house with grey slate roof, chimney smoke | 1286 × 1111 | 13 × 10 |
| `objects3/stone-house-roof-mossy-clear.png` | stone house with mossy roof, clear chimney | 1293 × 1113 | 13 × 10 |
| `objects3/stone-house-roof-mossy-smoke.png` | stone house with mossy roof, chimney smoke | 1284 × 1234 | 13 × 10 |

## Ground textures and decals

| File | Contents | Pixels | Ground footprint (m) |
| --- | --- | ---: | ---: |
| `objects3/decals-flower-ivory.png` | Sparse ivory wildflower scatter | 505 × 456 | 4 × 3 |
| `objects3/decals-flower-pink.png` | Scattered dusty pink wildflower flecks | 806 × 514 | 4 × 3 |
| `objects3/decals-flower-lavender.png` | Tiny muted lavender wildflower spires | 735 × 528 | 4 × 3 |
| `objects3/decals-grass-tufts-light.png` | Light grass blade tufts | 612 × 360 | 4 × 3 |
| `objects3/decals-grass-tufts-dark.png` | Dark olive grass and sedge tufts | 1184 × 671 | 5 × 3 |
| `objects3/decals-pebbles.png` | Grey and ochre small pebble scatter | 727 × 384 | 5 × 3 |
| `objects3/decals-clover.png` | Low clover leaves with soft edges | 1008 × 725 | 4 × 3 |
| `objects3/decals-bare-earth.png` | Worn bare-earth patch with feathered edges | 1107 × 532 | 7 × 5 |
| `objects3/decals-leaf-litter.png` | Scattered warm leaf litter | 992 × 604 | 6 × 4 |
| `textures/meadow-swales.png` | Lush olive meadow with irregular swales | 512 × 512 | 70 × 70 |
| `textures/meadow-dry-patches.png` | Mixed short meadow with dry tawny patches | 512 × 512 | 68 × 68 |
| `textures/meadow-deep-green.png` | Cool deep green meadow with leafy variation | 512 × 512 | 70 × 70 |
| `textures/paving-herringbone.png` | Warm limestone herringbone square paving | 512 × 512 | 16 × 16 |

## Set-three preview sheets

| File | Contents | Pixels | Ground footprint (m) |
| --- | --- | ---: | ---: |
| `set3-oriented.png` | Oriented modules · Set three | 1086 × 2734 | — |
| `set3-objects.png` | Map objects · Set three | 1554 × 1485 | — |
| `set3-roof-variants.png` | Roof and chimney variants · Set three | 1046 × 1025 | — |
| `set3-ground.png` | Terrain · 3 × 3 repeats and ground decals | 1046 × 1165 | — |

## Paint-over experiment

| File | Contents | Pixels | Ground footprint (m) |
| --- | --- | ---: | ---: |
| `paintover/amsterdam-overlay.png` | Amsterdam overlay | 780 × 1688 | ≈ 284 × 615 |
| `paintover/amsterdam.png` | Amsterdam live-map paint-over | 853 × 1844 | ≈ 284 × 615 |
| `paintover/innsbruck-overlay.png` | Innsbruck overlay | 780 × 1688 | ≈ 316 × 684 |
| `paintover/innsbruck.png` | Innsbruck live-map paint-over | 853 × 1844 | ≈ 316 × 684 |
| `paintover/manhattan-overlay.png` | Manhattan overlay | 780 × 1688 | ≈ 353 × 764 |
| `paintover/manhattan.png` | Manhattan live-map paint-over | 853 × 1844 | ≈ 353 × 764 |
| `paintover/seam-comparison.png` | Seam comparison | 1416 × 1812 | — |
| `paintover/seam-input-a.png` | Seam input a | 780 × 1688 | ≈ 284 × 615 |
| `paintover/seam-input-b.png` | Seam input b | 780 × 1688 | ≈ 284 × 615 |
| `paintover/seam-input-wide.png` | Seam input wide | 1170 × 1688 | ≈ 426 × 615 |
| `paintover/seam-render-a.png` | Seam render a | 780 × 1688 | ≈ 284 × 615 |
| `paintover/seam-render-b.png` | Seam render b | 780 × 1688 | ≈ 284 × 615 |
| `paintover/seam-render-conditioned.png` | Seam render conditioned | 780 × 1688 | ≈ 284 × 615 |
| `paintover/seam-render-wide-cut-a.png` | Seam render wide cut a | 780 × 1688 | ≈ 284 × 615 |
| `paintover/seam-render-wide-cut-b.png` | Seam render wide cut b | 780 × 1688 | ≈ 284 × 615 |
| `paintover/seam-render-wide.png` | Seam render wide | 1170 × 1688 | ≈ 426 × 615 |

See [the paint-over report](paintover/REPORT.md) for the comparison method and timings.

## Set four

Set pieces contain the painted buildings and their shared ground in one transparent image. Place them by the civic-space or yard anchor and join the live road to the feathered path entrance. [Set-piece placement data](setpieces/placements.json) records the visible ground anchors, path ports and waterfront baselines in pixels and normalized coordinates. Footprints are in-world ground sizes. The sprite canvas includes standing features and its clear fringe.

Forest edges overlap the dark canopy side. Mountain pieces overlap along scree and low shoulders. River and canal fills repeat at their listed ground dimensions. Rotate or align the fill to the locally dominant flow. The shoreline PNGs keep water-side transparency so the water fill can continue behind them.

### Settlements and set pieces

| File | Contents | Pixels | Ground footprint (m) |
| --- | --- | ---: | ---: |
| `setpieces/hamlet-well-yard.png` | Slate and thatch cottages around a well. Anchor well in fork yard; paths S, W | 1566 × 1104 | 57 × 46 |
| `setpieces/hamlet-red-barn.png` | Red-roof farm hamlet with a shared yard. Anchor shared dirt yard; paths SE, N | 1576 × 1086 | 61 × 48 |
| `setpieces/hamlet-orchard-crossing.png` | Orchard hamlet facing a gravel crossroads. Anchor orchard-yard well; paths S, E | 1617 × 1106 | 62 × 52 |
| `setpieces/hamlet-limewashed.png` | Three limewashed cottages on a small common. Anchor green at lane fork; paths SW, NE | 1552 × 1083 | 53 × 47 |
| `setpieces/village-chapel-green.png` | Blue-roof village around a chapel green. Anchor green-side well; paths S, E | 1432 × 1135 | 103 × 84 |
| `setpieces/village-red-square.png` | Russet-roof hamlet growing around a small square. Anchor small-square well; paths SW, NE | 1560 × 1086 | 104 × 87 |
| `setpieces/village-crossroads.png` | Long crossroads village with chapel and yards. Anchor well beside crossroads; paths W, E | 1822 × 930 | 111 × 79 |
| `setpieces/village-willow-well.png` | Warm limestone village with a willow by the well. Anchor well below the willow green; paths S, NW | 1537 × 1152 | 98 × 83 |
| `setpieces/village-timber-commons.png` | Timber village with thatch and shared commons. Anchor well in the commons; paths SE, N | 1474 × 1167 | 108 × 94 |
| `setpieces/town-market-limestone.png` | Limestone market town with two linked courts and pass-through lane. Anchor well in upper market court; paths W, SW, E | 1493 × 1162 | 222 × 146 |
| `setpieces/town-red-gables.png` | Red-gabled town with a corner market and inn. Anchor square fountain; paths SW, NE | 1443 × 1202 | 164 × 135 |
| `setpieces/town-cobbled-cross.png` | Grey-slate town around two short lanes and one market. Anchor cobbled market well; paths S, E | 1618 × 1098 | 171 × 132 |
| `setpieces/town-golden-thatch.png` | Honey-thatch market borough with slate church. Anchor market well; paths SE, W | 1586 × 1070 | 159 × 132 |
| `setpieces/town-orchard-market.png` | Mixed-roof orchard town with a snug market court. Anchor market-court well; paths S, NW | 1467 × 1189 | 172 × 141 |
| `setpieces/walled-town-limestone.png` | Limestone walled borough with a gate and blue spire. Anchor inner market well; paths S | 1403 × 1216 | 184 × 147 |
| `setpieces/walled-town-red-roofs.png` | Red-roofed fortified market centre. Anchor market well inside the walls; paths SW, N | 1381 × 1254 | 181 × 146 |
| `setpieces/walled-town-grey-corner.png` | Grey-slate walled riverside-era borough without a river. Anchor market well inside the walls; paths SE, W | 1515 × 1144 | 191 × 150 |
| `setpieces/alpine-chapel-common.png` | Alpine common with onion-dome church and shared woodpiles. Anchor common well; paths S, E | 1419 × 1214 | 118 × 91 |
| `setpieces/alpine-red-roof-inn.png` | Warm alpine chalets and an inn beneath an onion dome. Anchor stone fountain on the chalet common; paths SW, NE | 1410 × 1197 | 125 × 96 |
| `setpieces/alpine-stone-terrace.png` | Limestone and timber Alpine terraces around a chapel. Anchor well on the stepped market court; paths SE, W | 1434 × 1219 | 131 × 101 |
| `setpieces/farmstead-blue-yard.png` | Blue-slate farmhouse, open barn and vegetable yard. Anchor cart in the shared yard; paths S, W | 1417 × 1182 | 72 × 56 |
| `setpieces/farmstead-thatch-paddock.png` | Thatched farmstead with sheep and an adjoining paddock. Anchor cart in the shared yard; paths E, SW | 1580 × 1083 | 70 × 54 |
| `setpieces/farmstead-brick-strip.png` | Brick-and-clay farm with an attached field strip. Anchor working yard by the cart; paths S, NE | 1546 × 1103 | 76 × 60 |
| `setpieces/farmstead-longhouse.png` | Longhouse and barn facing a compact farmyard. Anchor cart at the dirt yard; paths W, SE | 1602 × 1096 | 78 × 55 |
| `setpieces/farmstead-orchard-gate.png` | Barn, farmhouse and a small orchard by a gated yard. Anchor cart inside the orchard gate; paths SE, N | 1482 × 1078 | 69 × 59 |
| `setpieces/monastery-cloister-garden.png` | Monastery compound with a cloister herb garden. Anchor cloister garden center; paths S | 1609 × 1106 | 135 × 112 |
| `setpieces/watermill-pond-race.png` | Working watermill with millpond and outgoing race. Anchor mill yard by the low stone well; paths W, SE | 1534 × 1068 | 102 × 88 |
| `setpieces/sawmill-wood-edge.png` | Sawmill and log yard at a woodland edge. Anchor log-loading area facing the yard; paths S, E | 1490 × 1162 | 108 × 91 |
| `setpieces/vineyard-estate.png` | Stone vineyard estate with adjoining vine rows. Anchor estate yard between house and press; paths SW, NE | 1584 × 1095 | 131 × 106 |
| `setpieces/fishing-hamlet-jetties.png` | Fishing hamlet with two jetties and moored boats. Anchor shared well; paths E, NE | 1544 × 1069 | 110 × 88 |
| `setpieces/market-fairground.png` | Grass fairground with a clear market lane and stalls. Anchor fairground well; paths S, N | 1408 × 1137 | 107 × 89 |
| `setpieces/graveyard-chapel.png` | Small chapel and sloping graveyard compound. Anchor chapel threshold; paths S, E | 1501 × 1129 | 77 × 66 |
| `setpieces/market-quay-water-west.png` | Blue-roof canal quarter around a small market; water west. Anchor canal-market well; paths E, S | 1390 × 1226 | 116 × 107 |
| `setpieces/market-quay-water-south.png` | Blue-roof canal quarter around a small market; water south. Anchor inland market court; paths N, E | 1597 × 1047 | 116 × 107 |
| `setpieces/red-gable-canal-water-west.png` | Russet stepped gables and a tight waterfront court; water west. Anchor small inland well court; paths E, S | 1316 × 1239 | 119 × 102 |
| `setpieces/red-gable-canal-water-south.png` | Russet stepped gables and a tight waterfront court; water south. Anchor paved court well; paths N, E | 1429 × 1160 | 119 × 102 |
| `setpieces/canal-chapel-court-water-west.png` | Canal-side chapel and cream limestone court; water west. Anchor chapel-court well; paths E, S | 1299 × 1247 | 125 × 109 |
| `setpieces/canal-chapel-court-water-south.png` | Canal-side chapel and cream limestone court; water south. Anchor well on the chapel court; paths N, E | 1567 × 1048 | 125 × 109 |
| `setpieces/quay-workshops-water-west.png` | Grey and moss-roof canal workshops and moorings; water west. Anchor meeting point of workshop lanes; paths E, S | 1328 × 1213 | 110 × 93 |
| `setpieces/quay-workshops-water-south.png` | Grey and moss-roof canal workshops and moorings; water south. Anchor cobbled workshop yard; paths N, E | 1458 × 1115 | 110 × 93 |

### Forests and mountain scenery

| File | Contents | Pixels | Ground footprint (m) |
| --- | --- | ---: | ---: |
| `scenery/forest-deciduous-broad.png` | Broad low mass of mature deciduous woodland | 1477 × 1096 | 123 × 86 |
| `scenery/forest-deciduous-lobed.png` | Three-lobed old deciduous canopy | 1360 × 1124 | 101 × 89 |
| `scenery/forest-deciduous-hook.png` | Hook-shaped deciduous copse with scalloped edge | 1315 × 1204 | 84 × 68 |
| `scenery/forest-deciduous-edge.png` | Long uneven deciduous woodland edge piece | 1788 × 845 | 90 × 26 |
| `scenery/forest-pine-ragged.png` | Large irregular overlapping alpine pine woodland | 1345 × 1217 | 116 × 90 |
| `scenery/forest-pine-swept.png` | Swept long pine copse in a tapering outline | 1576 × 1078 | 96 × 60 |
| `scenery/forest-pine-pocket.png` | Compact triangular pine pocket | 1306 × 1201 | 70 × 55 |
| `scenery/forest-pine-edge.png` | Uneven pine and scrub woodland edge piece | 1806 × 868 | 96 × 28 |
| `scenery/forest-mixed-broad.png` | Large varied pine and oak forest mass | 1467 × 1160 | 138 × 92 |
| `scenery/forest-mixed-bent.png` | Bent irregular belt of mixed woodland | 1564 × 1065 | 105 × 77 |
| `scenery/forest-mixed-pocket.png` | Small layered pine and broadleaf woodland patch | 1350 × 1114 | 76 × 62 |
| `scenery/forest-mixed-edge.png` | Mixed stand edge with a ragged shrub fringe | 1825 × 863 | 93 × 29 |
| `scenery/mountain-forested-slope-band.png` | Wide pine-covered Alpine slope band | 1574 × 1073 | 151 × 91 |
| `scenery/mountain-limestone-cliff-band.png` | Broken Alpine limestone escarpment band | 2124 × 837 | 139 × 48 |
| `scenery/mountain-scree-fan.png` | Fan of loose scree washing into Alpine meadow | 1567 × 1070 | 100 × 81 |
| `scenery/mountain-snow-ridge.png` | Rocky Alpine ridge with irregular snow-capped peaks | 1579 × 1083 | 170 × 111 |

### Cultivated scenery and water fills

| File | Contents | Pixels | Ground footprint (m) |
| --- | --- | ---: | ---: |
| `scenery/field-quilt-ribbon.png` | Long five-strip quilt with a low hedge and haystack | 1824 × 948 | 102 × 64 |
| `scenery/field-quilt-kite.png` | Kite-shaped four-strip field quilt | 1566 × 1104 | 91 × 80 |
| `scenery/field-quilt-step.png` | Stepped six-strip quilt with hedgerows | 1505 × 1066 | 112 × 81 |
| `scenery/field-quilt-hook.png` | Bent three-strip quilt in ochre harvest tones | 1509 × 1072 | 83 × 67 |
| `scenery/orchard-block-rows.png` | Loose orchard block with two short rows | 1557 × 1072 | 75 × 53 |
| `scenery/orchard-block-bloom.png` | Asymmetric mixed blossom orchard | 1444 × 1055 | 70 × 61 |
| `scenery/vineyard-block-slope.png` | Curved vineyard block with short stone terraces | 1403 × 1069 | 78 × 59 |
| `scenery/vineyard-block-long.png` | Long autumn vineyard with staggered vine rows | 1533 × 1086 | 89 × 49 |
| `scenery/paddock-sheep-shelter.png` | Irregular sheep paddock with a low timber shelter | 1508 × 1075 | 68 × 50 |
| `scenery/paddock-cattle-shelter.png` | Open cattle paddock with a blue-roofed shelter | 1556 × 1045 | 79 × 55 |
| `scenery/village-green-pond.png` | Village green with pond, willows and a path fork | 1557 × 1072 | 76 × 67 |
| `scenery/river-current-painted.png` | Seamless painted blue-teal river with current bands | 512 × 512 | 68 × 68 |
| `scenery/canal-reflection-painted.png` | Seamless quiet canal water with subtle broken reflections | 512 × 512 | 52 × 52 |

### Shoreline modules

| File | Contents | Pixels | Ground footprint (m) |
| --- | --- | ---: | ---: |
| `scenery/quay-soft-ew.png` | Weathered dressed-stone quay strip, ew | 2133 × 454 | 28 × 4 |
| `scenery/quay-soft-ns.png` | Weathered dressed-stone quay strip, ns | 397 × 2141 | 28 × 4 |
| `scenery/quay-soft-ne-sw.png` | Weathered dressed-stone quay strip, ne-sw | 1201 × 1228 | 28 × 4 |
| `scenery/quay-soft-nw-se.png` | Weathered dressed-stone quay strip, nw-se | 1277 × 1186 | 28 × 4 |
| `scenery/bank-grassy-ew.png` | Soft grassy bank strip, ew | 2213 × 364 | 28 × 4 |
| `scenery/bank-grassy-ns.png` | Soft grassy bank strip, ns | 322 × 1822 | 28 × 4 |
| `scenery/bank-grassy-ne-sw.png` | Soft grassy bank strip, ne-sw | 1135 × 997 | 28 × 4 |
| `scenery/bank-grassy-nw-se.png` | Soft grassy bank strip, nw-se | 1238 × 1174 | 28 × 4 |
| `scenery/bank-rocky-ew.png` | Rocky and muddy natural bank strip, ew | 2146 × 330 | 28 × 4.5 |
| `scenery/bank-rocky-ns.png` | Rocky and muddy natural bank strip, ns | 460 × 2152 | 28 × 4.5 |
| `scenery/bank-rocky-ne-sw.png` | Rocky and muddy natural bank strip, ne-sw | 1283 × 1236 | 28 × 4.5 |
| `scenery/bank-rocky-nw-se.png` | Rocky and muddy natural bank strip, nw-se | 1250 × 1185 | 28 × 4.5 |
| `scenery/bank-reeds-ew.png` | Low continuous fringe of reeds and cattails, ew | 2216 × 575 | 24 × 3 |
| `scenery/bank-reeds-ns.png` | Low continuous fringe of reeds and cattails, ns | 374 × 1567 | 24 × 3 |
| `scenery/bank-reeds-ne-sw.png` | Low continuous fringe of reeds and cattails, ne-sw | 1451 × 999 | 24 × 3 |
| `scenery/bank-reeds-nw-se.png` | Low continuous fringe of reeds and cattails, nw-se | 1270 × 1223 | 24 × 3 |

### Set-four previews

| File | Contents | Pixels | Ground footprint (m) |
| --- | --- | ---: | ---: |
| `set4-settlements.png` | Composed settlements | 1212 × 1637 | — |
| `set4-compounds.png` | Waterfronts and compounds | 1212 × 1637 | — |
| `set4-woodland-mountains.png` | Woodland and mountain scenery | 1212 × 1327 | — |
| `set4-fields-water.png` | Cultivated scenery and water repeats | 1212 × 1327 | — |
| `set4-shorelines.png` | Shoreline strips · four directions | 1212 × 1327 | — |
| `set4-check.png` | Phone-scale composition of set four | 780 × 1688 | 400 × 866 |
| `set4-check-comparison.png` | Phone-scale composition beside Amsterdam target | 1020 × 1146 | — |

## Set five

Block art carries its own painted boundary and ground fringe. Each terrain type has 40, 80 and 160 m lengths and four north-up screen axes. [Block placement templates](fillers/placement-templates.json) give the matching ground quadrilaterals. The perimeter falls off to alpha so the parcel can meet the caller’s road or meadow. Treat the boundary caps as optional art where a short side needs a gate, corner or termination.

Set-five base textures repeat in world coordinates at the stated metres. Use sunlit meadow art as a surface and the optional translucent patches as decals. Tree avenues leave room for the runtime street. Churchyard bases leave a central opening for a separate church or abbey. All artwork was painted with built-in image generation. Filler prompts used a plan rectangle and the Manhattan open-country paint as the material reference, with an orchard, wetland or landscape asset where the subject needed a closer example. Raster packing aligns the finished parcel to the orientation guide. The opaque paints are edge-wrapped for tiling, and the four meadow tiles are graded to retain distinct warm palettes.

### Straight-sided block fillers

| File | Contents | Pixels | Ground footprint (m) |
| --- | --- | ---: | ---: |
| `fillers/hedged-wheat-40-ew.png` | Hedged wheat strip, ew | 268 × 214 | 40 × 31 |
| `fillers/hedged-wheat-40-ns.png` | Hedged wheat strip, ns | 214 × 268 | 40 × 31 |
| `fillers/hedged-wheat-40-ne-sw.png` | Hedged wheat strip, ne-sw | 342 × 342 | 40 × 31 |
| `fillers/hedged-wheat-40-nw-se.png` | Hedged wheat strip, nw-se | 342 × 342 | 40 × 31 |
| `fillers/hedged-wheat-80-ew.png` | Hedged wheat strip, ew | 508 × 262 | 80 × 39 |
| `fillers/hedged-wheat-80-ns.png` | Hedged wheat strip, ns | 262 × 508 | 80 × 39 |
| `fillers/hedged-wheat-80-ne-sw.png` | Hedged wheat strip, ne-sw | 546 × 546 | 80 × 39 |
| `fillers/hedged-wheat-80-nw-se.png` | Hedged wheat strip, nw-se | 546 × 546 | 80 × 39 |
| `fillers/hedged-wheat-160-ew.png` | Hedged wheat strip, ew | 988 × 316 | 160 × 48 |
| `fillers/hedged-wheat-160-ns.png` | Hedged wheat strip, ns | 316 × 988 | 160 × 48 |
| `fillers/hedged-wheat-160-ne-sw.png` | Hedged wheat strip, ne-sw | 924 × 924 | 160 × 48 |
| `fillers/hedged-wheat-160-nw-se.png` | Hedged wheat strip, nw-se | 924 × 924 | 160 × 48 |
| `fillers/ploughed-strip-40-ew.png` | Freshly ploughed strip, ew | 268 × 214 | 40 × 31 |
| `fillers/ploughed-strip-40-ns.png` | Freshly ploughed strip, ns | 214 × 268 | 40 × 31 |
| `fillers/ploughed-strip-40-ne-sw.png` | Freshly ploughed strip, ne-sw | 342 × 342 | 40 × 31 |
| `fillers/ploughed-strip-40-nw-se.png` | Freshly ploughed strip, nw-se | 342 × 342 | 40 × 31 |
| `fillers/ploughed-strip-80-ew.png` | Freshly ploughed strip, ew | 508 × 262 | 80 × 39 |
| `fillers/ploughed-strip-80-ns.png` | Freshly ploughed strip, ns | 262 × 508 | 80 × 39 |
| `fillers/ploughed-strip-80-ne-sw.png` | Freshly ploughed strip, ne-sw | 546 × 546 | 80 × 39 |
| `fillers/ploughed-strip-80-nw-se.png` | Freshly ploughed strip, nw-se | 546 × 546 | 80 × 39 |
| `fillers/ploughed-strip-160-ew.png` | Freshly ploughed strip, ew | 988 × 316 | 160 × 48 |
| `fillers/ploughed-strip-160-ns.png` | Freshly ploughed strip, ns | 316 × 988 | 160 × 48 |
| `fillers/ploughed-strip-160-ne-sw.png` | Freshly ploughed strip, ne-sw | 924 × 924 | 160 × 48 |
| `fillers/ploughed-strip-160-nw-se.png` | Freshly ploughed strip, nw-se | 924 × 924 | 160 × 48 |
| `fillers/vegetable-allotments-40-ew.png` | Vegetable allotments, ew | 268 × 214 | 40 × 31 |
| `fillers/vegetable-allotments-40-ns.png` | Vegetable allotments, ns | 214 × 268 | 40 × 31 |
| `fillers/vegetable-allotments-40-ne-sw.png` | Vegetable allotments, ne-sw | 342 × 342 | 40 × 31 |
| `fillers/vegetable-allotments-40-nw-se.png` | Vegetable allotments, nw-se | 342 × 342 | 40 × 31 |
| `fillers/vegetable-allotments-80-ew.png` | Vegetable allotments, ew | 508 × 262 | 80 × 39 |
| `fillers/vegetable-allotments-80-ns.png` | Vegetable allotments, ns | 262 × 508 | 80 × 39 |
| `fillers/vegetable-allotments-80-ne-sw.png` | Vegetable allotments, ne-sw | 546 × 546 | 80 × 39 |
| `fillers/vegetable-allotments-80-nw-se.png` | Vegetable allotments, nw-se | 546 × 546 | 80 × 39 |
| `fillers/vegetable-allotments-160-ew.png` | Vegetable allotments, ew | 988 × 316 | 160 × 48 |
| `fillers/vegetable-allotments-160-ns.png` | Vegetable allotments, ns | 316 × 988 | 160 × 48 |
| `fillers/vegetable-allotments-160-ne-sw.png` | Vegetable allotments, ne-sw | 924 × 924 | 160 × 48 |
| `fillers/vegetable-allotments-160-nw-se.png` | Vegetable allotments, nw-se | 924 × 924 | 160 × 48 |
| `fillers/kitchen-garden-40-ew.png` | Kitchen garden with beanpoles and the shed, ew | 268 × 214 | 40 × 31 |
| `fillers/kitchen-garden-40-ns.png` | Kitchen garden with beanpoles and the shed, ns | 214 × 268 | 40 × 31 |
| `fillers/kitchen-garden-40-ne-sw.png` | Kitchen garden with beanpoles and the shed, ne-sw | 342 × 342 | 40 × 31 |
| `fillers/kitchen-garden-40-nw-se.png` | Kitchen garden with beanpoles and the shed, nw-se | 342 × 342 | 40 × 31 |
| `fillers/kitchen-garden-80-ew.png` | Kitchen garden with beanpoles and the shed, ew | 508 × 262 | 80 × 39 |
| `fillers/kitchen-garden-80-ns.png` | Kitchen garden with beanpoles and the shed, ns | 262 × 508 | 80 × 39 |
| `fillers/kitchen-garden-80-ne-sw.png` | Kitchen garden with beanpoles and the shed, ne-sw | 546 × 546 | 80 × 39 |
| `fillers/kitchen-garden-80-nw-se.png` | Kitchen garden with beanpoles and the shed, nw-se | 546 × 546 | 80 × 39 |
| `fillers/kitchen-garden-160-ew.png` | Kitchen garden with beanpoles and the shed, ew | 988 × 316 | 160 × 48 |
| `fillers/kitchen-garden-160-ns.png` | Kitchen garden with beanpoles and the shed, ns | 316 × 988 | 160 × 48 |
| `fillers/kitchen-garden-160-ne-sw.png` | Kitchen garden with beanpoles and the shed, ne-sw | 924 × 924 | 160 × 48 |
| `fillers/kitchen-garden-160-nw-se.png` | Kitchen garden with beanpoles and the shed, nw-se | 924 × 924 | 160 × 48 |
| `fillers/hay-meadow-40-ew.png` | Hay meadow with stooks, ew | 268 × 214 | 40 × 31 |
| `fillers/hay-meadow-40-ns.png` | Hay meadow with stooks, ns | 214 × 268 | 40 × 31 |
| `fillers/hay-meadow-40-ne-sw.png` | Hay meadow with stooks, ne-sw | 342 × 342 | 40 × 31 |
| `fillers/hay-meadow-40-nw-se.png` | Hay meadow with stooks, nw-se | 342 × 342 | 40 × 31 |
| `fillers/hay-meadow-80-ew.png` | Hay meadow with stooks, ew | 508 × 262 | 80 × 39 |
| `fillers/hay-meadow-80-ns.png` | Hay meadow with stooks, ns | 262 × 508 | 80 × 39 |
| `fillers/hay-meadow-80-ne-sw.png` | Hay meadow with stooks, ne-sw | 546 × 546 | 80 × 39 |
| `fillers/hay-meadow-80-nw-se.png` | Hay meadow with stooks, nw-se | 546 × 546 | 80 × 39 |
| `fillers/hay-meadow-160-ew.png` | Hay meadow with stooks, ew | 988 × 316 | 160 × 48 |
| `fillers/hay-meadow-160-ns.png` | Hay meadow with stooks, ns | 316 × 988 | 160 × 48 |
| `fillers/hay-meadow-160-ne-sw.png` | Hay meadow with stooks, ne-sw | 924 × 924 | 160 × 48 |
| `fillers/hay-meadow-160-nw-se.png` | Hay meadow with stooks, nw-se | 924 × 924 | 160 × 48 |
| `fillers/flax-strip-40-ew.png` | Blue-green flowering flax strip, ew | 268 × 214 | 40 × 31 |
| `fillers/flax-strip-40-ns.png` | Blue-green flowering flax strip, ns | 214 × 268 | 40 × 31 |
| `fillers/flax-strip-40-ne-sw.png` | Blue-green flowering flax strip, ne-sw | 342 × 342 | 40 × 31 |
| `fillers/flax-strip-40-nw-se.png` | Blue-green flowering flax strip, nw-se | 342 × 342 | 40 × 31 |
| `fillers/flax-strip-80-ew.png` | Blue-green flowering flax strip, ew | 508 × 262 | 80 × 39 |
| `fillers/flax-strip-80-ns.png` | Blue-green flowering flax strip, ns | 262 × 508 | 80 × 39 |
| `fillers/flax-strip-80-ne-sw.png` | Blue-green flowering flax strip, ne-sw | 546 × 546 | 80 × 39 |
| `fillers/flax-strip-80-nw-se.png` | Blue-green flowering flax strip, nw-se | 546 × 546 | 80 × 39 |
| `fillers/flax-strip-160-ew.png` | Blue-green flowering flax strip, ew | 988 × 316 | 160 × 48 |
| `fillers/flax-strip-160-ns.png` | Blue-green flowering flax strip, ns | 316 × 988 | 160 × 48 |
| `fillers/flax-strip-160-ne-sw.png` | Blue-green flowering flax strip, ne-sw | 924 × 924 | 160 × 48 |
| `fillers/flax-strip-160-nw-se.png` | Blue-green flowering flax strip, nw-se | 924 × 924 | 160 × 48 |
| `fillers/orchard-rows-40-ew.png` | Mixed apple and pear orchard rows, ew | 268 × 214 | 40 × 31 |
| `fillers/orchard-rows-40-ns.png` | Mixed apple and pear orchard rows, ns | 214 × 268 | 40 × 31 |
| `fillers/orchard-rows-40-ne-sw.png` | Mixed apple and pear orchard rows, ne-sw | 342 × 342 | 40 × 31 |
| `fillers/orchard-rows-40-nw-se.png` | Mixed apple and pear orchard rows, nw-se | 342 × 342 | 40 × 31 |
| `fillers/orchard-rows-80-ew.png` | Mixed apple and pear orchard rows, ew | 508 × 262 | 80 × 39 |
| `fillers/orchard-rows-80-ns.png` | Mixed apple and pear orchard rows, ns | 262 × 508 | 80 × 39 |
| `fillers/orchard-rows-80-ne-sw.png` | Mixed apple and pear orchard rows, ne-sw | 546 × 546 | 80 × 39 |
| `fillers/orchard-rows-80-nw-se.png` | Mixed apple and pear orchard rows, nw-se | 546 × 546 | 80 × 39 |
| `fillers/orchard-rows-160-ew.png` | Mixed apple and pear orchard rows, ew | 988 × 316 | 160 × 48 |
| `fillers/orchard-rows-160-ns.png` | Mixed apple and pear orchard rows, ns | 316 × 988 | 160 × 48 |
| `fillers/orchard-rows-160-ne-sw.png` | Mixed apple and pear orchard rows, ne-sw | 924 × 924 | 160 × 48 |
| `fillers/orchard-rows-160-nw-se.png` | Mixed apple and pear orchard rows, nw-se | 924 × 924 | 160 × 48 |
| `fillers/vineyard-rows-40-ew.png` | Trellised vineyard rows, ew | 268 × 214 | 40 × 31 |
| `fillers/vineyard-rows-40-ns.png` | Trellised vineyard rows, ns | 214 × 268 | 40 × 31 |
| `fillers/vineyard-rows-40-ne-sw.png` | Trellised vineyard rows, ne-sw | 342 × 342 | 40 × 31 |
| `fillers/vineyard-rows-40-nw-se.png` | Trellised vineyard rows, nw-se | 342 × 342 | 40 × 31 |
| `fillers/vineyard-rows-80-ew.png` | Trellised vineyard rows, ew | 508 × 262 | 80 × 39 |
| `fillers/vineyard-rows-80-ns.png` | Trellised vineyard rows, ns | 262 × 508 | 80 × 39 |
| `fillers/vineyard-rows-80-ne-sw.png` | Trellised vineyard rows, ne-sw | 546 × 546 | 80 × 39 |
| `fillers/vineyard-rows-80-nw-se.png` | Trellised vineyard rows, nw-se | 546 × 546 | 80 × 39 |
| `fillers/vineyard-rows-160-ew.png` | Trellised vineyard rows, ew | 988 × 316 | 160 × 48 |
| `fillers/vineyard-rows-160-ns.png` | Trellised vineyard rows, ns | 316 × 988 | 160 × 48 |
| `fillers/vineyard-rows-160-ne-sw.png` | Trellised vineyard rows, ne-sw | 924 × 924 | 160 × 48 |
| `fillers/vineyard-rows-160-nw-se.png` | Trellised vineyard rows, nw-se | 924 × 924 | 160 × 48 |
| `fillers/sheep-pasture-40-ew.png` | Sheep pasture with a timber field shelter, ew | 268 × 214 | 40 × 31 |
| `fillers/sheep-pasture-40-ns.png` | Sheep pasture with a timber field shelter, ns | 214 × 268 | 40 × 31 |
| `fillers/sheep-pasture-40-ne-sw.png` | Sheep pasture with a timber field shelter, ne-sw | 342 × 342 | 40 × 31 |
| `fillers/sheep-pasture-40-nw-se.png` | Sheep pasture with a timber field shelter, nw-se | 342 × 342 | 40 × 31 |
| `fillers/sheep-pasture-80-ew.png` | Sheep pasture with a timber field shelter, ew | 508 × 262 | 80 × 39 |
| `fillers/sheep-pasture-80-ns.png` | Sheep pasture with a timber field shelter, ns | 262 × 508 | 80 × 39 |
| `fillers/sheep-pasture-80-ne-sw.png` | Sheep pasture with a timber field shelter, ne-sw | 546 × 546 | 80 × 39 |
| `fillers/sheep-pasture-80-nw-se.png` | Sheep pasture with a timber field shelter, nw-se | 546 × 546 | 80 × 39 |
| `fillers/sheep-pasture-160-ew.png` | Sheep pasture with a timber field shelter, ew | 988 × 316 | 160 × 48 |
| `fillers/sheep-pasture-160-ns.png` | Sheep pasture with a timber field shelter, ns | 316 × 988 | 160 × 48 |
| `fillers/sheep-pasture-160-ne-sw.png` | Sheep pasture with a timber field shelter, ne-sw | 924 × 924 | 160 × 48 |
| `fillers/sheep-pasture-160-nw-se.png` | Sheep pasture with a timber field shelter, nw-se | 924 × 924 | 160 × 48 |
| `fillers/cow-pasture-40-ew.png` | Cow pasture with a low stone trough, ew | 268 × 214 | 40 × 31 |
| `fillers/cow-pasture-40-ns.png` | Cow pasture with a low stone trough, ns | 214 × 268 | 40 × 31 |
| `fillers/cow-pasture-40-ne-sw.png` | Cow pasture with a low stone trough, ne-sw | 342 × 342 | 40 × 31 |
| `fillers/cow-pasture-40-nw-se.png` | Cow pasture with a low stone trough, nw-se | 342 × 342 | 40 × 31 |
| `fillers/cow-pasture-80-ew.png` | Cow pasture with a low stone trough, ew | 508 × 262 | 80 × 39 |
| `fillers/cow-pasture-80-ns.png` | Cow pasture with a low stone trough, ns | 262 × 508 | 80 × 39 |
| `fillers/cow-pasture-80-ne-sw.png` | Cow pasture with a low stone trough, ne-sw | 546 × 546 | 80 × 39 |
| `fillers/cow-pasture-80-nw-se.png` | Cow pasture with a low stone trough, nw-se | 546 × 546 | 80 × 39 |
| `fillers/cow-pasture-160-ew.png` | Cow pasture with a low stone trough, ew | 988 × 316 | 160 × 48 |
| `fillers/cow-pasture-160-ns.png` | Cow pasture with a low stone trough, ns | 316 × 988 | 160 × 48 |
| `fillers/cow-pasture-160-ne-sw.png` | Cow pasture with a low stone trough, ne-sw | 924 × 924 | 160 × 48 |
| `fillers/cow-pasture-160-nw-se.png` | Cow pasture with a low stone trough, nw-se | 924 × 924 | 160 × 48 |
| `fillers/horse-paddock-40-ew.png` | Horse paddock with rough rails, ew | 268 × 214 | 40 × 31 |
| `fillers/horse-paddock-40-ns.png` | Horse paddock with rough rails, ns | 214 × 268 | 40 × 31 |
| `fillers/horse-paddock-40-ne-sw.png` | Horse paddock with rough rails, ne-sw | 342 × 342 | 40 × 31 |
| `fillers/horse-paddock-40-nw-se.png` | Horse paddock with rough rails, nw-se | 342 × 342 | 40 × 31 |
| `fillers/horse-paddock-80-ew.png` | Horse paddock with rough rails, ew | 508 × 262 | 80 × 39 |
| `fillers/horse-paddock-80-ns.png` | Horse paddock with rough rails, ns | 262 × 508 | 80 × 39 |
| `fillers/horse-paddock-80-ne-sw.png` | Horse paddock with rough rails, ne-sw | 546 × 546 | 80 × 39 |
| `fillers/horse-paddock-80-nw-se.png` | Horse paddock with rough rails, nw-se | 546 × 546 | 80 × 39 |
| `fillers/horse-paddock-160-ew.png` | Horse paddock with rough rails, ew | 988 × 316 | 160 × 48 |
| `fillers/horse-paddock-160-ns.png` | Horse paddock with rough rails, ns | 316 × 988 | 160 × 48 |
| `fillers/horse-paddock-160-ne-sw.png` | Horse paddock with rough rails, ne-sw | 924 × 924 | 160 × 48 |
| `fillers/horse-paddock-160-nw-se.png` | Horse paddock with rough rails, nw-se | 924 × 924 | 160 × 48 |
| `fillers/beehive-garden-40-ew.png` | Cottage garden with straw beehives, ew | 268 × 214 | 40 × 31 |
| `fillers/beehive-garden-40-ns.png` | Cottage garden with straw beehives, ns | 214 × 268 | 40 × 31 |
| `fillers/beehive-garden-40-ne-sw.png` | Cottage garden with straw beehives, ne-sw | 342 × 342 | 40 × 31 |
| `fillers/beehive-garden-40-nw-se.png` | Cottage garden with straw beehives, nw-se | 342 × 342 | 40 × 31 |
| `fillers/beehive-garden-80-ew.png` | Cottage garden with straw beehives, ew | 508 × 262 | 80 × 39 |
| `fillers/beehive-garden-80-ns.png` | Cottage garden with straw beehives, ns | 262 × 508 | 80 × 39 |
| `fillers/beehive-garden-80-ne-sw.png` | Cottage garden with straw beehives, ne-sw | 546 × 546 | 80 × 39 |
| `fillers/beehive-garden-80-nw-se.png` | Cottage garden with straw beehives, nw-se | 546 × 546 | 80 × 39 |
| `fillers/beehive-garden-160-ew.png` | Cottage garden with straw beehives, ew | 988 × 316 | 160 × 48 |
| `fillers/beehive-garden-160-ns.png` | Cottage garden with straw beehives, ns | 316 × 988 | 160 × 48 |
| `fillers/beehive-garden-160-ne-sw.png` | Cottage garden with straw beehives, ne-sw | 924 × 924 | 160 × 48 |
| `fillers/beehive-garden-160-nw-se.png` | Cottage garden with straw beehives, nw-se | 924 × 924 | 160 × 48 |
| `fillers/pond-common-40-ew.png` | Village common with an irregular pond, ew | 268 × 214 | 40 × 31 |
| `fillers/pond-common-40-ns.png` | Village common with an irregular pond, ns | 214 × 268 | 40 × 31 |
| `fillers/pond-common-40-ne-sw.png` | Village common with an irregular pond, ne-sw | 342 × 342 | 40 × 31 |
| `fillers/pond-common-40-nw-se.png` | Village common with an irregular pond, nw-se | 342 × 342 | 40 × 31 |
| `fillers/pond-common-80-ew.png` | Village common with an irregular pond, ew | 508 × 262 | 80 × 39 |
| `fillers/pond-common-80-ns.png` | Village common with an irregular pond, ns | 262 × 508 | 80 × 39 |
| `fillers/pond-common-80-ne-sw.png` | Village common with an irregular pond, ne-sw | 546 × 546 | 80 × 39 |
| `fillers/pond-common-80-nw-se.png` | Village common with an irregular pond, nw-se | 546 × 546 | 80 × 39 |
| `fillers/pond-common-160-ew.png` | Village common with an irregular pond, ew | 988 × 316 | 160 × 48 |
| `fillers/pond-common-160-ns.png` | Village common with an irregular pond, ns | 316 × 988 | 160 × 48 |
| `fillers/pond-common-160-ne-sw.png` | Village common with an irregular pond, ne-sw | 924 × 924 | 160 × 48 |
| `fillers/pond-common-160-nw-se.png` | Village common with an irregular pond, nw-se | 924 × 924 | 160 × 48 |
| `fillers/reed-osiers-40-ew.png` | Wet reed patch and clipped osiers, ew | 268 × 214 | 40 × 31 |
| `fillers/reed-osiers-40-ns.png` | Wet reed patch and clipped osiers, ns | 214 × 268 | 40 × 31 |
| `fillers/reed-osiers-40-ne-sw.png` | Wet reed patch and clipped osiers, ne-sw | 342 × 342 | 40 × 31 |
| `fillers/reed-osiers-40-nw-se.png` | Wet reed patch and clipped osiers, nw-se | 342 × 342 | 40 × 31 |
| `fillers/reed-osiers-80-ew.png` | Wet reed patch and clipped osiers, ew | 508 × 262 | 80 × 39 |
| `fillers/reed-osiers-80-ns.png` | Wet reed patch and clipped osiers, ns | 262 × 508 | 80 × 39 |
| `fillers/reed-osiers-80-ne-sw.png` | Wet reed patch and clipped osiers, ne-sw | 546 × 546 | 80 × 39 |
| `fillers/reed-osiers-80-nw-se.png` | Wet reed patch and clipped osiers, nw-se | 546 × 546 | 80 × 39 |
| `fillers/reed-osiers-160-ew.png` | Wet reed patch and clipped osiers, ew | 988 × 316 | 160 × 48 |
| `fillers/reed-osiers-160-ns.png` | Wet reed patch and clipped osiers, ns | 316 × 988 | 160 × 48 |
| `fillers/reed-osiers-160-ne-sw.png` | Wet reed patch and clipped osiers, ne-sw | 924 × 924 | 160 × 48 |
| `fillers/reed-osiers-160-nw-se.png` | Wet reed patch and clipped osiers, nw-se | 924 × 924 | 160 × 48 |
| `fillers/clearing-coppice-40-ew.png` | Coppice wood with a clearing, ew | 268 × 214 | 40 × 31 |
| `fillers/clearing-coppice-40-ns.png` | Coppice wood with a clearing, ns | 214 × 268 | 40 × 31 |
| `fillers/clearing-coppice-40-ne-sw.png` | Coppice wood with a clearing, ne-sw | 342 × 342 | 40 × 31 |
| `fillers/clearing-coppice-40-nw-se.png` | Coppice wood with a clearing, nw-se | 342 × 342 | 40 × 31 |
| `fillers/clearing-coppice-80-ew.png` | Coppice wood with a clearing, ew | 508 × 262 | 80 × 39 |
| `fillers/clearing-coppice-80-ns.png` | Coppice wood with a clearing, ns | 262 × 508 | 80 × 39 |
| `fillers/clearing-coppice-80-ne-sw.png` | Coppice wood with a clearing, ne-sw | 546 × 546 | 80 × 39 |
| `fillers/clearing-coppice-80-nw-se.png` | Coppice wood with a clearing, nw-se | 546 × 546 | 80 × 39 |
| `fillers/clearing-coppice-160-ew.png` | Coppice wood with a clearing, ew | 988 × 316 | 160 × 48 |
| `fillers/clearing-coppice-160-ns.png` | Coppice wood with a clearing, ns | 316 × 988 | 160 × 48 |
| `fillers/clearing-coppice-160-ne-sw.png` | Coppice wood with a clearing, ne-sw | 924 × 924 | 160 × 48 |
| `fillers/clearing-coppice-160-nw-se.png` | Coppice wood with a clearing, nw-se | 924 × 924 | 160 × 48 |
| `fillers/bowling-green-40-ew.png` | Bowling green in a walled grassy lot, ew | 268 × 214 | 40 × 31 |
| `fillers/bowling-green-40-ns.png` | Bowling green in a walled grassy lot, ns | 214 × 268 | 40 × 31 |
| `fillers/bowling-green-40-ne-sw.png` | Bowling green in a walled grassy lot, ne-sw | 342 × 342 | 40 × 31 |
| `fillers/bowling-green-40-nw-se.png` | Bowling green in a walled grassy lot, nw-se | 342 × 342 | 40 × 31 |
| `fillers/bowling-green-80-ew.png` | Bowling green in a walled grassy lot, ew | 508 × 262 | 80 × 39 |
| `fillers/bowling-green-80-ns.png` | Bowling green in a walled grassy lot, ns | 262 × 508 | 80 × 39 |
| `fillers/bowling-green-80-ne-sw.png` | Bowling green in a walled grassy lot, ne-sw | 546 × 546 | 80 × 39 |
| `fillers/bowling-green-80-nw-se.png` | Bowling green in a walled grassy lot, nw-se | 546 × 546 | 80 × 39 |
| `fillers/bowling-green-160-ew.png` | Bowling green in a walled grassy lot, ew | 988 × 316 | 160 × 48 |
| `fillers/bowling-green-160-ns.png` | Bowling green in a walled grassy lot, ns | 316 × 988 | 160 × 48 |
| `fillers/bowling-green-160-ne-sw.png` | Bowling green in a walled grassy lot, ne-sw | 924 × 924 | 160 × 48 |
| `fillers/bowling-green-160-nw-se.png` | Bowling green in a walled grassy lot, nw-se | 924 × 924 | 160 × 48 |
| `fillers/yew-graveyard-40-ew.png` | Enclosed graveyard with yews, ew | 268 × 214 | 40 × 31 |
| `fillers/yew-graveyard-40-ns.png` | Enclosed graveyard with yews, ns | 214 × 268 | 40 × 31 |
| `fillers/yew-graveyard-40-ne-sw.png` | Enclosed graveyard with yews, ne-sw | 342 × 342 | 40 × 31 |
| `fillers/yew-graveyard-40-nw-se.png` | Enclosed graveyard with yews, nw-se | 342 × 342 | 40 × 31 |
| `fillers/yew-graveyard-80-ew.png` | Enclosed graveyard with yews, ew | 508 × 262 | 80 × 39 |
| `fillers/yew-graveyard-80-ns.png` | Enclosed graveyard with yews, ns | 262 × 508 | 80 × 39 |
| `fillers/yew-graveyard-80-ne-sw.png` | Enclosed graveyard with yews, ne-sw | 546 × 546 | 80 × 39 |
| `fillers/yew-graveyard-80-nw-se.png` | Enclosed graveyard with yews, nw-se | 546 × 546 | 80 × 39 |
| `fillers/yew-graveyard-160-ew.png` | Enclosed graveyard with yews, ew | 988 × 316 | 160 × 48 |
| `fillers/yew-graveyard-160-ns.png` | Enclosed graveyard with yews, ns | 316 × 988 | 160 × 48 |
| `fillers/yew-graveyard-160-ne-sw.png` | Enclosed graveyard with yews, ne-sw | 924 × 924 | 160 × 48 |
| `fillers/yew-graveyard-160-nw-se.png` | Enclosed graveyard with yews, nw-se | 924 × 924 | 160 × 48 |
| `fillers/timber-yard-40-ew.png` | Timber yard with a work lean-to, ew | 268 × 214 | 40 × 31 |
| `fillers/timber-yard-40-ns.png` | Timber yard with a work lean-to, ns | 214 × 268 | 40 × 31 |
| `fillers/timber-yard-40-ne-sw.png` | Timber yard with a work lean-to, ne-sw | 342 × 342 | 40 × 31 |
| `fillers/timber-yard-40-nw-se.png` | Timber yard with a work lean-to, nw-se | 342 × 342 | 40 × 31 |
| `fillers/timber-yard-80-ew.png` | Timber yard with a work lean-to, ew | 508 × 262 | 80 × 39 |
| `fillers/timber-yard-80-ns.png` | Timber yard with a work lean-to, ns | 262 × 508 | 80 × 39 |
| `fillers/timber-yard-80-ne-sw.png` | Timber yard with a work lean-to, ne-sw | 546 × 546 | 80 × 39 |
| `fillers/timber-yard-80-nw-se.png` | Timber yard with a work lean-to, nw-se | 546 × 546 | 80 × 39 |
| `fillers/timber-yard-160-ew.png` | Timber yard with a work lean-to, ew | 988 × 316 | 160 × 48 |
| `fillers/timber-yard-160-ns.png` | Timber yard with a work lean-to, ns | 316 × 988 | 160 × 48 |
| `fillers/timber-yard-160-ne-sw.png` | Timber yard with a work lean-to, ne-sw | 924 × 924 | 160 × 48 |
| `fillers/timber-yard-160-nw-se.png` | Timber yard with a work lean-to, nw-se | 924 × 924 | 160 × 48 |
| `fillers/bleaching-field-40-ew.png` | Bleaching field with linen racks, ew | 268 × 214 | 40 × 31 |
| `fillers/bleaching-field-40-ns.png` | Bleaching field with linen racks, ns | 214 × 268 | 40 × 31 |
| `fillers/bleaching-field-40-ne-sw.png` | Bleaching field with linen racks, ne-sw | 342 × 342 | 40 × 31 |
| `fillers/bleaching-field-40-nw-se.png` | Bleaching field with linen racks, nw-se | 342 × 342 | 40 × 31 |
| `fillers/bleaching-field-80-ew.png` | Bleaching field with linen racks, ew | 508 × 262 | 80 × 39 |
| `fillers/bleaching-field-80-ns.png` | Bleaching field with linen racks, ns | 262 × 508 | 80 × 39 |
| `fillers/bleaching-field-80-ne-sw.png` | Bleaching field with linen racks, ne-sw | 546 × 546 | 80 × 39 |
| `fillers/bleaching-field-80-nw-se.png` | Bleaching field with linen racks, nw-se | 546 × 546 | 80 × 39 |
| `fillers/bleaching-field-160-ew.png` | Bleaching field with linen racks, ew | 988 × 316 | 160 × 48 |
| `fillers/bleaching-field-160-ns.png` | Bleaching field with linen racks, ns | 316 × 988 | 160 × 48 |
| `fillers/bleaching-field-160-ne-sw.png` | Bleaching field with linen racks, ne-sw | 924 × 924 | 160 × 48 |
| `fillers/bleaching-field-160-nw-se.png` | Bleaching field with linen racks, nw-se | 924 × 924 | 160 × 48 |

### Boundary joins

| File | Contents | Pixels | Ground footprint (m) |
| --- | --- | ---: | ---: |
| `fillers/block-end-hedge.png` | Hedged block end with a narrow entrance fence | 2154 × 704 | 12 × 10 |
| `fillers/block-corner-hedge.png` | Right-angle hawthorn corner | 756 × 768 | 10 × 10 |
| `fillers/block-end-rail.png` | Rail fence end with a field gate | 1760 × 574 | 12 × 10 |
| `fillers/block-corner-rail.png` | Old split-rail fence corner | 1108 × 952 | 10 × 10 |
| `fillers/block-end-wall.png` | Low stone plot end with a small break | 1369 × 956 | 12 × 10 |
| `fillers/block-corner-wall.png` | Low dry-stone right-angle corner | 1255 × 1126 | 10 × 10 |
| `fillers/block-end-ditch.png` | Ditch terminal edge with a simple foot crossing | 1443 × 781 | 12 × 10 |
| `fillers/block-corner-ditch.png` | Right-angle muddy ditch bend | 959 × 1000 | 10 × 10 |

### Trees

| File | Contents | Pixels | Ground footprint (m) |
| --- | --- | ---: | ---: |
| `scenery5/deciduous-trio-round.png` | 3 rounded deciduous crowns in a round clump | 1186 × 1076 | 24 × 19 |
| `scenery5/deciduous-trio-hook.png` | 3 rounded deciduous crowns in a hook clump | 1204 × 1218 | 24 × 15 |
| `scenery5/deciduous-five-round.png` | 5 rounded deciduous crowns in a round clump | 1292 × 1160 | 37 × 29 |
| `scenery5/deciduous-five-hook.png` | 5 rounded deciduous crowns in a hook clump | 1028 × 1088 | 37 × 23 |
| `scenery5/deciduous-eight-round.png` | 8 rounded deciduous crowns in a round clump | 1274 × 1097 | 53 × 42 |
| `scenery5/deciduous-eight-hook.png` | 8 rounded deciduous crowns in a hook clump | 1186 × 1188 | 53 × 32 |
| `scenery5/deciduous-dozen-round.png` | 12 rounded deciduous crowns in a round clump | 1367 × 1166 | 72 × 57 |
| `scenery5/deciduous-dozen-hook.png` | 12 rounded deciduous crowns in a hook clump | 1209 × 1136 | 72 × 44 |
| `scenery5/landmark-weeping-willow.png` | Weeping willow with a drooping rounded fan | 1193 × 1124 | 11 × 10 |
| `scenery5/landmark-silver-birch.png` | Silver birch with an airy broken canopy | 916 × 1242 | 9 × 8 |
| `scenery5/landmark-lombardy-poplar.png` | Tall distinct Lombardy poplar | 608 × 1515 | 6 × 6 |
| `scenery5/landmark-sweet-chestnut.png` | Ancient sweet chestnut with a low spreading crown | 1290 × 1095 | 13 × 11 |
| `scenery5/landmark-mountain-rowan.png` | Mountain rowan with divided foliage and rust berries | 1066 × 1034 | 8 × 7 |
| `scenery5/landmark-black-alder.png` | Wetland black alder with a forked crown | 949 × 1211 | 10 × 9 |
| `scenery5/pine-group-small.png` | Small mountain pine group | 1103 × 1121 | 33 × 26 |
| `scenery5/pine-group-large.png` | Large mountain pine group | 1479 × 1149 | 64 × 49 |
| `scenery5/larch-group-small.png` | Small mountain larch group | 1141 × 1139 | 33 × 26 |
| `scenery5/larch-group-large.png` | Large mountain larch group | 1498 × 1077 | 64 × 49 |
| `scenery5/tree-avenue-ew.png` | Tree-lined avenue on both sides of a clear corridor, ew | 2234 × 825 | 80 × 16 |
| `scenery5/tree-avenue-ns.png` | Tree-lined avenue on both sides of a clear corridor, ns | 801 × 1595 | 80 × 16 |
| `scenery5/tree-avenue-ne-sw.png` | Tree-lined avenue on both sides of a clear corridor, ne-sw | 1232 × 1051 | 80 × 16 |
| `scenery5/tree-avenue-nw-se.png` | Tree-lined avenue on both sides of a clear corridor, nw-se | 1275 × 1240 | 80 × 16 |
| `scenery5/hedge-standard-trees-ew.png` | Clipped hedgerow with mature standard trees, ew | 2164 × 668 | 80 × 11 |
| `scenery5/hedge-standard-trees-ns.png` | Clipped hedgerow with mature standard trees, ns | 503 × 1579 | 80 × 11 |
| `scenery5/hedge-standard-trees-ne-sw.png` | Clipped hedgerow with mature standard trees, ne-sw | 1150 × 1182 | 80 × 11 |
| `scenery5/hedge-standard-trees-nw-se.png` | Clipped hedgerow with mature standard trees, nw-se | 1173 × 1131 | 80 × 11 |

### Water, rocks and churchyard bases

| File | Contents | Pixels | Ground footprint (m) |
| --- | --- | ---: | ---: |
| `scenery5/rocky-bank-low.png` | Low rocky river edge with a moss seam | 1427 × 945 | 32 × 5 |
| `scenery5/rocky-bank-wide.png` | Wide rocky river margin with grey beds | 2163 × 667 | 53 × 10 |
| `scenery5/gravel-bar-point.png` | Pointed pale gravel bar | 1956 × 501 | 36 × 13 |
| `scenery5/gravel-bar-fan.png` | Low fan-shaped gravel and sand bar | 1350 × 949 | 49 × 21 |
| `scenery5/churchyard-small.png` | Open churchyard footing with stone walls and yews | 1447 × 1212 | 58 × 46 |
| `scenery5/churchyard-abbey.png` | Larger abbey yard base with a west-side entrance | 1433 × 1245 | 81 × 65 |
| `scenery5/crag-small.png` | small grey crag | 1004 × 1065 | 18 × 13 |
| `scenery5/crag-medium.png` | medium grey crag | 1117 × 1126 | 35 × 27 |
| `scenery5/crag-large.png` | large grey crag | 1316 × 1063 | 62 × 45 |
| `scenery5/outcrop-small.png` | small grey outcrop | 1260 × 899 | 18 × 13 |
| `scenery5/outcrop-medium.png` | medium grey outcrop | 1246 × 967 | 35 × 27 |
| `scenery5/outcrop-large.png` | large grey outcrop | 1451 × 1021 | 62 × 45 |
| `scenery5/boulder-field-small.png` | small grey boulder field | 1315 × 907 | 18 × 13 |
| `scenery5/boulder-field-medium.png` | medium grey boulder field | 1293 × 962 | 35 × 27 |
| `scenery5/boulder-field-large.png` | large grey boulder field | 1443 × 972 | 62 × 45 |
| `scenery5/quay-mooring-wide-ew.png` | Wide stone quay with mooring posts, ew | 2143 × 589 | 38 × 7 |
| `scenery5/quay-mooring-wide-ns.png` | Wide stone quay with mooring posts, ns | 526 × 1526 | 38 × 7 |
| `scenery5/quay-mooring-wide-ne-sw.png` | Wide stone quay with mooring posts, ne-sw | 1161 × 1193 | 38 × 7 |
| `scenery5/quay-mooring-wide-nw-se.png` | Wide stone quay with mooring posts, nw-se | 1193 × 1253 | 38 × 7 |
| `textures/canal-sun-sweeps.png` | Lily-pad canal with soft light sweeps and reflections | 512 × 512 | 55 × 55 |
| `textures/river-bright-current.png` | Blue-green river with bright current bands and foam | 512 × 512 | 67 × 67 |

### Base meadow tiles and transparent overlays

| File | Contents | Pixels | Ground footprint (m) |
| --- | --- | ---: | ---: |
| `scenery5/overlay-flower-drift.png` | Large diffuse flower drift | 1185 × 1080 | 76 × 54 |
| `scenery5/overlay-sunlit-grass.png` | Soft golden sunlit grass overlay | 1429 × 972 | 109 × 77 |
| `scenery5/overlay-cloud-shadow.png` | Wide soft cloud-shadow overlay | 1237 × 1095 | 126 × 89 |
| `scenery5/overlay-damp-grass.png` | Diffuse darker damp grass overlay | 1192 × 1027 | 96 × 68 |
| `textures/meadow-sunlit-gold.png` | Golden well-lit meadow with soft sun swaths | 512 × 512 | 83 × 83 |
| `textures/meadow-sunlit-copper.png` | Warm tawny green meadow with muted shade | 512 × 512 | 77 × 77 |
| `textures/meadow-sunlit-clover.png` | Warm pale green meadow with subtly broken light | 512 × 512 | 89 × 89 |
| `textures/meadow-sunlit-lowland.png` | Rich green-yellow lowland meadow with warm shade | 512 × 512 | 86 × 86 |

### Set-five previews

| File | Contents | Pixels | Ground footprint (m) |
| --- | --- | ---: | ---: |
| `set5-crop-fillers.png` | Crop strips and allotments | 918 × 4427 | — |
| `set5-orchard-pasture.png` | Orchards, vines and pasture | 918 × 3704 | — |
| `set5-commons-woods.png` | Commons, wet ground and woodland | 918 × 2981 | — |
| `set5-gardens-yards.png` | Gardens and working yards | 918 × 2981 | — |
| `set5-trees.png` | Grove, landmark and avenue trees | 1145 × 1535 | — |
| `set5-water-rock.png` | Water, quays, slopes and churchyards | 1145 × 1294 | — |
| `set5-ground-joints.png` | Sunlit ground, overlays and boundary joins | 1145 × 1053 | — |
| `set5-check.png` | Fifteen-block phone composition | 780 × 1688 | 400 × 866 |
| `set5-check-comparison.png` | Grid composition beside Manhattan target | 1020 × 1146 | — |
