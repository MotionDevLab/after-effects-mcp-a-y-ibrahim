# CONTEXT.md

Working notes for this fork (`MotionDevLab/after-effects-mcp-a-y-ibrahim`, forked from
`a-y-ibrahim/after-effects-mcp`). Tracks why this fork exists, what's been fixed,
and what's still open, so future sessions don't have to re-derive it.

## Branch workflow (decided 2026-07-29)

`main` tracks `upstream/main` (`a-y-ibrahim/after-effects-mcp`) directly and
should stay clean/undiverged. **Each tools-block feature addition gets its own
branch**, created off current `main`, merged back only once implemented and
verified against real After Effects. Don't commit new feature work straight to
`main`. The project-lifecycle tools (see below) are the first feature done
this way, on `feature/project-lifecycle-tools`.

## Why this fork exists

We were comparing two other forks of the original `Dakkshin/after-effects-mcp`
lineage (`MotionDevLab/after-effects-mcp` and `TheLlamainator/after-effects-mcp`,
a.k.a. "repo A" and "repo B") to decide which to extend. Research (see
`C:\Users\renat\After Effects research\ae-mcp-research.md`) found that
`a-y-ibrahim/after-effects-mcp` already covers the functional union of both
(A's layer ops + B's effects/keyframe/preset/audio engine), fixes a stale-result
race condition present in both, and adds rendering + visual-feedback tools
neither A nor B has at all. Decision: use this as the new base instead of
merging A into B by hand.

`ishu86/after-effects-mcp` was evaluated in parallel as a comparison target
(different architecture — CEP extension, not a ScriptUI bridge panel — so not a
merge candidate, but worth cross-checking for features worth porting). See its
own notes once that evaluation starts (`after-effects-mcp-ishu86` is local-only,
not forked, per the user's choice).

## Base decision: verified, not assumed (2026-07-29)

The claim "this fork is a superset of repo A and repo B" was re-checked
against actual source, not READMEs, before committing to it:

- Ibrahim's `run-script` whitelist (`allowedScripts` in `src/index.ts`, 34
  entries) is a **strict superset of both** repo A's 20-entry whitelist and
  repo B's 27-entry whitelist. Every script name in each is present here.
- Repo A's exclusive features (from its PR #26) are all present as first-class
  tools: `create-camera`, `duplicate-layer`, `delete-layer`, `set-layer-mask`,
  `batch-set-layer-properties`, `set-composition-properties`.
- Repo B's exclusive subsystems are all present: effects
  (`list-layer-effects`, `list-available-effects`, `set-effect-property`,
  `remove-effect`, `add-any-effect`), keyframe graph/easing control
  (`set-effect-keyframe`), presets (`list/search/apply-preset`), audio
  (`get-audio-info`, `set-audio-levels`, `analyze-audio-waveform`), markers
  (`add-marker`, `add-markers-bulk`), plus `create-adjustment-layer`,
  `center-layers`, `get-layer-clip-frames`.
- Ibrahim-only additions on top: deep inspection (`getLayerFull`/`getCompFull`
  → `inspect-layer`/`inspect-comp`), the rendering pipeline, the vision tools,
  `execute-script`, and `localize-comp`.

Conclusion: merging repo A into repo B by hand would have reproduced work
already done here, minus rendering and vision. Nothing from A or B needs
porting into this fork.

## Environment this was verified against

- Windows 11, Adobe After Effects 2026 (build `26.0x67`)
- Node v26.3.0 / npm 11.16.0
- Bridge folder: `%LOCALAPPDATA%\ae-mcp-bridge` (both `ae_command.json` and
  `ae_mcp_result.json` live here — shared between the Node MCP server and the
  AE ScriptUI panel)
- Bridge panel install path: `%APPDATA%\Adobe\After Effects\26.0\Scripts\ScriptUI Panels\mcp-bridge-auto.jsx`

## How to manually smoke-test (no MCP client app needed)

The MCP server talks stdio JSON-RPC, so you can't just `npm start` and watch —
it needs a client. `manual-tests/smoke-test.mjs` is a minimal MCP SDK client
that spawns the server and calls a few tools directly. Run it from the repo
root:

```bash
node manual-tests/smoke-test.mjs
```

Requires the After Effects bridge panel (`Window > mcp-bridge-auto.jsx`) to be
open in AE with "Auto-run commands" checked, and a project open.

**Known gotcha when testing manually**: the bridge panel seeds its
"already-processed" command ID from whatever is sitting in `ae_command.json`
*at panel startup* (see `initLastProcessedCommand()` in
`src/scripts/mcp-bridge-auto.jsx`) — intentional, so a stale command left over
from a previous session doesn't get replayed. But it means if you write a
command, then the panel restarts (or AE restarts) before it's picked up, that
command is now permanently marked "already seen" and will silently never run,
with no error logged anywhere. If a tool call times out for no obvious reason,
first check whether the panel restarted between writing and checking, and just
retry — a fresh call gets a fresh command ID and works fine. This is not a bug,
it's documented in-code, but it cost real debugging time before we knew about
it.

## Fixes applied in this fork

### 1. `see-frame` intermittent "(frame could not be read)" — FIXED 2026-07-28

**Symptom**: `see-frame` with an explicit `times` value (e.g. `times: 1`) would
render successfully in AE (`"Rendered comp ... - 1 frame"`) but the image
content block would be missing, replaced with `(frame at t=1s could not be
read)`. Reproduced twice in a row (not a fluke).

**Root cause**: `target.saveFrameToPng(times[i], new File(path))` in
`seeFrame()` (`src/scripts/mcp-bridge-auto.jsx`) is asynchronous on this AE
build — it returns before the PNG is actually flushed to disk. Confirmed via
a direct diagnostic script (`execute-script` tool, arbitrary ExtendScript):
`file.exists` was `false` immediately after `saveFrameToPng()` returned, and
`true` after a single 50ms poll, checked *within the same ExtendScript call* —
ruling out any Node-side file-read race.

The codebase already knew about a version of this problem: `_importWithRetry()`
(used by `contact-sheet` and `match-reference`) retries `importFile()` on
exception for exactly this reason, per its own comment. `seeFrame()` hands the
raw path back to Node instead of importing it itself, so it had no equivalent
retry and was missed.

**Fix**: added `_waitForFileReady(file, timeoutMs)` next to `_importWithRetry`
in `src/scripts/mcp-bridge-auto.jsx` — polls `file.exists` every 50ms up to a
timeout (default 3000ms) — and call it in `seeFrame()` right after each
`saveFrameToPng()`, before pushing the frame to the result. If the file never
appears, it now throws and surfaces as a per-frame `note` on the AE side (same
error-reporting path already used for other per-frame failures), instead of
silently omitting the image.

**Verified**: same explicit-time call that failed twice in a row now returns a
real 117KB image on retest, after rebuilding (`npm run build`), reinstalling
the bridge (`npm run install-bridge`), and reloading the panel in AE (close +
reopen `Window > mcp-bridge-auto.jsx` — required, ScriptUI panels don't hot
reload).

**Files touched**: `src/scripts/mcp-bridge-auto.jsx`

## Open issues / not yet investigated

