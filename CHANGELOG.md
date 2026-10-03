# Changelog

All notable changes to **`dsh-mc-art-panel`** (the npm package) and to the `mc-mod`
skill and `mc-studio` preset that ship inside it.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

The log starts at **0.2.0** — the first release that runs natively on Windows, whose
panel/report contract is stable, and whose shipped skills are general (no loader,
version, machine or project is baked in). Earlier 0.1.x releases were development
snapshots and are not itemised here.

## 0.2.9

### Fixed

- **An animated texture in your own pack was never animated in the panel, and the panel blamed the
  file for it.** `animationsFor()` consulted only the *reference* textures' animation table, and
  `preload()` collected the project's textures without ever looking for `<name>.png.mcmeta` — the
  word `mcmeta` did not appear in the host at all. A 16×192 strip (12 frames of 16, `frametime` 4)
  was therefore drawn as **one 16×192 texture**, which is the blur you saw, while the game read the
  `.mcmeta` and animated it correctly. The host now reads the project's `.mcmeta` (its own IHDR size
  reader; the same acceptance rules as the extractor's `animation_of`) and `animationsFor()` consults
  both tables.
- **The message no longer accuses the file of something the tool never checked.** "shaped like a
  strip but has no animation description" was printed whenever the shape looked like a strip and no
  animation entry existed — including when the `.mcmeta` was right there. There are now three cases
  saying three different things: a valid `.mcmeta` → nothing is shown; **`.mcmeta` present but
  unreadable** (bad JSON, no `animation` section, or the image is not a strip) → "this texture
  **has** an animation description file, but I cannot read it: `<path>.mcmeta` — `<the real
  reason>`"; genuinely absent → the shape-based message, which now also names the file to add.
- Two unrelated drifts surfaced by gating this: `check_jdk_test.py` had been rewritten to capture
  output without declaring how to decode it, so `encoding-test.js --fault` could not catch its own
  reverse fixture (the static rule now requires `encoding=`/`text=` whenever output is captured);
  and the host's line endings had been normalised to CRLF, which made multi-line `--fault` patches
  match nothing **silently** (`readHostSource()` now normalises to LF). Both guards reported
  "did not take effect" rather than turning green.

### Added

- `tools/mcart-plugin/project-animation-test.js`: fixture A (valid `.mcmeta` — must be 12 frames and
  must produce neither message), B (absent — may produce the shape message), C (present but broken —
  must produce the truthful message and must **never** say "no animation description"), D (a plain
  16×16 — silent). `--fault` (remove the project `.mcmeta` reading) turns 8 assertions red.
- `panel/ui-test.mjs` gained the same three cases plus `--fault-animnotes`, whose reverse fixture
  turns exactly case C red while **case B stays green** — the fallback message is *correct* when the
  host has nothing to say, so only "the host spoke and the client ignored it" may fail.

### Note

The `.mcmeta` path was already parsed on the reference side (that is where the jar's animations come
from), which is why this only broke for textures **in your own pack** — precisely the case the panel
exists for.

## 0.2.8

### Fixed

- **The block models the engine wrote were unusable in the game, and every gate said they were
  fine.** `write_block_model` passed the spec's `elements` through verbatim, so a face written as
  `"stone"` — a **key** into the model's own `textures` map, which is the spec's convention and what
  the engine's own audit validates — stayed `"stone"` in the emitted Minecraft model, where a value
  without `#` is a **path**: `<namespace>:textures/stone.png`, which does not exist. Every face lost
  its texture, so the model was invisible in game *and* undrawable in the panel. Measured on a real
  project: **42** references in one hand-authored model, **38** in another — and those two were the
  only broken ones, because they were the only ones going through the block-entity path.
  Face textures are now emitted as `#key`; values that are already `#…` or namespaced paths are left
  alone (vanilla writes those too).
- **The artifact is now validated by reading it back.** `validate_written_model` re-reads the model
  it just wrote and requires every face to be a `#variable` present in that model's own `textures`,
  or a path the pack really ships; otherwise it **raises**, so an illegal model cannot leave the
  generator. It sits *on* the generation path, ahead of the preview — because the preview reads PNGs
  from disk and therefore renders correctly even when the written model is broken. That split is
  exactly why this shipped: the picture was right and the artifact was wrong.
