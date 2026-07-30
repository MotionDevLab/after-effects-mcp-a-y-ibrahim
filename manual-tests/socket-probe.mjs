/*
 * Phase 0 feasibility probe for the TCP socket bridge transport.
 *
 * Answers S1-S12 from the socket-transport plan against a LIVE After Effects,
 * using the existing `execute-script` tool only - no bridge changes, no rebuild,
 * no panel reopen. This mirrors the discipline of manual-tests/shape-path-probe.mjs
 * (CONTEXT.md "Live feasibility probe"): prove the platform actually supports the
 * design BEFORE building anything on top of it.
 *
 * PROJECT SAFETY: this probe never creates, mutates, renders or saves anything in
 * the open project. It only opens/closes TCP sockets and reads a preference, so
 * the usual save-close-scratch-reopen dance is deliberately NOT performed. The
 * blocking test (S11) uses $.sleep instead of a real render, which is a strictly
 * harsher test of the same property (guaranteed zero yielding) and needs no comp.
 *
 * Three probes are HARD GATES for the plan:
 *   S3  - which interface does listen() bind? If 0.0.0.0, the token and the
 *         SECURITY.md note become mandatory rather than optional.
 *   S5  - is poll() genuinely non-blocking? The 50ms tick depends on it.
 *   S11 - does a connection made while AE is blocked survive in the backlog?
 *
 * Run with After Effects open and the MCP Bridge Auto panel running:
 *   node manual-tests/socket-probe.mjs
 */
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PORT = 47800;
const ALT_PORT = 47801;

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  cwd: "C:\\Users\\renat\\after-effects-mcp-a-y-ibrahim",
  stderr: "pipe",
});

const client = new Client({ name: "socket-probe", version: "1.0.0" });
await client.connect(transport);
transport.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));

let stepNum = 0;
let failures = 0;
const findings = {};

async function call(name, args = {}, { quiet = false } = {}) {
  stepNum++;
  console.log(`\n=== STEP ${stepNum}: ${name} ===`);
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? JSON.stringify(res);
  if (!quiet) console.log(String(text).slice(0, 2000));
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { res, parsed, text };
}

// execute-script returns {status:"success", result: <returned value>}
async function probe(label, script, { timeoutMs = 60000 } = {}) {
  const { parsed } = await call("execute-script", { script, timeoutMs });
  if (parsed?.status !== "success") {
    console.log(`!!! ${label}: execute-script itself failed`);
    failures++;
    findings[label] = { error: parsed?.error ?? parsed?.message ?? "unknown" };
    return null;
  }
  findings[label] = parsed.result;
  return parsed.result;
}

/*
 * Fire an execute-script that PARKS in a poll loop waiting for a connection,
 * then connect to it from Node while AE is still inside that call, then collect
 * the result. Node is not blocked while AE is, which is exactly what makes this
 * work: the bridge round trip and the socket under test are independent channels.
 */
async function probeWithConnection(
  label,
  script,
  clientFn,
  { settleMs = 1200, timeoutMs = 60000 } = {},
) {
  const pending = probe(label, script, { timeoutMs });
  await new Promise((r) => setTimeout(r, settleMs));
  let clientResult = null;
  try {
    clientResult = await clientFn();
  } catch (e) {
    clientResult = { clientError: String(e?.message ?? e) };
  }
  const aeResult = await pending;
  findings[label + "_node"] = clientResult;
  console.log(`  [node side] ${JSON.stringify(clientResult)?.slice(0, 600)}`);
  return { ae: aeResult, node: clientResult };
}

function assert(cond, msg) {
  if (!cond) {
    console.log(`!!! FAILED: ${msg}`);
    failures++;
  } else console.log(`OK: ${msg}`);
}
function note(msg) {
  console.log(`  -> ${msg}`);
}

// A tiny promise-based TCP client. Deliberately raw so it mirrors exactly what
// src/lib/bridge-socket-client.ts will have to do.
function tcpExchange(port, payload, { readMs = 8000, expectBytes = 0 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const chunks = [];
    let total = 0;
    let settled = false;
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (o) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {}
      resolve({ ...o, elapsedMs: Date.now() - started });
    };
    const timer = setTimeout(
      () =>
        done({
          ok: true,
          timedOut: true,
          bytes: total,
          text: Buffer.concat(chunks).toString("utf8").slice(0, 400),
        }),
      readMs,
    );
    sock.setNoDelay(true);
    sock.on("connect", () => {
      if (payload != null) sock.write(payload);
    });
    sock.on("data", (c) => {
      chunks.push(c);
      total += c.length;
      if (expectBytes && total >= expectBytes) {
        clearTimeout(timer);
        done({
          ok: true,
          bytes: total,
          text: Buffer.concat(chunks).toString("utf8").slice(0, 400),
        });
      }
    });
    sock.on("close", () => {
      clearTimeout(timer);
      done({
        ok: true,
        closedByPeer: true,
        bytes: total,
        text: Buffer.concat(chunks).toString("utf8").slice(0, 400),
      });
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      done({ ok: false, code: e.code, message: e.message });
    });
  });
}

