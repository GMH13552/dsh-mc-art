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

  python scripts/check_jdk.py                    # resolve + self-test, print the verdict
  python scripts/check_jdk.py --java-home DIR    # trust this one (still self-tested)
  python scripts/check_jdk.py --probe-dir DIR    # write the probe files here instead
  python scripts/check_jdk.py --needed 21        # a different required version

On Windows the interpreter is usually `python` or `py -3`; `python3` is often a
zero-byte Store stub that exits 9009 with no output, and `py -3` may point at an
interpreter that no longer exists. Probe by running it, never by looking for the name.

Exit codes: 0 = a usable JDK was found, 3 = none was (the reasons are printed), 2 = usage.
ASCII only, stdlib only -- it has to run on a bare Windows box.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SELF_TEST = HERE / "JvmWriteSelfTest.java"

# 候选清单与 `javac -version` 判定只有**一份**实现（`jdk_env.py`），
# `tools/mcmod_gametest.py` 也 import 它。两份实现漂过一次：运行器找得到 `~/tools/jdk17-*`，
# 而这份随包的检查器不找 —— 同一台机器，结论相反，用户被告知"去装一个 JDK 17"。
sys.path.insert(0, str(HERE))
import jdk_env  # noqa: E402

# Windows：stdout 默认按控制台代码页（cp936）编码。被别的程序（门禁、CI）用管道读走时，
# 那些 GBK 字节会被按 UTF-8 解成乱码 —— 连"写入自检失败"这句话都认不出来。
# 输出钉成 UTF-8（Linux/macOS 本来一致，无副作用）。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError, OSError):
        pass


def exe(home: Path, name: str) -> Path:
    return jdk_env.exe(home, name)


def self_test(home: Path, probe_dir: Path) -> tuple[bool, str]:
    """Start THIS JVM and make it write a file and a zip."""
    java = exe(home, "java")
    if not java.exists() or not SELF_TEST.exists():
        return False, "缺少 java 或自检源码"
    try:
        probe_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        # 探针目录都建不出来（被文件挡住 / 没权限）——这也是"写不了"的一种，要说清楚，
        # 而不是抛一个 traceback 给用户。
        return False, "自检目录建不出来：%s" % exc
    try:
        out = subprocess.run([str(java), str(SELF_TEST), str(probe_dir)],
                             capture_output=True, text=True, timeout=180, cwd=str(HERE))
    except Exception as exc:  # noqa: BLE001
        return False, "自检跑不起来：%s" % exc
    lines = ((out.stdout or "") + (out.stderr or "")).strip().splitlines()
    # 取第一行：自检成功时它是 "SELFTEST OK…"，失败时是那条 ReadOnly/isWritable 说明。
    return out.returncode == 0, (lines[0] if lines else "exit=%s" % out.returncode)


def candidates(explicit: str | None, needed: str) -> list[tuple[Path, str]]:
    """候选来自 `jdk_env.jdk_homes()` —— 那一份里包含 `~/tools`、`~/.jdks`、sdkman 等
    开发者真的会把 JDK 解压进去的地方，Mojang runtime 排在最后并带标签。"""
    return jdk_env.jdk_homes(explicit, needed=needed)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="resolve a JDK that can write a jar")
    parser.add_argument("--java-home", default=None, help="explicit JDK home to try first")
    parser.add_argument("--needed", default=jdk_env.NEEDED_JDK, help="required javac major version (default 17)")
    parser.add_argument("--probe-dir", default=None, help="where the self-test writes (default: temp)")
    args = parser.parse_args(argv)
    probe = Path(args.probe_dir) if args.probe_dir else Path(os.environ.get("TEMP") or "/tmp") / "mcmod-jdk-selftest"

    tried: list[str] = []
    for home, origin in candidates(args.java_home, args.needed):
        major, reason = jdk_env.jdk_major(home)
        if major is None:
            tried.append("  - %s  [%s]  %s" % (home, origin, reason))
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
        tried.append("  - %s  [%s]  是 JDK %s，但写入自检失败：%s%s"
                     % (home, origin, major, detail, jdk_env.low_integrity_hint(origin)))

    print("找不到能用的 JDK %s（要求：有 javac，且启动的 JVM 能写文件与 jar）。试过：" % args.needed)
    print("\n".join(tried))
    print("")
    print("解决：装一个普通 JDK %s（Temurin / Microsoft / Oracle），" % args.needed)
    print("或把一份 JDK 复制到普通目录（被打了低完整性标签的目录里复制出来的副本继承 Medium），")
    print("再用 --java-home 指给我。**不要**用 Minecraft 自带的 runtime java 跑构建。")
    return 3


if __name__ == "__main__":
    sys.exit(main())
