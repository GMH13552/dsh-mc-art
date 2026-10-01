#!/usr/bin/env python3
"""Pick a JDK: the ONE candidate list and version judgement both tools share.

WHY THIS MODULE EXISTS.  Two implementations grew apart.  The runner in
`tools/mcmod_gametest.py` searched `~/tools`, `~/.jdks` and friends and found the
JDK 17 that had just built the mod; the checker shipped to users,
`skills/mc-mod/scripts/check_jdk.py`, never looked there and told the user to go
install one.  Same machine, opposite verdicts -- and the one users see was wrong.
So the *candidates* and the `javac -version` judgement live here, once.

WHAT IS SHARED, WHAT IS NOT.  Shared: which directories are tried, in what order,
and what counts as "this directory is a JDK <major>".  Not shared: what happens
after a candidate matches.  `check_jdk.py` additionally starts that JVM and makes
it write a file and a zip (that is how the Low-integrity Mojang runtime is caught);
`mcmod_gametest.py` only checks that `java -version` runs.  That is exactly why
`pick_jdk()` takes a `verify` callback.

ASCII only, stdlib only -- `check_jdk.py` ships inside the skill and has to run on
a bare Windows console.
"""
from __future__ import annotations

import glob
import os
import re
import subprocess
from pathlib import Path

NEEDED_JDK = "17"


def exe(home, name: str) -> Path:
    suffix = ".exe" if os.name == "nt" else ""
    return Path(home) / "bin" / (name + suffix)


def jdk_major(home, run=subprocess.run, is_file=os.path.isfile, timeout: int = 60):
    """`(major, reason)` for this directory -- **really runs** `javac -version`.

    Never trusts the directory name: `jdk-17.0.8` can be anything, and
    `C:\\Program Files\\Java\\jdk-21` is a perfectly valid name for the WRONG
    compiler (1.18.2 cannot be built with 21).
    """
    javac = exe(home, "javac")
    if not is_file(str(javac)):
        return None, "no javac (not a JDK)"
    try:
        done = run([str(javac), "-version"], capture_output=True, text=True, timeout=timeout)
    except Exception as exc:  # noqa: BLE001
        return None, "javac would not start: %s" % exc
    text = (done.stdout or "") + (done.stderr or "")
    match = re.search(r"javac\s+(\d+)", text)
    if not match:
        return None, "javac -version printed something unreadable: %r" % (text.strip().splitlines()[:1],)
    return match.group(1), "javac %s" % match.group(1)


