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
import glob
import json
import os
import re
import shutil
import subprocess
import sys
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
PROXY = ("-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=7897 "
         "-Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=7897")

# The line the fault injection rewrites.  Kept as one exact string so a rename in
# the test makes this tool fail loudly instead of quietly injecting nothing.
FAULT_FIND = "state -> state.is(ExampleMod.EXAMPLE_BLOCK.get())"
FAULT_REPLACE = "state -> state.is(net.minecraft.world.level.block.Blocks.DIRT)"


def java_exe(home: Path, name: str) -> Path:
    suffix = ".exe" if os.name == "nt" else ""
    return Path(home) / "bin" / (name + suffix)


def jdk_major(home, run=subprocess.run, is_file=os.path.isfile, timeout: int = 60):
    """Does this directory hold a JDK, and which major version?  **Really runs it.**

    Returns `(major, reason)`.  Never trusts the directory name: `jdk17-nameless`
    can be anything, and `C:\\Program Files\\Java\\jdk-21` is a perfectly valid name
    for the WRONG compiler (1.18.2 cannot be built with 21).
    """
    javac = java_exe(home, "javac")
    if not is_file(str(javac)):
        return None, "没有 javac（不是 JDK）"
    try:
        done = run([str(javac), "-version"], capture_output=True, text=True, timeout=timeout)
    except Exception as exc:  # noqa: BLE001
        return None, "javac 跑不起来：%s" % exc
    text = (done.stdout or "") + (done.stderr or "")
    match = re.search(r"javac\s+(\d+)", text)
    if not match:
        return None, "javac -version 的输出认不出：%s" % text.strip().splitlines()[:1]
    return match.group(1), "javac %s" % match.group(1)


def jdk_homes(explicit, env=None, is_dir=os.path.isdir):
    """Plausible JDK homes, best first.  Explicit / JAVA_HOME, then the usual places.

    Deliberately generic: whoever runs this has their JDK somewhere ordinary
    (Program Files, `~/.jdks` from IntelliJ, `~/tools`, a package manager).  Nothing
    here is this author's machine -- pass `--java-home` for anything unusual.
    """
    env = os.environ if env is None else env
    home_dir = env.get("USERPROFILE") or env.get("HOME") or ""
    out = []

    def push(value):
        if not value:
            return
        path = Path(value)
        key = str(path).lower()
        if key not in [str(Path(item)).lower() for item in out]:
            out.append(path)

    push(explicit)
    push(env.get("JAVA_HOME"))
    push(env.get("JDK%s_HOME" % NEEDED_JDK))
    bases = []
    if os.name == "nt":
        program_files = env.get("ProgramFiles") or env.get("ProgramFiles(x86)") or ""
        for name in ("Java", "Eclipse Adoptium", "Microsoft", "Zulu", "Amazon Corretto", "BellSoft", "AdoptOpenJDK"):
            bases.append(Path(program_files) / name)
        local = env.get("LOCALAPPDATA") or ""
        bases += [Path(local) / "Programs" / "Eclipse Adoptium", Path(local) / "Programs" / "Microsoft"]
        if home_dir:
            bases += [Path(home_dir) / ".jdks", Path(home_dir) / "tools",
                      Path(env.get("USERPROFILE", "")) / "scoop" / "apps"]
    else:
        bases += [Path("/usr/lib/jvm"), Path("/opt/java"), Path("/Library/Java/JavaVirtualMachines")]
        if home_dir:
            bases += [Path(home_dir) / ".jdks", Path(home_dir) / ".sdkman" / "candidates" / "java"]
    for base in bases:
        if not is_dir(str(base)):
            continue
        try:
            entries = sorted(base.iterdir())
        except OSError:
            continue
        for entry in entries:
            push(entry)
            push(entry / "Contents" / "Home")   # macOS bundles
    # A JDK unzipped somewhere: <home>/jdk*/bin/javac.
    if home_dir:
        for pattern in (os.path.join(home_dir, "jdk*"), os.path.join(home_dir, "tools", "jdk*"),
                        os.path.join(home_dir, "tools", "*jdk*")):
            for found in sorted(glob.glob(pattern)):
                push(found)
                push(Path(found) / "Contents" / "Home")
    return out


def resolve_jdk(explicit=None, needed=NEEDED_JDK, env=None, run=subprocess.run,
                is_file=os.path.isfile, is_dir=os.path.isdir):
    """`{home, major, reason, tried}` -- the first JDK whose javac major really matches."""
    tried = []
    for home in jdk_homes(explicit, env=env, is_dir=is_dir):
        major, reason = jdk_major(home, run=run, is_file=is_file)
        tried.append({"home": str(home), "major": major, "reason": reason})
        if major == str(needed):
            return {"home": str(home), "major": major, "reason": reason, "tried": tried}
    return {"home": None, "major": None, "reason": "", "tried": tried}


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
    jdk17 = Path("C:/fake/tools/jdk17-nameless")
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
        new = resolve_jdk(None, needed="17", env=env, run=run,
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
    result = resolve_jdk(None, needed="17", env=env, run=run, is_file=lambda _p: True, is_dir=lambda _p: False)
    check("JAVA_HOME 里的 javac 21 被拒（1.18.2 要 JDK 17）",
          result["tried"][0]["home"] == str(jdk21) and result["tried"][0]["major"] == "21",
          str(result["tried"][:1]))
    check("继续找到 javac 17 的那一份（真的跑了 javac -version）",
          result["home"] == str(jdk17) and result["major"] == "17", str(result))

    run_none, _ = _fake_subprocess_run({})
    empty = resolve_jdk(None, needed="17", env={"JAVA_HOME": str(jdk21)}, run=run_none,
                        is_file=lambda _p: True, is_dir=lambda _p: False)
    check("一份都对不上时：home 为空，并且逐条记下试过谁、为什么不行",
          empty["home"] is None and len(empty["tried"]) >= 1 and all(item["reason"] for item in empty["tried"]),
          str(empty))

    # 真机器：本机默认 java 是 21，必须能找到一份 17 才算过（找不到就红，不假装）。
    real = resolve_jdk(os.environ.get("MCART_JAVA_HOME") or None, needed=NEEDED_JDK)
    check("真实机器上找到一份 javac %s 的 JDK 并真跑过" % NEEDED_JDK, real["home"] is not None,
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
    args = parser.parse_args(argv)

    if args.jdk_selftest:
        print("--- JDK 选择自测" + ("（--fault：对照老判据）" if args.fault else ""))
        return jdk_selftest(args.fault)

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

    backup = None
    if args.fault:
        if not source.is_file():
            print("注入失败：找不到测试源码 %s（用 --test-source 指给它）" % source, file=sys.stderr)
            return 2
        original = source.read_text(encoding="utf-8")
        if FAULT_FIND not in original:
            print("注入失败：测试源码里找不到要改的那句：\n  " + FAULT_FIND, file=sys.stderr)
            return 2
        backup = original
        source.write_text(original.replace(FAULT_FIND, FAULT_REPLACE), encoding="utf-8")
        print("已注入故障：断言改成 DIRT（血肉块不该通过）")

    try:
        code, text = run_gradle(project, log, args.timeout, jdk_home=jdk["home"])
    finally:
        if backup is not None:
            source.write_text(backup, encoding="utf-8")
            print("已把测试源码原样放回")

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
