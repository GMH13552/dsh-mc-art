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

### 1.4 Shallow vs deep, concretely (the deep-material bug)

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

## 3. The reference must be *mounted* into the plan, not just present on disk

Being on disk is not enough. Measured on a real project: the reference root had exported
five vanilla references — the `stone` and `deepslate` families plus an ore and its raw
and ingot forms — and yet the ore's plan mounted **only one of them**, while the
raw-ore plan mounted **none at all** (`"references": []`) even though the matching PNG
sat right beside it. The engine's own artifacts recorded it honestly (an `offered` count
of 1, `0 other candidate(s)`); nobody read them, nothing warned, and the ore's specks
were hand-written `pixel_map` instead. The user's reaction was: "this still does not
match the ore — was it even referenced?"

Checkable rules:

1. **"Does this asset have a vanilla same-kind thing?" is the first question, before
   anything is drawn.** Ores, raw forms, ingots, tools, armour, logs, stone: almost
   everything does. If it does, that reference **must** be mounted in the plan's
   `references`, with a role (`shape` / `material` / `pixel_style`). Having looked at it
   and drawn from memory is **not** mounting it.
2. **"On disk but not in the plan" is an error, not a choice.** If a same-kind reference
   exists in the reference root (or the plan's `refs/`) and you did not mount it, you are
   inventing the shape out of nothing. Either mount it, or write down why not — and that
   reason must be reported **prominently in the render summary**, not buried.
3. **Do not use `pixel_map` as a substitute for the reference.** Hand-written pixels are
   for the layer the reference cannot give you — where the accent goes, and how much of
   the surface it may take (§6). Using them to draw an ore's specks or an ingot's sheen
   produces exactly the "same stamp four times" and "one abrupt colour block" the user
   complained about. **Shape and value come from sampling the reference** (`pattern` /
   `value`); the hand-written part is only the final accent.
4. **Read the engine's own count.** When the render summary reports how many references
   were offered and how many other candidates exist, that number is the evidence. One
   mounted reference where several same-kind candidates exist is the smell.
5. **Self-check before delivery.** If the asset looks like a vanilla same-kind thing,
   ask: "side by side with that vanilla asset, can someone tell these are the same kind
   of thing with a different material?" If not, the reference was never connected.

## 4. When the panel cannot draw a block: read the report first

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

## 5. Gradients and bands, not scattered dots

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

## 6. The accent colour has a budget

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

## 7. The edge between two colours is part of the shape

Two family members whose colours meet (a warm hue next to a cold one, a bright top next
to a dark body) must not meet at one hard pixel. Put an intermediate value at the
boundary; the eye then reads a transition instead of "how abrupt can you make it". The
measurement behind the judgement: `audit --accent-edge-max` is the largest accepted
accent-to-base step, and the isolated-pixel share across the boundary stays low.

## 8. The family boundary: what must look alike, and what must not

| must look alike | must not be forced alike |
|---|---|
| a stone and its ore (shared background, palette, noise scale) | two different materials, on purpose |
| slab / stairs / wall / bricks from one set (same palette and noise, different silhouette) | a decorative block and a structural one |
| the variants of one family (cracked, mossy, polished) | anything from a different layer or biome |

**A colour-only request is a colour-only change.** If the user asked for the colours to
match, the shape must stay pixel-identical: measure the silhouette before and after, it
must not move. Changing the shape while claiming to fix the colour is the fastest way
to lose trust ("只要求颜色对称，结果形状也被改了").

## 9. Block entities and UV: "is this really a table?"

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

## 10. The look-at-it checklist (stage 6)

- the rendered sheet at 100% and zoomed;
- the whole family side by side;
- a wall of it (tiling), not one block;
- in the dark and in the light;
- in the running game, next to the vanilla blocks it will stand beside.

Then write one sentence about what is wrong with it. "Looks fine" is not a check.
The checklist below produces the input; the **verdict** is the section after it.

## 最后一眼：和原版并排，回答三个问题

**Mandatory once the render is green — not an optional extra.** Every gate in §5–§7 can
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
is "this does not look like the vanilla thing I mounted", suspect
`appearance.reference_sampling` before touching `pixel_map`: `pattern` keeps the source's
value rhythm (grain, mottling) and retints it while **retaining roughly 40% of the
source's own colour**, `value` transfers brightness only, and `none` paints from your
ramp alone. `part_reference_sampling` overrides per part and `part_reference_sources`
binds a part to one named image. A wrong sampling mode is why a mounted reference can
leave no visible trace at all. Measured in the engine's own notes: a bright crystal
palette over the vanilla wooden bow stayed dark wood-green with `pattern`, and read as
translucent crystal with `value`.
