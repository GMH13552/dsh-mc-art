#!/usr/bin/env python3
"""Pull ONE block's renderable definition out of a reference root, on demand.

Why not "scan everything once": the reference is 1406 vanilla textures plus 28
mod jars, and a single structure uses a handful of blocks.  So nothing is
pre-extracted and nothing is written to disk -- this reads the one blockstate,
walks its `parent` chain, and returns the model JSONs and the PNGs those models
actually reference, base64'd, on stdout.

What the disk actually looks like (measured, not assumed -- see AGENT.md #8):

  1.12.2-Forge_14.23.5.28641/<version>.jar
      assets/minecraft/blockstates/oak_log.json      <- id-space, flattened names
      assets/minecraft/models/block/oak_log.json     <- parent chain lives here
      assets/minecraft/textures/blocks/log_oak.png   <- note: log_oak, not oak_log
      (no lang/ and no pack.mcmeta in this jar at all)

  mods/[虚无世界] AoA3-3.3.6.jar
      assets/aoa3/blockstates/achony_log.json        model: "aoa3:generation/wood/achony_log"
      assets/aoa3/models/block/generation/wood/achony_log.json
      assets/aoa3/textures/blocks/generation/wood/achony_log.png
      assets/aoa3/lang/zh_cn.lang                    (the mod ships its own names)

So no single path scheme holds.  A blockstate's `model` ref resolves under
`models/block/`, a `parent` ref resolves under `models/` (its `block/` prefix is
part of the ref), and a texture ref resolves under any of several
`textures/<kind>/` folders.  This file tries those in order and reports which
one hit, rather than hardcoding one layout.

Names come from wherever they exist: the mod jar's own `lang/zh_cn.lang`, and
for vanilla from the hashed object store that `assets/indexes/<n>.json` points
at -- the version jars here carry no lang at all.  Every name reports the key
and the file it came from, so a fallback to the raw id is visible, not silent.

Usage:
    mcart_extract_block.py --root <path> --probe
    mcart_extract_block.py --root <path> --list --namespace <ns>
    mcart_extract_block.py --root <path> --block <ns>:<id>
Output: one JSON object on stdout.  Nothing else goes to stdout.
"""

import base64
import collections
import json
import os
import struct
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# The "which files count as an asset archive" rule lives in the scanner; it is
# not re-derived here, so the two can never disagree about what a reference is.
from mcart_scan_refs import is_jar, jars_in, subdirs  # noqa: E402


