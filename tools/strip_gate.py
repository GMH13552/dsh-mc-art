#!/usr/bin/env python3
"""注释剥离器不许吞代码：**源码里声明的名字，生成物里必须一个不少。**

WHY THIS EXISTS.  `tools/strip_comments.py` 的块注释规则原来是"任意位置的
`/\\* … *\\/`"。宿主源码里有一句行注释提到了 glob：

    // Forge keeps every mod in versions/<version>/mods/*.jar. …

那个 `/*` 被当成块注释的开头，一路吃到 313 行之后的 `*/`。于是**发出去的宿主**少了
十个声明（SCAN_SCRIPT、EXTRACT_SCRIPT、REFERENCE_MAX_BYTES、toolPaths、findTool、
findScanner、PYTHON_CANDIDATES、resolvePython、itemRoots、roots）——整条参考/提取通道。
生成物照样能解析、`verify-build` 照样绿（它比对的是"再剥一次"的结果，自证不了），
直到用户点开 ⚙ 设置，页面回一句 `findScanner is not defined`。

所以这条门禁只看一件事：**声明的名字有没有少**。它比对
`tools/mcart-plugin/<half>.js` 与 `panel/lib/<half>.js` 里内嵌的那份字符串。

   python tools/strip_gate.py          # 两半都查
   python tools/strip_gate.py --fault  # 证明这条检查能红：同一份夹具，老规则会吞、新规则不会
"""
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import strip_comments  # noqa: E402  (同一目录，脚本式导入)

# Windows：stdout 默认按控制台代码页（本机 cp936）编码，中文输出在 pwsh / CI 里会变成乱码。
# 这些门禁的输出是给人看的，统一钉成 UTF-8（Linux/macOS 上本来就一致，无副作用）。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError, OSError):
        pass

# 声明：`function name` / `const|let|var name =`（顶层和函数内都算——函数里的
# 局部 const 被吞掉同样是坏函数，`roots` 那次就是这么丢的）。
DECL = re.compile(r"^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)"
                  r"|^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=", re.M)
# 每一半在生成物里的样子（build.mjs 内嵌的字面量）。
HALVES = [
    ("host", "tools/mcart-plugin/host.js", "panel/lib/index.js", 'const SOURCE = "'),
    ("client", "tools/mcart-plugin/client.js", "panel/lib/client.js", 'var SOURCE = "'),
]

FAILURES = 0


def check(label, ok, detail=""):
    global FAILURES
    if not ok:
        FAILURES += 1
    print("  " + ("OK  " if ok else "FAIL") + " " + label + ("" if ok or detail == "" else "  -> " + detail))


def declared(text):
    out = {}
    for match in DECL.finditer(text):
        name = match.group(1) or match.group(2)
        out[name] = out.get(name, 0) + 1
    return out


def embedded(artifact, marker):
    """把生成物里内嵌的那段源码字符串解出来（它一定是个 JSON 字面量）。"""
    text = open(os.path.join(REPO, artifact), encoding="utf-8").read()
    at = text.find(marker)
    if at < 0:
        raise SystemExit("%s 里找不到 %r —— 生成物形状变了，这条门禁要跟着改" % (artifact, marker))
    start = at + len(marker) - 1
    decoded, _ = json.JSONDecoder().raw_decode(text[start:])
    return decoded, text


def compiles(source):
    """生成物必须能被 Node 编译成函数体。"""
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as handle:
        # 只编译，不执行（执行需要 harness/React 等注入绑定）。
        handle.write("new Function(%s);" % json.dumps(source))
        path = handle.name
    try:
        done = subprocess.run(["node", path], capture_output=True, text=True)
        return done.returncode == 0, (done.stderr or "").strip().split("\n")[0][:160]
    except FileNotFoundError:
        return True, "没有 node，跳过"
    finally:
        os.unlink(path)


def compare(annotated_text, emitted_text, label):
    """返回（缺了哪些名字）。"""
    wanted = declared(annotated_text)
    have = declared(emitted_text)
    return sorted(name for name in wanted if name not in have)


FIXTURE = """const ALPHA = 1
// 老规则会把这句里的 /* 当块注释开头：versions/<v>/mods/*.jar
function findThing(start) { return start }
const BETA = 2
/** helper 的说明 */
function helper() { return BETA }
"""


def fault():
    """A/B：同一份夹具，新规则一个都不吞，老规则必须吞掉名字。"""
    fixed_output = strip_comments.strip(FIXTURE)
    fixed_missing = compare(FIXTURE, fixed_output, "fixture")
    check("夹具上：行首规则一个声明都不吞", fixed_missing == [], str(fixed_missing))
    original = strip_comments.BLOCK
    try:
        strip_comments.BLOCK = re.compile(r"/\*[\s\S]*?\*/")   # 老规则
        greedy_output = strip_comments.strip(FIXTURE)
    finally:
        strip_comments.BLOCK = original
    greedy_missing = compare(FIXTURE, greedy_output, "fixture")
    check("夹具上：老规则确实吞掉声明（所以这条检查有意义）", greedy_missing != [], str(greedy_missing))
    check("而且被吞的正是那个函数", "findThing" in greedy_missing or "BETA" in greedy_missing, str(greedy_missing))
    print("全部通过" if FAILURES == 0 else "%d 项失败" % FAILURES)
    return 1 if FAILURES else 0


def main():
    print("--- 注释剥离器：生成物里声明的名字一个都不能少")
    for label, source, artifact, marker in HALVES:
        annotated = open(os.path.join(REPO, source), encoding="utf-8").read()
        emitted, artifact_text = embedded(artifact, marker)
        missing = compare(annotated, emitted, label)
        check("%s：%d 个声明一个不少（少了就说明剥离器吞了代码）" % (label, len(declared(annotated))),
              missing == [], "缺 " + "、".join(missing))
        ok, detail = compiles(emitted)
        check("%s：生成物能编译" % label, ok, detail)
        check("%s：生成物比注释源短（剥离器真干活了）" % label,
              len(emitted) < len(annotated), "%d vs %d" % (len(emitted), len(annotated)))
        check("%s：生成物里没有行首块注释残留（剥干净了）" % label,
              not re.search(r"^[ \t]*/\*", emitted, re.M))
    print("全部通过" if FAILURES == 0 else "%d 项失败" % FAILURES)
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(fault() if "--fault" in sys.argv else main())
