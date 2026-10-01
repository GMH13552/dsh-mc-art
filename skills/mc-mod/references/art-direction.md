# Art direction: the part a tool cannot do

The engine rasters and measures; it does not know what the thing is for. These are the
decisions the model owns — and the measurements that check them, because "it looks
right to me" is not a check either.

The engine's CLI is the `mc-art` skill's (`$M` below); that skill carries the full
command surface. `$M` exits non-zero when a declared gate is violated, so a measurement
can be a gate rather than a paragraph.

Everything marked *measured* below was measured on one machine with the vanilla assets
of one game version; treat the numbers as "what the reference family does", not as
constants of nature.

## 1. Choosing the reference (the mistake that started all of this)

A reference is a **decision**, not a lookup. Two textures can share a name root and
belong to different families: a deep-layer stone and a shallow-layer stone are both
"stone". Sampling the wrong one is not a small miss — the new block then reads as the
wrong material next to its neighbours, and no gate can see that.

### 1.1 The procedure: name the class, then pick from the class

"It feels like the same kind of thing" is not a step. These four are:

| # | do this | leave this behind |
|---|---|---|
| 1 | **Name the class.** Ask: in vanilla, what kind of thing is this? — base field stone / deep-layer variant / ore host rock / brick / polished stone / planks / glass / metal / organic / decoration. The class is what makes two references interchangeable; the name is not. | the class, as words |
| 2 | **List the candidates the class offers**, from the reference root, not from memory: `$M list-groups --source <reference dir or jar> --filter <class word>` | the candidate list you actually looked at |
| 3 | **Mount it and declare it** in the plan's `references`, with roles (`shape`, `scale`, `material`, `palette`, `pixel_style`; the engine also has a UV-layout role and a `negative` role for "not this one"). A reference with no role is a picture, not an instruction. | the reference entry |
| 4 | **Verify what actually loaded.** `$M why-reference --plan <plan.json>` prints the candidate table and the chosen entry (`--json` for a tool); a render writes the same report to `outputs/<name>/reference_selection.json`. Read it — do not trust your memory of what you mounted. | the loaded name and the step that chose it |

**Where the class is written.** The engine is adding a declared class on the reference
entry. Until that field exists, the class must be the **first sentence of that
reference's `note`**, in one fixed shape: `class: deep-layer field stone`. A note whose
first sentence is not a class is not a decision — it is prose.

**Notes are machine-read.** The engine scans a reference's `note` for wording that
*forbids* that reference ("must not be chosen", "belongs to another family" applied to
itself) and will fail the plan when the note's own layer/name matches the reference it
is attached to. Write notes as **positive statements** about what the reference is
(`class: deep-layer field stone — the correct layer for this asset`); a negative
sentence you copied from another plan can forbid the reference you actually wanted.

### 1.2 Notes are derived, never copied (three failures that shipped)

Real plans, neutralised names, same shapes:

| the failure | the rule it broke |
|---|---|
| `example_mist_stone`, a shallow-layer block, mounted a **deep-layer** reference, while its own note said the shallow variant must not be chosen | **a note may not contradict the reference it is attached to** |
| `example_shallow_stone`'s note was copied whole from the deep block's plan. The sentence is true for the deep block and false for the shallow one, so the note argued against its own correct choice | **never copy a note between plans** — derive it from *this* plan's class |
| an ore plan's note claimed "this is the same reference the stone plan uses", while the stone plan used a different one | **never claim agreement with another plan without checking**; a false sentence in a note is a false claim inside a deliverable |
| the shallow block was not in the design documents at all: the asset itself was invented, and its reference was invented with it | **every asset in a plan must have a provenance in the design docs** (`DESIGN.md` / `CONTENT.md`); if it is not there, **ask the user** |

The last row is the root cause of the others: **an asset made up on the spot gets a
reference made up on the spot.** Fix the asset list before touching the references.

### 1.3 The checklist that still holds

1. **Same version** as the build target. The reference root's version and the project's
   version must agree (`workflow.md` stage 0).
2. **Same layer and light regime**: what the player sees it next to matters more than
   the alphabetical name.
3. **Close in value and saturation** to the family it must join — measure the
   difference, do not judge it by eye.
4. **Prefer a member of the same family already in the project** (`includeGenerated`).
   A new block should join the set, not restart it.
5. **Never reference a placeholder.** Legacy/placeholder assets are removed before
   authoring; if one is still in the project it will be found and copied (`traps.md`).

