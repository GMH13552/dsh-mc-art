#!/usr/bin/env python3
"""Compare what was actually EMITTED against the files in tools/mcart-plugin/.

Reading the local build and calling that "verified" is how pkg-31 and pkg-32 got
shipped broken: the local file was fine, the emitted copy had a typo.  The only
proof that the running package matches the repository is to pull the arguments
back out of the session transcript and diff them.

  python3 tools/verify_emitted.py [session-dir-or-jsonl]

With no argument, the newest session under the workspace that contains a
`cordis_define` call is used.

WHICH CALL GETS COMPARED.  Taking the LAST one is wrong in both directions: a
session normally ends with a throwaway probe (几百字节、名字里带"探针"），
and comparing the repository against a probe reports drift that does not exist
-- a gate that cries wolf is a gate people learn to ignore.  So each call is
tagged, and for each half the most recent call that is NOT a probe is compared.
Probes are skipped and COUNTED in the output, so a skip is never silent.

A call whose name/purpose does not say 探针/probe is ALWAYS treated as a real
emission and must match the repository byte for byte -- that is what keeps this
gate able to fail.  If every call for a half is a probe, that half FAILS with
"没有可比的发射" instead of passing by default.
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
    return [call["code"] for call in defines_in(path)]


# 名字/用途里带这些词的一次性验证，不进比对（但仍然会被数出来）。
PROBE_WORDS = ("探针", "probe")


def is_probe(call):
    text = (call.get("name") or "") + " " + (call.get("purpose") or "")
    lowered = text.lower()
    return any(word.lower() in lowered for word in PROBE_WORDS)


def defines_in(path):
    """Every cordis_define call in one transcript, in order, with its metadata.

    The tool arguments live in `data.arguments` as a JSON **string**; the code
    blocks are inside it.  `walk` is kept as the fallback for transcripts shaped
    differently (an older format stored the arguments as a nested object).
    """
    if path.endswith(".zstd"):
        raw = subprocess.run(["zstd", "-dc", path], capture_output=True).stdout
    else:
        with open(path, "rb") as handle:
            raw = handle.read()
    primary = []
    fallback = []
    for line in raw.split(b"\n"):
        line = line.strip()
        if not line or b"cordis_define" not in line:
            continue
        try:
            payload = json.loads(line.decode("utf-8", "replace"))
        except ValueError:
            continue
        data = payload.get("data") if isinstance(payload, dict) else None
        if isinstance(data, dict) and data.get("name") == "cordis_define":
            try:
                args = json.loads(data.get("arguments") or "{}")
            except ValueError:
                args = {}
            code = args.get("code")
            if isinstance(code, dict) and ("host" in code or "client" in code):
                primary.append({"name": args.get("name"), "purpose": args.get("purpose"),
                                "turn": data.get("turn"), "code": code})
                continue
        # Fallback: a transcript whose code blocks are not behind `arguments`.
        blocks = []
        walk(payload, blocks)
        for code in blocks:
            fallback.append({"name": None, "purpose": None, "turn": None, "code": code})
    # 同一份代码在记录里出现多次（`tool/call` 一行，被渲染进 assistant/message 的
    # 副本若干），而且**副本和原文并不逐字节相同**（JSON 里的 \n 转义 vs 正文里的真
    # 换行），所以按内容去重分不开它们。只要有过一次带名字的 `tool/call`，就用它：
    # 副本既没有名字、也认不出是不是探针，混进来会让"最近一次"落到副本上。
    return primary if primary else fallback


def sessions_newest_first():
    """Every session transcript, newest first."""
    found = []
    for path in glob.glob(os.path.join(SESSIONS, "*", "session.v3.jsonl.zstd")):
        try:
            found.append((os.path.getmtime(path), path))
        except OSError:
            continue
    return [path for _, path in sorted(found, reverse=True)]


def newest_session():
    return (sessions_newest_first() or [None])[0]


def newest_emitting_session():
    """The newest session in which something was emitted that is worth comparing.

    Scanning only the newest session makes the gate red for the wrong reason: a
    session that ends with a throwaway probe has nothing to compare, and the
    reader learns to skip the red.  Drift is a property of the LAST real
    emission, so find it wherever it is.
    """
    for path in sessions_newest_first():
        try:
            calls = defines_in(path)
        except Exception:      # a corrupt/partial transcript is not this gate's business
            continue
        if any(not is_probe(call) for call in calls):
            return path
    return newest_session()


def main(argv):
    # --fault：把两份期望值各改一个字节，要求"报告不一致"**并且**退出码非 0。
    # 这条模式存在的理由很具体：这个门禁曾经打印 FAIL 却 return None，退出码恒为 0，
    # 用 `&&` 串起来跑的时候它永远"通过"。（exit3 = 没有可比的前提，是响亮的跳过。）
    fault = "--fault" in argv
    rest = [item for item in argv[1:] if item != "--fault"]
    path = rest[0] if rest else newest_emitting_session()
    if path is None:
        return "找不到会话记录：%s" % SESSIONS
    if os.path.isdir(path):
        path = os.path.join(path, "session.v3.jsonl.zstd")
    calls = defines_in(path)
    if not calls:
        return "这份会话记录里没有 cordis_define：%s" % path
    print("会话：%s" % path)
    probes = [call for call in calls if is_probe(call)]
    print("里面共有 %d 次 cordis_define，其中 %d 次是探针（不算比对）。"
          % (len(calls), len(probes)))
    if probes:
        print("  跳过的探针：%s" % "、".join(
            "第 %s 次「%s」" % (str(index + 1), (call.get("name") or "无名")[:28])
            for index, call in enumerate(calls) if is_probe(call)))
    failures = 0
    for name in ("host", "client"):
        # 最近一次**不是探针**、而且带这一半的发射；没有就是"没有可比的发射"。
        chosen = next((call for call in reversed(calls) if name in call["code"] and not is_probe(call)), None)
        if chosen is None:
            print("  FAIL %-7s 这份会话里没有可比的发射（带 %s 的每一次都是探针）" % (name, name))
            failures += 1
            continue
        index = calls.index(chosen)
        print("  比第 %d 次（共 %d 次）：「%s」" % (index + 1, len(calls), (chosen.get("name") or "无名")[:40]))
        emitted = chosen["code"].get(name)
        target = os.path.join(MIRROR, name + ".js")
        with open(target, "r", encoding="utf-8") as handle:
            annotated = handle.read()
        # A Package carries both halves as literal strings in ONE call, so what
        # ships is the file with its comments removed (see strip_comments.py).
        # The comparison is still exact -- the artifact is pinned to a
        # deterministic function of the repository source, and every gate runs
        # against the STRIPPED copy before the emit, which is the only version
        # that can actually reach the runtime.
        want = strip(annotated).rstrip("\n")
        if fault:
            want = want + "x"      # 只差一个字符，也必须是红的
        # OR the loader: a package may instead emit `loader.<half>.js`, which
        # reads the same file at activation.  Two possible artifacts, both pinned
        # to a file in this directory -- what is NOT allowed is a package that
        # matches neither, which is what re-typing 200 KB used to produce.
        loader_path = os.path.join(MIRROR, "loader." + name + ".js")
        want_loader = None
        if os.path.exists(loader_path):
            with open(loader_path, "r", encoding="utf-8") as handle:
                want_loader = strip(handle.read()).rstrip("\n")
            if fault:
                want_loader = want_loader + "x"
        emitted = emitted.rstrip("\n") if isinstance(emitted, str) else emitted
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
        if want_loader is not None and abs(len(emitted) - len(want_loader)) < 4096:
            # 长度在同一个量级 = 差的是这一份加载器本身（不是整包）。怎么修要写清楚，
            # 不然门禁红了也没人知道下一步做什么。
            print("       修法：在**能批准客户端半边**的会话里重发一次 cordis_define，"
                  "code.%s 用 tools/mcart-plugin/loader.%s.js 的去注释版"
                  "（python3 -c \"import sys;sys.path.insert(0,'tools');"
                  "from strip_comments import strip;print(strip(open('…').read()))\"）。"
                  "或者删掉这两个加载器文件（那就没有动态插件这条路了，本门禁也一并删）。" % (name, name))
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
    # **不能无条件 return None。** 原来就是这样：下面 `if message: sys.exit(1)`
    # 拿不到任何东西，于是"打印了 FAIL、退出码还是 0"——一个用 `&&` 串起来跑的门禁
    # 会把它当成通过。门禁红不红只看退出码，所以退出码必须跟着结论走。
    return None if failures == 0 else "%d 处不一致（退出码 1）" % failures


if __name__ == "__main__":
    message = main(sys.argv)
    if message:
        print(message)
        sys.exit(1)
