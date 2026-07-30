# Gap analysis — motion design tools not yet covered

Written 2026-07-29. Companion to `CONTEXT.md` (which tracks decisions/specs
for work already done or explicitly deferred). This file is different: it's
a forward-looking list of capabilities that are **not tracked anywhere else**
in the repo — gaps found by comparing against repo A (MotionDevLab), repo B
(TheLlamainator), and ishu86, plus general AE-scripting capability that none
of the four repos expose.

Status per `CONTEXT.md`: every gap previously tracked against repo A, repo B,
and ishu86 is now closed (most recently `batch-set-expression`). Nothing
below is "the other repo has it and we don't" — these are gaps across **all**
sibling repos. Pick based on what's actually useful for real work, not
completeness for its own sake.

## Candidates

### 1. Shape layer path / bezier authoring — IMPLEMENTED 2026-07-29
Built as `set-shape-path` + `get-shape-path` (branch
`feature/shape-path-authoring`), plus a `set-layer-mask` retrofit
(`maskInTangents`/`maskOutTangents`/`maskClosed`/`time`). See `CONTEXT.md`'s
"SPEC: set-shape-path / get-shape-path" section for the full design and the
live P1-P10 feasibility findings.

**Correction to the cost estimate below**: "fiddly but well-trodden ground"
undersold two real traps that only showed up live, not in the AE scripting
docs: (1) AE does not validate `Shape.vertices`/`inTangents`/`outTangents`
array-length agreement - it silently zero-fills the mismatch instead of
erroring, so validation had to move client-side (`src/lib/shape-path.ts`);
(2) a property reference obtained from a vector group is invalidated by any
later `addProperty` call on that same group (`ReferenceError: Object is
invalid`), which crashed the first version of the feasibility probe before
the bridge handler was written to resolve the Path property only after every
`addProperty`. Neither is mentioned anywhere in Adobe's scripting guide.

Confirmed *not* a repeat of the layer-styles block (item #3): `"ADBE Vector
Shape - Group"` and mask paths are both fully writable, keyframable, and
tangent-capable, verified live before any production code was written.

Original assessment (kept for reference):
No tool creates or edits a shape layer's vector path (vertices, in/out
tangents) directly. Existing mask tools (`set-layer-mask`) can apply a mask,
but nothing lets an agent draw or reshape a bezier path from data (e.g.
"create a shape layer tracing these 6 points" or "add a rounded-corner rect
path"). Relevant for logo reveals, custom shape animation, generative
line-art.
**Value**: high if shape-layer work is a real use case; otherwise unused.
**Cost**: medium-high — bezier path authoring in ExtendScript (`Shape`
object, `vertices`/`inTangents`/`outTangents` arrays) is fiddly but
well-trodden ground.

### 2. Puppet pin / mesh deformation — INVESTIGATED 2026-07-30: already covered, no new tool needed
Verified live (branch `feature/puppet-pin-investigation`) against a real
puppet-pinned layer in the user's working project (a layer with the
Advanced Puppet engine and 6 pins already placed by hand in the AE UI).

**Good news, unlike the layer-styles block**: once a mesh/pins exist,
Puppet shows up as an entirely ordinary effect - `layer.Effects` contains
`"Puppet"` (matchName `"ADBE FreePin3"`) - and its properties are fully
readable AND writable through the tools this repo already has
(`list-layer-effects`, `set-effect-property`, `add-any-effect`). No
"hidden property" restriction like Layer Styles had. Confirmed:
- `list-layer-effects` (`includeProperties: true, includeValues: true`)
  walks all the way down through `Puppet` -> `"ADBE FreePin3 ARAP Group"`
  -> `"ADBE FreePin3 Mesh Group"` -> `"ADBE FreePin3 Mesh Atom"` ("Mesh 1")
  -> `"ADBE FreePin3 PosPins"` ("Deform") -> each pin (`"Puppet Pin 1"`
  .. `"Puppet Pin 6"`), each with real `Position`/`Scale`/`Rotation` values
  and `canSetExpression: true`, `canVaryOverTime: true` - the same
  writable-property signature every other scriptable property in this
  codebase shows (Layer Styles showed the opposite).
- `set-effect-property` successfully wrote to a pin's Position (verified
  with a fully reversible test: toggle an identity expression on, confirm
  `expressionEnabled: true` with the value unchanged, then toggle it back
  off - avoided touching the user's real hand-placed mesh/keyframes).
  Setting `value`/`timeInSeconds` to keyframe pin motion follows the exact
  same call shape already used for every other effect property.

