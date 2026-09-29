---
name: mc-mod
description: Use when making or extending a Minecraft mod — blocks, items, entities, biomes, structures, recipes, lang, the resource pack, the Java project, or the GameTest verification loop. Covers the atlas/lang/settings contracts, the panel that edits a project's atlas, the panel's manual (what each control writes), a general mod-making workflow that is not tied to one loader, a version matrix that says what can be VERIFIED per target version, and the GameTestServer loop with the traps that were actually hit while building it.
---

# Minecraft Mod Studio

`mc-art` is the **art** half (pixels, models, renders). This is the **mod** half:
the project's contracts, the panel that edits them, the order to do things in, and
— the part that matters most — **how a mod's claims get checked by the game itself**.

Two rules run through everything here:

1. **One namespace, one truth.** For a given asset id there is exactly one file
   that says what it is. A texture in two places is two futures that will drift.
2. **A check that cannot fail is not a check.** Every "it works" here names the
   evidence and, where it exists, the fault injection that proves the evidence
   can say NO.

## What is in this skill

| file | what it answers |
|---|---|
| `references/panel.md` | the panel (the `mcart` plugin): every control, what it writes, what it refuses |
| `references/contracts.md` | `mc-art.atlas.json`, `mc-art.settings.json`, the pack layout, and who reads what |
| `references/workflow.md` | the general order of work, stage by stage, with the acceptance test for each stage |
| `references/versions.md` | the version matrix, what changes per version, and how to find out rather than guess |
| `references/gametest.md` | the verification loop: exact commands, exit-code semantics, templates, the traps |
| `references/traps.md` | the catalogue of things that silently go wrong, each with its evidence |

## The general workflow (detail in `references/workflow.md`)

```
0. Decide the target          version + loader + java, ONE place, before anything else
1. Decide what exists         ids, names (zh/en), the presentation of each: block / item / entity / structure / biome
2. Author the art             with the mc-art skill, against a reference root of the SAME version
3. Write the atlas            the index that says what exists and where its files are
4. Generate the code/assets   datagen or templates — never hand-write what can be generated
5. Verify behaviour IN GAME   GameTestServer: it runs, it asserts, it exits with the failure count
6. Verify the pack in game    client, real modpack (the part only a human can look at)
7. Ship and port              one branch per version; porting = swap templates + version numbers
```

Stages 0–4 are mechanical. Stage 5 is what separates "I generated some files" from
"there is a mod". Stage 6 is the only one that needs eyes.

## What can be verified, per target version

**GameTest is the judge, and it does not exist on every version.** Say this out
loud before promising a pipeline for an old target:

| target | art | code | behaviour verified by the game |
|---|---|---|---|
| 1.12.2 and older | ✅ (its own rules) | ✅ (Java 8, different API) | ❌ no GameTest — only "it compiles, the server starts, the log is clean" |
| 1.17 — 1.18.1 | ✅ | ✅ | ⚠️ GameTest exists; Forge needs **39.0.88+** |
| **1.18.2** (verified in this workspace) | ✅ | ✅ Java 17 | ✅ `GameTestServer`, exit code = failed required tests |
| 1.19.x — 1.20.x | ✅ | ✅ | ✅ (creative tabs became a registry — see `versions.md`) |
| 1.20.5+ / 1.21.x | ✅ | ✅ Java 21 | ✅, but the largest API break so far — port by template, not by memory |

Full table, what changes per version, and the method for finding out instead of
guessing: `references/versions.md`.

## The panel, in one paragraph

The `mcart` panel is a Cordis plugin in this deployment. It shows a project's
assets (menus for 群系/结构/实体/方块), renders the block/entity model in a 3D view
with a game-style **hotbar of the project's items along the bottom** (the 2D form
is drawn *in* the viewport when there is no model to show), lets you browse the
reference (vanilla + every mod) by item form and family, edit a texture in place
(pencil / fill / picker / eraser), edit a structure or biome cell by cell, and
point the reference directory at a game version. It writes exactly three things:
`atlas.saveTexture`, `atlas.saveVoxel`, `atlas.saveSettings` — and only ever into
the **project's own pack**, never into a jar. Full manual: `references/panel.md`.

## Running the judge

```bash
# from a mod project (see references/gametest.md for what the project must contain)
python3 tools/mcmod_gametest.py                 # verdict: exit code + parsed log
python3 tools/mcmod_gametest.py --fault         # inject a false assertion; it MUST fail
```

Measured in this workspace on 1.18.2 / Forge 40.2.0: a clean run says
`All 2 required tests passed :)` and exits 0; with `--fault` the server reports
`fleshblockplaces failed! <message> at x,y,z` and `1 required tests failed :(`,
exit code 1. First build ~26 min (downloads), every run after that ~1 min.

## The traps (each one cost a run — `references/traps.md`)

- **`error: null` is not an error.** Flat items set it on purpose.
- **An unqualified model `parent` means `minecraft:`.** A project pack does not
  ship the vanilla bases, so a project asset needs **two roots**: its own pack, then
  the game root.
- **An item model that points at geometry with no `display.gui`** (a `block/cross`)
  is drawn flat-on and split down the middle — *in the game too*. Vanilla puts
  `item/generated` in front of the texture for exactly this reason.
- **`builtin/*` is code, not a file.** `item/generated` parents to
  `builtin/generated`, which is in no pack, no jar and no mod — never report it as
  "missing".
- **A flat icon may not depend on a live `<img>`.** The panel drops those once the
  pixels are decoded; a sprite icon that pastes the element goes blank.
- **A canvas box is not its picture.** With `object-fit:contain` (or a
  `max-height`) the drawn rectangle is smaller and centred; map clicks through the
  *drawn* rect, or every click lands on the wrong pixel.
- **`forceExit` defaults to true and erases the verdict.** See `gametest.md`.
- **`tasks.named('runGameTestServer')` fails at configuration time**: ForgeGradle
  creates those tasks after the `minecraft { runs { … } }` block.
