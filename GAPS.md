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

### 1. Shape layer path / bezier authoring
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

### 2. Puppet pin / mesh deformation
No exposure of the Puppet tool (pins, mesh, starch) at all. This is a
distinct AE subsystem from shape/mask paths.
**Value**: niche — only matters for character/organic deformation work.
**Cost**: high — Puppet's scripting API is thin and mesh data is awkward to
generate programmatically without visual placement.

### 3. Layer styles (drop shadow, glow, stroke, bevel)
Classic AE "Layer Styles" (right-click → Layer Styles) are a separate
subsystem from Effects — not covered by any existing effects tooling
(`add-any-effect`, `set-effect-property`, etc., which target the Effects
stack, not styles).
**Value**: medium — common for text/lower-third polish (drop shadow, glow)
that's currently only reachable via effects-stack equivalents.
**Cost**: low-medium — Layer Styles are exposed via `layer.property("ADBE
Layer Styles")` groups, similar shape to existing effect-property code
already in the bridge.

### 4. Time remapping / speed ramps on a layer
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

### 5. Frame-index (not just seconds) parameter on `see-frame`/`contact-sheet`
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

Ranked by value-for-effort, most promising first:

1. **Time remapping / speed ramps** (#4) — real motion-design demand, and
   the implementation is likely cheaper than it looks since it can reuse
   the existing property/keyframe helpers once `timeRemapEnabled` is set.
2. **Layer styles** (#3) — common polish need, moderate cost, same shape as
   existing effect-property code.
3. **Frame-index convenience param** (#5) — trivial to add, low but real
   value; a good "while we're in there" addition alongside #1 or #3 rather
   than its own block.
4. **Shape layer path authoring** (#1) — higher value if you have a
   concrete shape-animation use case in mind; higher cost, so worth
   confirming the use case first (same discipline used before building
   `batch-set-expression`).
5. **Puppet pin / mesh** (#2) — lowest recommended priority: niche use
   case, high implementation cost, thin scripting API to build against.
