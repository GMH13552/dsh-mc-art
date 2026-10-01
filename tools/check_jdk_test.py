#!/usr/bin/env python3
"""门禁：挑 JDK 的那个 preflight 必须能说出"这个 JVM 写不了 jar"。

为什么值得单独一条：这条检查的价值全在**它能不能红**。用户机器上真实发生的是
Mojang 自带 runtime 带 Low 完整性标签 → `Files.isWritable` 对自己刚写的文件回 false →
`jdk.zipfs` 把 jar 当只读 → ForgeGradle 的 access transformer 必挂（22 字节空 jar）。
那种 JVM 在 Linux 上造不出来，但**症状类别**能造：让探针往一个不可写的目录里写。

   python tools/check_jdk_test.py

六件事：
  1. **候选清单只有一份**：`check_jdk.py` 必须从 `jdk_env.py` 取候选，不许再长一份
     （两份漂过一次：运行器找得到 `~/tools/jdk17-*`，随包的检查器不找，同一台机器结论相反）；
  2. **低完整性 Mojang runtime 会被写入自检正确拒绝**（注入式假候选，与机器无关）
     —— 这是 `check_jdk.py` 最有价值的行为；
  3. 自检源码必须 ASCII（它要在裸 Windows 控制台上跑）；
  4. 正常情况必须找到 JDK 并自检通过；**但机器上真的没有 JDK 17 时要 SKIP 并说明原因**
     （门禁测的是代码，机器缺 JDK 不是代码缺陷 —— 体例同 `orient-test.js`）；
  5. 探针目录不可写时必须 exit 3，并且**说出原因**（AccessDenied / isWritable）；
  6. 要求一个不存在的版本时必须 exit 3 且逐条列出试过什么。

   python tools/check_jdk_test.py --fault   # 把夹具换成"去掉写入自检"的老逻辑，要求当场红
"""
from __future__ import annotations

import ast
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
SCRIPTS = REPO / "skills" / "mc-mod" / "scripts"
SCRIPT = SCRIPTS / "check_jdk.py"
SELF_TEST = SCRIPTS / "JvmWriteSelfTest.java"
sys.path.insert(0, str(SCRIPTS))
import jdk_env  # noqa: E402

# Windows：stdout 默认按代码页编码，子进程输出里可能带替换字符 → 打印会 UnicodeEncodeError。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError, OSError):
        pass

FAULT = "--fault" in sys.argv[1:]
failures = 0


def check(label: str, ok: bool, detail: str = "") -> None:
    global failures
    if not ok:
        failures += 1
    print("  " + ("OK  " if ok else "FAIL") + " " + label + ("" if ok or detail == "" else "  -> " + detail))


def run(*args: str) -> tuple[int, str]:
    # 子进程是 Python，父进程按 UTF-8 解；子进程也按产品宿主的做法带 `-X utf8`
    # （两道防线；`encoding-test.js` 会盯着这一行，别删）。
    done = subprocess.run([sys.executable, "-X", "utf8", str(SCRIPT), *args], capture_output=True,
                          encoding="utf-8", errors="replace", timeout=600)
    return done.returncode, (done.stdout or "") + (done.stderr or "")


def fake_run(table):
    """`subprocess.run` 的替身：按可执行文件路径回答 `javac -version`。"""

    def runner(command, **_kwargs):
        exe = str(command[0])
        reply = table.get(exe)

        class Done:
            returncode = 1
            stdout = ""
            stderr = "not found"

        done = Done()
        if reply is not None:
            done.returncode = 0
            done.stdout = reply
        return done

    return runner


def low_integrity_fixture() -> int:
    """夹具：javac 17、但**写不了 jar** 的 Mojang runtime 必须被拒，并给出解释。

    不依赖本机装没装 Mojang runtime：临时目录里造一个 `.minecraft/runtime/<x>/bin`，
    只把 `javac` 的"回答"注入进去；`verify` 模拟写入自检失败（AccessDenied）。
    """
    before = failures
    with tempfile.TemporaryDirectory(prefix="jdk-low-integrity-") as tmp:
        runtime = Path(tmp) / ".minecraft" / "runtime" / "java-runtime-gamma-snapshot"
        (runtime / "bin").mkdir(parents=True)
        javac = str(jdk_env.exe(runtime, "javac"))
        env = {"APPDATA": tmp, "USERPROFILE": str(Path(tmp) / "home"), "HOME": str(Path(tmp) / "home")}
        runner = fake_run({javac: "javac 17.0.8\n"})
        only_fake_javac = lambda path: str(path) == javac   # noqa: E731

        verified = []

        def verify(home):
            verified.append(str(home))
            return False, "java.nio.file.AccessDeniedException: write-selftest.txt"

        modern = jdk_env.pick_jdk(None, needed="17", env=env, run=runner,
                                  is_file=only_fake_javac, is_dir=os.path.isdir, verify=verify)
        legacy = jdk_env.pick_jdk(None, needed="17", env=env, run=runner,
                                  is_file=only_fake_javac, is_dir=os.path.isdir, verify=None)

        mojang = [item for item in modern["tried"] if "Mojang" in str(item["origin"])]
        hint_ok = any("Low integrity" in str(item.get("hint", "")) for item in mojang)

        # `--fault`：把断言的对象换成**去掉写入自检**的老逻辑 —— 它会被接受，于是这条必须红。
        subject = legacy if FAULT else modern
        if FAULT:
            print("  （--fault：夹具换成「不看写入自检」的老逻辑，下面这条应当红）")
        check("低完整性 Mojang runtime（javac 17 但写不了 jar）必须被拒绝"
              + ("（--fault：老逻辑接受它）" if FAULT else ""),
              subject["home"] is None, "居然选中了 " + str(subject["home"]))
        check("拒绝理由里带上 Low 完整性标签的解释（不然用户不知道下一步做什么）", hint_ok,
              str(mojang[:1]))
        check("写入自检真的被调用过（不是拿 javac 版本糊过去）",
              len(verified) >= 1, "verify 调用 %d 次" % len(verified))
        check("夹具本身有效：去掉写入自检它确实会被接受（所以上面那条不是空转）",
              legacy["home"] is not None, str(legacy["home"]))
    return failures - before


