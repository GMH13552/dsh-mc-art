#!/usr/bin/env python3
"""门禁：挑 JDK 的那个 preflight 必须能说出"这个 JVM 写不了 jar"。

为什么值得单独一条：这条检查的价值全在**它能不能红**。用户机器上真实发生的是
Mojang 自带 runtime 带 Low 完整性标签 → `Files.isWritable` 对自己刚写的文件回 false →
`jdk.zipfs` 把 jar 当只读 → ForgeGradle 的 access transformer 必挂（22 字节空 jar）。
那种 JVM 在 Linux 上造不出来，但**症状类别**能造：让探针往一个不可写的目录里写。

   python3 tools/check_jdk_test.py

四件事：
  1. 正常情况必须找到 JDK 并自检通过（找不到就红——这台机器上本来就该有 Java）；
  2. 探针目录不可写时必须 exit 3，并且**说出原因**（AccessDenied / isWritable）；
  3. 要求一个不存在的版本时必须 exit 3 且逐条列出试过什么；
  4. 自检源码必须 ASCII（它要在裸 Windows 控制台上跑）。
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "skills" / "mc-mod" / "scripts" / "check_jdk.py"
SELF_TEST = HERE.parent / "skills" / "mc-mod" / "scripts" / "JvmWriteSelfTest.java"

failures = 0


def check(label: str, ok: bool, detail: str = "") -> None:
    global failures
    if not ok:
        failures += 1
    print("  " + ("OK  " if ok else "FAIL") + " " + label + ("" if ok or detail == "" else "  -> " + detail))


def run(*args: str) -> tuple[int, str]:
    done = subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, timeout=600)
    return done.returncode, (done.stdout or "") + (done.stderr or "")


def main() -> int:
    if not SCRIPT.exists():
        check("脚本在（skills/mc-mod/scripts/check_jdk.py）", False, str(SCRIPT))
        print("1 项失败")
        return 1

    # 4) ASCII 自检源码：裸 Windows 控制台上非 ASCII 会直接炸。
    raw = SELF_TEST.read_bytes()
    check("自检源码是 ASCII（能在裸 Windows 控制台跑）", all(byte < 128 for byte in raw),
          "第 %d 字节 = %d" % (next((i for i, b in enumerate(raw) if b >= 128), -1),
                              next((b for b in raw if b >= 128), 0)))

    # 1) 正常路径
    code, out = run()
    if code == 0:
        check("正常情况：找到能写 jar 的 JDK", "JDK OK" in out and "SELFTEST OK" in out, out.strip()[:200])
    else:
        check("正常情况：找到能写 jar 的 JDK", False,
              "这台机器上没有可用的 JDK —— 构建本来就跑不了，门禁不会假装通过：" + out.strip()[:200])

    # 2) 症状类别：探针目录不可写 → 必须红，并且说出原因
    with tempfile.TemporaryDirectory() as tmp:
        probe = Path(tmp) / "readonly"
        probe.mkdir()
        os.chmod(probe, 0o500)
        try:
            code_ro, out_ro = run("--probe-dir", str(probe))
        finally:
            os.chmod(probe, 0o700)
        check("探针目录不可写时：exit 3（不是假装通过）", code_ro == 3, "exit=%s" % code_ro)
        check("而且说得出原因（自检失败的具体报错）",
              "写入自检失败" in out_ro and ("AccessDenied" in out_ro or "SELFTEST FAIL" in out_ro),
              out_ro.strip()[:220])

    # 3) 版本不对 → 逐条列出试过什么
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