console.log("\n############ SOCKET FEASIBILITY PROBE (S1-S12) ############");
console.log("This probe does NOT touch the open project. It only opens sockets.\n");

// =====================================================================
// S1 - Does the Socket object exist at all in the panel's engine?
// =====================================================================
const s1 = await probe(
  "S1",
  `
var out = { typeofSocket: typeof Socket };
try {
  var s = new Socket();
  out.constructed = true;
  out.defaultEncoding = s.encoding;
  out.defaultTimeout = s.timeout;
  // Enumerate what the object actually exposes: the plan asserts there is no
  // localPort (which is what kills ephemeral ports, S12).
  var props = [];
  for (var k in s) { props.push(k); }
  out.members = props;
  out.hasLocalPort = ("localPort" in s);
  out.hasHost = ("host" in s);
  s.close();
} catch (e) {
  out.constructed = false;
  out.error = e.toString();
}
return out;
`,
);
assert(s1?.typeofSocket === "function", `S1: Socket exists (typeof = ${s1?.typeofSocket})`);
assert(s1?.constructed === true, "S1: new Socket() constructs without throwing");
note(
  `default encoding = ${JSON.stringify(s1?.defaultEncoding)}, default timeout = ${s1?.defaultTimeout}`,
);
note(`members: ${JSON.stringify(s1?.members)}`);

// =====================================================================
// S2 - Can it listen? And does listen(port, "UTF-8") accept an encoding?
// =====================================================================
const s2 = await probe(
  "S2",
  `
var out = {};
// Clean up anything a previous probe run left bound.
try { if ($.global.__probeListener) { $.global.__probeListener.close(); } } catch (e) {}
$.global.__probeListener = null;

var s = new Socket();
s.encoding = "UTF-8";
s.timeout = 10;
try {
  out.listenReturned = s.listen(${PORT});
  out.listenThrew = false;
} catch (e) {
  out.listenThrew = true;
  out.listenError = e.toString();
}
out.encodingAfterListen = s.encoding;
out.socketError = s.error;
if (out.listenReturned) { $.global.__probeListener = s; }
else { try { s.close(); } catch (e2) {} }

// Second form: does listen accept an encoding argument?
var s2b = new Socket();
try {
  out.listenWithEncodingReturned = s2b.listen(${ALT_PORT}, "UTF-8");
  out.encodingAfterListenArg = s2b.encoding;
  try { s2b.close(); } catch (e3) {}
} catch (e4) {
  out.listenWithEncodingError = e4.toString();
}
return out;
`,
);
assert(
  s2?.listenReturned === true,
  `S2: listen(${PORT}) returned true (threw=${s2?.listenThrew}, err=${s2?.listenError ?? "none"})`,
);
note(`encoding after listen = ${JSON.stringify(s2?.encodingAfterListen)}`);
note(
  `listen(port,"UTF-8") = ${s2?.listenWithEncodingReturned}, encoding then = ${JSON.stringify(s2?.encodingAfterListenArg)}`,
);

