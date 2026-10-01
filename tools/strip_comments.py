#!/usr/bin/env python3
r"""Strip comments from a dynamic Package half before it is emitted.

WHY THIS EXISTS.  A Cordis Package carries its Host and Client halves as literal
strings in ONE tool call, and a half cannot be omitted -- `startFresh` does
`if (plugin.run !== void 0) await this.retract(plugin)` before it looks at the
new definition, so a package with only one half leaves the plugin without the
other one.  The two halves are now ~195 KB of characters, and one call is all the
output budget there is.

About 13% of that is comments, and the comments in this repository are mostly
Chinese -- which costs roughly one token per character against roughly one token
per four characters for code.  Dropping them from the TRANSPORT is the difference
between a call that fits and a call that does not.

WHAT IS NOT LOST.  The annotated source stays in `tools/mcart-plugin/` and is what
people read and edit.  What ships to the runtime is this function of it, and
`tools/verify_emitted.py` compares the emitted strings against `strip()` of those
files -- so the artifact is still pinned, just to the stripped form.

THE LOADER (the cheap way, and now the normal one).  Re-typing 200 KB per change
was the real cost here -- 94 emits in one session, and one mistyped character meant
doing the whole thing again.  So a package may instead emit `loader.host.js` /
`loader.client.js`: ~1.3 KB each, which read `host.js` / `client.js` off disk when
the package activates and run them.  `verify_emitted.py` accepts either artifact
and says which one it matched.  Two things follow, and both are load-bearing:

  * what runs is the file at ACTIVATION time, so an edit needs the package re-run
    (`cordis_run` with the SAME packageId, mode `run`) -- not a new package;
  * `new Function` compiles in GLOBAL scope, so every binding the runtime injects
    has to be handed in explicitly (`harness`/`console`/`TextEncoder`/`btoa`/
    `atob` on the host; `React`/`host`/`styles`/`console` on the client).
    `tools/mcart-plugin/loader-test.js` runs the real halves THROUGH the loader
    and injects that omission, because forgetting one fails at run time inside a
    browser page, where the only evidence is a Run card.

WHAT IS REMOVED, EXACTLY.  Only two shapes, both decided **per line by position**,
never by scanning inside code:

  * block comments whose **first non-space characters begin the line** (`/** ... */`,
    `/* ... */`, however many lines they span)
  * lines whose first non-space characters are `//`

Both are line-anchored, and that anchoring is LOAD-BEARING.  The block rule was
once `/\*[\s\S]*?\*/` -- any `/*` anywhere.  A `//` comment mentioning a glob
("keeps every mod in versions/<version>/mods/*.jar") then opened a block that ran
to the next `*/` **313 lines later**, and the emitted host silently lost ten
declarations (SCAN_SCRIPT, EXTRACT_SCRIPT, REFERENCE_MAX_BYTES, toolPaths,
findTool, findScanner, PYTHON_CANDIDATES, resolvePython, itemRoots, roots) -- the
entire reference/extraction path.  The artifact still parsed, so nothing noticed
until a user clicked 设置 and the page said `findScanner is not defined`.  Hence
narrowing the rule, rewording the two comments that tripped it, and
`tools/strip_gate.py`, which compares declared names in the source against the
emitted artifact and fails when one is missing.

Trailing `//` comments are deliberately LEFT ALONE: deciding whether a `//` is a
comment or part of a string or a regex needs a real JavaScript lexer, and this
script is not allowed to be clever about code.  Inline `/* ... */` pairs (the
`catch (error) { /* not fatal */ }` shape) are left alone too, for the same
reason: they do not begin a line, so no rule here can mistake them for code.

   python tools/strip_comments.py <file> [<file> ...]
   python tools/strip_comments.py --check <annotated> <stripped>
"""
import re
import sys

# `^[ \t]*` 是关键：只有"整行就是块注释的开头"才算注释。行内的 `/*`（无论是
# `catch (e) { /* x */ }` 这种真注释，还是 `// ... mods/*.jar` 这种假开头）
# 一律不碰 —— 宁可少剥一层，也不能吞掉代码。
BLOCK = re.compile(r"^[ \t]*/\*[\s\S]*?\*/", re.MULTILINE)
WHOLE_LINE = re.compile(r"^[ \t]*//[^\n]*\n?", re.MULTILINE)


def strip(text):
    without_blocks = BLOCK.sub("", text)
    without_lines = WHOLE_LINE.sub("", without_blocks)
    return rstrip_lines(without_lines)


def rstrip_lines(text):
    """Drop trailing whitespace from every line.

    A block comment that began on an indented line leaves its indentation
    behind as a whitespace-only line, so the transported string used to depend
    on bytes nobody can see -- which turned "was it pasted exactly?" into a
    question about invisible characters.  Trailing whitespace cannot change what
    JavaScript means, and neither half contains a template literal or any other
    multi-line string (every backtick in both files is inside a comment), so it
    is removed from the TRANSPORT and `verify_emitted.py` compares against this
    same function.  The annotated sources are not touched.
    """
    return "\n".join(line.rstrip() for line in text.split("\n"))


def main(argv):
    # Windows：Python 默认按**控制台代码页**（本机 cp936/GBK）编码 stdout，而宿主/客户端
    # 源码里有 `⚙` 这类字符 —— 直接 write 会
    # `UnicodeEncodeError: 'gbk' codec can't encode character '\u2699'`，退出码 1，
    # 调用方（panel/build.mjs）只看到一段 traceback。生成物本身是 UTF-8，
    # 所以这里把两个输出流都钉死成 UTF-8（Linux/macOS 上本来就是 UTF-8，无副作用）。
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError, OSError):
            pass
    if len(argv) >= 3 and argv[0] == "--check":
        with open(argv[1], "r", encoding="utf-8") as handle:
            annotated = handle.read()
        with open(argv[2], "r", encoding="utf-8") as handle:
            stripped = handle.read()
        if strip(annotated) == stripped:
            print("ok: %s 就是 %s 去掉注释的样子" % (argv[2], argv[1]))
            return 0
        print("不一致：%s 不等于 %s 去掉注释的结果" % (argv[2], argv[1]))
        return 1
    if not argv:
        print(__doc__)
        return 2
    for path in argv:
        with open(path, "r", encoding="utf-8") as handle:
            text = handle.read()
        sys.stdout.write(strip(text))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