**One real gotcha to document**: a pin's property-GROUP matchName
(`"ADBE FreePin3 PosPin Atom"`) is **shared by all pins** - it does not
disambiguate which pin. You must select the specific pin by its **display
name** (`"Puppet Pin 1"`, `"Puppet Pin 2"`, ...) as one segment of
`propertyPath`, then the matchName again for the property within it
(e.g. `"ADBE FreePin3 PosPin Position"`). Example working path used in the
live test:
```
["ADBE FreePin3 ARAP Group", "ADBE FreePin3 Mesh Group",
 "ADBE FreePin3 Mesh Atom", "ADBE FreePin3 PosPins",
 "Puppet Pin 1", "ADBE FreePin3 PosPin Position"]
```

**Still not scriptable, confirmed by AE's own scripting model (not tested
live, no code path exists to test)**: creating the mesh itself - placing
pins, triangulating - has no ExtendScript API. That step still requires a
human using the Puppet Pin tool interactively in the AE UI. This gap is
therefore scoped narrower than originally written: not "no puppet
exposure at all," but specifically "no way to *create* a puppet mesh" -
*animating* one that already exists needs zero new code.

**Conclusion: no new tool built.** This isn't a code gap, it's a
documentation gap - closed by this entry. Anyone wanting to animate an
existing puppet-pinned layer can already do so today via
`list-layer-effects` (to enumerate pins and read current values) and
`set-effect-property` (to keyframe a pin's Position/Scale/Rotation over
time), following the property-path pattern above.

Original assessment (kept for reference):
No exposure of the Puppet tool (pins, mesh, starch) at all. This is a
distinct AE subsystem from shape/mask paths.
**Value**: niche — only matters for character/organic deformation work.
**Cost**: high — Puppet's scripting API is thin and mesh data is awkward to
generate programmatically without visual placement.

### 3. Layer styles (drop shadow, glow, stroke, bevel) — INVESTIGATED, BLOCKED 2026-07-29
Classic AE "Layer Styles" (right-click → Layer Styles) are a separate
subsystem from Effects — not covered by any existing effects tooling
(`add-any-effect`, `set-effect-property`, etc., which target the Effects
stack, not styles).

**Verified live (branch `feature/layer-styles-tool`, since deleted) that
this cannot be built via AE's scripting API, on this AE build (2026,
26.0x67)**: a read-only `list-layer-styles` tool worked fine (the group
`layer.property("ADBE Layer Styles")` is statically populated with all 11
children - Blending Options, the 9 real style types, plus Pattern Overlay -
each with real values readable). But writing is blocked entirely:
- `canSetEnabled` is `false` for the master `"ADBE Layer Styles"` group
  **and every individual style child** (Drop Shadow, etc.) - confirmed on
  text, solid, AND shape layers (not layer-type-specific).
- Attempting to set a value on a style's own child property (e.g. Drop
  Shadow's Opacity), even without touching `.enabled` at all, also fails:
  `"Can not 'set value' with this property, because the property or a
  parent property is hidden."`

This is a real Adobe ExtendScript API restriction, not a bug in this
codebase or a fixable resolution-logic problem: Layer Styles can only be
toggled/configured through the After Effects UI, not scripted, at least on
this build. The original cost estimate below (based on the shape looking
similar to Effects tooling) turned out to be wrong precisely because of
this - the shape is similar, but the write path is closed off entirely.

**Not pursued further**: applying a pre-saved `.ffx` animation preset with
a style baked in (via `layer.applyPreset()`, mirroring `apply-effect`'s
`presetPath` option) might be a workaround, but wasn't investigated - it
would require shipping/creating preset assets rather than fully
programmatic control, a different shape of tool than planned, and the
underlying "hidden property" restriction might still block reading back or
adjusting values afterward. Revisit only if this becomes worth the
research time - not blocking anything else.

Original assessment (kept for reference):
**Value**: medium — common for text/lower-third polish (drop shadow, glow)
that's currently only reachable via effects-stack equivalents.
**Cost**: low-medium — Layer Styles are exposed via `layer.property("ADBE
Layer Styles")` groups, similar shape to existing effect-property code
already in the bridge.

### 4. Time remapping / speed ramps on a layer — IMPLEMENTED 2026-07-29
Built as `set-time-remap` (branch `feature/time-remap-tool`). See
`CONTEXT.md`'s "SPEC: set-time-remap" section for the full design writeup.

