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

## Not yet tested

Everything else in the 50-tool catalog — effects (`apply-effect`,
`list-available-effects`, `set-effect-property`, etc.), presets, audio tools,
markers, rendering (`add-to-render-queue`, `start-render`, `render-aerender`),
`contact-sheet`, `match-reference`, `execute-script` (used only as a diagnostic
tool so far, not smoke-tested as a general capability), and all layer-creation
tools (`create-text-layer`, `create-camera`, `duplicate-layer`, etc.).

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
- **Asset management**: `import_footage`, `import_folder`, `replace_footage`,
  `find_missing_footage`, `collect_files`, `reduce_project`,
  `organize_project_items`.
- **Keyframe timeline manipulation**: `offset_keyframes`,
  `scale_keyframe_timing`, `reverse_keyframes`, `copy_keyframes`,
  `apply_easy_ease`, `get_keyframes`. (This fork has rich *creation* options
  incl. graph/easing control via `set-effect-keyframe`, but cannot transform
  existing keyframes.)
- **Expression suite**: `get_expression`, `remove_expression`,
  `enable_expression`, `add_expression_control`, `apply_expression_template`,
  `link_properties`. (This fork has only `setLayerExpression`.)
- **Motion-graphics templates**: `create_lower_third`, `create_title_card`,
  `create_transition`, `create_logo_reveal`, `create_text_animator`.
- Misc: `precompose_layers`, `add_light_layer`, `duplicate_composition`,
  `reorder_effects`, `copy_effects`, `set_work_area`, `delete_marker`.

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

## Next planned step

Decide which remaining ishu86 capabilities are worth reimplementing here.
Recommended priority order: ~~(1) project lifecycle~~ **done 2026-07-29**,
~~(2) asset management~~ **done 2026-07-29, see spec above**, (3) expression
suite, (4) keyframe timeline manipulation. All are plain ExtendScript domain
work and do not depend on ishu86's CEP architecture, so they can be written
directly against this fork's existing bridge dispatcher (`executeCommand()`
in `src/scripts/mcp-bridge-auto.jsx` + a matching `server.tool()`
registration in `src/index.ts`) — the project-lifecycle tools are a
concrete, already-verified template for exactly this kind of addition (see
the spec
section above for the wiring checklist).
