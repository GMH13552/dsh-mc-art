---
name: mc-mod
description: Use when making or extending a Minecraft mod — blocks, items, entities, biomes, structures, recipes, lang, the resource pack, the Java project, or the in-game verification loop. Covers the atlas/lang/settings contracts, the panel that edits a project's atlas, a general workflow (stage 0–7) that names what the model must judge and what a tool must measure, a version matrix with the method for finding facts instead of guessing, Windows-native notes, and the GameTestServer loop with the traps that were actually hit while building it.
---

# Minecraft Mod Studio

`mc-art` is the **art** half (pixels, models, renders). This is the **mod** half:
the project's contracts, the panel that edits them, the order to do things in, and
— the part that matters most — **how a mod's claims get checked by the game itself**.

Nothing here is tied to one loader, one game version, one machine, or one project.
Where a fact depends on the target (mappings, Java level, pack format, whether the game
even has a test framework), the skill says **how to find it out** rather than blessing a
remembered number.

Three rules run through everything here:

1. **One namespace, one truth** — and **one mod, one namespace.** A project is a mod;
   it owns exactly one namespace, and nothing may grow a second one inside it. For a
   given asset id there is exactly one file that says what it is. A texture in two
   places is two futures that will drift.
2. **A check that cannot fail is not a check.** Every "it works" here names the
   evidence and, where it exists, the fault injection that proves the evidence can say
   NO.
3. **Art goes through the engine — a hand-written PNG is not a delivery.** Textures
   come from the `mc-art` loop (sample the reference → author a plan → rasterise →
   **look at the result**), never from hand-placed pixels. Not style policing: two
   textures drawn independently end up with unrelated backgrounds and palettes, which
   is exactly how a set stops looking like one mod. Evidence the loop ran: the plan
   file, the rendered sheet, and the comparison against the reference.

## Who decides what (the shortest version of the most important part)

| the model judges (taste, context, intent) | a tool judges (measurement, repetition) |
|---|---|
| which reference answers this asset — a deep-layer stone must not be sampled from a shallow-layer one | pixel statistics: palette, value range, isolated-pixel count, tiling seams |
| what belongs to one family, and what deliberately does not | what actually exists in a jar, a pack, a reference root |
| where the emphasis goes, and how much surface it may take | whether a file is a valid PNG; whether two PNGs are byte-identical |
| names, ids, the sentence the player reads | whether an exit code matches the log's own count |
| whether it looks right, feels right, reads well | rasterising the same plan the same way twice |

Pushing taste onto a tool is how a set stops looking like one mod (the tool takes the
first name that matches). Pushing measurement onto the eye is how "about a tenth of the
pixels" becomes a false claim. Every stage in `references/workflow.md` names which side
owns it and what counts as passing.

## What is in this skill

| file | what it answers |
|---|---|
| `references/panel.md` | the panel: every control, what it writes, what it refuses |
| `references/contracts.md` | `mc-art.atlas.json`, `mc-art.settings.json`, the pack layout, and who reads what |
| `references/workflow.md` | the general order of work, stage by stage, with "what passes" and "who judges" for each |
| `references/art-direction.md` | the decisions a tool cannot make: pointing the reference root, reference choice, bands not speckles, accent budget, family boundary, UV |
| `references/versions.md` | the version matrix, what changes per version, and how to find out rather than guess |
| `references/gametest.md` | the verification loop: exact commands, exit-code semantics, templates, the traps |
| `references/windows.md` | native Windows: shell, `python` vs `python3`, JDK, line endings, encoding, paths |
| `references/traps.md` | the catalogue of things that silently go wrong, each with its evidence |

## The general workflow (stage 0–7; 0 is the prerequisite, 1–7 are the seven stages)

```
0. Decide the target          version + loader + java, ONE place, before anything else
1. Decide what exists         ids, names (zh/en), the presentation of each
2. Author the art             through the mc-art ENGINE (plan → rasterise → look),
                              against a reference of the SAME version — never hand-draw
3. Write the atlas            the index that says what exists and where its files are
4. Generate the code/assets   datagen or templates — never hand-write what can be generated
5. Verify behaviour IN GAME   the game's own test server: it runs, asserts, exits with the failure count
6. Verify with eyes           a real instance; the part only a human can look at
7. Ship and port              one branch per version; porting = swap templates + version numbers
```

Stage 0–4 are mechanical (a tool can check most of them). Stage 5 is what separates
"I generated some files" from "there is a mod". Stage 6 is the only one where a picture
is actually looked at. Per-stage acceptance and ownership: `references/workflow.md`.

## What can be verified, per target version

**The in-game judge does not exist on every version.** Say this out loud before
promising a pipeline for an old target:

