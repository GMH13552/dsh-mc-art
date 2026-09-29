#!/usr/bin/env python3
"""Tests for tools/mcart_extract_block.py.

Two halves, on purpose:

  * synthetic packs built in tmp_path -- these ALWAYS run, so a regression in a
    resolution rule is caught on any machine, and each one pins a rule that was
    actually wrong at some point (namespace fallback, name-key spelling, name
    priority, texture folder).
  * real-jar checks against the installation on this disk -- these skip when the
    path is absent, and they are what proves the rules match reality and not
    just my idea of it.
"""

import json
import os
import subprocess
import sys
import zipfile

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "mcart_extract_block.py")

# The installation the real-jar tests read.  Absent -> those tests skip.
REAL_ROOT = "/mnt/c/Users/GMH13/Release 2.8.3/.minecraft"
REAL_VERSION = "1.12.2-Forge_14.23.5.28641"
REAL_VANILLA_JAR = os.path.join(REAL_ROOT, "versions", REAL_VERSION, REAL_VERSION + ".jar")
REAL_MOD_JAR = os.path.join(REAL_ROOT, "versions", REAL_VERSION, "mods", "[虚无世界] AoA3-3.3.6.jar")

PNG = b"\x89PNG\r\n\x1a\n" + b"pretend pixels"

# The live project pack, for the multi-root check against a real vanilla parent.
PROJECT_PACK = "/home/gmh/mc-art/eyeball_tree/pack"


# Real-jar checks skip when this machine does not have that installation.
needs_real = pytest.mark.skipif(not os.path.isfile(REAL_VANILLA_JAR),
                                reason="这台机器上没有那个 .minecraft")


def run(*args):
    result = subprocess.run([sys.executable, TOOL] + list(args),
                            capture_output=True, text=True)
    assert result.stdout.strip(), "工具没有输出；stderr=%s" % result.stderr[-400:]
    return json.loads(result.stdout)


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)


