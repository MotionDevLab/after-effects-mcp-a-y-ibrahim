// Pure protocol core for the TCP socket bridge transport. Everything here is
// deterministic given its inputs: no sockets, no filesystem, no clock. The
// actual connecting lives in bridge-socket-client.ts and the actual file reads
// live in index.ts, so this module can be exercised exhaustively in CI.
//
// Topology (see docs/ARCHITECTURE.md): After Effects LISTENS on loopback and
// Node connects once per command. ExtendScript's only non-blocking primitive is
// Socket.poll(), and it exists solely on the listening side, so the panel has to
// be the server. The payoff is diagnostic: "panel not open" becomes an instant
// ECONNREFUSED instead of a silent timeout.

/**
 * First port the AE panel tries to bind. Chosen inside the IANA
 * registered-but-unassigned band and deliberately below Windows' ephemeral
 * range start (49152), so the scan can never collide with a port the OS is
 * handing out to unrelated processes.
 */
export const SOCKET_PORT_BASE = 47800;

/** How many consecutive ports the panel scans before giving up (47800..47815). */
export const SOCKET_PORT_TRIES = 16;

/** Wire protocol version, carried in both the command line and the rendezvous file. */
export const PROTOCOL_VERSION = 1;

/**
 * How long a cached discovery result stays valid. A closed panel therefore
 * costs one wasted ECONNREFUSED every 5 seconds rather than one per command.
 */
export const REDISCOVER_MS = 5000;

/**
 * How long to wait for the panel's ACK line before concluding the peer is not
 * our bridge. Every bridge >= 1.12 ACKs before dispatching, so a missing ACK is
 * proof that nothing executed, which is what makes falling back safe.
 */
export const ACK_TIMEOUT_MS = 1500;

/**
 * Bound on the TCP connect itself. Loopback connects and refusals both resolve
 * in microseconds; this exists only to stop a pathological firewall from
 * stalling a command for its full timeout.
 */
export const CONNECT_TIMEOUT_MS = 400;

/** Rendezvous files older than this with a dead port are safe to delete. */
export const RENDEZVOUS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Valid values for the AE_MCP_BRIDGE_TRANSPORT escape hatch. */
export type TransportMode = "auto" | "socket" | "file";

/**
 * What the AE panel publishes into the bridge folder once it has actually bound
 * a port. `port` is authoritative: the scan makes it non-deterministic by
 * design, so nothing except this file can report which port was really taken.
 */
export interface Rendezvous {
  v: number;
  port: number;
  token: string;
  bridgeVersion: string;
  aeVersion: string;
  boundAt: string;
  project: string;
}

/** True for an integer in the usable TCP port range. */
export function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * The ordered list of ports to try. `preferred` (the panel's saved port setting
 * or AE_MCP_BRIDGE_PORT) is attempted first and then never repeated, so a user
 * who pinned 47805 keeps it across restarts but still degrades gracefully to the
 * normal scan if something else has taken it meanwhile.
 */
export function candidatePorts(
  preferred?: number | null,
  base: number = SOCKET_PORT_BASE,
  tries: number = SOCKET_PORT_TRIES,
): number[] {
  const ports: number[] = [];
  if (isValidPort(preferred)) ports.push(preferred);
  for (let i = 0; i < tries; i++) {
    const p = base + i;
    if (!isValidPort(p)) break;
    if (ports.indexOf(p) === -1) ports.push(p);
  }
  return ports;
}

/** The rendezvous file name for a given port. Must match the .jsx exactly. */
export function rendezvousFileName(port: number): string {
  return `ae_bridge_port_${port}.json`;
}

/**
 * Recover the port from a rendezvous file name, or null if the name is not one.
 * Used to enumerate live listeners without opening every file in the folder.
 */
export function parseRendezvousFileName(name: string): number | null {
  const m = /^ae_bridge_port_(\d{1,5})\.json$/.exec(name);
  if (!m) return null;
  const port = Number(m[1]);
  return isValidPort(port) ? port : null;
}

/**
 * Parse a rendezvous file's contents. Never throws: a truncated, empty, or
 * hand-mangled file is just "no listener here", which the caller already has to
 * handle because the panel may have died between writing and binding.
 *
 * When `expectedPort` is supplied (the port recovered from the file name) a
 * disagreement rejects the file. The panel always names the file after the port
 * it bound, so a mismatch means the file was copied or corrupted, and trusting
 * either number would aim commands at a port nobody is serving.
 *
 * `v` is preserved rather than validated here so callers can tell a genuine
 * protocol mismatch (a future panel) apart from an absent listener; use
 * isSupportedRendezvous for that check.
 */
export function parseRendezvous(raw: string, expectedPort?: number): Rendezvous | null {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (!isValidPort(parsed.port)) return null;
  if (expectedPort !== undefined && parsed.port !== expectedPort) return null;
  if (typeof parsed.token !== "string" || parsed.token.length === 0) return null;

  const str = (value: unknown): string => (typeof value === "string" ? value : "");
  return {
    v: typeof parsed.v === "number" ? parsed.v : 0,
    port: parsed.port,
    token: parsed.token,
    bridgeVersion: str(parsed.bridgeVersion),
    aeVersion: str(parsed.aeVersion),
    boundAt: str(parsed.boundAt),
    project: str(parsed.project),
  };
}

/** True when we speak this rendezvous file's protocol version. */
export function isSupportedRendezvous(r: Rendezvous): boolean {
  return r.v === PROTOCOL_VERSION;
}

/**
 * True when a rendezvous file is old enough to be worth deleting (the caller
 * still confirms the port actually refuses before unlinking). An unparseable
 * `boundAt` counts as NOT stale: we would rather leave a file we do not
 * understand than delete a live listener's.
 */