Write down the class, the reference and the frame, and why. That sentence is the
evidence that a human made this choice.

### 1.4 Layer matching is bidirectional

A deep-layer block must not sample a light surface stone — **and a surface block must
not sample a deep-layer stone.** Both directions make the new block read as the wrong
material beside its neighbours, and neither is visible to a gate. Measured: the
deep-side error and the surface-side error were each made in a different plan.

The axis is value and temperature, not the name:

- **A family member already in this project wins.** If the project already has a dark
  stone-family block, sample *that*; a new block should join the set.
- The deep family is **darker and cooler** — lower mean value, hue away from the warm
  end. The surface family is lighter and warmer, and usually has a coarser noise.
- **Measure it before you commit.** Compare the candidates' mean value and hue with the
  block the new one will stand beside (the engine's `measure` reports per-sprite
  statistics; `audit --family` gates a set on its hue and value spread). A candidate
  whose mean value sits on the wrong side of that axis is the wrong family even when the
  name matches.

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

`audit --family` gates a set on its hue and value spread, so "the family drifted"
becomes a failing command instead of an opinion.

## 3. Mounted is not used

Having a reference on disk is not the same as mounting it, and mounting it is not the
same as using it. Measured on a real project: the reference root had exported the
vanilla ore family, yet the ore's plan mounted only one of them, the raw-ore plan
mounted none (`"references": []`), the engine's own artifacts said so (`offered: 1`,
`0 other candidate(s)`), and the ore's specks were hand-written `pixel_map` instead. The
engine records the count; nobody read it.

**Three levels of "using a reference":**

| level | what you took | verdict |
|---|---|---|
| name only | you matched the name and drew from memory | wasted the reference |
| geometry | you took positions/silhouette (coordinates, contour) | half |
| structure | you took its value grammar, material and shape syntax, then recoloured | complete |

**The judgement:** put the deliverable next to the reference and **say out loud what you
took from it**. If the answer is "the idea", the reference was decoration.

Rules that follow from this:

1. **Put the same-kind reference in the plan**, with a role (`shape` / `material` /
   `pixel_style`). "I looked at it and drew from memory" is not mounting it.
2. **"On disk but not in the plan" is an error, not a choice.** If a same-kind reference
   exists in the reference root (or the plan's `refs/`) and you did not mount it, you are
   inventing the shape out of nothing. Either mount it, or write down why not — and that
   reason must be reported **prominently in the render summary**.
3. **Do not use hand-written pixels as a substitute for the reference.** They are for
   the layer the reference cannot give you — where the accent goes, and how much of the
   surface it may take (§9). Using them to draw an ore's specks or an ingot's sheen
   produces the "same stamp four times" and "one abrupt colour block" the user
   complained about. Shape and value come from sampling the reference; the hand-written
   part is only the final accent.
4. Read the engine's own count in the render summary: one mounted reference where several
   same-kind candidates exist is the smell.

## 4. Measure the reference set before drawing anything

**This is the step that saves the most time.** A real session burned seven rounds
tuning an ore's accent brightness; one minute spent measuring the eight vanilla ores
first would have shown that the number being tuned was the wrong number entirely. The
user's own words: "there are lots of references — compare them".

### 4.1 Colour: mean, extremes and spread

For every same-kind vanilla asset, measure the **mean, max, min and standard deviation**
of its values, and compare them with your draft. Measured: a draft ingot had max 173.7 /
sd 27.8 against a reference ingot's **255 / 61.9** — a third of the contrast, which is
what "flat, as if it was never coloured" looks like as a number. Also compare the
**fraction of isolated pixels** and the **step** between neighbouring values; for tools
the vanilla reference sits at **47–59 % isolated with steps 71–81** (they are thin,
high-contrast pixel art on transparency), so a block-face threshold applied to a tool
will reject a perfectly good tool.

**Never hand-compute lightness.** The engine uses a perceptual luma (Rec.709 weights),
not the average of R/G/B; hand arithmetic produced three different wrong answers in one
session. Render once and read the engine's own reported accent/base numbers.

### 4.2 Shape grammar: measure the shape, do not invent it

Colour is only half of "does it look like the family". The other half is **shape
grammar**: how many clusters, how big, how solid, how thick, how many value levels
inside each. Measured across seven vanilla ores (per face):

| property | measured range |
|---|---|
| clusters per face | **6–9** |
| pixels per cluster | **4–29** |
| fill ratio (pixels ÷ bounding area) | **0.70–0.84** — solid blobs, not lines |
| maximum thickness | **5–9 px** |
| value levels inside one cluster | **2–5** |

Those five numbers are the shape contract of that class. Find 5–10 same-kind
references, measure them the same way, and **copy their common shape** — do not invent
a shape that "looks about right". Two ways this goes wrong, both measured: copying the
reference's pixel coordinates by hand (a few points lost, and the cluster degrades into
a one-pixel-wide line), and stamping an identical shape on every centroid (crosses or
3×3 blocks — a rubber stamp, which the engine's motif-repeat and layout gates exist to
catch). The right move is to reuse the reference's own cluster outlines, which are
already irregular and of different sizes, recolour them, and set the value by the
pixel's rank from the cluster centre.

