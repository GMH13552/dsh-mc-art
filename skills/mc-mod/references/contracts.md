# The contracts: atlas, lang, settings, pack

Three files decide everything, and each answers exactly one question. Two of them
are written by the panel; the third (`lang`) is written by whoever names things.
Confusing their roles is how an asset ends up existing but nameless, or named but
invisible.

| file | the question it answers | written by |
|---|---|---|
| `<项目>/mc-art.atlas.json` | **what exists**, and where its files are | the panel (structures/biomes), generators |
| `<项目>/pack/assets/<ns>/lang/zh_cn.json` | **what it is called** | you / a generator |
| `<项目>/mc-art.settings.json` | **what generation is allowed to look at** | the panel (⚙) |

## `mc-art.atlas.json`

```json
{
  "schema": "mc-art.atlas/1",
  "namespace": "examplemod",
  "pack": "pack",
  "entities":   [ { "id": "example_sheep", "layers": [ … ], "refs": [ … ] } ],
  "biomes":     [ { "id": "example_biome", "cells": [ { "block": "example_soil", "at": [-3, 0, -3] } ] } ],
  "structures": [ { "id": "…", "cells": [ … ] } ]
}
```

- `namespace` — the namespace every unqualified id in this project belongs to.
- `pack` — the pack directory, **relative to the project** (`pack` means
  `<项目>/pack`). Nothing else is hard-coded: this is the field that lets a project
  keep its pack wherever it likes.
- `entities[].layers[]` — one texture plus a box model (`{tex: [w,h], parts: [{name,
  pivot, rot, boxes: [{u,v,at,w,h,d}]}]}`), i.e. the classic Minecraft entity UV
  layout, authored rather than guessed.
- `biomes[].cells[]` / `structures[].cells[]` — the block grid: `{block, at:[x,y,z]}`
  and optionally `variant` (a blockstate string, e.g. a facing), which is what keeps
  a placed log from silently straightening the next time it is opened.

**Rule:** a cell may name a block without a namespace (`example_soil`); it resolves
against the project's own namespace. A qualified id (`minecraft:stone`) is taken
as written.

## `mc-art.settings.json`

```json
{
  "schema": "mc-art.settings/1",
  "reference": {
    "directory": "/mnt/c/…/versions/1.18.2-Forge_40.2.0",
    "includeGenerated": true,
    "includeMods": true,
    "mods": { "minecraft": true, "examplemod": true, … }
  }
}
```

- `reference.directory` — the **external baseline**: a `.minecraft` directory or a
  single version directory. This is the only place a version is named for the art
  side, and the engine reads the rules of *that* version.
- `includeGenerated` — also sample the project's **own** already-produced textures,
  so a new block matches what you already drew instead of drifting toward vanilla.
- `includeMods` + `mods{}` — an **opt-out** list: a mod nobody toggled counts as on,
  so a newly installed mod is visible without a visit to the panel.

The skill/CLI side reads this same file (`mc_art.project_settings.load_project_settings`)
**when it is given `--project <dir>`**. Without that flag the CLI uses only explicit
`--source` arguments — nothing is inferred. This is the one thing to say out loud
when someone asks "is the panel wired to the skill": yes, same file; and no, nothing
*pushes* a notification — the panel offers a one-click sentence instead
(see `panel.md`).

## `lang`

`pack/assets/<ns>/lang/zh_cn.json` (+ `en_us.json`). Keys the engines already look
for, in order: `block.<ns>.<id>`, `item.<ns>.<id>`, `.name` variants, a PascalCase
spelling, and the 1.12.2 `tile.*` forms. **A block item's name is a `block.` key in
1.13+** (`block.minecraft.acacia_button`), which is why asking only for `item.` left
every button nameless.

An asset with a model but no lang key still exists — it just shows its id. That is
the honest failure mode; do not invent a translation.

## The pack layout

```
<项目>/
  mc-art.atlas.json
  mc-art.settings.json          (optional; absent = documented defaults)
  pack/
    pack.mcmeta                 (pack_format differs per version)
    assets/<ns>/
      blockstates/<block>.json
      models/block/<block>.json
      models/item/<item>.json
      textures/block/<name>.png
      textures/item/<name>.png
      lang/{zh_cn,en_us}.json
```

`<项目>/pack/assets/<ns>/` **must exist** or the index skips the whole project —
that directory is what makes something "a project" at all.

## One project, one namespace

A project directory is a mod: `namespace` in `mc-art.atlas.json` is the only namespace
every unqualified id in it belongs to. Do not add a second namespace under the same
project's `pack/assets/` — a name would then have two homes, which is the exact thing the
first rule exists to prevent. The panel's create-project step enforces this (it refuses a
namespace that differs from what the directory already holds) and names the project and
the namespace the same way.

## Namespaces and parents (the part that bites)

- **An unqualified model `parent` means `minecraft:`.** `{"parent": "block/cube_all"}`
  in a project pack reaches vanilla's `block/cube_all`, *not* the project's own.
- A project pack does **not** ship the vanilla bases (`block/block`, `block/cube`,
  `block/cross`), so reading a project's models needs **two roots**: the project
  pack first (its own file wins), the game root second (it completes the vanilla
  half). One root is how every project item came back with no icon at all.
- `block/block` is where `display.gui` (the GUI rotation) and `gui_light` live. That
  is what a block item's icon is drawn with.

## Where the truth lives for textures

- The **resource pack** is the single truth for what a texture looks like.
- A mod project's `src/main/resources/assets/<ns>/…` is a **generated** copy
  (datagen from the atlas) and must not be hand-edited: two copies of one namespace
  are two futures.