def _pin_utf8_stdio():
    """把 stdout/stderr 钉成 UTF-8。

    为什么必须：Windows 上 Python 的 stdio 用**系统区域编码**（中文机器上是 GBK），
    而 DSH 宿主按 UTF-8 解子进程输出 —— 于是这里 print 出去的中文（方块/物品名，
    来自 lang 文件与 jar）到面板上就变成 `����ʯ`。实测症状很有辨识度：**面板自己的字
    正常，只有"读出来的名字"是乱码**。
    `python -X utf8` 也能解决，但环境里的 `PYTHONIOENCODING` 会盖过它；
    `reconfigure` 谁也盖不过，所以两层都上（宿主那边也加 -X utf8）。
    旧 Python 没有 reconfigure，包在 try 里。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


# A texture may hide in any of these; 1.12.2 used `blocks`/`items`, 1.13+ uses
# `block`/`item`, and mods use both.
TEXTURE_DIRS = ("blocks", "block", "items", "item", "entity", "particle",
                "gui", "misc", "models", "environment")

# One animated water/lava sheet is fine; a multi-megabyte sheet would blow the
# JSON message up for no visual gain.
MAX_TEXTURE_BYTES = 2 * 1024 * 1024

# A model chain that is longer than this is a cycle, not a chain.
MAX_MODEL_DEPTH = 8

LOCALES = ("en_us", "zh_cn")


class Provider:
    """One place assets can be read from: a jar, or a directory tree."""

    def __init__(self, kind, path, label, version=None):
        self.kind = kind
        self.path = path
        self.label = label
        self.version = version

    def describe(self):
        return {"kind": self.kind, "label": self.label, "path": self.path,
                "version": self.version}


class JarProvider(Provider):
    def __init__(self, path, label, version=None):
        Provider.__init__(self, "jar", path, label, version)
        self._zip = None

    def _archive(self):
        if self._zip is None:
            self._zip = zipfile.ZipFile(self.path)
        return self._zip

    def has(self, name):
        try:
            self._archive().getinfo(name)
            return True
        except KeyError:
            return False
        except Exception:
            return False

    def read(self, name):
        try:
            return self._archive().read(name)
        except Exception:
            return None

    def names(self):
        try:
            return self._archive().namelist()
        except Exception:
            return []


class DirProvider(Provider):
    """An already-extracted resource tree.

    Only `assets/` is ever walked, and only whole namespace folders are read.
    This matters more than it looks: `.minecraft` also has an `assets/` folder --
    the hashed object store -- so a naive "root has assets/, add a dir provider"
    walked `saves/`, `libraries/` and tens of thousands of object files on every
    lookup, which turned a single block extraction into a 60-second timeout.
    """

    def __init__(self, path, label, version=None, subtree="assets"):
        Provider.__init__(self, "dir", path, label, version)
        self.subtree = subtree

    def _full(self, name):
        return os.path.join(self.path, name.replace("/", os.sep))

    def has(self, name):
        return os.path.isfile(self._full(name))

    def read(self, name):
        try:
            with open(self._full(name), "rb") as handle:
                return handle.read()
        except OSError:
            return None

    def names(self):
        base = os.path.join(self.path, self.subtree)
        out = []
        if not os.path.isdir(base):
            return out
        for folder, _, files in os.walk(base):
            rel = os.path.relpath(folder, self.path).replace(os.sep, "/")
            prefix = "" if rel == "." else rel + "/"
            for name in files:
                out.append(prefix + name)
        return out


class Repository:
    """Search order over several providers.  First hit wins, and the hit is
    reported, so a surprising result can be explained instead of guessed at."""

    def __init__(self, providers):
        self.providers = providers
        self._name_cache = {}

    def find(self, candidates):
        for name in candidates:
            for provider in self.providers:
                if provider.has(name):
                    return provider, name
        return None, None

    def read(self, candidates):
        provider, name = self.find(candidates)
        if provider is None:
            return None, None
        return provider.read(name), name

    def read_json(self, candidates):
        data, name = self.read(candidates)
        if data is None:
            return None, None
        try:
            return json.loads(data.decode("utf-8", "replace")), name
        except ValueError:
            return None, name

    def names(self, provider):
        if id(provider) not in self._name_cache:
            self._name_cache[id(provider)] = provider.names()
        return self._name_cache[id(provider)]

    def list_prefix(self, prefix):
        """Every name under `prefix` across all providers, first-seen order."""
        out = []
        seen = set()
        for provider in self.providers:
            for name in self.names(provider):
                if name.startswith(prefix) and name not in seen:
                    seen.add(name)
                    out.append(name)
        return out


def split_ref(reference, default_namespace):
    text = "" if reference is None else str(reference)
    if ":" in text:
        namespace, path = text.split(":", 1)
        return namespace, path
    return default_namespace, text


def namespace_chain(default_namespace):
    """Namespaces to try for a reference that did not name one.

    Minecraft resolves an unqualified resource location to `minecraft`, but a
    hand-written mc-art pack means "my own namespace" (`"all": "blocks/dirt"`).
    Both conventions are on this disk -- AoA3's models say
    `"parent": "block/cube_column"` and expect vanilla, while a generated pack
    says `"blocks/dirt"` and expects itself -- so try the local namespace first
    and fall back to vanilla.  Nothing is resolved by guessing: a candidate is
    only used if the file is actually there.
    """
    out = []
    for name in (default_namespace, "minecraft"):
        if name and name not in out:
            out.append(name)
    return out


def pascal_case(block):
    """`achony_log` -> `AchonyLog`.

    AoA3 registers blocks as Java classes and names them `tile.AchonyLog.name`,
    so the snake_case id the blockstate file uses is not the key it translates.
    This is a spelling of the same id, tried after the literal ones and only
    used when the key exists.
    """
    return "".join(part[:1].upper() + part[1:] for part in str(block).split("_") if part)


def model_candidates(namespace, path):
    # A blockstate's `model` ref lands under models/block/ even when the ref does
    # not say so ("dirt" -> models/block/dirt.json); a `parent` ref usually does
    # say so ("block/cube_all" -> models/block/cube_all.json).  Trying both
    # spellings covers each without needing to know which one this is.
    return ["assets/%s/models/%s.json" % (namespace, path),
            "assets/%s/models/block/%s.json" % (namespace, path),
            "assets/%s/models/item/%s.json" % (namespace, path)]


def texture_candidates(namespace, path):
    # A model's texture value is relative to `textures/` and normally already
    # carries the kind folder: 1.12.2 vanilla says "blocks/log_oak", AoA3 says
    # "blocks/generation/wood/achony_log", 1.13+ says "block/oak_log".  So the
    # ref itself is tried first; the kind-prefixed forms only exist to tolerate a
    # hand-written pack that leaves the folder out.
    out = ["assets/%s/textures/%s.png" % (namespace, path)]
    for kind in TEXTURE_DIRS:
        out.append("assets/%s/textures/%s/%s.png" % (namespace, kind, path))
    return out


# Values that describe the block on its own rather than its relationship to
# something else.  Used only to break ties between variants that already do not
# rotate the model -- see `pick_variant`.
PLAIN_VALUES = {"straight", "bottom", "false", "none", "normal", "inventory", "", "north", "y"}


def entry_has_rotation(entry):
    """Does this variant rotate the model at all?"""
    items = entry if isinstance(entry, list) else [entry]
    for item in items:
        if not isinstance(item, dict):
            continue
        for name in ("x", "y"):
            try:
                if int(item.get(name, 0)) % 360 != 0:
                    return True
            except (TypeError, ValueError):
                pass
    return False


def pick_variant(variants):
    """Which variant to draw, and why.

    1.13+ packs use a single "" key.  1.12.2 columns use axis=y / axis=x /
    axis=z / axis=none, and a column drawn on its side is the wrong shape for a
    palette icon.  So: the flat key, then an upright column, then the plainest
    name, -- never a guess about geometry.

    After those, the variant that does NOT rotate the model: that is the
    orientation the model was drawn in, so it is the one the author means.
    Falling straight through to `sorted()[0]` picked `facing=east` for a
    furnace, purely because `e` sorts first -- the block opened facing a
    direction nobody chose.
    """
    keys = sorted(variants.keys())
    if not keys:
        return None
    for wanted in ("", "axis=y", "axis=z", "normal", "inventory"):
        if wanted in variants:
            return wanted
    plain = [key for key in keys if not entry_has_rotation(variants.get(key))]
    if not plain:
        return keys[0]
    if len(plain) == 1:
        return plain[0]
    # Among the ones that do not rotate, prefer the one whose properties say the
    # least about anything OUTSIDE this block.  `shape=straight` is literally
    # "no neighbour relationship" (a staircase corner is `inner_*`/`outer_*`,
    # which is a statement about the block next to it), `half=bottom` is the
    # plain half, `conditional=false` is the plain command block.  Without this
    # a staircase opened as `facing=east,half=bottom,shape=inner_right` purely
    # because `i` sorts before `s`.
    def plainness(key):
        score = 0
        for part in str(key).split(","):
            value = part.split("=", 1)[1] if "=" in part else part
            if value in PLAIN_VALUES:
                score += 1
        return score
    return sorted(plain, key=lambda key: (-plainness(key), key))[0]


def variant_models(entry):
    items = entry if isinstance(entry, list) else [entry]
    out = []
    for item in items:
        if isinstance(item, dict) and isinstance(item.get("model"), str):
            out.append(item)
    return out


def merge_defaults(defaults, entry):
    """One Forge variant with the blockstate's `defaults` filled in underneath.

    `forge_marker` keeps a shared block for the model AND its textures, and a
    variant is free to name only the model:

        {"forge_marker": 1,
         "defaults": {"textures": {"all": "simpleores:blocks/copper_block"}},
         "variants": {"normal": {"model": "cube_all"}}}

    Taking `defaults` only when the variant was empty handled the Apotheosis
    shape and left this one with a dangling `#all`.  `cube_all`'s whole texture
    table IS `#all`, so every face resolved to nothing, `missingTextures` filled
    up with "#all" six times, and the block drew nothing at all -- which is what
    "no model for cell block simpleores:copper_block" was.

    Defaults are a DEFAULT: anything the variant states wins.
    """
    if not isinstance(entry, dict):
        return entry
    merged = dict(entry)
    for name in ("model", "x", "y", "uvlock"):
        if merged.get(name) is None and defaults.get(name) is not None:
            merged[name] = defaults[name]
    default_textures = defaults.get("textures")
    if isinstance(default_textures, dict) and default_textures:
        own = merged.get("textures")
        table = dict(default_textures)
        if isinstance(own, dict):
            table.update(own)
        merged["textures"] = table
    return merged


def normalize_when(when):
    """A `when` clause with every value as the STRING a comparison will use.

    The same property is spelled both ways in the wild -- 1.18.2's
    `prismarine_wall` writes `"up": "true"` while its `glass_pane` writes
    `"north": true` in the SAME version -- and `low`/`tall` are strings already.
    Normalising here means the consumer compares strings and never has to know
    which pack wrote which spelling.
    """
    if not isinstance(when, dict):
        return {}
    out = {}
    for key, value in when.items():
        if value is True:
            out[str(key)] = "true"
        elif value is False:
            out[str(key)] = "false"
        elif value is None:
            continue
        else:
            out[str(key)] = str(value)
    return out


def multipart_applies(state):
    """Every `apply` a `multipart` blockstate lists, with its `when`, file order.

    Minecraft decides which of them are in play from the block's NEIGHBOURS --
    a wall shows the side facing a solid block and hides the other three -- and
    the extractor is asked about ONE block with no world around it.  So each
    apply is handed over TWICE over: the geometry as its own ref, and the `when`
    clause that says when the game would draw it.  A consumer with no neighbours
    draws the union (an approximation, and it says so); one that knows the
    neighbours evaluates the clauses and draws what the game would.

    NOT a 1.13+ thing: 1.12.2's own `cobblestone_wall` and `glass_pane` are
    multipart too.  What differs is the property SHAPE -- 1.12.2 walls are
    boolean sides, 1.18.2 walls are `low`/`tall` -- and neither is hardcoded
    here: the clauses come from the pack, whatever they say.
    """
    parts = state.get("multipart") if isinstance(state, dict) else None
    if not isinstance(parts, list):
        return []
    out = []
    seen = set()
    for item in parts:
        if not isinstance(item, dict):
            continue
        when = normalize_when(item.get("when"))
        apply = item.get("apply")
        for entry in (apply if isinstance(apply, list) else [apply]):
            if not isinstance(entry, dict) or not isinstance(entry.get("model"), str) or not entry.get("model"):
                continue
            # A GUARD, not a fix: measured on 1.18.2 the applies of fire, walls,
            # fences and panes are already distinct, so this drops nothing today.
            # The same model at the same rotation IS the same geometry, though,
            # and drawing it twice is a no-op the strict depth test throws away,
            # so a pack that repeats an apply does not get charged for it.
            signature = (entry.get("model"), entry.get("x") or 0, entry.get("y") or 0,
                         entry.get("uvlock") is True)
            if signature in seen:
                continue
            seen.add(signature)
            out.append((entry, when))
    return out


def multipart_entries(state):
    """Just the applies -- `multipart_applies` without the clauses."""
    return [entry for entry, _when in multipart_applies(state)]



def resolve_blockstate(repository, namespace, block, wanted=None):
    """-> (blockstate dict, chosen variant key, list of model entries, path)

    `wanted` picks a specific variant key ("facing=east", "axis=x").  An
    unknown key falls back to the default pick rather than failing: the caller
    got its list from a previous extraction of the same block, and a pack can
    change under it between the two calls.
    """
    rel = "assets/%s/blockstates/%s.json" % (namespace, block)
    state, found = repository.read_json([rel])
    if state is None:
        return None, None, None, found
    variants = state.get("variants")
    if not isinstance(variants, dict) or not variants:
        # A `multipart` blockstate has no variant table at all, just a list of
        # applies -- and it is NOT a 1.13+ thing: 1.12.2's own cobblestone_wall
        # and glass_pane are multipart too, so this branch serves both versions.
        # What differs between them is the PROPERTY SHAPE: 1.12.2 walls are
        # boolean sides, 1.18.2 walls are `low`/`tall`.  Neither is hardcoded
        # here -- the `when` clauses come from the pack, whatever they say.
        # Until this existed, every wall/fence/pane came out as "这个方块没有几何
        # 模型 ... 用方块实体在代码里渲染的" -- true of `eplus:decorative_book`,
        # flatly false of all 48 of these, whose elements were one file away.
        parts = multipart_entries(state)
        if not parts:
            return state, None, [], found
        defaults = state.get("defaults")
        if isinstance(defaults, dict):
            parts = [merge_defaults(defaults, entry) for entry in parts]
        return state, None, parts, found
    # Match on the canonical spelling: the viewer composes a key out of the
    # properties it chose, and the pack may have written those same properties in
    # another order.  Looking the raw string up would call a valid choice invalid.
    key = None
    if wanted is not None:
        for candidate in variants.keys():
            if canonical_variant_key(candidate) == canonical_variant_key(wanted):
                key = candidate
                break
    if key is None:
        key = pick_variant(variants)
    entries = variant_models(variants.get(key))
    if not entries:
        # Forge's `forge_marker` blockstates put the model in `defaults` and
        # leave the variant as `[{}]` (Apotheosis does exactly this).  Without
        # this the block reported "没有可用的模型" while its model was right there
        # in the same file.
        fallback = state.get("defaults")
        if isinstance(fallback, dict) and isinstance(fallback.get("model"), str) and fallback.get("model"):
            # The whole entry, not just `model`: Forge also carries `textures`
            # here.  hellshelf keeps its ONLY texture table in defaults
            # (`{end: blocks/nether_brick, side: apotheosis:...}`), so taking
            # just the model left `#end`/`#side` dangling and the block drew
            # nothing at all.
            entries = [fallback]
    # ...and when the variant DOES name a model, `defaults` still supplies its
    # textures.  Merging only in the empty-variant case fixed one Forge shape
    # and left the other one silently blank.
    defaults = state.get("defaults")
    if isinstance(defaults, dict) and entries:
        entries = [merge_defaults(defaults, entry) for entry in entries]
    return state, key, entries, found


def png_size(data):
    """(width, height) from a PNG header, or None."""
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return struct.unpack(">II", data[16:24])


def animation_of(data, meta):
    """How a texture animates, from the `.mcmeta` beside it -- or None.

    An animated texture is a vertical strip: frame 0 on top, then each next
    frame below it (lava_still is 16x320 = 20 frames).  Handing the whole strip
    to a consumer that maps UV 0..1 over the image smears every frame across one
    face, which is what "画出来了但不会动" looked like: a static mess.  So the
    caller needs to know the frame boundaries, and this is where they come from.

    Only a `.mcmeta` that actually declares `animation` counts.  A tall sprite
    with no metadata is left alone -- guessing "tall means animated" would chop
    a legitimately tall texture into frames that do not exist.

    `frames` in the metadata is NOT a count: it is a list, and an entry may be
    an index or `{index, time}`.  A frame may repeat or be skipped, so the
    playback order has to be carried, not just the number.
    """
    if meta is None:
        return None
    size = png_size(data)
    if size is None:
        return None
    width, height = size
    if width == 0 or height <= width or height % width != 0:
        return None
    try:
        declared = json.loads(meta.decode("utf-8", "replace")).get("animation")
    except ValueError:
        return None
    if not isinstance(declared, dict):
        return None
    strip = height // width
    order = []
    listed = declared.get("frames")
    if isinstance(listed, list):
        for item in listed:
            index = item.get("index", 0) if isinstance(item, dict) else item
            try:
                index = int(index)
            except (TypeError, ValueError):
                continue
            if 0 <= index < strip:
                order.append(index)
    if not order:
        order = list(range(strip))
    try:
        frametime = int(declared.get("frametime", 1))
    except (TypeError, ValueError):
        frametime = 1
    return {
        "frames": len(order),
        "strip": strip,
        "order": order,
        "frametime": max(1, frametime),
        "interpolate": bool(declared.get("interpolate")),
    }


def canonical_variant_key(key):
    """One spelling for a variant key, whatever order the pack wrote it in.

    A key is `name=value` pairs joined by commas, and a pack may write them in
    any order -- `facing=down,conditional=false` and
    `conditional=false,facing=down` are the same variant.  The consumer composes
    a key out of the properties it chose, so both sides have to agree on one
    spelling or a perfectly valid choice is reported as "no such variant".

    A key with no `=` (1.13 uses `""`, Forge uses `normal`) is its own canonical
    form: there are no properties to reorder.
    """
    text = str(key)
    if "=" not in text:
        return text
    parts = [part for part in text.split(",") if part != ""]
    return ",".join(sorted(parts))


def variant_properties(key):
    """`facing=down,conditional=false` -> {"facing": "down", "conditional": "false"}.

    The consumer derives some properties from the placement and has no rule at
    all for others -- nothing in the world says whether a command block is
    conditional.  Those have to keep the variant the extractor chose, so the
    default has to be handed over as data rather than as one opaque string.
    """
    out = {}
    if key is None:
        return out
    for part in str(key).split(","):
        if "=" not in part:
            continue
        name, value = part.split("=", 1)
        out[name] = value
    return out


def variant_axes(state):
    """The independent properties behind a blockstate, and their values.

    The viewer used to print `variants`' keys straight out as buttons, which is
    fine for a furnace (four `facing=...`) and useless for anything with two
    properties: a command block becomes twelve `conditional=false,facing=down`
    labels, and a staircase becomes **forty** (`facing` 4 x `half` 2 x
    `shape` 5).  Those are not forty choices; they are three questions.

    So the properties are reported separately, each with its own values, and the
    viewer asks one question per row.  Order is by property name so the client
    can compose a key that matches `canonical_variant_key`.
    """
    variants = state.get("variants") if isinstance(state, dict) else None
    if not isinstance(variants, dict):
        return []
    values = {}
    for key in variants.keys():
        for part in str(key).split(","):
            if "=" not in part:
                continue
            name, value = part.split("=", 1)
            values.setdefault(name, set()).add(value)
    return [{"name": name, "values": sorted(values[name])} for name in sorted(values.keys())]


def variant_key_list(state):
    """Every variant key a blockstate offers, in canonical form, sorted.

    The viewer shows the ones it can offer as buttons.  A block with one variant
    gets one entry, and the viewer then has nothing to offer -- which is the
    honest answer, not a disabled control.
    """
    variants = state.get("variants") if isinstance(state, dict) else None
    if not isinstance(variants, dict):
        return []
    return sorted({canonical_variant_key(key) for key in variants.keys()})


def variant_rotation(entries):
    """The blockstate's rotation of the whole model, as {x, y, uvlock} or None.

    The consumer applies this LAST, to the finished quads.  It cannot be baked
    into the model's elements here: a model element may carry its own
    `rotation`, which Minecraft applies in model space *before* the variant
    rotation, so rotating `from`/`to` in place would put the two in the wrong
    order for every stairs/cross model.

    x is applied first, then y with its sign flipped, about the block centre.
    Both halves of that were checked against vanilla 1.12.2 rather than
    recalled.  `oak_log` declares `axis=z` as `x: 90` and `axis=x` as
    `x: 90, y: 90` -- a log is symmetric so it cannot settle the sign, but
    `furnace` does: the model puts its front face on the north side and
    `facing=east` is `y: 90`, and north only lands on east if y is negated.
    """
    if not entries:
        return None
    first = entries[0]
    if not isinstance(first, dict):
        return None

    def degrees(name):
        try:
            return int(first.get(name, 0)) % 360
        except (TypeError, ValueError):
            return 0

    x = degrees("x")
    y = degrees("y")
    if x == 0 and y == 0:
        return None
    return {"x": x, "y": y, "uvlock": bool(first.get("uvlock"))}


def first_frame(data, meta):
    """Crop an animated texture down to its first frame.

    The ICON path still needs this: a hotbar slot paints the PNG as a CSS
    background, so a whole strip arrives squashed into one square.  The 3D path
    no longer crops -- it takes the strip and the `animation_of` description, so
    the viewer can play it.  Returns (plain png bytes, frame count or 0).
    """
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        return data, 0
    width, height = struct.unpack(">II", data[16:24])
    if width == 0 or height <= width or height % width != 0:
        return data, 0
    # Only when the pack actually declares it animated; a tall sprite that is not
    # animated must be left alone.
    frames = height // width
    if meta is not None:
        try:
            declared = json.loads(meta.decode("utf-8", "replace")).get("animation") or {}
        except ValueError:
            declared = {}
        listed = declared.get("frames")
        if isinstance(listed, list) and listed:
            frames = len(listed)
    elif frames > 1 and height % width == 0:
        # No .mcmeta: keep it -- see the caller, which only calls us with one.
        pass
    try:
        from PIL import Image  # noqa: PLC0415
    except Exception:
        return data, frames
    try:
        import io as _io
        image = Image.open(_io.BytesIO(data))
        image.load()
        cropped = image.crop((0, 0, width, width))
        out = _io.BytesIO()
        cropped.save(out, "PNG", optimize=True)
        return out.getvalue(), frames
    except Exception:
        return data, frames


def qualify_textures(repository, namespace, table):
    """Rewrite texture refs to `namespace:path` for the archive that has them.

    A mod may write `"all": "blocks/wool_colored_brown"` meaning vanilla.  We
    already resolve that correctly when reading bytes -- and then used to hand
    the model back with the ref still unqualified, throwing the answer away.  A
    consumer that guesses the mod's own namespace then finds nothing, skips every
    face, and the block renders as *nothing at all* (the user saw exactly that:
    "no model for cell block travelersbackpack:travelers_backpack").
    """
    out = {}
    for key, value in table.items():
        if not isinstance(value, str) or value.startswith("#"):
            out[key] = value
            continue
        ref_namespace, ref_path = split_ref(value, namespace)
        chosen = None
        for candidate in namespace_chain(ref_namespace):
            provider, _name = repository.find(texture_candidates(candidate, ref_path))
            if provider is not None:
                chosen = candidate + ":" + ref_path
                break
        out[key] = chosen if chosen is not None else value
    return out


# The handful of vanilla BASE models a project pack inherits by unqualified
# name but does not ship.  A pack's block model says `{"parent": "block/cube_all"}`
# and `cube_all` lives in the game; when the game root is readable it is read
# from there and this table is never consulted.  Without one, a project block
# item had no geometry at all and read as "shape: none" -- our own resources with
# no item form -- while the 3D view of the same block worked, because the host
# carries this exact table for it.  Seven entries, same numbers, so that the icon
# and the 3D view agree about a block nobody shipped a parent for.
#
# `block/block` is also where the GUI matrix lives (`display.gui`), and those
# numbers are the ones measured in `vanilla3d/tools/render_item_model.py`.
def _cube_elements(pick):
    faces = {name: {"texture": pick[name], "uv": [0, 0, 16, 16]}
             for name in ("down", "up", "north", "south", "west", "east")}
    return [{"from": [0, 0, 0], "to": [16, 16, 16], "faces": faces}]


_CROSS_ELEMENTS = [
    {"from": [0.8, 0, 8], "to": [15.2, 16, 8], "shade": False,
     "rotation": {"origin": [8, 8, 8], "axis": "y", "angle": 45, "rescale": True},
     "faces": {"north": {"uv": [0, 0, 16, 16], "texture": "#cross"},
               "south": {"uv": [0, 0, 16, 16], "texture": "#cross"}}},
    {"from": [8, 0, 0.8], "to": [8, 16, 15.2], "shade": False,
     "rotation": {"origin": [8, 8, 8], "axis": "y", "angle": 45, "rescale": True},
     "faces": {"west": {"uv": [0, 0, 16, 16], "texture": "#cross"},
               "east": {"uv": [0, 0, 16, 16], "texture": "#cross"}}},
]

BUILTIN_VANILLA_PARENTS = {
    "block/block": {
        "textures": {},
        "gui_light": "side",
        "display": {"gui": {"rotation": [30, 225, 0], "translation": [0, 0, 0],
                            "scale": [0.625, 0.625, 0.625]}},
    },
    # `cube` holds the elements (one cube, six faces keyed `#down..#east`);
    # the others only MAP those keys onto their own texture names.  Copied from
    # the 1.18.2 jar rather than simplified, so a pack that says
    # `{"parent": "block/cube_all"}` and one that says `{"parent": "block/cube"}`
    # both land on the same numbers.
    "block/cube": {
        "parent": "block/block",
        "textures": {"particle": "#north"},
        "elements": _cube_elements({"down": "#down", "up": "#up", "north": "#north",
                                    "south": "#south", "west": "#west", "east": "#east"}),
    },
    "block/cube_all": {
        "parent": "block/cube",
        "textures": {"particle": "#all", "down": "#all", "up": "#all",
                     "north": "#all", "south": "#all", "west": "#all", "east": "#all"},
    },
    "block/cube_column": {
        "parent": "block/cube",
        "textures": {"particle": "#side", "end": "#end", "side": "#side",
                     "down": "#end", "up": "#end", "north": "#side",
                     "south": "#side", "west": "#side", "east": "#side"},
    },
    "block/cube_bottom_top": {
        "parent": "block/cube",
        "textures": {"particle": "#side", "bottom": "#bottom", "top": "#top", "side": "#side",
                     "down": "#bottom", "up": "#top", "north": "#side",
                     "south": "#side", "west": "#side", "east": "#side"},
    },
    # A cross is standalone in vanilla: no parent, so no `display` -- which is
    # exactly why a cross-shaped block's item is drawn straight on.
    "block/cross": {"textures": {"particle": "#cross"}, "elements": _CROSS_ELEMENTS},
    "block/tinted_cross": {"parent": "block/cross", "textures": {}},
}


def walk_model(repository, default_namespace, reference, out_models, sources, missing):
    """Collect the model chain for `reference` into out_models.

    Returns the merged texture table of the whole chain.  Cycle-safe: a model
    that parents itself (some packs do) stops instead of hanging.
    """
    textures = {}
    chain = []
    seen = set()
    node_ref = reference
    current_namespace = default_namespace
    for _ in range(MAX_MODEL_DEPTH):
        if not node_ref:
            break
        ref_namespace, ref_path = split_ref(node_ref, current_namespace)
        if ref_path.startswith("builtin/"):
            # `builtin/generated` (what every `item/generated` parents to) and
            # `builtin/entity` (code-drawn items) are NOT files anywhere: the game
            # builds them in code, so no pack, jar or mod can ever contain one.
            # Recording them as missing made every flat item report
            # "模型链缺 minecraft:builtin/generated" -- a warning about something
            # that is neither wrong nor fixable, and the user saw it under the
            # 3D view and asked what it was doing there.
            sources.append(None)
            break
        model = None
        found_namespace = None
        hit = None
        for candidate_namespace in namespace_chain(ref_namespace):
            model, hit = repository.read_json(model_candidates(candidate_namespace, ref_path))
            if model is not None:
                found_namespace = candidate_namespace
                break
        if model is None and ref_path in BUILTIN_VANILLA_PARENTS \
                and (":" not in node_ref or ref_namespace == "minecraft"):
            # Unqualified means `minecraft:` in the game, and this is the one
            # case where nothing on disk can answer: the pack inherits these
            # bases, it does not ship them, and there is no game root.  Marked so
            # the consumer can SAY it used a built-in instead of pretending the
            # chain was complete.
            model = BUILTIN_VANILLA_PARENTS[ref_path]
            found_namespace = "minecraft"
            hit = None
            missing.append("内置:" + ref_path)
        if model is None:
            # A parent that is nowhere in this reference root (a single mod jar
            # with no vanilla next to it) used to produce a block with no
            # elements, no textures and NO complaint -- indistinguishable from
            # "this block is empty".
            missing.append("%s:%s" % (ref_namespace, ref_path))
            sources.append(None)
            break
        key = "%s:%s" % (found_namespace, ref_path)
        if key in seen:
            break
        seen.add(key)
        chain.append((key, model))
        sources.append(hit)
        parent = model.get("parent")
        node_ref = parent if isinstance(parent, str) and parent else None
        # An unqualified parent inherits from where the child was found, so a
        # mod model parenting to "block/cube_column" reaches vanilla while a
        # generated pack's own models stay in their own namespace.
        current_namespace = found_namespace
    # Child overrides parent, so fold the chain back to front.
    for key, model in reversed(chain):
        if key not in out_models:
            table = model.get("textures")
            if isinstance(table, dict):
                for name, value in table.items():
                    textures[name] = value
    for key, model in chain:
        if key not in out_models:
            out_models[key] = model
    return textures


def dereference(table, reference):
    name = "" if reference is None else str(reference)
    for _ in range(MAX_MODEL_DEPTH):
        if not name.startswith("#"):
            break
        nxt = table.get(name[1:])
        if nxt is None:
            break
        name = str(nxt)
    return name


def elements_of(out_models):
    """The first element list in the chain, child first -- same rule the plugin
    renderer uses, so the extracted block and an in-project block agree."""
    for key in out_models:
        model = out_models[key]
        elements = model.get("elements")
        if isinstance(elements, list) and elements:
            return elements
    return None


def read_lang_table(repository, namespace):
    """Every lang file a provider ships for this namespace.

    Mod jars ship their own (`assets/aoa3/lang/zh_cn.lang`).  Vanilla jars ship
    only `en_us` -- 1.18.2 has `assets/minecraft/lang/en_us.json` and nothing
    else -- which is exactly why the locale of each entry is returned alongside
    it: an English entry from the jar must not beat a Chinese entry from the
    index store just because the jar was searched first.
    """
    merged = {}
    origin = {}
    locale_of = {}
    prefixes = ["assets/%s/lang/" % namespace]
    for locale in LOCALES:
        for prefix in prefixes:
            for name in repository.list_prefix(prefix):
                if not name.endswith((".lang", ".json")):
                    continue
                if os.path.basename(name).split(".")[0] != locale:
                    continue
                data, _ = repository.read([name])
                if data is None:
                    continue
                for key, value in parse_lang(data, name).items():
                    merged[key] = value
                    origin[key] = name
                    locale_of[key] = locale
    return merged, origin, locale_of


def parse_lang(data, name):
    text = data.decode("utf-8", "replace")
    if name.endswith(".json"):
        try:
            parsed = json.loads(text)
        except ValueError:
            return {}
        if not isinstance(parsed, dict):
            return {}
        return {k: v for k, v in parsed.items() if isinstance(v, str)}
    out = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        out[key.strip()] = value.strip()
    return out


def index_lang(root):
    """The hashed object store: assets/indexes/<n>.json -> assets/objects/<hh>/<hash>.

    These are the only place this pack keeps vanilla names, and there is one
    index per game version, so they are read newest-key-first but all merged:
    `oak_log` is a 1.13 id and only a 1.13+ index names it.
    """
    indexes = os.path.join(root, "assets", "indexes")
    if not os.path.isdir(indexes):
        return {}, {}, {}
    merged = {}
    origin = {}
    locale_of = {}
    try:
        names = sorted(name for name in os.listdir(indexes) if name.endswith(".json"))
    except OSError:
        return {}, {}, {}
    # Oldest index first so a newer one wins, but both locale passes run over
    # all of them so zh_cn always beats en_us for the same key.
    def stamp(name):
        try:
            return os.path.getmtime(os.path.join(indexes, name))
        except OSError:
            return 0

    names.sort(key=stamp)
    for locale in LOCALES:
        for name in names:
            try:
                with open(os.path.join(indexes, name), encoding="utf-8") as handle:
                    index = json.load(handle)
            except (OSError, ValueError):
                continue
            objects = index.get("objects")
            if not isinstance(objects, dict):
                continue
            for path in sorted(objects.keys()):
                if "/lang/" not in path or not path.startswith("minecraft/"):
                    continue
                base = os.path.basename(path)
                if base.split(".")[0] != locale:
                    continue
                info = objects.get(path) or {}
                digest = info.get("hash")
                if not isinstance(digest, str) or len(digest) < 3:
                    continue
                blob = os.path.join(root, "assets", "objects", digest[:2], digest)
                try:
                    with open(blob, "rb") as handle:
                        data = handle.read()
                except OSError:
                    continue
                for key, value in parse_lang(data, base).items():
                    merged[key] = value
                    origin[key] = "indexes/%s:%s" % (name, path)
                    locale_of[key] = locale
    return merged, origin, locale_of


def name_candidates(namespace, block, variant):
    """Key spellings, most specific first.

    Every shape below is one that actually occurs on this disk:
      block.minecraft.oak_log       1.13+ vanilla
      tile.dirt.name                1.12.2 vanilla
      tile.AchonyLog.name           AoA3 (PascalCase of the id, and NO namespace
                                    segment -- which is why both forms are tried)
    Trying them in order is reading the pack, not inventing a name; a miss falls
    back to the raw id and says so.
    """
    pascal = pascal_case(block)
    out = []

    def add(template, name):
        for prefix in ("%s.%s" % (template, namespace), template):
            key = prefix + "." + name
            if key not in out:
                out.append(key)

    add("block", block)
    add("tile", block + ".name")
    add("tile", block)
    add("tile", pascal + ".name")
    add("tile", pascal)
    add("item", pascal + ".name")
    # TravelersBackpack names its block only as `item.travelers_backpack.name`
    # -- no tile.* key at all -- so the bare `.name` spelling is tried too.
    add("item", block + ".name")
    add("item", block)
    out.append("%s.%s" % (namespace, block))
    if variant:
        # 1.12.2 names a variant-carrying block through the variant key
        # ("tile.dirt.default.name" while its blockstate says "normal").
        plain = variant.replace("=", ".").replace(",", ".")
        add("tile", block + "." + variant + ".name")
        add("tile", block + "." + plain + ".name")
        add("block", block + "." + variant)
    return out


def lookup_name(tables, namespace, block, variant):
    """Key priority first, then locale, then which table has it.

    Two separate ordering bugs lived here.  Searching table-by-table meant the
    vanilla jar's en_us `tile.dirt.name` ("Dirt") won before the index store's
    zh_cn `block.minecraft.dirt` ("泥土") was consulted.  Fixing that to search
    key-first was not enough: 1.18.2's jar ships ONLY en_us, so for the very same
    key `block.minecraft.oak_log` the English entry still came back.  The locale
    of the entry now outranks the order the tables happen to be in.
    """
    for key in name_candidates(namespace, block, variant):
        best = None
        for table, origin, locale_of in tables:
            if key not in table:
                continue
            rank = 1 if locale_of.get(key) == "zh_cn" else 0
            if best is None or rank > best[0]:
                best = (rank, table[key], origin.get(key))
        if best is not None:
            return best[1], key, best[2]
    return None, None, None


def choose_version_dir(root, requested):
    """Which version to read, and why.  Never guesses: a version is chosen only
    because it exists, and the reason is returned so it can be shown."""
    versions = os.path.join(root, "versions")
    dirs = subdirs(versions)
    if not dirs:
        return None, None
    if requested:
        for path in dirs:
            if os.path.basename(path.rstrip("/")) == requested:
                return path, "指定版本"
    # A version with mods is a version somebody actually plays; among those the
    # most recently touched one.  Falling back to plain mtime alone would pick a
    # version that is only a launcher snapshot.
    def stamp(path):
        try:
            return os.path.getmtime(path)
        except OSError:
            return 0
    with_mods = [p for p in dirs if jars_in(os.path.join(p, "mods"))]
    pool = with_mods or dirs
    best = sorted(pool, key=stamp)[-1]
    return best, ("有 mods 的版本里最近改动的" if with_mods else "最近改动的版本")


# What a game directory keeps directly under assets/ that is NOT a namespace.
OBJECT_STORE_DIRS = ("indexes", "objects", "skins")


def extracted_namespaces(root):
    """Namespace folders under `<root>/assets`, if this is a resource tree.

    Deliberately does not count `indexes` / `objects` / `skins`: those are the
    hashed object store, and their presence must not make a whole game
    installation look like an extracted pack.
    """
    assets = os.path.join(root, "assets")
    try:
        entries = os.listdir(assets)
    except OSError:
        return []
    out = []
    for name in sorted(entries):
        if name in OBJECT_STORE_DIRS:
            continue
        if os.path.isdir(os.path.join(assets, name)):
            out.append(name)
    return out


def index_root(root, version_dir):
    """Where the hashed object store lives -- which is NOT always the root.

    A version directory keeps `<version>.jar` and `mods/` but no `assets/`; the
    index store (and with it every vanilla lang file, this pack's vanilla jars
    carrying only `en_us`) belongs to the game directory above `versions/`.
    Without this, pointing the reference at a version folder rendered the right
    geometry with English names -- correct-looking and wrong.
    """
    if os.path.isdir(os.path.join(root, "assets", "indexes")):
        return root
    if version_dir is None:
        return root
    if os.path.abspath(version_dir) != os.path.abspath(root):
        return root
    parent = os.path.dirname(os.path.abspath(root.rstrip("/")))
    if os.path.basename(parent) != "versions":
        return root
    game = os.path.dirname(parent)
    if os.path.isdir(os.path.join(game, "assets", "indexes")):
        return game
    return root


def build_providers(root, version=None):
    """-> (providers, description).  Order matters: the chosen version's own jar
    is searched before its mods, so a mod override wins over vanilla only if the
    version jar is silent -- which is how the game layers them."""
    providers = []
    detail = {}
    if os.path.isfile(root):
        if not is_jar(root):
            return None, {"error": "这是个文件，但不是 jar：" + root}
        providers.append(JarProvider(root, os.path.basename(root)))
        detail["shape"] = "单个 jar"
        return providers, detail

    if not os.path.isdir(root):
        return None, {"error": "路径不存在：" + root}

    version_dir, why = choose_version_dir(root, version)
    if version_dir is None and jars_in(root):
        # The root IS a version directory.  This mirrors the scanner's rule: a
        # version dir has its own <version>.jar plus mods/ and no versions/
        # subdir.  Missing this made the vanilla jar invisible -- the probe
        # reported "模组目录" with 21 providers and the version jar was never
        # opened, so every vanilla block came back as "参考目录里没有这个方块".
        version_dir = root
        why = "根目录本身就是一个版本目录"
    detail["version"] = os.path.basename(version_dir.rstrip("/")) if version_dir else None
    detail["versionWhy"] = why
    detail["indexRoot"] = index_root(root, version_dir)

    if version_dir:
        detail["shape"] = "游戏目录" if version_dir != root else "版本目录"
        for jar in jars_in(version_dir):
            providers.append(JarProvider(jar, os.path.basename(jar), detail["version"]))
        for jar in jars_in(os.path.join(version_dir, "mods")):
            providers.append(JarProvider(jar, os.path.basename(jar), detail["version"]))
    else:
        found = jars_in(os.path.join(root, "mods"))
        if found:
            detail["shape"] = "模组目录"
            for jar in found:
                providers.append(JarProvider(jar, os.path.basename(jar)))

    # An already-extracted assets tree, searched last so it cannot quietly
    # override the real version.  `<root>/assets` alone is NOT evidence of one:
    # a game directory also has `assets/` (the object store), and treating that
    # as a resource tree made every lookup walk the whole installation.  The test
    # is whether namespace folders are actually there.
    if extracted_namespaces(root):
        providers.append(DirProvider(root, os.path.basename(root.rstrip("/")) or root))
        detail.setdefault("shape", "已解包资源根")

    if not providers:
        detail["shape"] = detail.get("shape") or "没认出这是什么"
    return providers, detail


def build_providers_multi(roots, version=None):
    """Providers for several roots, in order.  The FIRST root wins a lookup.

    A project's own pack and the game reference are two different roots, and a
    project model usually inherits vanilla parents it does not ship:
    `example_log` is `{"parent": "block/cube_column"}` and `cube_column` lives in
    the version jar.  Reading only the project pack therefore found no `elements`
    anywhere and reported "这个方块没有几何模型" -- a true statement about that
    chain and a misleading one about the block.  Two roots fix it, and they have
    to be ordered, because the project's own file must win over a same-named one
    in the reference.
    """
    providers = []
    detail = {}
    for index, root in enumerate(roots):
        found, why = build_providers(root, version if index == 0 else None)
        if found is None:
            if index == 0:
                return None, why
            continue
        providers.extend(found)
        if index == 0:
            detail = dict(why)
        else:
            for key in ("version", "versionWhy", "indexRoot"):
                if not detail.get(key) and why.get(key):
                    detail[key] = why[key]
    # "Nothing recognised" is NOT an error here: the single-root path returns an
    # empty provider list plus the reason, and callers turn that into their own
    # message ("参考目录里没有这个方块").  Making it an error replaced every one of
    # those with one generic string and dropped `providers` from `probe`.
    if not providers:
        return providers, detail
    if len(roots) > 1:
        detail["shape"] = " + ".join([part for part in [detail.get("shape"), "附加上下文"] if part])
    return providers, detail


def list_namespace(repository, namespace):
    prefix = "assets/%s/blockstates/" % namespace
    out = []
    seen = set()
    for name in repository.list_prefix(prefix):
        if not name.endswith(".json"):
            continue
        block = name[len(prefix):-len(".json")]
        if "/" in block or block in seen:
            continue
        seen.add(block)
        out.append(block)
    return sorted(out)


def lang_tables_for(repository, root, namespace):
    tables = [read_lang_table(repository, namespace)]
    if namespace == "minecraft":
        tables.append(index_lang(root))
    return tables


# Shape/function families, read off the id.  Longest suffix first, so
# `_fence_gate` does not land in `_fence` and `_concrete_powder` not in
# `_concrete`.  These are not invented buckets: every suffix below is one the
# game itself uses, and anything that matches none of them is honestly "其他"
# rather than being forced somewhere wrong.
FAMILY_SUFFIXES = [
    ("_pressure_plate", "压力板"), ("_fence_gate", "栅栏门"), ("_concrete_powder", "混凝土粉末"),
    ("_glass_pane", "玻璃板"), ("_trapdoor", "活板门"), ("_planks", "木板"),
    ("_sapling", "树苗"), ("_leaves", "树叶"), ("_stairs", "楼梯"), ("_slab", "台阶"),
    ("_fence", "栅栏"), ("_wall", "墙"), ("_pane", "玻璃板"), ("_glass", "玻璃"),
    ("_wool", "羊毛"), ("_carpet", "地毯"), ("_terracotta", "陶瓦"), ("_concrete", "混凝土"),
    ("_banner", "旗帜"), ("_statue", "雕像"), ("_spawner", "刷怪笼"), ("_lamp", "灯"),
    ("_torch", "火把"), ("_door", "门"), ("_button", "按钮"), ("_sign", "告示牌"),
    ("_bed", "床"), ("_chest", "箱子"), ("_ore", "矿石"), ("_log", "原木"),
    ("_wood", "原木"), ("_stem", "原木"), ("_bricks", "砖"), ("_brick", "砖"),
    ("_block", "方块"), ("_grass", "草"), ("_fern", "草"), ("_flower", "植物"),
    ("_mushroom", "植物"), ("_fungus", "植物"), ("_plant", "植物"), ("_crop", "作物"),
    ("_sand", "沙子"), ("_dirt", "泥土"), ("_stone", "石头"),
]

# A mod that files its own models into folders has TOLD us its categories --
# AoA3 uses decoration/generation/functional.  Reading those beats any guess.
GROUP_LABELS = {"decoration": "装饰", "generation": "生成", "functional": "功能",
                "decorative": "装饰", "worldgen": "生成", "misc": "杂项"}


def family_of(block):
    for suffix, label in FAMILY_SUFFIXES:
        if block.endswith(suffix):
            return label
    return "其他"


def group_of(reference):
    """The mod-authored folder, when the model reference has one.

    A flat reference (`dirt`, `oak_log`) means the pack did not categorise, and
    then there is nothing to show -- not an invented "方块" bucket.
    """
    if not isinstance(reference, str) or reference == "":
        return "", ""
    path = reference.split(":", 1)[-1]
    parts = path.split("/")
    if len(parts) < 2:
        return "", ""
    head = parts[0]
    if head in ("block", "item"):
        return "", ""
    return head, GROUP_LABELS.get(head, head)


def block_summaries(repository, namespace):
    """id -> model/group/family, for the picker's categories."""
    out = []
    for block in list_namespace(repository, namespace):
        _state, _variant, entries, _path = resolve_blockstate(repository, namespace, block)
        model = entries[0].get("model") if entries else None
        group, group_label = group_of(model)
        out.append({"id": block, "model": model, "group": group, "groupLabel": group_label,
                    "family": family_of(block)})
    return out