def write_bytes(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(data)


def pack(root, namespace, models, blockstates, textures, lang=None):
    """An extracted resource tree: <root>/assets/<ns>/..."""
    base = os.path.join(root, "assets", namespace)
    for name, body in blockstates.items():
        write(os.path.join(base, "blockstates", name + ".json"), json.dumps(body))
    for name, body in models.items():
        write(os.path.join(base, "models", "block", name + ".json"), json.dumps(body))
    for name, data in textures.items():
        write_bytes(os.path.join(base, "textures", name + ".png"), data)
    for locale, table in (lang or {}).items():
        text = "".join("%s=%s\n" % (k, v) for k, v in table.items())
        write(os.path.join(base, "lang", locale + ".lang"), text)


def index_lang(root, name, entries):
    """Add a hashed-object-store lang file plus the index that points at it."""
    digest = ("a" * 38) + name[-2:]
    blob = os.path.join(root, "assets", "objects", digest[:2], digest)
    write_bytes(blob, "".join("%s=%s\n" % (k, v) for k, v in entries.items()).encode("utf-8"))
    write(os.path.join(root, "assets", "indexes", "1.12.json"),
          json.dumps({"objects": {"minecraft/lang/%s.lang" % name: {"hash": digest}}}))


def make_jar(path, entries):
    """A real zip, because the jar reader is the thing under test."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with zipfile.ZipFile(path, "w") as archive:
        for name, data in entries.items():
            archive.writestr(name, data if isinstance(data, bytes) else json.dumps(data))
    return path


CUBE = {"textures": {"all": "#all"},
        "elements": [{"from": [0, 0, 0], "to": [16, 16, 16],
                      "faces": {"up": {"texture": "#all"}}}]}


def jar_block(block, texture, extra=None):
    entries = {
        "assets/minecraft/blockstates/%s.json" % block: {"variants": {"": {"model": block}}},
        "assets/minecraft/models/block/%s.json" % block: {"textures": {"all": texture},
                                                          "elements": CUBE["elements"]},
        "assets/minecraft/textures/blocks/%s.png" % texture: PNG,
    }
    entries.update(extra or {})
    return entries


# --------------------------------------------------------------------------
# synthetic packs
# --------------------------------------------------------------------------

def test_plain_block_resolves(tmp_path):
    root = str(tmp_path)
    pack(root, "testns",
         models={"thing": {"parent": "block/cube_all", "textures": {"all": "blocks/thing"}}},
         blockstates={"thing": {"variants": {"": {"model": "thing"}}}},
         textures={"blocks/thing": PNG})
    pack(root, "minecraft",
         models={"block/cube_all": {"textures": {"all": "#all"},
                                    "elements": [{"from": [0, 0, 0], "to": [16, 16, 16],
                                                  "faces": {"up": {"texture": "#all"}}}]}},
         blockstates={}, textures={})
    out = run("--root", root, "--block", "testns:thing")
    assert "error" not in out, out
    assert out["variant"] == ""
    assert "testns:blocks/thing" in out["textures"]
    # chain + the baked model the consumer actually reads
    assert len(out["models"]) >= 2, list(out["models"])


def test_unqualified_parent_reaches_minecraft(tmp_path):
    """A mod model says "block/cube_all" and means vanilla, not itself.

    This is the rule that was wrong: the parent was resolved against the mod's
    own namespace, so the chain stopped at depth 1 and the block came out with
    no elements and no textures at all.
    """
    root = str(tmp_path)
    pack(root, "testns",
         models={"thing": {"parent": "block/cube_all", "textures": {"all": "blocks/thing"}}},
         blockstates={"thing": {"variants": {"": {"model": "thing"}}}},
         textures={"blocks/thing": PNG})
    pack(root, "minecraft",
         models={"block/cube_all": {"textures": {"all": "#all"},
                                    "elements": [{"from": [0, 0, 0], "to": [16, 16, 16],
                                                  "faces": {"up": {"texture": "#all"}}}]}},
         blockstates={}, textures={})
    out = run("--root", root, "--block", "testns:thing")
    assert "minecraft:block/cube_all" in out["models"], list(out["models"])
    # and the element list is reachable, which is what the renderer needs
    assert any(m.get("elements") for m in out["models"].values())


def test_own_namespace_wins_over_minecraft_for_textures(tmp_path):
    """A generated pack's "blocks/dirt" means its OWN blocks/dirt."""
    root = str(tmp_path)
    pack(root, "testns",
         models={"thing": {"textures": {"all": "blocks/thing"},
                           "elements": [{"from": [0, 0, 0], "to": [16, 16, 16],
                                         "faces": {"up": {"texture": "#all"}}}]}},
         blockstates={"thing": {"variants": {"": {"model": "thing"}}}},
         textures={"blocks/thing": b"OWN" + PNG})
    pack(root, "minecraft", models={}, blockstates={}, textures={"blocks/thing": b"VANILLA" + PNG})
    out = run("--root", root, "--block", "testns:thing")
    import base64
    assert base64.b64decode(out["textures"]["testns:blocks/thing"]) == b"OWN" + PNG


def test_bare_and_pascal_lang_keys(tmp_path):
    """AoA3 names a block tile.AchonyLog.name with no namespace segment."""
    root = str(tmp_path)
    pack(root, "testns",
         models={"achony_log": {"textures": {"all": "blocks/achony_log"},
                                "elements": [{"from": [0, 0, 0], "to": [16, 16, 16],
                                              "faces": {"up": {"texture": "#all"}}}]}},
         blockstates={"achony_log": {"variants": {"": {"model": "achony_log"}}}},
         textures={"blocks/achony_log": PNG},
         lang={"zh_cn": {"tile.AchonyLog.name": "桉格尼木"}})
    out = run("--root", root, "--block", "testns:achony_log")
    assert out["name"] == "桉格尼木", out["name"]
    assert out["nameKey"] == "tile.AchonyLog.name"


def test_specific_key_beats_convenient_table(tmp_path):
    """en_us "tile.dirt.name=Dirt" must NOT beat zh_cn "block.minecraft.dirt=泥土".

    Searching table-by-table returned "Dirt" for every vanilla block, because the
    jar's own en_us table was consulted first and it happened to hold a matching
    key.  The key spelling has to be ranked above which file it came from.
    """
    root = str(tmp_path)
    pack(root, "minecraft",
         models={"dirt": {"textures": {"all": "blocks/dirt"},
                          "elements": [{"from": [0, 0, 0], "to": [16, 16, 16],
                                        "faces": {"up": {"texture": "#all"}}}]}},
         blockstates={"dirt": {"variants": {"normal": {"model": "dirt"}}}},
         textures={"blocks/dirt": PNG},
         lang={"en_us": {"tile.dirt.name": "Dirt"}})
    index_lang(root, "zh_cn", {"block.minecraft.dirt": "泥土"})
    out = run("--root", root, "--block", "minecraft:dirt")
    assert out["name"] == "泥土", (out["name"], out["nameKey"])
    assert out["nameKey"] == "block.minecraft.dirt"


def test_variant_preference(tmp_path):
    root = str(tmp_path)
    pack(root, "testns",
         models={"log": {"textures": {"all": "blocks/log"},
                         "elements": [{"from": [0, 0, 0], "to": [16, 16, 16],
                                       "faces": {"up": {"texture": "#all"}}}]},
                 "flat": {"textures": {"all": "blocks/log"},
                          "elements": [{"from": [0, 0, 0], "to": [16, 16, 16],
                                        "faces": {"up": {"texture": "#all"}}}]}},
         blockstates={"log": {"variants": {"axis=x": {"model": "log"}, "axis=y": {"model": "log"},
                                           "axis=z": {"model": "log"}, "axis=none": {"model": "log"}}},
                      "flat": {"variants": {"": {"model": "flat"}}}},
         textures={"blocks/log": PNG})
    assert run("--root", root, "--block", "testns:log")["variant"] == "axis=y"
    assert run("--root", root, "--block", "testns:flat")["variant"] == ""


def test_missing_block_is_an_error_not_a_guess(tmp_path):
    root = str(tmp_path)
    pack(root, "testns", models={}, blockstates={}, textures={})
    out = run("--root", root, "--block", "testns:nope")
    assert "error" in out and "nope" in out["error"]


def test_missing_texture_is_reported(tmp_path):
    """A dangling texture must be visible, not silently absent."""
    root = str(tmp_path)
    pack(root, "testns",
         models={"thing": {"textures": {"all": "blocks/gone"},
                           "elements": [{"from": [0, 0, 0], "to": [16, 16, 16],
                                         "faces": {"up": {"texture": "#all"}}}]}},
         blockstates={"thing": {"variants": {"": {"model": "thing"}}}},
         textures={})
    out = run("--root", root, "--block", "testns:thing")
    assert out["textures"] == {}
    assert "blocks/gone" in out["missingTextures"]


def test_parent_cycle_terminates(tmp_path):
    root = str(tmp_path)
    pack(root, "testns",
         models={"a": {"parent": "b", "textures": {"all": "blocks/t"}},
                 "b": {"parent": "a"}},
         blockstates={"loop": {"variants": {"": {"model": "a"}}}},
         textures={"blocks/t": PNG})
    out = run("--root", root, "--block", "testns:loop")
    # The walk must terminate; a model that parents in a circle has no `elements`
    # anywhere, so the honest answer is "no geometry", said specifically.
    assert out.get("noGeometry") is True, out
    assert "没有几何模型" in out["error"], out.get("error")
    assert len(out["models"]) <= 3


def test_corrupt_jar_is_not_fatal(tmp_path):
    root = str(tmp_path)
    write_bytes(os.path.join(root, "broken.jar"), b"this is not a zip file")
    out = run("--root", os.path.join(root, "broken.jar"), "--block", "minecraft:oak_log")
    assert "error" in out, "坏 jar 应当报错而不是崩掉"


def test_texture_files_say_which_namespace_won(tmp_path):
    """An unqualified ref does not record where it resolved; the caller needs it.

    Without this the host cannot key the texture the way the model refers to it,
    because "blocks/thing" could have come from the pack itself or from vanilla.
    """
    root = str(tmp_path)
    pack(root, "testns",
         models={"thing": {"parent": "block/cube_all", "textures": {"all": "blocks/thing"}}},
         blockstates={"thing": {"variants": {"": {"model": "thing"}}}},
         textures={"blocks/thing": PNG})
    pack(root, "minecraft",
         models={"block/cube_all": {"textures": {"all": "#all"},
                                    "elements": [{"from": [0, 0, 0], "to": [16, 16, 16],
                                                  "faces": {"up": {"texture": "#all"}}}]}},
         blockstates={}, textures={})
    out = run("--root", root, "--block", "testns:thing")
    assert out["textureFiles"]["testns:blocks/thing"] == "assets/testns/textures/blocks/thing.png"


def test_icons_batch_names_and_pngs(tmp_path):
    """The hotbar wants many icons; one process must serve all of them."""
    root = str(tmp_path)
    body = {"textures": {"all": "blocks/t"},
            "elements": [{"from": [0, 0, 0], "to": [16, 16, 16],
                          "faces": {"up": {"texture": "#all"}}}]}
    pack(root, "testns",
         models={"one": body, "two": body},
         blockstates={"one": {"variants": {"": {"model": "one"}}},
                      "two": {"variants": {"": {"model": "two"}}}},
         textures={"blocks/t": PNG},
         lang={"zh_cn": {"tile.One.name": "一", "tile.Two.name": "二"}})
    out = run("--root", root, "--namespace", "testns", "--icons", "one,two,missing")
    assert set(out["icons"]) == {"one", "two"}
    assert out["icons"]["one"]["name"] == "一"
    assert out["icons"]["two"]["png"]
    assert out["failed"] == ["missing"]


def test_locale_outranks_table_order(tmp_path):
    """The SAME key in two tables: the Chinese one has to win.

    `test_specific_key_beats_convenient_table` covered two different keys.  This
    is the harder case that survived that fix: 1.18.2's jar ships only en_us, so
    for the identical key `block.minecraft.dirt` the jar's "Dirt" was returned
    and the index store's zh_cn was never reached.  Locale has to outrank which
    table the entry happened to come from.
    """
    root = str(tmp_path)
    pack(root, "minecraft",
         models={"dirt": {"textures": {"all": "blocks/dirt"}, "elements": CUBE["elements"]}},
         blockstates={"dirt": {"variants": {"normal": {"model": "dirt"}}}},
         textures={"blocks/dirt": PNG},
         lang={"en_us": {"block.minecraft.dirt": "Dirt"}})
    index_lang(root, "zh_cn", {"block.minecraft.dirt": "泥土"})
    out = run("--root", root, "--block", "minecraft:dirt")
    assert out["name"] == "泥土", (out["name"], out["nameFrom"])


def test_dangling_parent_is_reported(tmp_path):
    """A parent that is nowhere must be said out loud.

    A single mod jar has no vanilla next to it, so `block/cube_column` resolves
    to nothing: the block came back with no elements, no textures and no
    complaint -- indistinguishable from an empty model.
    """
    root = str(tmp_path)
    pack(root, "testns",
         models={"thing": {"parent": "block/does_not_exist", "textures": {"all": "blocks/t"}}},
         blockstates={"thing": {"variants": {"": {"model": "thing"}}}},
         textures={"blocks/t": PNG})
    out = run("--root", root, "--block", "testns:thing")
    assert out["missingModels"], out
    assert "does_not_exist" in out["missingModels"][0], out["missingModels"]
    assert out["textures"] == {}


def test_version_directory_is_recognised(tmp_path):
    """Pointing at <game>/versions/<v> must still open <v>.jar.

    The scanner has always known this shape; the extractor re-derived it and got
    it wrong -- the version jar was never opened, the probe said "模组目录" with
    only the mods, and every vanilla block reported "参考目录里没有这个方块".
    """
    root = str(tmp_path)
    version = os.path.join(root, "versions", "1.12.2-Test")
    make_jar(os.path.join(version, "1.12.2-Test.jar"), jar_block("thing", "t"))
    os.makedirs(os.path.join(version, "mods"), exist_ok=True)
    probe = run("--root", version, "--probe")
    assert probe["shape"] == "版本目录", probe["shape"]
    labels = [p["label"] for p in probe["providers"]]
    assert "1.12.2-Test.jar" in labels, labels
    out = run("--root", version, "--block", "minecraft:thing")
    assert "error" not in out, out
    assert out["textures"], out


def test_version_directory_finds_names_from_the_game_root(tmp_path):
    """A version directory has no index store; the game directory above does.

    This pack's vanilla jars carry only `en_us`, so without looking upward the
    geometry rendered correctly under English names -- correct-looking and wrong.
    """
    root = str(tmp_path)
    version = os.path.join(root, "versions", "1.12.2-Test")
    make_jar(os.path.join(version, "1.12.2-Test.jar"),
             jar_block("thing", "t", {"assets/minecraft/lang/en_us.lang": "block.minecraft.thing=Thing\n"}))
    index_lang(root, "zh_cn", {"block.minecraft.thing": "东西"})
    out = run("--root", version, "--block", "minecraft:thing")
    assert "error" not in out, out
    assert out["name"] == "东西", (out["name"], out["nameFrom"])


def test_namespaces_reports_block_counts(tmp_path):
    """The picker's number must be BLOCKSTATES, in the version being read.

    It used to come from the PNG scanner, which counts textures across every
    installed version -- so `minecraft` was advertised as "13209 张" while this
    tool could offer 407 blocks out of it.  A number you cannot get is worse
    than no number.
    """
    root = str(tmp_path)
    pack(root, "alpha", models={}, blockstates={"one": {"variants": {}}, "two": {"variants": {}}}, textures={})
    pack(root, "beta", models={}, blockstates={"only": {"variants": {}}}, textures={})
    # Textures but no blockstates: not a source of blocks at all.
    pack(root, "emptyish", models={}, blockstates={}, textures={"blocks/x": PNG})
    out = run("--root", root, "--namespaces")
    assert "error" not in out, out
    got = {item["name"]: item["blocks"] for item in out["namespaces"]}
    assert got["alpha"] == 2, got
    assert got["beta"] == 1, got
    assert got.get("emptyish", 0) == 0, got
    assert [item["name"] for item in out["namespaces"]][:2] == ["alpha", "beta"], out["namespaces"]


@needs_real
def test_real_namespaces_are_block_counts_of_one_version():
    out = run("--root", REAL_ROOT, "--namespaces")
    assert out["version"] == REAL_VERSION, out["version"]
    got = {item["name"]: item["blocks"] for item in out["namespaces"]}
    assert got.get("aoa3", 0) > 1000, got
    assert got.get("minecraft", 0) > 300, got
    # Everything reported is a real source of blocks; nothing is listed at 0.
    assert all(item["blocks"] > 0 for item in out["namespaces"]), out["namespaces"]
    # Far fewer than the 30 namespaces the texture scanner reports, because most
    # mods on this disk ship no models at all.
    assert len(out["namespaces"]) < 20, len(out["namespaces"])


def test_list_carries_categories(tmp_path):
    """Categories must come from the pack, not from me.

    A mod that files its models into folders (AoA3: decoration/generation/
    functional) has stated its own categories; a flat pack states none and must
    then report none rather than an invented bucket.  The shape family is read
    off the id and anything unmatched is honestly 其他.
    """
    root = str(tmp_path)
    pack(root, "testns",
         models={"thing": {}, "deep/thing_slab": {}},
         blockstates={"thing": {"variants": {"": {"model": "thing"}}},
                      "thing_slab": {"variants": {"": {"model": "deep/thing_slab"}}},
                      "plain_log": {"variants": {"": {"model": "flat_log"}}},
                      "weird_thing": {"variants": {"": {"model": "flat_log"}}}},
         textures={})
    out = run("--root", root, "--list", "--namespace", "testns")
    got = {item["id"]: item for item in out["blocks"]}
    assert got["thing"]["group"] == "", got["thing"]
    assert got["thing_slab"]["group"] == "deep", got["thing_slab"]
    assert got["thing_slab"]["family"] == "\u53f0\u9636", got["thing_slab"]
    assert got["plain_log"]["family"] == "\u539f\u6728", got["plain_log"]
    # Nothing matched, so it must say so -- not be forced into a bucket.
    assert got["weird_thing"]["family"] == "\u5176\u4ed6", got["weird_thing"]


def test_model_refs_are_qualified(tmp_path):
    """A texture ref must come back qualified for the archive that has it.

    A mod writes `"all": "blocks/wool_colored_brown"` meaning vanilla.  We resolve
    that correctly when reading the bytes -- and then used to hand the MODEL back
    with the ref still unqualified, so the consumer guessed the mod's own
    namespace, found nothing, skipped every face, and the block rendered as
    nothing at all.  Qualifying only the texture map was not enough; the model is
    what gets dereferenced.
    """
    root = str(tmp_path)
    pack(root, "testns",
         models={"thing": {"parent": "block/cube_all", "textures": {"all": "blocks/thing"}}},
         blockstates={"thing": {"variants": {"": {"model": "thing"}}}},
         textures={})
    pack(root, "minecraft",
         models={"block/cube_all": CUBE}, blockstates={}, textures={"blocks/thing": PNG})
    out = run("--root", root, "--block", "testns:thing")
    assert out["models"]["testns:thing"]["textures"]["all"] == "minecraft:blocks/thing", out["models"]
    assert "minecraft:blocks/thing" in out["textures"], list(out["textures"])


def test_forge_marker_model_comes_from_defaults(tmp_path):
    """`variants: {"normal": [{}]}` + `defaults.model` must still resolve."""
    root = str(tmp_path)
    pack(root, "testns",
         models={"altar": CUBE},
         blockstates={"altar": {"forge_marker": 1, "defaults": {"model": "altar"},
                                "variants": {"normal": [{}]}}},
         textures={"blocks/thing": PNG})
    out = run("--root", root, "--block", "testns:altar")
    assert "error" not in out, out
    assert out["modelRefs"] == ["__baked__"], out["modelRefs"]


def test_consumer_gets_one_baked_model(tmp_path):
    """The consumer must not have to resolve anything.

    Resolution used to live twice -- here and in the plugin's JavaScript -- and
    each copy understood only part of it, so every new blockstate shape leaked a
    block.  The contract now: modelRefs points at ONE model, it has no parent,
    and every texture reference in it already names its namespace.  #aliases are
    still allowed, because the consumer dereferences those against the same table.
    """
    root = str(tmp_path)
    pack(root, "testns",
         models={"thing": {"parent": "block/cube_all", "textures": {"all": "blocks/thing"}}},
         blockstates={"thing": {"variants": {"": {"model": "thing"}}}},
         textures={})
    pack(root, "minecraft",
         models={"block/cube_all": CUBE}, blockstates={}, textures={"blocks/thing": PNG})
    out = run("--root", root, "--block", "testns:thing")
    refs = out["modelRefs"]
    assert refs == ["__baked__"], refs
    baked = out["models"]["__baked__"]
    assert "parent" not in baked, baked
    assert baked["elements"], baked
    for value in baked["textures"].values():
        assert not (isinstance(value, str) and ":" not in value and not value.startswith("#")), baked["textures"]


def write_animated_pack(root, frametime=2, meta_extra=None):
    """A 16x64 four-frame strip with the `.mcmeta` that declares it animated."""
    import io
    from PIL import Image
    image = Image.new("RGBA", (16, 64))
    for y in range(64):
        for x in range(16):
            image.putpixel((x, y), ((y * 4) % 256, 0, 0, 255))
    out = io.BytesIO()
    image.save(out, "PNG")
    pack(root, "testns",
         models={"thing": {"textures": {"all": "blocks/thing"},
                           "elements": [{"from": [0, 0, 0], "to": [16, 16, 16],
                                         "faces": {"up": {"texture": "#all"}}}]}},
         blockstates={"thing": {"variants": {"": {"model": "thing"}}}},
         textures={"blocks/thing": out.getvalue()})
    animation = {"frametime": frametime}
    animation.update(meta_extra or {})
    write(os.path.join(root, "assets", "testns", "textures", "blocks", "thing.png.mcmeta"),
          json.dumps({"animation": animation}))


def test_3d_path_ships_the_whole_strip_and_how_to_play_it(tmp_path):
    """An animated texture must arrive as a strip PLUS its playback description.

    Cropping to frame 0 is what made animated blocks stand still ("画出来了但
    不会动").  A viewer can only step through frames if it is told where the
    frame boundaries are and how fast to advance, so the strip goes over whole
    and `animations` says how to read it.
    """
    import struct
    import base64
    root = str(tmp_path)
    write_animated_pack(root)
    out = run("--root", root, "--block", "testns:thing")
    raw = base64.b64decode(out["textures"]["testns:blocks/thing"])
    width, height = struct.unpack(">II", raw[16:24])
    assert (width, height) == (16, 64), (width, height)
    assert out["animatedTextures"]["testns:blocks/thing"] == 4, out["animatedTextures"]
    animation = out["animations"]["testns:blocks/thing"]
    assert animation["frames"] == 4, animation
    assert animation["strip"] == 4, animation
    assert animation["order"] == [0, 1, 2, 3], animation
    assert animation["frametime"] == 2, animation


def test_frame_order_is_carried_not_just_the_count(tmp_path):
    """`frames` in .mcmeta is a list, and it may reorder or repeat.

    lava_still declares 38 entries while its strip holds 20 rows -- the number
    of rows is not the number of playback steps, so a count alone loses it.
    """
    import io
    from PIL import Image
    root = str(tmp_path)
    image = Image.new("RGBA", (16, 48))
    for y in range(48):
        for x in range(16):
            image.putpixel((x, y), ((y * 5) % 256, 0, 0, 255))
    out_bytes = io.BytesIO()
    image.save(out_bytes, "PNG")
    pack(root, "testns",
         models={"thing": {"textures": {"all": "blocks/thing"},
                           "elements": [{"from": [0, 0, 0], "to": [16, 16, 16],
                                         "faces": {"up": {"texture": "#all"}}}]}},
         blockstates={"thing": {"variants": {"": {"model": "thing"}}}},
         textures={"blocks/thing": out_bytes.getvalue()})
    write(os.path.join(root, "assets", "testns", "textures", "blocks", "thing.png.mcmeta"),
          json.dumps({"animation": {"frametime": 3,
                                    "frames": [{"index": 0, "time": 5}, 2, 1, {"index": 2}]}}))
    out = run("--root", root, "--block", "testns:thing")
    animation = out["animations"]["testns:blocks/thing"]
    assert animation["frames"] == 4, animation
    assert animation["order"] == [0, 2, 1, 2], animation
    assert animation["strip"] == 3, animation
    assert animation["frametime"] == 3, animation


def test_icon_path_still_crops_the_strip(tmp_path):
    """The hotbar paints the PNG as a CSS background.

    A whole strip handed to a background arrives squashed into one square, so
    the icon path keeps cropping to frame 0 even though the 3D path no longer
    does.  Two consumers, two answers, and this is the one that must not drift.
    """
    import struct
    import base64
    root = str(tmp_path)
    write_animated_pack(root)
    out = run("--root", root, "--namespace", "testns", "--icons", "thing")
    assert "thing" in out["icons"], out
    raw = base64.b64decode(out["icons"]["thing"]["png"])
    width, height = struct.unpack(">II", raw[16:24])
    assert (width, height) == (16, 16), (width, height)


def test_a_tall_texture_without_mcmeta_is_left_alone(tmp_path):
    """No `.mcmeta`, no animation.

    A 16x64 sprite with no metadata is not evidence of four frames.  Guessing
    "tall means animated" would chop a legitimately tall texture into frames
    that do not exist.
    """
    import io
    import struct
    import base64
    from PIL import Image
    root = str(tmp_path)
    image = Image.new("RGBA", (16, 64), (1, 2, 3, 255))
    out_bytes = io.BytesIO()
    image.save(out_bytes, "PNG")
    pack(root, "testns",
         models={"thing": {"textures": {"all": "blocks/thing"},
                           "elements": [{"from": [0, 0, 0], "to": [16, 16, 16],
                                         "faces": {"up": {"texture": "#all"}}}]}},
         blockstates={"thing": {"variants": {"": {"model": "thing"}}}},
         textures={"blocks/thing": out_bytes.getvalue()})
    out = run("--root", root, "--block", "testns:thing")
    assert out["animations"] == {}, out["animations"]
    raw = base64.b64decode(out["textures"]["testns:blocks/thing"])
    width, height = struct.unpack(">II", raw[16:24])
    assert (width, height) == (16, 64), (width, height)


def test_variant_rotation_is_reported_for_the_consumer_to_apply(tmp_path):
    """The blockstate's own x/y must reach the consumer, unapplied.

    It cannot be baked into `from`/`to` here: a model element may carry its own
    `rotation`, which Minecraft applies in model space BEFORE the variant
    rotation, so rotating the raw corners would put the two in the wrong order
    for every cross/stairs model.  The consumer applies this last.
    """
    root = str(tmp_path)
    pack(root, "testns",
         models={"thing": {"textures": {"all": "blocks/thing"},
                           "elements": [{"from": [0, 0, 0], "to": [16, 16, 16],
                                         "faces": {"up": {"texture": "#all"}}}]}},
         blockstates={"thing": {"variants": {"axis=y": {"model": "thing"},
                                             "axis=x": {"model": "thing", "x": 90, "y": 90}}}},
         textures={"blocks/thing": PNG})
    upright = run("--root", root, "--block", "testns:thing", "--variant", "axis=y")
    assert upright["variant"] == "axis=y", upright["variant"]
    assert upright["variantRotation"] is None, upright["variantRotation"]
    assert upright["variantKeys"] == ["axis=x", "axis=y"], upright["variantKeys"]
    lying = run("--root", root, "--block", "testns:thing", "--variant", "axis=x")
    assert lying["variant"] == "axis=x", lying["variant"]
    assert lying["variantRotation"] == {"x": 90, "y": 90, "uvlock": False}, lying["variantRotation"]
    # and the geometry handed over is the SAME either way -- proof this is the
    # consumer's job and not a silent half-rotation on this side
    assert lying["models"]["__baked__"]["elements"] == upright["models"]["__baked__"]["elements"]


def test_an_unknown_variant_falls_back_instead_of_failing(tmp_path):
    """The list came from an earlier call; the pack can change under it."""
    root = str(tmp_path)
    pack(root, "testns",
         models={"thing": {"textures": {"all": "blocks/thing"},
                           "elements": [{"from": [0, 0, 0], "to": [16, 16, 16],
                                         "faces": {"up": {"texture": "#all"}}}]}},
         blockstates={"thing": {"variants": {"normal": {"model": "thing"}}}},
         textures={"blocks/thing": PNG})
    out = run("--root", root, "--block", "testns:thing", "--variant", "facing=east")
    assert "error" not in out, out
    assert out["variant"] == "normal", out["variant"]


def test_list_is_sorted_and_named(tmp_path):
    root = str(tmp_path)
    pack(root, "testns",
         models={}, blockstates={"b": {"variants": {}}, "a": {"variants": {}}}, textures={},
         lang={"zh_cn": {"tile.A.name": "甲"}})
    out = run("--root", root, "--list", "--namespace", "testns")
    assert [b["id"] for b in out["blocks"]] == ["a", "b"]
    assert out["blocks"][0]["name"] == "甲"
    assert out["blocks"][1]["name"] == "b", "没有键就该退回 id，而不是编一个"


# --------------------------------------------------------------------------
# real jars: the rules above, checked against the packs on this disk
# --------------------------------------------------------------------------

@needs_real
def test_real_vanilla_oak_log():
    out = run("--root", REAL_ROOT, "--block", "minecraft:oak_log")
    assert "error" not in out, out
    assert out["name"] == "橡木原木"
    assert out["variant"] == "axis=y", "1.12.2 的柱子应当竖着画"
    assert out["missingTextures"] == []
    # oak_log -> cube_column -> cube -> block
    assert len(out["models"]) >= 4, list(out["models"])
    # The textures are named log_oak / log_oak_top, NOT oak_log: a resolver that
    # guessed the texture from the block id would find nothing here.
    assert len(out["textures"]) == 2, list(out["textures"])


@needs_real
def test_real_vanilla_blocks_have_chinese_names():
    for block, expected in (("dirt", "泥土"), ("stone", "石头"), ("grass", "草"), ("glass", "玻璃")):
        out = run("--root", REAL_ROOT, "--block", "minecraft:" + block)
        assert out["name"] == expected, (block, out["name"], out["nameKey"])


@needs_real
@pytest.mark.skipif(not os.path.isfile(REAL_MOD_JAR), reason="没有 AoA3")
def test_real_mod_block():
    out = run("--root", REAL_ROOT, "--block", "aoa3:achony_log")
    assert "error" not in out, out
    assert out["name"] == "桉格尼木", (out["name"], out["nameKey"])
    assert out["missingTextures"] == []
    assert len(out["textures"]) == 2
    # The mod does not ship block/cube_column, so this only resolves if the
    # parent fell through to the vanilla jar.
    assert len(out["models"]) >= 4, list(out["models"])


@needs_real
def test_real_list_covers_vanilla():
    out = run("--root", REAL_ROOT, "--list", "--namespace", "minecraft")
    ids = {b["id"] for b in out["blocks"]}
    assert {"oak_log", "dirt", "stone", "glass"} <= ids
    named = sum(1 for b in out["blocks"] if b["name"] != b["id"])
    # Not every technical block is translated, but the overwhelming majority is.
    assert named > 0.75 * len(out["blocks"]), "%d/%d named" % (named, len(out["blocks"]))


@needs_real
def test_real_probe_reports_why(tmp_path):
    out = run("--root", REAL_ROOT, "--probe")
    assert out["version"] == REAL_VERSION, out["version"]
    assert out["versionWhy"], "选版本的理由必须说出来"
    assert "aoa3" in out["namespaces"]


def test_object_store_is_not_an_extracted_pack(tmp_path):
    """<root>/assets/objects is the hashed store, not a resource tree.

    Treating any root with an `assets/` folder as an extracted pack meant a game
    directory got a directory provider rooted at the whole installation, so every
    name lookup walked saves/, libraries/ and the entire object store.  A single
    block took 60 seconds and timed out.  This pins the guard.
    """
    root = str(tmp_path)
    for index in range(40):
        write_bytes(os.path.join(root, "assets", "objects", "ab", "hash%02d" % index), b"x")
    write(os.path.join(root, "assets", "indexes", "1.12.json"), json.dumps({"objects": {}}))
    out = run("--root", root, "--probe")
    kinds = {p["kind"] for p in out["providers"]}
    assert "dir" not in kinds, "对象仓库被当成了资源树：%s" % out["providers"]


@needs_real
def test_real_animated_block_ships_a_playable_strip():
    """sea_lantern is animated in 1.12.2 and must arrive as 5 frames, not one.

    A real pack, so this fails if the frame rules only hold for my synthetic
    one: the strip is 16x80, the metadata says frametime 5.
    """
    import struct
    import base64
    out = run("--root", REAL_ROOT, "--block", "minecraft:sea_lantern")
    assert "error" not in out, out
    animation = out["animations"].get("minecraft:blocks/sea_lantern")
    assert animation is not None, out["animatedTextures"]
    assert animation["frames"] == 5, animation
    assert animation["frametime"] == 5, animation
    raw = base64.b64decode(out["textures"]["minecraft:blocks/sea_lantern"])
    assert struct.unpack(">II", raw[16:24]) == (16, 80)
    # the icon path must still hand over a single square
    icons = run("--root", REAL_ROOT, "--namespace", "minecraft", "--icons", "sea_lantern")
    assert "sea_lantern" in icons["icons"], icons
    icon = base64.b64decode(icons["icons"]["sea_lantern"]["png"])
    assert struct.unpack(">II", icon[16:24]) == (16, 16)


@needs_real
def test_real_oak_log_variants_match_the_vanilla_blockstate():
    """The rotation convention is checked against the game's own file.

    `axis=z` is `x: 90` and `axis=x` is `x: 90, y: 90`; whatever the consumer
    does with them, these are the numbers it must be handed.
    """
    upright = run("--root", REAL_ROOT, "--block", "minecraft:oak_log", "--variant", "axis=y")
    assert upright["variantRotation"] is None, upright["variantRotation"]
    zed = run("--root", REAL_ROOT, "--block", "minecraft:oak_log", "--variant", "axis=z")
    assert zed["variantRotation"]["x"] == 90, zed["variantRotation"]
    assert zed["variantRotation"]["y"] == 0, zed["variantRotation"]
    exed = run("--root", REAL_ROOT, "--block", "minecraft:oak_log", "--variant", "axis=x")
    assert exed["variantRotation"] == {"x": 90, "y": 90, "uvlock": False}, exed["variantRotation"]
    assert upright["variantKeys"] == ["axis=none", "axis=x", "axis=y", "axis=z"], upright["variantKeys"]


@needs_real
def test_real_furnace_facing_is_the_discriminator():
    """furnace is why the y sign is what it is.

    Its model puts the front face on the NORTH side, and `facing=east` is
    `y: 90`.  A log is symmetric so it cannot settle the sign; this can.
    """
    out = run("--root", REAL_ROOT, "--block", "minecraft:furnace", "--variant", "facing=east")
    assert out["variantRotation"] == {"x": 0, "y": 90, "uvlock": False}, out["variantRotation"]
    north = run("--root", REAL_ROOT, "--block", "minecraft:furnace", "--variant", "facing=north")
    assert north["variantRotation"] is None, north["variantRotation"]


def test_forge_defaults_supply_textures_to_a_variant_that_names_a_model(tmp_path):
    """The shape that made simpleores:copper_block draw nothing at all.

    `forge_marker` keeps a shared `defaults` block for the model AND its
    textures, and a variant may name only the model:

        {"forge_marker": 1,
         "defaults": {"textures": {"all": "testns:blocks/copper"}},
         "variants": {"normal": {"model": "cube_all"}}}

    `cube_all`'s entire texture table IS `#all`, so without merging `defaults`
    every face resolved to nothing -- `missingTextures` filled up with "#all"
    six times and the block drew as an empty cell.
    """
    root = str(tmp_path)
    pack(root, "testns",
         models={},
         blockstates={"copper": {"forge_marker": 1,
                                 "defaults": {"textures": {"all": "testns:blocks/copper"}},
                                 "variants": {"normal": {"model": "cube_all"}}}},
         textures={"blocks/copper": PNG})
    pack(root, "minecraft",
         models={"cube_all": {"parent": "block/cube", "textures": {"particle": "#all"}},
                 "cube": {"textures": {"particle": "#down", "down": "#down", "up": "#up",
                                       "north": "#north", "south": "#south",
                                       "west": "#west", "east": "#east"},
                          "elements": CUBE["elements"]}},
         blockstates={}, textures={})
    out = run("--root", root, "--block", "testns:copper")
    assert "error" not in out, out
    assert out["missingTextures"] == [], out["missingTextures"]
    baked = out["models"]["__baked__"]
    assert baked["elements"], baked
    # The face keeps the ALIAS -- the consumer dereferences `#all` against this
    # same table -- but the table must now say where `all` actually comes from.
    assert baked["textures"]["all"] == "testns:blocks/copper", baked["textures"]
    assert out["textures"].get("testns:blocks/copper"), list(out["textures"])


def test_the_variant_beats_defaults_on_textures(tmp_path):
    """Defaults are a default, not an override."""
    root = str(tmp_path)
    pack(root, "testns",
         models={},
         blockstates={"thing": {"forge_marker": 1,
                                "defaults": {"textures": {"all": "testns:blocks/plain"}},
                                "variants": {"normal": {"model": "cube_all",
                                                        "textures": {"all": "testns:blocks/fancy"}}}}},
         textures={"blocks/plain": PNG})
    pack(root, "minecraft",
         models={"cube_all": {"parent": "block/cube", "textures": {"particle": "#all"}},
                 "cube": {"textures": {"down": "#down", "up": "#up", "north": "#north",
                                       "south": "#south", "west": "#west", "east": "#east"},
                          "elements": CUBE["elements"]}},
         blockstates={}, textures={})
    pack(root, "testns", models={}, blockstates={}, textures={"blocks/fancy": PNG})
    out = run("--root", root, "--block", "testns:thing")
    assert "error" not in out, out
    assert out["missingTextures"] == [], out["missingTextures"]
    assert out["models"]["__baked__"]["textures"]["all"] == "testns:blocks/fancy", \
        out["models"]["__baked__"]["textures"]


@needs_real
def test_real_simpleores_copper_is_not_blank():
    """The pack the user hit it on.  Without the defaults merge this reports a
    missing `#all` six times and no usable texture at all."""
    out = run("--root", REAL_ROOT, "--block", "simpleores:copper_block")
    if "error" in out and "没有这个方块" in str(out["error"]):
        pytest.skip("这台机器上没有 simpleores")
    assert "error" not in out, out
    assert out["missingTextures"] == [], out["missingTextures"]
    assert out["textures"], "一个贴图都没有抽出来"


def test_variant_axes_separate_the_questions_from_the_combinations(tmp_path):
    """Two independent properties must be reported as TWO properties.

    A command block's twelve `conditional=<bool>,facing=<dir>` keys are not
    twelve choices, they are two questions (2 x 6).  Printing the keys is what
    put eleven `conditional=false,facing=...` labels in front of the user.
    """
    root = str(tmp_path)
    variants = {}
    for conditional in ("false", "true"):
        for facing in ("down", "north", "east"):
            variants["conditional=%s,facing=%s" % (conditional, facing)] = {"model": "thing"}
    pack(root, "testns",
         models={"thing": {"textures": {"all": "blocks/thing"},
                           "elements": [{"from": [0, 0, 0], "to": [16, 16, 16],
                                         "faces": {"up": {"texture": "#all"}}}]}},
         blockstates={"thing": {"variants": variants}},
         textures={"blocks/thing": PNG})
    out = run("--root", root, "--block", "testns:thing")
    assert out["variantAxes"] == [
        {"name": "conditional", "values": ["false", "true"]},
        {"name": "facing", "values": ["down", "east", "north"]},
    ], out["variantAxes"]
    assert len(out["variantKeys"]) == 6, out["variantKeys"]


def test_a_variant_key_written_in_another_order_still_resolves(tmp_path):
    """The consumer composes `name=value` pairs; the pack may order them another way.

    Matching the raw string would call a perfectly valid choice invalid.
    """
    root = str(tmp_path)
    pack(root, "testns",
         models={"thing": {"textures": {"all": "blocks/thing"},
                           "elements": [{"from": [0, 0, 0], "to": [16, 16, 16],
                                         "faces": {"up": {"texture": "#all"}}}]}},
         # the pack writes facing FIRST
         blockstates={"thing": {"variants": {
             "facing=north,conditional=false": {"model": "thing"},
             "facing=south,conditional=true": {"model": "thing", "y": 180}}}},
         textures={"blocks/thing": PNG})
    out = run("--root", root, "--block", "testns:thing", "--variant", "conditional=true,facing=south")
    assert "error" not in out, out
    assert out["variant"] == "conditional=true,facing=south", out["variant"]
    assert out["variantRotation"] == {"x": 0, "y": 180, "uvlock": False}, out["variantRotation"]
    # and the reported keys are the canonical spelling of the pack's own keys
    assert out["variantKeys"] == ["conditional=false,facing=north", "conditional=true,facing=south"], out["variantKeys"]


def test_the_default_variant_avoids_neighbour_dependent_shapes(tmp_path):
    """`shape=inner_right` is a statement about the block NEXT to it.

    Picking it as the default made a staircase open as a corner purely because
    `i` sorts before `s` -- and a corner is not what you get standing alone.
    """
    root = str(tmp_path)
    pack(root, "testns",
         models={"thing": {"textures": {"all": "blocks/thing"},
                           "elements": [{"from": [0, 0, 0], "to": [16, 16, 16],
                                         "faces": {"up": {"texture": "#all"}}}]}},
         blockstates={"thing": {"variants": {
             "facing=east,half=bottom,shape=inner_right": {"model": "thing"},
             "facing=east,half=bottom,shape=outer_left": {"model": "thing"},
             "facing=east,half=bottom,shape=straight": {"model": "thing"}}}},
         textures={"blocks/thing": PNG})
    out = run("--root", root, "--block", "testns:thing")
    assert out["variant"] == "facing=east,half=bottom,shape=straight", out["variant"]


@needs_real
def test_real_command_block_reports_two_axes():
    """The block the user actually asked about."""
    out = run("--root", REAL_ROOT, "--block", "minecraft:command_block")
    assert "error" not in out, out
    axes = {axis["name"]: axis["values"] for axis in out["variantAxes"]}
    assert set(axes.keys()) == {"conditional", "facing"}, out["variantAxes"]
    assert axes["conditional"] == ["false", "true"], axes
    assert len(axes["facing"]) == 6, axes
    assert len(out["variantKeys"]) == 12, len(out["variantKeys"])
    # conditional is not an orientation and must not be the thing that varies
    assert out["variant"] == "conditional=false,facing=north", out["variant"]


@needs_real
def test_real_stairs_are_three_questions_not_forty_buttons():
    out = run("--root", REAL_ROOT, "--block", "minecraft:oak_stairs")
    assert "error" not in out, out
    axes = {axis["name"]: axis["values"] for axis in out["variantAxes"]}
    assert set(axes.keys()) == {"facing", "half", "shape"}, axes
    assert len(out["variantKeys"]) == 40, len(out["variantKeys"])
    assert out["variant"] == "facing=east,half=bottom,shape=straight", out["variant"]


# --------------------------------------------------------------------------
# several roots: a project pack plus the vanilla reference it inherits from
# --------------------------------------------------------------------------

def test_a_project_pack_resolves_the_vanilla_parent_it_inherits(tmp_path):
    """A project model is usually a thin child of a vanilla parent.

    `eyeball_log` is `{"parent": "block/cube_column", ...}` and `cube_column`
    lives in the version jar, not in the project.  One root therefore finds no
    `elements` anywhere and reports "这个方块没有几何模型" -- true of that chain,
    misleading about the block.  Two roots, the pack first.
    """
    project = str(tmp_path / "project")
    game = str(tmp_path / "game")
    pack(project, "testns",
         models={"thing": {"parent": "block/cube_column",
                           "textures": {"end": "testns:blocks/thing_top",
                                        "side": "testns:blocks/thing"}}},
         blockstates={"thing": {"variants": {"": {"model": "testns:block/thing"}}}},
         textures={"blocks/thing": PNG, "blocks/thing_top": PNG})
    # The reference supplies the geometry and refers to `#end`/`#side`; the child
    # supplies those two names.  That is the real shape, and the reason the child
    # cannot be read alone.
    pack(game, "minecraft",
         models={"cube_column": {"textures": {"particle": "#side"},
                                 "elements": [{"from": [0, 0, 0], "to": [16, 16, 16],
                                               "faces": {"up": {"texture": "#end"},
                                                         "down": {"texture": "#end"},
                                                         "north": {"texture": "#side"},
                                                         "south": {"texture": "#side"},
                                                         "west": {"texture": "#side"},
                                                         "east": {"texture": "#side"}}}]}},
         blockstates={}, textures={})

    # The pack alone is no longer a dead end: the built-in table has the seven
    # vanilla bases, and using one is reported (`内置:`), so a reader can tell a
    # jar-read parent from a table one.
    alone = run("--root", project, "--block", "testns:thing")
    assert "error" not in alone, alone
    assert any(str(name).startswith("内置:") for name in alone["missingModels"]), \
        alone["missingModels"]

    together = run("--root", project, "--root", game, "--block", "testns:thing")
    assert "error" not in together, together
    # With the game root present, nothing comes from the table.
    assert not any(str(name).startswith("内置:") for name in together["missingModels"]), \
        together["missingModels"]
    assert together["missingTextures"] == [], together["missingTextures"]
    baked = together["models"]["__baked__"]
    assert baked["elements"], baked
    assert "minecraft:block/cube_column" in together["models"], list(together["models"])
    # and the project's own texture wins over anything the reference might have
    assert together["models"]["__baked__"]["textures"]["side"] == "testns:blocks/thing", \
        together["models"]["__baked__"]["textures"]


def test_the_first_root_wins_a_lookup(tmp_path):
    """Order is the whole point: the project's own file must beat the reference.

    Both roots ship `testns:block/thing`.  Reading them in the wrong order would
    silently serve vanilla's cube where the project's log was meant.
    """
    first = str(tmp_path / "first")
    second = str(tmp_path / "second")
    pack(first, "testns",
         models={"thing": {"textures": {"all": "testns:blocks/mine"},
                           "elements": CUBE["elements"]}},
         blockstates={"thing": {"variants": {"": {"model": "thing"}}}},
         textures={"blocks/mine": PNG})
    pack(second, "testns",
         models={"thing": {"textures": {"all": "testns:blocks/theirs"},
                           "elements": CUBE["elements"]}},
         blockstates={"thing": {"variants": {"": {"model": "thing"}}}},
         textures={"blocks/theirs": PNG})
    out = run("--root", first, "--root", second, "--block", "testns:thing")
    assert "error" not in out, out
    assert out["models"]["__baked__"]["textures"]["all"] == "testns:blocks/mine", \
        out["models"]["__baked__"]["textures"]
    backwards = run("--root", second, "--root", first, "--block", "testns:thing")
    assert backwards["models"]["__baked__"]["textures"]["all"] == "testns:blocks/theirs", \
        backwards["models"]["__baked__"]["textures"]


def test_one_root_behaves_exactly_as_before(tmp_path):
    """The multi-root path must be invisible when there is only one root."""
    root = str(tmp_path)
    pack(root, "testns",
         models={"thing": {"textures": {"all": "blocks/thing"},
                           "elements": CUBE["elements"]}},
         blockstates={"thing": {"variants": {"a": {"model": "thing"},
                                             "b": {"model": "thing", "y": 90}}}},
         textures={"blocks/thing": PNG})
    out = run("--root", root, "--block", "testns:thing")
    assert "error" not in out, out
    assert out["variantKeys"] == ["a", "b"], out["variantKeys"]
    probe = run("--root", root, "--probe")
    assert "providers" in probe, probe


@needs_real
def test_real_project_block_through_its_vanilla_parent():
    """The live case: our own log, read together with the reference it inherits.

    Also the answer to "does our log have an orientation": it does not, and the
    tool says so with `variantAxes == []` rather than leaving it to be guessed.
    """
    if not os.path.isdir(PROJECT_PACK):
        pytest.skip("这台机器上没有 eyeball_tree/pack")
    out = run("--root", PROJECT_PACK, "--root", REAL_ROOT, "--block", "eyeballtree:eyeball_log")
    assert "error" not in out, out
    assert out["missingTextures"] == [], out["missingTextures"]
    assert "minecraft:block/cube_column" in out["models"], list(out["models"])
    assert out["variantAxes"] == [], out["variantAxes"]
    assert out["name"] == "眼球原木", out["name"]


# --------------------------------------------------------------------------
# multipart (blockstates with no `variants` at all -- 1.12.2 has them too:
# cobblestone_wall and glass_pane are multipart, with boolean sides instead of low/tall)
# --------------------------------------------------------------------------
WALL_SIDES = [{"apply": {"model": "post"}}] + [
    {"apply": {"model": "side", "y": degrees, "uvlock": True}}
    for degrees in (0, 90, 180, 270)]


def multipart_pack(root, blockstate, models=None):
    pack(root, "testns",
         models=models or {"post": CUBE, "side": CUBE},
         blockstates={"thing": blockstate},
         textures={"blocks/thing": PNG})


def test_a_multipart_block_hands_over_every_apply_with_its_own_rotation(tmp_path):
    """Walls, fences and paned glass have no variant table -- only `apply` lists.

    Each apply carries its OWN y rotation, so they cannot be folded into one
    model: `prismarine_wall` is a post plus four sides at 0/90/180/270, and
    baking those into one element list would draw all four in the same
    direction.  They travel as separate refs and the consumer rotates each one.
    """
    root = str(tmp_path)
    multipart_pack(root, {"multipart": WALL_SIDES})
    out = run("--root", root, "--block", "testns:thing")
    assert "error" not in out, out
    assert out["multipart"] is True, out
    assert out["modelRefs"] == ["post", "side", "side", "side", "side"], out["modelRefs"]
    assert out["modelRotations"] == [{"x": 0, "y": 0}, {"x": 0, "y": 0}, {"x": 0, "y": 90},
                                     {"x": 0, "y": 180}, {"x": 0, "y": 270}], out["modelRotations"]
    # The blockstate-level rotation is applied LAST to the finished quads, so it
    # must stay out of the way here -- the four sides are already placed.
    assert out["variantRotation"] is None, out["variantRotation"]
    assert out["noGeometry"] is False, out
    # One model cannot carry four rotations, so nothing may be baked.
    assert "__baked__" not in out["models"], list(out["models"])


def test_multipart_with_no_elements_anywhere_still_says_so(tmp_path):
    """The honest failure stays honest.

    A block with no geometry must keep reporting "no geometry" -- the multipart
    path may not turn that into a silent empty model just because it gave up on
    baking.  This is the shape that used to make every wall read as "rendered in
    code by a block entity".
    """
    root = str(tmp_path)
    multipart_pack(root, {"multipart": [{"apply": {"model": "hollow"}}]},
                   models={"hollow": {"textures": {"all": "blocks/thing"}}})
    out = run("--root", root, "--block", "testns:thing")
    assert out["noGeometry"] is True, out
    assert "没有几何模型" in out.get("error", ""), out.get("error")


def test_a_repeated_apply_is_drawn_once(tmp_path):
    """A guard, not a fix: 1.18.2 never repeats one.

    Measured on fire, walls, fences and panes -- every apply is already
    distinct, so this drops nothing today.  The same model at the same rotation
    IS the same geometry, though, and the strict depth test would throw the
    second copy away anyway.
    """
    root = str(tmp_path)
    multipart_pack(root, {"multipart": [{"apply": {"model": "side"}},
                                        {"apply": {"model": "side"}},
                                        {"apply": [{"model": "side", "y": 90}]},
                                        {"apply": [{"model": "side", "y": 90}]}]})
    out = run("--root", root, "--block", "testns:thing")
    assert out["modelRefs"] == ["side", "side"], out["modelRefs"]
    assert out["modelRotations"] == [{"x": 0, "y": 0}, {"x": 0, "y": 90}], out["modelRotations"]


def test_the_variant_path_is_not_multipart(tmp_path):
    """A `variants` blockstate must behave exactly as it did before.

    One baked model, no per-apply rotations, and `multipart: false` so the
    consumer's one-model path is not even considered.
    """
    root = str(tmp_path)
    pack(root, "testns", models={"thing": CUBE},
         blockstates={"thing": {"variants": {"": {"model": "thing"}}}},
         textures={"blocks/thing": PNG})
    out = run("--root", root, "--block", "testns:thing")
    assert out["multipart"] is False, out
    assert out["modelRefs"] == ["__baked__"], out["modelRefs"]
    assert out["modelRotations"] == [], out["modelRotations"]
    assert out["multipartWhens"] == [], out["multipartWhens"]


# --------------------------------------------------------------------------
# multipart `when` clauses: they are what makes the approximation avoidable
# --------------------------------------------------------------------------
def test_multipart_whens_travel_beside_the_refs(tmp_path):
    """Each apply's `when`, parallel to `modelRefs`, is what a consumer needs.

    Without it the consumer can only draw the union of every apply -- a wall
    showing four sides where the game would show one.  With it, a consumer that
    knows the neighbours can draw exactly what the game would.
    """
    root = str(tmp_path)
    multipart_pack(root, {"multipart": [
        {"when": {"up": "true"}, "apply": {"model": "post"}},
        {"when": {"north": "low"}, "apply": {"model": "side"}},
        {"when": {"north": "tall"}, "apply": {"model": "side", "y": 90}},
    ]})
    out = run("--root", root, "--block", "testns:thing")
    assert out["multipart"] is True, out
    assert len(out["multipartWhens"]) == len(out["modelRefs"]), out
    assert out["multipartWhens"] == [{"up": "true"}, {"north": "low"}, {"north": "tall"}], out["multipartWhens"]
    # The refs and the clauses must describe the SAME apply: `modelRefs` stays in
    # file order and so does this, which is the invariant the consumer relies on.
    assert out["modelRefs"] == ["post", "side", "side"], out["modelRefs"]
    assert out["modelRotations"] == [{"x": 0, "y": 0}, {"x": 0, "y": 0}, {"x": 0, "y": 90}], out["modelRotations"]


def test_every_apply_brings_its_own_texture(tmp_path):
    """A multipart blockstate may name a DIFFERENT model per apply.

    Measured: 1.18.2's `prismarine_wall` is a post model plus a side model plus a
    tall-side model, three separate files.  `elements_of` returns ONE element
    list -- the rule for a single model chain -- so collecting the referenced
    textures from it shipped only the first apply's texture.  The consumer then
    resolved the post and silently dropped every side: a wall drawn as a thin
    column, with no error anywhere.  Same shape as the shared `ref:` handle bug --
    invisible on the first piece, only on the second.
    """
    root = str(tmp_path)
    other = PNG + b"a different picture"
    def piece(tex):
        return {"textures": {"all": tex},
                "elements": [{"from": [0, 0, 0], "to": [16, 16, 16],
                              "faces": {"up": {"texture": "#all"}}}]}
    pack(root, "testns",
         models={"post": piece("blocks/post_tex"), "side": piece("blocks/side_tex")},
         blockstates={"thing": {"multipart": [
             {"when": {"up": "true"}, "apply": {"model": "post"}},
             {"when": {"north": "low"}, "apply": {"model": "side"}}]}},
         textures={"blocks/post_tex": PNG, "blocks/side_tex": other})
    out = run("--root", root, "--block", "testns:thing")
    assert out["modelRefs"] == ["post", "side"], out["modelRefs"]
    assert sorted(out["textures"]) == ["testns:blocks/post_tex", "testns:blocks/side_tex"], \
        sorted(out["textures"])
    assert out["missingTextures"] == [], out["missingTextures"]
    # 两张图必须真的是两张：如果两条 apply 都解到了第一个模型那张，#all 会在
    # 合并表里被解成同一个名字，而这里立刻就能看出来。
    import base64
    first = out["textures"]["testns:blocks/post_tex"]
    second = out["textures"]["testns:blocks/side_tex"]
    assert first != second, "两条 apply 拿到了同一张图"
    assert base64.b64decode(first) == PNG
    assert base64.b64decode(second) == other


def test_boolean_when_values_arrive_as_strings(tmp_path):
    """`"north": true` and `"north": "true"` must both come out as `'true'`.

    Measured in the real packs: 1.18.2's `prismarine_wall` writes `"up": "true"`
    and its `glass_pane` writes `"north": true` in the SAME version, and 1.12.2
    does the same thing.  Two spellings, one meaning -- so the consumer compares
    strings and never has to know which pack wrote which.
    """
    root = str(tmp_path)
    multipart_pack(root, {"multipart": [
        {"when": {"up": True}, "apply": {"model": "post"}},
        {"when": {"north": "true"}, "apply": {"model": "side"}},
        {"when": {"east": False}, "apply": [{"model": "side", "y": 90}]},
    ]})
    out = run("--root", root, "--block", "testns:thing")
    assert out["multipartWhens"] == [{"up": "true"}, {"north": "true"}, {"east": "false"}], out["multipartWhens"]


def test_an_apply_with_no_when_is_drawn_always(tmp_path):
    """`{}` is not "never" -- it is "whenever the block is drawn at all".

    1.18.2's `glass_pane` post is exactly this, so treating a missing clause as
    "don't draw" would delete the post from every pane.
    """
    root = str(tmp_path)
    multipart_pack(root, {"multipart": [
        {"apply": {"model": "post"}},
        {"when": {"north": "true"}, "apply": {"model": "side"}},
    ]})
    out = run("--root", root, "--block", "testns:thing")
    assert out["multipartWhens"] == [{}, {"north": "true"}], out["multipartWhens"]



# --------------------------------------------------------------------------
# items, entities, and the blocks the game draws in code
#
# A resource pack carries no entity or block-entity geometry: those are Java
# classes.  What it does carry is names, textures, the mod's own grouping, and
# -- for the GeckoLib family -- real box data.  These three tests pin the scan
# that tells those apart, because the alternative is a viewer that shows an
# empty box for a chest and blames itself.
# --------------------------------------------------------------------------
def item_pack(root):
    """A tiny pack with the three presentation forms that actually differ."""
    models = {
        "apple": {"parent": "item/generated", "textures": {"layer0": "item/apple"}},
        "sword": {"parent": "item/handheld", "textures": {"layer0": "item/sword"}},
        "helmet": {"parent": "item/generated", "textures": {"layer0": "item/helmet"}},
        "egg": {"parent": "item/template_spawn_egg",
                "textures": {"layer0": "item/egg", "layer1": "item/egg_overlay"}},
        "stone": {"parent": "block/stone"},
        "generated": {"parent": "builtin/generated", "display": {"gui": {
            "rotation": [0, 0, 0], "translation": [0, 0, 0], "scale": [1, 1, 1]}}},
        "handheld": {"parent": "item/generated"},
        "template_spawn_egg": {"parent": "item/generated"},
    }
    blocks = {
        "stone": {"variants": {"": {"model": "stone"}}},
        "sign": {"variants": {"": {"model": "sign"}}},          # no elements: a block entity
    }
    block_models = {
        # Vanilla's chain is `item/stone` -> `block/stone` -> `block/cube_all` ->
        # `block/block`, and the GUI matrix lives on `block/block`.  The texture
        # table is a real path: `CUBE`'s own `#all -> #all` is a placeholder the
        # other tests never ask to resolve.
        "stone": dict(CUBE, parent="block/block", textures={"all": "blocks/thing"}),
        "sign": {"textures": {"particle": "blocks/thing"}},
        "block": {"display": {"gui": {"rotation": [30, 225, 0], "translation": [0, 0, 0],
                                     "scale": [0.625, 0.625, 0.625]}}},
    }
    base = os.path.join(root, "assets", "testns")
    write(os.path.join(base, "lang", "zh_cn.json"),
          json.dumps({"item.testns.apple": "苹果", "item.testns.sword": "剑",
                      "entity.testns.zombie": "僵尸", "entity.testns.fiend": "恶魔",
                      "entity.testns.armor_stand": "盔甲架"}))
    pack(root, "testns", models=block_models, blockstates=blocks,
         textures={"item/apple": PNG, "item/sword": PNG, "item/helmet": PNG,
                   "item/egg": PNG, "item/egg_overlay": PNG,
                   "blocks/thing": PNG, "entity/signs/oak.png": PNG})
    # `pack` files every model under `models/block/`; item models live in
    # `models/item/`, and that folder IS the item registry the scan reads.
    for name, body in models.items():
        write(os.path.join(base, "models", "item", name + ".json"), json.dumps(body))
    # An item model's parent `block/stone` has to exist in the SAME namespace
    # walk, so it is written as a model too (above), and the block entry gives
    # the iso shape its elements.


def test_items_travel_with_their_presentation_form(tmp_path):
    """A block item is an ISOMETRIC 3D icon; a generated item is flat layers.

    This is the difference the viewer has to act on, and it is read from the
    model chain, not guessed from the name: `item/stone` parents to a block
    model (elements -> draw it with the GUI matrix and the side lighting),
    `item/apple` parents to `builtin/generated` (no elements, `layer0` -> draw
    the sprites stacked, lit from the front).
    """
    root = str(tmp_path)
    item_pack(root)
    out = run("--root", root, "--list", "--namespace", "testns", "--kind", "item")
    by_id = {item["id"]: item for item in out["items"]}
    # `models/item/` also holds the PARENTS (`generated`, `handheld`,
    # `template_spawn_egg`), exactly as vanilla ships them; they are reported but
    # marked, because a picker full of "generated / handheld" is noise.
    assert {item["id"] for item in out["items"] if not item["parentOnly"]} == \
        {"apple", "sword", "helmet", "egg", "stone"}, sorted(by_id)
    assert by_id["handheld"]["parentOnly"] is True, by_id["handheld"]
    assert by_id["apple"]["parentOnly"] is False, by_id["apple"]

    assert by_id["apple"]["shape"] == "flat", by_id["apple"]
    assert by_id["apple"]["light"] == "front", by_id["apple"]
    assert by_id["apple"]["layers"] == ["item/apple"], by_id["apple"]["layers"]
    assert by_id["apple"]["name"] == "苹果", by_id["apple"]
    assert by_id["apple"]["form"] == "item", by_id["apple"]

    # `item/handheld` is the game's own marker for a tool: same flat drawing,
    # different family.
    assert by_id["sword"]["form"] == "tool", by_id["sword"]
    assert by_id["sword"]["family"] == "剑", by_id["sword"]

    assert by_id["helmet"]["form"] == "armour", by_id["helmet"]
    assert by_id["egg"]["form"] == "egg", by_id["egg"]
    assert by_id["egg"]["layers"] == ["item/egg", "item/egg_overlay"], by_id["egg"]["layers"]

    # The block item: elements, the side lighting, and the GUI matrix the icon
    # is drawn with -- READ from `block/block`'s own `display.gui`.
    assert by_id["stone"]["shape"] == "iso", by_id["stone"]
    assert by_id["stone"]["light"] == "side", by_id["stone"]
    assert by_id["stone"]["elements"] == 1, by_id["stone"]
    assert by_id["stone"]["display"]["rotation"] == [30, 225, 0], by_id["stone"]["display"]


def test_the_game_builtin_parent_is_not_a_missing_model(tmp_path):
    """`builtin/generated` is built into the game; no root can ever contain it.

    1.18.2's own `item/generated` declares `parent: builtin/generated`, and there
    is no such JSON in the jar, in a pack or in a mod -- the game makes it in
    code.  Recording it in `missing` made the panel print
    "模型链缺 minecraft:builtin/generated" under EVERY flat item; the user saw it
    under the 3D view and asked what it was doing there.  A warning about
    something that is neither wrong nor fixable is worse than no warning.

    `apple` walks exactly that chain here: apple -> item/generated (in the pack)
    -> builtin/generated (nowhere).
    """
    root = str(tmp_path)
    item_pack(root)
    out = run("--root", root, "--list", "--namespace", "testns", "--kind", "item")
    by_id = {item["id"]: item for item in out["items"]}
    assert by_id["apple"]["shape"] == "flat", by_id["apple"]
    assert by_id["apple"]["missing"] == [], by_id["apple"]["missing"]
    # A parent that really is absent must STILL be reported: this is not a licence
    # to stop complaining about a broken chain.
    base = os.path.join(root, "assets", "testns", "models", "item")
    write(os.path.join(base, "broken.json"), json.dumps({"parent": "testns:block/nope"}))
    out2 = run("--root", root, "--list", "--namespace", "testns", "--kind", "item")
    broken = {item["id"]: item for item in out2["items"]}["broken"]
    assert broken["missing"] == ["testns:block/nope"], broken["missing"]


def test_entity_scan_reads_both_texture_spellings_grouping_and_geometry(tmp_path):
    """The four sources, and which one answered.

    `textures/entity/` (vanilla) and `textures/entities/` (AoA3) are both real;
    a mod's loot-table folders are its own grouping; and GeckoLib is the one
    family that ships geometry -- so `draw` is `geo` for exactly those.
    """
    root = str(tmp_path)
    item_pack(root)
    base = os.path.join(root, "assets", "testns")
    write_bytes(os.path.join(base, "textures", "entity", "zombie.png"), PNG)
    write_bytes(os.path.join(base, "textures", "entities", "ghost.png"), PNG)
    write_bytes(os.path.join(base, "textures", "entity", "armorstand", "wood.png"), PNG)
    write(os.path.join(base, "loot_tables", "entities", "mobs", "abyss", "fiend.json"),
          json.dumps({"pools": []}))
    write(os.path.join(base, "geo", "turret.geo.json"), json.dumps({
        "format_version": "1.12.0",
        "minecraft:geometry": [{"description": {"texture_width": 64, "texture_height": 64},
                                "bones": [{"name": "base", "pivot": [0, 0, 0]}]}]}))
    # Animation files are NOT geometry and live in their own folder (ars_nouveau:
    # `animations/<model>_<state>.geo.json`); they must not become entities.
    write(os.path.join(base, "animations", "turret_walk.geo.json"),
          json.dumps({"format_version": "1.8.0", "animations": {}}))

    out = run("--root", root, "--list", "--namespace", "testns", "--kind", "entity")
    by_id = {entity["id"]: entity for entity in out["entities"]}

    assert by_id["zombie"]["name"] == "僵尸", by_id["zombie"]
    assert by_id["zombie"]["nameSource"] == "lang", by_id["zombie"]
    assert by_id["fiend"]["name"] == "恶魔", by_id["fiend"]
    assert by_id["fiend"]["group"] == "mobs/abyss", by_id["fiend"]
    # Plural spelling: the texture-only candidate still shows up, and says so.
    assert by_id["ghost"]["nameSource"] == "texture", by_id["ghost"]
    assert by_id["ghost"]["textures"], by_id["ghost"]
    # Vanilla spells the folder `armorstand` and the entity `armor_stand`:
    # separators are not identity, and the file inside (`wood`) is a VARIANT of
    # that entity, not an entity of its own.
    assert "armorstand" not in by_id and "wood" not in by_id, sorted(by_id)
    assert by_id["armor_stand"]["name"] == "盔甲架", by_id["armor_stand"]
    assert any(name.endswith("armorstand/wood.png") for name in by_id["armor_stand"]["textures"]), \
        by_id["armor_stand"]["textures"]
    # GeckoLib: geometry present -> drawable; its animation file is not geometry.
    assert by_id["turret"]["draw"] == "geo", by_id["turret"]
    assert by_id["turret"]["geometry"]["bones"] == 1, by_id["turret"]
    assert by_id["turret"]["animations"] == ["assets/testns/animations/turret_walk.geo.json"], \
        by_id["turret"]["animations"]
    assert "turret_walk" not in by_id, sorted(by_id)
    # Everything else has to SAY why it cannot be drawn.
    assert by_id["zombie"]["draw"] == "code" and by_id["zombie"].get("why"), by_id["zombie"]


def test_code_drawn_blocks_are_reported_with_the_right_texture_hint(tmp_path):
    """A chest is a block entity: no elements anywhere, and the pack still knows
    the texture.  The hint must be the FAMILY+variANT pair, not every file whose
    name shares a word (`black_bed` is `bed/black.png`, not `cat/black.png`)."""
    root = str(tmp_path)
    item_pack(root)
    base = os.path.join(root, "assets", "testns")
    for name in ("bed/black.png", "bed/white.png", "cat/black.png", "signs/oak.png"):
        write_bytes(os.path.join(base, "textures", "entity", name), PNG)
    write(os.path.join(base, "blockstates", "black_bed.json"),
          json.dumps({"variants": {"": {"model": "black_bed"}}}))
    write(os.path.join(base, "models", "block", "black_bed.json"),
          json.dumps({"textures": {"particle": "blocks/thing"}}))
    write(os.path.join(base, "blockstates", "oak_sign.json"),
          json.dumps({"variants": {"": {"model": "oak_sign"}}}))
    write(os.path.join(base, "models", "block", "oak_sign.json"),
          json.dumps({"textures": {"particle": "blocks/thing"}}))

    out = run("--root", root, "--code-blocks", "--namespace", "testns")
    by_id = {block["id"]: block for block in out["blocks"]}
    assert "black_bed" in by_id and "oak_sign" in by_id, sorted(by_id)
    # `sign` from item_pack is a second one, and `stone` must NOT be here.
    assert "stone" not in by_id, sorted(by_id)
    bed_hints = [hint["texture"] for hint in by_id["black_bed"]["textures"]]
    assert bed_hints[0] == "assets/testns/textures/entity/bed/black.png", bed_hints
    assert "assets/testns/textures/entity/cat/black.png" not in bed_hints, bed_hints
    sign_hints = [hint["texture"] for hint in by_id["oak_sign"]["textures"]]
    assert sign_hints[0] == "assets/testns/textures/entity/signs/oak.png", sign_hints
    # `reason` is the PRIMARY evidence and `reasons` the whole list: a bed has
    # no elements at all, so that is what leads.
    assert by_id["black_bed"]["reason"] == "no-elements", by_id["black_bed"]
    assert by_id["black_bed"]["reasons"] == ["no-elements"], by_id["black_bed"]


def test_a_placeholder_cube_is_recognised_as_code_drawn(tmp_path):
    """The reported bug: a mod ships a plain cube because its real shape is code.

    `travelersbackpack:cake` and `ars_nouveau:alchemical_sourcelink` are both
    `{parent: block/cube_all, textures: {all: <stand-in>}}`, so drawing them
    faithfully produces "a cube wearing an entity texture".  The pack says so --
    their ITEM models parent to `builtin/entity` -- and for the GeckoLib family
    the real boxes are in the pack as `geo/<name>.geo.json`.

    A plain cube (`minecraft:stone` is the same model chain!) must NOT be
    flagged: the marker is the evidence, not the chain's shape.
    """
    root = str(tmp_path)
    item_pack(root)
    base = os.path.join(root, "assets", "testns")
    # A stand-in CUBE: it really has elements (that is the whole problem -- the
    # picture looks deliberate), unlike a chest, which has none.
    stand_in = json.dumps(dict(CUBE, parent="block/block",
                               textures={"all": "blocks/thing"}))

    for block in ("standin", "turretblock"):
        write(os.path.join(base, "blockstates", block + ".json"),
              json.dumps({"variants": {"": {"model": block}}}))
        write(os.path.join(base, "models", "block", block + ".json"), stand_in)
    # The item marker is what distinguishes it from an ordinary cube.
    write(os.path.join(base, "models", "item", "standin.json"),
          json.dumps({"parent": "builtin/entity"}))
    write(os.path.join(base, "models", "item", "turretblock.json"),
          json.dumps({"parent": "builtin/entity"}))
    # ...and GeckoLib ships the real geometry, which is the fix, not just the label.
    write(os.path.join(base, "geo", "turretblock.geo.json"), json.dumps({
        "format_version": "1.12.0",
        "minecraft:geometry": [{"description": {"texture_width": 32, "texture_height": 32},
                                "bones": [{"name": "main", "pivot": [0, 0, 0]}]}]}))

    standin = run("--root", root, "--block", "testns:standin")
    assert standin["codeRendered"]["reasons"] == ["builtin/entity"], standin["codeRendered"]
    assert standin["codeRendered"]["standInCube"] is True, standin["codeRendered"]
    assert standin["codeRendered"]["geometry"] is None, standin["codeRendered"]

    turret = run("--root", root, "--block", "testns:turretblock")
    assert turret["codeRendered"]["reasons"] == ["builtin/entity", "geo"], turret["codeRendered"]
    assert turret["codeRendered"]["bones"] == 1, turret["codeRendered"]
    assert turret["codeRendered"]["geometry"].endswith("turretblock.geo.json"), turret["codeRendered"]

    # A real cube: same model chain, no marker -- and it must stay unflagged.
    plain = run("--root", root, "--block", "testns:stone")
    assert "codeRendered" not in plain, plain.get("codeRendered")

    # The namespace scan has to catch the stand-in too: `no elements` alone
    # missed every one of the 43 travelersbackpack blocks.
    scan = run("--root", root, "--code-blocks", "--namespace", "testns")
    by_id = {block["id"]: block for block in scan["blocks"]}
    assert "standin" in by_id and "turretblock" in by_id, sorted(by_id)
    assert by_id["standin"]["standInCube"] is True, by_id["standin"]
    assert by_id["turretblock"]["geo"].endswith("turretblock.geo.json"), by_id["turretblock"]
    assert "stone" not in by_id, sorted(by_id)


def test_a_project_pack_needs_the_game_root_for_the_vanilla_parents(tmp_path):
    """A resource pack does not ship `block/cube_all` / `block/block`.

    Its models parent to those by an UNQUALIFIED name (`"parent": "block/cube_all"`),
    and an unqualified model reference means `minecraft:` in the game -- so the
    pack alone resolves nothing, the whole chain comes back missing, and every
    block item reads as `shape: none`: an item with no icon.  That is exactly
    what "看不到我们自己做出来的资源的物品形式" looked like.

    Pointing the SAME command at the pack AND at the game root completes the
    chain, and the project's own file still wins because the first root is tried
    first.  `--list` always took every root; `--item` and `--items` were the two
    that silently dropped all but the first.
    """
    project = os.path.join(str(tmp_path), "pack")
    game = os.path.join(str(tmp_path), "game")
    base = os.path.join(project, "assets", "proj")
    write(os.path.join(base, "models", "item", "thing.json"),
          json.dumps({"parent": "proj:block/thing"}))
    write(os.path.join(base, "models", "block", "thing.json"),
          json.dumps({"parent": "block/cube_all", "textures": {"all": "proj:block/thing"}}))
    write_bytes(os.path.join(base, "textures", "block", "thing.png"), PNG)
    write(os.path.join(base, "lang", "zh_cn.json"),
          json.dumps({"item.proj.thing": "东西"}))
    vanilla = os.path.join(game, "assets", "minecraft", "models", "block")
    write(os.path.join(vanilla, "cube_all.json"),
          json.dumps({"parent": "block/cube", "textures": {"particle": "#all"}}))
    write(os.path.join(vanilla, "cube.json"), json.dumps(dict(CUBE, parent="block/block")))
    write(os.path.join(vanilla, "block.json"), json.dumps({
        "gui_light": "side",
        "display": {"gui": {"rotation": [30, 225, 0], "translation": [0, 0, 0],
                            "scale": [0.625, 0.625, 0.625]}}}))

    alone = run("--root", project, "--item", "proj:thing")
    # Answered from the built-in table, and it says so.
    assert alone["shape"] == "iso", alone
    assert "内置:block/cube_all" in alone["missingModels"], alone["missingModels"]
    # The page path (`--items`) had the very same hole as `--item`.
    page = run("--root", project, "--items", "thing", "--namespace", "proj")
    assert page["items"]["thing"]["shape"] == "iso", page["items"]["thing"]
    assert "内置:block/cube_all" in page["items"]["thing"]["missingModels"], page["items"]["thing"]

    both = run("--root", project, "--root", game, "--item", "proj:thing")
    # Read from the game instead of the table, so no marker.
    assert not any(str(n).startswith("内置:") for n in both["missingModels"]), both["missingModels"]
    assert both["shape"] == "iso", both
    assert both["light"] == "side", both
    assert both["display"]["rotation"] == [30, 225, 0], both["display"]
    assert both["name"] == "东西", both.get("name")
    assert both["form"] == "block", both["form"]
    listed = run("--root", project, "--root", game, "--list", "--namespace", "proj",
                 "--kind", "item")
    assert [item["id"] for item in listed["items"]] == ["thing"], listed["items"]
    assert listed["items"][0]["shape"] == "iso", listed["items"][0]


def test_a_project_pack_alone_still_resolves_the_vanilla_bases(tmp_path):
    """No game root at all: the seven vanilla bases come from the built-in table.

    A pack ships `{"parent": "block/cube_all"}` and nothing else; the ICON path
    needs `cube_all` (and through it `block/block`'s `display.gui`) or it reports
    `shape: none` -- our own resources with no item form -- while the 3D view of
    the same block works, because the host carries this very table.  The table is
    copied from the 1.18.2 jar (mapping and all), and using it is SAID, not
    hidden: every entry it supplied is reported as `内置:<name>`.
    """
    pack_root = os.path.join(str(tmp_path), "pack")
    base = os.path.join(pack_root, "assets", "proj")
    write(os.path.join(base, "models", "item", "thing.json"),
          json.dumps({"parent": "proj:block/thing"}))
    write(os.path.join(base, "models", "block", "thing.json"),
          json.dumps({"parent": "block/cube_all", "textures": {"all": "proj:block/thing"}}))
    write_bytes(os.path.join(base, "textures", "block", "thing.png"), PNG)
    write(os.path.join(base, "models", "item", "column.json"),
          json.dumps({"parent": "proj:block/column"}))
    write(os.path.join(base, "models", "block", "column.json"),
          json.dumps({"parent": "block/cube_column",
                      "textures": {"end": "proj:block/thing", "side": "proj:block/thing"}}))
    write(os.path.join(base, "models", "item", "flower.json"),
          json.dumps({"parent": "proj:block/flower"}))
    write(os.path.join(base, "models", "block", "flower.json"),
          json.dumps({"parent": "block/cross", "textures": {"cross": "proj:block/thing"}}))

    cube = run("--root", pack_root, "--item", "proj:thing")
    assert cube["shape"] == "iso", cube
    assert cube["display"]["rotation"] == [30, 225, 0], cube.get("display")
    assert cube["light"] == "side", cube["light"]
    assert cube["elements"] == 1, cube.get("elements")
    assert "内置:block/cube_all" in cube["missingModels"], cube["missingModels"]
    assert "内置:block/block" in cube["missingModels"], cube["missingModels"]

    column = run("--root", pack_root, "--item", "proj:column")
    assert column["shape"] == "iso", column
    assert "内置:block/cube_column" in column["missingModels"], column["missingModels"]

    # A cross is standalone in vanilla: no parent, so no GUI matrix -- and the
    # icon path has to say that instead of inventing the standard one.
    flower = run("--root", pack_root, "--item", "proj:flower")
    assert flower["shape"] == "iso", flower
    assert flower["display"] is None, flower.get("display")
    assert "内置:block/cross" in flower["missingModels"], flower["missingModels"]


def test_item_icon_recipe_is_drawn_the_way_the_game_draws_it(tmp_path):
    """The 2D inventory icon, as data.

    A block item is an ISOMETRIC render (the chain has elements, and the GUI
    matrix comes from `block/block`'s own `display.gui`); a generated item is
    flat layers with no directional shading (`gui_light: front`).  And vanilla's
    inventory animation is `overrides` -- `item/clock` is 64 model swaps, NOT an
    animated texture, which is why the frames have to be resolved to their own
    layer lists here.
    """
    root = str(tmp_path)
    item_pack(root)
    base = os.path.join(root, "assets", "testns")
    # A `gui_light: side` block item: the 3D icon takes the side lighting.
    write(os.path.join(base, "models", "item", "blockitem.json"),
          json.dumps({"parent": "block/stone"}))
    # A generated item that animates by SWAPPING MODELS, like the clock.
    write(os.path.join(base, "models", "item", "watch.json"), json.dumps({
        "parent": "item/generated", "textures": {"layer0": "item/watch_0"},
        "overrides": [{"predicate": {"time": 0.0}, "model": "item/watch"},
                      {"predicate": {"time": 0.5}, "model": "item/watch_1"}]}))
    write(os.path.join(base, "models", "item", "watch_1.json"),
          json.dumps({"parent": "item/generated", "textures": {"layer0": "item/watch_1"}}))
    for name in ("watch_0", "watch_1"):
        write_bytes(os.path.join(base, "textures", "item", name + ".png"), PNG)

    block_item = run("--root", root, "--item", "testns:blockitem")
    assert block_item["kind"] == "item", block_item.get("kind")
    assert block_item["shape"] == "iso", block_item
    assert block_item["light"] == "side", block_item
    assert block_item["display"]["rotation"] == [30, 225, 0], block_item["display"]
    assert block_item["textures"], block_item["textures"].keys()

    flat = run("--root", root, "--item", "testns:apple")
    assert flat["shape"] == "flat", flat
    assert flat["light"] == "front", flat
    assert flat["layers"] == ["item/apple"], flat["layers"]
    # A flat item has no elements, so it must NOT come back complaining about
    # "no geometry" -- that complaint is for a block.
    assert flat["error"] is None, flat["error"]
    assert len(flat["textures"]) == 1, flat["textures"].keys()

    watch = run("--root", root, "--item", "testns:watch")
    assert watch["shape"] == "flat", watch
    assert [frame["layers"] for frame in watch["frames"]] == \
        [["item/watch_0"], ["item/watch_1"]], watch["frames"]
    assert watch["frames"][1]["predicate"] == {"time": 0.5}, watch["frames"][1]
    # Every frame's texture has to travel, or the animation plays blanks.
    assert len(watch["textures"]) == 2, watch["textures"].keys()

    # An item the game draws in code has no icon data anywhere -- say it.
    write(os.path.join(base, "models", "item", "codeonly.json"),
          json.dumps({"parent": "builtin/entity"}))
    code = run("--root", root, "--item", "testns:codeonly")
    assert code["shape"] == "none", code
    assert code["drawable"] is False, code
    assert "builtin/entity" in code["error"], code["error"]
