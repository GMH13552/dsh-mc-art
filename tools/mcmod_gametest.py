#!/usr/bin/env python3
"""Run a Forge mod's GameTestServer and turn it into a verdict we can trust.

WHY THIS IS THE JUDGE.  `GameTestServer` is Mojang's own special dedicated server:
it runs every registered game test and then EXITS, and **the exit code is the
number of failed required tests** (Forge documents this, and it is why the whole
thing is CI-friendly).  So "did the mod do what it claims" is not my opinion and
not a screenshot -- it is a number the game itself produced.

  python tools/mcmod_gametest.py                 # run, print the verdict
  python tools/mcmod_gametest.py --fault         # prove the judge can fail
  python tools/mcmod_gametest.py --json OUT      # machine-readable result
  python tools/mcmod_gametest.py --jdk-selftest  # only the JDK picker (--fault: old judgement picks 21)
  python tools/mcmod_gametest.py --restore-selftest  # only the --fault contract (inject -> byte-exact restore)

On Windows the interpreter is usually `python` or `py -3` (`python3` is often a
zero-byte Store stub), and the default `java` is often the WRONG major version
(1.18.2 needs 17; a JDK 21 cannot build it).  So the JDK is picked by **running**
each candidate -- `javac -version` and the write self-test -- never by trusting a
name or a directory listing.

`--fault` exists for the same reason every other gate in this repository has one:
a check that cannot fail on the bug it names is not a check.  It temporarily
rewrites the assertion in the test source to something false, runs the server,
and requires a NON-zero exit -- then puts the file back, byte for byte.

The proxy is not optional: Gradle ignores `http_proxy` from the environment and
only reads `systemProp.*` (see the project's gradle.properties), and the wrapper
download needs it as a JVM flag too.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
# Windows：stdout 默认按控制台代码页（本机 cp936）编码，中文输出在 pwsh / CI 里会变成乱码。
# 这个工具的输出是给人看的，统一钉成 UTF-8（Linux/macOS 上本来就一致，无副作用）。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError, OSError):
        pass
DEFAULT_PROJECT = Path(os.environ.get("MCMOD_PROJECT") or (REPO / "examplemod" / "mod"))
GRADLE_TASK = "runGameTestServer"
NEEDED_JDK = "17"
# 候选清单与 `javac -version` 判定只有**一份**实现，随包的 `skills/mc-mod/scripts/check_jdk.py`
# 也 import 它（`jdk_env.py` 跟着 skill 一起发出去）。两份实现漂过一次：这份运行器找得到
# `~/tools/jdk17-*`，而随包的检查器不找 —— 同一台机器，结论相反。
sys.path.insert(0, str(REPO / "skills" / "mc-mod" / "scripts"))
import jdk_env  # noqa: E402
PROXY = ("-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=7897 "
         "-Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=7897")

# The line the fault injection rewrites.  Kept as one exact string so a rename in
# the test makes this tool fail loudly instead of quietly injecting nothing.
#
# **D1: these are DEFAULTS, not the contract.**  They name the example project's own
# symbol, so before `--fault-find/--fault-replace` existed every new project had to
# spell `ExampleMod.EXAMPLE_BLOCK` in its own source just to make `--fault` reach the
# injection step -- i.e. the tool forced you to pollute the thing under test.  Pass
# the two flags to point at *your* assertion; with no flags the old text is used, so
# the example project (and its selftests) keep working unchanged.
FAULT_FIND = "state -> state.is(ExampleMod.EXAMPLE_BLOCK.get())"
FAULT_REPLACE = "state -> state.is(net.minecraft.world.level.block.Blocks.DIRT)"


def inject_fault_file(source: Path, find: str = FAULT_FIND, replace: str = FAULT_REPLACE):
    """把断言改成 `replace`，返回一个**按字节**还原的可调用对象。

    WHY BYTES.  `--fault` 的契约是"注入 → 必须红 → **还原**"。老实现用
    `read_text()` / `write_text()`，那是**文本模式**：Windows 上 `write_text` 会把 `\\n`
    展开成 `\\r\\n`。于是跑完一次故障注入，`git diff` 是空的、`git status` 却永远脏，还伴随
    `warning: CRLF will be replaced by LF in …ExampleGameTests.java`（Lead 实测）。
    在这个仓库里这很致命：任何人 `git add -A` 都会把一次行尾变更带进提交，而"看起来像改了代码"
    的 diff 会让 review 失效 —— `.gitattributes` 正是把 `*.java` 钉成 LF 的。

    所以注入前按二进制读、还原时按二进制写：内容与行尾都逐字节回到原样。

    `find`/`replace` 由 CLI 的 `--fault-find/--fault-replace` 传进来（D1）：默认值只保证
    示例工程能跑，任何别的工程都该用**它自己的**那句断言。
    """
    original = source.read_bytes()
    text = original.decode("utf-8")
    if find not in text:
        raise LookupError(find)
    source.write_bytes(text.replace(find, replace).encode("utf-8"))
    return lambda: source.write_bytes(original)


def java_exe(home: Path, name: str) -> Path:
    return jdk_env.exe(home, name)


def jdk_major(home, run=subprocess.run, is_file=os.path.isfile, timeout: int = 60):
    """`(major, reason)` for this directory -- the shared implementation really runs it."""
    return jdk_env.jdk_major(home, run=run, is_file=is_file, timeout=timeout)


def java_runs(home):
    """这个 JDK 的 `java` 真的能启动吗？——运行器这一侧的最小 verify。

    更强的那一道（启动这个 JVM、让它写文件与 jar，用来抓 Low 完整性标签）在
    `skills/mc-mod/scripts/check_jdk.py` 里，它把 `self_test` 当 verify 传给同一个
    `jdk_env.pick_jdk`。两边共享候选与版本判定，只是门槛不同 —— 这是刻意的。
    """
    java = jdk_env.exe(home, "java")
    if not os.path.isfile(str(java)):
        return False, "no java in bin/"
    try:
        done = subprocess.run([str(java), "-version"], capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=60)
    except Exception as exc:  # noqa: BLE001
        return False, "java would not start: %s" % exc
    return done.returncode == 0, "java -version exit=%s" % done.returncode


def resolve_jdk(explicit=None, needed=NEEDED_JDK, env=None, run=subprocess.run,
                is_file=os.path.isfile, is_dir=os.path.isdir, verify=java_runs):
    """`{home, origin, major, reason, hint, tried}` -- shared candidates, shared judgement.

    候选清单与 `javac -version` 判定来自 `skills/mc-mod/scripts/jdk_env.py`（**唯一一份**）。
    两份实现漂过一次：这份运行器找得到 `~/tools/jdk17-*`，而随包的 `check_jdk.py` 不找，
    同一台机器给出相反结论、用户被告知"去装一个 JDK 17"。
    """
    return jdk_env.pick_jdk(explicit, needed=needed, env=env, run=run,
                            is_file=is_file, is_dir=is_dir, verify=verify)


def restore_selftest(fault: bool = False) -> int:
    """把"还原"这条契约立起来：真跑一次 CLI `--fault`，断言工作树前后都是干净的。

    用一个临时 git 仓库 + 假 `gradlew.bat`（退出码 1）当夹具 —— 不必起真服务端，
    但走的是**真的注入 / 真的还原 / 真的退出码**那条路。

    `--fault` 反向夹具：故意用**文本模式**（LF→CRLF）写回，同一个断言必须红 ——
    证明这条检查不是空转（在老实现上它确实会红）。
    """
    failures = 0

    def check(label, ok, detail=""):
        nonlocal failures
        if not ok:
            failures += 1
        print("  " + ("OK  " if ok else "FAIL") + " " + label + ("" if ok or not detail else "  -> " + detail))

    fixture = ("package com.examplemod;\n\n"
               "import net.minecraft.gametest.framework.GameTest;\n\n"
               "public class ExampleGameTests {\n"
               "  @GameTest(template = \"empty\")\n"
               "  public void places() {\n"
               "    // 注入要改的就是下面这一句（直接引用 FAULT_FIND，改名了也不会漂）\n"
               "    GameTestHelper.succeedIf(() -> " + FAULT_FIND + ");\n"
               "  }\n"
               "}\n")

    with tempfile.TemporaryDirectory(prefix="mcmod-restore-") as tmp:
        project = Path(tmp)
        source = project / "src/main/java/com/examplemod/ExampleGameTests.java"
        source.parent.mkdir(parents=True)
        source.write_bytes(fixture.encode("utf-8"))
        (project / "gradlew.bat").write_text("@echo off\nexit /b 1\n", encoding="ascii")
        # 真实工程里 `build/` 是 gitignore 的（工具会往那儿写 gametest.log）——
        # 夹具也照做，这样"跑完 git status 仍然为空"看起来跟真仓库一样。
        (project / ".gitignore").write_text("build/\n", encoding="ascii")
        before = source.read_bytes()

        if fault:
            # 反向夹具：模拟老实现在 Windows 文本模式下的写回（LF → CRLF）。
            injected = before.decode("utf-8").replace(FAULT_FIND, FAULT_REPLACE)
            buggy = injected.replace("\n", "\r\n").encode("utf-8")
            source.write_bytes(buggy)
            check("老实现（文本模式写回）确实会改变字节 ← 所以按字节还原是必需的",
                  source.read_bytes() != injected.encode("utf-8") and b"\r\n" in source.read_bytes(),
                  "行尾没被改，说明这个反向夹具本身失效了")
            check("而且差异**只是行尾**：换回 LF 后内容与注入版逐字节相同",
                  source.read_bytes().replace(b"\r\n", b"\n").decode("utf-8") == injected)
            source.write_bytes(before)
            check("按字节还原回原文件后，与跑之前逐字节相同",
                  source.read_bytes() == before)
            print("全部通过（对照成立：文本模式写回会把工作树弄脏，按字节还原不会）"
                  if failures == 0 else "%d 项失败" % failures)
            return 1 if failures else 0

        jdk = resolve_jdk(None, NEEDED_JDK)
        if jdk["home"] is None:
            print("  SKIP 本机没有可用的 JDK %s —— CLI 那条夹具没跑（`--jdk-selftest` 能看细节）" % NEEDED_JDK)
            return 0
        subprocess.run(["git", "init", "-q"], cwd=str(project), capture_output=True, encoding="utf-8", errors="replace")
        subprocess.run(["git", "add", "-A"], cwd=str(project), capture_output=True, encoding="utf-8", errors="replace")
        subprocess.run(["git", "-c", "user.email=t@example.invalid", "-c", "user.name=t",
                        "commit", "-q", "-m", "fixture"], cwd=str(project),
                       capture_output=True, encoding="utf-8", errors="replace")
        clean_before = subprocess.run(["git", "status", "--porcelain"], cwd=str(project),
                                      capture_output=True, encoding="utf-8", errors="replace")
        check("夹具仓库一开始是干净的", clean_before.stdout.strip() == "", clean_before.stdout.strip())

        done = subprocess.run([sys.executable, "-X", "utf8", str(HERE / "mcmod_gametest.py"),
                               "--project", str(project),
                               "--test-source", str(source), "--java-home", jdk["home"], "--fault"],
                              capture_output=True, encoding="utf-8", errors="replace", timeout=600)
        out = (done.stdout or "") + (done.stderr or "")
        status_after = subprocess.run(["git", "status", "--porcelain"], cwd=str(project),
                                      capture_output=True, encoding="utf-8", errors="replace")
        check("跑完 CLI `--fault` 之后 `git status --porcelain` 仍然为空（工作树没被弄脏）",
              status_after.stdout.strip() == "", status_after.stdout.strip())
        check("注入真的生效过（不是「没跑」）", "已注入故障" in out and "已把测试源码原样放回" in out,
              out.strip().splitlines()[-1][:120] if out.strip() else "(没有输出)")
        check("`--fault` 契约成立：假 gradlew 退出码 1 → 判定为「抓到了」且 CLI 退出码 0",
              "抓到了" in out and done.returncode == 0,
              "returncode=%s；%s" % (done.returncode, out.strip().splitlines()[-1][:100] if out.strip() else "(没有输出)"))
        check("测试源码逐字节回到原样（行尾也没变）", source.read_bytes() == before,
              "%d 字节 -> %d 字节" % (len(before), len(source.read_bytes())))

    print("全部通过" if failures == 0 else "%d 项失败" % failures)
    return 1 if failures else 0


# ---------------------------------------------------------------------------
# D1/D2/D3/D4 的自测。体例同 restore_selftest：正向断言 + 一个**反向夹具**
# （`--fault` 下用"老写法"跑同一条断言，要求它红），证明门禁不是空转。
# ---------------------------------------------------------------------------

CUSTOM_FAULT_FIND = "state -> state.is(MyMod.MY_BLOCK.get())"
# **故意与默认替换不同**：否则"没用默认那句"这条断言就没有区分力。
CUSTOM_FAULT_REPLACE = "state -> state.is(net.minecraft.world.level.block.Blocks.STONE)"


def _fixture_source(find: str) -> str:
    return ("package com.examplemod;\n\n"
            "import net.minecraft.gametest.framework.GameTest;\n\n"
            "public class ExampleGameTests {\n"
            "  @GameTest(template = \"empty\")\n"
            "  public void places() {\n"
            "    GameTestHelper.succeedIf(() -> " + find + ");\n"
            "  }\n"
            "}\n")


def _fixture_project(tmp, find: str = FAULT_FIND, gradlew_exit: int = 1, observe: bool = True):
    """临时工程，**目录名故意含空格**（形状同用户那种 `Release 2.8.3`，但不是真实路径）。"""
    project = Path(tmp) / "Release 2.8.3" / "proj"
    source = project / "src/main/java/com/examplemod/ExampleGameTests.java"
    source.parent.mkdir(parents=True)
    source.write_bytes(_fixture_source(find).encode("utf-8"))
    lines = ["@echo off"]
    if observe:
        lines.append("echo started> ran.txt")
        # 把子进程看到的 GRADLE_USER_HOME 抄下来：D4 靠它证明环境变量**真的传到了**。
        lines.append("echo %GRADLE_USER_HOME%> gradle-home-seen.txt")
        lines.append('copy /y "src\\main\\java\\com\\examplemod\\ExampleGameTests.java" observed.java >nul')
    lines.append("exit /b %d" % gradlew_exit)
    (project / "gradlew.bat").write_text("\r\n".join(lines) + "\r\n", encoding="ascii")
    (project / ".gitignore").write_text("build/\nran.txt\nobserved.java\ngradle-home/\ngradle-home-seen.txt\n",
                                        encoding="ascii")
    return project, source


def _legacy_gradle_command(project: str):
    """D3 的老写法：把 `list2cmdline` 的结果当**一个 argv 元素**。"""
    return [os.environ.get("ComSpec", "cmd.exe"), "/d", "/s", "/c",
            subprocess.list2cmdline([os.path.join(project, "gradlew.bat"),
                                     GRADLE_TASK, "--no-daemon", "--console=plain"])]


def _run_cli(project, source, jdk_home, extra=(), timeout: int = 600):
    command = [sys.executable, "-X", "utf8", str(HERE / "mcmod_gametest.py"),
               "--project", str(project), "--test-source", str(source),
               "--java-home", str(jdk_home), "--gradle-home", str(Path(project) / "gradle-home"),
               *extra]
    return subprocess.run(command, capture_output=True, encoding="utf-8", errors="replace", timeout=timeout)


def _checker():
    state = {"failures": 0}

    def check(label, ok, detail=""):
        if not ok:
            state["failures"] += 1
        print("  " + ("OK  " if ok else "FAIL") + " " + label + ("" if ok or not detail else "  -> " + detail))
    return check, state


def space_selftest(fault: bool = False) -> int:
    """D3：**含空格的工程路径**上，wrapper 必须真的被启动。

    老写法（argv 元素里塞整条命令行）在无空格路径上能跑，所以历史一直没暴露；
    用户工程路径里有空格（`...\\Release 2.8.3\\...`），它当场死成"stage unknown / 退出码 1"。
    """
    check, state = _checker()
    if os.name != "nt":
        print("  SKIP 这条只在 Windows 上有意义（cmd.exe 的引号剥法）")
        return 0
    with tempfile.TemporaryDirectory(prefix="mcmod-space-") as tmp:
        project, _source = _fixture_project(tmp)

        command = gradle_command(project=str(project))
        done = subprocess.run(command, shell=isinstance(command, str), cwd=str(project),
                              capture_output=True, encoding="utf-8", errors="replace", timeout=120)
        started = (project / "ran.txt").is_file()

        if fault:
            # 反向夹具：用**老写法**去满足"wrapper 真的被启动"，它必须不成立。
            (project / "ran.txt").unlink(missing_ok=True)
            legacy = subprocess.run(_legacy_gradle_command(str(project)), cwd=str(project),
                                    capture_output=True, encoding="utf-8", errors="replace", timeout=120)
            check("反向夹具：老写法下「wrapper 真的被启动」这条断言确实红（含空格路径起不动）",
                  not (project / "ran.txt").is_file(),
                  "老写法居然起来了（returncode=%s），这个反向夹具失效了" % legacy.returncode)
            check("老写法的报错形状就是那句 `... is not recognized`（伪装成 Gradle 失败）",
                  "is not recognized" in ((legacy.stdout or "") + (legacy.stderr or "")),
                  ((legacy.stdout or "") + (legacy.stderr or "")).strip()[:160])
            print("全部通过（对照成立：老写法在含空格路径上确实起不动）" if state["failures"] == 0
                  else "%d 项失败" % state["failures"])
            return 1 if state["failures"] else 0

        check("含空格路径上 wrapper 真的被启动了（假 gradlew 写出了 ran.txt）", started,
              "returncode=%s；%s" % (done.returncode, ((done.stdout or "") + (done.stderr or "")).strip()[:200]))
        check("启动方式是「一条命令行 + shell」，不是 argv 列表", isinstance(command, str), str(command))
        check("wrapper 在命令行里带引号", command.startswith('"'), str(command))

        (project / "ran.txt").unlink(missing_ok=True)
        legacy = subprocess.run(_legacy_gradle_command(str(project)), cwd=str(project),
                                capture_output=True, encoding="utf-8", errors="replace", timeout=120)
        check("对照：老写法在同一夹具上确实起不动（这就是用户遇到的形状）",
              not (project / "ran.txt").is_file(), "老写法居然也起来了，夹具没有区分力")

        # 端到端：真走一遍 CLI（含注入/还原），JDK 不在就 SKIP 这一段。
        jdk = resolve_jdk(None, NEEDED_JDK)
        if jdk["home"] is None:
            print("  SKIP 本机没有可用的 JDK %s —— CLI 那一段没跑（上面直接量了 wrapper 启动）" % NEEDED_JDK)
        else:
            (project / "ran.txt").unlink(missing_ok=True)
            done = _run_cli(project, _source, jdk["home"], ["--fault"])
            out = (done.stdout or "") + (done.stderr or "")
            check("CLI 端到端：含空格工程路径上跑通 --fault（抓到了 → 退出码 0）",
                  done.returncode == 0 and "抓到了" in out,
                  "returncode=%s；%s" % (done.returncode, out.strip().splitlines()[-1][:160] if out.strip() else "(没有输出)"))
            check("CLI 端到端：wrapper 真被启动（ran.txt 有）", (project / "ran.txt").is_file())
            check("CLI 端到端：注入真的生效过（假 gradlew 抄到的源码里有替换后的断言）",
                  (project / "observed.java").is_file()
                  and FAULT_REPLACE in (project / "observed.java").read_text(encoding="utf-8"),
                  (project / "observed.java").read_text(encoding="utf-8")[:80]
                  if (project / "observed.java").is_file() else "(没有 observed.java)")

    print("全部通过" if state["failures"] == 0 else "%d 项失败" % state["failures"])
    return 1 if state["failures"] else 0


def fault_args_selftest(fault: bool = False) -> int:
    """D1：`--fault-find/--fault-replace` 给了就用给定的；没给就用兼容默认。"""
    check, state = _checker()
    with tempfile.TemporaryDirectory(prefix="mcmod-fa-") as tmp:
        project, source = _fixture_project(tmp, find=CUSTOM_FAULT_FIND)
        before = source.read_bytes()

        if fault:
            # 反向夹具：老实现写死注入点 —— 在这份（不含示例工程符号的）源码上**根本走不到注入**。
            try:
                inject_fault_file(source)          # 默认 find
                check("反向夹具：写死注入点时应该注入失败（LookupError）", False,
                      "居然注入了 —— 说明默认 find 恰好出现在这份夹具里，夹具失效")
            except LookupError:
                check("反向夹具：老实现（注入点写死）在这份源码上确实注入失败 ← 所以必须有 CLI 覆盖",
                      True)
            finally:
                source.write_bytes(before)
            check("而且源码逐字节没被动过", source.read_bytes() == before)
            print("全部通过（对照成立：写死注入点会逼着别人写出示例工程的符号）" if state["failures"] == 0
                  else "%d 项失败" % state["failures"])
            return 1 if state["failures"] else 0

        jdk = resolve_jdk(None, NEEDED_JDK)
        if jdk["home"] is None:
            print("  SKIP 本机没有可用的 JDK %s —— CLI 那两条没跑（下面直接量注入函数）" % NEEDED_JDK)
        else:
            done = _run_cli(project, source, jdk["home"],
                            ["--fault", "--fault-find", CUSTOM_FAULT_FIND,
                             "--fault-replace", CUSTOM_FAULT_REPLACE])
            out = (done.stdout or "") + (done.stderr or "")
            check("给了 --fault-find/--fault-replace：CLI 用给定的那句注入并抓到（退出码 0）",
                  done.returncode == 0 and "抓到了" in out,
                  "returncode=%s；%s" % (done.returncode, out.strip().splitlines()[-1][:160] if out.strip() else "(没有输出)"))
            observed = (project / "observed.java").read_text(encoding="utf-8") if (project / "observed.java").is_file() else ""
            check("真的用了给定的替换文本（假 gradlew 抄到的源码里有 CUSTOM_FAULT_REPLACE）",
                  CUSTOM_FAULT_REPLACE in observed, observed[:120] or "(没有 observed.java)")
            check("没用默认那句（默认替换在抄到的源码里不该出现）",
                  FAULT_REPLACE not in observed, observed[:120] or "(没有 observed.java)")
            check("源码逐字节还原", source.read_bytes() == before,
                  "%d 字节 -> %d 字节" % (len(before), len(source.read_bytes())))

            done2 = _run_cli(project, source, jdk["home"], ["--fault"])
            out2 = (done2.stdout or "") + (done2.stderr or "")
            check("没给参数时用**兼容默认**：在这份自定义源码上注入失败、退出码 2",
                  done2.returncode == 2, "returncode=%s" % done2.returncode)
            check("而且报错里告诉用户用 --fault-find（不是丢一句 traceback）",
                  "--fault-find" in out2, out2.strip().splitlines()[-1][:160] if out2.strip() else "(没有输出)")

        # 纯函数那一层（不依赖 JDK）：默认参数就是兼容默认，显式参数一定生效。
        probe = Path(tmp) / "probe.java"
        probe.write_bytes(_fixture_source(CUSTOM_FAULT_FIND).encode("utf-8"))
        undo = inject_fault_file(probe, CUSTOM_FAULT_FIND, CUSTOM_FAULT_REPLACE)
        injected = probe.read_bytes().decode("utf-8")
        check("注入函数：显式 find/replace 真的生效", CUSTOM_FAULT_REPLACE in injected and CUSTOM_FAULT_FIND not in injected)
        undo()
        check("注入函数：还原后逐字节相同", probe.read_bytes() == _fixture_source(CUSTOM_FAULT_FIND).encode("utf-8"))

    print("全部通过" if state["failures"] == 0 else "%d 项失败" % state["failures"])
    return 1 if state["failures"] else 0


def fault_verdict_selftest(fault: bool = False) -> int:
    """D2：`--fault` **没抓到**故障时必须非 0。"""
    check, state = _checker()
    legacy_rule = lambda caught, ok=True: (0 if (ok or True) else 1)  # noqa: E731  老判据

    if fault:
        check("反向夹具：老判据在「没抓到」时也返回 0（判决是摆设）",
              legacy_rule(False) == 0 and fault_exit_code(False) != 0,
              "老判据=%s 新判据=%s" % (legacy_rule(False), fault_exit_code(False)))
        print("全部通过（对照成立：老判据恒为 0，新判据对「没抓到」返回非 0）" if state["failures"] == 0
              else "%d 项失败" % state["failures"])
        return 1 if state["failures"] else 0

    check("抓到故障 → 退出码 0", fault_exit_code(True) == 0, str(fault_exit_code(True)))
    check("没抓到故障 → 退出码非 0（且与「判定没通过」的 1 区分：用 4）",
          fault_exit_code(False) == 4, str(fault_exit_code(False)))

    jdk = resolve_jdk(None, NEEDED_JDK)
    if jdk["home"] is None:
        print("  SKIP 本机没有可用的 JDK %s —— 端到端那两条没跑（判据函数已直接量过）" % NEEDED_JDK)
    else:
        with tempfile.TemporaryDirectory(prefix="mcmod-fv-") as tmp:
            # ① 假 gradlew **退出 0** = 注入的故障没被抓到 → CLI 必须非 0
            project, source = _fixture_project(Path(tmp) / "notcaught", gradlew_exit=0)
            done = _run_cli(project, source, jdk["home"], ["--fault"])
            out = (done.stdout or "") + (done.stderr or "")
            check("端到端：故障没被抓到（假 gradlew 退出 0）→ CLI 非 0",
                  done.returncode == 4 and "没抓到" in out,
                  "returncode=%s；%s" % (done.returncode, out.strip().splitlines()[-1][:160] if out.strip() else "(没有输出)"))
        with tempfile.TemporaryDirectory(prefix="mcmod-fv2-") as tmp:
            # ② 假 gradlew **退出 1** = 抓到了 → CLI 必须 0
            project, source = _fixture_project(Path(tmp) / "caught", gradlew_exit=1)
            done = _run_cli(project, source, jdk["home"], ["--fault"])
            out = (done.stdout or "") + (done.stderr or "")
            check("端到端：抓到了（假 gradlew 退出 1）→ CLI 退出码 0",
                  done.returncode == 0 and "抓到了" in out,
                  "returncode=%s；%s" % (done.returncode, out.strip().splitlines()[-1][:160] if out.strip() else "(没有输出)"))
            check("输出里写明「工具自身的退出码不携带判决」（判决看 gradlew）",
                  "不携带判决" in out, out[-200:])

    print("全部通过" if state["failures"] == 0 else "%d 项失败" % state["failures"])
    return 1 if state["failures"] else 0


def gradle_home_selftest(fault: bool = False) -> int:
    """D4：选出的 Gradle 家必须**真的可写**，并打印是哪个、为什么。"""
    check, state = _checker()
    with tempfile.TemporaryDirectory(prefix="mcmod-gh-") as tmp:
        root = Path(tmp)
        writable = root / "writable-home"
        # 确定性的"不可写"：候选项的位置被一个**文件**占住（Windows 上 os.chmod 管不住写权限）。
        blocked = root / "blocked-home"
        blocked.write_text("not a directory\n", encoding="utf-8")

        if fault:
            # 反向夹具：老行为 = 拿到第一个候选就用，不自检可写 → 会用一个建不了锁文件的家。
            ok_blocked, why = dir_writable(blocked)
            check("反向夹具：「第一个候选」确实是不可写的（老行为会直接用它）", ok_blocked is False, why)
            chosen_legacy = str(blocked)
            check("反向夹具：老行为下「选出的家真的可写」这条断言会红",
                  dir_writable(chosen_legacy)[0] is False)
            print("全部通过（对照成立：不自检可写就会选中一个 wrapper 建不了 .lck 的家）"
                  if state["failures"] == 0 else "%d 项失败" % state["failures"])
            return 1 if state["failures"] else 0

        picked = pick_gradle_home(explicit=writable)
        check("显式 --gradle-home：选中它本身", picked["home"] == str(writable), str(picked["home"]))
        check("理由里写明来源（--gradle-home）", "--gradle-home" in picked["why"], picked["why"])
        check("选出的家**真的可写**（再探一次）", dir_writable(picked["home"])[0])

        # 默认候选被文件占住 → 必须跳过它，并用逐条理由说清为什么
        picked2 = pick_gradle_home(candidates=[(str(blocked), "默认：用户家目录下的 .gradle"),
                                               (str(writable), "系统临时目录")])
        check("第一个候选不可写时跳到下一个可写的", picked2["home"] == str(writable), str(picked2["home"]))
        rejected = picked2["tried"][0]
        check("被拒的候选记下了**为什么**（这条会打印在报告里）",
              rejected["writable"] is False and "锁文件" in rejected["reason"] or "建不出目录" in rejected["reason"],
              str(rejected))
        check("环境变量 GRADLE_USER_HOME 排在最前（优先级）",
              pick_gradle_home(env={GRADLE_HOME_ENV: str(writable)})["home"] == str(writable))

        jdk = resolve_jdk(None, NEEDED_JDK)
        if jdk["home"] is None:
            print("  SKIP 本机没有可用的 JDK %s —— CLI 报告那一条没跑" % NEEDED_JDK)
        else:
            with tempfile.TemporaryDirectory(prefix="mcmod-gh2-") as tmp2:
                project, source = _fixture_project(Path(tmp2))
                done = _run_cli(project, source, jdk["home"], ["--fault"])
                out = (done.stdout or "") + (done.stderr or "")
                check("CLI 报告里写出了用了哪个 Gradle 家", "Gradle 家：" in out,
                      out.strip().splitlines()[-1][:160] if out.strip() else "(没有输出)")
                check("报告里那个家就是夹具给的那个，且真的可写",
                      str(Path(project) / "gradle-home") in out and dir_writable(Path(project) / "gradle-home")[0],
                      "chosen-in-output=%s" % (str(Path(project) / "gradle-home") in out))
                seen = (project / "gradle-home-seen.txt")
                seen_text = seen.read_text(encoding="utf-8", errors="replace").strip() if seen.is_file() else ""
                check("GRADLE_USER_HOME 真的传到了子进程（假 gradlew 抄下来的就是那个家）",
                      Path(seen_text) == Path(project) / "gradle-home",
                      "子进程看到：%r；期望：%r" % (seen_text, str(Path(project) / "gradle-home")))

    print("全部通过" if state["failures"] == 0 else "%d 项失败" % state["failures"])
    return 1 if state["failures"] else 0


def gradle_command(platform_name: str | None = None, project: str | None = None):
    """The wrapper for this OS, as something that actually starts.

    Windows has no `./gradlew`: it ships **`gradlew.bat`**.  And a `.bat` cannot be
    handed to `CreateProcess` directly -- `subprocess.run(["gradlew.bat", ...])` dies
    with `FileNotFoundError: [WinError 2]` (measured on this machine; the old code
    did exactly that, so `mcmod_gametest.py` could never run on native Windows).
    Batch files have to go through `cmd.exe`.

    **Why this returns a STRING on Windows (D3, measured on the user's own project).**
    The first fix built the argv list with `subprocess.list2cmdline([wrapper, *args])`
    as ONE element.  `subprocess` saw an element containing spaces, quoted it again,
    and cmd got a literal `\\"...\\"`; `/s` only strips the outermost pair, so the run
    died with
        '"C:\\...\\Release 2.8.3\\...\\gradlew.bat"' is not recognized ...
    exit code 1, stage "unknown" -- i.e. it looked like a Gradle failure, not a quoting
    bug.  We never noticed because every earlier measurement ran on the example project,
    whose path has no spaces.  So: build the **whole command line** and give it to the
    shell (`shell=True` in `run_gradle`), never as a single argv element.

    `platform_name` exists so a self-check can ask for the other platform's answer
    without being on it (`gradle_command("nt")` must mention gradlew.bat) -- an
    unverifiable branch is how "it works on my machine" gets shipped.
    """
    windows = (os.name == "nt") if platform_name is None else (platform_name == "nt")
    args = [GRADLE_TASK, "--no-daemon", "--console=plain"]
    if not windows:
        return ["./gradlew", *args]
    wrapper = "gradlew.bat" if project is None else os.path.join(project, "gradlew.bat")
    # 一条**命令行字符串**（wrapper 加引号 + 参数用 list2cmdline 拼好），交给 cmd.exe。
    return '"%s" %s' % (wrapper, subprocess.list2cmdline(args))


# ---------------------------------------------------------------------------
# Gradle 家（D4）。默认的 `~/.gradle` 在某些身份下**只有 ReadAndExecute**：
# wrapper 建 `.lck` 就被拒（Lead 实测：`C:\Users\<user>\.gradle` 不可写，可写的是另一个
# 工程外的目录）。**`-g` 补救不了**：`gradlew.bat` 的 CommandLineParser 遇到第一个位置参数
# 就停，`-g` 只有放在任务名之前才会被解析 —— 所以只能靠 `GRADLE_USER_HOME` 环境变量。
# 判定器因此自己选家：探测 + **可写自检**（真建一个锁文件再删），并在报告里说清用了哪个、
# 以及默认那个为什么被拒。
# ---------------------------------------------------------------------------

GRADLE_HOME_ENV = "GRADLE_USER_HOME"


def gradle_home_candidates(env=None, home=None) -> list:
    """`[(path, 为什么在候选里)]`，顺序就是优先级。"""
    env = os.environ if env is None else env
    base = Path(home) if home is not None else Path.home()
    out = []
    if env.get(GRADLE_HOME_ENV):
        out.append((env[GRADLE_HOME_ENV], "环境变量 %s" % GRADLE_HOME_ENV))
    out.append((str(base / ".gradle"), "默认：用户家目录下的 .gradle"))
    local = env.get("LOCALAPPDATA")
    if local:
        out.append((str(Path(local) / "gradle"), "LOCALAPPDATA 下的 gradle"))
    out.append((str(Path(tempfile.gettempdir()) / "mcmod-gradle-home"), "系统临时目录"))
    return out


def dir_writable(path) -> tuple:
    """`(可写?, 理由)` —— **真的去建一个锁文件再删掉**。

    为什么不用 `os.chmod`：Windows 上 `os.chmod(dir, 0o500)` **根本管不住**写权限
    （本仓库为这件事栽过一次，见 check_jdk_test.py 的历史）。能写出 `.lck` 才说明
    wrapper 能起来，所以要照 wrapper 的真实动作来探。
    """
    path = Path(path)
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        return False, "建不出目录：%s" % exc
    probe = path / ".mcmod-write-probe.lck"
    try:
        probe.write_bytes(b"probe")
        probe.unlink()
    except OSError as exc:
        return False, "建不了锁文件（wrapper 会被同样拒绝）：%s" % exc
    return True, "可写（建锁文件成功）"


def pick_gradle_home(explicit=None, env=None, candidates=None) -> dict:
    """`{home, why, tried}` —— 选一个**真的可写**的 Gradle 家。没有可写的就返回 home=None。"""
    listed = list(candidates if candidates is not None else gradle_home_candidates(env=env))
    if explicit:
        listed.insert(0, (str(explicit), "--gradle-home"))
    tried = []
    for path, why in listed:
        ok, reason = dir_writable(path)
        tried.append({"home": str(path), "why": why, "writable": ok, "reason": reason})
        if ok:
            return {"home": str(path), "why": why, "tried": tried}
    return {"home": None, "why": "候选里没有一个可写", "tried": tried}


def run_gradle(project: Path, log: Path, timeout: int, jdk_home: str | None = None,
               gradle_home: str | None = None) -> tuple:
    """One `runGameTestServer`, its exit code, and the log text.

    `jdk_home` is not decoration: Gradle picks up whatever `java` it finds, and on a
    normal Windows box that is Java 21 -- which cannot build 1.18.2.  The resolved
    JDK is handed over as JAVA_HOME **and** put first on PATH, so both the launcher
    and every forked toolchain use it.

    `gradle_home` goes in as `GRADLE_USER_HOME` (D4) -- see `pick_gradle_home`.
    """
    env = dict(os.environ)
    if jdk_home:
        env["JAVA_HOME"] = jdk_home
        env["PATH"] = os.path.join(jdk_home, "bin") + os.pathsep + env.get("PATH", "")
    if gradle_home:
        env[GRADLE_HOME_ENV] = str(gradle_home)
    env["GRADLE_OPTS"] = PROXY
    env["JAVA_TOOL_OPTIONS"] = ""
    command = gradle_command(project=str(project))
    shell = isinstance(command, str)          # Windows：整条命令行交给 cmd.exe
    log.parent.mkdir(parents=True, exist_ok=True)
    started = time.time()
    with open(log, "wb") as handle:
        shown = command if shell else " ".join(command)
        handle.write(("$ %s\n" % shown).encode("utf-8"))
        handle.flush()
        try:
            done = subprocess.run(command, shell=shell, cwd=str(project), env=env,
                                  stdout=handle, stderr=subprocess.STDOUT, timeout=timeout)
            code = done.returncode
        except subprocess.TimeoutExpired:
            handle.write(b"\n[timeout] gradlew exceeded %d seconds\n" % timeout)
            code = -1
    text = log.read_text(encoding="utf-8", errors="replace")
    print("gradlew 退出码 %d，用时 %.1f 秒，日志 %s" % (code, time.time() - started, log))
    return code, text


# The log format, pinned to a REAL run rather than to a guess (the first version
# of this parser looked for "<name> passed", which never appears: successes are
# only counted, failures are named):
#
#   [..] [minecraft/GameTestBatchRunner]: Running test batch 'defaultBatch:1' (2 tests)...
#   [..] [minecraft/LogTestReporter]: exampleBlockPlaces failed! <message> at 1,-59,1 (relative: 1,1,1) (t=0)
#   [..] [minecraft/GameTestServer]: All 2 required tests passed :)
#   [..] [minecraft/GameTestServer]: 1 required tests failed :(
BATCH_LINE = re.compile(r"Running test batch '([^']+)' \((\d+) tests?\)")
PASSED_LINE = re.compile(r"All (\d+) required tests passed")
FAILED_LINE = re.compile(r"(\d+) required tests failed")
# `... [minecraft/LogTestReporter]: <name> failed! <message> at <x,y,z> (relative: ..)`
# -- note the `]: `, which the first version of this pattern missed.
FAILED_TEST = re.compile(r":\s*([A-Za-z0-9_$.]+) failed!\s*(.*?)(?:\s+at\s+(-?\d+,-?\d+,-?\d+)|$)")


def read_log(text: str) -> dict:
    batches = []
    failures = []
    passed_count = None
    failed_count = None
    for line in text.splitlines():
        hit = BATCH_LINE.search(line)
        if hit is not None:
            batches.append({"batch": hit.group(1), "tests": int(hit.group(2))})
            continue
        hit = FAILED_TEST.search(line)
        if hit is not None:
            failures.append({"name": hit.group(1), "message": hit.group(2).strip(),
                             "at": hit.group(3) or ""})
            continue
        hit = PASSED_LINE.search(line)
        if hit is not None:
            passed_count = int(hit.group(1))
            continue
        hit = FAILED_LINE.search(line)
        if hit is not None:
            failed_count = int(hit.group(1))
    return {"batches": batches, "testsRun": sum(b["tests"] for b in batches),
            "passedReported": passed_count, "failedReported": failed_count,
            "failures": failures}


def verdict(code: int, log: dict, text: str) -> dict:
    lower = text.lower()
    compiled = "compilejava failed" in lower or "compilation failed" in lower
    reported = log["passedReported"] if log["passedReported"] is not None else log["failedReported"]
    # "ran" needs EVIDENCE, not just a run: a compile failure exits 1 too, and
    # calling that "1 failed test" would be a lie of exactly the kind this
    # repository keeps catching.
    ran = (not compiled) and (reported is not None or bool(log["batches"]))
    if compiled:
        stage = "compile"
    elif ran:
        stage = "ran"
    else:
        stage = "unknown"
    count = log["failedReported"] if log["failedReported"] is not None else 0
    # The exit code is documented as the failed-required-test count.  Checking the
    # log against it is what catches `forceExit` (or anything else) quietly turning
    # that number into a 0.
    matches = None if stage != "ran" else (code == count)
    notes = []
    if stage == "compile":
        notes.append("编译就没过：这个 1 是 Gradle 的失败码，不是失败的测试数")
    if code == 0 and stage != "ran":
        notes.append("退出码 0，但日志里没有测试跑过的证据 ← 不能算通过")
    if matches is False:
        notes.append("退出码(%d)和日志里报的失败数(%d)对不上 ← 有人把退出码抹平了" % (code, count))
    return {
        "ok": code == 0 and stage == "ran" and matches is not False,
        "stage": stage,
        "exitCode": code,
        "failedRequired": count if stage == "ran" else None,
        "exitCodeMatchesLog": matches,
        "testsRun": log["testsRun"],
        "batches": log["batches"],
        "failedNames": [f["name"] for f in log["failures"]],
        "failures": log["failures"],
        "note": "；".join(notes),
    }


def _fake_subprocess_run(table):
    """A `subprocess.run` stand-in: answer `javac -version` per executable path."""
    calls = []

    def run(command, **_kwargs):
        exe = str(command[0])
        calls.append(exe)
        reply = table.get(exe)

        class Done:
            returncode = 1
            stdout = ""
            stderr = "找不到这个命令"

        done = Done()
        if reply is not None:
            done.returncode = 0
            done.stdout = reply
            done.stderr = ""
        return done

    return run, calls


def jdk_selftest(fault: bool = False) -> int:
    """The JDK picker must really run javac -- prove it, including a red one.

    `--jdk-selftest --fault` runs the OLD judgement ("bin/javac exists?") over the same
    answers and requires it to pick the **wrong** JDK, so "the version probe is what
    makes this work" is demonstrated instead of asserted.
    """
    failures = 0

    def check(label, ok, detail=""):
        nonlocal failures
        if not ok:
            failures += 1
        print("  " + ("OK  " if ok else "FAIL") + " " + label + ("" if ok or not detail else "  -> " + detail))

    jdk21 = Path("C:/fake/java/jdk-21")
    jdk17 = Path("C:/fake/tools/jdk-17.0.8")
    javac21, javac17 = str(java_exe(jdk21, "javac")), str(java_exe(jdk17, "javac"))
    table = {javac21: "javac 21.0.7\n", javac17: "javac 17.0.8\n"}
    env = {"JAVA_HOME": str(jdk21), "JDK17_HOME": str(jdk17)}

    # Old judgement: "does this directory have bin/javac?" -- nothing about the version.
    legacy_exists = {str(jdk21): True, str(jdk17): True}
    legacy_pick = None
    for home in (jdk21, jdk17):
        if legacy_exists.get(str(home)):
            legacy_pick = home
            break

    if fault:
        print("--- A/B：老判据（只看 bin/javac 在不在）在同样答复下会不会选错")
        check("老判据选中 Java 21（1.18.2 用它会编译失败）", legacy_pick == jdk21, str(legacy_pick))
        run, _calls = _fake_subprocess_run(table)
        new = resolve_jdk(None, needed="17", env=env, run=run, verify=None,
                          is_file=lambda _p: True, is_dir=lambda _p: False)
        check("同一组答复下新判据选中 javac 17（这就是差别）", new["home"] == str(jdk17), str(new["home"]))
        print("全部通过（对照成立：老判据确实会选错）" if failures == 0 else "%d 项失败" % failures)
        return 1 if failures else 0

    print("--- 伪造 JDK 目录")
    nt = gradle_command("nt", project="X:\\proj")
    posix = gradle_command("posix")
    # D3 之后 Windows 侧返回的是**一条命令行字符串**（交给 shell），不是 argv：
    # argv 形态下 `list2cmdline` 的结果会被 subprocess 再包一层引号，含空格的工程路径就起不动。
    check("Windows 用 gradlew.bat，且返回的是**交给 shell 的一条命令行字符串**（不是 argv —— argv 会二次加引号）",
          isinstance(nt, str) and nt.startswith('"') and "gradlew.bat" in nt, str(nt))
    check("Windows 那条命令行里 wrapper 是**带引号**的（含空格的工程路径靠它）",
          nt.split(" ")[0].startswith('"') and nt.split(" ")[0].endswith('"'), str(nt))
    check("POSIX 仍然直接跑 ./gradlew（argv，不经 shell）", posix[0] == "./gradlew", str(posix))
    run, _calls = _fake_subprocess_run(table)
    result = resolve_jdk(None, needed="17", env=env, run=run, verify=None,
                         is_file=lambda _p: True, is_dir=lambda _p: False)
    check("JAVA_HOME 里的 javac 21 被拒（1.18.2 要 JDK 17）",
          result["tried"][0]["home"] == str(jdk21) and result["tried"][0]["major"] == "21",
          str(result["tried"][:1]))
    check("继续找到 javac 17 的那一份（真的跑了 javac -version）",
          result["home"] == str(jdk17) and result["major"] == "17", str(result))

    run_none, _ = _fake_subprocess_run({})
    empty = resolve_jdk(None, needed="17", env={"JAVA_HOME": str(jdk21)}, run=run_none, verify=None,
                        is_file=lambda _p: True, is_dir=lambda _p: False)
    check("一份都对不上时：home 为空，并且逐条记下试过谁、为什么不行",
          empty["home"] is None and len(empty["tried"]) >= 1 and all(item["reason"] for item in empty["tried"]),
          str(empty))

    # 真机器：本机默认 java 是 21，必须能找到一份 17 —— 但**机器上没有 JDK 17 不是代码缺陷**，
    # 那种情况要 SKIP 而不是 FAIL（体例同 orient-test.js）。先用**共享候选表**看本机有没有 17。
    present17 = [home for home, _origin in jdk_env.jdk_homes(None)
                 if jdk_env.jdk_major(home)[0] == NEEDED_JDK]
    if not present17:
        print("  SKIP 这台机器上没有任何 javac %s 的候选（%d 个候选目录里一个都不是）——"
              "机器问题，不是代码缺陷；夹具那几条已经在上面跑了" % (NEEDED_JDK, len(jdk_env.jdk_homes(None))))
    else:
        real = resolve_jdk(os.environ.get("MCART_JAVA_HOME") or None, needed=NEEDED_JDK)
        check("真实机器上找到一份 javac %s 的 JDK，并且它的 java 真能启动" % NEEDED_JDK,
              real["home"] is not None,
              "；".join("%s → %s" % (item["home"], item["reason"]) for item in real["tried"][:6]))
        if real["home"]:
            print("       选中 %s（%s）" % (real["home"], real["reason"]))
        for item in real["tried"]:
            if item["home"] != real["home"]:
                print("       拒绝 %s → %s" % (item["home"], item["reason"]))

    print("全部通过" if failures == 0 else "%d 项失败" % failures)
    return 1 if failures else 0


def fault_exit_code(caught: bool) -> int:
    """`--fault` 的判决：**没抓到就非 0**（D2）。

    老实现是 `0 if (result["ok"] or args.fault) else 1` —— 只要带了 `--fault` 就恒为 0，
    于是"没抓到故障"（也就是这个检查本身是空的）也会报成功。抓不到错的检查不算检查。

    返回：0 = 抓到了故障；4 = 没抓到（与"判定没通过"的 1 区分开，调用方一眼能分辨）。
    """
    return 0 if caught else 4


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--project", default=str(DEFAULT_PROJECT),
                        help="Forge 工程目录（默认：仓库里的示例工程，或 MCMOD_PROJECT）")
    parser.add_argument("--log", default="")
    parser.add_argument("--json", default="")
    parser.add_argument("--timeout", type=int, default=3600)
    parser.add_argument("--fault", action="store_true",
                        help="inject a false assertion, require a non-zero exit, restore the file")
    parser.add_argument("--tail", type=int, default=25, help="how many log lines to echo")
    parser.add_argument("--java-home", default=None,
                        help="JDK to build with (1.18.2 needs 17); default: probe JAVA_HOME and the usual places")
    parser.add_argument("--needed", default=NEEDED_JDK, help="required javac major version (default 17)")
    parser.add_argument("--test-source", default="", help="the GameTests source --fault rewrites (default: searched under the project)")
    # D1：注入点不再写死。默认值只服务示例工程；**别的工程必须自己给**（否则会逼着别人
    # 在源码里逐字写出示例工程的符号 —— 为了配合工具去污染被测对象）。
    parser.add_argument("--fault-find", default=FAULT_FIND,
                        help="--fault 要改的那一句（默认：示例工程那句；**你的工程请自己给**）")
    parser.add_argument("--fault-replace", default=FAULT_REPLACE,
                        help="--fault 把它换成什么（默认：换成 DIRT 断言）")
    # D4：Gradle 家。默认 ~/.gradle 在某些身份下不可写；-g 补救不了（wrapper 的
    # CommandLineParser 遇到第一个位置参数就停），所以只能靠这个显式入口/环境变量。
    parser.add_argument("--gradle-home", default=None,
                        help="GRADLE_USER_HOME（默认：探测到第一个**真的可写**的家，报告里会说清是哪个、为什么）")
    parser.add_argument("--jdk-selftest", action="store_true",
                        help="only test the JDK picker (with --fault: prove the old judgement picks the wrong JDK)")
    parser.add_argument("--restore-selftest", action="store_true",
                        help="only test the --fault contract: inject then restore must leave the tree byte-identical "
                             "(with --fault: prove a text-mode restore DOES dirty it)")
    parser.add_argument("--space-selftest", action="store_true",
                        help="D3：含空格的工程路径上 wrapper 必须真的被启动（with --fault: the old argv form must fail)")
    parser.add_argument("--fault-args-selftest", action="store_true",
                        help="D1：--fault-find/--fault-replace 给了就用给定的，没给就用兼容默认")
    parser.add_argument("--fault-verdict-selftest", action="store_true",
                        help="D2：--fault 没抓到故障必须非 0")
    parser.add_argument("--gradle-home-selftest", action="store_true",
                        help="D4：选出的 Gradle 家必须真的可写，并打印是哪个、为什么")
    args = parser.parse_args(argv)

    if args.jdk_selftest:
        print("--- JDK 选择自测" + ("（--fault：对照老判据）" if args.fault else ""))
        return jdk_selftest(args.fault)

    if args.restore_selftest:
        print("--- --fault「还原」契约自测" + ("（--fault：反向夹具）" if args.fault else ""))
        return restore_selftest(args.fault)

    if args.space_selftest:
        print("--- D3 含空格工程路径自测" + ("（--fault：反向夹具）" if args.fault else ""))
        return space_selftest(args.fault)

    if args.fault_args_selftest:
        print("--- D1 注入点可配置自测" + ("（--fault：反向夹具）" if args.fault else ""))
        return fault_args_selftest(args.fault)

    if args.fault_verdict_selftest:
        print("--- D2 --fault 判定自测" + ("（--fault：反向夹具）" if args.fault else ""))
        return fault_verdict_selftest(args.fault)

    if args.gradle_home_selftest:
        print("--- D4 Gradle 家自测" + ("（--fault：反向夹具）" if args.fault else ""))
        return gradle_home_selftest(args.fault)

    # The JDK comes first: with the wrong one, Gradle fails 26 minutes in, and a
    # 1.18.2 project cannot be built by the Java 21 that `java` usually resolves to.
    jdk = resolve_jdk(args.java_home, args.needed)
    if jdk["home"] is None:
        print("找不到能用的 JDK %s（要求：bin/javac 真的存在，且 `javac -version` 报的 major 正好是 %s）。试过："
              % (args.needed, args.needed))
        for item in jdk["tried"][:20]:
            print("  - %s  [%s]" % (item["home"], item["reason"]))
        print("装一个普通 JDK %s，或用 --java-home <目录> / JAVA_HOME 指给我。" % args.needed)
        return 3
    print("JDK %s：%s（%s，真跑过 javac）" % (args.needed, jdk["home"], jdk["reason"]))

    project = Path(args.project).resolve()
    if not project.is_dir():
        print("工程目录不存在：%s（用 --project 指一个 Forge 工程目录；不指就用仓库里的示例工程）" % project,
              file=sys.stderr)
        return 2
    log = Path(args.log) if args.log else project / "build" / "gametest.log"
    if args.test_source:
        source = Path(args.test_source).resolve()
    else:
        found = sorted(project.glob("src/main/java/**/*GameTests.java"))
        source = found[0] if found else project / "src/main/java/com/examplemod/ExampleGameTests.java"

    restore = None
    if args.fault:
        if not source.is_file():
            print("注入失败：找不到测试源码 %s（用 --test-source 指给它）" % source, file=sys.stderr)
            return 2
        try:
            restore = inject_fault_file(source, args.fault_find, args.fault_replace)
        except LookupError as missing:
            print("注入失败：测试源码里找不到要改的那句：\n  " + str(missing), file=sys.stderr)
            print("用 --fault-find <你工程里那句断言> 指给它（--fault-replace 指定替换成什么）。"
                  "\n默认那句是**示例工程**的，别的工程必须自己给 —— 工具不该逼你在源码里"
                  "写出示例工程的符号。", file=sys.stderr)
            return 2
        print("已注入故障：\n  改  %s\n  成  %s" % (args.fault_find, args.fault_replace))

    # D4：先选一个**真的可写**的 Gradle 家（默认的 ~/.gradle 在某些身份下只有 ReadAndExecute，
    # wrapper 建 .lck 就被拒；`-g` 补救不了，只能靠环境变量）。选了就要说清是哪个、为什么。
    gradle_home = pick_gradle_home(args.gradle_home)
    if gradle_home["home"] is None:
        print("找不到可写的 Gradle 家（候选都写不进去）。试过：", file=sys.stderr)
        for item in gradle_home["tried"]:
            print("  - %s  [%s] → %s" % (item["home"], item["why"], item["reason"]), file=sys.stderr)
        print("用 --gradle-home <目录> 指一个可写目录，或设 GRADLE_USER_HOME。", file=sys.stderr)
        return 3
    print("Gradle 家：%s（%s；可写自检＝真建了一个锁文件）" % (gradle_home["home"], gradle_home["why"]))
    for item in gradle_home["tried"]:
        if item["home"] != gradle_home["home"]:
            print("  拒绝 %s [%s] → %s" % (item["home"], item["why"], item["reason"]))

    try:
        code, text = run_gradle(project, log, args.timeout, jdk_home=jdk["home"],
                               gradle_home=gradle_home["home"])
    finally:
        if restore is not None:
            restore()
            print("已把测试源码原样放回（按字节，行尾不变）")

    log = read_log(text)
    result = verdict(code, log, text)
    for batch in log["batches"]:
        print("  批次 %s：%d 条测试" % (batch["batch"], batch["tests"]))
    for failure in log["failures"]:
        print("  失败 %s：%s %s" % (failure["name"], failure["message"], failure["at"]))
    if log["passedReported"] is not None:
        print("  服务端说：%d 条必要测试全部通过" % log["passedReported"])
    if log["failedReported"] is not None:
        print("  服务端说：%d 条必要测试失败" % log["failedReported"])
    print("日志末尾：")
    for line in text.splitlines()[-args.tail:]:
        print("  | " + line)

    if args.fault:
        # The judge must say NO to a wrong mod.  An exit code of 0 here would mean
        # the loop is decorative.
        caught = code != 0
        print("注入结果：" + ("抓到了（gradlew 退出码 %d）" % code if caught else "没抓到 ← 这个闭环是摆设"))
        result["faultCaught"] = caught
        print("（工具自身的退出码**不携带判决** —— 判决看 gradlew 的退出码；这里非 0 只表示"
              "「没抓到故障」，也就是这个检查是空的。）")
    else:
        print("判定：" + ("通过（退出码 0，阶段 %s）" % result["stage"] if result["ok"]
                        else "没通过（阶段 %s，退出码 %d）" % (result["stage"], code)))
    if result["note"]:
        print("注意：" + result["note"])

    if args.json:
        Path(args.json).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n",
                                   encoding="utf-8")
        print("机器可读结果：%s" % args.json)
    if args.fault:
        # D2：以前是 `0 if (result["ok"] or args.fault) else 1` —— 带了 --fault 就恒为 0，
        # 于是"没抓到"也报成功。现在没抓到返回 4（见 fault_exit_code）。
        verdict_code = fault_exit_code(result.get("faultCaught", False))
        if verdict_code != 0:
            print("没抓到注入的故障 → 退出码 %d（这不是「判定没通过」，是「这个检查是空的」）" % verdict_code)
        return verdict_code
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