def baked_model(models, merged_textures):
    """Collapse the whole resolution into ONE self-contained model.

    This is the stage that kept breaking.  Resolving a blockstate into something
    renderable is Minecraft's model baking: apply `defaults` and the variant's
    overrides, follow the parent chain, merge the texture tables in the right
    precedence, and hand out refs that already name their namespace.  That was
    implemented TWICE -- here in Python and again in the consumer's JavaScript --
    and each copy understood only part of it, so every new blockstate shape that
    appeared leaked another block (forge_marker `defaults`, variant textures,
    unqualified refs, ...).

    So: do it once, here, and hand the consumer a single model with no parent and
    no unresolved reference.  The consumer only has to draw it.
    """
    elements = None
    for model in models.values():
        candidate = model.get("elements")
        if isinstance(candidate, list) and candidate:
            elements = candidate
            break
    if elements is None:
        return None
    return {"textures": dict(merged_textures), "elements": elements}


def namespace_blocks(repository):
    """namespace -> how many blockstates it has IN THE VERSION BEING READ.

    Deliberately not the scanner's number: that one counts PNGs across every
    installed version, so `minecraft` came out as "13209 张" while the extractor
    only ever reads one version and can actually offer 407 blocks.  A picker
    labelled with a number you cannot get is worse than no number.
    """
    seen = set()
    for provider in repository.providers:
        for name in repository.names(provider):
            parts = name.split("/")
            if len(parts) > 3 and parts[0] == "assets" and parts[2] == "blockstates" and name.endswith(".json"):
                seen.add(parts[1])
    out = [{"name": namespace, "blocks": len(list_namespace(repository, namespace))}
           for namespace in sorted(seen)]
    out.sort(key=lambda item: (-item["blocks"], item["name"]))
    return out


