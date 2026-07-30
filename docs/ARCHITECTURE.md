# Architecture

This document explains how the server talks to After Effects and how the code is
organized.

## Two transports, one contract

The MCP server (Node) and the panel that runs inside After Effects (ExtendScript)
never call each other directly across process boundaries in the usual sense - the
server does not import AE's scripting DOM, and the panel is not a Node process.
They communicate over one of two transports, chosen automatically:

- **Socket (preferred).** The panel opens a real TCP listener on loopback; the
  server connects, sends one command, and reads one result back over the wire.
  ExtendScript's `Socket` object supports this natively (`listen()`, non-blocking
  `poll()`, `readln()`/`write()`) - an earlier version of this document claimed
  otherwise, which was never actually true, only untested.
- **File (automatic fallback).** Two JSON files in a shared folder, polled on a
  timer. This is the original transport and it never went away: the socket layers
  on top of it, and every one of the 80-odd tools falls back to it automatically
  whenever the socket is unavailable.

Every tool goes through one function, `sendBridgeCommand`, which tries the socket
first and falls back to files. Its signature and return contract - the raw result
string, a synthetic timeout envelope, never throwing - are identical regardless of
which transport actually served the command, so nothing above that function knows
or needs to know which one ran.

```
MCP client ──stdio──▶ MCP server (Node, src/index.ts)
                            │
                            │  sendBridgeCommand(command, args)
                            ▼
                  ┌─── socket available? ───┐
                  │ yes                   no │
                  ▼                          ▼
        TCP :47800-47815              shared bridge folder
        (one connection,              ae_command.json / ae_mcp_result.json
         NDJSON, ACK then result)     (polled on a timer)
                  │                          │
                  └──────────┬───────────────┘
                             ▼
              AE panel (ExtendScript, src/scripts/mcp-bridge-auto.jsx)
              serves BOTH transports from one 50ms tick
```

## The socket transport

The panel listens on loopback (`127.0.0.1`), trying ports `47800`-`47815` in
order and publishing whichever one it actually bound - see "Port rendezvous"
below, since `listen()` cannot be told which interface or port to use and
ExtendScript has no way to report back an ephemeral port. One connection serves
exactly one command: connect, send a newline-terminated JSON command line, get
back a newline-terminated JSON result line, done. This matches the existing
concurrency model exactly (one bridge interaction at a time, serialized by the
same mutex that already existed for the file transport), so there is no
persistent-connection state machine, keepalive, or reconnect logic to reason
about.

**The ACK is the whole safety story.** The panel writes a one-line
acknowledgement _before_ it dispatches the command to its handler:

```
-> {"v":1,"token":"<hex>","commandId":"...","command":"getCompFull","args":{...}}
<- {"_ack":1,"commandId":"...","bridgeVersion":"1.12.0-mcp-socket"}
<- {"status":"success", ..., "_commandId":"...", "_transport":"socket"}
   [panel closes the connection]
```

That ordering is what makes the automatic fallback provably safe rather than a
guess: a failure _before_ a valid ACK (refused connection, no ACK within 1.5s, an
explicit rejection) proves nothing executed in After Effects, so retrying the
same command over the file transport cannot double-run it. A failure _after_ the
ACK proves the opposite - the command may already be running - so it is reported
as an error instead, never retried. This is encoded in exactly one place,
`canFallbackFrom()` in `src/lib/bridge-socket-client.ts`, and every other piece
of the transport-selection logic in `src/index.ts` defers to it.

