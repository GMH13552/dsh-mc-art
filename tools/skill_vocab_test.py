#!/usr/bin/env python3
"""门禁：两个 skill 的**散文里只准出现公共词汇与占位符**。

WHY IT IS A WHITELIST, NOT A BLOCKLIST.  A blocklist can only catch leaks somebody already
noticed.  The ones that actually shipped — `blood_sheep`, `crystal_bow_pulling_1`, `aoa3`,
`example_soil` — were none of them on the list at the time; a new project invents new nouns.
Inverting it means **a new noun fails by default**, and adding an allowlist entry is a
deliberate act ("this is vanilla / an API / a format token" — the review the leak needs).

WHY IT MATTERS BEYOND PRIVACY.  Examples are **training signal**: whatever the doc shows, the
model steers toward.  A skill that teaches with `crystal_bow` invites crystal bows, and one
that teaches with the author's measured palette invites that palette.  So every example here
must be either domain-standard vocabulary or an obvious placeholder
(`examplemod` / `example_*` / `ModelExample*` / `<…>`), and the placeholders carry no
author's naming at all.

WHAT IS SCANNED.  Prose: every `.md` file of both skills (code fences included — that is
exactly where example ids live), plus `.py` comments and docstrings (the engine's code
identifiers are the program itself and are not examples; its *comments* are prose).

   python tools/skill_vocab_test.py          # audit both skills
   python tools/skill_vocab_test.py --fault  # plant a foreign noun; the gate MUST catch it
"""
from __future__ import annotations

import argparse
import ast
import io
import json
import os
import re
import subprocess
import sys
import tokenize
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
# Windows：stdout 默认按控制台代码页（本机 cp936）编码，中文输出在 pwsh / CI 里会变成乱码。
# 门禁的输出是给人看的，统一钉成 UTF-8（Linux/macOS 上本来就一致，无副作用）。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError, OSError):
        pass
ALLOW_FILE = HERE / "skill_vocab_allow.txt"
SKILLS = [REPO / "skills" / "mc-mod",
          Path(os.environ.get("MC_ART_SKILL_DIR") or (Path.home() / ".dsh" / "skills" / "mc-art"))]

SNAKE = re.compile(r"(?<![A-Za-z0-9_])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![A-Za-z0-9_])")
PASCAL = re.compile(r"(?<![A-Za-z0-9_])[A-Z][a-z]+(?:[A-Z][a-z0-9]*)+\b")
# 命名空间**位置**上的短 id —— 只有出现在这些位置的才可能是"别人的模组名/项目名"：
#   assets/<ns>/…、`"namespace": "<ns>"`、`<ns>:<path>`（限定 id 的前缀）。
# 不按"被引起来的单个小写词"来判：那会把 `"block"`、`"id"`、`"path"` 这些 JSON 键全抓进来。
NAMESPACE_POSITIONS = [
    re.compile(r"assets/([a-z][a-z0-9_]{1,31})/"),
    re.compile(r'"namespace"\s*:\s*"([a-z][a-z0-9_]{1,31})"'),
    re.compile(r"(?<![A-Za-z0-9_:/])([a-z][a-z0-9_]{1,31}):[a-z][a-z0-9_/]*"),
]

# 占位符约定：带了这些前缀/括号的一律放行（它们不携带任何作者命名）。
def is_placeholder(token: str) -> bool:
    return ("Example" in token or "example" in token
            or token.startswith(("my_", "My"))
            or "<" in token or ">" in token
            or token in {"minecraft", "examplemod"})


def allowed() -> dict[str, str]:
    out: dict[str, str] = {}
    for line in ALLOW_FILE.read_text(encoding="utf-8").splitlines():
        body = line.split("#", 1)[0].strip()
        if body == "":
            continue
        for token in body.split():
            out[token] = line.split("#", 1)[1].strip() if "#" in line else ""
    return out