# ---------------------------------------------------------------------------
# items, entities, and the blocks the game draws in code
#
# A resource pack does NOT carry entity or block-entity GEOMETRY -- those are
# Java classes (`ModelZombie`, `ChestRenderer`).  What a pack does carry is:
#
#   names      lang keys `entity.<ns>.<id>` (1.13+, and most mods even on 1.12.2)
#              or `entity.<ClassName>.name` (vanilla 1.12.2, no namespace)
#   textures   `textures/entity/**` in vanilla, `textures/entities/**` in AoA3
#              -- BOTH spellings are in the wild, and looking for only one is
#              how "659 张生物贴图" reads as zero
#   grouping   the mod's own organisation: AoA3 files its mob loot tables per
#              dimension (`loot_tables/entities/mobs/<dimension>/<id>.json`)
#   geometry   ONLY for the GeckoLib family, which ships real box data as
#              `geo/<name>.geo.json`
#
# So the honest scan lists every candidate with its name, its textures, its
# group, and a verdict on whether we can DRAW it (`geo` / `code`), and it says
# which of those sources answered.  "We have 659 AoA3 mob textures" is not the
# same claim as "we can draw 659 AoA3 mobs": none of them has geometry in the
# pack, so all 659 are `code`.
# ---------------------------------------------------------------------------

