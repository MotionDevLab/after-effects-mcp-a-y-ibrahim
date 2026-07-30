/*
 * Live verification for C5: does src/index.ts actually prefer the socket, and
 * does it fall back to files correctly?
 *
 * Unlike socket-smoke-test.mjs (which bypasses the server to test the panel),
 * this drives the real MCP server over stdio, so it exercises sendBridgeCommand
 * and the transport-selection logic end to end.
 *
 * Run with After Effects open, the MCP Bridge Auto panel running, and a
 * disposable scratch project:
 *   node manual-tests/transport-select-test.mjs
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
  const client = new Client({ name: "transport-test", version: "1.0.0" });
  await client.connect(transport);
  const logs = [];
  transport.stderr?.on("data", (d) => logs.push(String(d)));
  try {
    return await fn(client, logs);
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
  return { text, parsed, ms: Date.now() - started };
}

// --- 1: default (auto) should pick the socket ------------------------------
console.log("\n=== 1: default mode, panel listening ===");
await withServer({}, async (client) => {
  const r = await callTool(client, "find-missing-footage");
  console.log(`  ${r.ms}ms  _transport=${r.parsed?._transport}`);
  assert(
    r.parsed?._transport === "socket",
    `auto mode used the socket (got ${r.parsed?._transport})`,
  );
  assert(r.parsed?.status !== "error", "the command actually succeeded");

  // Latency: several calls in a row, to see the poll floor disappear.
  const times = [];
  for (let i = 0; i < 5; i++) {
    const t = await callTool(client, "find-missing-footage");
    times.push(t.ms);
  }
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  console.log(`  socket latency over 5 calls: ${times.join(", ")}ms (avg ${avg}ms)`);
  assert(avg < 250, `socket avg latency ${avg}ms is below the old 250ms poll floor`);
});

// --- 2: AE_MCP_BRIDGE_TRANSPORT=file forces the file path ------------------
console.log("\n=== 2: AE_MCP_BRIDGE_TRANSPORT=file (kill switch) ===");
await withServer({ AE_MCP_BRIDGE_TRANSPORT: "file" }, async (client) => {
  const r = await callTool(client, "find-missing-footage");
  console.log(`  ${r.ms}ms  _transport=${r.parsed?._transport}`);
  assert(
    r.parsed?._transport === "file",
    `file mode used the file transport (got ${r.parsed?._transport})`,
  );
  assert(r.parsed?.status !== "error", "the file transport still works");
});

// --- 3: no listener + auto => falls back to files (does NOT hard error) ----
console.log("\n=== 3: no rendezvous, auto mode must fall back ===");
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-bridge-none-"));
await withServer({ AE_MCP_BRIDGE_DIR: emptyDir }, async (client) => {
  const r = await callTool(client, "find-missing-footage");
  console.log(`  ${r.ms}ms  -> ${r.text.slice(0, 120)}`);
  // AE is not watching this folder, so the file transport times out. The POINT
  // is that we get the file transport's timeout envelope, not a socket error:
  // that proves the absent listener caused a fallback rather than a failure.
  assert(
    /Timed out waiting for bridge result/.test(r.text),
    "absent listener fell back to files (got the file-transport timeout envelope)",
  );
  assert(
    !/socket/i.test(r.text),
    "no socket error leaked to the caller when simply no listener was published",
  );
});

// --- 4: socket-only mode with no listener must NOT fall back ---------------
console.log("\n=== 4: AE_MCP_BRIDGE_TRANSPORT=socket, no rendezvous ===");
await withServer(
  { AE_MCP_BRIDGE_DIR: emptyDir, AE_MCP_BRIDGE_TRANSPORT: "socket" },
  async (client) => {
    const r = await callTool(client, "find-missing-footage");
    console.log(`  ${r.ms}ms  -> ${r.text.slice(0, 160)}`);
    assert(
      /forbids the file fallback/.test(r.text),
      "socket-only mode refused to fall back and said why",
    );
    assert(r.ms < 3000, `socket-only failure was fast (${r.ms}ms), not a full timeout`);
  },
);

try {
  fs.rmSync(emptyDir, { recursive: true, force: true });
} catch {}

console.log(`\n=== DONE: ${failures === 0 ? "ALL PASSED" : failures + " FAILED"} ===`);
process.exit(failures === 0 ? 0 : 1);
