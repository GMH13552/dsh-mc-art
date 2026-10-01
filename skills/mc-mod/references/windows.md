# Windows (native, no WSL)

Everything in this skill is general; Windows is where "it worked on my machine"
becomes a support ticket. These are the differences that were measured.

## The shell is not bash

- A DSH session on Windows runs `pwsh`, not bash: `rm`, `mv`, `cat`, `cp`, `$VAR` and
  single-quote semantics are not the same thing.
- Measured: the panel builds its shell commands per dialect (`rm -f`/`mv -f` become
  `Remove-Item`/`Move-Item`) and a gate runs the captured commands against the real
  Windows shell to prove the dialect is right, not just that the strings differ.
- Portable installers use **one logic file plus two thin shells**: the logic lives in a
  cross-platform runtime (Node), and `install.sh`/`install.bat` only find it. Two copies
  of the logic get two sets of bugs.
- Paths: forward slashes work in Node and Python on Windows. Prefer `/` when the path
  is embedded in a string another language will parse.
- Quote every path containing a space or a non-ASCII character; `C:\dev\my mod` and
  `C:\项目\模组` are legal and common.

## Python: the name is not the test

- On Windows the interpreter is usually `python` or `py -3`. `python3` is often a
  **zero-byte Store stub** that exits with code 9009 and prints nothing.
- `py -3` can also be broken: the launcher reads a registry entry that may point at an
  interpreter that no longer exists (measured on this machine: `Unable to create
  process`).
- The only honest probe is to **run it once**:

  ```bash
  python -c "print(1)"     # require: exit code 0 and stdout exactly 1
  ```

- Probe order: `python3` → `python` → `py -3` → `py`, each one really executed; an
  explicit path in an environment variable or config wins over all of them.
- "The command exists" is not evidence. A command that exists and fails is worse than
  a missing one, because the failure looks like a bug in the tool.

## JDK: the version number is not the test either

- 1.17–1.20.1 targets need **Java 17**; 1.20.5+ / 1.21.x need **Java 21**.
- Do **not** build with the Java runtime bundled with the game. A JVM started from that
  runtime runs at low mandatory integrity, where `Files.isWritable()` answers false even
  for a file the JVM just wrote; `jdk.zipfs` then treats every jar as read-only and the
  build dies leaving an empty jar (`gametest.md`).
- `scripts/check_jdk.py` starts each candidate and makes it write a file and a zip entry.
  Exit code 3 means none was usable.

## Node and the bundled runtime

- A DSH desktop install ships its own runtime under
  `resources/runtime/primary-runtime/dependencies/`: Python (with Pillow), Node and
  pnpm. On such a machine "install Python first" is wrong advice — use what is already
  there.

## Line endings and encoding

- Line endings are pinned in `.gitattributes`: `.bat`/`.cmd`/`.ps1` are CRLF;
  `.sh`/`.py`/`.md`/`.json`/`.yml` are LF. A `.sh` with CRLF fails with
  `\r: command not found`; a labelled `.bat` with bare LF can misbehave. Do not rely on
  "whoever cloned it" to get this right — pin it in the repository.
- Text files are **UTF-8 without BOM**. A BOM makes `javac` fail with
  `illegal character: '\ufeff'`.
- Do not write source files through a shell that re-encodes. Older shell defaults use a
  legacy code page, and a GBK round-trip destroys Chinese text silently. Use the file
  tools; when a script must write, pass UTF-8 explicitly.
- A console code page can mangle Chinese on output; set the console to UTF-8 or write
  to a file with an explicit encoding and read that.

## Paths, spaces and length

- Keep build roots short and ASCII where possible (`C:\dev\mod\...`); deep nesting plus
  spaces plus non-ASCII is where Gradle and the Java tooling trip.
- Avoid embedding a Windows path with backslashes in another language's string literal:
  `\U`, `\m` and friends become escapes. Convert to `/` first — measured: an installer's
  generated home-path line silently changed until it did.

## What is *not* different

- The mod, the pack, the ids and the atlas are platform-independent.
- The GameTest runner picks the Gradle wrapper for the platform (`gradlew.bat` on
  Windows).
- No WSL is required: everything above runs in a native Windows session.