- The engine's own example `examples/example_block_entity/desk.json` is a **spec** whose generated
  model was broken; it now emits `#wood`/`#paper`, and the emitted model is read back and validated
  (20 faces, zero bare words).
- **A second source of truth, removed by choice.** A spec may now declare a texture's real asset id
  (`{"path": …, "id": "ns:block/real_name"}`), in which case nothing is copied. Copying stays the
  default, but when the spec key differs from the source file's name the copy is **reported** with
  its consequence: the pack ships those bytes *renamed*, so anything referring to the real asset id
  will not find them.

### Added

- **The panel now names this mistake instead of sending you hunting for a missing PNG.** A face
  texture that is a bare word *and* matches a key in the model's `textures` map is reported as
  **`texture-missing-hash`**: it names the face, says the bare word is being read as a path, lists
  the model's texture keys, and says **"you probably meant `#stone`"** — adding that the block is
  broken in the game too, not only in the panel. A `#variable` that is not in the map is a separate
  reason (`texture-variable-unresolved`), and a genuinely missing file stays `textures-unresolved`;
  the three no longer share one sentence. `tools/mcart-plugin/texture-syntax-test.js` covers all
  three plus two **legal** forms (`"#stone"`, and a bare *path* like `block/stone_tex`) so the advice
  cannot fire on correct input.
- Unresolved textures that are the project's own no longer report `no-reference-directory`; a
  missing PNG in your own pack has nothing to do with whether a reference directory is set.

### Changed

- Vendored `mc-art` snapshot: `49793ad` → `a6e224c`.

### Note

`mc-art doctor` caught the installer's clone being one commit behind before this release — the
commit being this fix — and said which side was stale. Fast-forwarding that clone is now part of the
re-vendor step; without it the package would have shipped the broken model writer again.

## 0.2.7

### Fixed

- **A block whose model parents `minecraft:block/cube_all` could report "the chain is complete, but
  not one face was drawn" with `原因：unknown`.** Two separate defects sat behind that one message:
  - The parent fallback chain accepted any **truthy** result as "resolved", so a parent fetched as
    an **empty shell** (`{}` / `{textures:{}}`) short-circuited the built-in vanilla parent table
    and the chain ended with no geometry. An empty shell is not a resolution. This is not a
    hypothetical shape: the game's own `block/block` carries only `display`/`gui_light` — no
    elements, no parent — so an ordinary chain really does contain one.
  - `no-quads` was only set when `elements !== undefined`, so "the whole chain has no elements" fell
    through to `unknown` — and `unknown` is not a diagnosis. It is now **`no-geometry`**, and the
    text names the real cause (a parent that could not be fetched) and says explicitly that this is
    **not** evidence of a block entity.
- The report's line about the built-in parent table printed **"（这次没走到）" whenever nothing was
  missing** — i.e. it claimed the table had not been used even when the table was what resolved the
  chain. It now says what actually happened: the keys it hit and which one caught the chain, or that
  it was consulted and did not have the key, or that it was not needed at all.
- `tools/mcart-plugin/parent-fallback-test.js`: a self-contained project whose pack contains an empty
  shell must still draw; the control (no `cube_all` in the pack, so the built-in table must do the
  work) must **not** go red; and the reason must not be `unknown`. The reverse fixture turns three
  assertions red.

### Note

The build that produced the report predated `vanillaBare()` (present from 0.2.3): a project model
written the way vanilla writes it resolved to nothing there. Worth recording because the panel's
**host half only reloads when DSH is fully restarted** — approving a new version is not enough on
its own.

### Changed

- Vendored `mc-art` snapshot unchanged (`49793ad`): this release is panel-side only.

## 0.2.6

This release is mostly one thing a user's own second session measured and wrote down: a
757-line log of what actually cost time while building a mod with these tools. Its first
finding was a defect in a gate **we** shipped two releases earlier.

### Fixed

- **The embedding band was measuring the wrong thing.** `accent_base_gap`'s default 6..24 came
  from `iron_ore`, and it was the **mean of a whole ore cluster**, not of a speck. Measured across
  all eight vanilla ores the figure runs **−75.7 (redstone) … +106.6 (gold)** and **none of them
  falls inside 6..24**. Using the default as an ore's target compresses a deposit that should read
  as bright into a recessive smudge — the session did that for seven rounds. The constants are now
  named for their owner (`ITEM_ACCENT_GAP*`), the vanilla ore range is published as a fact,
  `accent_base_gap_min/max` default to `None` so the engine can tell a **default** from a
  **declaration**, and an asset declared as a deposit that declares no band is **refused** with the
  way out in the message. The default was not loosened: that would refuse items.
