# The workflow

General on purpose: it assumes no loader, no version, and none of this repository's
tooling. What each stage produces, what proves it, and **who is allowed to judge it**.

The order matters because each stage **consumes the previous one's evidence**, and
because the two expensive things — building the game, and looking at the game —
should happen as late as possible and as few times as possible.

## Who decides: the model, or the tool

This is the split that goes wrong most often, and it goes wrong in both directions.

| the model decides (taste, context, intent) | a tool decides (measurement, repetition) |
|---|---|
| which reference answers this asset — a deep-layer stone must not be sampled from a shallow-layer one | pixel statistics: palette, value range, isolated-pixel count, tiling seams |
| what belongs to one family, and what deliberately does not | listing what actually exists in a jar, a pack, a reference root |
| where the emphasis goes, and how much of the surface it may take | whether a file is a valid PNG, and whether two PNGs are byte-identical |
| names, ids, the sentence the player reads | whether an exit code matches the log's own count |
| whether it looks right, feels right, reads well | rasterising the same plan the same way twice |

**A tool must never choose the reference.** It cannot see the difference between a
deep layer and a shallow one, so it takes the first name that matches — and that one
choice is what makes a set stop looking like one mod.

**The model must never measure by eye.** "About a tenth of the pixels" is a claim a
script settles in a second.

Both halves leave evidence. A judgement is written down (`chose X, because …`): the
plan file, the reference name, the sentence. A measurement is a command and its
output. Neither one replaces the other.

## The stages

Stage 0 is the prerequisite; stages 1–7 are the seven stages of work.

| stage | produces | 什么算过（可失败） | 谁来判断 |
|---|---|---|---|
| 0 decide the target | one file naming version + loader + Java | reading **one** file answers "what is this for"; the reference version equals the build target | model writes it; a script can compare the two values |
| 1 decide what exists | ids, names, presentation | every id could be typed into the game and found; ids unique, legal, and every one has the lang key its presentation needs | model decides; a script/gate validates shape |
| 2 author the art | plan + rendered sheet | plan file **and** sheet **and** a written note of what differs from the reference; family renders side by side; measurements below the thresholds | model chooses the reference and authors the plan; the engine rasterises and measures |
| 3 write the atlas | the index of what exists and where | the scanner lists the project with the expected counts and **zero errors** | model declares; scanner judges |
| 4 generate code/assets | datagen/template output | deleting the generated tree and regenerating reproduces it byte for byte (or the generator says why not) | script |
| 5 verify behaviour in game | GameTest run + log | a green run **and** a red run from an injected fault | the game (exit code + parsed log) |
| 6 verify with eyes | screenshot + a sentence | the actual PNG read at 100%, the family side by side, the thing placed in the running game | human |
| 7 ship and port | branch/version, published artifact | new version's in-game run green, pack still loads | model + script |

## 0. Decide the target — one place, before anything else

Pick **version + loader + Java** and write it in exactly one file. Everything else
(mappings, dependency versions, pack formats, the Java API surface) is a *function*
of it.

- In a Gradle project that place is `gradle.properties` / `build.gradle` (the
  `mappings`, `minecraft`, and `java.toolchain.languageVersion` lines). The art side's
  version lives in the project's settings file, under `reference.directory` (see
  `contracts.md`). Other build systems have their own one file — find it, do not add
  a second one.
- **Guard:** if the reference directory's version and the build target disagree, say
  so, loudly. It is a silent trap: art read by one version's rules, code compiled
  against another, and no tool complains on its own.

**Acceptance:** one file answers "what version is this for". *Judge:* the model reads
it; the disagreement check is mechanical once both values are in files.

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
| code-drawn (block entity) | nothing in the pack; the game draws it — unless it has a model, which needs a UV layout (`art-direction.md`) |

The interesting decision here is not the id, it is the **family**: which of these
things are supposed to look like siblings. Write that down before drawing, not after.

**Acceptance:** a list of ids that could be typed into the game and found. *Judge:*
the model decides; a gate can validate uniqueness, legal characters, and that a lang
key exists for every id.

## 2. Author the art — through the ENGINE, against a reference of the SAME version

**Rule: you do not draw textures pixel by pixel.** You sample a reference, author a
plan, rasterise it, and look at the result. A PNG written by a hand-placed pixel loop
is **not** a delivery, even if it is the right size and looks plausible: two textures
drawn independently end up with unrelated backgrounds and palettes. Measured example:
a stone and its ore came out with completely different backgrounds because each was
drawn on its own instead of sampled from one reference.

**Precondition — check it before drawing anything.** The reference root must point at
a real game installation of the **same version** as the target. Read the project's
`mc-art.settings.json` (`reference.directory`) to find out what it points at. If it is
unset: **say so and stop** — do not "make do" with invented art. The reference decides
the rules (a 1.12.2 and a 1.18.2 model/blockstate differ, and so does the way a face is
UV-mapped), and it is where the palette comes from.

**Choosing the reference is the part only the model can do** (`art-direction.md` has
the checklist): same version, same material role, same layer, close in value and
saturation. A name that matches is not a reference that matches.

