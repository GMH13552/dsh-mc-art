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

The entity model specs are still imported from
`vanilla3d/tools/render_entity_model.py` -- no model number is typed here.

    python3 tools/emit_atlas.py            # write both artifacts
    python3 tools/emit_atlas.py --check    # exit 1 when either is stale
"""

import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "vanilla3d", "tools"))

import render_entity_model as em  # noqa: E402  (path set up above)

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
    "fleshland": {
        "project": "血肉之地",
        "block": {
            "flesh_block": "血肉块",
            "flesh_grass": "血肉草皮",
            "flesh_soil": "血肉泥土",
            "flesh_stone": "血肉石",
            "flesh_wool": "血肉羊毛",
            "vein_block": "筋膜块",
            "eyeball_block": "眼球块",
            "congealed_blood": "凝血块",
            "blood_bone_block": "血骨块",
            "blood_crystal_ore": "血晶矿石",
            "blood_eye_sprout": "血眼芽",
            "blood_sac": "血囊",
            "flesh_tendril": "血肉触须",
        },
        "item": {"blood_crystal": "血晶"},
        "entity": {"blood_sheep": "畸变羊", "blood_slime": "血滴史莱姆"},
        "biome": {"fleshland": "血肉之地"},
    },
    "eyeballtree": {
        "project": "眼球树",
        "block": {
            "eyeball_log": "眼球原木",
            "eyeball_stripped_log": "去皮眼球原木",
            "eyeball_planks": "眼球木板",
            "eyeball_leaves": "眼球树叶",
            "eyeball_sapling": "眼球树苗",
        },
        "structure": {"eyeball_tree": "眼球树"},
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

def fleshland_biome_cells():
    """A 7x7 patch of the Flesh Land: mostly grass, worn soil, bare stone.

    The ground goes into a coordinate map first so an ore can REPLACE the ground
    it sits in.  Appending it at the same `at` instead puts two blocks in one
    cell, and the depth test then hides whichever loses the tie -- which is
    exactly how the blood-crystal vein went missing from the render while the
    palette still counted it.
    """
    ground = {}
    for x in range(-3, 4):
        for z in range(-3, 4):
            block = "flesh_grass"
            if (x + z) % 3 == 0:
                block = "flesh_soil"
            if (x * 3 + z * 5) % 11 == 0:
                block = "flesh_stone"
            ground[(x, z)] = block
    ground[(2, -2)] = "blood_crystal_ore"      # a vein is IN the ground
    cells = [
        {"block": block, "at": [x, 0, z]}
        for (x, z), block in sorted(ground.items())
    ]
    # growths stand ON the ground, one level up -- never inside it
    cells += [
        {"block": "blood_eye_sprout", "at": [1, 1, -1]},
        {"block": "flesh_tendril", "at": [-2, 1, 1]},
        {"block": "blood_sac", "at": [2, 1, 2]},
        {"block": "eyeball_block", "at": [-3, 1, -3]},
    ]
    return cells


def eyeball_tree_cells(offset=(0, 0, 0)):
    """The eyeball tree: four logs of trunk, an eyed canopy.  Cross-namespace
    by design -- it is built out of `eyeballtree:*` blocks wherever it stands."""
    ox, oy, oz = offset
    cells = [
        {"block": "eyeballtree:eyeball_log", "at": [ox, oy + y, oz]}
        for y in range(4)
    ]
    for x in range(-1, 2):
        for z in range(-1, 2):
            cells.append({"block": "eyeballtree:eyeball_leaves",
                          "at": [ox + x, oy + 4, oz + z]})
    for x, z in ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)):
        cells.append({"block": "eyeballtree:eyeball_leaves",
                      "at": [ox + x, oy + 5, oz + z]})
    cells.append({"block": "eyeballtree:eyeball_leaves", "at": [ox, oy + 6, oz]})
    return cells


# ---------------------------------------------------------------------------

def fleshland_atlas(namespace):
    return {
        "schema": SCHEMA,
        "namespace": namespace,
        "pack": "pack",
        "entities": [
            {
                "id": "blood_sheep",
                "layers": [
                    {"texture": "entity/blood_sheep.png", "mode": "opaque",
                     "model": model_of(em.sheep_skin())},
                    {"texture": "entity/blood_sheep_wool.png", "mode": "blend",
                     "model": model_of(em.sheep_wool())},
                ],
                "refs": ["plans/blood_sheep.plan.json",
                         "plans/blood_sheep_wool.plan.json",
                         "tools/build_sheep_shared.py"],
            },
            {
                "id": "blood_slime",
                "layers": [
                    {"texture": "entity/blood_slime.png", "mode": "opaque",
                     "model": model_of(em.slime_core())},
                    {"texture": "entity/blood_slime.png", "mode": "blend",
                     "model": model_of(em.slime_shell())},
                ],
                "refs": ["plans/blood_slime.plan.json", "tools/build_slime.py"],
            },
        ],
        "biomes": [
            {"id": "fleshland",
             "cells": fleshland_biome_cells(),
             "refs": ["tools/build_flesh.py", "tools/render_ensemble.py"]},
        ],
        # No `structures` key at all, on purpose.  The eyeball tree belongs to
        # the `eyeballtree` project, which already declares it; a second copy in
        # this project's atlas was an invention, and the project owner removed
        # it -- key included.  Keep the generator agreeing with that decision.
    }


def eyeball_tree_atlas(namespace):
    return {
        "schema": SCHEMA,
        "namespace": namespace,
        "pack": "pack",
        "entities": [],
        "biomes": [],
        "structures": [
            {"id": "eyeball_tree",
             "cells": eyeball_tree_cells(),
             "refs": ["tools/build_plans.py", "SUMMARY.md"]},
        ],
    }


PROJECTS = {
    "fleshland": fleshland_atlas,
    "eyeball_tree": eyeball_tree_atlas,
}


def dump(payload):
    return json.dumps(payload, indent=2, ensure_ascii=False) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true",
                        help="do not write; exit 1 when a file is missing or stale")
    args = parser.parse_args()

    stale = []
    for project, build in PROJECTS.items():
        namespace = namespace_of(project)
        if namespace is None:
            print("!! %s: cannot determine the pack namespace" % project)
            return 2

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