**Correction to the cost estimate below**: this note originally assumed
the existing `_resolveLayerProperty`/keyframe helpers "can likely already
handle" Time Remap once enabled. That turned out to be wrong —
`_resolveLayerProperty` only searches Transform Group/Effect Parade/Text
Properties, and Time Remap (`"ADBE Time Remapping"`) is a top-level
`AVLayer` property outside all three, requiring direct `layer.property(...)`
access instead. Cost was still low-medium in practice, just not for the
reason originally guessed.

Original assessment (kept for reference):
Distinct from the existing keyframe-manipulation suite (`offset-keyframes`,
`scale-keyframe-timing`, etc.), which retime keyframes on a *named
property* the caller already has. Nothing enables/animates a layer's own
`timeRemapEnabled` + time-remap stopstream (freeze frames, speed ramps,
ease-in/out on playback speed itself).
**Value**: medium-high — speed ramps are a common motion-design ask and
current tools can't do it at all (not even manually via `setLayerKeyframe`,
since the time-remap property doesn't exist until `timeRemapEnabled` is
turned on).
**Cost**: low-medium — mostly `layer.timeRemapEnabled = true` then treating
the resulting property like any other keyframed property, which the
existing `_resolveLayerProperty`/keyframe helpers can likely already handle
once the property exists.

### 5. Frame-index (not just seconds) parameter on `see-frame` — IMPLEMENTED 2026-07-29
Added a `frameNumbers` param to `see-frame` (branch `feature/frame-index-param`),
combinable with the existing `times` param. `contact-sheet` was scoped out -
it only ever accepts a `count` (auto-sampled evenly across the duration),
not an explicit list of positions, so a frame-index alternative doesn't
apply there. Conversion happens bridge-side, in `seeFrame()`
(`mcp-bridge-auto.jsx`), using the resolved comp's own `frameRate` -
`frameNumber / comp.frameRate` - right before the existing clamp-and-collect
loop, so it shares the same clamping and rendering path as `times`.
Verified via `manual-tests/frame-index-param-test.mjs` against the real
project's "Comp 1" (29.97 fps, a genuine non-round rate): `frameNumbers`
alone, `times` alone, and both combined in one call all returned the
expected image counts.

Original assessment (kept for reference):
Minor, not a missing tool — an ergonomics gap. `see-frame`'s `times` param
is in seconds; there's no `frameNumber` alternative. On non-round frame
rates (23.976, 29.97) a caller has to do the `frame / frameRate` conversion
themselves, which invites off-by-one-frame rounding errors.
**Value**: low — easy workaround exists (compute seconds yourself), but a
`frameNumbers` option would remove a whole class of caller error.
**Cost**: very low — thin wrapper converting frame index → seconds using
the comp's own `frameRate`, right before calling the existing
`saveFrameToPng` path.

## Not on this list (deliberately)

- **`compIndex` semantic standardization** — already tracked and
  deliberately deferred in `CONTEXT.md` ("Known limitations") until a real
  incident occurs, not a completeness gap.
- **Template-introspection tool** (ishu86 idea) — already assessed and
  rejected as low-value in the expression-suite spec (only 6 templates,
  already documented in schema).

## Recommendation

Ranked by value-for-effort, most promising first. Updated 2026-07-29 after
item #1 (shape path authoring) was implemented and verified live:

1. ~~**Time remapping / speed ramps** (#4)~~ — **done**, see
   `set-time-remap` in `CONTEXT.md`.
2. ~~**Layer styles** (#3)~~ — **investigated, blocked**: AE's scripting
   API doesn't support enabling/configuring Layer Styles at all
   (`canSetEnabled: false` everywhere, confirmed live). Not buildable as a
   write tool; see the corrected assessment above.
3. ~~**Frame-index convenience param** (#5)~~ — **done**, see
   `see-frame`'s `frameNumbers` param above.
4. ~~**Shape layer path authoring** (#1)~~ — **done**, see
   `set-shape-path`/`get-shape-path` in `CONTEXT.md`.
5. ~~**Puppet pin / mesh** (#2)~~ — **investigated, no new tool needed**:
   animating an existing puppet mesh is already fully covered by
   `list-layer-effects`/`set-effect-property`, confirmed live. See the
   corrected assessment above for the working property-path pattern.

All five tracked candidates are now resolved (three shipped as new tools,
one confirmed already covered by existing tools, one confirmed blocked by
AE's own scripting API). Nothing is currently tracked here; new gaps
should be added as they're found rather than manufacturing work against
this list for completeness.
