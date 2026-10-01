# Traps

Each entry: **symptom → cause → fix → how it was found.** They are here because each
one cost real time and none of them announce themselves. They generalise: the point
is the *shape* of the failure, not the specific line of code.

## Data and contracts

**"Every flat item says the model chain is missing something."**
→ `item/generated` parents to `builtin/generated`, which is built into the game: it
is in no pack, no jar, no mod. Reporting it as missing is a warning about something
that cannot be fixed.
→ Treat `builtin/*` as the end of the chain, not as a missing file.
→ Found by reading the jar: `item/generated.json` says `"parent": "builtin/generated"`
and `namelist` has no `builtin/` entry at all.

**"The project's item has no icon, but the same item in the jar is fine."**
→ An unqualified `parent` means `minecraft:` — a project pack does not ship the
vanilla bases, so the chain dead-ends unless the **game root** is also given.
→ Pass **two roots**: the project pack first, the game root second.
→ Found by listing project items with one root and comparing with the reference.

**"The icon looks wrong in the game too, and nobody noticed."**
→ The item model pointed at geometry with no `display.gui` (a `block/cross`): drawn
flat-on and cut in half. Vanilla's own flower items put `item/generated` in front of
the block texture for exactly this reason.
→ Fix the **pack** (`item/generated` + `layer0` = the block texture). A warning in
the UI is not a fix.
→ Found by rendering the icon and comparing it with the source sprite, pixel by pixel.

**"A block exists but is invisible / nameless."**
→ The block id in `blockstates` and the item id in `models/item` disagreed, or the
lang key was `item.` where the game asks for `block.`.
→ Make the ids equal and the key match the presentation; an assertion in a game test
is the durable fix.

## Rendering and UI

**"Every sprite on a plane is split down the middle / stretched."**
→ A UV was interpolated perspective-correctly under an **orthographic** camera.
Perspective-correct maths assumes a divide by depth; an orthographic camera has none,
so every face with depth across it is warped (a cube slightly, a diagonal cross
badly).
→ Add an explicit `orthographic` flag to the rasteriser and use affine interpolation
there; keep the perspective path for the world camera.
→ Found by measuring stripe widths on a depth-slanted face: 31/32 px even vs 16…45 px
warped (2.81×).

**"Clicks paint the wrong pixel; it gets worse when the panel is wider."**
→ The element's *box* is not its *picture*: `object-fit:contain` plus a `max-height`
scale the picture to fit and centre it, leaving margins. Mapping the box maps the
margins too.
→ Compute the **drawn rectangle** first (`scale = min(boxW/imgW, boxH/imgH)`, centre
offset), then map inside it. When the box already matches the aspect this reduces to
the naive formula.
→ Found by measuring: clicking the picture's left edge landed on cell 4 instead of 0.

**"Half of the grid icons are blank and it is always the non-block items."**
→ The flat-icon path pasted a **live `<img>` element**, and the panel removes those the
moment a texture's pixels are decoded. Cubes were unaffected because they draw from the
decoded pixel buffer.
→ Make both paths read only decoded pixels. Then no DOM lifecycle can blank an icon.
→ Found by rendering with the node list emptied: 0 painted pixels for flat items vs
2744 for a cube.

**"The view looks frozen after selecting something."**
→ Selecting an asset with no scene (an item-only material) cleared the scene but the
render effect returned early **without clearing the canvas**, so the previous model
stayed on screen and rotation/zoom appeared dead.
→ Clear the viewport when there is nothing to draw, and say why underneath.
→ Reported by a user as "the 3D froze"; the fix is measurable (painted pixels → 0).

## Art and reference

**"The new block does not look like its neighbours, and it is not obvious why."**
→ The reference was chosen by **name**, not by family: a deep-layer block sampled a
shallow-layer texture because both are called "stone".
→ Choose by role, layer and value (`art-direction.md` §1); prefer a member of the
family that is already in the project.
→ Found by rendering the family side by side: the new sheet's background and palette
were unrelated to its siblings.

**"One or two pixels jut out / the ore looks like confetti."**
→ Per-pixel randomness instead of structure, and an accent with no budget.
→ Bands and connected clusters, one accent hue per family, accent share around a tenth
of the surface at most (`art-direction.md` §2–3).
→ Found by measuring: isolated-pixel count high, accent share far above the budget.

**"I only asked for the colours to match, and the shape changed too."**
→ "Make the colours match" was read as "redraw it", so the silhouette moved.
→ A colour-only request leaves the shape **pixel-identical**; measure the silhouette
before and after and show it did not move.
→ Found by diffing the two silhouettes; they were not equal.

**"The old placeholder is in the new texture."**
→ A leftover placeholder asset was still in the project and was picked up as a
reference (`includeGenerated` makes that easy).
→ Delete placeholders before authoring; if one is found, say so instead of shipping its
shapes.
→ Found by comparing the new texture with the placeholder's silhouette.

**"Dark wood table with a paper on it — is that really a table?"**
→ The block entity had no model of its own: the plank texture was edited instead, so the
3D view showed a plank with a mark on it.
→ Give it a model with real boxes and a texture authored in **UV space**, with separate
UV regions for parts that are different materials (`art-direction.md` §6).
→ Found by opening it in the 3D view and asking the question out loud.

## Process and tooling

**"The exit code says 1, so one test failed."**
→ No: a compile failure also exits non-zero. `forceExit` (default true) can also
flatten the verdict to 0.
→ Require log evidence that tests ran, cross-check the code against the log's count,
and never call a compile failure a test failure.

**"A check passes, so it must be fine."**
→ Look at how the check is written for evidence, not for structure: a check that
asserts on *code text* is not a check, and an injection that does not change behaviour
is decoration. Two examples from the work that produced this skill: an "injection"
that only renamed a key, and one that read a property without calling it.
→ For every claim, name the fault that would make it fail, then inject it.

**"The fixture breaks the next test in the file."**
→ A test that wrote into a shared fixture (a settings file) and deleted it afterwards
took the reference root away from every later test.
→ Tests that touch shared state must **restore it exactly** and assert the restore.

**"The build takes 26 minutes."**
→ First run only: Gradle + loader artifacts + ~450 MB of game assets. Warm caches make
it ~1 minute. Budget for the first one, and do not read a slow first run as a failure.