### 4.3 Thresholds come from the class, not from the last asset

A threshold is a measurement of some class of asset. Applying it to a different class is
how a correct picture gets rejected. Two measured examples:

- **Tools vs block faces**: an item plan with a block-face isolated-pixel limit reported
  10.16 % and failed; the vanilla tools measure 47–59 % isolated, so the *limit* was the
  problem, not the picture.
- **A stone that carries bright specks must itself have value range.** Vanilla `stone`
  tops out around 143; a bright ore speck jumps to ~198. A "flat, bright stone + bright
  ore specks" combination cannot pass the edge gate — and the gate is right: the
  reference that works for this (a vanilla ore) uses a **darker, more varied stone base**
  whose p90 is ~147 and whose max is pulled to ~198 by the specks.

### 4.4 Write the measurement as a tool, not as an inline command

Measuring is repeated work; put it in a small script and keep it (a tool that prints
mean/max/sd per sprite, a colour-composition dump, a cluster-grammar measurement, a
contact sheet). Three rules that were learned the hard way:

- **Write a `.py` file; do not inline Python in the shell** — on Windows the quoting
  layers eat it (four failures in one session), and the file is reusable.
- **A top-N colour list cannot answer "is it all there?"** Print all colours matching a
  filter, or the full composition; showing only the six most common colours hid two of
  three value levels and produced a completely wrong analysis.
- **Build a tool that reproduces the engine's view** when a gate complains: read the
  sprite and the plan, recompute what the engine computes (which pixels match the
  declared colours, the connected clusters, the value bins per cluster), and print the
  clusters the engine would reject. It found in one run what several rounds of reading
  error messages had not — including one case where the engine blamed the picture for
  something a hand-written post-processing step had removed.

## 5. Gates: which one applies, and where its number comes from

### 5.1 Ask first: does this gate measure what I want?

| decision | owner |
|---|---|
| is this picture good-looking | model / human (look at it) |
| did I violate a gate I declared | engine (numbers) |
| **does the gate I declared measure the thing I want** | **model / human — asked once, before starting** |

The third row is not optional. The signature failure: an engine default that was
calibrated for one class of asset was treated as the hard target for another class, and
six rounds went into moving a number that was never the problem. Before tuning anything,
ask **what the number is measuring and for which class it was measured**, then decide
whether it is your target at all.

### 5.2 Which band applies to which asset class

The accent-to-base contrast band has a default (**6..24**) that was measured from an
**item-scale decoration** — historically from the *mean of a whole ore cluster*, which
averages a high-contrast ore into a mid-contrast number. So:

| asset class | where its accent/base band comes from |
|---|---|
| accent decoration on an item (a mark, a rune) | the engine default **6..24** is the right scale |
| **ore / vein** | **declare `accent_base_gap_min` / `accent_base_gap_max` from the measured vanilla ore range (−76..+107)**, or keep the default and write `threshold_waiver` explaining why |
| plain block (no accent) | `accent_budget: 0` — there is no band to argue about |

Measured on seven vanilla ores, the accent-to-base gap runs from **−75.7 to +106.6** —
none of them is inside 6..24, and both signs occur (some specks are darker than the
base, some much brighter). **Direction matters more than magnitude.**

Do not try to dodge the band by declaring `accent_colors: []`: the engine rescans the
render independently and reports the accent-looking pixels that **no gate measured**
(`unaudited_accent`). The fix is the band, not the declaration. And the colours you
declare must equal the colours the plan actually draws, hex for hex — a mismatch leaves
pixels unmeasured and lets the rest merge into a large same-colour cluster, which
surfaces as an unrelated ramp error.

### 5.3 Declarable in the plan vs fixed in the engine