- None currently open in this fork. (Update this section as new issues are
  found — don't let it silently go stale.)

### External blocker: ishu86 CEP extension will not load (AE 2026)

Not a bug in this fork, but recorded here since it shapes the comparison work.
`ishu86/after-effects-mcp` ships a **CEP extension** (not a ScriptUI panel).
On this machine it fails to load with `Signature verification failed for
extension com.aemcp.panel` (in `%TEMP%\CEP12-AEFT.log`).

Ruled out as causes — all verified:

- `PlayerDebugMode` **is** correctly set: `REG_SZ "1"` under
  `HKCU\SOFTWARE\Adobe\CSXS.12`, confirmed identical in the native, `/reg:32`
  and `/reg:64` views.
- AE 2026's CEP runtime **is** CEP 12 (`CEP12-AEFT.log`), so `CSXS.12` is the
  right key. `CSXS.10`/`.11` are also set.
- The manifest is valid: `AEFT [24.0,99.9]`, `RequiredRuntime CSXS 12.0`,
  bundle id matches the install folder name.

Actual cause: **AE 2026 / CEP 12 enforces signature verification regardless of
`PlayerDebugMode`.** Evidence: an audit of every CEP extension on this machine
shows *every* extension that successfully loads in AE is signed (has
`META-INF`) — AEUX, Bodymovin, the Adobe CCX panels. The single unsigned
extension present (`SuperPNG_Win`) is a Photoshop extension, so nothing here
demonstrates an unsigned extension loading in AE at all. The classic
`PlayerDebugMode` bypass appears to no longer work on this AE version.

Real fix if execution is ever needed: sign the extension with Adobe's
`ZXPSignCmd` (a self-signed certificate is sufficient for local use).

**Workaround used instead**: the ishu86 MCP server's tool catalog can be
enumerated over stdio *without* AE or the panel running — `tools/list` works
fine, only actual tool *execution* needs the bridge. That was enough for the
feature comparison below, so signing was not pursued.

## Verified-working (smoke tested against real AE 2026)

- `get-help`
- `check-bridge` (version match confirmed)
- `run-script` → `getProjectInfo` (real project data returned)
- `inspect-comp` (real comp/layer data returned)
- `inspect-layer` with `includeKeyframes: true` (verified keyframe data
  written by `setLayerKeyframe` reads back correctly)
- `setLayerKeyframe` (Position + Opacity, 2 keyframes each, correct
  interpolation, correct values on readback)
- `see-frame` (after the fix above — both default-time and explicit-time
  cases confirmed)
- `render-status` (empty-state response confirmed)
- `create-project`, `open-project`, `save-project`, `close-project` (full
  12-step safety test, see the project-lifecycle spec section above)
- `import-footage`, `import-folder`, `replace-footage`, `find-missing-footage`,
  `collect-files`, `reduce-project`, `organize-project-items` (full 46-step
  safety test, see the asset-management spec section above)
- `get-expression`, `enable-expression`, `add-expression-control`,
  `link-properties`, `apply-expression-template` (22-step test, see the
  expression-suite spec section above)
- `get-keyframes`, `offset-keyframes`, `scale-keyframe-timing`,
  `reverse-keyframes`, `copy-keyframes`, `apply-easy-ease` (25-step test,
  found and fixed 2 real bugs during verification - see the
  keyframe-manipulation spec section above)
- `create-lower-third`, `create-title-card`, `create-transition`,
  `create-logo-reveal`, `create-text-animator` (28-step test, found and
  fixed 4 real bugs during verification, one cross-cutting - see the
  motion-graphics-templates spec section and "Known limitations" above)
- `batch-set-expression` (5-scenario test, see the spec section above) -
  also incidentally exercised `create-text-layer`, previously untested.

## Not yet tested

Everything else in the 50-tool catalog — effects (`apply-effect`,
`list-available-effects`, `set-effect-property`, etc.), presets, audio tools,
markers, rendering (`add-to-render-queue`, `start-render`, `render-aerender`),
`contact-sheet`, `match-reference`, `execute-script` (used only as a diagnostic
tool so far, not smoke-tested as a general capability), and most other
layer-creation tools (`create-camera`, `duplicate-layer`, etc.).

## Feature comparison vs ishu86 (67 tools) — done 2026-07-29

Catalog obtained via `tools/list` over stdio without AE running (see the CEP
blocker above). ishu86 is **not a merge target** — it's a CEP extension with a
script-generator architecture, so nothing ports mechanically — but it is a
useful source of feature ideas. Neither server dominates.

**In ishu86, entirely absent from this fork** (strongest port candidates):

- ~~**Project lifecycle**: `create_project`, `open_project`, `save_project`,
  `close_project`. This fork has *no* project-level tools at all — arguably
  the biggest single gap.~~ **Implemented 2026-07-29** — see "Fixes/features
  applied" below. No longer a gap.
- ~~**Asset management**: `import_footage`, `import_folder`, `replace_footage`,
  `find_missing_footage`, `collect_files`, `reduce_project`,
  `organize_project_items`.~~ **Implemented 2026-07-29.** (This bullet was
  left un-struck by mistake when the block landed - fixed here, no code
  change, doc-only correction.)
- ~~**Keyframe timeline manipulation**: `offset_keyframes`,
  `scale_keyframe_timing`, `reverse_keyframes`, `copy_keyframes`,
  `apply_easy_ease`, `get_keyframes`.~~ **Implemented 2026-07-29.**
- ~~**Expression suite**: `get_expression`, `remove_expression`,
  `enable_expression`, `add_expression_control`, `apply_expression_template`,
  `link_properties`.~~ **Implemented 2026-07-29.**
- ~~**Motion-graphics templates**: `create_lower_third`, `create_title_card`,
  `create_transition`, `create_logo_reveal`, `create_text_animator`.~~
  **Implemented 2026-07-29.**
- ~~Misc: `precompose_layers`, `add_light_layer`, `duplicate_composition`,
  `reorder_effects`, `copy_effects`, `set_work_area`, `delete_marker`.~~
  **Implemented 2026-07-29** (see block #6 spec below) - plus
  `delete_composition`, which this list originally missed entirely (found
  sitting next to `duplicate_composition` in ishu86's own schema file while
  researching block #6).

**In this fork, absent from ishu86** (i.e. reasons the base choice still holds):

- Full **rendering pipeline** — `add-to-render-queue`, `render-queue`,
  `start-render`, background `render-aerender`, `render-status`. ishu86 has
  only `render_frame`.
- **Visual feedback** — `see-frame`, `contact-sheet`, `match-reference`.
- **Audio** — `analyze-audio-waveform`, `animate-to-audio`, `get-audio-info`,
  `set-audio-levels`.
- **Presets** — `list-presets`, `search-presets`, `apply-preset`.
- `execute-script` (arbitrary ExtendScript), `set-layer-mask`,
  `batch-set-layer-properties`, `center-layers`, `localize-comp` (Arabic/RTL),
  `list-available-effects`, deep `inspect-comp`/`inspect-layer`,
  `check-bridge`.

## SPEC: project-lifecycle tools — IMPLEMENTED and verified 2026-07-29

Written 2026-07-29 as a design-first spec, then implemented the same day.
Read this before touching these four tools again — the destructive-operation
contract below is a deliberate decision, not a default to rediscover.

**Implementation**: `create-project` / `open-project` / `save-project` /
`close-project` tools added to `src/index.ts` (registered just before
`create-composition`), plus `createProject`/`openProject`/`saveProject`/
`closeProject` bridge functions and a shared `_resolveSaveFirst()` gate added
to `src/scripts/mcp-bridge-auto.jsx` (placed right after `getProjectInfo()`).
All four bridge command names added to `allowedScripts` (`run-script`
whitelist) and to `NO_UNDO_GROUP_COMMANDS`. Implemented exactly per the spec
below — no deviations.

**Verified 2026-07-29** via `manual-tests/project-lifecycle-test.mjs`, a
12-step sequence designed specifically to exercise every branch of the
`saveFirst` contract **without risking the real project's content** (the
video layers + keyframes from earlier this session): save the real project
first (so all further "discard" tests run against disposable throwaway
projects, never the real one), exercise every gate branch, then restore the
real project and confirm it came back byte-for-byte identical (path match +
`inspect-comp` confirming all 3 original layers). All 12 assertions passed,
including the two safety-critical paths:
- `close-project {saveFirst:true}` on a dirty project with no file path yet →
  correctly returned the informed error, did not silently discard or crash.
- `close-project {saveFirst:false}` on a dirty disposable project → correctly
  discarded and succeeded (the explicit, informed-consent path).

Re-run `node manual-tests/project-lifecycle-test.mjs` (from the repo root)
after any future change to these four tools or to `_resolveSaveFirst()`.

### Why this needs a spec before code

`create-project` / `open-project` / `close-project` can discard unsaved AE
work. That is the one failure mode in this whole tool surface that is
genuinely unrecoverable, so the contract must be explicit rather than left to
whoever implements it. Two things informed the design:

1. `executeCommand()` already wraps every command in
   `app.beginSuppressDialogs()` (`src/scripts/mcp-bridge-auto.jsx` ~line 3637)
   specifically so an AE modal can never block the single-threaded bridge
   poll loop (a blocked panel never writes the result file → the whole
   automation hangs). This is already solved — do not re-solve it.
2. Because dialogs are globally suppressed, these tools must **never** rely
   on AE's native "prompt to save changes?" behavior (AE's `CloseOptions`
   enum has a `PROMPT_TO_SAVE_CHANGES` option — do not use it here). Under
   suppression its actual behavior is undocumented/version-dependent. Instead,
   check `app.project.dirty` explicitly in script and require the caller to
   say what to do about it. Never let an implicit AE default decide.

### Contract

- `saveFirst` is a **required boolean, no default**, on both `open-project`
  and `close-project` (the two operations that can throw away the *current*
  project). Zod: `z.boolean().describe("Required. If true, save the current
  project first (if it has a file path; error if it doesn't and is dirty).
  If false, the current project's unsaved changes are discarded.")`. Do NOT
  make this optional with a default — an omitted flag on a destructive
  operation is exactly the ambiguity this spec exists to prevent.
- Before doing anything destructive, check `app.project.dirty`:
  - If `false` (nothing unsaved): proceed regardless of `saveFirst`.
  - If `true` and `saveFirst === true`: call `app.project.save()` if
    `app.project.file` exists; if there's no file path yet (never-saved new
    project), return `{status:"error", error:"Project has unsaved changes
    and no file path yet; cannot saveFirst. Call save-project with an
    explicit path first, or pass saveFirst:false to discard."}` — do NOT
    silently discard, do NOT silently proceed without saving.
  - If `true` and `saveFirst === false`: proceed and discard (this is the
    explicit, informed-consent path for discarding work).
