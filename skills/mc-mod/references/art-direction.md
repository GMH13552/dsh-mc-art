# Art direction: the part a tool cannot do

The engine rasters and measures; it does not know what the thing is for. These are the
decisions the model owns — and the measurements that check them, because "it looks
right to me" is not a check either.

The engine's CLI is the `mc-art` skill's (`$M` below); that skill carries the full
command surface. `$M` exits non-zero when a declared gate is violated, so a measurement
can be a gate rather than a paragraph.

## 1. Choosing the reference (the mistake that started all of this)

A reference is a **decision**, not a lookup. Two textures can share a name root and
belong to different families: a deep-layer stone and a shallow-layer stone are both
"stone". Sampling the wrong one is not a small miss — the new block then reads as the
wrong material next to its neighbours, and no gate can see that.

Checklist, in order:

1. **Same version** as the build target. The reference root's version and the project's
   version must agree (`workflow.md` stage 0).
2. **Same role**: structural field / ore / decorative / organic / man-made.
3. **Same layer and light regime**: what the player sees it next to matters more than
   the alphabetical name.
4. **Close in value and saturation** to the family it must join — measure the
   difference, do not judge it by eye.
5. **Prefer a member of the same family already in the project** (`includeGenerated`).
   A new block should join the set, not restart it.
6. **Never reference a placeholder.** Legacy/placeholder assets are removed before
   authoring; if one is still in the project it will be found and copied (`traps.md`).

Write down which reference and which frame, and why. That sentence is the evidence
that a human made this choice.

### Shallow vs deep, concretely (the deep-material bug)

A deep-layer block that samples the surface stone is the canonical failure. It happens
because the tool lists what *exists* and both are called stone; the choice is yours, and
here is how to make it non-arbitrary:

- **A family member already in this project wins.** If the project already has a dark
  stone-family block, sample *that*; a new block should join the set.
- **The axis is value and temperature, not the name.** The deep family is **darker and
  cooler** — lower mean value, hue away from the warm end. The surface family is lighter
  and warmer, and usually has a coarser noise.
- **Measure it before you commit.** Compare the candidates' mean value and hue with the
  block the new one will stand beside (the engine's `measure` reports per-sprite
  statistics; `audit --family` gates a set on its hue and value spread). A candidate
  whose mean value sits on the wrong side of that axis is the wrong family even when the
  name matches.
- **The forbidden case, written plainly:** a dark deep-layer block **must not** sample
  the light surface-stone group, and "they share a word" is not a reason.

## 2. Pointing the reference root — and what a wrong one does

