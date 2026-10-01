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
FAULT_FIND = "state -> state.is(ExampleMod.EXAMPLE_BLOCK.get())"
FAULT_REPLACE = "state -> state.is(net.minecraft.world.level.block.Blocks.DIRT)"


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


def inject_fault_file(source: Path):
    """把断言改成 DIRT，返回一个**按字节**还原的可调用对象。

    WHY BYTES.  `--fault` 的契约是"注入 → 必须红 → **还原**"。老实现用
    `read_text()` / `write_text()`，那是**文本模式**：Windows 上 `write_text` 会把 `\\n`
    展开成 `\\r\\n`。于是跑完一次故障注入，`git diff` 是空的、`git status` 却永远脏，还伴随
    `warning: CRLF will be replaced by LF in …ExampleGameTests.java`（Lead 实测）。
    在这个仓库里这很致命：任何人 `git add -A` 都会把一次行尾变更带进提交，而"看起来像改了代码"
    的 diff 会让 review 失效 —— `.gitattributes` 正是把 `*.java` 钉成 LF 的。

    所以注入前按二进制读、还原时按二进制写：内容与行尾都逐字节回到原样。
    """
    original = source.read_bytes()
    text = original.decode("utf-8")
    if FAULT_FIND not in text:
        raise LookupError(FAULT_FIND)
    source.write_bytes(text.replace(FAULT_FIND, FAULT_REPLACE).encode("utf-8"))
    return lambda: source.write_bytes(original)


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


def gradle_command(platform_name: str | None = None, project: str | None = None) -> list[str]:
    """The wrapper for this OS, as an argv that actually starts.

    Windows has no `./gradlew`: it ships **`gradlew.bat`**.  And a `.bat` cannot be
    handed to `CreateProcess` directly -- `subprocess.run(["gradlew.bat", ...])` dies
    with `FileNotFoundError: [WinError 2]` (measured on this machine; the old code
    did exactly that, so `mcmod_gametest.py` could never run on native Windows).
    Batch files have to go through `cmd.exe /d /s /c`.

    `platform_name` exists so a self-check can ask for the other platform's answer
    without being on it (`gradle_command("nt")` must mention gradlew.bat) -- an
    unverifiable branch is how "it works on my machine" gets shipped.
    """
    windows = (os.name == "nt") if platform_name is None else (platform_name == "nt")
    args = [GRADLE_TASK, "--no-daemon", "--console=plain"]
    if not windows:
        return ["./gradlew", *args]
    wrapper = "gradlew.bat" if project is None else os.path.join(project, "gradlew.bat")
    return [os.environ.get("ComSpec", "cmd.exe"), "/d", "/s", "/c",
            subprocess.list2cmdline([wrapper, *args])]


def run_gradle(project: Path, log: Path, timeout: int, jdk_home: str | None = None) -> tuple[int, str]:
    """One `runGameTestServer`, its exit code, and the log text.

    `jdk_home` is not decoration: Gradle picks up whatever `java` it finds, and on a
    normal Windows box that is Java 21 -- which cannot build 1.18.2.  The resolved
    JDK is handed over as JAVA_HOME **and** put first on PATH, so both the launcher
    and every forked toolchain use it.
    """
    env = dict(os.environ)
    if jdk_home:
        env["JAVA_HOME"] = jdk_home
        env["PATH"] = os.path.join(jdk_home, "bin") + os.pathsep + env.get("PATH", "")
    env["GRADLE_OPTS"] = PROXY
    env["JAVA_TOOL_OPTIONS"] = ""
    command = gradle_command(project=str(project))
    log.parent.mkdir(parents=True, exist_ok=True)
    started = time.time()
    with open(log, "wb") as handle:
        handle.write(("$ %s\n" % " ".join(command)).encode("utf-8"))
        handle.flush()
        try:
            done = subprocess.run(command, cwd=str(project), env=env,
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
    check("Windows 用 gradlew.bat，而且经 cmd.exe 执行（.bat 不能被 CreateProcess 直接跑）",
          "gradlew.bat" in " ".join(nt) and nt[0].lower().endswith(("cmd.exe", "cmd")), str(nt))
    check("POSIX 仍然直接跑 ./gradlew", posix[0] == "./gradlew", str(posix))
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
    parser.add_argument("--jdk-selftest", action="store_true",
                        help="only test the JDK picker (with --fault: prove the old judgement picks the wrong JDK)")
    parser.add_argument("--restore-selftest", action="store_true",
                        help="only test the --fault contract: inject then restore must leave the tree byte-identical "
                             "(with --fault: prove a text-mode restore DOES dirty it)")
    args = parser.parse_args(argv)

    if args.jdk_selftest:
        print("--- JDK 选择自测" + ("（--fault：对照老判据）" if args.fault else ""))
        return jdk_selftest(args.fault)

    if args.restore_selftest:
        print("--- --fault「还原」契约自测" + ("（--fault：反向夹具）" if args.fault else ""))
        return restore_selftest(args.fault)

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
            restore = inject_fault_file(source)
        except LookupError:
            print("注入失败：测试源码里找不到要改的那句：\n  " + FAULT_FIND, file=sys.stderr)
            return 2
        print("已注入故障：断言改成 DIRT（示例块不该通过）")

    try:
        code, text = run_gradle(project, log, args.timeout, jdk_home=jdk["home"])
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
        print("注入结果：" + ("抓到了（退出码 %d）" % code if caught else "没抓到 ← 这个闭环是摆设"))
        result["faultCaught"] = caught
    else:
        print("判定：" + ("通过（退出码 0，阶段 %s）" % result["stage"] if result["ok"]
                        else "没通过（阶段 %s，退出码 %d）" % (result["stage"], code)))
    if result["note"]:
        print("注意：" + result["note"])

    if args.json:
        Path(args.json).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n",
                                   encoding="utf-8")
        print("机器可读结果：%s" % args.json)
    return 0 if (result["ok"] or args.fault) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