ENTITY_TEXTURE_DIRS = ("textures/entity/", "textures/entities/")
GEO_DIRS = ("geo/", "geo/block/", "geo/item/", "geo/entity/")

# Item families, read off the id -- same rule and the same honesty note as
# FAMILY_SUFFIXES for blocks: longest suffix first so `_chestplate` does not
# land in `_plate`, and anything matching none of these is honestly "其他".
ITEM_FAMILIES = [
    ("_chestplate", "胸甲"), ("_leggings", "护腿"), ("_boots", "靴子"), ("_helmet", "头盔"),
    ("_pickaxe", "镐"), ("_shovel", "锹"), ("_sword", "剑"), ("_hoe", "锄"), ("_axe", "斧"),
    ("_shears", "剪刀"), ("_fishing_rod", "钓竿"), ("_flint_and_steel", "打火石"),
    ("_bow", "弓"), ("_arrow", "箭"), ("_shield", "盾"),
    ("_ingot", "锭"), ("_nugget", "粒"), ("_dust", "粉"), ("_gem", "宝石"),
    ("_bucket", "桶"), ("_seeds", "种子"), ("_seed", "种子"), ("_sapling", "树苗"),
    ("_potion", "药水"), ("_spawn_egg", "刷怪蛋"), ("_book", "书"), ("_apple", "苹果"),
    ("_stew", "炖菜"), ("_soup", "汤"), ("_pie", "派"), ("_bread", "面包"),
    ("_cookie", "曲奇"), ("_cake", "蛋糕"), ("_carrot", "胡萝卜"), ("_potato", "马铃薯"),
    ("_berries", "浆果"), ("_meat", "肉"), ("_fish", "鱼"), ("_cod", "鳕鱼"),
    ("_salmon", "鲑鱼"), ("_beef", "牛肉"), ("_porkchop", "猪排"), ("_chicken", "鸡肉"),
    ("_mutton", "羊肉"), ("_rabbit", "兔肉"), ("_door", "门"), ("_sign", "告示牌"),
    ("_boat", "船"), ("_minecart", "矿车"), ("_banner", "旗帜"), ("_bed", "床"),
    ("_chest", "箱子"), ("_shulker_box", "潜影盒"), ("_dye", "染料"),
]


def item_family(item):
    for suffix, label in ITEM_FAMILIES:
        if item.endswith(suffix):
            return label
    # Some packs name the item after the thing itself (`apple`, `sword`).
    bare = {suffix.lstrip("_"): label for suffix, label in ITEM_FAMILIES}
    return bare.get(item, "其他")


def all_names(repository):
    """Every archive name under the first provider order, once.

    A scan that called `list_prefix` per block would walk every name of every
    provider once per block (407 blocks x 30 jars); this walks it once and
    filters in memory.
    """
    out = []
    seen = set()
    for provider in repository.providers:
        for name in repository.names(provider):
            if name not in seen:
                seen.add(name)
                out.append(name)
    return out


def _under(names, prefix):
    return [name for name in names if name.startswith(prefix)]


def _ids_from(names, prefix, suffix=".json"):
    out = set()
    for name in _under(names, prefix):
        if not name.endswith(suffix):
            continue
        rel = name[len(prefix):-len(suffix)]
        if rel:
            out.add(rel)
    return out


def item_facts(repository, namespace, item, names=None):
    """What an item is, in the terms the viewer needs: shape, layers, GUI matrix.

    `shape` is the PRESENTATION FORM, and it is read, not guessed:
      * `iso`  -- the model chain really has `elements` (a block item: the GUI
                  icon is the block drawn isometrically, `display.gui` and all)
      * `flat` -- no elements anywhere, but `layer0..N` textures (a generated
                  item: the icon is those sprites stacked, lit from the front)
      * `none` -- neither (a stub model that only names a parent)
    """
    chain = collections.OrderedDict()
    sources = []
    missing = []
    merged = walk_model(repository, namespace, "item/%s" % item, chain, sources, missing)
    if not chain:
        return None
    models = list(chain.values())
    elements = 0
    for model in models:
        candidate = model.get("elements")
        if isinstance(candidate, list):
            elements += len(candidate)
    layers = []
    for index in range(8):
        key = "layer%d" % index
        if key in merged:
            layers.append(merged[key])
    gui = None
    gui_light = None
    overrides = None
    for model in models:
        display = model.get("display")
        if gui is None and isinstance(display, dict) and isinstance(display.get("gui"), dict):
            gui = display["gui"]
        if gui_light is None and isinstance(model.get("gui_light"), str):
            gui_light = model["gui_light"]
        if overrides is None and isinstance(model.get("overrides"), list):
            overrides = [entry for entry in model["overrides"] if isinstance(entry, dict)]
    parent_refs = [key.split(":", 1)[-1] for key in chain.keys()]
    shape = "iso" if elements > 0 else ("flat" if layers else "none")
    handheld = any(ref.endswith("item/handheld") for ref in parent_refs)
    egg = any("template_spawn_egg" in ref for ref in parent_refs)
    block_item = any(ref.startswith("block/") or "/block/" in ref for ref in parent_refs)
    if shape == "iso":
        form = "block"
    elif egg:
        form = "egg"
    elif set(item.split("_")) & {"helmet", "chestplate", "leggings", "boots"}:
        form = "armour"
    elif handheld:
        form = "tool"
    else:
        form = "item"
    return {
        "id": item,
        "form": form,
        "family": item_family(item),
        "shape": shape,
        # `gui_light` is the 1.18.2 data field; 1.12.2 has no such field and
        # decides with `IBakedModel.isGui3d()` instead, which is the same
        # question: a 3D icon takes the side lighting, a flat one does not.
        "light": gui_light if gui_light else ("side" if shape == "iso" else "front"),
        "guiLightFromData": gui_light is not None,
        "display": gui,
        "layers": layers,
        "elements": elements,
        "models": parent_refs,
        "textures": dict(merged),
        "sources": [name for name in sources if name],
        "missing": [name for name in missing],
        "overrides": overrides or [],
    }


ITEM_FORMS = {"block": "方块（等距图标）", "tool": "工具/武器（平铺）",
              "armour": "盔甲（平铺图标）", "egg": "刷怪蛋（平铺）",
              "item": "物品（平铺）"}


def list_items(repository, namespace, tables=None, names=None):
    """Every item a pack declares, from `models/item/**`.

    A resource pack has no item registry: what exists IS the model file.  That
    is the same convention blockstates already use here, and it is why an item
    with a model but no lang key still shows up (with its id as the name).
    """
    names = names if names is not None else all_names(repository)
    prefix = "assets/%s/models/item/" % namespace
    ids = sorted(_ids_from(names, prefix))
    # A pack's `models/item/` holds PARENTS as well as items: vanilla ships
    # `generated.json`, `handheld.json` and `template_*.json` in the same folder,
    # and none of them is an item.  The pack does not label them, but it shows
    # both facts that tell them apart: something else names it as a `parent`,
    # and nothing gives it a name.
    used_as_parent = set()
    out = []
    for item in ids:
        facts = item_facts(repository, namespace, item)
        if facts is None:
            continue
        # The same key search blocks use: it already tries
        # `item.<ns>.<id>`, `item.<ns>.<id>.name`, `item.<ns>.<Pascal>.name`,
        # `block.<ns>.<id>` and the 1.12.2 `tile.*` spellings.  A block item's
        # name really is a `block.` key in 1.13+ (`block.minecraft.acacia_button`),
        # which is why asking only for `item.` left every button nameless.
        name, key, where = lookup_name(tables or [], namespace, item, None)
        facts["name"] = name if name else item
        facts["nameKey"] = key
        facts["nameFrom"] = where
        # A block item's family is the BLOCK family (`_button`, `_stairs`, ...);
        # a flat item's is the item suffix table.
        facts["family"] = family_of(item) if facts["form"] == "block" else item_family(item)
        facts["formLabel"] = ITEM_FORMS.get(facts["form"], facts["form"])
        facts["named"] = key is not None
        for reference in facts["models"][1:]:
            used_as_parent.add(reference)
        out.append(facts)
    for facts in out:
        facts["parentOnly"] = (not facts["named"]) and ("item/%s" % facts["id"] in used_as_parent)
    return out


def norm_id(word):
    """`armor_stand` == `armorstand`: the pack's folder names do not always agree
    with the registry id (vanilla's armor-stand textures live in
    `textures/entity/armorstand/`, no underscore), and treating them as different
    entities loses the texture for the one that has the name."""
    return str(word).replace("_", "").replace("-", "").lower()


def snake_case(word):
    """`XPOrb` -> `xp_orb`, `SmallFireball` -> `small_fireball`.

    Vanilla 1.12.2 names entities by CLASS simple name in lang
    (`entity.SmallFireball.name`), not by registry id, so the id has to be
    reconstructed.  It is a reconstruction and it is marked as one.
    """
    out = []
    for index, char in enumerate(word):
        if char.isupper() and index > 0 and (not word[index - 1].isupper()
                                             or (index + 1 < len(word) and word[index + 1].islower())):
            out.append("_")
        out.append(char.lower())
    return "".join(out)



# ---------------------------------------------------------------------------
# "the game does not draw this shape from the pack"
#
# Both reported cases are the same shape of thing, and the pack SAYS SO:
#
#   travelersbackpack:block/cake  -> block/cube_all, textures.all = block/cake_side
#   ars_nouveau:block/relay_deposit -> block/cube_all, textures.all = blocks/source_deposit
#
# A plain full cube painted with a stand-in texture, because the real thing is
# drawn by a block entity renderer in Java.  Drawing the stand-in is not a
# rendering bug -- it is faithfully drawing what the pack says -- but it is a
# WRONG picture, and the pack gives three pieces of evidence to catch it:
#
#   no-elements    the whole chain has no `elements` at all (chest, sign, bed,
#                  shulker box, banner: vanilla 1.18.2 draws all of them in code)
#   builtin/entity the ITEM model parents to `builtin/entity`, which is vanilla's
#                  own marker for `BlockEntityWithoutLevelRenderer` -- i.e. "the
#                  item is drawn in code" (vanilla chest, and both blocks above)
#   geo            GeckoLib puts the real boxes in the pack: `geo/<name>.geo.json`
#                  -- findable, so the stand-in can be REPLACED rather than hidden
# ---------------------------------------------------------------------------

def geo_geometry_for(repository, namespace, name, names=None):
    """The GeckoLib geometry for `name`, if the pack ships one."""
    names = names if names is not None else all_names(repository)
    wanted = norm_id(name)
    best = None
    for geo_dir in GEO_DIRS:
        prefix = "assets/%s/%s" % (namespace, geo_dir)
        for path in _under(names, prefix):
            if not path.endswith(".json"):
                continue
            stem = os.path.basename(path)[:-len(".json")]
            if stem.endswith(".geo"):
                stem = stem[:-len(".geo")]
            if norm_id(stem) != wanted:
                continue
            data, _hit = repository.read([path])
            if data is None:
                continue
            try:
                parsed = json.loads(data.decode("utf-8", "replace"))
            except ValueError:
                continue
            geometry = parsed.get("minecraft:geometry") if isinstance(parsed, dict) else None
            if isinstance(geometry, list) and geometry:
                best = {"file": path, "format": parsed.get("format_version"),
                        "geometry": geometry[0]}
                break
        if best is not None:
            break
    return best


def item_model_marker(repository, namespace, item):
    """The item model for `item`, peeled down to whatever marks it as code-drawn.

    `builtin/entity` is vanilla's marker for "this is rendered by code, there is
    no model here"; 1.18.2's `item/chest.json` uses it, and so does
    `ars_nouveau`'s sourcelink item.  Returns the marker name or None.
    """
    chain = collections.OrderedDict()
    sources = []
    missing = []
    walk_model(repository, namespace, "item/%s" % item, chain, sources, missing)
    for model in chain.values():
        # `builtin/entity` is a PARENT reference, not a file: `walk_model` cannot
        # find it (it is built into the game, there is no JSON for it), so it
        # shows up as a missing parent and never as a chain entry.  Looking for
        # it among the chain KEYS finds nothing and silently reports "no marker"
        # for every code-drawn item -- which is exactly how the first version of
        # this failed on `travelersbackpack:cake` while working on nothing.
        parent = model.get("parent") if isinstance(model, dict) else None
        if isinstance(parent, str) and parent.split(":")[-1] == "builtin/entity":
            return "builtin/entity"
    return None