// =====================================================================
// S3 - HARD GATE: which interface did listen() actually bind?
// =====================================================================
const s3 = await probe(
  "S3",
  `
var out = { os: $.os };
var isWin = ($.os.indexOf("Windows") !== -1);
out.platform = isWin ? "windows" : "mac";
try {
  var cmd = isWin
    ? 'cmd /c netstat -ano | findstr ${PORT}'
    : 'lsof -nP -iTCP:${PORT} -sTCP:LISTEN';
  out.command = cmd;
  out.raw = system.callSystem(cmd);
} catch (e) {
  out.callSystemError = e.toString();
}
if (out.raw) {
  var r = "" + out.raw;
  out.bindsLoopback  = (r.indexOf("127.0.0.1:${PORT}") !== -1);
  out.bindsWildcard  = (r.indexOf("0.0.0.0:${PORT}") !== -1) || (r.indexOf("*:${PORT}") !== -1) || (r.indexOf("[::]:${PORT}") !== -1);
}
return out;
`,
);
console.log("\n----- S3 RAW OUTPUT (read this carefully) -----");
console.log(s3?.raw ?? `(no output; callSystem error: ${s3?.callSystemError})`);
console.log("-----------------------------------------------");
if (s3?.bindsWildcard) {
  console.log("!!! GATE S3: listen() binds a WILDCARD address (0.0.0.0 / [::]).");
  console.log("!!! The bridge exposes unbounded eval(). The token in the plan is now MANDATORY,");
  console.log("!!! peer-address rejection (S4) must be used if available, and SECURITY.md must");
  console.log("!!! document the residual exposure plus a host firewall rule for 47800-47815.");
} else if (s3?.bindsLoopback) {
  console.log("GATE S3: listen() binds 127.0.0.1 only. Exposure is contained to the local host.");
} else {
  console.log("!!! GATE S3: INCONCLUSIVE. Inspect the raw output above by hand before proceeding.");
  failures++;
}

// =====================================================================
// S5 - HARD GATE: is poll() non-blocking with nothing pending?
// =====================================================================
const s5 = await probe(
  "S5",
  `
var out = {};
var s = $.global.__probeListener;
if (!s) { return { error: "no listener from S2" }; }
var t0 = (new Date()).getTime();
var results = [];
for (var i = 0; i < 20; i++) {
  var c = s.poll();
  results.push(c === null ? "null" : "conn");
  if (c) { try { c.close(); } catch (e) {} }
}
out.elapsedMsFor20Polls = (new Date()).getTime() - t0;
out.allNull = true;
for (var j = 0; j < results.length; j++) { if (results[j] !== "null") out.allNull = false; }
out.perPollMs = out.elapsedMsFor20Polls / 20;
return out;
`,
);
assert(s5?.allNull === true, "S5: poll() returns null when nothing is pending");
assert(
  typeof s5?.elapsedMsFor20Polls === "number" && s5.elapsedMsFor20Polls < 200,
  `S5: 20 polls took ${s5?.elapsedMsFor20Polls}ms (${s5?.perPollMs}ms each) - must be non-blocking for a 50ms tick`,
);

// =====================================================================
// S4 + S6 - Accepted socket: peer address readable? readln() on a big line?
// =====================================================================
const bigLine = "A".repeat(256 * 1024);
const s46 = await probeWithConnection(
  "S4_S6",
  `
var out = {};
var s = $.global.__probeListener;
if (!s) { return { error: "no listener from S2" }; }
var conn = null;
var t0 = (new Date()).getTime();
// Park in a NON-blocking poll loop (this is exactly the bridgeTick shape).
while (!conn && ((new Date()).getTime() - t0) < 15000) {
  conn = s.poll();
  if (!conn) { $.sleep(20); }
}
if (!conn) { return { error: "no connection arrived within 15s" }; }
out.acceptedAfterMs = (new Date()).getTime() - t0;

// S4: is the peer address readable? This decides whether AE can reject
// non-loopback peers itself, which is the strongest available control.
try { out.peerHost = conn.host; } catch (e) { out.peerHostError = e.toString(); }
out.hasHostProperty = ("host" in conn);

conn.encoding = "UTF-8";
conn.timeout = 30;

// S6: does readln() return a whole 256KB line, or truncate it?
var t1 = (new Date()).getTime();
var line = conn.readln();
out.readlnMs = (new Date()).getTime() - t1;
out.receivedLength = line ? line.length : 0;
out.expectedLength = ${bigLine.length};
out.truncated = (out.receivedLength !== out.expectedLength);
out.firstChars = line ? line.substr(0, 8) : null;
out.lastChars = line ? line.substr(line.length - 8) : null;
out.connectedAfterRead = conn.connected;
out.eof = conn.eof;

try { conn.write("ACK\\n"); } catch (e2) { out.writeError = e2.toString(); }
try { conn.close(); } catch (e3) {}
return out;
`,
  () => tcpExchange(PORT, bigLine + "\n", { readMs: 6000, expectBytes: 4 }),
);
assert(
  s46.ae?.acceptedAfterMs != null,
  `S4: poll() accepted the Node connection (after ${s46.ae?.acceptedAfterMs}ms)`,
);
if (s46.ae?.hasHostProperty && s46.ae?.peerHost) {
  console.log(
    `OK: S4: peer address IS readable ("${s46.ae.peerHost}") - AE can reject non-loopback peers directly. USE THIS.`,
  );
} else {
  console.log(
    `NOTE: S4: peer address NOT usable (host=${JSON.stringify(s46.ae?.peerHost)}, err=${s46.ae?.peerHostError}). Rely on the token alone.`,
  );
}
assert(
  s46.ae?.truncated === false,
  `S6: readln() returned the full 256KB line (got ${s46.ae?.receivedLength} of ${s46.ae?.expectedLength}) in ${s46.ae?.readlnMs}ms`,
);
if (s46.ae?.truncated) {
  console.log(
    "!!! S6: readln() TRUNCATES. The command line needs chunked reading, not a single readln().",
  );
}

