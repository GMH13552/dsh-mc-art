#!/usr/bin/env python3
"""Emit each project's asset graph, and its display dictionary, as TWO files.

    <project>/mc-art.atlas.json                  structure only.  ASCII.
    <project>/pack/assets/<ns>/lang/zh_cn.json   display only.  Exactly what
                                                 Minecraft itself loads.

Why the split: the atlas is machine data, and the name a player sees has to come
from the same file the game reads.  Baking Chinese into the atlas would let the
viewer show a name the mod does not actually have -- the viewer would be lying
about the game.  So the atlas says *what exists*, the lang file says *what it is
called*, and the viewer resolves through the lang file, falling back to the id
exactly as the game falls back to the translation key.

The entity model specs come from a renderer that lives OUTSIDE this repository
(`render_entity_model.py`); point `MCART_RENDER_TOOLS` at the directory holding
it, or drop it in `vanilla3d/tools/`.  **No model number is typed here** -- and
when the renderer is not on this machine the tool SKIPs with a loud line instead
of failing, because "the renderer is not checked out here" is a machine fact,
not a defect in this code.  A project whose `<project>/pack/assets/<ns>` is not
present is skipped the same way.

    python tools/emit_atlas.py            # write both artifacts
    python tools/emit_atlas.py --check    # exit 1 when either is stale

Every name here is a neutral placeholder (`example_*` / `示例*`): this repository
is public, and the example projects it renders must not carry anybody's private
mod vocabulary.
"""

import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RENDER_TOOLS = os.environ.get("MCART_RENDER_TOOLS") or os.path.join(ROOT, "vanilla3d", "tools")
sys.path.insert(0, RENDER_TOOLS)

try:
    import render_entity_model as em  # noqa: E402  (path set up above)
except ImportError:
    em = None

SCHEMA = "mc-art.atlas/1"


# ---------------------------------------------------------------------------
# display names
#
# Keys are the lang keys Minecraft itself resolves, so blocks / items / entities
# and biomes read exactly what the game would show.  Structures and the project
# title have no in-game concept, so they live under a clearly-marked `mc-art.`
# prefix -- the viewer's own vocabulary, not a pretend game key.
#
# The wording follows the project's own plans where a plan names the block
# (`request.query` opens with the Chinese name); the rest are filled in here.
# ---------------------------------------------------------------------------

DISPLAY = {
    "examplemod": {
        "project": "Example Land",
        "block": {
            "example_block": "示例块",
            "example_grass": "示例草皮",
            "example_soil": "示例泥土",
            "example_stone": "示例石",
            "example_wool": "示例羊毛",
            "example_vein_block": "示例脉络块",
            "example_orb_block": "示例珠块",
            "example_gel_block": "示例凝块",
            "example_bone_block": "示例骨块",
            "example_crystal_ore": "示例晶矿石",
            "example_sprout": "示例芽",
            "example_sac": "示例囊",
            "example_tendril": "示例触须",
        },
        "item": {"example_crystal": "示例晶"},
        "entity": {"example_sheep": "示例羊", "example_slime": "示例史莱姆"},
        "biome": {"examplemod": "Example Land"},
    },
    "exampletree": {
        "project": "示例树",
        "block": {
            "example_log": "示例原木",
            "example_stripped_log": "去皮示例原木",
            "example_planks": "示例木板",
            "example_leaves": "示例树叶",
            "example_sapling": "示例树苗",
        },
        "structure": {"example_tree": "示例树"},
    },
}


def lang_entries(namespace):
    """The flat lang dictionary for one namespace, game keys first."""
    table = DISPLAY.get(namespace, {})
    out = {}
    for kind in ("block", "item", "entity", "biome"):
        for name, text in sorted(table.get(kind, {}).items()):
            out[kind + "." + namespace + "." + name] = text
    for name, text in sorted(table.get("structure", {}).items()):
        out["mc-art.structure." + namespace + "." + name] = text
    if "project" in table:
        out["mc-art.project." + namespace] = table["project"]
    return out


def namespace_of(project):
    """The single namespace directory inside a project's resource pack."""
    assets = os.path.join(ROOT, project, "pack", "assets")
    if not os.path.isdir(assets):
        return None
    names = sorted(
        name for name in os.listdir(assets)
        if os.path.isdir(os.path.join(assets, name))
    )
    return names[0] if len(names) == 1 else None


def model_of(spec):
    """The renderer's own dict, minus the field the atlas carries separately."""
    return {
        "tex": list(spec["tex"]),
        "parts": [
            {
                "name": part["name"],
                "pivot": list(part["pivot"]),
                "rot": dict(part.get("rot", {})),
                "boxes": [dict(box) for box in part["boxes"]],
            }
            for part in spec["parts"]
        ],
    }


# ---------------------------------------------------------------------------
# cells: the declarative scenes.  World coordinates, one cell = one block.
# ---------------------------------------------------------------------------