def list_entities(repository, namespace, names=None):
    """Every entity candidate the pack can tell us about, with a draw verdict.

    Sources, and which one answered, are both reported: a name that came from a
    1.12.2 class-name lang key is a guess at the registry id, and a candidate
    that only exists because a texture file is named after it has no name at all
    beyond that file.
    """
    names = names if names is not None else all_names(repository)
    tables, origin, locale_of = read_lang_table(repository, namespace)
    found = {}

    by_norm = {}

    def slot(entity_id):
        # Fold spellings that differ only by separators onto ONE entry, keeping
        # the spelling that has a name: `armor_stand` (lang) wins over
        # `armorstand` (folder).
        key = norm_id(entity_id)
        existing = by_norm.get(key)
        if existing is not None:
            return existing
        entry = {"id": entity_id, "name": entity_id, "nameKey": None,
                 "nameFrom": None, "nameSource": None, "textures": [],
                 "group": "", "geometry": None, "animations": [], "draw": "code"}
        by_norm[key] = entry
        found[entity_id] = entry
        return entry

    prefix = "entity.%s." % namespace
    for key, value in tables.items():
        if not key.startswith("entity."):
            continue
        rest = key[len("entity."):]
        if rest.endswith(".name"):
            rest = rest[:-len(".name")]
        parts = rest.split(".")
        if len(parts) >= 2 and parts[0] == namespace:
            entity_id = ".".join(parts[1:])
            entry = slot(entity_id)
            entry["name"] = value
            entry["nameKey"] = key
            entry["nameFrom"] = origin.get(key)
            entry["nameSource"] = "lang"
        elif namespace == "minecraft" and len(parts) == 1:
            # 1.12.2: no namespace in the key, the class name is the id.
            entity_id = snake_case(parts[0])
            entry = slot(entity_id)
            if entry["nameSource"] is None:
                entry["name"] = value
                entry["nameKey"] = key
                entry["nameFrom"] = origin.get(key)
                entry["nameSource"] = "lang-class-name"

    for texture_dir in ENTITY_TEXTURE_DIRS:
        texture_prefix = "assets/%s/%s" % (namespace, texture_dir)
        for name in _under(names, texture_prefix):
            if not name.endswith(".png"):
                continue
            rel = name[len(texture_prefix):]
            parts = rel.split("/")
            basename = parts[-1][:-4]
            for candidate, from_folder in ((basename, False), (parts[-2] if len(parts) > 1 else basename, True)):
                entry = slot(candidate)
                if name not in entry["textures"]:
                    entry["textures"].append(name)
                if entry["nameSource"] is None:
                    entry["nameSource"] = "texture"
                if from_folder and not entry["group"]:
                    entry["group"] = ""

    loot_prefix = "assets/%s/loot_tables/entities/" % namespace
    for name in _under(names, loot_prefix):
        if not name.endswith(".json"):
            continue
        parts = name[len(loot_prefix):-len(".json")].split("/")
        if len(parts) >= 2:
            entry = by_norm.get(norm_id(parts[-1]))
            if entry is not None and not entry["group"]:
                # The whole parent path, not just the first segment: AoA3 files
                # `loot_tables/entities/mobs/<dimension>/<mob>.json`, so
                # "mobs/abyss" is the mod's own two-level classification.
                entry["group"] = "/".join(parts[:-1])

    for geo_dir in GEO_DIRS:
        geo_prefix = "assets/%s/%s" % (namespace, geo_dir)
        for name in _under(names, geo_prefix):
            if not name.endswith(".json"):
                continue
            rel = name[len(geo_prefix):]
            basename = rel[:-len(".json")]
            data, _hit = repository.read([name])
            if data is None:
                continue
            try:
                parsed = json.loads(data.decode("utf-8", "replace"))
            except ValueError:
                continue
            geometry = parsed.get("minecraft:geometry") if isinstance(parsed, dict) else None
            candidate = basename
            if candidate.endswith(".geo"):
                candidate = candidate[:-len(".geo")]
            generic = False
            for suffix in ("_walk", "_walking", "_fly", "_flying", "_attack", "_idle",
                           "_standing", "_sit", "_sleep", "_death", "_hurt", "_spawn",
                           "_animations", "_animation"):
                if candidate.endswith(suffix):
                    generic = True
            entry = by_norm.get(norm_id(candidate))
            if entry is None and not generic and rel.split("/")[0:1]:
                # Geometry with no lang key and no texture of its own is still
                # evidence of something drawable: GeckoLib puts the boxes in the
                # pack, so the scan can offer it even when the mod forgot a name.
                entry = slot(candidate)
                entry["nameSource"] = "geometry"
            if entry is None:
                continue
            if isinstance(geometry, list) and geometry:
                description = geometry[0].get("description") if isinstance(geometry[0], dict) else None
                description = description if isinstance(description, dict) else {}
                entry["geometry"] = {
                    "file": name,
                    "format": parsed.get("format_version"),
                    "textureWidth": description.get("texture_width"),
                    "textureHeight": description.get("texture_height"),
                    "bones": len(geometry[0].get("bones") or []),
                }
                entry["draw"] = "geo"
            else:
                if name not in entry["animations"]:
                    entry["animations"].append(name)

    # A file STEM is only an entity if it has a name of its own, or if its folder
    # has none.  Vanilla lays a mob out as `entity/zombie/zombie.png`: the folder
    # is the entity and the file is the variant.  Without this rule every such
    # file became a phantom entity called `wood`, `normal`, `black`, `sheep_fur`
    # -- 419 "entities" in vanilla, most of them texture file names.
    for entity_id in list(found.keys()):
        entry = found[entity_id]
        if entry["nameSource"] != "texture" or entry["geometry"] is not None or not entry["textures"]:
            continue
        stems = {os.path.basename(name).split(".")[0] for name in entry["textures"]}
        if entity_id not in stems:
            continue                                  # this one IS the folder
        parents = {os.path.basename(os.path.dirname(name)) for name in entry["textures"]}
        for parent_id in parents:
            parent = by_norm.get(norm_id(parent_id))
            if parent is None or parent is entry:
                continue
            if parent["nameSource"] is None or parent["nameSource"] == "texture":
                continue                              # nothing better to merge into
            for name in entry["textures"]:
                if name not in parent["textures"]:
                    parent["textures"].append(name)
            found.pop(entity_id, None)
            break

    # Animation files are not geometry: `ars_nouveau` keeps them next to nothing
    # in particular (`animations/<model>_<state>.geo.json`) and they carry an
    # `animations` table instead of `minecraft:geometry`.  Attach them to the
    # longest entry id they start with, so the scan can say "这个模型有动画文件"
    # without pretending to have read them.
    for animation_dir in ("animations/", "geo/"):
        animation_prefix = "assets/%s/%s" % (namespace, animation_dir)
        for name in _under(names, animation_prefix):
            if not name.endswith(".json"):
                continue
            basename = os.path.basename(name)[:-len(".json")]
            if basename.endswith(".geo"):
                basename = basename[:-len(".geo")]
            owner = None
            for entity_id in found:
                if norm_id(basename).startswith(norm_id(entity_id)) and \
                        (owner is None or len(entity_id) > len(owner)):
                    owner = entity_id
            if owner is None:
                continue
            entry = found[owner]
            if entry["geometry"] is not None and entry["geometry"]["file"] == name:
                continue
            if name not in entry["animations"]:
                entry["animations"].append(name)

    out = list(found.values())
    for entry in out:
        if entry["draw"] != "geo" and entry["textures"]:
            entry["why"] = "几何在代码里（原版和绝大多数模组都不把生物模型放进资源包），包里只有贴图"
        elif entry["draw"] != "geo":
            entry["why"] = "只有名字，连贴图都没找到"
    # A named candidate first, and among the named ones the mod's own grouping;
    # texture-only candidates last, because they are the weakest evidence.
    order = {"lang": 0, "lang-class-name": 1, "geometry": 2, "texture": 3, None: 4}
    out.sort(key=lambda item: (order.get(item["nameSource"], 3), item["group"], item["id"]))
    return out


def code_drawn_blocks(repository, namespace, names=None, limit=None):
    """Blocks whose whole model chain has no `elements`: the game draws them.

    Chests, signs, beds, shulker boxes and banners are the vanilla family; a
    mod's decorative block that a TileEntity renders is the same shape of thing.
    The pack still knows their TEXTURES, and for several of them the texture
    folder is the only evidence that the block exists at all -- so the candidate
    entity textures are returned next to each one instead of leaving the reader
    with "画不出来".
    """
    names = names if names is not None else all_names(repository)
    entity_textures = []
    for texture_dir in ENTITY_TEXTURE_DIRS:
        entity_textures.extend(_under(names, "assets/%s/%s" % (namespace, texture_dir)))
    blocks = list_namespace(repository, namespace)
    if limit is not None:
        blocks = blocks[:limit]
    out = []
    for block in blocks:
        state, _variant, entries, state_path = resolve_blockstate(repository, namespace, block)
        if state is None or not entries:
            continue
        chain = collections.OrderedDict()
        sources = []
        missing = []
        for entry in entries:
            walk_model(repository, namespace, entry.get("model"), chain, sources, missing)
        elements = 0
        for model in chain.values():
            candidate = model.get("elements")
            if isinstance(candidate, list):
                elements += len(candidate)
        geo = geo_geometry_for(repository, namespace, block, names)
        marker = item_model_marker(repository, namespace, block)
        if elements > 0 and geo is None and marker is None:
            continue
        # Which entity textures belong to THIS block?  A bare prefix test says
        # `black_banner` owns `entity/cat/black.png`, which is noise.  The pack's
        # own layout answers it: vanilla keeps a block entity's texture in a
        # folder named after the block family (`chest/`, `signs/`, `bed/`,
        # `banner/`, `shulker/`) with the VARIANT as the file name, so
        # `oak_sign` is `signs/oak.png` and `red_bed` is `bed/red.png`.
        tokens = set(block.split("_"))
        scored = []
        for name in entity_textures:
            stem = os.path.basename(name).split(".")[0]
            folder = os.path.basename(os.path.dirname(name))
            bare = folder.rstrip("s")
            stem_tokens = set(stem.split("_"))
            # The FAMILY test is what removes the ties: `acacia` is a subset of
            # `acacia_sign`'s words, but so is `boat`, and only `signs/` is the
            # family this block belongs to.
            family = bool(bare) and ("_" + bare) in ("_" + block)
            score = 0
            if stem == block or folder == block:
                score = 5                                   # exact
            elif family and stem_tokens and stem_tokens <= tokens:
                score = 4                                   # right family, right variant
            elif family:
                score = 3                                   # right family, no variant match
            if score > 0:
                # More matching words first: `shulker_black.png` beats the plain
                # `shulker.png` for `black_shulker_box`.
                scored.append((score, len(stem_tokens), folder, name))
        scored.sort(key=lambda item: (-item[0], -item[1], item[2], item[3]))
        hints = [{"texture": name, "folder": folder, "score": score}
                 for score, _words, folder, name in scored[:3]]
        reasons = []
        if elements == 0:
            reasons.append("no-elements")
        if marker is not None:
            reasons.append(marker)
        if geo is not None:
            reasons.append("geo")
        out.append({"id": block,
                    "reason": reasons[0] if reasons else ("block-entity" if hints else "no-geometry-and-no-hint"),
                    "reasons": reasons,
                    "standInCube": elements > 0,
                    "geo": geo["file"] if geo is not None else None,
                    "textures": hints,
                    "missingModels": [name for name in missing][:6],
                    "state": state_path})
    return out


def namespaces(root, version=None):
    roots = root if isinstance(root, (list, tuple)) else [root]
    providers, detail = build_providers_multi(roots, version)
    if providers is None:
        return {"error": detail["error"]}
    repository = Repository(providers)
    return {
        "root": os.path.abspath(roots[0]),
        "shape": detail.get("shape"),
        "version": detail.get("version"),
        "versionWhy": detail.get("versionWhy"),
        "namespaces": namespace_blocks(repository),
    }


def extract(root, namespace, block, version=None, variant=None):
    roots = root if isinstance(root, (list, tuple)) else [root]
    providers, detail = build_providers_multi(roots, version)
    if providers is None:
        return {"error": detail["error"]}
    repository = Repository(providers)
    # `animate=True`: this is the 3D path, so an animated texture arrives as its
    # whole strip with a description of how to play it, not as frame 0.
    result = extract_with(repository, detail.get("indexRoot") or roots[0], namespace, block,
                          lang_tables_for(repository, detail.get("indexRoot") or roots[0], namespace),
                          detail, animate=True, wanted_variant=variant)
    # A blockstate whose whole chain has no `elements` has nothing to draw
    # (1.12.2 mods do this for blocks a TileEntity renders in code --
    # eplus:decorative_book is `{parent: block/block, particle: ...}`).  Say so
    # specifically, but ONLY when there is no other error: the consumer treats
    # the mere PRESENCE of `error` as failure (`error !== undefined`), so a key
    # that is merely null would fail every block.
    if result.get("noGeometry") is True and result.get("error") is None:
        result["error"] = ("这个方块没有几何模型（整条模型链里都没有 elements，通常是用方块实体"
                           + "在代码里渲染的），所以画不出来：" + namespace + ":" + block)
    # ...and the OTHER way the same thing happens: the pack ships a placeholder
    # cube (`block/cube_all` + a stand-in texture) because the real shape is
    # drawn in code.  `travelersbackpack:cake` and `ars_nouveau:alchemical_sourcelink`
    # are both this, and both say so -- their ITEM models parent to
    # `builtin/entity`.  Reported, never silently ignored: drawing the stand-in
    # is a wrong picture that looks deliberate.
    marker = item_model_marker(repository, namespace, block)
    geo = geo_geometry_for(repository, namespace, block)
    if marker is not None or geo is not None or result.get("noGeometry") is True:
        result["codeRendered"] = {
            "reasons": ([marker] if marker else []) + (["geo"] if geo else [])
                       + (["no-elements"] if result.get("noGeometry") is True else []),
            "standInCube": result.get("noGeometry") is not True,
            "geometry": geo["file"] if geo else None,
            "bones": len(geo["geometry"].get("bones") or []) if geo else None,
        }
    return result