// =====================================================================
// S7 - Can AE write a 4MB response, and does the peer receive all of it?
// =====================================================================
const FOUR_MB = 4 * 1024 * 1024;
const s7 = await probeWithConnection(
  "S7",
  `
var out = {};
var s = $.global.__probeListener;
if (!s) { return { error: "no listener from S2" }; }
var conn = null;
var t0 = (new Date()).getTime();
while (!conn && ((new Date()).getTime() - t0) < 15000) {
  conn = s.poll();
  if (!conn) { $.sleep(20); }
}
if (!conn) { return { error: "no connection arrived within 15s" }; }
conn.encoding = "UTF-8";
conn.timeout = 30;
conn.readln();   // drain the client's greeting

// Build 4MB by doubling (concatenation in a loop would be O(n^2) here).
var payload = "x";
while (payload.length < ${FOUR_MB}) { payload += payload; }
payload = payload.substr(0, ${FOUR_MB});
out.payloadLength = payload.length;

// First: a SINGLE write of the whole thing. What does it return?
var t1 = (new Date()).getTime();
try {
  out.singleWriteReturned = conn.write(payload);
  out.singleWriteThrew = false;
} catch (e) {
  out.singleWriteThrew = true;
  out.singleWriteError = e.toString();
}
out.singleWriteMs = (new Date()).getTime() - t1;
try { conn.write("\\n"); } catch (e2) {}
out.connectedAfterWrite = conn.connected;
try { conn.close(); } catch (e3) {}
return out;
`,
  () => tcpExchange(PORT, "GO\n", { readMs: 20000, expectBytes: FOUR_MB + 1 }),
);
const got = s7.node?.bytes ?? 0;
assert(
  got === FOUR_MB + 1,
  `S7: peer received all ${FOUR_MB + 1} bytes of a single 4MB write (got ${got}, threw=${s7.ae?.singleWriteThrew}, returned=${s7.ae?.singleWriteReturned}, ${s7.ae?.singleWriteMs}ms)`,
);
if (got !== FOUR_MB + 1) {
  console.log(
    `!!! S7: single write is LOSSY or capped. The 32KB chunked writeSocketLine loop is REQUIRED (the plan already assumes this).`,
  );
}

// =====================================================================
// S8 - Which getPrefAsLong form actually reads the network permission?
// =====================================================================
const s8 = await probe(
  "S8",
  `
var out = {};
try {
  out.twoArg = app.preferences.getPrefAsLong("Main Pref Section", "Pref_SCRIPTING_FILE_NETWORK_SECURITY");
} catch (e) { out.twoArgError = e.toString(); }
try {
  out.threeArg = app.preferences.getPrefAsLong("Main Pref Section", "Pref_SCRIPTING_FILE_NETWORK_SECURITY", PREFType.PREF_Type_MACHINE_INDEPENDENT);
} catch (e2) { out.threeArgError = e2.toString(); }
try {
  out.v2TwoArg = app.preferences.getPrefAsLong("Main Pref Section v2", "Pref_SCRIPTING_FILE_NETWORK_SECURITY");
} catch (e3) { out.v2TwoArgError = e3.toString(); }
try {
  out.havePref = app.preferences.havePref("Main Pref Section", "Pref_SCRIPTING_FILE_NETWORK_SECURITY", PREFType.PREF_Type_MACHINE_INDEPENDENT);
} catch (e4) { out.havePrefError = e4.toString(); }
out.aeVersion = app.version;
return out;
`,
);
note(`2-arg=${s8?.twoArg} 3-arg=${s8?.threeArg} v2=${s8?.v2TwoArg} havePref=${s8?.havePref}`);
const permForm =
  s8?.threeArg === 1
    ? "3-arg PREF_Type_MACHINE_INDEPENDENT"
    : s8?.twoArg === 1
      ? "2-arg"
      : s8?.v2TwoArg === 1
        ? "2-arg with 'Main Pref Section v2'"
        : null;
