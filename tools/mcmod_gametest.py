#!/usr/bin/env python3
"""Run a Forge mod's GameTestServer and turn it into a verdict we can trust.

WHY THIS IS THE JUDGE.  `GameTestServer` is Mojang's own special dedicated server:
it runs every registered game test and then EXITS, and **the exit code is the
number of failed required tests** (Forge documents this, and it is why the whole
thing is CI-friendly).  So "did the mod do what it claims" is not my opinion and
not a screenshot -- it is a number the game itself produced.

  python3 tools/mcmod_gametest.py                 # run, print the verdict
  python3 tools/mcmod_gametest.py --fault         # prove the judge can fail
  python3 tools/mcmod_gametest.py --json OUT      # machine-readable result

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
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
DEFAULT_PROJECT = REPO / "fleshland" / "mod"
GRADLE_TASK = "runGameTestServer"
PROXY = ("-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=7897 "
         "-Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=7897")

# The line the fault injection rewrites.  Kept as one exact string so a rename in
# the test makes this tool fail loudly instead of quietly injecting nothing.
FAULT_FIND = "state -> state.is(FleshlandMod.FLESH_BLOCK.get())"
FAULT_REPLACE = "state -> state.is(net.minecraft.world.level.block.Blocks.DIRT)"


def run_gradle(project: Path, log: Path, timeout: int) -> tuple[int, str]:
    """One `runGameTestServer`, its exit code, and the log text."""
    env = dict(os.environ)
    env["GRADLE_OPTS"] = PROXY
    env["JAVA_TOOL_OPTIONS"] = ""
    command = ["./gradlew", GRADLE_TASK, "--no-daemon", "--console=plain"]
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
#   [..] [minecraft/LogTestReporter]: fleshblockplaces failed! <message> at 1,-59,1 (relative: 1,1,1) (t=0)
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


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--project", default=str(DEFAULT_PROJECT))
    parser.add_argument("--log", default="")
    parser.add_argument("--json", default="")
    parser.add_argument("--timeout", type=int, default=3600)
    parser.add_argument("--fault", action="store_true",
                        help="inject a false assertion, require a non-zero exit, restore the file")
    parser.add_argument("--tail", type=int, default=25, help="how many log lines to echo")
    args = parser.parse_args(argv)

    project = Path(args.project).resolve()
    log = Path(args.log) if args.log else project / "build" / "gametest.log"
    source = project / "src/main/java/com/fleshland/FleshlandGameTests.java"

    backup = None
    if args.fault:
        original = source.read_text(encoding="utf-8")
        if FAULT_FIND not in original:
            print("注入失败：测试源码里找不到要改的那句：\n  " + FAULT_FIND, file=sys.stderr)
            return 2
        backup = original
        source.write_text(original.replace(FAULT_FIND, FAULT_REPLACE), encoding="utf-8")
        print("已注入故障：断言改成 DIRT（血肉块不该通过）")

    try:
        code, text = run_gradle(project, log, args.timeout)
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
