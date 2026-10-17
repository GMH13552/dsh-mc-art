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
# 每一半在生成物里的样子：源码被**内联**在函数体里，两边用注释围栏标出
# （`panel/build.mjs` 生成）。不再按 `const SOURCE = "…"` 找 —— 0.2.1 的浏览器
# 沙箱禁掉了求值型加载，产物已经改成静态函数体，门禁跟着真实产物走。
FENCE_BEGIN = "// >>> mcart:embedded-source"
FENCE_END = "// <<< mcart:embedded-source"
HALVES = [
    ("host", "tools/mcart-plugin/host.js", "panel/lib/index.js"),
    ("client", "tools/mcart-plugin/client.js", "panel/lib/client.js"),
]

# 拆分之后：`tools/mcart-plugin/<half>.js` 是**生成物**（barrel），真源是
# `tools/mcart-plugin/<half>/` 下的片段 + `<half>.manifest.json`（入口列最后）。
# 所以"注释源"不再直接读 barrel —— 先问唯一拼接实现 `panel/source.mjs` 要拼接结果，
# 再与 barrel 交叉验证二者逐字节一致（两个真相会让门禁各自为政）。
HALF_SPEC = {
    "host": ("host.js", "host.manifest.json"),
    "client": ("client.js", "client.manifest.json"),
}

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


def concat_half(half):
    """问唯一拼接实现要"这一半的完整源码"（`node panel/source.mjs <half>`）。"""
    done = subprocess.run(["node", os.path.join(REPO, "panel", "source.mjs"), half],
                          cwd=REPO, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=120)
    if done.returncode != 0:
        raise SystemExit("%s：`node panel/source.mjs %s` 失败（退出码 %s）：%s"
                         % (half, half, done.returncode, (done.stderr or "").strip()[:400]))
    return done.stdout


def fragments(half):
    """清单里的片段路径（相对 tools/mcart-plugin/）。legacy 单文件模式返回 []。"""
    _, manifest = HALF_SPEC[half]
    path = os.path.join(REPO, "tools", "mcart-plugin", manifest)
    with open(path, encoding="utf-8") as handle:
        listed = json.load(handle)
    return [item.replace("\\", "/") for item in listed]


def fragment_names_missing(barrel_text, listed, root=None):
    """清单里每个片段**声明的名字**，必须都出现在 barrel 里。

    WHY：片段被列进清单、拼接却漏了它（或者 barrel 没重写），症状是"某些函数突然不存在"。
    `--fault` 会用同一份函数证明它能红。
    """
    root = root or os.path.join(REPO, "tools", "mcart-plugin")
    missing = []
    for name in listed:
        path = os.path.join(root, name)
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
        for declared_name in declared(text):
            if declared_name not in barrel_text:
                missing.append(name + ":" + declared_name)
    return missing


def embedded(artifact):
    """把生成物里内嵌的那段源码正文解出来（两行围栏之间）。"""
    text = open(os.path.join(REPO, artifact), encoding="utf-8").read()
    start = text.find(FENCE_BEGIN)
    if start < 0:
        raise SystemExit("%s 里找不到源码围栏 %r —— 生成物形状变了，这条门禁要跟着改"
                         % (artifact, FENCE_BEGIN))
    start += len(FENCE_BEGIN)
    stop = text.find(FENCE_END, start)
    if stop < 0:
        raise SystemExit("%s 里不完整的围栏（有 begin 没有 end）" % artifact)
    return text[start:stop], text


def compiles(source):
    """生成物必须能被 Node 编译成函数体。"""
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as handle:
        # 只编译，不执行（执行需要 harness/React 等注入绑定）。
        handle.write("new Function(%s);" % json.dumps(source))
        path = handle.name
    try:
        # 生成物里带着中文注释；不写 encoding 时按区域编码解，stderr 会变乱码（门禁假红）。
        done = subprocess.run(["node", path], capture_output=True, text=True,
                              encoding="utf-8", errors="replace")
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

    # 片段名对账的 A/B：清单里两个片段，barrel 只拼了第一个 → 第二个的名字必须报缺。
    with tempfile.TemporaryDirectory(prefix="stripgate-frag-") as tmp:
        os.makedirs(os.path.join(tmp, "host"))
        with open(os.path.join(tmp, "host", "p-a.js"), "w", encoding="utf-8") as handle:
            handle.write("function alpha() { return 1 }\n")
        with open(os.path.join(tmp, "host", "p-b.js"), "w", encoding="utf-8") as handle:
            handle.write("function beta() { return alpha() }\n")
        listed = ["host/p-a.js", "host/p-b.js"]
        partial = "function alpha() { return 1 }\n"
        missing_partial = fragment_names_missing(partial, listed, root=tmp)
        check("片段名对账：barrel 漏拼一个片段 → 它的声明必须报缺（这条会红）",
              any(item.endswith(":beta") for item in missing_partial), str(missing_partial))
        complete = partial + "function beta() { return alpha() }\n"
        check("片段名对账：全拼进去就一个都不缺",
              fragment_names_missing(complete, listed, root=tmp) == [])
    print("全部通过" if FAILURES == 0 else "%d 项失败" % FAILURES)
    return 1 if FAILURES else 0


def main():
    print("--- 注释剥离器：生成物里声明的名字一个都不能少")
    for label, source, artifact in HALVES:
        barrel_path = os.path.join(REPO, source)
        with open(barrel_path, encoding="utf-8") as handle:
            barrel = handle.read()
        # ① 拼接结果与 barrel 必须逐字节一致（barrel 是生成物，真源是片段清单）。
        concatenated = concat_half(label)
        check("%s：`panel/source.mjs %s` 的拼接结果与 barrel 逐字节一致" % (label, label),
              concatenated == barrel,
              "拼接 %d 字符 / barrel %d 字符" % (len(concatenated), len(barrel)))
        # ② 清单里每个片段声明的名字都出现在 barrel 里。
        listed = fragments(label)
        missing_names = fragment_names_missing(barrel, listed)
        if listed:
            check("%s：清单里 %d 个片段的声明名字都出现在 barrel 里" % (label, len(listed)),
                  missing_names == [], "缺 " + "、".join(missing_names[:8]))
        else:
            print("  · %s：清单为空（legacy 单文件模式）—— 片段名字对账等拆分落地后生效" % label)
        # ③ 剥注释不许吞代码（原来那条，输入用 barrel = 拼接结果）。
        annotated = barrel
        emitted, artifact_text = embedded(artifact)
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