def prose_of(path: Path) -> str:
    if path.suffix == ".md":
        return path.read_text(encoding="utf-8", errors="replace")
    text = path.read_text(encoding="utf-8", errors="replace")
    parts: list[str] = []
    try:
        tree = ast.parse(text)
        for node in ast.walk(tree):
            if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                doc = ast.get_docstring(node)
                if doc:
                    parts.append(doc)
    except SyntaxError:
        pass
    try:
        for token in tokenize.generate_tokens(io.StringIO(text).readline):
            if token.type == tokenize.COMMENT:
                parts.append(token.string)
    except (tokenize.TokenError, IndentationError):
        pass
    return "\n".join(parts)


def tokens_of(text: str) -> dict[str, set[str]]:
    found: dict[str, set[str]] = {}
    for pattern in (SNAKE, PASCAL):
        for match in pattern.findall(text):
            found.setdefault(match, set()).add("identifier")
    for pattern in NAMESPACE_POSITIONS:
        for match in pattern.findall(text):
            found.setdefault(match, set()).add("namespace")
    return found


JUNK_DIRS = {".git", "__pycache__", ".cache", ".pytest_cache", ".mypy_cache", ".ruff_cache",
             ".venv", "node_modules", ".DS_Store", ".ipynb_checkpoints"}
JUNK_SUFFIX = (".pyc", ".pyo", ".egg-info", ".log", ".swp")


def publishes(path: Path) -> bool:
    """这个文件会不会**随包发出去**？判据必须和 `panel/build.mjs` 的 isSkipped/isJunk 同一份。

    为什么要共用：门禁如果对"根本不出门的文件"报红，就会用一堆改不改都无所谓的噪声
    掩盖真正的泄漏；反过来，如果它悄悄把某个真会发出去的文件跳掉，那才是灾难。
    `tests/` 不随包发（`panel/build.mjs:isSkipped`），所以这里也不看它 ——
    但 `--fault` 会用 node 真调一次那两个函数，对同一组路径逐条比对，防止两边漂移。
    """
    parts = path.parts
    if "tests" in parts:
        return False
    if any(part in JUNK_DIRS for part in parts):
        return False
    return not str(path).endswith(JUNK_SUFFIX)


def scan(roots: list[Path], allow: dict[str, str]) -> dict[str, set[str]]:
    offenders: dict[str, set[str]] = {}
    for root in roots:
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*")):
            if not path.is_file() or path.suffix not in (".md", ".py"):
                continue
            if not publishes(path):
                continue
            text = prose_of(path)
            for token in tokens_of(text):
                if is_placeholder(token) or token in allow:
                    continue
                offenders.setdefault(token, set()).add(str(path))
    return offenders


PREDICATE_SAMPLES = [
    "skills/mc-mod/SKILL.md",
    "skills/mc-mod/references/windows.md",
    "mc_art/style.py",
    "skills/mc-mod/tests/test_leak.py",
    "mc-art/tests/test_shape_lock.py",
    "mc_art/__pycache__/style.cpython-312.pyc",
    "mc_art/.cache/whatever.py",
    "mc_art/node_modules/pkg/index.js",
    "mc_art/notes.log",
    "mc_art/style.pyc",
]


def build_predicate(samples: list[str]) -> tuple[list[bool] | None, str]:
    """跑 `panel/build.mjs` 的 isSkipped/isJunk，拿到"这些路径会不会发出去"的 JS 答案。"""
    script = ("import(process.env.MCART_BUILD_URL).then((m)=>{"
              "const paths=JSON.parse(process.env.MCART_PATHS);"
              "process.stdout.write(JSON.stringify(paths.map((p)=>!(m.isSkipped(p)||m.isJunk(p)))))"
              "}).catch((e)=>{console.error(String((e&&e.message)||e));process.exit(1)})")
    build = (REPO / "panel" / "build.mjs").resolve()
    env = dict(os.environ, MCART_BUILD_URL=build.as_uri(), MCART_PATHS=json.dumps(samples))
    try:
        done = subprocess.run(["node", "--input-type=module", "-e", script],
                              capture_output=True, text=True, env=env, timeout=120)
    except FileNotFoundError:
        return None, "没有 node"
    if done.returncode != 0:
        return None, (done.stderr or "").strip()[:200]
    return json.loads(done.stdout), ""


