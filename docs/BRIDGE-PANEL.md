# Bridge Panel (`mcp-bridge-auto.jsx`)

The bridge panel is the ScriptUI window that runs inside After Effects (**Window → mcp-bridge-auto.jsx**). It hosts the socket/file listener that the MCP server talks to, and gives a live view of transport health.

## Status block

| Field | Meaning |
|---|---|
| **Socket** | `LISTENING 127.0.0.1:<port>` when the panel has successfully bound a local TCP socket and is accepting commands from the MCP server — this is the primary transport. Shows `OFF (<reason>)` if it failed to bind. |
| **Permission** | `ENABLED` / `DISABLED`. Reflects AE's *"Allow Scripts to Write Files and Access Network"* preference. Must be `ENABLED` for the socket to bind at all — if it's `DISABLED`, the socket can't start and everything silently drops to file transport. |
| **File fallback** | `ON`/`OFF` plus the shared bridge folder path (e.g. `C:\Users\<you>\AppData\Local\ae-mcp-bridge`). This is the older, slower transport: the server writes a command file, the panel polls for it, and writes a result file back. Kept as a safety net for when the socket is unavailable. |
| **`N socket / M file`** | Running counters of how many commands have been served over each transport. All-socket traffic (`M = 0`) confirms the fast path is actually in use and nothing is silently degrading to file polling. |
| **`last <command> <ms>`** | Name and round-trip time of the most recently executed command. |
| **`errors N \| rejected N`** | `errors` = commands that threw an exception inside After Effects while executing. `rejected` = commands the panel refused before execution (malformed payload, protocol version mismatch, duplicate command id, etc). Both `0` means every command that arrived ran cleanly. |

## Port row

| Control | Action |
|---|---|
| **Port** field | The TCP port the socket listens on. Editable. |
| **Apply** | Commits a new port value to the running listener without a full teardown/rebind. |
| **Restart listener** | Fully stops and rebinds the socket. Use this if the socket gets stuck, after changing the port, or after `check-bridge` reports a listener that isn't answering. |

## Checkboxes

| Checkbox | Effect |
|---|---|
| **Auto-run commands** | When checked (default), incoming commands execute immediately as they arrive. Unchecking pauses automatic execution — a safety switch for reviewing/holding commands before they touch the project. |
| **Socket** / **File** | Enable or disable each transport independently. Turning a transport off removes it from `check-bridge`'s list of usable listeners. |
| **Verbose log** | When checked, every internal state transition is written to the Command Log immediately. When unchecked, log updates are throttled (flushed periodically) to avoid noisy/frequent UI redraws. |

## Buttons

| Button | Action |
|---|---|
| **Check now** | Forces an immediate refresh of the diagnostics fields instead of waiting for the next periodic tick. |
| **Copy diagnostics** | Opens a modal with the diagnostics as plain text (version, socket/permission state, counters). ScriptUI has no real clipboard API, so this is the way to get the info out — select and copy manually, e.g. to paste into a bug report. |
| **Clear log** | Empties the Command Log text box. |

## Command Log

A running, timestamped feed of each command's lifecycle:

```
HH:MM:SS: Executing command: <name>
HH:MM:SS: Calling <name> function...
HH:MM:SS: Returned from <name>.
HH:MM:SS: Command completed successfully: <name> (<N> ms)
```

Useful for confirming a specific MCP tool call actually reached AE and how long it took, independent of what the MCP client reports.

## Cross-check with `check-bridge`

The MCP tool `check-bridge` reads this same state from the server side (via a ping over whichever transport is selected) and reports it back as JSON — `bridgeVersion`, `aeVersion`, `transportInUse`, `pingMs`, and the full `socket.allListeners` list (every port with a panel open, which one is targeted, and why others were skipped). If `check-bridge` and the panel disagree, `Restart listener` in the panel or re-running `npm run install-bridge` + restarting After Effects is the usual fix.