**Blocking commands are not a problem.** A multi-minute render leaves the
connection open but idle; neither side imposes an idle timeout on it (Node
deliberately does not use `socket.setTimeout`, since that is an idle timer and
would kill the exact commands it's meant to protect). Each side bounds only its
own per-operation waits: the panel's `conn.timeout` bounds reading the command
line, and the server's ACK/deadline timers are ordinary elapsed-time `setTimeout`
calls, not socket-idle timers.

**Port rendezvous is a file, not a shared environment variable.** The panel
publishes what it actually bound into the same shared bridge folder the file
transport already uses:

```
<bridgeFolder>/ae_bridge_port_47800.json
{ "v":1, "port":47800, "token":"<32 hex>", "bridgeVersion":"1.12.0-mcp-socket",
  "aeVersion":"26.0x67", "boundAt":"<iso>", "project":"MyProject.aep" }
```

This has to be a file rather than an env var read by both sides:
`$.getenv` inside ExtendScript sees none of the `AE_MCP_BRIDGE_*` variables (After
Effects is not launched from the MCP client's environment), and `listen()` gives
ExtendScript no way to learn which port it actually got if it asked for an
ephemeral one. With a pinned port unset, the server targets the **lowest**
published port, which keeps a second After Effects instance from silently
re-targeting a user already working in the first one. See
[`SECURITY.md`](../SECURITY.md) for what the token in that file does and does not
protect against.

## The file bridge (automatic fallback)

1. The server clears the result file, then writes `ae_command.json` containing the
   command name, its arguments, and a unique `commandId`.
2. The panel, polling on the same tick that services the socket, sees a new
   command, runs it against the AE scripting DOM inside a single undo group, and
   writes `ae_mcp_result.json` with the result and the same `commandId`.
3. The server polls the result file and returns the payload whose `commandId`
   matches the command it sent, so results never cross wires when several commands
   run in a row.

The whole clear-write-wait cycle is serialized by the same promise-queue mutex
that serializes the socket path, so two concurrent tool calls cannot clobber each
other's files or interleave a socket command with a file command.

## The shared folder

Both sides must resolve to the **same** folder - it carries both the file-transport
JSON files and the socket's rendezvous files. On Windows, `Documents` is often
redirected to OneDrive (Known Folder Move), which would make Node and After
Effects compute different paths that never meet, producing a permanent timeout.
To avoid that:

- **Windows:** `%LOCALAPPDATA%\ae-mcp-bridge` (never redirected by OneDrive).
- **macOS:** `~/Documents/ae-mcp-bridge`.
- **Override:** set the `AE_MCP_BRIDGE_DIR` environment variable for **both** the
  MCP server process and After Effects.

## Versioning and health

The panel reports a `BRIDGE_VERSION`; the server knows the `EXPECTED_BRIDGE_VERSION`
it was built against. The `check-bridge` tool compares them and flags a stale panel,
which catches the common "edited the server but forgot to re-run `install-bridge`"
case (old panel + new server = unknown command). Since 1.12.0, `check-bridge` also
probes every published rendezvous file directly - not just the one selected - and
classifies exactly why the socket transport is or isn't usable (no listener
published, the network permission is off, the wrong token, a protocol mismatch,
a dead port, or After Effects simply being busy), rather than collapsing all of
those into one indistinguishable timeout the way the file-only bridge had to.

## Code layout

| Path                              | Role                                                                                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                    | The MCP server: tool registrations and bridge dispatch (`sendBridgeCommand`, transport selection).                                                    |
| `src/lib/bridge-core.ts`          | Pure helpers: result parsing, atomic writes, path/platform resolution, command-id generation. Unit tested.                                            |
| `src/lib/bridge-socket.ts`        | Pure socket-transport protocol: port candidates, rendezvous parsing/selection, NDJSON framing. Unit tested.                                           |
| `src/lib/bridge-socket-client.ts` | The Node side of one socket command: connect, send, classify the outcome. Unit tested against a real `net` server.                                    |
| `src/lib/preset-scan.ts`          | Recursive `.ffx` preset scanner. Unit tested.                                                                                                         |
| `src/lib/wav.ts`                  | Pure WAV amplitude analysis and peak detection. Unit tested.                                                                                          |
| `src/scripts/mcp-bridge-auto.jsx` | The ExtendScript panel that runs inside After Effects: serves both transports, executes queued commands. ES3-era; not Node, never compiled or linted. |
| `tests/*.test.ts`                 | Vitest unit tests for the pure core, plus an end-to-end suite driving the real built server over MCP stdio against fake file and socket panels.       |
| `tests/probe-live-ae.cjs`         | Manual probe against a live After Effects (not part of the automated suite).                                                                          |
| `manual-tests/*.mjs`              | Manual end-to-end scripts against a live After Effects and a live MCP server process.                                                                 |

The rule of thumb: logic that can run without a live After Effects lives in
`src/lib/` and is unit tested; everything that needs the running app goes through
the bridge.

## Reliability properties

- **Per-command ids:** every command is matched by id, shared across a socket
  attempt and its file-transport retry, so a tool waits for its own result
  instead of guessing by command name and a fallback retry can never be mistaken
  for a second, unrelated command.
- **Atomic writes:** command and result files are written to a temporary sibling
  and renamed into place, so a reader never sees a half-written file.
- **One undo group per command:** a single Ctrl/Cmd+Z cleanly reverses any command,
  on either transport.
- **Errors surface as errors:** AE-side failures are flagged so the client treats
  them as errors, not silently successful output.
- **A failure that could have double-executed a command is never retried:** the
  socket transport falls back to files only from a state proven to have executed
  nothing (see "The socket transport" above); this is the one correctness rule
  the whole feature is built around.