def examplemod_biome_cells():
    """A 7x7 patch of the Example Land: mostly grass, worn soil, bare stone.

    The ground goes into a coordinate map first so an ore can REPLACE the ground
    it sits in.  Appending it at the same `at` instead puts two blocks in one
    cell, and the depth test then hides whichever loses the tie -- which is
    exactly how the crystal vein went missing from the render while the palette
    still counted it.
    """
    ground = {}
    for x in range(-3, 4):
        for z in range(-3, 4):
            block = "example_grass"
            if (x + z) % 3 == 0:
                block = "example_soil"
            if (x * 3 + z * 5) % 11 == 0:
                block = "example_stone"
            ground[(x, z)] = block
    ground[(2, -2)] = "example_crystal_ore"      # a vein is IN the ground
    cells = [
        {"block": block, "at": [x, 0, z]}
        for (x, z), block in sorted(ground.items())
    ]
    # growths stand ON the ground, one level up -- never inside it
    cells += [
        {"block": "example_sprout", "at": [1, 1, -1]},
        {"block": "example_tendril", "at": [-2, 1, 1]},
        {"block": "example_sac", "at": [2, 1, 2]},
        {"block": "example_orb_block", "at": [-3, 1, -3]},
    ]
    return cells


def example_tree_cells(offset=(0, 0, 0)):
    """The example tree: four logs of trunk, a layered canopy.  Cross-namespace
    by design -- it is built out of `exampletree:*` blocks wherever it stands."""
    ox, oy, oz = offset
    cells = [
        {"block": "exampletree:example_log", "at": [ox, oy + y, oz]}
        for y in range(4)
    ]
    for x in range(-1, 2):
        for z in range(-1, 2):
            cells.append({"block": "exampletree:example_leaves",
                          "at": [ox + x, oy + 4, oz + z]})
    for x, z in ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)):
        cells.append({"block": "exampletree:example_leaves",
                      "at": [ox + x, oy + 5, oz + z]})
    cells.append({"block": "exampletree:example_leaves", "at": [ox, oy + 6, oz]})
    return cells


# ---------------------------------------------------------------------------

def examplemod_atlas(namespace):
    return {
        "schema": SCHEMA,
        "namespace": namespace,
        "pack": "pack",
        "entities": [
            {
                "id": "example_sheep",
                "layers": [
                    {"texture": "entity/example_sheep.png", "mode": "opaque",
                     "model": model_of(em.sheep_skin())},
                    {"texture": "entity/example_sheep_wool.png", "mode": "blend",
                     "model": model_of(em.sheep_wool())},
                ],
                "refs": ["plans/example_sheep.plan.json",
                         "plans/example_sheep_wool.plan.json",
                         "tools/build_sheep_shared.py"],
            },
            {
                "id": "example_slime",
                "layers": [
                    {"texture": "entity/example_slime.png", "mode": "opaque",
                     "model": model_of(em.slime_core())},
                    {"texture": "entity/example_slime.png", "mode": "blend",
                     "model": model_of(em.slime_shell())},
                ],
                "refs": ["plans/example_slime.plan.json", "tools/build_slime.py"],
            },
        ],
        "biomes": [
            {"id": "examplemod",
             "cells": examplemod_biome_cells(),
             "refs": ["tools/build_example.py", "tools/render_ensemble.py"]},
        ],
        # No `structures` key at all, on purpose.  The example tree belongs to
        # the `exampletree` project, which already declares it; a second copy in
        # this project's atlas was an invention, and the project owner removed
        # it -- key included.  Keep the generator agreeing with that decision.
    }


def example_tree_atlas(namespace):
    return {
        "schema": SCHEMA,
        "namespace": namespace,
        "pack": "pack",
        "entities": [],
        "biomes": [],
        "structures": [
            {"id": "example_tree",
             "cells": example_tree_cells(),
             "refs": ["tools/build_plans.py", "SUMMARY.md"]},
        ],
    }


PROJECTS = {
    "examplemod": examplemod_atlas,
    "example_tree": example_tree_atlas,
}


def dump(payload):
    return json.dumps(payload, indent=2, ensure_ascii=False) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true",
                        help="do not write; exit 1 when a file is missing or stale")
    args = parser.parse_args()

    if em is None:
        print("SKIP 渲染模块不在本机（找的是 %s）；设 MCART_RENDER_TOOLS 指向它所在的目录。"
              % RENDER_TOOLS)
        print("     这一条与机器有关，不是代码缺陷 —— 所以 SKIP 而不是红。")
        return 0

    stale = []
    for project, build in PROJECTS.items():
        namespace = namespace_of(project)
        if namespace is None:
            print("SKIP %s：本机没有 <repo>/%s/pack/assets/<命名空间>（没 checkout 就不算它）"
                  % (project, project))
            continue

        atlas_text = dump(build(namespace))
        # A non-ASCII byte in the atlas is a mistake now, not a style choice.
        if not atlas_text.isascii():
            print("!! %s: atlas has non-ASCII; display names belong in the lang file"
                  % project)
            return 2

        targets = [
            (os.path.join(ROOT, project, "mc-art.atlas.json"), atlas_text),
            (os.path.join(ROOT, project, "pack", "assets", namespace, "lang",
                          "zh_cn.json"), dump(lang_entries(namespace))),
        ]
        for path, text in targets:
            current = None
            if os.path.exists(path):
                with open(path, encoding="utf-8") as handle:
                    current = handle.read()
            if current == text:
                print("ok    %s" % os.path.relpath(path, ROOT))
                continue
            stale.append(path)
            if args.check:
                print("stale %s" % os.path.relpath(path, ROOT))
                continue
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(text)
            print("write %s" % os.path.relpath(path, ROOT))

    if args.check and stale:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
