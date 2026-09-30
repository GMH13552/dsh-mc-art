#!/usr/bin/env python3
"""把一个"墙"补齐成 1.16+ 原版那种形状 —— 数字全部从游戏 jar 里读，不手写。

用户遇到的是这个（项目 the_nameless_mist，1.18.2）：

  blockstates/<name>.json        原版那种 multipart，指向
                                 <ns>:block/<name>_post / _side / _side_tall
  models/block/<name>.json       parent = block/wall_side      ← 1.18.2 里没有这个文件

生成的三个模型**从来没写出来过**，而 `block/wall_side` 从 1.16 起被原版改名成
`template_wall_side`。两处一起坏掉，结果就是：**游戏里这个方块整块显示不出来**
（multipart 的每一段都加载失败 = missing model），面板也只能说一句
`cannot resolve model for <name>`。

原版自己怎么写的（1.18.2 jar 里量到的）：

  blockstates/cobblestone_wall.json  multipart，5 个 low + 4 个 tall + 1 个 post，
                                     侧面那几段带 "uvlock": true 和 "y": 90/180/270
  models/block/cobblestone_wall_post.json       parent minecraft:block/template_wall_post
  models/block/cobblestone_wall_side.json       parent minecraft:block/template_wall_side
  models/block/cobblestone_wall_side_tall.json  parent minecraft:block/template_wall_side_tall
  三个都只覆盖一个贴图键："wall"

所以本脚本做的事就是：读原版那四个文件 → 把名字换成你的墙、把 wall 贴图换成你的贴图
→ 写进项目的每一棵树（pack/、src/main/resources/、build/resources/main/，只写已经存在的）。

  python3 tools/fix_wall_assets.py --project <项目目录>
  python3 tools/fix_wall_assets.py --project <项目目录> --check    # 只报，不改
  python3 tools/fix_wall_assets.py --project <项目目录> --jar <jar>

参考目录默认从 <项目>/mc-art.settings.json 的 reference.directory 读（面板里设置的那个），
Windows 路径会翻译成 WSL 的 /mnt/<盘符>/…。
"""

import argparse
import glob
import json
import os
import re
import sys
import zipfile

VANILLA_BLOCKSTATE = "assets/minecraft/blockstates/cobblestone_wall.json"
VANILLA_MODELS = {
    "post": "assets/minecraft/models/block/cobblestone_wall_post.json",
    "side": "assets/minecraft/models/block/cobblestone_wall_side.json",
    "side_tall": "assets/minecraft/models/block/cobblestone_wall_side_tall.json",
}
# 每个 :block/<名字> 引用要换成什么后缀。原版 blockstate 里的名字都叫
# cobblestone_wall_<后缀>，所以"原版名字 → 你的名字"就是一次替换。
SUFFIXES = ("post", "side", "side_tall")
# 这三个原版母模型是 1.16 之后就位的。项目里如果写了旧的 block/wall_side，
# 游戏同样加载不了 —— 所以修 blockstate 的同时也把那个文件的 parent 修好。
TEMPLATE_PARENTS = {
    "post": "minecraft:block/template_wall_post",
    "side": "minecraft:block/template_wall_side",
    "side_tall": "minecraft:block/template_wall_side_tall",
}
# 旧名字（1.13–1.15）。出现在 parent 里就是写错了。
LEGACY_PARENTS = ("block/wall_post", "block/wall_side", "block/wall_side_tall")


def wsl_path(value):
    """`C:\\Users\\x\\y` -> `/mnt/c/Users/x/y`；已经是 posix 的原样返回。"""
    text = str(value).replace("\\", "/")
    match = re.match(r"^([A-Za-z]):/(.*)$", text)
    if match is None:
        return text
    return "/mnt/" + match.group(1).lower() + "/" + match.group(2)


def reference_directory(project):
    settings = os.path.join(project, "mc-art.settings.json")
    if not os.path.exists(settings):
        return ""
    try:
        with open(settings, encoding="utf-8") as handle:
            parsed = json.load(handle)
    except ValueError:
        return ""
    directory = ((parsed.get("reference") or {}).get("directory")) or ""
    return wsl_path(directory) if directory else ""


