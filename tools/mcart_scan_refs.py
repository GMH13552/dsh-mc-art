#!/usr/bin/env python3
"""Enumerate the namespaces a reference root actually contains.

A "reference root" is wherever a Minecraft installation keeps its game assets.
That is NOT one shape, and it is not where the first version of this assumed:

  1.12.2 vanilla  ->  assets/minecraft/textures/**  lives INSIDE the version jar.
                      assets/indexes/1.12.json has zero entries under
                      minecraft/textures/block/ -- the hashed object store only
                      held sounds/lang back then.  So the jar must be read.
  Forge mods      ->  versions/<version>/mods/*.jar, each carrying
                      assets/<modid>/textures/**

So a root may be: the game directory (`.minecraft`), one version directory, a
`mods` directory, a single jar, or an already-extracted `assets/` root.

Usage:  mcart_scan_refs.py <path>
        mcart_scan_refs.py --detect
Output: a single JSON object on stdout.  Nothing else is written to stdout.
"""

import collections
import glob
import json
import os
import sys
import zipfile


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


# Anything that is not a player-facing asset archive.
JAR_SKIP = ("-sources", "-javadoc", "-dev", "-api", "-natives", "-slim")


def is_jar(path):
    name = os.path.basename(path).lower()
    if not name.endswith(".jar"):
        return False
    return not any(name[:-4].endswith(skip) for skip in JAR_SKIP)


def count_jar(path):
    """namespace -> png count, or None when the file cannot be read."""
    counts = collections.Counter()
    try:
        with zipfile.ZipFile(path) as archive:
            for name in archive.namelist():
                if not name.startswith("assets/") or not name.endswith(".png"):
                    continue
                if "/textures/" not in name:
                    continue
                parts = name.split("/")
                if len(parts) < 5:
                    continue
                counts[parts[1]] += 1
    except Exception:
        return None
    return counts


def count_assets_dir(base):
    """namespace -> png count for an extracted <base>/assets/<ns>/textures/."""
    assets = os.path.join(base, "assets")
    if not os.path.isdir(assets):
        return None
    counts = collections.Counter()
    try:
        entries = sorted(os.listdir(assets))
    except OSError:
        return None
    for namespace in entries:
        textures = os.path.join(assets, namespace, "textures")
        if not os.path.isdir(textures):
            continue
        for _, _, files in os.walk(textures):
            for name in files:
                if name.lower().endswith(".png"):
                    counts[namespace] += 1
    return counts


def jars_in(directory):
    try:
        return sorted(
            os.path.join(directory, name)
            for name in os.listdir(directory)
            if is_jar(os.path.join(directory, name))
        )
    except OSError:
        return []


def subdirs(directory):
    try:
        return sorted(
            os.path.join(directory, name)
            for name in os.listdir(directory)
            if os.path.isdir(os.path.join(directory, name))
        )
    except OSError:
        return []


def scan(root):
    root = os.path.abspath(root)
    sources = []
    merged = {}

    def record(counter, path, label, kind, version=None):
        if counter is None:
            sources.append({"label": label, "kind": kind, "path": path, "error": "读不出来"})
            return
        total = sum(counter.values())
        sources.append({"label": label, "kind": kind, "path": path, "textures": total,
                        "version": version})
        for namespace, count in counter.items():
            slot = merged.setdefault(namespace, {"name": namespace, "count": 0, "from": []})
            slot["count"] += count
            if label not in slot["from"]:
                slot["from"].append(label)

    if not os.path.exists(root):
        return {"error": "路径不存在：" + root}

    if os.path.isfile(root):
        if not is_jar(root):
            return {"error": "这是个文件，但不是 jar：" + root}
        record(count_jar(root), root, os.path.basename(root), "jar")
        shape = "单个 jar"
    else:
        kinds = []

        # An already-extracted root, i.e. <root>/assets/<ns>/textures/**
        extracted = count_assets_dir(root)
        if extracted:
            kinds.append("已解包资源根")
            record(extracted, root, os.path.basename(root.rstrip("/")) or root, "解包")

        # A version directory holds the vanilla jar next to its own mods/.
        # A game directory holds many version directories.  Decide which one
        # this root is BEFORE touching mods/, or a version directory counts its
        # own mods twice (once as <root>/mods, once as <root-as-version>/mods).
        version_dirs = []
        versions_dir = os.path.join(root, "versions")
        if subdirs(versions_dir):
            version_dirs = subdirs(versions_dir)
            kinds.append("游戏目录")
        elif jars_in(root):
            version_dirs = [root]
            kinds.append("版本目录")

        if version_dirs:
            for version in version_dirs:
                label = os.path.basename(version.rstrip("/")) or version
                for jar in jars_in(version):
                    record(count_jar(jar), jar, os.path.basename(jar), "原版", label)
                for jar in jars_in(os.path.join(version, "mods")):
                    record(count_jar(jar), jar, os.path.basename(jar), "模组", label)
        else:
            # A bare mods/ directory, pointed at directly.
            found = jars_in(os.path.join(root, "mods"))
            if found:
                kinds.append("模组目录")
                for jar in found:
                    record(count_jar(jar), jar, os.path.basename(jar), "模组")

        shape = " + ".join(kinds) if kinds else "没认出这是什么"

    namespaces = sorted(merged.values(), key=lambda item: (-item["count"], item["name"]))
    return {
        "root": root,
        "shape": shape,
        "sources": sources,
        "namespaces": namespaces,
        "textures": sum(item["count"] for item in namespaces),
    }


def detect():
    """Candidate game directories, most likely first.  Never guesses a path is
    valid -- each candidate is returned only because it exists on disk."""
    home = os.path.expanduser("~")
    candidates = []
    candidates += sorted(glob.glob("/mnt/c/Users/*/AppData/Roaming/.minecraft"))
    candidates += sorted(glob.glob("/mnt/c/Users/*/.minecraft"))
    candidates += sorted(glob.glob("/mnt/c/Users/*/*/.minecraft"))
    candidates += [os.path.join(home, ".minecraft"), os.path.join(home, "AppData/Roaming/.minecraft")]
    out = []
    seen = set()
    for path in candidates:
        real = os.path.realpath(path)
        if real in seen or not os.path.isdir(path):
            continue
        seen.add(real)
        out.append(path)
    return {"candidates": out}


_pin_utf8_stdio()
if __name__ == "__main__":
    arguments = sys.argv[1:]
    if not arguments:
        print(json.dumps({"error": "用法：mcart_scan_refs.py <path> | --detect"}))
    elif arguments[0] == "--detect":
        print(json.dumps(detect(), ensure_ascii=False))
    else:
        print(json.dumps(scan(arguments[0]), ensure_ascii=False))