def fault() -> int:
    """A/B：门禁必须能红，而且**只对会发出去的文件**红。"""
    failures = 0
    allow = allowed()

    def check(label: str, ok: bool, detail: str = "") -> None:
        nonlocal failures
        if not ok:
            failures += 1
        print("  " + ("OK  " if ok else "FAIL") + " " + label +
              ("" if ok or detail == "" else "  -> " + detail))

    publishable = SKILLS[0] / "references" / ".vocab-fault.md"
    skipped_dir = SKILLS[0] / "tests"
    skipped = skipped_dir / ".vocab-fault.md"
    publishable.write_text("这个方块叫 bloodstone_lantern，实体叫 BloodLanternBeast。\n", encoding="utf-8")
    skipped_dir.mkdir(parents=True, exist_ok=True)
    skipped.write_text("这个方块叫 skiptest_lantern，实体叫 SkippedBeast。\n", encoding="utf-8")
    try:
        offenders = scan(SKILLS, allow)
    finally:
        publishable.unlink(missing_ok=True)
        skipped.unlink(missing_ok=True)
        try:
            skipped_dir.rmdir()
        except OSError:
            pass

    caught = "bloodstone_lantern" in offenders and "BloodLanternBeast" in offenders
    check("会随包发出去的文件里种一个外来名词 → 抓到（门禁能红）", caught,
          "" if caught else "只抓到：" + ", ".join(sorted(offenders)[:8]))
    ignored = "skiptest_lantern" not in offenders and "SkippedBeast" not in offenders
    check("tests/ 里的记号不算泄漏（它不随包发，报了只会掩盖真问题）", ignored,
          "居然报成了泄漏：" + ", ".join(sorted(set(offenders) & {"skiptest_lantern", "SkippedBeast"})))

    # 跨语言判据一致：Python 这边的 publishes() 与 build.mjs 的 isSkipped/isJunk 必须一致。
    js, why = build_predicate(PREDICATE_SAMPLES)
    if js is None:
        check("与 panel/build.mjs 的'什么会发出去'判据对齐（真的各问一次）", False,
              "调不动 node/build.mjs：" + why)
    else:
        mine = [publishes(Path(sample)) for sample in PREDICATE_SAMPLES]
        agree = mine == js
        check("与 panel/build.mjs 的'什么会发出去'判据对齐（真的各问一次）", agree,
              "python=" + str(mine) + " js=" + str(js))
    print("全部通过" if failures == 0 else "%d 项失败" % failures)
    return 1 if failures else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="skills 的散文词汇白名单门禁")
    parser.add_argument("--fault", action="store_true", help="种一个外来名词，要求门禁抓到")
    args = parser.parse_args(argv)
    allow = allowed()

    if args.fault:
        return fault()

    offenders = scan(SKILLS, allow)
    total = sum(len(items) for items in offenders.values())
    if not offenders:
        print("  OK   两个 skill 的散文里只有公共词汇与 example* 占位符" +
              "（白名单 %d 条）" % len(allow))
        print("全部通过")
        return 0
    for token in sorted(offenders):
        files = sorted({Path(item).name for item in offenders[token]})
        print("  FAIL %-32s %s" % (token, ", ".join(files)))
    print("%d 个记号不在白名单里（每个 %d 个文件）—— 要么改成 example* 占位符，要么"
          "在 tools/skill_vocab_allow.txt 里写明理由" % (total, len(offenders)))
    return 1


if __name__ == "__main__":
    sys.exit(main())