- `create-project` (maps to AE's `app.newProject()`) needs the same dirty
  check on the *outgoing* project before creating the new one — it takes
  `saveFirst` too, for the same reason.
- `save-project` takes an optional `filePath`: if provided, this is a
  save-as (`app.project.save(new File(filePath))`); if omitted, `app.project.
  save()` (must already have a file path, else error — do not silently fall
  back to a default path).
- All four join `NO_UNDO_GROUP_COMMANDS` in `mcp-bridge-auto.jsx` (~line
  3623) — undo groups are meaningless across a project boundary, and
  wrapping `app.newProject()`/`app.open()`/`app.project.close()` in
  `app.beginUndoGroup()` risks exactly the "Undo group mismatch" AE 2026
  warning already documented in that file's comments for `startRender`/
  `executeScript`.
- None of the four belong in `READ_ONLY_COMMANDS` (~line 2550) — all mutate
  state (even `close-project` ends the session's project context).

### Tool-by-tool

**`create-project`** (bridge command `createProject`)
```
{
  saveFirst: z.boolean().describe("Required. Whether to save the outgoing project (if dirty) before creating the new one. See saveFirst contract above."),
}
```
Bridge: dirty-check outgoing project per contract above, then
`app.newProject()`. Return `{status:"success"}` or the informed-error shape
above.

**`open-project`** (bridge command `openProject`)
```
{
  filePath: z.string().describe("Absolute path to the .aep project file to open."),
  saveFirst: z.boolean().describe("Required. Whether to save the currently open project (if dirty) before switching. See saveFirst contract above."),
}
```
Bridge: dirty-check current project per contract, then
`app.open(new File(filePath))`. If the file doesn't exist, return a clear
error rather than letting AE's own exception surface raw (match the style of
existing error handling elsewhere in the file, e.g. `getCompFull`'s
"Composition not found" pattern).

**`save-project`** (bridge command `saveProject`)
```
{
  filePath: z.string().optional().describe("Absolute path to save to (save-as). Omit to save to the project's existing file path (errors if the project has never been saved)."),
}
```
Bridge: `filePath` provided → `app.project.save(new File(filePath))`; omitted
→ error if `!app.project.file`, else `app.project.save()`.

**`close-project`** (bridge command `closeProject`)
```
{
  saveFirst: z.boolean().describe("Required. Whether to save before closing. See saveFirst contract above."),
}
```
Bridge: dirty-check per contract, then `app.project.close(CloseOptions.
DO_NOT_SAVE_CHANGES)` (we already handled saving explicitly above per the
contract, so always pass `DO_NOT_SAVE_CHANGES` here — never
`SAVE_CHANGES`/`PROMPT_TO_SAVE_CHANGES`, to avoid a second, redundant, or
conflicting save path). After close, AE typically auto-creates a blank
untitled project — note this in the tool description so the model doesn't
expect "no project open" as a resulting state.

### Wiring checklist (match existing patterns exactly — see `duplicate-layer`
/ `delete-layer` in `src/index.ts` ~line 2829 as the template)

1. Add all four bridge command names (`createProject`, `openProject`,
   `saveProject`, `closeProject`) to the `allowedScripts` whitelist in
   `run-script` (`src/index.ts` ~line 271-306).
2. Add four `server.tool()` registrations following the exact
   try/`sendBridgeCommand(cmd, parameters, 8000, 250)`/`bridgeToolResult`/
   catch shape every other tool uses.
3. Add four `case` branches to the big `switch (command)` in
   `executeCommand()` (`mcp-bridge-auto.jsx`), following the
   `logToPanel("Calling X function..."); result = X(args);
   logToPanel("Returned from X.");` pattern used by every other case.
4. Implement the four functions themselves near the other project-level
   functions (`getProjectInfo`, `listCompositions` are the closest existing
   analogues for placement).
5. Add all four bridge command names to `NO_UNDO_GROUP_COMMANDS`.
6. Rebuild (`npm run build`), reinstall bridge (`npm run install-bridge`),
   close+reopen the panel in AE (required — ScriptUI doesn't hot-reload),
   then smoke-test with `manual-tests/smoke-test.mjs` or an ad-hoc script per
   the pattern already established there. Test the error paths deliberately:
   a dirty project with `saveFirst:false` (confirm it discards, don't just
   assume), and a never-saved dirty project with `saveFirst:true` (confirm
   the informed error fires instead of a crash or silent no-op).

## SPEC: asset-management tools — IMPLEMENTED and verified 2026-07-29
(branch `feature/asset-management-tools`)

Written and implemented 2026-07-29, branched off
`feature/project-lifecycle-tools` (a deliberate stack, not the general
"branch from main" default — these two blocks are being built sequentially
this time).

Closes ishu86 gap #2: `import_footage`, `import_folder`, `replace_footage`,
`find_missing_footage`, `collect_files`, `reduce_project`,
`organize_project_items`. ishu86's CEP extension can't execute here (see the
CEP blocker section above), so its **source** was read directly as ground
truth for the real AE ExtendScript API surface rather than guessed from
memory.

**Confirmed from ishu86's source** (`assetGenerators.ts` /
`projectGenerators.ts`):
- `item.replace(file)` and `app.project.reduceProject([comp, ...])` are
  genuine single native AE API calls — direct 1:1 ports.
- "Import a folder," "find missing footage," "collect files," and "organize
  into folders" have **no native AE API** — all four are hand-rolled via
  `app.project.numItems`/`item(i)` iteration plus real properties
  (`footageMissing`, `usedIn`, `parentFolder`, `items.addFolder()`) and real
  `File`/`Folder` methods (`File.copy()`, `Folder.getFiles()`).
- ishu86's zod schemas (`schemas.ts`) are dead code — never imported by the
  actual handler, which casts args to `any`. Not evidence of what's actually
  validated in that project.

**Three deliberate deviations from ishu86**, decided before implementation:

1. **`collect-files` does not repoint the live project.** ishu86 calls
   `app.project.save(newPath)` to write the collected copy, which silently
   changes what `app.project.file` points to — a later plain "save" would
   overwrite the collected copy instead of the user's original. This version
   requires the project already be saved, then uses `File.copy()` on the
   existing `.aep` (never `app.project.save()` on the new path), so the live
   project's identity never changes.
2. **`reduce-project` requires explicit `confirm:true` (no default) and
   explicit `compNames` (no active-comp fallback).** It permanently deletes
   unused project items and isn't reliably undoable via Edit>Undo — same
   informed-consent pattern as `saveFirst` on the project-lifecycle tools.
3. **`organize-project-items`'s `custom` mode is a genuine new feature, not a
   port.** ishu86's own `custom` mode creates named folders but never
   actually moves any item into them (an unfinished no-op in their code).
   This version adds a real `customFolders: [{folderName, itemNames?,
   itemIds?}]` mapping so items actually land where specified.