assert(
  permForm !== null,
  `S8: a getPrefAsLong form returns 1 (use: ${permForm ?? "NONE WORKED - permission may be OFF, or none of these forms is right"})`,
);

// =====================================================================
// S9 - Second listen() on an already-bound port: false, or throw?
// =====================================================================
const s9 = await probe(
  "S9",
  `
var out = {};
var s = new Socket();
s.encoding = "UTF-8";
try {
  out.returned = s.listen(${PORT});
  out.threw = false;
  out.socketError = s.error;
} catch (e) {
  out.threw = true;
  out.error = e.toString();
}
try { s.close(); } catch (e2) {}
out.conclusion = out.threw
  ? "THROWS - the port scan MUST wrap each listen() in try/catch"
  : (out.returned === false
      ? "returns false - a falsy check is enough, but keep try/catch anyway"
      : "returned TRUTHY on an already-bound port - DOUBLE BINDING, investigate before shipping");
return out;
`,
);
note(`S9: ${s9?.conclusion}`);
assert(
  s9?.threw === true || s9?.returned === false,
  `S9: a second listen(${PORT}) does not silently succeed (threw=${s9?.threw}, returned=${s9?.returned})`,
);

// =====================================================================
// S10 - Override plumbing: $.getenv and app.settings round-trip
// =====================================================================
const s10 = await probe(
  "S10",
  `
var out = {};
try { out.envPort = $.getenv("AE_MCP_BRIDGE_PORT"); } catch (e) { out.envError = e.toString(); }
try { out.envTransport = $.getenv("AE_MCP_BRIDGE_TRANSPORT"); } catch (e2) {}
try { out.envBridgeDir = $.getenv("AE_MCP_BRIDGE_DIR"); } catch (e3) {}
try {
  app.settings.saveSetting("MCPBridge", "port", "47899");
  out.haveSetting = app.settings.haveSetting("MCPBridge", "port");
  out.readBack = app.settings.getSetting("MCPBridge", "port");
  out.roundTrips = (out.readBack === "47899");
} catch (e4) {
  out.settingsError = e4.toString();
}
return out;
`,
);
assert(
  s10?.roundTrips === true,
  `S10: app.settings round-trips the port (read back ${JSON.stringify(s10?.readBack)}) - the in-panel Port field can persist`,
);
note(
  `env AE_MCP_BRIDGE_PORT=${JSON.stringify(s10?.envPort)}, AE_MCP_BRIDGE_DIR=${JSON.stringify(s10?.envBridgeDir)}`,
);

// =====================================================================
// S12 - listen(0): is an ephemeral port bindable, and is it readable back?
// =====================================================================
const s12 = await probe(
  "S12",
  `
var out = {};
var s = new Socket();
s.encoding = "UTF-8";
try {
  out.listenZeroReturned = s.listen(0);
  out.threw = false;
} catch (e) {
  out.threw = true;
  out.error = e.toString();
}
// The decisive question: even if it bound, can AE discover WHICH port it got?
out.hasLocalPort = ("localPort" in s);
try { out.localPort = s.localPort; } catch (e2) { out.localPortError = e2.toString(); }
try { out.host = s.host; } catch (e3) {}
var props = [];
for (var k in s) { props.push(k); }
out.members = props;
try { s.close(); } catch (e4) {}
out.conclusion = (out.listenZeroReturned && (out.localPort != null))
  ? "EPHEMERAL PORTS ARE VIABLE - revisit the plan's deterministic-base-plus-scan decision"
  : "ephemeral ports are NOT viable (no readable bound port) - deterministic base plus scan is correct";
return out;
`,
);
note(`S12: ${s12?.conclusion}`);
assert(
  s12?.localPort == null,
  `S12: no readable bound port (localPort=${JSON.stringify(s12?.localPort)}) - confirms the plan's port-scan design`,
);

