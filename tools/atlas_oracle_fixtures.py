#!/usr/bin/env python3
"""Write the oracle fixtures: Python-rendered ground truth + a JS job spec.

    python tools/atlas_oracle_fixtures.py [outdir]

Each fixture is a scene the two renderers must agree on, pixel for pixel.  The
Python side renders the reference PNG; the JS side (`tools/atlas_oracle.mjs`)
renders the same scene from the same camera and diffs it.

The block fixture is deliberately built the *long way round* on the JS side: the
reference uses explicit elements, while the JS job names only the vanilla parent
(`block/cube_bottom_top`).  If the parent template baked into `atlas_core.mjs`
were wrong, the two would disagree.
"""

import json
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "vanilla3d", "tools"))

import render_block_model as bm          # noqa: E402
import render_entity_model as em         # noqa: E402

ENTITY_BG = [28, 26, 30]
BLOCK_BG = [30, 26, 30]


def camera_json(camera, models):
    # Camera keeps only the direction, so re-deriving a target from
    # `position + forward` would introduce a rounding error that neither side
    # shares.  Name the framing centre itself instead: both renderers then
    # build the identical basis, and any difference left is a real one.
    low, high = em.scene_bbox(models if isinstance(models, (list, tuple)) else [models])
    centre = (low + high) / 2.0
    return {
        "position": [float(v) for v in camera.position],
        "target": [float(v) for v in centre],
        "width": int(camera.viewport[0]),
        "height": int(camera.viewport[1]),
        "fovY": float(bm.FOV_Y),
    }


def write(path, payload):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=1)
    print("write", path)


def entity_fixture(out, name, layers, direction):
    """layers: [(spec, texture_path, blend)]"""
    models = [layer[0] for layer in layers]
    camera = em.fit_camera(models if len(models) > 1 else models[0], direction)
    items = []
    textures = {}
    js_layers = []
    for index, (spec, texture, blend) in enumerate(layers):
        tid = "t%d" % index
        textures[tid] = texture
        items.append((spec, texture, (1.0, 1.0, 1.0)) + ((True,) if blend else ()))
        js_layers.append({"spec": spec, "texture": tid,
                          "mode": "blend" if blend else "opaque"})
    reference = os.path.join(out, name + ".ref.png")
    em.render_scene(items, reference, camera, tuple(ENTITY_BG))
    write(os.path.join(out, name + ".json"), {
        "name": name, "kind": "entity", "layers": js_layers,
        "camera": camera_json(camera, models), "background": ENTITY_BG,
        "textures": textures, "reference": reference,
    })


def cube_elements(pick):
    faces = {}
    for face in ("down", "up", "north", "south", "west", "east"):
        faces[face] = {"texture": pick[face], "uv": [0, 0, 16, 16]}
    return [{"from": [0, 0, 0], "to": [16, 16, 16], "faces": faces}]


CROSS_ELEMENTS = [
    {"from": [0.8, 0, 8], "to": [15.2, 16, 8],
     "rotation": {"origin": [8, 8, 8], "axis": "y", "angle": 45, "rescale": True},
     "faces": {"north": {"uv": [0, 0, 16, 16], "texture": "#cross"},
               "south": {"uv": [0, 0, 16, 16], "texture": "#cross"}}},
    {"from": [8, 0, 0.8], "to": [8, 16, 15.2],
     "rotation": {"origin": [8, 8, 8], "axis": "y", "angle": 45, "rescale": True},
     "faces": {"west": {"uv": [0, 0, 16, 16], "texture": "#cross"},
               "east": {"uv": [0, 0, 16, 16], "texture": "#cross"}}},
]


def block_fixture(out, name, model, texture_map, parent_override=None):
    """model: the JS-side model JSON; texture_map: res-name -> source PNG."""
    tex_dir = os.path.join(out, "tex")
    os.makedirs(tex_dir, exist_ok=True)
    texture_ids = {}
    textures = {}
    for index, (res, source) in enumerate(sorted(texture_map.items())):
        flat = res.split("/")[-1] + ".png"
        shutil.copyfile(source, os.path.join(tex_dir, flat))
        tid = "t%d" % index
        texture_ids[res] = tid
        textures[tid] = os.path.join(tex_dir, flat)

    # the reference is built from explicit elements, the JS job from the parent
    elements = model.get("_elements")
    merged = {
        "textures": dict(model.get("textures", {}), **{k: k for k in []}),
        "elements": elements,
    }
    position = (1.9, 1.75, 2.3)
    target = (0.5, 0.5, 0.5)
    reference = os.path.join(out, name + ".ref.png")
    bm.render(merged, tex_dir, reference, position, target, tuple(BLOCK_BG))
    js_model = {k: v for k, v in model.items() if not k.startswith("_")}
    write(os.path.join(out, name + ".json"), {
        "name": name, "kind": "block", "model": js_model,
        "parents": parent_override or {},
        "textureIds": texture_ids, "textures": textures,
        "camera": {"position": list(position), "target": list(target),
                   "width": bm.WIDTH, "height": bm.HEIGHT, "fovY": float(bm.FOV_Y)},
        "background": BLOCK_BG, "reference": reference,
    })


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/oracle"
    os.makedirs(out, exist_ok=True)
    pack = os.path.join(ROOT, "examplemod", "pack", "assets", "examplemod", "textures")

    # 1. the vanilla cow: the fixture the entity renderer was calibrated on
    entity_fixture(out, "cow", [(em.cow(), os.path.join(
        ROOT, "vanilla3d", "textures", "entity", "cow.png"), False)],
        em.VIEWS["front34"])

    # 2. the example sheep: two layers, opaque skin then blended fleece
    entity_fixture(out, "sheep", [
        (em.sheep_skin(), os.path.join(pack, "entity", "example_sheep.png"), False),
        (em.sheep_wool(), os.path.join(pack, "entity", "example_sheep_wool.png"), True),
    ], em.VIEWS["front34"])

    # 3. a cube_bottom_top block, resolved through the JS parent template
    block_fixture(
        out, "block_grass",
        {
            "parent": "block/cube_bottom_top",
            "textures": {
                "top": "examplemod:block/example_grass_top",
                "bottom": "examplemod:block/example_soil",
                "side": "examplemod:block/example_grass_side",
            },
            "_elements": cube_elements({
                "down": "#bottom", "up": "#top", "north": "#side",
                "south": "#side", "west": "#side", "east": "#side"}),
        },
        {
            "examplemod:block/example_grass_top": os.path.join(pack, "block", "example_grass_top.png"),
            "examplemod:block/example_soil": os.path.join(pack, "block", "example_soil.png"),
            "examplemod:block/example_grass_side": os.path.join(pack, "block", "example_grass_side.png"),
        },
    )

    # 4. a cross block: the same 45-degree element rotation, no `shade` key so
    #    the two sides agree on lighting and the geometry is what gets compared
    block_fixture(
        out, "block_cross",
        {
            "parent": "block/cross",
            "textures": {"cross": "examplemod:block/example_tendril"},
            "_elements": CROSS_ELEMENTS,
        },
        {"examplemod:block/example_tendril": os.path.join(pack, "block", "example_tendril.png")},
        parent_override={
            "block/cross": {"textures": {"particle": "#cross"},
                            "elements": CROSS_ELEMENTS},
        },
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
