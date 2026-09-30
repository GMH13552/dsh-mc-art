# The workflow

General on purpose: it does not assume a loader, a version, or our tooling. What
each stage produces, what proves it, and what to do when it is wrong.

The order matters because each stage **consumes the previous one's evidence**, and
because the two expensive things — building the game, and looking at the game —
should happen as late as possible and as few times as possible.

## 0. Decide the target — one place, before anything else

Pick **version + loader + Java** and write it in exactly one file. Everything else
(mappings, dependency versions, pack formats, the Java API surface) is a *function*
of it.

- In this workspace that place is the mod project's `gradle.properties` /
  `build.gradle`, and the art side's version lives in
  `mc-art.settings.json → reference.directory`.
- **Guard:** if the reference directory's version and the build target disagree,
  say so. It is a silent trap: art read by one version's rules, code compiled
  against another, and no tool complains.

**Acceptance:** you can answer "what version is this for" by reading one file.

## 1. Decide what exists

Ids, names (zh + en), and the **presentation** of each thing — because presentation
decides which files are needed at all:

| presentation | needs |
|---|---|
| block | `blockstates/` + `models/block/` + a `block.` lang key |
| item | `models/item/` + an `item.` lang key |
| block + item | both, and **the block id and the item id must match** |
| entity | a texture + an entity model (UV layout) |
| structure / biome | an atlas entry with `cells` |
| code-drawn (block entity) | nothing in the pack; the game draws it |

**Acceptance:** a list of ids that could be typed into the game and found.

## 2. Author the art — through the ENGINE, against a reference root of the SAME version

**Rule: you do not draw textures.** You sample a reference, author a plan, rasterise it, and
look at the result. A PNG written by `PIL`/`numpy`/a hand-placed pixel loop is **not a
delivery**, even if it is 16×16 and looks plausible: two textures drawn independently end up
with unrelated backgrounds and palettes. Measured example: a stone and its ore came out with
completely different backgrounds because each was drawn on its own instead of sampled from one
reference.

**Precondition — check it before drawing anything.** The reference root must point at a real
game installation of the **same version** as the target. Read `<项目>/mc-art.settings.json`
(`reference.directory`) or ask the panel (⚙ 设置 → 参考目录). If it is unset: **say so and
stop** — do not "make do" with invented art. The reference decides the rules (1.12.2 vs 1.18.2
differ in model/blockstate shape and in how a face is UV-mapped), and it is where the palette
comes from.

**The loop** (`$M` is the `mc-art` skill's CLI; the skill carries the full command surface):

```bash
$M index-vanilla --root <参考目录>          # 1. SCAN — what logical names exist
$M evidence <name>                          # 2. LOOK — pull the real PNGs and read them
#   3. EVIDENCE — literal pixels where precision matters; which frame of a family answers this
#   4. AUTHOR a plan (your decisions) — e.g. work/stone.plan.json
$M render --plan work/stone.plan.json --out outputs/stone
#   5. LOOK at outputs/stone/sprite.png — then go back to 4 until it holds up
```

- Sample the project's own earlier textures too (`includeGenerated`), or new work drifts toward
  vanilla and stops looking like the set.
- **Family consistency is the point.** A stone and its ore share a background and a palette:
  render them in the same session against the same reference and compare the sheets side by
  side. If two sheets do not look like siblings, that is two bugs, not two styles.

**Acceptance (all three, or the stage is not done):** the plan file(s) under the project, the
rendered sheet (`outputs/<name>/sprite.png`), and a note of what differs from the reference and
why. A PNG with no plan beside it fails this stage by definition.

## 3. Write the atlas

The index that says what exists and where its files are. Add entries for entities,
biomes and structures; blocks and items are discovered from the pack itself.

**Acceptance:** the scanner lists the project, with the expected counts and **no
errors**. (`atlas.scan` in the panel, or the extractor's `--list`.)

## 4. Generate code and assets — never hand-write what can be generated

- Assets (blockstates, models, lang, recipes, loot tables) come from the atlas via
  datagen/templates.
- Java comes from **per-version templates**: registration, properties, creative tab,
  and the GameTest skeleton all differ between versions.
- Anything hand-written in `src/main/resources` is a second truth and will drift.

**Acceptance:** deleting the generated tree and regenerating reproduces it byte for
byte (or the generator says why not).

## 5. Verify behaviour IN GAME

This is the stage that turns "I generated files" into "there is a mod". Use the
game's own test framework; it runs the real server and fails with a machine-readable
verdict. Full detail in `gametest.md`.

```bash
python tools/mcmod_gametest.py            # verdict: exit code = failed required tests
python tools/mcmod_gametest.py --fault    # prove the verdict can say NO
```

**Acceptance:** a green run **and** a red run from an injected fault. One without the
other is decoration.

## 6. Verify the pack in the game (the part only a human can look at)

The judge checks behaviour; it cannot check whether the thing *looks* right, how it
feels to place, or whether it collides with the other 40 mods in a pack.

- Put the built jar into a real instance (ideally the target modpack, not a bare
  dev environment) and look at it.
- For a modpack environment, the honest setup is a dedicated server built from the
  same mods, with our jar added.

**Acceptance:** a screenshot (or a live look) and a sentence about what is wrong with
it — written down, because "looks fine" is not a check.

## 7. Ship and port

- One branch (or one project) per version. Do **not** try to make one jar serve
  several game versions; that is the loader's job, not the mod's.
- Porting = swap the templates and the version numbers, then re-run stage 5 on the
  new version. The art, the ids, the names and the design do not move.
- Multi-loader (Forge + Fabric + NeoForge from one tree) is worth it only when you
  actually need it; the usual shape is a `common` module plus one module per loader.

**Acceptance:** the new version's GameTest run is green, and the pack still loads.

## Rules that hold at every stage

1. **One namespace, one truth** — for any id, exactly one file says what it is.
2. **Evidence or it did not happen** — name the file, the number, the log line.
3. **Inject the fault** — before trusting a check, make it fail on purpose once.
4. **Say what was not verified** — "the icons render" is not "the mod works".
5. **Numbers that claim a meaning must be checked against their context** — an exit
   code of 1 is "1 failed test" only when tests actually ran.