| you can declare (in the plan) | fixed in the engine |
|---|---|
| `accent_budget`, `accent_colors`, `accent_min_cluster`, `accent_cleanup`, `accent_edge_max` | `ramp_level_step` = **16.0** — the luma bin width. It is the one number here that is **not** in the plan contract, so it cannot be declared. |
| `accent_base_gap_min` / `accent_base_gap_max` — the accent/base band; **defaults 6.0 / 24.0** (the item band) | |
| the ramp gates, in the plan's `appearance` block: `accent_ramp_min_pixels` (**default 6**), `accent_ramp_min_levels` (**default 3**), `accent_ramp_max_dominant_share` (**default 0.6**) — set one to `null` and that check is simply not run | |
| `threshold_waiver` — a written reason unlocks a widened limit | |
| `band_maximum_isolated`, `band_maximum_step` | |

The defaults are a starting point, not a target: they were measured on some class of asset,
and your class may need different numbers (§5.2, §6). `null` means "do not check this" — a
declarable act, not a silent edit. (The engine has one further ramp gate that requires a
judged cluster's value steps to mostly run in one direction; it is declarable the same way.)

Read the engine's function signatures once (about twenty lines) instead of approximating
the defaults by trial and error: rendering ten times is more expensive than reading.

### 5.4 What those numbers mean in practice

- **`ramp_level_step` = 16.0 (fixed)**: the engine bins each pixel's luma into 16-wide
  buckets, so two declared value levels that land in the same bucket count as **one**.
  Measured: three levels at 11 / 14 / 20 counted as two levels. "I declared three levels" is
  not the same claim as "three levels are visible" — space them by more than one bucket.
- **`accent_ramp_min_pixels` (default 6)**: clusters smaller than six pixels are not judged
  for levels at all. That is why a vanilla single-colour speck is legal, and why forcing
  three levels onto a two-pixel dot is wasted effort (and usually makes the field look more
  broken).
- **`accent_ramp_min_levels` (default 3) / `accent_ramp_max_dominant_share` (default 0.6)**:
  a judged cluster must show at least three value levels, and no single level may own more
  than 60 % of it — that is what "the deposit uses only 1 level" is complaining about.
- **The monotone ramp gate (default 0.6)**: a judged cluster's value steps must mostly run
  in one direction; a deposit that steps up and down at random is refused.
- **Setting any of these to `null` turns that check off.** Prefer declaring a value measured
  on the class; if you do turn one off, say why — a *widened* limit without a reason is
  itself rejected (§5.8).
- **`accent_min_cluster` counts same-colour clusters**, not "same accent": a bright core
  ringed by a darker shade is, topologically, its own one-pixel cluster. It is a gate
  (what will be refused), not a repair; repairing needs the explicit cleanup switch.

### 5.5 The engine's own words, translated

The engine's error strings are the user's complaints in another language. Learn the
mapping:

| the engine says | the user means |
|---|---|
| "pasted on rather than set in" | 突兀 — it juts out of the surface |
| "on the WRONG SIDE" | the accent is darker than the base where it should be lighter (or the reverse) |
| "too faint: smeared into the base" | 看不出来 — there is no distinction |
| "uses only N value level(s) of the declared M" | the deposit looks flat |
| "one deposit shape appears N times" | 太有规律 — it looks stamped |

### 5.6 Two classification rules that come before any tuning

- **Material or decoration?** Material (ink on paper, wood grain, wear on metal) belongs
  in the part's own `colors`; only **decoration** (a mark, ore specks, a gem) belongs in
  `accent_colors`. Declaring ink as an accent makes a correct picture fail the
  decoration gates ("this cluster uses only one level"), and the error sends you looking
  at the drawing instead of the classification.
- **The palette is a gradient, so it must be monotonic.** The `value` sampling mode
  treats the colour list as a gradient in list order; appending the darkest colour at
  the end inverts the mapping. Measured: ink appended to the end of a paper ramp
  produced a white-outlined, black-filled sheet. Order the list by luma.

### 5.7 Distinctness and abruptness are two different axes

Use **hue and saturation** to make a new block recognisable, and **keep its value
aligned with its neighbours**. Measured: a mist stone with saturation 4.6 % against the
vanilla stone's 0.0 % was "indistinguishable from ordinary stone"; raising the value to
create separation produced "too abrupt in too many places". The version that worked kept
the value at 122.7 (vanilla 125.5) and moved saturation to ~17 % and hue to ~211° — and
the family audit's hue spread went green (0.3°) at the same time.

### 5.8 You cannot widen a limit quietly

The engine notices when a declared limit is looser than its reference value and refuses
to pass on it silently: it prints a `DECLARED LIMIT RELAXED` line naming the declared
value, the engine reference and the measured value, and demands either a
`threshold_waiver` with the reason or the original value back. When a check fails,
**add content or declare why the check does not apply** — do not lower the check.

## 6. Per-asset-class success criteria

Read the row for the class you are making **before starting**; then answer §5.1's third
question for that row.

| class | numbers that decide success | numbers that are **not** the target |
|---|---|---|
| **plain field block** | family hue/value spread (`audit --family`); band structure (isolated share, band count); `accent_budget: 0`; tile-edge margin ≥ 1 px (§12) | the accent/base band (there is no accent) |
| **ore / vein** | accent/base gap band declared from this class's measured reference range; cluster count / size / fill ratio / thickness / levels against the shape contract (§4.2); edge margin ≥ 1 px; the host stone has its own value range | the engine's default 6..24 band; "accent pixel count" as a proxy for looking like ore |
| **tool / item** | silhouette comes from the reference (`appearance_only`); isolated share and step measured from vanilla tools (47–59 %, 71–81); max/sd contrast against the reference; palette monotone | block-face thresholds; value or gap bands meant for block decoration |
| **armour** | everything for tools, plus per-part silhouettes and piece-to-piece consistency (family audit over the set) | per-sprite accent budgets where there is no decoration |
| **entity** | UV layout boxes; every opaque texel lands inside a declared UV region; silhouette and face readability from the reference | per-pixel accent budgets and tiling margins |
| **block entity / custom model** | real model boxes; texture authored in UV space; separate UV regions per material; nothing in the pack when the game draws the shape | tiling margin (a model face is not a tiled block face) |

Two cross-cutting notes:

- A "success number" is only a target if it was measured **on this class**; otherwise it
  is a reference, not a gate (§4.3).
- **Say what you did not verify.** Every row has a human half (readability, taste) that
  no number covers — that half is the last look (§14 and 最后一眼).

## 7. When the panel cannot draw a block: read the report first

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

## 8. Gradients and bands, not scattered dots

Per-pixel independent randomness reads as static. A material reads as a material when
its variation has **structure**:

- pick an axis (vertical is usual for a wall, radial for a round object) and a small
  number of value steps along it;
- put the variation in **bands and clusters** — connected regions — not single pixels;
- reserve single pixels for deliberate detail (a chip, a rivet), never for the field.

Measurable, so a script settles the argument:

| measurement | what good looks like |
|---|---|
| isolated-pixel share (pixels differing from all four neighbours) | near zero inside a field — `audit --max-isolated <0..1>` |
| value trend along the chosen axis | mostly monotonic, few reversals |
| value histogram | a few modes (bands), not one flat blob |
| family hue/value spread | inside the family span you declared with `$M audit --family` |

## 9. The accent colour has a budget

"One or two pixels jut out" is a budget problem:

- **One accent hue per family.** The accent is how the eye finds the special part; a
  second accent hue spends that attention twice and reads as noise.
- **The accent covers roughly a tenth of the surface at most** — ore specks, an inlay,
  a lit edge. Declare the budget and let the engine enforce it:
  `$M audit <sprite.png> --accent-color <hex> --base-color <hex> --accent-budget <pixels>`
  (a budget of `0` is valid — a plain block has no accent).
- **Accent clusters are connected.** An ore vein is a cluster or a short band, never
  confetti: `accent_min_cluster` rejects deposits smaller than what you declared.
- **Keep the value range tight** — about two or three steps for one family — so the
  family reads as one material.

## 10. The edge between two colours is part of the shape

Two family members whose colours meet (a warm hue next to a cold one, a bright top next
to a dark body) must not meet at one hard pixel. Put an intermediate value at the
boundary; the eye then reads a transition instead of "how abrupt can you make it". The
measurement behind the judgement: `accent_edge_max` is the largest accepted
accent-to-base step, and the isolated-pixel share across the boundary stays low.

## 11. The family boundary: what must look alike, and what must not

| must look alike | must not be forced alike |
|---|---|
| a stone and its ore (shared background, palette, noise scale) | two different materials, on purpose |
| slab / stairs / wall / bricks from one set (same palette and noise, different silhouette) | a decorative block and a structural one |
| the variants of one family (cracked, mossy, polished) | anything from a different layer or biome |

**A colour-only request is a colour-only change.** If the user asked for the colours to
match, the shape must stay pixel-identical: measure the silhouette before and after, it
must not move. Changing the shape while claiming to fix the colour is the fastest way
to lose trust ("只要求颜色对称，结果形状也被改了").

## 12. Tiling safety for block faces

A block face is not a picture, it is a tile: a motif that touches the 0/15 rows or
columns will show a **half motif** on every neighbour, which reads as a seam. Measured
across the vanilla ores: six of seven keep **0 edge-touching pixels and a 1-pixel
margin**; the seventh touches with one pixel and has no margin. Treat "margin ≥ 1 px" as
the family's own rule, not as fussiness.

- It applies to **block faces** that tile.
- It does **not** apply to crosses/plants or to block-entity model faces — those are not
  tiled faces, and enforcing it there rejects correct art.
- **The engine has no gate for this yet.** Until it does, this is a model/human check:
  measure the margin (a small script, §4.4) or look at a wall of the block, not one tile.

## 13. Block entities and UV: "is this really a table?"

"Dark wood table with a paper on it" is not a plank texture with two extra strokes. If
the thing has geometry the player walks around, it needs:

- a **model** with real boxes;
- a texture **authored in UV space** — each face points at the UV region drawn for it;
- separate UV regions for parts that are different materials (the paper is not the
  table's planks).

The engine can assign the UV layout and then check that what you painted actually lands
inside it (`entity` / `uv`, and the `pack` step for multi-face assets) — that check is
what turns "it is probably a table" into a verdict.

**But `uv_regions` is for atlases and block faces, not for items or entities.** Measured:
carrying a `uv_regions` block from a block template into an item plan silently switched
off contour fitting, so `appearance_only` did nothing and the item rendered as a fully
opaque square (**0 transparent pixels**, where the vanilla reference has most of the
canvas transparent). If `shape_edit_mode` is `appearance_only` or
`preserve_silhouette`, do not declare `uv_regions`; check the transparent-pixel count
when you look at the result.

## 14. The look-at-it checklist (stage 6)

- the rendered sheet at 100% and zoomed;
- the whole family side by side;
- a wall of it (tiling), not one block;
- in the dark and in the light;
- in the running game, next to the vanilla blocks it will stand beside.

Then write one sentence about what is wrong with it. "Looks fine" is not a check.
The checklist above produces the input; the **verdict** is the section after it.

## 最后一眼：和原版并排，回答三个问题

**Mandatory once the render is green — not an optional extra.** Every gate in §5 can
pass while the thing is still ugly, and that is exactly how rejected versions ship with
all their numbers in range. "I looked at it" is not this step: this step produces three
written answers.

1. **Put the delivered sprite next to the reference it actually mounted, both zoomed.**
   For a family, look at the whole contact sheet, not one member. Reading them separately
   is not looking at them together.

2. **Answer three questions in writing**, in the delivery note:
   - **读得出来是什么吗?** — is it readable as the thing: an ore reads as an ore, an
     ingot as an ingot, a table as a table.
   - **丑不丑?** — is it ugly? Judge it by "a player will look at this hundreds of
     times", not by "there is no error in it".
   - **和原版并排，像同一个游戏里的东西吗?** — next to vanilla, does it look like it
     belongs to the same game? Note what is *not* being asked: not "is it like the
     reference I mounted", but "is it the same art style at all". A faithful copy of a
     reference that still looks foreign has failed this question.

3. **Any "no" sends you back to the plan; do not ship.** One bit per question —
   "mostly" is a no.

4. **Counter-example discipline, written down.** `audit` and `style_report.json` being
   green is **not** the answer to those three questions; they answer only "did you cross
   a declared line". Measured: three consecutive versions shipped with every gate green
   and every declared number inside budget, and the user rejected all three. That is what
   treating a measurement as a taste costs.

**"Mounted" is not the same as "the reference did anything".** If the side-by-side answer
is "this does not look like the vanilla thing I mounted", suspect the sampling mode
before touching hand-written pixels: `pattern` keeps the source's value rhythm (grain,
mottling) and retints it while **retaining roughly 40 % of the source's own colour**,
`value` transfers brightness only, and `none` paints from your ramp alone.
`part_reference_sampling` overrides per part and `part_reference_sources` binds a part
to one named image. A wrong sampling mode is why a mounted reference can leave no visible
trace at all. Measured in the engine's own notes: a bright crystal palette over the
vanilla wooden bow stayed dark wood-green with `pattern`, and read as translucent
crystal with `value`.