def collect_texture_payload(repository, namespace, referenced, merged_textures, animate=True):
    """Read every texture a model chain references, in the form a consumer needs.

    Pulled out of `extract_with` so the ITEM path can use it too: an item with
    `overrides` (vanilla's clock is 64 of them) needs the same texture payload
    once per override frame, and two copies of this loop would drift -- the
    animation handling in here is the part that took the longest to get right.
    """
    textures = {}
    texture_files = {}
    animated = {}
    animations = {}
    missing_textures = []
    sources = []
    for name in ordered_unique(referenced):
        resolved = dereference(merged_textures, name)
        if not resolved:
            continue
        tex_namespace, tex_path = split_ref(resolved, namespace)
        data = None
        found = None
        for candidate_namespace in namespace_chain(tex_namespace):
            data, found = repository.read(texture_candidates(candidate_namespace, tex_path))
            if data is not None:
                break
        if data is None:
            missing_textures.append(resolved)
            continue
        if len(data) > MAX_TEXTURE_BYTES:
            missing_textures.append(resolved + "（太大）")
            continue
        meta = None
        if found is not None:
            meta, _meta_name = repository.read([found + ".mcmeta"])
        animation = animation_of(data, meta)
        if animation is not None:
            animated[resolved] = animation["frames"]
            if animate:
                animations[resolved] = animation
            else:
                data, _ = first_frame(data, meta)
        textures[resolved] = base64.b64encode(data).decode("ascii")
        texture_files[resolved] = found
        sources.append(found)
    return textures, texture_files, animated, animations, missing_textures, sources


def extract_with(repository, root, namespace, block, tables, detail,
                 animate=False, wanted_variant=None, item=False):
    if item:
        # An ITEM model is a one-entry blockstate as far as everything below is
        # concerned: `models/item/<name>.json` -> parents -> either `elements`
        # (a block item: drawn isometrically) or `layer0..N` (a generated item:
        # drawn as stacked sprites).  Reusing this path means the item inherits
        # the whole chain walk, the baking, the animation handling and the name
        # lookup, instead of a second implementation that drifts from it.
        state = {"variants": {"": {"model": "item/%s" % block}}}
        variant = None
        entries = [{"model": "item/%s" % block}]
        state_path = "assets/%s/models/item/%s.json" % (namespace, block)
    else:
        state, variant, entries, state_path = resolve_blockstate(repository, namespace, block, wanted_variant)
    if state is None or not entries:
        return {"error": "参考目录里没有这个方块：%s:%s" % (namespace, block),
                "version": detail.get("version"), "shape": detail.get("shape")}

    models = collections.OrderedDict()
    sources = []
    missing_models = []
    merged_textures = {}
    # A `multipart` blockstate is a LIST of applies and each one carries its own
    # x/y rotation -- `prismarine_wall` is the post plus four sides at
    # y = 0/90/180/270.  Folding those into one model would mean applying four
    # different rotations to one element list, so they stay separate refs and the
    # consumer rotates each with the code it already has (`modelRotations`).
    multipart = len(entries) > 1
    for entry in (entries or []):
        chain = collections.OrderedDict()
        table = walk_model(repository, namespace, entry.get("model"), chain, sources, missing_models)
        for key, model in chain.items():
            if key not in models:
                models[key] = model
        for key, value in (table or {}).items():
            if key not in merged_textures:
                merged_textures[key] = value
    # Forge lets a variant (or `defaults`) override the model's textures.  Those
    # overrides belong to no model file, so they have to be merged into the child
    # model here or the consumer -- which only ever sees the models -- cannot
    # resolve `#end` / `#side` and skips every face.
    override = entries[0].get("textures") if entries else None
    if isinstance(override, dict) and override:
        merged = dict(merged_textures)
        for key, value in override.items():
            merged[key] = value
        merged_textures = merged
        first = next(iter(models), None)
        if first is not None:
            table = models[first].get("textures")
            child = dict(table) if isinstance(table, dict) else {}
            for key, value in override.items():
                child[key] = value
            models[first]["textures"] = child
    if merged_textures:
        merged_textures = qualify_textures(repository, namespace, merged_textures)
    # The models themselves have to be rewritten too -- that is what the consumer
    # dereferences.  Qualifying only the merged table fixed the map keys and left
    # the model saying `blocks/wool_colored_brown`, so the lookup still missed.
    for model in models.values():
        table = model.get("textures")
        if isinstance(table, dict):
            model["textures"] = qualify_textures(repository, namespace, table)

    referenced = []
    # `elements_of` returns ONE element list -- the rule for a single model
    # chain.  A multipart blockstate is drawn apply by apply, so EVERY apply's
    # textures are needed: taking just the first model's shipped the post's
    # texture and none of the sides', and the consumer then drew the post and
    # silently dropped every side (a wall that is only a thin column).  Same
    # shape of bug as the shared `ref:` handle: correct-looking, and only
    # visible on the second piece of the SAME block.
    #
    # Each apply's faces must also be dereferenced against ITS OWN texture
    # table: vanilla writes `"texture": "#wall"`, and every apply model carries
    # its own `wall`, so dereferencing all of them through the first chain's
    # merged table points every piece at the first piece's picture.
    if multipart:
        chains = [model for model in models.values()
                  if isinstance(model.get("elements"), list) and model.get("elements")]
    else:
        first = elements_of(models)
        chains = [{"elements": first, "textures": merged_textures}] if first else []
    for chain in chains:
        table = chain.get("textures") if isinstance(chain.get("textures"), dict) else {}
        for element in chain.get("elements") or []:
            faces = element.get("faces") if isinstance(element, dict) else None
            if not isinstance(faces, dict):
                continue
            for face in faces.values():
                if not isinstance(face, dict) or "texture" not in face:
                    continue
                referenced.append(dereference(table, face["texture"])
                                  or dereference(merged_textures, face["texture"])
                                  or face["texture"])
    # An animated texture is a strip, and a consumer that maps UV 0..1 over it
    # smears every frame onto one face.  The 3D path therefore takes the whole
    # strip PLUS the description of how to step through it; the icon path (a CSS
    # background) still crops, because a squashed strip is not an icon.
    (textures, texture_files, animated, animations,
     missing_textures, texture_sources) = collect_texture_payload(
        repository, namespace, referenced, merged_textures, animate)
    sources.extend(texture_sources)

    # --- bake, so the consumer never has to resolve anything itself ---
    baked_refs = [entry.get("model") for entry in entries]
    # The `when` clause per apply, parallel to `modelRefs`.  Only meaningful for
    # multipart, and only shipped when the two lists really do line up: a
    # consumer that evaluates a clause against the wrong model would draw the
    # wrong thing and say it had checked, which is worse than not checking.
    multipart_whens = []
    if multipart:
        pairs = multipart_applies(state)
        if len(pairs) == len(entries):
            multipart_whens = [when for _entry, when in pairs]
        else:
            multipart = False
    baked = None if multipart else baked_model(models, merged_textures)
    if baked is not None:
        models = collections.OrderedDict(models)
        models["__baked__"] = baked
        baked_refs = ["__baked__"]
    # A blockstate whose whole chain contains no `elements` has no geometry to
    # draw -- 1.12.2 mods do this for blocks a TileEntity renders in code
    # (eplus:decorative_book is one: `{parent: block/block, particle: ...}`, no
    # elements anywhere).  No amount of model baking produces that, so say so
    # specifically instead of leaving the consumer with a silent empty model.
    no_geometry = baked is None
    if no_geometry and multipart:
        # `baked` is None here because the applies were deliberately LEFT
        # unbaked, not because there was nothing to draw.
        no_geometry = not any(isinstance(model.get("elements"), list) and model.get("elements")
                              for model in models.values())

    name, key, origin = lookup_name(tables, namespace, block, variant)

    return {
        "root": os.path.abspath(root),
        "shape": detail.get("shape"),
        "version": detail.get("version"),
        "versionWhy": detail.get("versionWhy"),
        "namespace": namespace,
        "block": block,
        "noGeometry": no_geometry,
        "animatedTextures": animated,
        "animations": animations,
        "name": name or block,
        "nameKey": key,
        "nameFrom": origin,
        "variant": None if variant is None else canonical_variant_key(variant),
        "variantKeys": variant_key_list(state),
        "variantAxes": variant_axes(state),
        "variantDefaults": variant_properties(None if variant is None else canonical_variant_key(variant)),
        "variantRotation": None if multipart else variant_rotation(entries),
        "variants": sorted((state.get("variants") or {}).keys()),
        "blockstate": state,
        "blockstatePath": state_path,
        "modelRefs": baked_refs,
        # Parallel to `modelRefs`, and only meaningful for multipart: each apply
        # brings its own rotation.  Always as long as the ref list, zeros
        # included, so the consumer never has to guess which index has one.
        "modelRotations": ([] if not multipart else
                           [{"x": entry.get("x") or 0, "y": entry.get("y") or 0}
                            for entry in entries]),
        # Parallel to `modelRefs`: `{}` means the game draws this apply whenever
        # the block is drawn at all.  Values are strings -- see `normalize_when`.
        "multipartWhens": multipart_whens,
        "multipart": multipart,
        "models": models,
        "textures": textures,
        "textureFiles": texture_files,
        "missingTextures": missing_textures,
        "missingModels": missing_models,
        "textureDirs": sorted({name.split("/")[3] for name in sources
                               if name and "/textures/" in name}),
        "sources": ordered_unique([name for name in sources if name]),
    }



# ---------------------------------------------------------------------------
# one item's icon, as a recipe the viewer can draw
#
# Two shapes, and the difference is the whole reason a viewer needs the pack's
# own numbers rather than a nice-looking 2:1 isometric cube:
#
#   iso   the chain really has `elements` (a block item).  The GUI icon is the
#         block drawn isometrically with `display.gui` (vanilla: rotation
#         [30,225,0], scale 0.625) and the GUI's OWN lighting -- ambient 0.4
#         plus two lights, with the model matrix's scale(16,-16,16) flipping the
#         normals, giving up 1.0 / east 0.637 / north 0.435.  Those are not the
#         world's face shades (1.0/0.8/0.6), and `vanilla3d/tools/render_item_model.py`
#         is where they were measured.
#   flat  no elements, `layer0..N` textures: the icon is those sprites stacked,
#         lit from the front (`gui_light: front`), so NO directional shading.
#
# `overrides` is where a vanilla item animates in the inventory: `item/clock` is
# 64 of them, and `item/bow` has three for the pull.  They are resolved to their
# own layer lists so the viewer can play them.
# ---------------------------------------------------------------------------

MAX_ICON_FRAMES = 64


def flat_layer_refs(repository, namespace, model_ref):
    """`layer0..N` of a flat model, in order; None if it is not flat."""
    chain = collections.OrderedDict()
    sources = []
    missing = []
    merged = walk_model(repository, namespace, model_ref, chain, sources, missing)
    if not chain:
        return None
    for model in chain.values():
        if isinstance(model.get("elements"), list) and model["elements"]:
            return None                      # a 3D model: its frames are not flat
    layers = []
    for index in range(8):
        key = "layer%d" % index
        if key in merged:
            layers.append(dereference(merged, merged[key]))
    return layers or None