The value lives in one place: `<project>/mc-art.settings.json` →
`reference.directory` (the panel's `⚙ 参考目录` writes that field). Read it; do not
guess what it points at.

**Checks, in order, before drawing anything:**

1. **The path really exists.** Ask the panel's `atlas.gameRoots`: it returns the places
   it looked (`candidates`) and the roots it really **detected** (`detected`). Adopt one
   of the detected ones, or a path you have verified on disk. **Never type a guessed
   path into the box** — a path that does not exist produces "no art", not a warning
   you can act on.
2. **It must hold readable assets**: a version jar
   (`versions/<version>/<version>.jar`), or a `mods/` directory with jars, or an
   unpacked `assets/<namespace>/…` tree. The engine treats all three as valid.
   **Prefer the version directory** `.minecraft/versions/<version>`, because it pins the
   version. Pointing at `.minecraft` itself only works when exactly one version under
   it resolves, and the host's own failure text says: point at
   `.minecraft/versions/<version>`, not at `.minecraft` itself.
3. **The version must equal the build target** (`workflow.md` stage 0). Art read with
   one version's rules and code compiled against another is a silent mismatch.
4. **List the candidates before choosing.** The engine can enumerate the logical names a
   root actually offers — a list is evidence, memory is not:

   ```bash
   $M list-groups --source <reference dir or jar> --filter <keyword> --limit 20
   $M list-groups --source <reference dir or jar> --category <category> --namespace <ns>
   ```

**What a wrong reference produces** (the panel's diagnostic names these `reason`s):

| what you see | what it means | the fix |
|---|---|---|
| `no-reference-directory` | nothing is set for this project | set it (step 1–2) |
| `reference-jar-missing` | the path exists but holds no readable jar or asset tree | fix the path; do not start authoring |
| `vanilla-parent-missing` | readable, but that parent is not in this version's jar | a version mismatch, not a broken project |
| family drift (the new sheet's background/palette differs from its siblings) | the wrong family was sampled | re-pick by role/value (§1), then `$M audit --family` |

`audit --family` gates a set on its hue and value spread (defaults: 26° and 56°), so
"the family drifted" becomes a failing command instead of an opinion.

## 3. When the panel cannot draw a block: read the report first

The panel returns a **structured** diagnostic, not a sentence: a `reason`, a `missing[]`
list where each entry is `kind: 'project'` or `kind: 'vanilla'` and carries the path to
create, and a `tried[]` list of the real paths it walked.

- `kind: 'project'` → **the project's own model file is absent**; create it at the path
  the report gives (`pack/assets/<ns>/models/block/<id>.json`). Do **not** edit `parent`.
- `kind: 'vanilla'` → a vanilla parent the model needs is not in the reference version;
  check the reference (and its version) rather than the project.
- `no-reference-directory` → nothing can be read at all; fix §2 first.
- `parent-cycle` → the model chain loops; it is a project-side error.

Measured on a real project once: of 45 blocks, **28 could not be drawn**, and the first
version of the report blamed "missing vanilla parent" when the truth was that the
project's own model file was missing. The report format was the bug and it is fixed —
but the lesson stands: **when something cannot be drawn, read the report before changing
anything, and never "fix" it by editing `parent` on a hunch.**

## 4. Gradients and bands, not scattered dots

Per-pixel independent randomness reads as static. A material reads as a material when
its variation has **structure**:

- pick an axis (vertical is usual for a wall, radial for a round object) and a small
  number of value steps along it;
- put the variation in **bands and clusters** — connected regions — not single pixels;
- reserve single pixels for deliberate detail (a chip, a rivet), never for the field.

Measurable, so a script settles the argument:

| measurement | what good looks like |
|---|---|
| isolated-pixel share (pixels differing from all four neighbours) | near zero inside the field — `audit --max-isolated <0..1>` |
| value trend along the chosen axis | mostly monotonic, few reversals |
| value histogram | a few modes (bands), not one flat blob |
| family hue/value spread | inside `audit --max-hue-span` / `--max-value-span` |

## 5. The accent colour has a budget

"One or two pixels jut out" is a budget problem:

- **One accent hue per family.** The accent is how the eye finds the special part; a
  second accent hue spends that attention twice and reads as noise.
- **The accent covers roughly a tenth of the surface at most** — ore specks, an inlay,
  a lit edge. Declare the budget and let the engine enforce it:
  `$M audit <sprite.png> --accent-color <hex> --base-color <hex> --accent-budget <pixels>`
  (a budget of `0` is valid — a plain block has no accent).
- **Accent clusters are connected.** An ore vein is a cluster or a short band, never
  confetti: `--min-cluster <pixels>` rejects deposits smaller than what you declared.
- **Keep the value range tight** — about two or three steps for one family — so the
  family reads as one material.

## 6. The edge between two colours is part of the shape

Two family members whose colours meet (a warm hue next to a cold one, a bright top next
to a dark body) must not meet at one hard pixel. Put an intermediate value at the
boundary; the eye then reads a transition instead of "how abrupt can you make it". The
measurement behind the judgement: `audit --accent-edge-max` is the largest accepted
accent-to-base step, and the isolated-pixel share across the boundary stays low.

## 7. The family boundary: what must look alike, and what must not

| must look alike | must not be forced alike |
|---|---|
| a stone and its ore (shared background, palette, noise scale) | two different materials, on purpose |
| slab / stairs / wall / bricks from one set (same palette and noise, different silhouette) | a decorative block and a structural one |
| the variants of one family (cracked, mossy, polished) | anything from a different layer or biome |

**A colour-only request is a colour-only change.** If the user asked for the colours to
match, the shape must stay pixel-identical: measure the silhouette before and after, it
must not move. Changing the shape while claiming to fix the colour is the fastest way
to lose trust ("只要求颜色对称，结果形状也被改了").

## 8. Block entities and UV: "is this really a table?"

"Dark wood table with a paper on it" is not a plank texture with two extra strokes. If
the thing has geometry the player walks around, it needs:

- a **model** with real boxes;
- a texture **authored in UV space** — each face points at the UV region drawn for it;
- separate UV regions for parts that are different materials (the paper is not the
  table's planks).

The engine can assign the UV layout and then check that what you painted actually lands
inside it (`entity` / `uv`, and the `pack` step for multi-face assets) — that check is
what turns "it is probably a table" into a verdict. If the model does not exist, the
pack needs no texture at all — the game draws it (`contracts.md`).

## 9. The look-at-it checklist (stage 6)

- the rendered sheet at 100% and zoomed;
- the whole family side by side;
- a wall of it (tiling), not one block;
- in the dark and in the light;
- in the running game, next to the vanilla blocks it will stand beside.

Then write one sentence about what is wrong with it. "Looks fine" is not a check.
