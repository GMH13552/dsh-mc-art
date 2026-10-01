# Changelog

All notable changes to **`dsh-mc-art-panel`** (the npm package) and to the `mc-mod`
skill and `mc-studio` preset that ship inside it.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

The log starts at **0.2.0** — the first release that runs natively on Windows, whose
panel/report contract is stable, and whose shipped skills are general (no loader,
version, machine or project is baked in). Earlier 0.1.x releases were development
snapshots and are not itemised here.

## 0.2.0

### Added

- **Windows native, no WSL.** Installers (`install.bat` / `install.sh`), every gate,
  and the GameTest verdict tool run in a native Windows session. The Python probe is
  behavioural: every candidate (`python3` → `python` → `py -3` → `py`) is really
  executed and must print `1` with exit code 0 — a zero-byte Store stub that exits 9009
  is not accepted, and neither is "the command exists".
- **Structured panel diagnostics.** A block that cannot be drawn now returns
  `{ error, diagnostic: { reason, block, missing[], tried[], referenceDirectory } }`,
  where `missing[]` distinguishes `kind: 'project'` (the project's own model file) from
  `kind: 'vanilla'` (a vanilla parent), and every entry carries the exact path to fix.
  The report is ≤ 20 lines, never repeated, and is shown on screen only — it is not
  written anywhere.
- **`references/art-direction.md`** — the art decisions a tool cannot make: how to pick
  the reference that belongs to the family (a deep-layer block must not sample a
  shallow-layer texture), gradients/bands instead of scattered dots, an accent budget,
  family boundaries, colour-only requests, and block-entity UV.
- **`references/windows.md`** — shell dialect, `python` vs `python3`, JDK 17/21,
  line endings, BOM/GBK, paths with spaces and non-ASCII characters.
- **`README.md`, `LICENSE` (MIT) and this file.**
- mc-studio's persona now says that installing the npm package delivers **panel +
  preset + both skills** in one step, so no manual copying into the user directory is
  needed.

### Changed

- **`mc-mod` is general.** Loader-, version-, machine- and project-specific wording was
  replaced by the method for *finding out* (`version.json` in the client jar, `javap`
  on the mapped jar, the compiler as a judge). The version matrix stays, as categories
  of change rather than memorised numbers.
- **The workflow now names who judges what, at every stage.** Stage 0–7 each state what
  passes and whether the model, a tool, the game or a human decides. The split is one
  sentence: taste/context/intent belongs to the model (reference choice, family
  boundary, emphasis, naming, player experience); measurement and repetition belong to
  tools (pixel statistics, jar scans, exit codes, byte-for-byte regeneration).
- Examples are neutral throughout: `examplemod`, `example_*`, `<placeholder>`.
- Version matrix aligned with the actual capability: GameTest exists from 1.17; on Forge
  it needs 1.18.1+ / 39.0.88+.

### Fixed

- The panel no longer writes to sessions, agent inboxes or persisted logs — every write
  goes to the project's own pack or the project's own settings/atlas files, and the
  panel's report is display-only.
- The "cannot draw this block" report no longer calls a missing **project** model a
  missing **vanilla** parent, and no longer sends the user off to edit `parent`.
- multipart blocks (vanilla walls and fences among them) are read from all variants
  instead of only the first, and doors/slabs no longer render as a single half.
- Plugin entry points load on Windows: module paths go through `pathToFileURL`, so
  `entry-test.mjs` no longer fails with `ERR_UNSUPPORTED_ESM_URL_SCHEME`.

### Removed

- Author machine paths and private project names from everything tracked by git; example
  identities are `examplemod` / `example_*`.