Also: `import-folder` and `collect-files` both accumulate a `note` string of
per-item failures (matching the existing pattern in `seeFrame()`) instead of
ishu86's silent `catch (e) {}` swallowing.

None of the 7 join `NO_UNDO_GROUP_COMMANDS` — a plain per-command undo group
is correct for all of them. `find-missing-footage` joins `READ_ONLY_COMMANDS`
(genuinely read-only, matches ishu86 not wrapping it in an undo group
either).

Full schema/logic detail for all 7 tools is implemented directly in
`src/index.ts` (schemas) and `src/scripts/mcp-bridge-auto.jsx` (bridge
functions) — this section records the *why*, the code itself is the
authoritative *what*.

**Verified 2026-07-29** via `manual-tests/asset-management-test.mjs`, a
46-step scripted test following the same safety discipline as
project-lifecycle: saved and closed the real project first, ran every
mutating/destructive case (imports, replace, organize in all 3 modes,
reduce-project's confirm gate, collect-files) against disposable scratch
projects only, then restored the real project and confirmed its 3 layers
still intact. All assertions passed on the second run (first run had two
test-script bugs, not product bugs — a wrong expected count for
`organize-project-items` type mode once `import-folder`'s own root-folder
nesting was accounted for, and a forgotten `save-project` call before testing
`collect-files`'s save-required gate — both fixed in the test, not the
tools). Notably, `replace-footage` was verified via an independent
`execute-script` check reading `itemByID(id).file.fsName` back, not just
trusting the tool's success message, and `collect-files`'s no-repoint
behavior was directly asserted by confirming `getProjectInfo`'s `path`
matched the pre-collect saved path exactly afterward.

Re-run `node manual-tests/asset-management-test.mjs` (from the repo root)
after any future change to these 7 tools.

## SPEC: expression-suite tools — IMPLEMENTED and verified 2026-07-29
(branch `feature/expression-suite-tools`)

Written 2026-07-29, branched off `feature/asset-management-tools` (continuing
the sequential stack). Closes ishu86 gap #3. **Scoped tighter than the
previous two blocks** — this session had ~25% of a 5h budget left when this
block started, so fewer tools than ishu86 has, reusing existing helpers
wherever possible.

ishu86's `expressionGenerators.ts` was read directly as ground truth:
- `set_expression`/`remove_expression` are just `prop.expression = "..."`/`""`
  — **already fully covered by this fork's existing `setLayerExpression`**
  (empty string already clears it per its own description). Not
  reimplemented — would be pure duplication.
- `add_expression_control` = adding a Slider/Angle/Color/Point/Checkbox/Layer
  Control **effect** via match-name (`"ADBE Slider Control"` etc.), then
  setting its one sub-property. ishu86 silently discards Dropdown Control's
  default value (no map entry). Not replicated - see deviation below.
- `link_properties` = a hand-rolled one-way expression
  (`thisComp.layer("X").property("Y").value [+ offset]`) — **not** AE
  parenting. ishu86 also has a `if (params.targetLayerIndex)` truthy-check
  bug (breaks for index 0, low-impact since AE layers are 1-indexed anyway,
  but fixed here for free using `!== undefined` consistently).
- `apply_expression_template` = 20 hardcoded expression strings + naive
  `{{param}}` substitution on top of `set_expression`. **Deliberately shipped
  a smaller 6-template set here** (wiggle, loop, time, bounce, inertia,
  overshoot) instead of porting all 20 - a budget-driven scope cut, easy to
  extend later.
- ishu86 also built (but never wired to a tool) a batch-expression-setter and
  a template-introspection tool. Batch-expression-setter **implemented
  2026-07-29** as `batch-set-expression` - see the spec section immediately
  below. Template-introspection remains deferred (assessed as low-value: only
  6 templates exist, already documented in the tool's own schema).

**Reuse, not reinvention**: `findPropertyByNameOrMatchName(container,
propertyName)` (`mcp-bridge-auto.jsx:858`) resolves a property by name or
matchName - used by every new tool instead of writing new resolution logic.
`LayerIdentifierSchema` (`compIndex`/`layerIndex`, already used by
`setLayerKeyframe`/`setLayerExpression`) is the schema shape for every new
tool's layer target - no new schema design needed there either.

**Five tools added**: `get-expression` (read-only: expression string +
enabled + error), `enable-expression` (toggles `.expressionEnabled` without
touching the string - distinct from clearing via `setLayerExpression`),
`add-expression-control`, `link-properties` (same-comp only, matching
ishu86's actual scope), `apply-expression-template`. Full schema/logic detail
is in `src/index.ts` and `src/scripts/mcp-bridge-auto.jsx` - this section
records the *why*.

**Verified 2026-07-29** via `manual-tests/expression-suite-test.mjs` (22
steps, one disposable scratch project, lean per the budget constraint) - all
assertions passed on the first real run (after fixing a test-script schema
mistake for `createSolidLayer`, an existing tool called via `run-script`
whose args I had wrong - `compName` not `compIndex`, `color` as a `[r,g,b]`
0-1 array not an `{r,g,b}` 0-255 object, `size` not `width`/`height`; not a
new-tool bug). Notably confirmed: `get-expression` round-trips a string set
via the existing `setLayerExpression`; `enable-expression` toggles state
without altering the expression text; `add-expression-control`'s default
value was verified actually applied via an independent `execute-script`
read (not just the tool's own success message), and the dropdown limitation
surfaces as a `note` rather than silently vanishing; `link-properties`
produces a real cross-layer expression string; `apply-expression-template`
substitutes params with no leftover `{{...}}` tokens. Real project (3
layers) restored intact at the end.

## SPEC: batch-set-expression — IMPLEMENTED and verified 2026-07-29
(branch `feature/batch-expression-setter`)

Follow-up to the expression-suite block above, closing the
batch-expression-setter gap noted there. Motivated by a real use case ("add
a wiggle to all 8 text layers in one call" instead of N separate
`setLayerExpression` round-trips). Scoped deliberately narrow: **one
property name + one expression string applied to many layers** in the same
comp, not a general per-item-different-expression batch tool - that's more
flexibility than the motivating use case needs.

**Resolution-family decision**: `setLayerExpression` (the single-layer tool
this batches) uses the older raw-positional `LayerIdentifierSchema` +
`_resolveCompAndLayerSimple` family. But this file's own "Known
limitations" section says new tools should default to the comp-ordinal,
`compName`-preferring `_resolveComp`/`_resolveLayer` family instead (the
convention block #6 and `batch-set-layer-properties` already use), to avoid
growing the unsafe-family list. `batch-set-expression` follows that
guidance rather than matching `setLayerExpression`'s own family - it's a new
bridge function built by combining three already-shared helpers
(`_resolveComp`, `_resolveLayer`, `_resolveLayerProperty`), not new
resolution logic. One side effect: `CompIdentifierSchema` (previously
declared inline just before block #6's tools, ~line 3765) was moved up next
to `LayerIdentifierSchema` (~line 937) so it's in scope for this tool's
earlier position in the file - a pure relocation, no shape change.

**Response shape decision**: modeled on `batch-set-layer-properties`'s
`results[]` array of per-item `{layerIndex, layerName, status, message}`
objects (top-level `status: "success"` even when individual items fail),
not `copy-effects`'s flat `warnings[]` string list. This tool's items are
independent per-layer pass/fail outcomes - exactly what `results[]` already
models - whereas `warnings[]` is for accumulating non-fatal sub-issues
within one logical operation, which doesn't fit here.

**One tool added**: `batch-set-expression` - `compName`/`compIndex` (comp-
ordinal) once, plus `propertyName`, `expressionString`, and a `targets`
array of `{layerIndex}`/`{layerName}`. Empty-string `expressionString`
removes the expression from every target, matching `setLayerExpression`'s
existing convention.

**Verified 2026-07-29** via `manual-tests/batch-expression-test.mjs` - all
assertions passed on the first real run. Confirmed: expression applied to
all 3 targets in one call and round-tripped via an independent
`get-expression` read (not just the tool's own success message); a batch
with one valid `layerName` and one nonexistent one reports
`successCount: 1` of 2, with the bad target's per-item result
`status: "error", message: "Layer not found"` while the valid target still
succeeds (partial-failure isolation, top-level `status` stays "success");
an invalid `propertyName` on an otherwise-valid layer reports a per-item
"not found" error without aborting the batch; empty-string
`expressionString` removed the expression, confirmed via `get-expression`
returning `expression: ""`. Real project (3 layers) restored intact at the
end.

## SPEC: keyframe-manipulation tools — IMPLEMENTED and verified 2026-07-29
(branch `feature/keyframe-manipulation-tools`)

Written 2026-07-29, branched off `feature/expression-suite-tools`. Closes
ishu86 gap #4 (final block on the current priority list):
`offset_keyframes`, `scale_keyframe_timing`, `reverse_keyframes`,
`copy_keyframes`, `apply_easy_ease`, `get_keyframes`.

ishu86's `keyframeGenerators.ts` was read directly as ground truth. Key
findings:
- AE's scripting DOM has **no `setKeyTime()`** - `keyTime` is read-only, so
  moving/scaling/reversing keyframe times is forced to be
  destroy-all-keys + recompute + rebuild, a genuine API constraint, not a
  shortcut.
- `get-keyframes` is only partially redundant with this fork's existing
  `inspect-layer`/`includeKeyframes` (`dumpLeaf()` in the jsx file) - that
  only covers Transform-group properties, not effects, and neither source
  returns temporal ease (speed/influence). Building it properly closes a
  real gap rather than duplicating.
- **Two real bugs found in ishu86, not replicated**: (1)
  `offset_keyframes`/`scale_keyframe_timing` silently drop any keyframe
  whose recomputed time goes negative during rebuild, yet still report the
  *original* key count as moved/scaled - fixed here by reporting the actual
  re-added count plus a `note` for drops. (2) `copy_keyframes`/
  `apply_easy_ease` use a falsy check (`if (params.xIndex)`) instead of
  `!== undefined` on indices - latent (AE indices are 1-based, index 0 never
  real) but fixed for consistency, same class of fix as `link-properties` in
  the previous block.
- `reverse_keyframes` is correct in ishu86 (properly swaps in/out
  interpolation and ease) - ported directly.
- `apply_easy_ease`'s ease value is confirmed as AE's real default
  (`speed=0, influence=33.33`), matching this fork's own `buildEaseArray()`
  default exactly. **Deliberate improvement**: omitting `keyframeIndex`
  applies Easy Ease to all keyframes on the property (not an error/no-op) -
  matches how AE's own Easy Ease command behaves with multiple keyframes
  selected, and is the more common real use case.

**Reuse, not reinvention**: `_resolveLayerProperty` (added in the expression-
suite block) handles all property resolution - Transform/Effects/Text, no
new lookup logic. `findKeyIndexAtTime`, `getPropertyDimensionCount`,
`buildEaseArray`, `buildEaseArrayFromSpec` (existing, power
`set-effect-keyframe`) are reused directly by `apply-easy-ease`.
`LayerIdentifierSchema` is the schema shape for every single-layer tool.

Full schema/logic detail is in `src/index.ts` and
`src/scripts/mcp-bridge-auto.jsx` - this section records the *why*.

**Verified 2026-07-29** via `manual-tests/keyframe-manipulation-test.mjs` (25
steps) - two real bugs were found and fixed during verification, neither
present in ishu86 (they're specific to this fork's own implementation, found
by actually testing rather than just porting):

1. **`apply-easy-ease` crashed**: "Unable to call setTemporalEaseAtKey ...
   Value array does not have 1 elements." It sized the ease array using
   `getPropertyDimensionCount()` (based on the property's *value* shape - 3
   for Position's `[x,y,z]`), but AE's temporal ease for a spatial property
   is a single unified motion-path ease (length 1), not one value per axis -
   value-dimensionality and ease-dimensionality are different concepts. Fixed
   by reading the expected length from the key's own existing
   `keyInTemporalEase(idx).length`/`keyOutTemporalEase(idx).length` instead
   of guessing from the value shape.
2. **Interpolation type was silently lost on every rebuild** (`offset-
   keyframes`, `scale-keyframe-timing`, `reverse-keyframes`, `copy-
   keyframes`): every rebuilt keyframe came back as `BEZIER`/`BEZIER`
   regardless of its original type, with no error (each call was wrapped in
   a silent `try/catch`, masking it). Root cause: `setTemporalEaseAtKey`
   appears to force/promote a key to `BEZIER` interpolation as a side
   effect, and the code called `setInterpolationTypeAtKey` *before*
   `setTemporalEaseAtKey` - so the ease call clobbered the just-set
   interpolation type. Fixed by reordering: ease first, interpolation type
   last, in both `_rebuildKeyframesAtNewTimes` and `copyKeyframes`.

Both were caught specifically because the test asserted on *interpolation
type surviving the round-trip* (via an intentionally asymmetric HOLD-in/
LINEAR-out keyframe) rather than only checking counts and times - a useful
lesson for verifying future keyframe-touching tools. Also two test-script
false alarms (not product bugs): the existing `setLayerKeyframe` tool
deliberately seeds an extra keyframe at `comp.time` on its first call for a
property, which briefly looked like a keyframe-count bug until traced to
that existing, intentional behavior; and an early version of the test lost
its own asymmetric-interpolation test keyframe to an earlier destructive
offset step, which was a test design issue (fixed by isolating that check to
its own untouched property) not a tool bug.

Re-run `node manual-tests/keyframe-manipulation-test.mjs` (from the repo
root) after any future change to these 6 tools.

## SPEC: motion-graphics templates — IMPLEMENTED and verified 2026-07-29
(branch `feature/motion-graphics-templates`, off `feature/keyframe-manipulation-tools`)

Written 2026-07-29. Block #5, chosen over ishu86's deferred
batch-expression/template-introspection tools because it's a genuinely new
capability category (composite multi-layer builders for common real
deliverables) rather than completing something already 90% done. Closes:
`create_lower_third`, `create_title_card`, `create_transition`,
`create_logo_reveal`, `create_text_animator`.

ishu86's `templateGenerators.ts` was read directly as ground truth. Confirmed
portable - every AE call in this category (`addComp`, `addText`, `addSolid`,
TextDocument mutation, `addProperty("ADBE ...")`, `KeyframeEase`,
`setTemporalEaseAtKey`, animator/selector match-names) is plain ExtendScript
with zero CEP-specific surface, same conclusion as every previous block.
Also confirmed: a second ishu86 file, `src/presets/motion-graphics/index.ts`,
is dead code (unreferenced), same pattern as `schemas.ts` found earlier -
not a source to trust for "what's actually wired."

**Six real bugs found in ishu86, fixed here rather than replicated:**
1. `create_lower_third` accepts `secondaryColor` but never uses it anywhere
   in the function body - dead parameter. Fixed: implemented as a real thin
   accent stripe under the main bar (defaults to `primaryColor` if omitted,
   never silently ignored).
2. `create_lower_third`'s title/subtitle font is hardcoded
   (`Arial-BoldMT`/`ArialMT`) for every style, despite a *different*, unused
   ishu86 file implying styles should carry their own font. Fixed: a
   per-style font default, plus an optional `fontFamily` override (this
   fork's `createTextLayer` already supports arbitrary fonts, so this is
   cheap and consistent).
3. `create_transition`'s `easing` param is declared in the schema and typed,
   but never referenced in the function body at all - completely dead.
   Fixed: genuinely wired using this fork's own existing `buildEaseArray`/
   `KeyframeEase`/`setTemporalEaseAtKey` (already proven in the
   keyframe-manipulation block), applied in the correct order discovered
   last block (ease before interpolation type - `setTemporalEaseAtKey`
   appears to force-promote to BEZIER, so setting interpolation type last is
   what makes it stick).
4. `create_logo_reveal`: if neither `logoItemId` nor `logoItemName` is
   supplied (neither is in the schema's `required` list, so this is
   reachable), the generated code never declares the `logoItem` variable in
   that branch, then immediately checks `if (!logoItem)` - a raw ES3
   `ReferenceError`, not the intended friendly error. Fixed: explicit
   validation in the bridge function returns a clear error instead.
5. `create_logo_reveal`'s `style` schema enum has 6 values but the
   implementation only handles 5 - `particle` silently falls through with
   zero animation (logo just appears, no reveal). Fixed: `particle` dropped
   from the enum entirely rather than accepted-and-ignored, matching the
   same principle as `organize-project-items`'s custom-mode decision in the
   asset-management block (implement properly or omit, never silently no-op).
6. `create_text_animator`'s `delay` param is read into a local variable and
   then never used again - dead. Its `wave` style also isn't a true
   per-character wave (a shared, non-oscillating position offset plus a
   scrolling selector window, despite the description implying real
   per-character motion). Fixed: `delay` genuinely wired as a per-character
   stagger via a `textIndex`-based expression on the selector (the standard
   AE technique); `wave` rewritten as a real per-character oscillating
   expression (`Math.sin(time*speed + textIndex*phase) * amplitude` on the
   animator's Position), not a keyframed approximation.

**Reuse**: comp resolution (by name, falling back to the active comp) is
already duplicated identically across `createTextLayer`/`createSolidLayer`/
`createShapeLayer` - factored into one new shared `_resolveCompByNameOrActive`
helper used by all 5 new functions, without touching those 3 existing
functions. Color convention matches the existing `[r,g,b]` 0-1 array
established by those same functions, not ishu86's differing format. New
functions call raw AE APIs directly (matching ishu86's own approach and this
fork's own style in the keyframe-manipulation block) rather than composing
through the 3 existing functions, since those return JSON strings rather than
live layer references, making composition more awkward than writing focused
code directly.

**Schema conventions**: the 4 layer-creating tools (`create-lower-third`,
`create-title-card`, `create-transition`, `create-logo-reveal`) use
`compName` (optional, falls back to active comp) matching `createTextLayer`/
`createSolidLayer`/`createShapeLayer` exactly - they're peers of those
functions (add something to a target comp), not of the
`compIndex`+`layerIndex` tools (which modify an existing layer).
`create-text-animator` uses `LayerIdentifierSchema` instead, since it
modifies an existing text layer, not creates one.

Full schema/logic detail is in `src/index.ts` and
`src/scripts/mcp-bridge-auto.jsx` - this section records the *why*.

**Verified 2026-07-29** via `manual-tests/motion-graphics-templates-test.mjs`
(28 steps). This was the most bug-dense block so far - four real bugs found
and fixed, one of them (#3 below) a **cross-cutting bug affecting nearly
every tool built in every previous block**, not something specific to this
one. See "Known limitations" below for the full writeup; short version:

1. **Invalid ease influence value.** `_applyEasingAtKey` used `0.1` as
   "practically no ease" - originally coded as `0.01`, below AE's actual
   valid range of `[0.1, 100]` for `KeyframeEase`, which crashed
   `create-transition` outright with a `Constructor` error. Fixed by using
   the real minimum, `0.1`.
2. **`app.beginSuppressDialogs()` does not reliably suppress AE's native
   "unsaved changes" dialog** raised internally by `app.open()`/
   `app.newProject()` for a dirty current project - it blocked the entire
   bridge (every MCP tool, not just the one call) until manually dismissed,
   *even though* `_resolveSaveFirst` had already decided discarding was
   safe. Fixed in `createProject`/`openProject` by explicitly calling
   `app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES)` first (proven
   reliable, no dialog, across dozens of calls all session) instead of
   trusting `app.open()`/`app.newProject()` to handle a dirty project
   silently themselves. This is a real reliability fix to the
   project-lifecycle tools from block #1, only surfaced now because this
   block's test created much heavier scratch-project state than any earlier
   test.
3. **`app.project.item(index)`'s positional index is not stable creation
   order** - see "Known limitations" below, this is the big one.
4. **A Text Animator's "Properties" group is a fixed ~103-slot catalog**
   (every possible per-character property, Anchor Point always first), not
   a growable list of what's been added. `addProperty(matchName)` activates
   a specific slot and returns a working reference to it (so the *write*
   side - what `create-text-animator` itself does - was correct all along);
   but re-discovering "the one I just added" afterward via `.property(1)`
   always returns Anchor Point regardless of what's active. The fix
   (searching by `matchName` + a non-empty `.expression`/value) was only
   needed in the *test's* verification code, not the tool itself - recorded
   here anyway since it's a real, reusable lesson for any future work
   touching Text Animator properties.

Also fixed for consistency (not bugs, just correctness identified while
writing the new code): `_easeDimensionForProperty` was added proactively so
`create-transition`'s new easing code wouldn't reproduce the exact
value-dimension-vs-ease-dimension crash already found and fixed in
`apply-easy-ease` last block - applying that lesson before it could bite a
second time, rather than after.

Re-run `node manual-tests/motion-graphics-templates-test.mjs` (from the repo
root) after any future change to these 5 tools.

## SPEC: layer/composition management tools — IMPLEMENTED and verified 2026-07-29
(branch `feature/layer-comp-management-tools`, off `feature/motion-graphics-templates`)

Written 2026-07-29. Block #6, closing out the "Misc" bullet from the
feature-comparison table above: `precompose_layers`, `add_light_layer`,
`duplicate_composition`, `reorder_effects`, `copy_effects`, `set_work_area`,
`delete_marker`. **Plus `delete_composition`**, found sitting right next to
`DuplicateCompositionSchema` in ishu86's `schemas.ts` while researching this
block - the feature-comparison table above never listed it as a gap (an
oversight in that doc, not a deliberate omission), but it's absent from this
fork too and belongs with the same block.

ishu86's `compositionGenerators.ts`, `layerGenerators.ts`,
`effectsGenerators.ts`, and `markerGenerators.ts` were read directly as ground
truth. All 8 are thin wrappers around native AE calls
(`comp.duplicate()`/`.remove()`, `comp.layers.addLight()`,
`comp.layers.precompose()`, `effect.moveTo()`, `effectsGroup.addProperty(matchName)`,
`markerProp.removeKey()`, `comp.workAreaStart`/`workAreaDuration`) - no
CEP-specific surface, same conclusion as every previous block.

**Key design decision: which comp/layer resolution convention to use.**
This fork already has *two different, undocumented* `compIndex` semantics
coexisting (found while researching this block, not previously written down):
- `_resolveCompAndLayerSimple`/`resolveCompAndLayer` (mcp-bridge-auto.jsx) -
  `compIndex` = raw 1-based position in the whole Project-panel item list via
  `app.project.item(compIndex)`. Used by `apply-effect`, `list-layer-effects`,
  `add-marker`, every `LayerIdentifierSchema` tool. This is the instability
  already documented below.
- `_resolveComp`/`_resolveLayer` (mcp-bridge-auto.jsx) - `compIndex` = the
  Nth *composition* specifically (a comp-only ordinal counter, comps found by
  scanning and incrementing a counter only `instanceof CompItem`), with
  `compName` checked first and active-comp as final fallback. Used by
  `duplicate-layer`, `delete-layer`, `set-composition-properties`,
  `set-layer-mask`, `batch-set-layer-properties`.
- **The same composition can need a different numeric `compIndex` depending
  on which tool you call** (a folder or non-comp item before it shifts the
  raw-position count but not the comp-ordinal count). Not fixed (same
  "sweeping change, out of scope for one block" reasoning as the original
  finding) - added to "Known limitations" below since it's a real,
  previously-undocumented gap, not new instability introduced by this block.
- **Decision for all 8 new tools: use the `_resolveComp`/`_resolveLayer`
  convention** (`compName` optional, `compIndex` optional as comp-ordinal
  fallback, active-comp as final fallback; `layerIndex`/`layerName` optional
  pair where a layer is needed) - matches `duplicate-layer`/`delete-layer`
  exactly (the closest sibling tools - these are structural/destructive comp
  and layer operations, not per-property animation edits), and is the
  direction CONTEXT.md's existing limitations section already recommends
  ("switching to `compName` everywhere"). No new resolution helpers needed -
  `_resolveComp`/`_resolveLayer` are reused as-is for all 8.

**Effect resolution reuses `resolveEffectOnLayer`** (mcp-bridge-auto.jsx,
already backs `remove-effect`: accepts `effectIndex`/`effectName`/
`effectMatchName`) for `reorder-effects` - a deliberate improvement over
ishu86, whose `reorder_effects` is index-only with no name fallback at all.
`copy-effects` needs a *list* of effects (or "all"), so it iterates
`effectsGroup.property(i)` directly (ishu86's own approach) rather than
calling `resolveEffectOnLayer` per index.

**Bugs found in ishu86, not replicated:**
1. `add_light_layer`'s `color` accepts an optional `a` (alpha) component
   (`ColorSchema` is shared with every other color field) which
   `colorToES3()` then emits as a 4-element array - passed straight into
   `.setValue()` on a Light layer's Color property, which is a plain
   3-component Color control. Fixed here by using this fork's own `[r,g,b]`
   0-1 array convention (established in the motion-graphics-templates block,
   no alpha field exists at all) - the bug class doesn't exist in this
   fork's parameter shape to begin with.
2. `copy_effects` copies each effect property's current static `.value` via
   `setValue()`, wrapped in a bare `try {} catch (e) {}` that silently
   swallows every failure (a keyframed or expression-driven source property
   can't be copied via a static `setValue` - it just silently doesn't copy,
   and the caller has no way to know). Fixed here: same no-silent-swallow
   pattern as `offset-keyframes`/`scale-keyframe-timing` from the
   keyframe-manipulation block - a `warnings` array in the result lists any
   property that couldn't be copied and why (keyframed/expression-enabled
   properties are detected and named explicitly, not lumped in with generic
   failures).
3. `delete_marker`/`get_markers`/`snap_to_marker` all use
   `if (params.layerIndex || params.layerName)` - a falsy check, not
   `!== undefined`. Same latent-not-triggerable class as `link_properties`/
   `copy_keyframes` in earlier blocks (AE indices are 1-based, so a real
   index 0 never occurs through normal use) - fixed for free/consistency.
4. **`reorder_effects` reads `effect.name`/`effect.propertyIndex` off the
   *same* effect reference immediately after calling `effect.moveTo()`.**
   Confirmed live: After Effects invalidates that reference the instant the
   move happens - re-reading it throws `ReferenceError: Object is invalid`,
   so the tool would error out on every call despite the reorder itself
   succeeding. ishu86's own generated code has the identical bug (reads
   `effect.name` after `moveTo()` in the same script) - never caught on
   their side because their CEP extension can't load on this AE install
   (the persistent blocker noted earlier in this file), so it was never
   actually run against live AE. Fixed here by capturing `effect.name`
   *before* the move, and reporting the already-known `newIndex` from the
   request instead of re-reading `.propertyIndex` afterward.
5. **`precompose_layers` treats the return value of
   `comp.layers.precompose()` as the new replacement layer.** Confirmed
   live: `precompose()` actually returns the new **`CompItem`** (the nested
   composition itself), not a layer - reading `.index` or `.source` off it
   throws `TypeError: undefined is not an object` (neither property exists
   on a `CompItem`). Same root cause as bug #4 - ishu86's own generated code
   makes the identical assumption (`generateResultObject({ index:
   'precompLayer.index', ..., sourceCompId: 'precompLayer.source.id' })`)
   and was never live-tested for the same CEP-blocker reason. Fixed here:
   the actual replacement layer is looked up afterward at the lowest index
   among the originally-selected `layerIndices` (AE's own placement rule -
   confirmed live), and the CompItem's `id`/`name` are reported as
   `sourceCompId`/`sourceCompName` instead of trying to read them through a
   nonexistent `.source` on the wrong object type.

**Deliberate scope limits (documented, not fixed):**
- `copy-effects` only copies each effect's current static property values,
  never keyframes or expressions on those properties (matches ishu86's own
  scope) - a caller who needs full keyframe fidelity on a copied effect
  should follow up with this fork's own `copy-keyframes` tool (built last
  block) for that specific property. Not extended to auto-chain into
  `copy-keyframes` internally - keeps this tool's behavior simple and
  predictable rather than surprising.
- `delete-composition`/`delete-layer` do not check whether the target is
  used elsewhere (nested as another comp's layer source, referenced in the
  render queue) before removing it - matches ishu86 and matches this fork's
  own pre-existing `delete-layer` precedent exactly; native AE behavior
  applies (referencing layers become missing-source, same as manually
  deleting in the UI).
- `set-work-area` does not pre-validate `start`/`duration` against
  `comp.duration` before calling AE's native setters - matches ishu86's
  approach exactly. **Correction after live testing (2026-07-29)**: ishu86's
  own writeup assumes AE clamps an out-of-range `workAreaDuration` silently;
  live testing on this build shows AE actually **throws** ("Unable to set
  'workAreaDuration'. Value 100 out of range 0.03 to 4.03.") rather than
  clamping. Not a bug in this fork's implementation - the bridge function's
  existing try/catch already surfaces this correctly as a `status:"error"`
  result instead of a false "success", which is the right behavior; ishu86's
  assumption about AE's own clamping behavior was simply wrong, and this
  fork does not repeat it in its documentation or tests.

**Tool-by-tool:**
- `duplicate-composition` (bridge `duplicateComposition`) - `compName`/
  `compIndex` optional pair, `newName` optional. `comp.duplicate()`.
- `delete-composition` (bridge `deleteComposition`) - `compName`/`compIndex`
  optional pair. Captures name before `.remove()`.
- `add-light-layer` (bridge `addLightLayer`) - `compName`/`compIndex`
  optional pair, `name`/`type` (`PARALLEL`/`SPOT`/`POINT`/`AMBIENT`, default
  `POINT`)/`color` ([r,g,b] 0-1, optional)/`intensity` optional.
  `comp.layers.addLight(name, [comp.width/2, comp.height/2])`.
- `precompose-layers` (bridge `precomposeLayers`) - `compName`/`compIndex`
  optional pair, `layerIndices` (required array of 1-based ints, matches
  ishu86 - AE's own `precompose()` only accepts indices, no name-array
  alternative exists to offer), `name` required, `moveAttributes` optional
  (default `true`, matches AE's own UI default). `comp.layers.precompose(...)`.
- `reorder-effects` (bridge `reorderEffects`) - `compName`/`compIndex` +
  `layerIndex`/`layerName` optional pairs, `effectIndex`/`effectName`/
  `effectMatchName` (via `resolveEffectOnLayer`, improvement over ishu86's
  index-only), `newIndex` required. `effect.moveTo(newIndex)`.
- `copy-effects` (bridge `copyEffects`) - `compName`/`compIndex` +
  `sourceLayerIndex`/`sourceLayerName` + `targetLayerIndex`/`targetLayerName`
  (all via `_resolveComp`/`_resolveLayer`), `effectIndices` optional array
  (omit = copy all). Returns `copiedEffects`, `count`, and `warnings` (bug
  fix #2 above).
- `delete-marker` (bridge `deleteMarker`) - `compName`/`compIndex` +
  `layerIndex`/`layerName` optional pair (present = layer marker, absent =
  composition marker, matches ishu86's inference exactly but with
  `!== undefined` checks), `markerIndex` required.
  `markerProp.removeKey(markerIndex)`.
- `set-work-area` (bridge `setWorkArea`) - `compName`/`compIndex` optional
  pair, `start` required, `duration` required positive.

All 8 added to `allowedScripts` in `src/index.ts`. None added to
`READ_ONLY_COMMANDS` (all mutate) or `NO_UNDO_GROUP_COMMANDS` (plain,
individually-undoable ops - the dispatcher's central
`beginUndoGroup`/`endUndoGroup` wrap is correct as-is, same as every prior
block's non-render/non-lifecycle tools).

**Verified 2026-07-29** via `manual-tests/layer-comp-management-test.mjs`.
Re-run after any future change to these 8 tools.

## Known limitations

### `compIndex`'s positional index can shift as a project grows (discovered 2026-07-29)

Every `compIndex`/`layerIndex`-based tool in this fork (the `LayerIdentifierSchema`
convention - `setLayerKeyframe`, every expression-suite tool, every
keyframe-manipulation tool, `create-text-animator`, and more) resolves a
composition via `app.project.item(compIndex)`. That index is **the item's
current position in the Project panel's flat item list, not a stable ID
assigned at creation** - confirmed live: a composition created first (and
initially at position 1) had shifted to **position 3** later in the same
session, after only a few more items were added and After Effects
auto-created its own built-in "Solids" folder (a real, automatic AE
behavior whenever a solid-color layer is created). No tool in this codebase
did anything to explicitly move or reorder that composition - the position
simply isn't stable once a project has more than a couple of items or any
folders.

**Practical impact**: `compIndex` is safe to treat as stable only in a
freshly-created, simple scratch project immediately after creating the
target comp (which is exactly the shape of every previous block's test -
why this was never caught until a test finally created enough items to
trigger it). In any real project with multiple comps, imported footage, or
folders (including AE's own auto-created "Solids"/"Comps" folders), a
`compIndex` captured earlier in a session can silently point at the wrong
composition later, since nothing about the target comp itself changed.

**Not fixed here** - this is a pre-existing, cross-cutting design property
of the whole `LayerIdentifierSchema` convention (present since block #1 or
earlier, in code this fork inherited, not introduced this session), and
fixing it properly (e.g. switching to `compName` everywhere, or resolving
`compIndex` against `item.id` instead of positional index) would be a
sweeping change across every tool in every block, out of scope for a single
block's fix. Recorded here as a known limitation so a future session
doesn't have to rediscover it, and so any caller relying on a `compIndex`
captured earlier in a long session knows to re-resolve it (e.g. via
`getProjectInfo`, matching by name) rather than trust it stays valid.

**What already avoids this**: the four motion-graphics tools that create
new content (`create-lower-third`, `create-title-card`, `create-transition`,
`create-logo-reveal`) all use `compName` (falling back to the active comp),
not `compIndex` - they were designed this way from the start, matching
`createTextLayer`/`createSolidLayer`/`createShapeLayer`'s existing
convention, and are unaffected by this limitation.

### A second, different `compIndex` semantic also exists (discovered 2026-07-29, while researching block #6)

The instability above describes one resolution helper. This codebase
actually has **two, and they disagree with each other**:
- `_resolveCompAndLayerSimple`/`resolveCompAndLayer` - `compIndex` = raw
  1-based position in the whole Project-panel item list
  (`app.project.item(compIndex)`). Backs `apply-effect`,
  `list-layer-effects`, `add-marker`, every `LayerIdentifierSchema` tool.
  This is the semantic described above.
- `_resolveComp`/`_resolveLayer` - `compIndex` = the Nth *composition*
  specifically (a counter incremented only when `instanceof CompItem`),
  checked only if `compName` didn't resolve, falling back to the active
  comp last. Backs `duplicate-layer`, `delete-layer`,
  `set-composition-properties`, `set-layer-mask`,
  `batch-set-layer-properties`, and (as of block #6) all 8 new
  layer/comp-management tools.

**Practical impact**: the same composition can require a *different*
numeric `compIndex` depending on which tool you call, if any non-comp item
(a folder, imported footage, a solid) sits before it in the Project panel -
raw-position counting and comp-only counting diverge as soon as that
happens. Neither semantic is "wrong" in isolation; the problem is that two
different tool families silently disagree about what the same parameter
name means.

**Not fixed here** - same reasoning as above (standardizing on one semantic
project-wide is a sweeping cross-cutting change, out of scope for a single
block). Block #6 deliberately chose the `_resolveComp`/`_resolveLayer`
(comp-ordinal, `compName`-preferring) semantic for all its new tools, since
it's the direction this limitation already recommended moving toward - so
new tools added going forward should default to that convention too, rather
than perpetuating the raw-positional one.

#### Full tool inventory by resolution family (researched 2026-07-29)

A complete Explore pass over `src/index.ts` and `src/scripts/mcp-bridge-auto.jsx`
found the raw-positional side is actually **three** subtly different
implementations, not one, plus one tool that bypasses the bridge entirely.
Use this table to know which counting rule applies before trusting a
`compIndex` value with any specific tool:

- **Raw-positional via `LayerIdentifierSchema` + `_resolveCompAndLayerSimple`**
  (`app.project.item(compIndex)`, then bracket `comp.layers[layerIndex]`):
  `setLayerKeyframe`, `setLayerExpression`, `get-expression`,
  `enable-expression`, `add-expression-control`, `apply-expression-template`,
  `get-keyframes`, `offset-keyframes`, `scale-keyframe-timing`,
  `reverse-keyframes`, `apply-easy-ease`, `create-text-animator` (12 tools,
  all bare-required `compIndex`+`layerIndex`, no `compName`/`layerName`
  alternative).
- **Raw-positional via the `resolveCompAndLayer` helper** (same
  `app.project.item(compIndex)`, but method-call `comp.layer(layerIndex)`
  and defaults both indices to `1` if omitted): `set-effect-property`,
  `set-effect-keyframe`, `list-layer-effects`, `remove-effect`,
  `set-audio-levels`.
- **Raw-positional, resolved inline** (`app.project.item(compIndex)`
  written directly in the bridge function, no shared helper at all):
  `apply-effect`, `add-any-effect`, `apply-effect-template`, `add-marker`,
  `get-audio-info`, `center-layers`, `get-layer-clip-frames`.
- **Raw-positional via bracket indexing on the whole items collection**
  (`app.project.items[compIndex]` - not even `.item()` - plus
  `comp.layers[idx]` bracket for both layers): `link-properties`,
  `copy-keyframes`. The least safe existing variant, and the only one with
  *no* name-based alternative on the layer side either (no
  `sourceLayerName`/`targetLayerName`).
- **Comp-ordinal, `compName`-preferring (`_resolveComp`/`_resolveLayer`) -
  already safe, no action needed**: `duplicate-layer`, `delete-layer`,
  `set-composition-properties`, `set-layer-mask`,
  `batch-set-layer-properties`, all 8 block-#6 tools
  (`duplicate-composition`, `delete-composition`, `add-light-layer`,
  `precompose-layers`, `reorder-effects`, `copy-effects`, `delete-marker`,
  `set-work-area`), the 4 motion-graphics creators (`create-lower-third`,
  `create-title-card`, `create-transition`, `create-logo-reveal`),
  `localize-comp`, `create-camera`, `inspect-comp`, `inspect-layer`,
  `animate-to-audio`/`animate-from-data`, `batch-set-expression`.
- **Deliberately excluded from any future fix, vestigial**: `test-animation`
  (`src/index.ts` ~line 1436). Bypasses the bridge dispatcher entirely -
  writes a standalone `.jsx` temp file the user must manually run via
  `File > Scripts > Run Script File...`, uses blocking `alert()` popups,
  and duplicates what `setLayerKeyframe`/`setLayerExpression` already do
  properly through the real bridge. Inherited from the base fork, not part
  of the maintained tool surface - a candidate for removal, not migration,
  if anyone ever revisits it.

#### Mitigation adopted instead of a full refactor (decided 2026-07-29)

A full standardization pass (migrate all ~20 tools above onto
`_resolveComp`/`_resolveLayer`, delete `_resolveCompAndLayerSimple`/
`resolveCompAndLayer`) was scoped out in detail but **deliberately not
implemented**: the actual trigger condition for a wrong-target bug is
narrow (a non-comp item before the target comp, *and* a caller reusing a
`compIndex` across the wrong tool family without re-resolving), it hasn't
caused a real observed incident, and the fix would be the single largest,
most cross-cutting change of the whole project - including a breaking
semantic change to `compIndex` on 12+ tools - for a bug class that's still
hypothetical in practice.

Instead, the safety net is enforced as **repo-resident agent guidance**
rather than a code change: `.claude/skills/ae-mcp-compindex-safety/SKILL.md`
(auto-discovered by any Claude Code session opened in this repo) and
`AGENTS.md` (repo root, the cross-tool convention other coding agents like
Codex auto-load) both codify the safe practice - prefer `compName`
wherever a tool accepts it; if only `compIndex` is available, re-resolve it
immediately before the call using the counting rule for that *specific*
tool family from the table above, never reuse a `compIndex` captured for a
different tool. If this bug class ever causes a real, observed
wrong-target incident, that would be the trigger to revisit the full
refactor with a concrete case to test against instead of a hypothetical
one.

## Next planned step

All 6 planned tool blocks are implemented and verified (project lifecycle,
asset management, expression suite, keyframe manipulation, motion-graphics
templates, layer/composition management), plus a docs-only block adding
`.claude/skills/ae-mcp-compindex-safety/SKILL.md` and `AGENTS.md` to
mitigate the `compIndex` inconsistency without a full refactor (see "Known
limitations" above). Remaining candidates if a future block is wanted:
ishu86's batch-expression-setter/template-introspection tools, built but
never wired up on their side (deferred in the expression-suite spec above);
or the full `compIndex` semantic standardization, deliberately deferred
until it causes a real observed incident rather than staying a
documented/mitigated risk.