**The loop** (`$M` is the `mc-art` skill's CLI; that skill carries the full command
surface, so read it before typing — the engine's subcommands are the authority here):

```bash
# 1. SCAN — what logical names actually resolve from this root (a list, not memory)
$M list-groups --source <reference dir or jar> --filter <keyword> --limit 20
# 2. LOOK — pull the real PNGs and read them
$M list-groups --source <reference dir or jar> --extract <namespace>:<category>/<name> --to work/refs
#   3. EVIDENCE — literal pixels where precision matters; which frame of a family answers this
$M evidence --source <reference dir or jar> --name <family> --member <member>
#   4. AUTHOR a plan (your decisions) — e.g. work/stone.plan.json
$M render --plan work/stone.plan.json --out outputs/stone
#   5. LOOK at outputs/stone/sprite.png — then go back to 4 until it holds up
```

Before any of it, point the reference correctly and list candidates instead of assuming:
`art-direction.md` §2 has the checks and the three `reason`s a wrong root produces.

- Sample the project's own earlier textures too (`includeGenerated`), or new work
  drifts toward vanilla and stops looking like the set.
- **Family consistency is the point.** A stone and its ore share a background and a
  palette: render them in the same session against the same reference and compare the
  sheets side by side. If two sheets do not look like siblings, that is two bugs, not
  two styles.
- **The plan must mount the same-kind reference, not merely acknowledge it.** If a
  same-kind vanilla reference exists on disk (or under `refs/`) and the plan's
  `references` does not carry it with a role (`shape` / `material` / `pixel_style`),
  the shape is being invented — mount it, or write down why not
  (`art-direction.md` §3). `pixel_map` is for the last accent, never a replacement for
  the reference.
- **The engine measures what the eye cannot settle.** Accent share, isolated-pixel
  count, value spread, and "did the silhouette move when only the colour was asked
  to" are numbers (`art-direction.md` names the thresholds). The model reads the
  numbers and decides; the model does not produce them by eye.

**Acceptance (all three, or the stage is not done):** the plan file(s) under the
project, the rendered sheet, and a note of what differs from the reference and why —
plus every same-kind reference either mounted or its absence explained in the render
summary. A PNG with no plan beside it fails this stage by definition. *Judge:* the
model authors and looks; the engine rasterises and measures.

## 3. Write the atlas

The index that says what exists and where its files are. Add entries for entities,
biomes and structures; blocks and items are discovered from the pack itself.

**Acceptance:** the scanner lists the project, with the expected counts and **no
errors** (`atlas.scan` in the panel, or the extractor's `--list`). *Judge:* the model
declares what exists; the scanner judges the declaration.

## 4. Generate code and assets — never hand-write what can be generated

- Assets (blockstates, models, lang, recipes, loot tables) come from the atlas via
  datagen/templates.
- Java comes from **per-version templates**: registration, properties, creative tab,
  and the GameTest skeleton all differ between versions.
- Anything hand-written in the generated resource tree is a second truth and will
  drift.

**Acceptance:** deleting the generated tree and regenerating reproduces it byte for
byte (or the generator says why not). *Judge:* a script — this is a diff, not an
opinion.

## 5. Verify behaviour IN GAME

This is the stage that turns "I generated files" into "there is a mod". Use the game's
own test framework; it runs the real server and fails with a machine-readable verdict.
Full detail in `gametest.md`.

```bash
python tools/mcmod_gametest.py            # verdict: exit code = failed required tests
python tools/mcmod_gametest.py --fault    # prove the verdict can say NO
```

On a Windows box the interpreter is usually `python` or `py -3` (`python3` is often a
zero-byte Store stub that exits 9009 with no output). The check is "it really runs",
not "the name exists" — see `windows.md`.

**Acceptance:** a green run **and** a red run from an injected fault. One without the
other is decoration. *Judge:* the game — the exit code, cross-checked against the log's
own count.

## 6. Verify with eyes (the part only a human can look at)

The judge checks behaviour; it cannot check whether the thing *looks* right, how it
feels to place, or whether it collides with the other 40 mods in a pack. It also cannot
see the picture at all: read the PNG, do not trust a summary of it.

- Read the rendered sheet at 100% **and** zoomed; put the family side by side; look at
  a wall of it (tiling), not one block; look at it in the dark and in the light.
- Put the built jar into a real instance (ideally the target modpack, not a bare dev
  environment) and look at it. For a modpack environment the honest setup is a
  dedicated server built from the same mods, with this jar added.
- **Colour-only requests:** if the user asked for the colours to match, the shape must
  be pixel-identical. Check that, do not assume it.
- **The last look is a verdict, not a glance.** Before shipping, put the delivered sprite
  next to the reference the plan actually mounted and **answer three questions in
  writing** (readable? ugly? same art style as vanilla?); any "no" sends you back to the
  plan. Gates being green does not answer them — that is how three rejected versions
  shipped with every declared number in budget. Full procedure: `art-direction.md`,
  最后一眼.

**Acceptance:** a screenshot (or a live look), plus the three written answers — an
answer, not "looks fine", because "looks fine" is not a check. *Judge:* a human.

## 7. Ship and port

- One branch (or one project directory) per version. Do **not** try to make one jar
  serve several game versions; that is the loader's job, not the mod's.
- Porting = swap the templates and the version numbers, then re-run stage 5 on the new
  version. The art, the ids, the names and the design do not move.
- Multi-loader (two or more loaders from one tree) is worth it only when you actually
  need it; the usual shape is a `common` module plus one module per loader.

**Acceptance:** the new version's in-game run is green, and the pack still loads.
*Judge:* the game for behaviour, the model for "did the design survive the port".

## Rules that hold at every stage

1. **One namespace, one truth** — for any id, exactly one file says what it is.
2. **Evidence or it did not happen** — name the file, the number, the log line.
3. **Inject the fault** — before trusting a check, make it fail on purpose once.
4. **Say what was not verified** — "the icons render" is not "the mod works".
5. **Numbers that claim a meaning must be checked against their context** — an exit
   code of 1 is "1 failed test" only when tests actually ran.
6. **Do not push taste onto a tool, and do not push measurement onto the eye** — the
   two columns of the table at the top of this file.