- **`mc-art gap-from-refs`** measures the band from your own references, and reports the
  **per-deposit** figure (the one to declare) separately from the **per-pixel** boundary figure —
  stating that averaging a cluster first is exactly how `12.24` was produced, and printing its mask
  rule, because a different mask gives a different number.
- **The judge could not run on a path with spaces.** `list2cmdline()` was handed to `subprocess` as
  a single argv element, so cmd received a literal `\"…\"` and answered
  `'…' is not recognized` — which looks like a Gradle failure. The user's own project path
  (`Release 2.8.3`) has a space, so this was blocking. Windows now gets one command line.
- **`--fault` returned 0 even when it caught nothing**, which made "the checker can say no"
  unfalsifiable. It now returns **4** when the injected fault goes undetected (1 stays "the verdict
  did not pass"), and says that the tool's own exit code carries no verdict.
- **`--fault`'s injection point was hardcoded** to the example mod's expression, so any new project
  had to write `ExampleMod.EXAMPLE_BLOCK` verbatim — polluting the subject to satisfy the tool.
  `--fault-find` / `--fault-replace` were added; the old pair stays as a compatibility default and
  the failure now points at the flag.
- **The judge did not manage Gradle's home**, and the default one is read-only to a sandboxed
  process, so the wrapper died creating a lock file. It now probes candidates, **really creates a
  lock file** to prove writability, prints which home it chose and why each other was rejected, and
  passes `GRADLE_USER_HOME`. (`gradlew`'s `-g` cannot fix this: the wrapper parses it only when it
  precedes the task name.)
- **`geometry.uv_regions` silently cancelled contour conformance** (`appearance_only` plus declared
  regions degrade an item to a full opaque quad — measured 0 transparent pixels where vanilla has
  188). The two declarations cancelling out are now reported.

### Added

- **`mc-art doctor`** — platform, engine root, module count, which interpreter works **and why each
  candidate was rejected**, whether the three entry points really run, line endings against
  `git check-attr`, writability, and whether the engine copies on this machine agree. On its first
  run it caught a stale `~/.dsh/skills/mc-art` and said which side was behind.
- **`scripts/check-ore-gap.py`** (an undeclared ore is refused, a declared one passes; both
  directions proven) and **`scripts/check-tiling.py`** — a real tiling-seam gate counting pattern
  pixels on row 0/15 or column 0/15 against a declared `tiling_min_margin`. Six of eight vanilla
  ores keep a margin of 1; only emerald touches the edge, and the message says so.
- **`tests/test_doc_counts.py`** — the module count a document claims is compared against
  `mc_art/*.py`, so the number can no longer drift (it caught `doctor.py` immediately: **34**).

### Changed

- **The skill now teaches the path that was missing.** Measure the reference corpus **first** —
  colour *and* shape grammar (per-face blush count, cluster size, fill ratio, thickness, luma
  levels; the vanilla ore contract measured across seven ores is 6–9 clusters, 4–29 px,
  fill 0.70–0.84, thickness 5–9, 2–5 levels) — then state per-asset-class success criteria, then
  draw. Plus: which gates are declarable versus fixed, that "attached a reference" is not "used the
  reference", that layer matching runs **both** ways, and that the band a category needs comes from
  its own references. `windows.md` gained the measured PowerShell traps (write a `.py`, never
  inline; `Set-Content -Encoding UTF8` writes a BOM that breaks `json.load`), and `traps.md` gained
  the one that quietly destroys good pixels: a "repair" step written before its premise was checked.
- Vendored `mc-art` snapshot: `427fd01` → `49793ad`.

## 0.2.5

### Fixed

- **Every texture in your own project pack refused to save.** The panel said *"this texture handle
  is not a relative path inside the project pack"* while the path plainly **was** inside your pack:
  the sentence was true about the *shape* and false about the *reason*. The host stored your
  project's own textures as **absolute** paths (`preload()`), that value travelled to the editor as
  its save handle, and the client's safety check rejects drive-letter paths — so **no texture in your
  own pack could be saved**, and the write path was never reached at all. The host now stores
  pack-relative handles and resolves them against the project root when reading; the in-pack test
  normalises separators, case and `.`/`..` and compares real paths, and it **accepts an in-pack
  absolute path** as well, so a stray absolute handle cannot lock you out again. The rejection
  message now names what is actually wrong — empty / NUL / drive-letter / leading slash / `..` /
  outside the pack, five distinct reasons — instead of one sentence that blames your own pack.
- `tools/mcart-plugin/texture-edit-test.js`: the handle must pass the **real** client check
  (`safeTextureHandle`, pulled out of `client.js` rather than re-implemented) and the host must
  actually land the bytes in the project pack (before/after compared). The reverse fixture puts the
  absolute path back and turns **six** assertions red — including the message users actually saw,
  verbatim — with the file unchanged at 224 B, i.e. not one byte written.

### Changed

- Vendored `mc-art` snapshot unchanged (`cf39eba`): this release is panel-side only.

## 0.2.4

### Added

- **A reference now declares a class, and the engine checks it.** The user's words: *"mist stone
  should be shallow rock, shouldn't it?"* — the plan had attached `deepslate` and written a note
  forbidding `stone`. The **class** is what makes two references interchangeable; the name is not.
  `descriptor.class` / `descriptor.layer` and `references[].class`; the engine derives each
  candidate's class and layer from its name (`mc_art/refclass.py`, printed by `mc-art refclass`), and
  a gate requires the declared class to be **represented** among the attached references and the
  chosen one to be in the declared layer. Class and layer stay separate on purpose:
  `deepslate_iron_ore` is an *ore* that lives *deep*, and flattening the two would make "this ore is
  from the wrong layer" impossible to say. An unrecognised name classifies as `unknown` and is never
  failed — the engine would rather say "I don't know" than guess.
- **`reference_notes`.** A note may not contradict the reference it is attached to, and a note
  claiming "this is the same reference plan X uses" is **verified against plan X**, not believed. A
  note that merely *names* another reference is allowed: describing a composite choice ("its specks
  sit on the stone base") is exactly what such a note is for.
- **`mc-art refclass --plans <dir>`** — a family view that marks the outlier: the plan whose attached
  references do not represent the class it declares.
- **The skill now has the procedure that was missing.** "Name the class → list that class's
  candidates from the reference root → attach and declare roles → verify with `why-reference` what
  actually loaded, do not trust your memory of what you mounted." The "who decides" table used to
  assign the choice to the model without ever saying how to make it.
- Three real failures from a shipped plan set are written into the skill as counter-examples: a note
  copied between plans (so it argued against its own correct choice), a note forbidding the very
  layer it used, and a claim of agreement with another plan that was false. Plus the root cause they
  share: **an asset made up on the spot gets a reference made up with it** — every asset in a plan
  must have a provenance in the design documents, or the user is asked.

### Fixed

- The pipeline rebuilt `GenerationPlan(...)` in four places and **silently dropped new fields**,
  which is why a false cross-plan claim came back as "could not be checked" instead of "is false".
- Four example plans are written back in their compact hand-written form; earlier rounds had
  re-serialised them through `json.dumps`, expanding every inline array until a two-key change looked
  like fifty lines.

### Changed

- Vendored `mc-art` snapshot: `427fd01` → `74a6142`.

## 0.2.3

### Fixed

- **An item with no block model showed an empty preview.** A carrot, a sword: the host correctly
  answers "no model for this" (a flat item has no `elements`), but the client kept **the previous
  asset's 3D** on screen instead of clearing it — and the 2D fallback only drew when `scene === null`.
  Measured before the fix: clicking a carrot left **16916 pixels of the *previous* asset** in the
  viewport and 0 for the item itself. Clearing the scene on every picker action, and treating
  "a scene with no quads" as nothing to draw, fixes it; the panel now says which of the two it is.
- **One slot with no icon failed the whole page.** `atlas.itemIcons` returned
  `{items: {<id>: undefined}}` for an item whose icon could not be fetched, and the strict
  lossless-JSON check rejected the entire response — so 1 bad slot out of 40 took the page down.
  A slot now carries an explicit `missing: true` with its reason, and the other 39 are unaffected.
- **Five gates were locale-dependent.** `subprocess.run(..., text=True)` without `encoding=` decodes
  a child's UTF-8 output using the machine's ANSI code page. On a Chinese Windows
  `tools/test_extract_block.py` was **22 failed / 31 passed**; with `-X utf8`, **53 passed**. The
  panel host had always passed `-X utf8`; only the gates had not. Both halves are pinned now, and a
  gate proves it: `tools/mcart-plugin/encoding-test.js`.
- **The shipped JDK checker could not find a working JDK.** `check_jdk.py` searched `Program Files`
  and the game's runtime, but **not `~/tools`** — so on a machine whose only usable JDK 17 lives
  there it said "install a JDK 17" while the repo's own runner built with it happily. Both sides now
  share one implementation (`skills/mc-mod/scripts/jdk_env.py`).
- **Two gates had been silently empty.** The "probe directory is not writable" fixture used
  `os.chmod(dir, 0o500)`, a no-op on Windows; and `check_jdk.py` created the probe directory outside
  its `try` and never pinned stdout to UTF-8, so a piped reader saw mojibake instead of the reason.
- **Private names were in tracked files** — a mod's own vocabulary in `tools/emit_atlas.py`, a
  machine directory name in `tools/mcmod_gametest.py`, and two copies of a full project name in
  `tools/fix_wall_assets.py` that nothing scanned, because the check only looked at `panel/`.
- **The vendored engine was stale and had broken line endings.** `build.mjs` vendors the `mc-art`
  clone, which was one commit behind, so the package would have shipped **without the Windows entry
  points added in `mc-art` `2d1912d`** — the original "the tool cannot be found" defect, unfixed.
  And because that clone had `core.autocrlf=true` while `mc-art` had no `.gitattributes`, the POSIX
  launcher was vendored with CRLF (53 CR bytes) and could not run under bash at all.

### Added

- **`mc-art` has a `.gitattributes`** pinning line endings per path — including the extensionless
  `bin/mc-art text eol=lf`, which `*.sh` cannot match. Verified by cloning with
  `core.autocrlf=true`: the launcher arrives byte-identical to the clean tree.
- **`tools/mcart-plugin/batch-page-test.js`** — a page with one bad slot still returns, with the bad
  slot marked and the others intact; the reverse fixture must be **rejected by the same check the
  real runtime uses**, not by a new assertion.
- **`tools/mcart-plugin/encoding-test.js`** — every Python subprocess must set UTF-8 mode and be
  decoded as UTF-8; eight mutants (drop `encoding`, drop `-X utf8`) are all caught.
- **`tools/check-tracked-private.mjs`** — scans **`git ls-files`**, not a hand-written directory
  list, because that list was the reason `tools/` and `examplemod/` were never checked. Private names
  fail anywhere; a third-party name fails only in code — a comment is a citation, not a leak.
- **`tools/check-skill-content.mjs`** — every tool path a skill doc names must resolve from a root
  the reader could actually be standing in. This is the check that caught the stale vendored engine.
- **Vendor provenance and an EOL policy.** `panel/.vendor-state.json` records which commit was
  vendored; `verify-build` compares it against the source and refuses when the snapshot is behind.
  Line endings are normalised at copy time, so a package can no longer depend on whoever cloned it.

### Changed

- Vendored `mc-art` snapshot: `fc32714` → `427fd01`.

## 0.2.2

### Added

- **The last look is mandatory.** Rendering is not finished when the gates are green: the sprite must
  be magnified beside the reference the plan *actually attached* (and the family's contact sheet for
  a family), and three questions answered **in words** — does it read as what it is, is it ugly, does
  it look like the same game as vanilla. Any "no" sends it back to the plan. The skill states outright
  that a green `audit` is not an answer to those three questions, with this project's own three
  rejected deliveries as the worked example.
- **`unaudited_accent`.** After rendering, the *picture* is scanned with a criterion independent of
  every declaration (a pixel's chroma against its own local median) and diffed against the audited
  accent set; paint that stands out but was never measured is an error, reported with count,
  coordinates and colours. It exists because it happened here: the ingot carried a leftover
  hand-drawn `pixel_map` band while the audit counted a 5-pixel derived set, so **two rounds tuned
  numbers while the picture stayed wrong**. A plan declaring **both** `pixel_map` and
  `accent_from_reference` now warns at render time.
- **`accent_base_gap`** — is the accent *set into* its material or pasted on? A **signed** band centred
  on vanilla's own measurement (vanilla `iron_ore`'s specks sit **+12.24** luma brighter than their
  stone; band 6…24). Both directions go red: too loud (`+47.7`, "pasted on rather than set in") and
  reversed (`−7.9`, "on the WRONG SIDE — darker than its base where vanilla is brighter").

### Fixed

- **Each family member is measured with its own declared accent.** The family axes had been fed the
  *union* of every member's accent colours, so each member was judged against colours it never
  declared. Proven on identical sprites: saturation span `0.3928 → 0.0749`, hue span `6.5° → 1.7°`,
  with not one pixel of art changed.
- **Accent consistency now applies only to members that declare an accent.** Vanilla never shared one
  accent between an ore and its ingot; binding the ingot to the ore's amber was enforcing a rule this
  project invented. The metal members are judged on the material axes instead.
- **The ore deposits are embedded, and the gap was a luma problem, not a transition problem.**
  Vanilla's specks start 13 luma from their stone; ours started 83, which no amount of blending
  recovers. Each member's ramp is now pitched to its own base (signed gaps `+9.86 / +15.94`).
- **The ingot is material-axis**: cool grey metal with one faint warm light taken from
  `iron_ingot`'s own shading — not a warm patch on grey metal. `example_deepslate_ore` added, so the
  deep-layer ore vanilla pairs with its stone ore now exists too.

### Changed

- Vendored `mc-art` snapshot: `afa754f` → `fc32714` (199 tests, family build `EXIT=0`, 21 fault
  fixtures all red where they should be).

### Removed

- The `accent_edge_max` waiver the ore used to carry: with the deposits embedded, it passes on the
  family's own limit again.

## 0.2.1

### Fixed

- **An accent is no longer allowed to be a pasted band.** A cluster that fills ≥ 75 % of
  its bounding box *and* is ≥ 1.8 : 1 elongated is rejected — its outline has nothing to
  do with the form it lies on. The rejected 17-pixel, 7×3, 81 %-filled bar is kept as the
  gate's red fixture.
- **A declared limit can no longer be widened quietly.** A plan whose threshold is looser
  than the engine's reference *and* whose product only passes because of it is an error,
  unless `appearance.threshold_waiver` says why — and it is reported either way. (The
  ingot's `accent_edge_max` had been raised 60 → 90 to let its own 83.24 through.)
- **A reference that is on disk but not attached to the plan is now an error.** The new
  `reference_pool` stage scores every candidate the reference root holds against the one
  the plan attached; an unattached candidate that scores higher is
  `REFERENCE AVAILABLE BUT UNUSED`, unless `descriptor.reference_waiver` explains it.
  In this repository's own example family that is exactly what had happened: `iron_ore`
  and `raw_iron` were extracted and never attached, and the ore's specks had been
  hand-drawn crosses.
- **Three structure gates**, calibrated against vanilla rather than guessed: motif repeat
  (one stamp used several times), layout regularity (cluster centres on a grid) and ramp
  use (a cluster sitting in one value level). Vanilla `iron_ore`'s own specks pass all
  three comfortably; the rejected deliveries are the fixtures.
- The example family is rebuilt on real references: the ore overlays **`iron_ore`'s own
  pixels** on the stone base (the base is byte-identical to `example_stone` outside the
  61 accent pixels), the raw lump takes `raw_iron`'s contour under `appearance_only`, and
  the ingot's highlight is taken from **`iron_ingot`'s own lighting**
  (`accent_from_reference`: brightest 22 % of its luminance, mapped down a four-stop
  ramp) instead of a drawn band.
- Contact sheets state provenance honestly: one tile per reference **the plan actually
  attached** (`example_ore <- stone`, `example_ore <- iron_ore`), plus a red
  `AVAILABLE, NOT USED` column for anything left behind.
- `mc-mod`'s `art-direction.md` gained §3, "the reference must be *mounted* into the plan,
  not just present on disk", and the rule that a hand-written `pixel_map` is not a
  substitute for a reference.

### Changed

- Vendored `mc-art` snapshot: `7e95b70` → `afa754f` (196 tests passing).

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
