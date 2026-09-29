#!/usr/bin/env python3
"""Compare what was actually EMITTED against the files in tools/mcart-plugin/.

Reading the local build and calling that "verified" is how pkg-31 and pkg-32 got
shipped broken: the local file was fine, the emitted copy had a typo.  The only
proof that the running package matches the repository is to pull the arguments
back out of the session transcript and diff them.

  python3 tools/verify_emitted.py [session-dir-or-jsonl]

With no argument, the newest session under the workspace that contains a
`cordis_define` call is used.
"""
import glob
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from strip_comments import strip  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
MIRROR = os.path.join(HERE, "mcart-plugin")
SESSIONS = os.path.expanduser("~/.dsh/sessions/--home-gmh-mc-art--")


def walk(node, out, depth=0):
    """Every dict that carries a `code` block with host/client strings.

    Tool arguments are stored as a JSON **string** nested inside the transcript
    line (`"arguments": "{\\"plugin\\":...,\\"code\\":{...}}"`), not as a nested
    object.  Walking only the decoded line therefore finds nothing at all and
    the report reads "这份会话记录里没有 cordis_define" -- which looks like "no
    emit happened" when in fact every emit is right there.  So a string that
    parses as JSON gets walked too.
    """
    if depth > 6:
        return
    if isinstance(node, dict):
        code = node.get("code")
        if isinstance(code, dict) and ("host" in code or "client" in code):
            out.append(code)
        elif isinstance(code, str) and code[:1] in ("{", "["):
            try:
                walk(json.loads(code), out, depth + 1)
            except ValueError:
                pass
        for value in node.values():
            walk(value, out, depth + 1)
    elif isinstance(node, list):
        for value in node:
            walk(value, out, depth + 1)
    elif isinstance(node, str) and node[:1] in ("{", "["):
        try:
            walk(json.loads(node), out, depth + 1)
        except ValueError:
            pass


def calls_in(path):
    """All cordis_define code blocks in one session transcript, in order."""
    if path.endswith(".zstd"):
        raw = subprocess.run(["zstd", "-dc", path], capture_output=True).stdout
    else:
        with open(path, "rb") as handle:
            raw = handle.read()
    found = []
    for line in raw.split(b"\n"):
        line = line.strip()
        if not line or b"cordis_define" not in line:
            continue
        try:
            payload = json.loads(line.decode("utf-8", "replace"))
        except ValueError:
            continue
        walk(payload, found)
    return found


def newest_session():
    best = None
    for path in glob.glob(os.path.join(SESSIONS, "*", "session.v3.jsonl.zstd")):
        try:
            stamp = os.path.getmtime(path)
        except OSError:
            continue
        if best is None or stamp > best[0]:
            best = (stamp, path)
    return None if best is None else best[1]


def main(argv):
    path = argv[1] if len(argv) > 1 else newest_session()
    if path is None:
        return "找不到会话记录：%s" % SESSIONS
    if os.path.isdir(path):
        path = os.path.join(path, "session.v3.jsonl.zstd")
    blocks = calls_in(path)
    if not blocks:
        return "这份会话记录里没有 cordis_define：%s" % path
    code = blocks[-1]
    print("会话：%s" % path)
    print("里面共有 %d 次 cordis_define，比对最后一次。" % len(blocks))
    failures = 0
    for name in ("host", "client"):
        emitted = code.get(name)
        target = os.path.join(MIRROR, name + ".js")
        with open(target, "r", encoding="utf-8") as handle:
            annotated = handle.read()
        # A Package carries both halves as literal strings in ONE call, so what
        # ships is the file with its comments removed (see strip_comments.py).
        # The comparison is still exact -- the artifact is pinned to a
        # deterministic function of the repository source, and every gate runs
        # against the STRIPPED copy before the emit, which is the only version
        # that can actually reach the runtime.
        want = strip(annotated)
        # OR the loader: a package may instead emit `loader.<half>.js`, which
        # reads the same file at activation.  Two possible artifacts, both pinned
        # to a file in this directory -- what is NOT allowed is a package that
        # matches neither, which is what re-typing 200 KB used to produce.
        loader_path = os.path.join(MIRROR, "loader." + name + ".js")
        want_loader = None
        if os.path.exists(loader_path):
            with open(loader_path, "r", encoding="utf-8") as handle:
                want_loader = strip(handle.read())
        if emitted is None:
            print("  FAIL %-7s 这次定义里没有 %s 这一半" % (name, name))
            failures += 1
            continue
        if emitted == want:
            print("  OK   %-7s 与 %s 去注释后逐字符相同（%d 字符，源文件 %d）"
                  % (name, name + ".js", len(want), len(annotated)))
            continue
        if want_loader is not None and emitted == want_loader:
            print("  OK   %-7s 与 loader.%s.js 逐字符相同（%d 字符）——这一包是加载器，"
                  "真正的源码 %s.js 在激活时从磁盘读"
                  % (name, name, len(want_loader), name))
            continue
        failures += 1
        print("  FAIL %-7s 发出去的和仓库里的不一样：发出 %d 字节，仓库 %d 字节"
              % (name, len(emitted), len(want)))
        if want_loader is not None:
            print("       （既不是 %s.js，也不是 loader.%s.js）" % (name, name))
        # Point at the first difference instead of dumping 100 KB at the reader.
        limit = min(len(emitted), len(want))
        where = next((index for index in range(limit) if emitted[index] != want[index]), limit)
        print("       第一处不同在第 %d 个字符（第 %d 行）"
              % (where, emitted[:where].count("\n") + 1))
        print("       发出：%r" % emitted[max(0, where - 60):where + 60])
        print("       仓库：%r" % want[max(0, where - 60):where + 60])
    print("逐字节一致" if failures == 0 else "%d 处不一致" % failures)
    return None


if __name__ == "__main__":
    message = main(sys.argv)
    if message:
        print(message)
        sys.exit(1)