def find_jar(directory):
    candidates = sorted(glob.glob(os.path.join(directory, "*.jar")))
    return candidates[0] if candidates else ""


def read_vanilla(jar):
    """原版那四个文件，字节级读出来自己解析（要替换名字，不能只抄字符串）。"""
    with zipfile.ZipFile(jar) as archive:
        files = {}
        for name in [VANILLA_BLOCKSTATE] + list(VANILLA_MODELS.values()):
            files[name] = json.loads(archive.read(name).decode("utf-8"))
    blockstate = files[VANILLA_BLOCKSTATE]
    models = {suffix: files[path] for suffix, path in VANILLA_MODELS.items()}
    # 自检：原版那三个模型确实只有 wall 一个贴图键，否则下面的替换就是猜的。
    for suffix, model in models.items():
        keys = sorted((model.get("textures") or {}).keys())
        if keys != ["wall"]:
            raise SystemExit("原版 %s 的贴图键不是只有 wall：%s（脚本要跟着改）" % (suffix, keys))
    return blockstate, models


def wall_names(project, namespace):
    """发现需要修的墙：`models/block/*_wall.json`，且缺 _post/_side/_side_tall。"""
    models_dir = os.path.join(project, "pack", "assets", namespace, "models", "block")
    if not os.path.isdir(models_dir):
        return []
    found = []
    for name in sorted(os.listdir(models_dir)):
        if not name.endswith("_wall.json"):
            continue
        base = name[: -len(".json")]
        missing = [suffix for suffix in SUFFIXES
                   if not os.path.exists(os.path.join(models_dir, base + "_" + suffix + ".json"))]
        if missing:
            found.append((base, missing))
    return found


def wall_texture(project, namespace, base):
    """这个墙用哪张贴图：`textures.texture`（面板生成的写法）或 `textures.wall`。"""
    path = os.path.join(project, "pack", "assets", namespace, "models", "block", base + ".json")
    try:
        with open(path, encoding="utf-8") as handle:
            model = json.load(handle)
    except (OSError, ValueError):
        model = {}
    textures = model.get("textures") or {}
    for key in ("wall", "texture", "all"):
        if isinstance(textures.get(key), str):
            return textures[key]
    stripped = base[: -len("_wall")] if base.endswith("_wall") else base
    return namespace + ":block/" + stripped


def rewrite_blockstate(blockstate, namespace, base, texture):
    """原版 cobblestone_wall 的名字换成你的，`minecraft:` 换成你的命名空间。

    贴图**不在这里覆盖**：段里已经有 `the_nameless_mist:block/<base>_post` 这种模型名，
    贴图写在模型文件里（原版也是这么分的）。
    """
    text = json.dumps(blockstate, indent=2, ensure_ascii=False)
    text = text.replace("minecraft:", namespace + ":")
    text = text.replace("cobblestone_wall", base)
    return json.loads(text)


def target_trees(project, namespace):
    """每个已经存在的 assets 树都要写：pack/ 是面板读的，src/ 是构建的源头。"""
    relative = os.path.join("assets", namespace)
    trees = []
    for root in ("pack", os.path.join("src", "main", "resources"),
                 os.path.join("build", "resources", "main")):
        directory = os.path.join(project, root, relative)
        if os.path.isdir(directory):
            trees.append(os.path.join(project, root))
    return trees


def write_json(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False)
        handle.write("\n")