def jdk_homes(explicit=None, env=None, is_dir=os.path.isdir, needed: str = NEEDED_JDK):
    """`[(home, origin)]`, best first.  The order is part of the contract:

    1. the explicit argument (`--java-home`)
    2. `JAVA_HOME`, `JDK<needed>_HOME`
    3. the usual install roots (`C:\\Program Files\\{Java,Eclipse Adoptium,...}`,
       `/usr/lib/jvm`, `/Library/Java/JavaVirtualMachines`)
    4. **where a developer actually unzips a JDK**: `~/.jdks` (IntelliJ),
       `~/tools[/jdk*|*jdk*]`, `~/.sdkman/candidates/java`, `~/scoop/apps`,
       `%LOCALAPPDATA%\\Programs\\...`
    5. Mojang's bundled runtime -- **LAST** and labelled: it is the one that usually
       fails the write self-test, so any real JDK must win first.
    """
    env = os.environ if env is None else env
    home_dir = env.get("USERPROFILE") or env.get("HOME") or ""
    out = []
    seen = set()

    def push(value, origin):
        if value is None or str(value) == "":
            return
        path = Path(value)
        key = str(path).lower()
        if key in seen:
            return
        seen.add(key)
        out.append((path, origin))

    push(explicit, "--java-home")
    push(env.get("JAVA_HOME"), "JAVA_HOME")
    push(env.get("JDK%s_HOME" % needed), "JDK%s_HOME" % needed)

    program_files = env.get("ProgramFiles") or env.get("ProgramFiles(x86)") or ""
    local_appdata = env.get("LOCALAPPDATA") or ""
    bases = []
    if os.name == "nt":
        for name in ("Java", "Eclipse Adoptium", "Microsoft", "Zulu",
                     "Amazon Corretto", "BellSoft", "AdoptOpenJDK"):
            bases.append(Path(program_files) / name)
        bases += [Path(local_appdata) / "Programs" / "Eclipse Adoptium",
                  Path(local_appdata) / "Programs" / "Microsoft",
                  Path(local_appdata) / "Programs" / "Java"]
    else:
        bases += [Path("/usr/lib/jvm"), Path("/opt/java"),
                  Path("/Library/Java/JavaVirtualMachines")]
    if home_dir:
        bases += [Path(home_dir) / ".jdks",
                  Path(home_dir) / "tools",
                  Path(home_dir) / ".sdkman" / "candidates" / "java",
                  Path(home_dir) / "scoop" / "apps"]
    for base in bases:
        if not is_dir(str(base)):
            continue
        try:
            entries = sorted(base.iterdir())
        except OSError:
            continue
        for entry in entries:
            push(entry, str(base))
            push(entry / "Contents" / "Home", str(base))   # macOS bundles

    # A JDK unzipped somewhere obvious under the home directory (`~/tools/jdk17-*`).
    if home_dir:
        for pattern in (os.path.join(home_dir, "jdk*"),
                        os.path.join(home_dir, "tools", "jdk*"),
                        os.path.join(home_dir, "tools", "*jdk*")):
            for found in sorted(glob.glob(pattern)):
                push(found, "glob %s" % os.path.basename(pattern))
                push(Path(found) / "Contents" / "Home", "glob %s" % os.path.basename(pattern))

    # Mojang's bundled runtime goes last and is labelled on purpose.
    appdata = env.get("APPDATA") or home_dir
    if appdata:
        runtime = Path(appdata) / ".minecraft" / "runtime"
        if is_dir(str(runtime)):
            try:
                for child in sorted(runtime.iterdir()):
                    push(child, "Mojang runtime (Low integrity label)")
            except OSError:
                pass
    return out


def low_integrity_hint(origin: str) -> str:
    """The sentence that makes the Mojang-runtime rejection understandable."""
    if "Mojang" not in str(origin):
        return ""
    return ("  <- it carries the Low integrity label: Files.isWritable() says false even "
            "for a file it just wrote, so jdk.zipfs treats every jar as read-only "
            "(that is how ForgeGradle's access-transformer step dies)")


def pick_jdk(explicit=None, needed: str = NEEDED_JDK, env=None,
             run=subprocess.run, is_file=os.path.isfile, is_dir=os.path.isdir, verify=None):
    """`{home, origin, major, reason, hint, tried}` -- first candidate that really matches.

    `verify(home) -> (ok, detail)` is the caller's extra gate: `check_jdk.py` makes the
    JVM write a file and a zip; `mcmod_gametest.py` only asks `java -version` to run.
    A rejected candidate is always recorded in `tried` with a sentence explaining why
    (that list is the whole point: "looks like a JDK 17" is not the question).
    """
    tried = []
    for home, origin in jdk_homes(explicit, env=env, is_dir=is_dir, needed=needed):
        major, reason = jdk_major(home, run=run, is_file=is_file)
        if major is None:
            tried.append({"home": str(home), "origin": origin, "major": None,
                          "reason": reason, "hint": ""})
            continue
        if major != str(needed):
            tried.append({"home": str(home), "origin": origin, "major": major,
                          "reason": "%s (need %s)" % (reason, needed), "hint": ""})
            continue
        if verify is not None:
            ok, detail = verify(home)
            if not ok:
                tried.append({"home": str(home), "origin": origin, "major": major,
                              "reason": "is JDK %s but the write self-test failed: %s" % (major, detail),
                              "hint": low_integrity_hint(origin)})
                continue
        return {"home": str(home), "origin": origin, "major": major, "reason": reason,
                "hint": low_integrity_hint(origin), "tried": tried}
    return {"home": None, "origin": None, "major": None, "reason": "", "hint": "", "tried": tried}