def main() -> int:
    if not SCRIPT.exists():
        check("脚本在（skills/mc-mod/scripts/check_jdk.py）", False, str(SCRIPT))
        print("1 项失败")
        return 1

    source = SCRIPT.read_text(encoding="utf-8")
    check("候选清单只有一份：check_jdk.py 从 jdk_env 取候选（不再自己长一份）",
          "import jdk_env" in source and "jdk_env.jdk_homes" in source)

    # 只查**代码里的字符串常量**（docstring 里提到 `.minecraft\runtime\...` 是在讲来龙去脉，
    # 不是候选表）。拿 AST 看，别拿文本 `in` 撞上注释。
    docstrings = set()
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            body = getattr(node, "body", [])
            first = body[0] if body else None
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) \
                    and isinstance(first.value.value, str):
                docstrings.add(first.value.value)   # 原始常量，不是 get_docstring 清过缩进的版本
    code_literals = [node.value for node in ast.walk(tree)
                     if isinstance(node, ast.Constant) and isinstance(node.value, str)
                     and node.value not in docstrings]
    leaked = [text for text in code_literals if ".minecraft" in text or "Eclipse Adoptium" in text]
    check("check_jdk.py 的**代码**里没有自己的候选枚举（那些字面量只该在 jdk_env.py）",
          not leaked, str(leaked[:3]))

    # 3) ASCII 自检源码：裸 Windows 控制台上非 ASCII 会直接炸。
    raw = SELF_TEST.read_bytes()
    check("自检源码是 ASCII（能在裸 Windows 控制台跑）", all(byte < 128 for byte in raw),
          "第 %d 字节 = %d" % (next((i for i, b in enumerate(raw) if b >= 128), -1),
                              next((b for b in raw if b >= 128), 0)))

    # 2) 与机器无关的低完整性夹具（这条门禁的主体证明）。
    low_integrity_fixture()

    # 本机有没有一份**非 Mojang**的 JDK 17？没有就 SKIP 下面两条真机检查，而不是 FAIL。
    homes = jdk_env.jdk_homes(None)
    real17 = [str(home) for home, origin in homes
              if "Mojang" not in str(origin) and jdk_env.jdk_major(home)[0] == "17"]
    mojang17 = [str(home) for home, origin in homes
                if "Mojang" in str(origin) and jdk_env.jdk_major(home)[0] == "17"]

    if not real17:
        print("  SKIP 本机没有非 Mojang 的 JDK 17（候选 %d 个，其中 Mojang 的 17 有 %d 个）——"
              "机器问题，不是代码缺陷；上面那条夹具是这条门禁的主体证明，与机器无关。"
              % (len(homes), len(mojang17)))
    else:
        # 4) 正常路径：真机上有可用的 JDK 17 → check_jdk.py 必须接受它（统一候选表之后成立）。
        code, out = run()
        if code == 0:
            check("正常情况：找到能写 jar 的 JDK 17（%s）" % os.path.basename(real17[0]),
                  "JDK OK" in out and "SELFTEST OK" in out, out.strip()[:200])
        else:
            check("正常情况：找到能写 jar 的 JDK 17", False,
                  "本机有 javac 17（%s）却没被接受 —— 这是候选表/判定漂移，不是机器问题：%s"
                  % (", ".join(real17[:3]), out.strip()[:200]))

        # 5) 症状类别：探针目录建不出来 / 不可写 → 必须红，并且说出原因。
        #    Windows 上 `chmod 500` **不会**让目录变成不可写（实测：chmod 之后仍能写文件），
        #    所以拿"路径被一个文件挡住"来造同一种失败 —— 两个平台都确定性地失败。
        with tempfile.TemporaryDirectory() as tmp:
            blocked = Path(tmp) / "blocked"
            blocked.write_text("not a directory\n", encoding="ascii")
            probe = blocked / "child"
            code_ro, out_ro = run("--probe-dir", str(probe))
            check("探针目录建不出来时：exit 3（不是假装通过，也不抛 traceback）",
                  code_ro == 3, "exit=%s" % code_ro)
            check("而且说得出原因（自检失败的具体报错）",
                  "写入自检失败" in out_ro and ("自检目录建不出来" in out_ro
                                          or "AccessDenied" in out_ro or "SELFTEST FAIL" in out_ro),
                  out_ro.strip()[:220])

    # 6) 版本不对 → 逐条列出试过什么（与机器无关：没有哪个 JDK 是 99）。
    code_bad, out_bad = run("--needed", "99")
    reasons = [line for line in out_bad.splitlines() if line.strip().startswith("- ")]
    check("要求不存在的版本时：exit 3 且逐条列出候选与原因", code_bad == 3 and len(reasons) >= 2,
          "exit=%s，原因 %d 条" % (code_bad, len(reasons)))
    check("失败信息里给了出路（装一个普通 JDK / 复制到普通目录 / --java-home）",
          "JDK" in out_bad and ("--java-home" in out_bad), out_bad.strip()[-200:])

    print("全部通过" if failures == 0 else "%d 项失败" % failures)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
