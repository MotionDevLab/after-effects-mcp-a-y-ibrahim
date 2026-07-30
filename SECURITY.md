# Security Policy

## Supported versions

The latest release on the `main` branch is the only supported version.

## Reporting a vulnerability

Please do not open a public issue for security problems. Instead, report them
privately through GitHub's [security advisories](https://github.com/a-y-ibrahim/after-effects-mcp/security/advisories/new)
for this repository. You can expect an initial response within a few days.

## Known advisories in the MCP SDK's HTTP transport

`npm audit` currently reports advisories in `@modelcontextprotocol/sdk` and its
Express dependency chain (`express`, `body-parser`, `path-to-regexp`, `qs`). Every
one of these is in the SDK's **Streamable HTTP / SSE transport**.

This server uses **`StdioServerTransport` only** (see `src/index.ts`). It never
starts an HTTP server, so Express and its dependencies are installed but never
loaded or reachable. The DNS-rebinding advisory is HTTP-transport-specific by
definition, and the ReDoS/DoS advisories live in HTTP request-parsing code paths
this server does not execute.

The SDK versions that patch these advisories currently trigger a TypeScript
compiler regression (unbounded type inference across this server's tool
registrations) that fails the build, so the dependency is pinned to a version
that builds. This is tracked, and the pin will be lifted once a patched SDK
release compiles cleanly. If you expose this server over HTTP by modifying it,
re-evaluate these advisories first.

## Scope worth knowing about

This server exposes an `execute-script` tool that runs arbitrary ExtendScript
inside After Effects, and the AE panel requires the "Allow Scripts to Write Files
and Access Network" permission to function. That is by design: the whole point is
to give an AI assistant programmatic control of After Effects. Treat the MCP
server the same way you would treat a local shell. Only connect it to clients you
trust, and be aware that any prompt able to reach the server can, in principle,
run scripts and read or write files that After Effects can.

## The socket transport binds all interfaces, not just loopback

Since 1.12.0, the After Effects panel prefers a TCP socket transport over the
original file-polling one (see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)).
Be aware of exactly what it does and does not protect against.

**The bind is wider than intended.** ExtendScript's `Socket.listen()` takes no
interface argument, and measured against a live After Effects instance it binds
`0.0.0.0` and `[::]` - every network interface, not only loopback (127.0.0.1).
There is no way to restrict it to loopback from ExtendScript. On a machine with
no other mitigation, this means a port in `47800`-`47815` running arbitrary
ExtendScript (the same `execute-script` capability mentioned above) is reachable
from your LAN, not just from the machine itself.

**The token is a nuisance barrier and a protocol tag, not authentication.**
Every command must carry a token published in a rendezvous file
(`ae_bridge_port_<port>.json`) in the shared bridge folder. This is worth having

- it makes a foreign process squatting the port fail loudly instead of hanging,
  and it means a random LAN scanner cannot simply issue commands without first
  reading a file that (by default) only this machine's user account can read - but
  it is **not cryptographic access control**. ExtendScript has no CSPRNG available
  to it, so the token is generated from timestamp and timer jitter, not a secure
  random source. Anyone who can already read that file - any local process running
  as the same user - could already write `ae_command.json` directly under the
  original file transport, so the token restores parity with that transport and
  claims nothing beyond it.

**What actually mitigates this:**

- **A firewall rule is the real boundary**, not the token. `npm run install-bridge`
  prints the exact rule to add; run it yourself (this project does not modify
  firewall settings programmatically, and never will without you running the
  command):

  ```powershell
  # Windows: block inbound connections to the bridge's port range from
  # anywhere except this machine itself.
  New-NetFirewallRule -DisplayName "AE MCP Bridge (loopback only)" `
    -Direction Inbound -Protocol TCP -LocalPort 47800-47815 -Action Block `
    -RemoteAddress Internet,Intranet -Profile Any
  ```

  On macOS, use the built-in Application Firewall or `pf` to block inbound TCP on
  `47800-47815` from anything but `127.0.0.1`.

- **`check-bridge` surfaces the exposure.** It reports the socket's problem state
  (or `null` when healthy) and lists every listener currently published in the
  bridge folder, so you can see at a glance whether a socket is open and on which
  port.
- **If you would rather not run a socket at all**, set
  `AE_MCP_BRIDGE_TRANSPORT=file` in the MCP server's environment. This is a full
  kill switch: the server never opens a socket connection and uses only the
  original file-polling transport, at the cost of the latency improvement.
- **The permission this already requires** ("Allow Scripts to Write Files and
  Access Network") is the same permission the file transport has always needed;
  the socket transport adds no new AE-side permission to grant.
