#!/usr/bin/env python3
"""Pick a JDK that can actually write a jar -- before Gradle wastes 26 minutes.

WHY THIS IS A SEPARATE STEP.  ForgeGradle's access-transformer step writes into a jar
through `jdk.zipfs`, and `jdk.zipfs` decides writability with `Files.isWritable()`.  A JVM
started from Mojang's bundled runtime (`...\\.minecraft\\runtime\\java-runtime-gamma-*`) runs
at **Low mandatory integrity** and answers `false` even for a file it just wrote itself, so
every jar looks read-only and the build dies with

    java.nio.file.ReadOnlyFileSystemException
        at jdk.nio.zipfs.ZipFileSystem.checkWritable

leaving a 22-byte empty jar behind.  Nothing about the JDK's version string predicts this,
so the check is behavioural: start each candidate and make it write a file and a zip.

  python3 scripts/check_jdk.py                    # resolve + self-test, print the verdict
  python3 scripts/check_jdk.py --java-home DIR    # trust this one (still self-tested)
  python3 scripts/check_jdk.py --probe-dir DIR    # write the probe files here instead
  python3 scripts/check_jdk.py --needed 21        # a different required version

Exit codes: 0 = a usable JDK was found, 3 = none was (the reasons are printed), 2 = usage.
ASCII only, stdlib only -- it has to run on a bare Windows box.
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SELF_TEST = HERE / "JvmWriteSelfTest.java"


def exe(home: Path, name: str) -> Path:
    return home / "bin" / (name + (".exe" if os.name == "nt" else ""))


def javac_major(home: Path) -> str | None:
    """This directory a JDK (javac) and which major version?"""
    javac = exe(home, "javac")
    if not javac.exists():
        return None
    try:
        out = subprocess.run([str(javac), "-version"], capture_output=True, text=True, timeout=60)
    except Exception:
        return None
    match = re.search(r"javac\s+(\d+)", (out.stdout or "") + (out.stderr or ""))
    return match.group(1) if match else None


def self_test(home: Path, probe_dir: Path) -> tuple[bool, str]:
    """Start THIS JVM and make it write a file and a zip."""
    java = exe(home, "java")
    if not java.exists() or not SELF_TEST.exists():
        return False, "缺少 java 或自检源码"
    probe_dir.mkdir(parents=True, exist_ok=True)
    try:
        out = subprocess.run([str(java), str(SELF_TEST), str(probe_dir)],
                             capture_output=True, text=True, timeout=180, cwd=str(HERE))
    except Exception as exc:  # noqa: BLE001
        return False, "自检跑不起来：%s" % exc
    lines = ((out.stdout or "") + (out.stderr or "")).strip().splitlines()
    # 取第一行：自检成功时它是 "SELFTEST OK…"，失败时是那条 ReadOnly/isWritable 说明。
    return out.returncode == 0, (lines[0] if lines else "exit=%s" % out.returncode)


def candidates(explicit: str | None, needed: str) -> list[tuple[Path, str]]:
    out: list[tuple[Path, str]] = []
    if explicit:
        out.append((Path(explicit), "--java-home"))
    if os.environ.get("JAVA_HOME"):
        out.append((Path(os.environ["JAVA_HOME"]), "JAVA_HOME"))
    # Mojang's runtime goes LAST and is labelled: it is the one that carries the Low
    # integrity label, so it usually fails the self-test.  Mentioning it in the failure
    # list is the whole point -- "looks like a JDK 17" is not the question.
    appdata = os.environ.get("APPDATA") or os.environ.get("HOME") or ""
    if appdata:
        runtime = Path(appdata) / ".minecraft" / "runtime"
        if runtime.is_dir():
            for child in sorted(runtime.iterdir()):
                out.append((child, "Mojang runtime (Low integrity label)"))
    for base in (r"C:\Program Files\Java", r"C:\Program Files\Eclipse Adoptium",
                 r"C:\Program Files\Microsoft", r"C:\Program Files\Zulu",
                 r"C:\Program Files\Amazon Corretto", r"C:\Program Files\BellSoft",
                 "/usr/lib/jvm", "/opt/java", "/Library/Java/JavaVirtualMachines"):
        directory = Path(base)
        if directory.is_dir():
            for child in sorted(directory.iterdir()):
                out.append((child, base))
    for name in ("JAVA_HOME_%s" % needed, "JDK%s_HOME" % needed):
        if os.environ.get(name):
            out.append((Path(os.environ[name]), name))
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="resolve a JDK that can write a jar")
    parser.add_argument("--java-home", default=None, help="explicit JDK home to try first")
    parser.add_argument("--needed", default="17", help="required javac major version (default 17)")
    parser.add_argument("--probe-dir", default=None, help="where the self-test writes (default: temp)")
    args = parser.parse_args(argv)
    probe = Path(args.probe_dir) if args.probe_dir else Path(os.environ.get("TEMP") or "/tmp") / "mcmod-jdk-selftest"

    tried: list[str] = []
    seen: set[str] = set()
    for home, origin in candidates(args.java_home, args.needed):
        key = str(home).lower()
        if key in seen:
            continue
        seen.add(key)
        major = javac_major(home)
        if major is None:
            tried.append("  - %s  [%s]  没有 javac（不是 JDK）" % (home, origin))
            continue
        if major != args.needed:
            tried.append("  - %s  [%s]  javac %s（需要 %s）" % (home, origin, major, args.needed))
            continue
        ok, detail = self_test(home, probe)
        if ok:
            print("JDK OK: %s  [%s]  javac %s" % (home, origin, major))
            print("  自检: %s" % detail)
            print("  用 --java-home 把它交给构建（或设 JAVA_HOME）")
            return 0
        hint = ""
        if "Mojang" in origin:
            hint = ("  <- 它带 Low 完整性标签：Files.isWritable 对自己刚写的文件都回 false，"
                    "jdk.zipfs 于是把 jar 当只读（ForgeGradle 的 AT 步骤就是这么挂的）")
        tried.append("  - %s  [%s]  是 JDK %s，但写入自检失败：%s%s" % (home, origin, major, detail, hint))

    print("找不到能用的 JDK %s（要求：有 javac，且启动的 JVM 能写文件与 jar）。试过：" % args.needed)
    print("\n".join(tried))
    print("")
    print("解决：装一个普通 JDK %s（Temurin / Microsoft / Oracle），" % args.needed)
    print("或把一份 JDK 复制到普通目录（被打了低完整性标签的目录里复制出来的副本继承 Medium），")
    print("再用 --java-home 指给我。**不要**用 Minecraft 自带的 runtime java 跑构建。")
    return 3


if __name__ == "__main__":
    sys.exit(main())