def item_recipe(repository, namespace, item, tables, detail, index_root, facts=None):
    """One item's icon recipe, from an already-open repository.

    Split out of `extract_item` so a whole PAGE of icons is one process: opening
    every jar and indexing its names is the fixed cost, and a single item spends
    almost all of its ~0.3 s there.  Forty separate processes for forty slots
    would make the picker unusable.
    """
    if facts is None:
        facts = item_facts(repository, namespace, item)
    if facts is None:
        return {"error": "参考目录里没有这个物品：%s:%s" % (namespace, item),
                "version": detail.get("version"), "shape": detail.get("shape")}
    result = extract_with(repository, index_root, namespace, item, tables, detail,
                          animate=True, item=True)
    name, key, where = lookup_name(tables, namespace, item, None)
    result["name"] = name if name else item
    result["nameKey"] = key
    result["nameFrom"] = where
    result["kind"] = "item"
    result["item"] = item
    # Same key search blocks use: it already knows the `item.*` spellings AND
    # that a block item's name is a `block.` key.
    for name_key in ("form", "family", "shape", "light", "guiLightFromData", "display",
                     "layers", "elements", "overrides"):
        result[name_key] = facts[name_key]
    result["named"] = key is not None
    result["formLabel"] = ITEM_FORMS.get(facts["form"], facts["form"])
    result["drawable"] = facts["shape"] != "none"

    frames = []
    if facts["shape"] == "flat" and facts["overrides"]:
        for entry in facts["overrides"][:MAX_ICON_FRAMES]:
            model_ref = entry.get("model") if isinstance(entry, dict) else None
            if not isinstance(model_ref, str) or model_ref == "":
                continue
            layers = flat_layer_refs(repository, namespace, model_ref)
            if layers is None:
                continue
            frames.append({"model": model_ref,
                           "predicate": entry.get("predicate") if isinstance(entry.get("predicate"), dict) else {},
                           "layers": layers})
    result["frames"] = frames
    result["framesTruncated"] = len(facts["overrides"]) > MAX_ICON_FRAMES

    if facts["shape"] == "flat":
        # A flat item has no elements, so `extract_with` collected no textures at
        # all -- its icon is its layers, and they have to be fetched here.  This
        # is also where a mod's `.mcmeta` item animation arrives.
        refs = list(facts["layers"])
        for frame in frames:
            refs.extend(frame["layers"])
        (textures, texture_files, animated, animations,
         missing_textures, texture_sources) = collect_texture_payload(
            repository, namespace, refs, {}, True)
        result["textures"] = textures
        result["textureFiles"] = texture_files
        result["animations"] = animations
        result["animatedTextures"] = animated
        result["missingTextures"] = missing_textures
        result["sources"] = ordered_unique([name for name in texture_sources if name])
        # "no elements anywhere" is the NORMAL state of a generated item, not a
        # complaint: the icon is drawable, just not in 3D.
        result["error"] = None
        result["noGeometry"] = False
    elif facts["shape"] == "none":
        marker = item_model_marker(repository, namespace, item)
        result["error"] = ("这个物品没有可画的图标：模型链里既没有 elements 也没有 layer 贴图"
                           + ("（它的 item 模型写着 parent: builtin/entity，原版用代码画它，"
                              "包里没有图标数据）" if marker else ""))
    return result


def extract_item(root, namespace, item, version=None):
    roots = root if isinstance(root, (list, tuple)) else [root]
    providers, detail = build_providers_multi(roots, version)
    if providers is None:
        return {"error": detail["error"]}
    repository = Repository(providers)
    index_root = detail.get("indexRoot") or roots[0]
    tables = lang_tables_for(repository, index_root, namespace)
    return item_recipe(repository, namespace, item, tables, detail, index_root)


def extract_items(root, namespace, items, version=None):
    """Several items' icon recipes in ONE process (a page of the picker)."""
    roots = root if isinstance(root, (list, tuple)) else [root]
    providers, detail = build_providers_multi(roots, version)
    if providers is None:
        return {"error": detail["error"]}
    repository = Repository(providers)
    index_root = detail.get("indexRoot") or roots[0]
    tables = lang_tables_for(repository, index_root, namespace)
    out = collections.OrderedDict()
    for item in items:
        if not item or item in out:
            continue
        out[item] = item_recipe(repository, namespace, item, tables, detail, index_root)
    return {"namespace": namespace, "version": detail.get("version"),
            "shape": detail.get("shape"), "kind": "items", "items": out}


def icon_of(extracted):
    """The one texture a player would recognise: the first face of the first
    element, same rule the viewer's existing icon path uses."""
    elements = elements_of(extracted.get("models") or {})
    if not elements:
        return None
    first = elements[0]
    faces = first.get("faces") if isinstance(first, dict) else None
    if not isinstance(faces, dict):
        return None
    merged = {}
    for model in (extracted.get("models") or {}).values():
        table = model.get("textures")
        if isinstance(table, dict):
            for key, value in table.items():
                merged[key] = value
    referenced = []
    for face in faces.values():
        if isinstance(face, dict) and "texture" in face:
            referenced.append(face["texture"])
    for name in referenced:
        resolved = dereference(merged, name)
        if resolved and resolved in (extracted.get("textures") or {}):
            return resolved
    return None


def icons(root, namespace, blocks, version=None):
    """Several blocks in ONE process.

    The hotbar wants ~72 icons at a time, and one process per block cost about
    0.4 s each -- half a minute of nothing.  Reading N blocks from an
    already-open archive is milliseconds, so the batch is the point.
    """
    roots = root if isinstance(root, (list, tuple)) else [root]
    providers, detail = build_providers_multi(roots, version)
    if providers is None:
        return {"error": detail["error"]}
    repository = Repository(providers)
    reference_root = detail.get("indexRoot") or roots[0]
    tables = lang_tables_for(repository, reference_root, namespace)
    out = {}
    failed = []
    for block in blocks:
        extracted = extract_with(repository, reference_root, namespace, block, tables, detail)
        if extracted.get("error"):
            failed.append(block)
            continue
        chosen = icon_of(extracted)
        if chosen is None:
            failed.append(block)
            continue
        out[block] = {"name": extracted["name"], "texture": chosen,
                      "png": extracted["textures"][chosen]}
    return {"namespace": namespace, "version": detail.get("version"),
            "icons": out, "failed": failed}


def probe(root, version=None):
    roots = root if isinstance(root, (list, tuple)) else [root]
    providers, detail = build_providers_multi(roots, version)
    if providers is None:
        return {"error": detail["error"]}
    repository = Repository(providers)
    return {
        "root": os.path.abspath(roots[0]),
        "shape": detail.get("shape"),
        "version": detail.get("version"),
        "versionWhy": detail.get("versionWhy"),
        "providers": [provider.describe() for provider in providers],
        "namespaces": sorted(namespaces_of(repository)),
    }


def namespaces_of(repository):
    """Every `assets/<ns>/` any provider carries, across all of them -- a mod's
    textures can live in a different jar than its models."""
    out = set()
    for provider in repository.providers:
        for name in repository.names(provider):
            parts = name.split("/")
            if len(parts) > 3 and parts[0] == "assets":
                out.add(parts[1])
    return out


def ordered_unique(values):
    out = []
    seen = set()
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


def main(argv):
    # `--root` may repeat.  The FIRST root is the one that wins a lookup and the
    # one whose shape/version is reported; any others are searched after it, which
    # is how a project pack resolves the vanilla parents it inherits.
    args = {"roots": [], "namespace": None, "block": None, "version": None,
            "list": False, "probe": False, "icons": None, "namespaces": False,
            "variant": None, "kind": "block", "codeBlocks": False, "limit": None,
            "item": None, "items": None}
    index = 0
    while index < len(argv):
        token = argv[index]
        if token == "--root" and index + 1 < len(argv):
            args["roots"].append(argv[index + 1])
            index += 2
        elif token == "--namespace" and index + 1 < len(argv):
            args["namespace"] = argv[index + 1]
            index += 2
        elif token == "--block" and index + 1 < len(argv):
            args["block"] = argv[index + 1]
            index += 2
        elif token == "--version" and index + 1 < len(argv):
            args["version"] = argv[index + 1]
            index += 2
        elif token == "--icons" and index + 1 < len(argv):
            args["icons"] = argv[index + 1]
            index += 2
        elif token == "--variant" and index + 1 < len(argv):
            args["variant"] = argv[index + 1]
            index += 2
        elif token == "--namespaces":
            args["namespaces"] = True
            index += 1
        elif token == "--list":
            args["list"] = True
            index += 1
        elif token == "--items" and index + 1 < len(argv):
            args["items"] = [name for name in argv[index + 1].split(",") if name]
            index += 2
        elif token == "--item" and index + 1 < len(argv):
            args["item"] = argv[index + 1]
            index += 2
        elif token == "--model" and index + 1 < len(argv):
            args["models"] = [name for name in argv[index + 1].split(",") if name]
            index += 2
        elif token == "--kind" and index + 1 < len(argv):
            args["kind"] = argv[index + 1]
            index += 2
        elif token == "--code-blocks":
            args["codeBlocks"] = True
            index += 1
        elif token == "--limit" and index + 1 < len(argv):
            try:
                args["limit"] = int(argv[index + 1])
            except ValueError:
                return {"error": "--limit 需要一个整数"}
            index += 2
        elif token == "--probe":
            args["probe"] = True
            index += 1
        else:
            return {"error": "认不出的参数：" + token}

    roots = args["roots"]
    if not roots:
        return {"error": "用法：--root <path> [--root <path> ...] [--probe | --list --namespace <ns> | --block <ns>:<id>]"}
    root = roots[0] if len(roots) == 1 else roots

    if args["namespaces"]:
        return namespaces(root, args["version"])

    if args["models"]:
        # 只取模型链本身，不取方块：面板遇到"项目自己的模型继承了原版母模型，而内置表里
        # 没有它"时，用这一条去 jar 里把整条链现取回来（`block/template_wall_side`
        # → `block/block`），这样面板不必维护一张手抄的原版模型表，换版本也不会过期。
        providers, detail = build_providers_multi(args["roots"], args["version"])
        if providers is None:
            return {"error": detail["error"]}
        repository = Repository(providers)
        out_models = {}
        sources = []
        missing = []
        for reference in args["models"]:
            walk_model(repository, "minecraft", reference, out_models, sources, missing)
        if not out_models:
            return {"error": "一个模型都没取到：" + ",".join(args["models"]),
                    "missing": missing[:8], "root": root}
        return {"models": out_models, "missing": missing[:8], "roots": args["roots"],
                "requested": args["models"], "version": detail.get("version"),
                "shape": detail.get("shape")}

    if args["items"]:
        if not args["namespace"]:
            return {"error": "--items 需要 --namespace"}
        # EVERY root, not just the first.  A project pack ships its own
        # `models/item/*` but not the vanilla parents they inherit
        # (`block/cube_column`, `item/generated`), so with one root the whole
        # chain came back "missing" and every project block item read as
        # `shape: none` -- an item with no icon, which is exactly what "看不到
        # 我们自己做出来的资源的物品形式" looked like.  `--list` already took the
        # full list; `--item`/`--items` were the two that dropped it.
        return extract_items(args["roots"], args["namespace"], args["items"], args["version"])

    if args["item"] is not None:
        if ":" not in args["item"]:
            return {"error": "--item 需要 <命名空间>:<物品名>"}
        namespace, name = args["item"].split(":", 1)
        return extract_item(args["roots"], namespace, name, args["version"])

    if args["codeBlocks"]:
        if not args["namespace"]:
            return {"error": "--code-blocks 需要 --namespace"}
        listed = args["roots"]
        providers, detail = build_providers_multi(listed, args["version"])
        if providers is None:
            return {"error": detail["error"]}
        repository = Repository(providers)
        return {"namespace": args["namespace"], "version": detail.get("version"),
                "shape": detail.get("shape"), "kind": "code-blocks",
                "blocks": code_drawn_blocks(repository, args["namespace"], limit=args["limit"])}

    if args["probe"]:
        return probe(root, args["version"])

    if args["icons"] is not None:
        if not args["namespace"]:
            return {"error": "--icons 需要 --namespace"}
        blocks = [b for b in args["icons"].split(",") if b]
        return icons(root, args["namespace"], blocks, args["version"])

    if args["list"]:
        if not args["namespace"]:
            return {"error": "--list 需要 --namespace"}
        listed = args["roots"]
        providers, detail = build_providers_multi(listed, args["version"])
        if providers is None:
            return {"error": detail["error"]}
        repository = Repository(providers)
        index_root = detail.get("indexRoot") or listed[0]
        if args["kind"] == "item":
            return {"namespace": args["namespace"], "version": detail.get("version"),
                    "shape": detail.get("shape"), "kind": "item",
                    "items": list_items(repository, args["namespace"],
                                        lang_tables_for(repository, index_root, args["namespace"]))}
        if args["kind"] == "entity":
            return {"namespace": args["namespace"], "version": detail.get("version"),
                    "shape": detail.get("shape"), "kind": "entity",
                    "entities": list_entities(repository, args["namespace"])}
        if args["kind"] != "block":
            return {"error": "认不出的 --kind：" + args["kind"]}
        blocks = list_namespace(repository, args["namespace"])
        tables = lang_tables_for(repository, detail.get("indexRoot") or listed[0], args["namespace"])
        summaries = {item["id"]: item for item in block_summaries(repository, args["namespace"])}
        named = []
        for block in blocks:
            name, key, where = lookup_name(tables, args["namespace"], block, None)
            extra = summaries.get(block, {})
            named.append({"id": block, "name": name or block, "nameKey": key, "nameFrom": where,
                          "model": extra.get("model"), "group": extra.get("group", ""),
                          "groupLabel": extra.get("groupLabel", ""),
                          "family": extra.get("family", family_of(block))})
        return {"namespace": args["namespace"], "shape": detail.get("shape"),
                "version": detail.get("version"), "versionWhy": detail.get("versionWhy"),
                "blocks": named}

    if not args["block"]:
        return {"error": "要么 --probe，要么 --list --namespace <ns>，要么 --block <ns>:<id>"}
    namespace, block = split_ref(args["block"], "minecraft")
    return extract(root, namespace, block, args["version"], args["variant"])


if __name__ == "__main__":
    _pin_utf8_stdio()
print(json.dumps(main(sys.argv[1:]), ensure_ascii=False))