// =====================================================================
// S11 - HARD GATE: does the listener survive a long BLOCKING operation, and
//       is a connection made DURING the block still waiting in the backlog?
// =====================================================================
const s11 = await probeWithConnection(
  "S11",
  `
var out = {};
var s = $.global.__probeListener;
if (!s) { return { error: "no listener from S2" }; }
// Drain anything already pending so the test is unambiguous.
var drained = 0;
var stale = s.poll();
while (stale) { drained++; try { stale.close(); } catch (e) {} stale = s.poll(); }
out.drainedBefore = drained;

// Block HARD for 6 seconds with zero yielding. This is a strictly harsher test
// than rq.render(), which may pump internally; $.sleep provably does not.
var t0 = (new Date()).getTime();
$.sleep(6000);
out.blockedMs = (new Date()).getTime() - t0;

// The connection Node made ~1.2s into that block should be sitting in the OS
// accept backlog. If poll() returns null here, the whole blocking-render design
// in the plan is wrong and the transport needs a different answer for renders.
var conn = s.poll();
out.connectionSurvivedBlock = !!conn;
if (conn) {
  conn.encoding = "UTF-8";
  conn.timeout = 30;
  out.line = conn.readln();
  try { conn.write("SURVIVED\\n"); } catch (e2) { out.writeError = e2.toString(); }
  try { conn.close(); } catch (e3) {}
}
out.listenerStillUsable = false;
try { var after = s.poll(); out.listenerStillUsable = true; if (after) { after.close(); } } catch (e4) { out.postError = e4.toString(); }
return out;
`,
  () => tcpExchange(PORT, "DURING_BLOCK\n", { readMs: 15000, expectBytes: 9 }),
);
assert(
  s11.ae?.connectionSurvivedBlock === true,
  `S11 GATE: a connection made during a ${s11.ae?.blockedMs}ms hard block was still in the backlog afterwards`,
);
assert(
  s11.ae?.line?.indexOf("DURING_BLOCK") === 0,
  `S11: the buffered command line was intact after the block (got ${JSON.stringify(s11.ae?.line)})`,
);
assert(s11.ae?.listenerStillUsable === true, "S11: the listener is still usable after the block");
if (s11.ae?.connectionSurvivedBlock !== true) {
  console.log(
    "!!! S11: connections do NOT survive a blocking command. Renders would drop every request.",
  );
  console.log("!!! Revisit section 'Blocking commands' in the plan before writing C4.");
}

// =====================================================================
// Cleanup - never leave a port bound behind.
// =====================================================================
const cleanup = await probe(
  "cleanup",
  `
var out = { closed: [] };
try {
  if ($.global.__probeListener) {
    $.global.__probeListener.close();
    out.closed.push("listener");
  }
} catch (e) { out.closeError = e.toString(); }
$.global.__probeListener = null;
try { app.settings.saveSetting("MCPBridge", "port", ""); out.settingCleared = true; } catch (e2) {}
// Confirm the port is actually free again.
var s = new Socket();
try {
  out.rebindSucceeded = s.listen(${PORT});
  s.close();
} catch (e3) { out.rebindError = e3.toString(); }
return out;
`,
);
assert(
  cleanup?.rebindSucceeded === true,
  `S-cleanup: port ${PORT} was released and can be rebound (no zombie socket left behind)`,
);

// =====================================================================
console.log("\n\n================ PROBE FINDINGS (JSON) ================");
console.log(JSON.stringify(findings, null, 2));

console.log("\n================ GATE SUMMARY ================");
console.log(
  `S3  bind interface : ${s3?.bindsWildcard ? "WILDCARD - token MANDATORY, update SECURITY.md" : s3?.bindsLoopback ? "loopback only" : "INCONCLUSIVE"}`,
);
console.log(
  `S5  poll() non-blocking : ${s5?.allNull === true && s5?.elapsedMsFor20Polls < 200 ? "YES" : "NO - 50ms tick is unsafe"}`,
);
console.log(
  `S11 survives blocking   : ${s11.ae?.connectionSurvivedBlock === true ? "YES" : "NO - blocking-render design is wrong"}`,
);
console.log(
  `S4  peer address usable : ${s46.ae?.peerHost ? `YES ("${s46.ae.peerHost}")` : "no - rely on token"}`,
);
console.log(
  `S6  readln() 256KB      : ${s46.ae?.truncated === false ? "full line" : "TRUNCATES - chunked read needed"}`,
);
console.log(
  `S7  4MB single write    : ${got === FOUR_MB + 1 ? "complete" : `capped at ${got} - chunked write REQUIRED`}`,
);
console.log(`S8  permission form     : ${permForm ?? "none worked"}`);
console.log(
  `S12 ephemeral ports     : ${s12?.localPort == null ? "not viable (expected)" : "VIABLE - revisit plan"}`,
);

console.log(`\n=== DONE: ${failures === 0 ? "ALL ASSERTIONS PASSED" : failures + " FAILED"} ===`);
console.log("Record these findings in CONTEXT.md before writing any shipped code (commit C0).");
await client.close();
process.exit(failures === 0 ? 0 : 1);
