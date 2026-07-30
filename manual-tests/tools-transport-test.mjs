/*
 * Live verification for C7: are get-results, run-bridge-test and check-bridge
 * actually transport aware?
 *
 * transport-select-test.mjs proves sendBridgeCommand picks the right transport.
 * This proves the three tools that do NOT go through the ordinary path agree
 * with it: get-results has to read the socket's in-band result (there is no
 * result file on the socket at all), run-bridge-test has to return its result
 * instead of queueing it, and check-bridge has to name the exact reason the
 * socket is unusable rather than collapsing four causes into one timeout.
 *
 * WARNING: run-bridge-test APPLIES REAL EFFECTS to the open project. Per
 * AGENTS.md, save and close the real project first and run this against a
 * disposable scratch project.
 *
 * Run with After Effects open and the MCP Bridge Auto panel listening:
 *   node manual-tests/tools-transport-test.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CWD = "C:\\Users\\renat\\after-effects-mcp-a-y-ibrahim";
let failures = 0;

function assert(cond, msg) {
  if (!cond) {
    console.log(`!!! FAILED: ${msg}`);
    failures++;
  } else {
    console.log(`OK: ${msg}`);
  }
}

async function withServer(env, fn) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["build/index.js"],
    cwd: CWD,
    env: { ...process.env, ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "tools-transport-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

async function callTool(client, name, args = {}) {
  const started = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { text, parsed, ms: Date.now() - started, isError: res.isError === true };
}

// --- 1: check-bridge against a live listening panel -------------------------
console.log("\n=== 1: check-bridge, panel listening ===");
await withServer({}, async (client) => {
  const r = await callTool(client, "check-bridge");
  console.log(`  ${r.ms}ms  ${r.text}`);
  assert(r.parsed?.ok === true, "the panel answered");
  assert(r.parsed?.versionMatch === true, "bridge version matches the server");
  assert(r.parsed?.socket?.problem === null, `socketProblem is null (got ${r.parsed?.socket?.problem})`);
  assert(r.parsed?.socket?.hint === null, "a healthy socket carries no hint");
  // The consistency rule: problem:null must mean commands REALLY use the socket.
  assert(r.parsed?.transportInUse === "socket", `the health check itself used the socket (got ${r.parsed?.transportInUse})`);
  assert(
    r.parsed?.socket?.selectedPort === r.parsed?.socket?.panelReported?.port,
    "the port we selected is the port the panel says it bound",
  );
  assert(r.parsed?.socket?.panelReported?.networkPermission === true, "the panel reports the network permission is on");
  assert(Array.isArray(r.parsed?.socket?.allListeners) && r.parsed.socket.allListeners.length >= 1, "at least one listener is reported");
  const sel = (r.parsed?.socket?.allListeners ?? []).find((l) => l.selected);
  assert(!!sel && sel.reachable === true, "the selected listener was probed and answered");
  assert(!!sel && typeof sel.aeVersion === "string" && sel.aeVersion.length > 0, `the listener reports its AE version (${sel?.aeVersion})`);
  console.log(`  panel: ${sel?.aeVersion}  project=${sel?.project}  port=${sel?.port}`);
});

// --- 2: get-results reads the socket's in-band result -----------------------
console.log("\n=== 2: get-results after a socket command ===");
await withServer({}, async (client) => {
  const info = await callTool(client, "run-script", { script: "getProjectInfo" });
  assert(info.parsed?._transport === "socket", `the setup command used the socket (got ${info.parsed?._transport})`);

  const r = await callTool(client, "get-results");
  console.log(`  ${r.ms}ms  _source=${r.parsed?._source} _transport=${r.parsed?._transport} _ageMs=${r.parsed?._ageMs}`);
  assert(r.parsed?._source === "server-memory", "get-results served the cached result, not the result file");
  assert(r.parsed?._transport === "socket", "and it knows the result came over the socket");
  assert(typeof r.parsed?._ageMs === "number" && r.parsed._ageMs < 30000, "the cached result is reported as fresh");
  assert(
    r.parsed?._commandExecuted === "getProjectInfo",
    `it is the result of the command we just ran (got ${r.parsed?._commandExecuted})`,
  );
});

// --- 3: run-bridge-test returns its result --------------------------------
console.log("\n=== 3: run-bridge-test (APPLIES EFFECTS: scratch project only) ===");
await withServer({}, async (client) => {
  const r = await callTool(client, "run-bridge-test");
  console.log(`  ${r.ms}ms  -> ${r.text.slice(0, 200)}`);
  assert(!/has been queued/.test(r.text), "it no longer just queues the command");
  assert(r.parsed?._commandExecuted === "bridgeTestEffects", "the result is the bridge test's own");
  assert(r.parsed?._transport === "socket", "and it went over the socket");
});

// --- 4: the kill switch is reported as a cause, not as a broken bridge ------
console.log("\n=== 4: check-bridge with AE_MCP_BRIDGE_TRANSPORT=file ===");
await withServer({ AE_MCP_BRIDGE_TRANSPORT: "file" }, async (client) => {
  const r = await callTool(client, "check-bridge");
  console.log(`  ${r.ms}ms  problem=${r.parsed?.socket?.problem}`);
  assert(r.parsed?.ok === true, "the bridge is still healthy over files");
  assert(r.parsed?.socket?.problem === "transport-disabled", `problem is transport-disabled (got ${r.parsed?.socket?.problem})`);
  assert(r.parsed?.transportInUse === "file", "and the health check really used the file transport");
  // The listener is still listed, just not contacted: the user needs to see it
  // is there so "transport-disabled" reads as a choice, not as a fault.
  const l = (r.parsed?.socket?.allListeners ?? [])[0];
  assert(!!l && l.reachable === null, "the live listener is listed but was not probed");
});

// --- 5: a pin nobody is listening on --------------------------------------
console.log("\n=== 5: check-bridge with AE_MCP_BRIDGE_PORT pinned to a dead port ===");
await withServer({ AE_MCP_BRIDGE_PORT: "47899" }, async (client) => {
  const r = await callTool(client, "check-bridge");
  console.log(`  ${r.ms}ms  problem=${r.parsed?.socket?.problem}`);
  assert(
    r.parsed?.socket?.problem === "pinned-port-not-found",
    `problem is pinned-port-not-found (got ${r.parsed?.socket?.problem})`,
  );
  assert(r.parsed?.socket?.selectedPort === null, "nothing was selected");
  assert(/47899/.test(r.parsed?.socket?.hint ?? ""), "the hint names the pinned port");
  assert(r.parsed?.ok === true, "commands still work: it fell back to the file transport");
});

// --- 6: no panel at all, via an empty bridge folder ------------------------
console.log("\n=== 6: check-bridge with an empty bridge folder ===");
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-bridge-none-"));
await withServer({ AE_MCP_BRIDGE_DIR: emptyDir }, async (client) => {
  const r = await callTool(client, "check-bridge");
  console.log(`  ${r.ms}ms  ok=${r.parsed?.ok} problem=${r.parsed?.socket?.problem}`);
  assert(r.parsed?.ok === false, "no panel is watching that folder, so ok is false");
  assert(r.parsed?.socket?.problem === "no-rendezvous", `problem is no-rendezvous (got ${r.parsed?.socket?.problem})`);
  assert(r.parsed?.socket?.allListeners?.length === 0, "no listeners are reported");
  assert(typeof r.parsed?.socket?.hint === "string", "the failure branch still carries the socket hint");
});
try {
  fs.rmSync(emptyDir, { recursive: true, force: true });
} catch {}

console.log(`\n=== DONE: ${failures === 0 ? "ALL PASSED" : failures + " FAILED"} ===`);
process.exit(failures === 0 ? 0 : 1);
