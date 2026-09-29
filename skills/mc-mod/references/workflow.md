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

## 2. Author the art — against a reference root of the SAME version

Use the `mc-art` skill. The engine is deterministic: you write a plan, it rasterises,
you measure. Iterate at seconds per attempt rather than minutes per game launch.

- The reference root decides the rules (1.12.2 and 1.18.2 differ in model and
  blockstate shape, and in how a face is UV-mapped).
- Sample the project's own earlier textures too (`includeGenerated`), or new work
  drifts toward vanilla and stops looking like the set.

**Acceptance:** the rendered sheet next to the reference it was sampled from, plus a
note of what differs and why.

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
python3 tools/mcmod_gametest.py            # verdict: exit code = failed required tests
python3 tools/mcmod_gametest.py --fault    # prove the verdict can say NO
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
