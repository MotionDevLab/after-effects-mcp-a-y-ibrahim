# Agent instructions for after-effects-mcp-a-y-ibrahim

This repo is an MCP (Model Context Protocol) server that lets an AI agent
drive Adobe After Effects: a TypeScript server (`src/index.ts`) exposing
`server.tool(...)` registrations, talking to an ExtendScript ScriptUI panel
bridge (`src/scripts/mcp-bridge-auto.jsx`) via a file-based command/result
protocol. `CONTEXT.md` at the repo root is the living spec/decision log for
this fork - read it before making non-trivial changes; it documents design
decisions, known bugs, and known limitations that aren't obvious from the
code alone.

## Known gotcha: `compIndex` means two different things

This codebase has a real, documented inconsistency: the `compIndex`
parameter used by many tools does **not** mean the same thing across all
of them. Two incompatible resolution semantics coexist:

1. **Raw-positional** - `compIndex` = the item's raw 1-based position in
   the *whole* Project-panel item list (folders, footage, comps, all
   counted together). Unstable: After Effects auto-creates folders (e.g.
   "Solids") as a project grows, silently shifting a comp's raw position.
2. **Comp-ordinal** - `compIndex` = the Nth *composition specifically*
   (only comps counted), with `compName` checked first and the active comp
   as a final fallback.

The same composition can require a **different** numeric `compIndex`
depending on which tool is called - and this fails silently (you get a
valid-looking result, just for the wrong composition), not with an error.

**The rule**: prefer `compName` over `compIndex` whenever a tool accepts
it - most do. Never reuse a `compIndex` value across different tools
without re-resolving it first via `getProjectInfo`. If a tool only accepts
`compIndex` (no `compName` alternative), resolve it fresh immediately
before the call, using the counting rule for *that specific tool*.

**Raw-positional tools (no `compName` alternative)**: `setLayerKeyframe`,
`setLayerExpression`, `get-expression`, `enable-expression`,
`add-expression-control`, `apply-expression-template`, `get-keyframes`,
`offset-keyframes`, `scale-keyframe-timing`, `reverse-keyframes`,
`apply-easy-ease`, `create-text-animator`, `set-effect-property`,
`set-effect-keyframe`, `list-layer-effects`, `remove-effect`,
`set-audio-levels`, `apply-effect`, `add-any-effect`,
`apply-effect-template`, `add-marker`, `get-audio-info`, `center-layers`,
`get-layer-clip-frames`, `link-properties`, `copy-keyframes`.

**Comp-ordinal, `compName`-preferring - already safe, just use
`compName`**: `duplicate-layer`, `delete-layer`,
`set-composition-properties`, `set-layer-mask`,
`batch-set-layer-properties`, `duplicate-composition`,
`delete-composition`, `add-light-layer`, `precompose-layers`,
`reorder-effects`, `copy-effects`, `delete-marker`, `set-work-area`,
`create-lower-third`, `create-title-card`, `create-transition`,
`create-logo-reveal`, `localize-comp`, `create-camera`, `inspect-comp`,
`inspect-layer`, `animate-to-audio`, `animate-from-data`,
`batch-set-expression`, `set-time-remap`.

`test-animation` bypasses the bridge dispatcher entirely (writes a
manual-run `.jsx` temp file) and isn't part of the maintained tool
surface - don't rely on its `compIndex` behavior for anything.

Full inventory, exact resolution code per tool family, and why this was
mitigated with documentation rather than a full code refactor:
`CONTEXT.md`, "Known limitations" section.

## Working conventions in this repo

- One git branch per feature/tools block, stacked sequentially off the
  previous block's branch (not off `main`). Never merge without being
  explicitly told to.
- ScriptUI panels do not hot-reload - after `npm run build` +
  `npm run install-bridge`, the panel must be manually closed and reopened
  in After Effects (`Window > mcp-bridge-auto.jsx`) before new bridge code
  takes effect.
- Manual end-to-end tests live in `manual-tests/*.mjs` (MCP SDK client
  scripts run against a real, running After Effects instance). The
  established discipline: save and close the real/working project first,
  do all mutation/testing in a disposable scratch project, then reopen the
  real project and confirm its content is unchanged before finishing.