export function isStaleRendezvous(
  r: Rendezvous,
  now: number,
  maxAgeMs: number = RENDEZVOUS_MAX_AGE_MS,
): boolean {
  const t = Date.parse(r.boundAt);
  if (Number.isNaN(t)) return false;
  return now - t > maxAgeMs;
}

/**
 * Pick which listener to talk to.
 *
 * With a pinned port, only that exact listener is eligible: the pin means
 * "connect here only", so silently drifting elsewhere would defeat the whole
 * point of the escape hatch.
 *
 * Otherwise the LOWEST port wins. Lowest rather than most-recently-bound is
 * what makes two After Effects instances predictable: launching a second AE
 * cannot silently re-target a user who is working in the first one, and the
 * choice stays stable across restarts.
 */
export function selectRendezvous(
  listeners: Rendezvous[],
  pinnedPort?: number | null,
): Rendezvous | null {
  if (listeners.length === 0) return null;
  if (isValidPort(pinnedPort)) {
    for (const r of listeners) if (r.port === pinnedPort) return r;
    return null;
  }
  let best = listeners[0];
  for (const r of listeners) if (r.port < best.port) best = r;
  return best;
}

/**
 * Build the single newline-terminated line that carries a command to AE.
 * JSON.stringify escapes every `\n` and `\r` inside the payload, so the
 * terminator can never appear mid-frame and NDJSON framing stays unambiguous.
 */
export function encodeCommandLine(input: {
  token: string;
  commandId: string;
  command: string;
  args: unknown;
}): string {
  return (
    JSON.stringify({
      v: PROTOCOL_VERSION,
      token: input.token,
      commandId: input.commandId,
      command: input.command,
      args: input.args ?? {},
    }) + "\n"
  );
}

/**
 * True when `line` is the panel's ACK for `commandId`. The ACK is written
 * before the command is dispatched, which is what separates "connection alive"
 * from "command finished" and lets a ten minute render coexist with a 1.5s
 * liveness check.
 */
export function isAckLine(line: string, commandId?: string): boolean {
  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  if (parsed._ack !== 1) return false;
  if (commandId !== undefined && parsed.commandId !== commandId) return false;
  return true;
}

/** Incremental NDJSON reader over raw TCP chunks. */
export interface FrameReader {
  /** Feed one chunk; returns every complete line it completed, in order. */
  push(chunk: Buffer): string[];
  /** Bytes buffered so far without a terminator (for diagnostics and limits). */
  pending(): number;
  /** Take any unterminated trailing bytes as a final line, e.g. on peer close. */
  flush(): string | null;
}

/**
 * Split incoming bytes into newline-delimited frames.
 *
 * The split happens on the BYTE 0x0A before any decoding, never on a decoded
 * string. TCP can put a chunk boundary anywhere, including the middle of a
 * multibyte UTF-8 sequence, and `chunk.toString("utf8")` on a partial sequence
 * silently yields U+FFFD. Splitting bytes first is safe because 0x0A cannot
 * occur inside a UTF-8 multibyte sequence (continuation bytes are all >= 0x80).
 * This is the same corruption class the panel's explicit UTF-8 encoding guards
 * against on the AE side, and it is why Arabic payloads get a dedicated test.
 */
export function createFrameReader(): FrameReader {
  let buf = Buffer.alloc(0);

  return {
    push(chunk: Buffer): string[] {
      buf = buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([buf, chunk]);
      const lines: string[] = [];
      let start = 0;
      for (;;) {
        const nl = buf.indexOf(0x0a, start);
        if (nl === -1) break;
        let end = nl;
        // Tolerate CRLF even though the panel writes a bare LF.
        if (end > start && buf[end - 1] === 0x0d) end -= 1;
        lines.push(buf.subarray(start, end).toString("utf8"));
        start = nl + 1;
      }
      if (start > 0) buf = buf.subarray(start);
      return lines;
    },

    pending(): number {
      return buf.length;
    },

    flush(): string | null {
      if (buf.length === 0) return null;
      const rest = buf.toString("utf8");
      buf = Buffer.alloc(0);
      return rest;
    },
  };
}

/**
 * Read the transport escape hatch. `socket` never falls back (used in CI so the
 * socket path cannot rot behind a working fallback) and `file` is the kill
 * switch. Anything unrecognized means `auto`, because a typo in a client config
 * should not disable the bridge.
 */
export function readTransportMode(env: NodeJS.ProcessEnv): TransportMode {
  const raw = (env.AE_MCP_BRIDGE_TRANSPORT || "").trim().toLowerCase();
  if (raw === "socket" || raw === "file" || raw === "auto") return raw;
  return "auto";
}

/**
 * Read AE_MCP_BRIDGE_PORT. Deliberately one-sided: on the Node server this
 * means "connect to this port only", while the panel treats the same variable
 * as merely the first candidate to try.
 */
export function readPinnedPort(env: NodeJS.ProcessEnv): number | null {
  const raw = (env.AE_MCP_BRIDGE_PORT || "").trim();
  if (raw.length === 0) return null;
  const port = Number(raw);
  return isValidPort(port) ? port : null;
}

/**
 * Whether the cached rendezvous is old enough to re-read from disk.
 * `lastDiscoveryAt` of null means we have never looked.
 */
export function shouldRediscover(
  lastDiscoveryAt: number | null,
  now: number,
  ttlMs: number = REDISCOVER_MS,
): boolean {
  if (lastDiscoveryAt === null) return true;
  return now - lastDiscoveryAt >= ttlMs;
}
