---
name: ae-mcp-compindex-safety
description: Use before calling any After Effects MCP tool that takes a compIndex parameter, or before reusing a compIndex value captured from a different tool call in this repo. This codebase has two incompatible compIndex semantics across its own tools - using the wrong one silently targets the wrong composition instead of erroring.
---

# compIndex safety for this repo's After Effects MCP tools

This fork (`after-effects-mcp-a-y-ibrahim`) has a real, documented
inconsistency: **`compIndex` does not mean the same thing across all of its
own tools.** Two different resolution semantics coexist:

1. **Raw-positional**: `compIndex` = the item's raw 1-based position in the
   *whole* Project-panel item list (folders, footage, comps, everything).
   Unstable across a session - After Effects auto-creates folders (e.g.
   "Solids") as a project grows, which shifts a comp's raw position without
   anything about the comp itself changing.
2. **Comp-ordinal**: `compIndex` = the Nth *composition specifically*
   (comps only, folders/footage don't count), with `compName` checked
   first and the active comp as a final fallback.

The same composition can require a **different numeric `compIndex`**
depending on which tool you call. This fails silently, not loudly - you get
a valid result back, just for the wrong composition.

## The rule

- **Prefer `compName` over `compIndex` whenever a tool accepts it.** Most
  tools do. This sidesteps the whole problem.
- **Never reuse a `compIndex` value across different tools without
  re-resolving it.** A `compIndex` captured for one tool (e.g. via
  `getProjectInfo`, or returned by another call) may mean something
  different to the next tool you call.
- If a tool only accepts `compIndex` (no `compName`), call `getProjectInfo`
  immediately beforehand and resolve the index fresh, using the counting
  rule for *that specific tool* (see below) - don't assume yesterday's or
  even five-tool-calls-ago's value still points at the same comp.

## Quick reference: which family is a given tool in?

**Raw-positional (whole item list, no `compName` alternative)** -
`setLayerKeyframe`, `setLayerExpression`, `get-expression`,
`enable-expression`, `add-expression-control`, `apply-expression-template`,
`get-keyframes`, `offset-keyframes`, `scale-keyframe-timing`,
`reverse-keyframes`, `apply-easy-ease`, `create-text-animator`,
`set-effect-property`, `set-effect-keyframe`, `list-layer-effects`,
`remove-effect`, `set-audio-levels`, `apply-effect`, `add-any-effect`,
`apply-effect-template`, `add-marker`, `get-audio-info`, `center-layers`,
`get-layer-clip-frames`, `link-properties`, `copy-keyframes`.

**Comp-ordinal, `compName`-preferring - already safe** - `duplicate-layer`,
`delete-layer`, `set-composition-properties`, `set-layer-mask`,
`batch-set-layer-properties`, `duplicate-composition`,
`delete-composition`, `add-light-layer`, `precompose-layers`,
`reorder-effects`, `copy-effects`, `delete-marker`, `set-work-area`,
`create-lower-third`, `create-title-card`, `create-transition`,
`create-logo-reveal`, `localize-comp`, `create-camera`, `inspect-comp`,
`inspect-layer`, `animate-to-audio`, `animate-from-data`. For these, just
pass `compName` and skip the problem entirely.

**Not part of the maintained tool surface** - `test-animation` bypasses
the bridge dispatcher and writes a manual-run `.jsx` temp file; don't rely
on its `compIndex` behavior for anything.

## Full detail

The complete inventory, exact resolution code for each family, and the
reasoning for why this was documented-and-mitigated rather than fixed with
a full refactor: `CONTEXT.md`, "Known limitations" section (search for "A
second, different `compIndex` semantic also exists").