| target | art | code | behaviour verified by the game |
|---|---|---|---|
| 1.12.2 and older | ✅ (its own rules) | ✅ (Java 8, different API) | ❌ no GameTest — only "it compiles, the server starts, the log is clean" |
| 1.17 – 1.18.1 | ✅ | ✅ | ⚠️ GameTest exists; on Forge it needs **39.0.88+** |
| 1.18.2 (measured once on one machine) | ✅ | ✅ Java 17 | ✅ `GameTestServer`, exit code = failed required tests |
| 1.19.x – 1.20.x | ✅ | ✅ | ✅ (creative tabs became a registry — see `versions.md`) |
| 1.20.5+ / 1.21.x | ✅ | ✅ Java 21 | ✅, but the largest API break of the era — port by template, not by memory |

Treat the rows as *categories of change*, not as facts to trust: the exact numbers for
the version in front of you come from that version's own files. Full table, what
changes, and the method for **finding out instead of guessing**
(`version.json` in the client jar, `javap` on the mapped jar, and the compiler as a
13-second judge): `references/versions.md`.

## The panel, in one paragraph

The panel is a Cordis plugin. It shows a project's assets (menus for
群系/结构/实体/方块), renders the block/entity model in a 3D view with a game-style
**hotbar of the project's items along the bottom** (the 2D form is drawn *in* the
viewport when there is no model to show), lets you browse the reference (vanilla + every
mod) by item form and family, edit a texture in place (pencil / fill / picker / eraser),
edit a structure or biome cell by cell, and point the reference directory at a game
version. It writes exactly three things: `atlas.saveTexture`, `atlas.saveVoxel`,
`atlas.saveSettings` — and only ever into the **project's own pack**, never into a jar.
Full manual: `references/panel.md`.

**The reference directory is art-only.** It is read by the mc-art engine to show
vanilla/mod textures and models for style matching; the build loop never reads it, and
setting it does not replace the build tool's own asset download. Where the setting
lives, which file to read to find out what it points at, and which shapes are actually
readable: `references/panel.md` and `references/art-direction.md` §2.

If the panel ships as an installed package, verify **delivery** and not just
installation: the client bundle must register under the package name, or the page
silently shows `Failed to load plugins` while every offline check stays green — recipe
and the one-command check in `references/panel.md`.

## Running the judge

```bash
# 0) First ask "can this JVM write a jar?" — it saves one very long first build
python scripts/check_jdk.py                    # exit 3 = no usable JDK on this machine
# from a mod project (see references/gametest.md for what the project must contain)
python tools/mcmod_gametest.py                 # verdict: exit code + parsed log
python tools/mcmod_gametest.py --fault         # inject a false assertion; it MUST fail
```

On Windows the interpreter is usually `python` or `py -3`; `python3` is often a zero-byte
Store stub. The only honest probe is running it once (`windows.md`).

**Step 0 is not optional, and it is not about the version string.** `jdk.zipfs` decides
whether a jar is writable with `Files.isWritable()`, and a JVM started from a game's own
bundled runtime runs at low mandatory integrity — where that call returns false even for
a file the JVM just wrote. The access-transformer step then dies with
`ReadOnlyFileSystemException` and leaves a 22-byte empty jar. `scripts/check_jdk.py`
starts each candidate and makes it write a file and a zip
(`scripts/JvmWriteSelfTest.java`), so the answer comes from the JVM you are actually
about to build with. Full trap: `gametest.md`.

Measured once on 1.18.2 / Forge 40.2.0, on one machine: a clean run says
`All 2 required tests passed :)` and exits 0; with `--fault` the server reports
`exampleblockplaces failed! <message> at x,y,z` and `1 required tests failed :(`,
exit code 1. First build ~26 min (downloads), every run after that ~1 min — budget for
the first one and do not read it as a failure.

## The traps (each one cost a run — `references/traps.md`)

- **`error: null` is not an error.** Flat items set it on purpose.
- **An unqualified model `parent` means `minecraft:`.** A project pack does not ship the
  vanilla bases, so a project asset needs **two roots**: its own pack, then the game root.
- **An item model that points at geometry with no `display.gui`** (a `block/cross`) is
  drawn flat-on and split down the middle — *in the game too*. Vanilla puts
  `item/generated` in front of the texture for exactly this reason.
- **`builtin/*` is code, not a file.** `item/generated` parents to `builtin/generated`,
  which is in no pack, no jar and no mod — never report it as "missing".
- **A flat icon may not depend on a live `<img>`.** The panel drops those once the
  pixels are decoded; a sprite icon that pastes the element goes blank.
- **A canvas box is not its picture.** With `object-fit:contain` (or a `max-height`) the
  drawn rectangle is smaller and centred; map clicks through the *drawn* rect, or every
  click lands on the wrong pixel.
- **`forceExit` defaults to true and erases the verdict.** See `gametest.md`.
- **`tasks.named('runGameTestServer')` fails at configuration time**: the build plugin
  creates those tasks after the `minecraft { runs { … } }` block.
- **A reference that matches by name is not a reference that matches.** See
  `art-direction.md` before sampling anything.
