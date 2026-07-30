/*
 * First live smoke test for the C4 socket listener in mcp-bridge-auto.jsx.
 *
 * This is NOT the full E2E suite (that's C7's job, once check-bridge and
 * sendBridgeCommand are transport-aware). It talks to the rendezvous file and
 * the socket directly, bypassing src/index.ts entirely, so a bug in the panel
 * cannot hide behind the file-transport fallback that sendBridgeCommand would
 * otherwise silently take.
 *
 * Run after installing the bridge and reopening the panel in AE, on a
 * disposable scratch project:
 *   node manual-tests/socket-smoke-test.mjs
 */
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BRIDGE_DIR =
  process.env.AE_MCP_BRIDGE_DIR ||
  path.join(process.env.LOCALAPPDATA || os.homedir(), "ae-mcp-bridge");

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    console.log(`!!! FAILED: ${msg}`);
    failures++;
  } else {
    console.log(`OK: ${msg}`);
  }
}

function findRendezvous() {
  const files = fs.readdirSync(BRIDGE_DIR).filter((f) => /^ae_bridge_port_\d+\.json$/.test(f));
  if (files.length === 0) return null;
  const parsed = files
    .map((f) => {
      const data = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, f), "utf8"));
      return { file: f, ...data };
    })
    .sort((a, b) => a.port - b.port);
  return parsed[0];
}

function sendRaw(port, line, { readMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (o) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {}
      resolve(o);
    };
    const timer = setTimeout(
      () => done({ ok: true, timedOut: true, text: Buffer.concat(chunks).toString("utf8") }),
      readMs,
    );
    sock.setNoDelay(true);
    sock.on("connect", () => sock.write(line));
    sock.on("data", (c) => {
      chunks.push(c);
      const text = Buffer.concat(chunks).toString("utf8");
      const lines = text.split("\n").filter(Boolean);
      if (lines.length >= 2) {
        clearTimeout(timer);
        done({ ok: true, text, lines });
      }
    });
    sock.on("close", () => {
      clearTimeout(timer);
      done({ ok: true, closed: true, text: Buffer.concat(chunks).toString("utf8") });
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      done({ ok: false, code: e.code, message: e.message });
    });
  });
}

console.log(`Bridge dir: ${BRIDGE_DIR}`);
const rv = findRendezvous();
assert(!!rv, `rendezvous file found in ${BRIDGE_DIR}`);
if (!rv) {
  console.log("No rendezvous file. Is the panel open, and is BRIDGE_VERSION 1.12.0-mcp-socket?");
  process.exit(1);
}
console.log(
  `  -> port=${rv.port} v=${rv.v} bridgeVersion=${rv.bridgeVersion} aeVersion=${rv.aeVersion}`,
);
assert(rv.v === 1, "rendezvous v is 1");
assert(
  rv.bridgeVersion === "1.12.0-mcp-socket",
  `bridgeVersion is 1.12.0-mcp-socket (got ${rv.bridgeVersion})`,
);
assert(typeof rv.token === "string" && rv.token.length > 0, "rendezvous carries a token");

// --- 1: valid ping ---------------------------------------------------------
const id1 = `smoke-${Date.now()}-1`;
const line1 =
  JSON.stringify({ v: 1, token: rv.token, commandId: id1, command: "ping", args: {} }) + "\n";
const r1 = await sendRaw(rv.port, line1);
console.log(`  raw: ${JSON.stringify(r1).slice(0, 400)}`);
assert(r1.ok && r1.lines && r1.lines.length >= 2, "got at least ACK + result line for ping");
if (r1.lines) {
  const ack = JSON.parse(r1.lines[0]);
  const result = JSON.parse(r1.lines[1]);
  assert(ack._ack === 1 && ack.commandId === id1, "first line is a valid ACK for our commandId");
  assert(result._commandId === id1, "result line carries our commandId");
  assert(
    result._transport === "socket",
    `result is stamped _transport:"socket" (got ${result._transport})`,
  );
}

// --- 2: wrong token is rejected before dispatch -----------------------------
const id2 = `smoke-${Date.now()}-2`;
const line2 =
  JSON.stringify({ v: 1, token: "not-the-real-token", commandId: id2, command: "ping", args: {} }) +
  "\n";
const r2 = await sendRaw(rv.port, line2, { readMs: 3000 });
console.log(`  raw: ${JSON.stringify(r2).slice(0, 300)}`);
if (r2.text) {
  const firstLine = r2.text.split("\n").filter(Boolean)[0];
  const parsed = firstLine ? JSON.parse(firstLine) : null;
  assert(
    parsed && parsed._ack === 0 && parsed.error === "unauthorized",
    "wrong token gets _ack:0 unauthorized, not dispatched",
  );
}

// --- 3: Arabic round trip through getProjectInfo-shaped echo ---------------
// Use a command that echoes args back if available; ping does not carry args,
// so this uses execute-script equivalent via a real command: getProjectInfo
// has no args to echo, so we instead verify framing via a big/unicode ping
// wrapper is not available. Fall back to confirming raw bytes are intact by
// checking the JSON parses cleanly despite non-ASCII in the commandId.
const id3 = `smoke-${Date.now()}-مرحبا`;
const line3 =
  JSON.stringify({ v: 1, token: rv.token, commandId: id3, command: "ping", args: {} }) + "\n";
const r3 = await sendRaw(rv.port, line3);
if (r3.lines) {
  const result = JSON.parse(r3.lines[1]);
  assert(result._commandId === id3, "Arabic commandId round trips exactly through ACK+result");
}

// --- 4: malformed line gets rejected, connection does not hang -------------
const r4 = await sendRaw(rv.port, "not even json\n", { readMs: 3000 });
console.log(`  raw: ${JSON.stringify(r4).slice(0, 300)}`);
if (r4.text) {
  const firstLine = r4.text.split("\n").filter(Boolean)[0];
  const parsed = firstLine ? JSON.parse(firstLine) : null;
  assert(
    parsed && parsed._ack === 0 && parsed.error === "bad-request",
    "malformed line gets _ack:0 bad-request",
  );
} else {
  assert(false, "malformed line: bridge did not respond within budget (silent hang?)");
}

// --- 5: rebind check - is the rendezvous file still the same after all this?
const rv2 = findRendezvous();
assert(!!rv2 && rv2.port === rv.port, "listener still bound to the same port after 4 commands");

console.log(`\n=== DONE: ${failures === 0 ? "ALL PASSED" : failures + " FAILED"} ===`);
process.exit(failures === 0 ? 0 : 1);