def main():
    parser = argparse.ArgumentParser(description="把墙的 blockstate + 三个模型补齐（数字读自游戏 jar）")
    parser.add_argument("--project", required=True, help="模组项目目录（里面有 pack/ 和 mc-art.settings.json）")
    parser.add_argument("--jar", default="", help="游戏 jar；不给就从 mc-art.settings.json 的参考目录里找")
    parser.add_argument("--namespace", default="", help="资源包命名空间；不给就从 pack/assets/ 里唯一那个取")
    parser.add_argument("--check", action="store_true", help="只检查，不改任何文件")
    args = parser.parse_args()

    project = os.path.abspath(args.project)
    if not os.path.isdir(project):
        return "找不到项目目录：%s" % project
    assets = os.path.join(project, "pack", "assets")
    namespace = args.namespace
    if namespace == "":
        names = [entry for entry in os.listdir(assets)
                 if os.path.isdir(os.path.join(assets, entry))] if os.path.isdir(assets) else []
        if len(names) != 1:
            return "pack/assets/ 下有 %d 个命名空间，用 --namespace 指定一个：%s" % (len(names), "、".join(names))
        namespace = names[0]

    jar = args.jar or find_jar(reference_directory(project))
    if jar == "" or not os.path.exists(jar):
        return ("找不到游戏 jar。用 --jar 指定，或者先在面板里把参考目录设成 .minecraft/versions/<版本> "
                "（现在读到的是 %r）" % reference_directory(project))
    blockstate, models = read_vanilla(jar)
    print("游戏 jar：%s" % jar)
    print("原版形状读到了：multipart %d 段 + %d 个模板模型"
          % (len(blockstate.get("multipart") or []), len(models)))

    walls = wall_names(project, namespace)
    if not walls:
        print("没有需要修的墙（每个 *_wall.json 都有 _post/_side/_side_tall 了）")
        return None

    trees = target_trees(project, namespace)
    print("要写的树：%s" % "、".join(os.path.relpath(tree, project) for tree in trees))
    problems = []
    for base, missing in walls:
        texture = wall_texture(project, namespace, base)
        print("- %s（贴图 %s，缺 %s）" % (base, texture, "、".join(missing)))
        for suffix in SUFFIXES:
            payload = {"parent": TEMPLATE_PARENTS[suffix], "textures": {"wall": texture}}
            for tree in trees:
                path = os.path.join(tree, "assets", namespace, "models", "block",
                                    base + "_" + suffix + ".json")
                if args.check:
                    if not os.path.exists(path):
                        problems.append(os.path.relpath(path, project))
                    continue
                write_json(path, payload)
        state = rewrite_blockstate(blockstate, namespace, base, texture)
        for tree in trees:
            path = os.path.join(tree, "assets", namespace, "blockstates", base + ".json")
            if args.check:
                try:
                    with open(path, encoding="utf-8") as handle:
                        have = json.load(handle)
                except (OSError, ValueError):
                    problems.append(os.path.relpath(path, project) + "（读不出来）")
                    continue
                if (have.get("multipart") or []) != (state.get("multipart") or []):
                    problems.append(os.path.relpath(path, project) + "（还不是原版那种形状）")
                continue
            write_json(path, state)
        # 那个"每个方块一个模型"的文件：原版墙没有这个文件，而它现在的 parent
        # (block/wall_side) 在本版本根本不存在 —— 留着就是一颗雷（谁引用它谁加载失败）。
        for tree in trees:
            path = os.path.join(tree, "assets", namespace, "models", "block", base + ".json")
            if not os.path.exists(path):
                continue
            try:
                with open(path, encoding="utf-8") as handle:
                    current = json.load(handle)
            except ValueError:
                continue
            parent = str(current.get("parent") or "")
            if parent not in LEGACY_PARENTS:
                continue
            if args.check:
                problems.append(os.path.relpath(path, project) + "（parent 还是 %s）" % parent)
                continue
            current["parent"] = TEMPLATE_PARENTS["side"]
            current["textures"] = {"wall": texture}
            write_json(path, current)

    if args.check:
        if problems:
            print("%d 处还没修：" % len(problems))
            for item in problems[:20]:
                print("  " + item)
            return "墙的资源不完整（上面那些）"
        print("每面墙都是原版那种形状：三个模型 + blockstate + 没有旧 parent")
        return None
    print("写完了。游戏里重新加载资源包（F3+T）就能看到墙。")
    return None


if __name__ == "__main__":
    message = main()
    if message:
        print(message)
        sys.exit(1)
    sys.exit(0)
