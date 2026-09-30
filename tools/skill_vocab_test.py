#!/usr/bin/env python3
"""门禁：两个 skill 的**散文里只准出现公共词汇与占位符**。

WHY IT IS A WHITELIST, NOT A BLOCKLIST.  A blocklist can only catch leaks somebody already
noticed.  The ones that actually shipped — `blood_sheep`, `crystal_bow_pulling_1`, `aoa3`,
`flesh_soil` — were none of them on the list at the time; a new project invents new nouns.
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

   python3 tools/skill_vocab_test.py          # audit both skills
   python3 tools/skill_vocab_test.py --fault  # plant a foreign noun; the gate MUST catch it
"""
from __future__ import annotations

import argparse
import ast
import io
import os
import re
import sys
import tokenize
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
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


def scan(roots: list[Path], allow: dict[str, str]) -> dict[str, set[str]]:
    offenders: dict[str, set[str]] = {}
    for root in roots:
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*")):
            if not path.is_file() or path.suffix not in (".md", ".py"):
                continue
            if any(part in {".cache", "tests", ".git", "__pycache__", ".pytest_cache"} for part in path.parts):
                continue
            text = prose_of(path)
            for token in tokens_of(text):
                if is_placeholder(token) or token in allow:
                    continue
                offenders.setdefault(token, set()).add(str(path))
    return offenders


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="skills 的散文词汇白名单门禁")
    parser.add_argument("--fault", action="store_true", help="种一个外来名词，要求门禁抓到")
    args = parser.parse_args(argv)
    allow = allowed()

    if args.fault:
        target = SKILLS[0] / "references" / ".vocab-fault.md"
        target.write_text("这个方块叫 bloodstone_lantern，实体叫 BloodLanternBeast。\n", encoding="utf-8")
        try:
            offenders = scan(SKILLS, allow)
        finally:
            target.unlink(missing_ok=True)
        caught = "bloodstone_lantern" in offenders and "BloodLanternBeast" in offenders
        print("  " + ("OK  " if caught else "FAIL") + " 故障注入的外来名词被抓到（门禁能红）"
              + ("" if caught else "  -> 只抓到：" + ", ".join(sorted(offenders)[:8])))
        print("全部通过" if caught else "1 项失败")
        return 0 if caught else 1

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
