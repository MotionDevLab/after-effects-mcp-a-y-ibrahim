// End to end tests for the bridge, driving the REAL built server (build/index.js)
// over MCP stdio JSON-RPC while a fake After Effects reads and writes the shared
// bridge folder. Everything between the MCP tool call and the AE panel is
// therefore exercised for real: the mutex, command-id correlation, the result
// poll loop, timeout synthesis and isError classification.
//
// This replaces tests/bridge-roundtrip-test.cjs and tests/verify-fixes.cjs, which
// contained the same fake-AE logic but were standalone scripts nobody ran. They
// are now CI enforced, which matters because the socket transport is about to be
// layered underneath all of this and the file path must not regress.
//
// The bridge folder is a private mkdtemp dir passed via AE_MCP_BRIDGE_DIR, so a
// real AE panel running on the same machine cannot interfere with the run.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(repoRoot, "build", "index.js");

/**
 * Read the version the SERVER expects straight out of the built bundle, so this
 * test can never drift from EXPECTED_BRIDGE_VERSION. Keeping a literal here is
 * exactly how the old .cjs harness ended up asserting 1.5.0 against a 1.11.0
 * server.
 */
function readExpectedVersionFromServer(): string {
  const src = fs.readFileSync(serverPath, "utf8");
  const m = src.match(/EXPECTED_BRIDGE_VERSION\s*=\s*["']([^"']+)["']/);
  if (!m) throw new Error(`Could not find EXPECTED_BRIDGE_VERSION in ${serverPath}`);
  return m[1];
}

interface ToolCallResult {
  isError: boolean;
  text: string;
  parsed: any;
}

/** Minimal MCP stdio JSON-RPC client, enough to initialize and call tools. */
function makeClient(child: ChildProcessWithoutNullStreams) {
  let buf = "";
  const waiters = new Map<number, (msg: any) => void>();

  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && waiters.has(msg.id)) {
        waiters.get(msg.id)!(msg);
        waiters.delete(msg.id);
      }
    }
  });

  let id = 0;
  function send(method: string, params?: unknown, notify = false): Promise<any> {
    const msg: any = { jsonrpc: "2.0", method };
    if (params !== undefined) msg.params = params;
    if (!notify) msg.id = ++id;
    child.stdin.write(JSON.stringify(msg) + "\n");
    if (notify) return Promise.resolve(undefined);
    const myId = id;
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        waiters.delete(myId);
        reject(new Error(`RPC timeout: ${method}`));
      }, 30000);
      waiters.set(myId, (r) => {
        clearTimeout(to);
        resolve(r);
      });
    });
  }

  async function callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const r = await send("tools/call", { name, arguments: args });
    const text = r.result?.content?.[0]?.text ?? "";
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* opaque text */
    }
    return { isError: r.result?.isError === true, text, parsed };
  }

  return { send, callTool };
}

/**
 * Fake After Effects panel over the file transport. Polls ae_command.json and
 * writes ae_mcp_result.json, mirroring what mcp-bridge-auto.jsx does, including
 * the tracking fields the id-matcher depends on.
 */
class FakeAE {
  enabled = true;
  /** Set false to simulate an OLD panel build that does not echo _commandId. */
  echoTracking = true;
  responder: (cmd: any) => Record<string, unknown> = () => ({ status: "success" });
  seen: any[] = [];

  private answered = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly dir: string) {}

  start(): void {
    this.timer = setInterval(() => {
      if (!this.enabled) return;
      try {
        const cmdFile = path.join(this.dir, "ae_command.json");
        if (!fs.existsSync(cmdFile)) return;
        const raw = fs.readFileSync(cmdFile, "utf8");
        if (!raw) return;
        const cmd = JSON.parse(raw);
        if (!cmd.commandId || this.answered.has(cmd.commandId)) return;
        this.answered.add(cmd.commandId);
        this.seen.push(cmd);

        const body: any = this.responder(cmd) || {};
        if (this.echoTracking) {
          body._responseTimestamp = new Date().toISOString();
          body._commandExecuted = cmd.command;
          body._commandId = cmd.commandId;
        }
        fs.writeFileSync(path.join(this.dir, "ae_mcp_result.json"), JSON.stringify(body, null, 2), {
          encoding: "utf8",
        });
      } catch {
        /* mid-write race: retry next tick, exactly like the real panel */
      }
    }, 25);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** A well formed ping reply from a panel claiming `version`. */
  pingAs(version: string): void {
    this.responder = () => ({
      status: "success",
      pong: true,
      bridgeVersion: version,
      aeVersion: "26.0x67 (SIMULATED)",
      bridgeFolder: this.dir,
      project: "SIMULATED Project.aep",
      activeComp: "SIM Comp 1",
    });
  }
}

let dir: string;
let child: ChildProcessWithoutNullStreams;
let client: ReturnType<typeof makeClient>;
let ae: FakeAE;
let EXPECTED_VERSION: string;

beforeAll(async () => {
  if (!fs.existsSync(serverPath)) {
    throw new Error(`Missing ${serverPath}. Run "npm run build" before "npm test".`);
  }
  EXPECTED_VERSION = readExpectedVersionFromServer();

  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-mcp-e2e-"));
  child = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AE_MCP_BRIDGE_DIR: dir },
  }) as ChildProcessWithoutNullStreams;
  child.stderr.on("data", () => {
    /* the server logs progress to stderr; keep test output readable */
  });

  client = makeClient(child);
  ae = new FakeAE(dir);
  ae.start();

  await client.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "bridge-e2e", version: "1.0.0" },
  });
  await client.send("notifications/initialized", {}, true);
}, 30000);

afterAll(() => {
  ae?.stop();
  try {
    child?.kill();
  } catch {
    /* already gone */
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("server startup", () => {
  it("registers its tools, including check-bridge", async () => {
    const r = await client.send("tools/list", {});
    const names: string[] = (r.result?.tools ?? []).map((t: any) => t.name);
    expect(names.length).toBeGreaterThan(50);
    expect(names).toContain("check-bridge");
    expect(names).toContain("execute-script");
  });
});

describe("check-bridge", () => {
  it("reports a clear failure when no panel answers", async () => {
    ae.enabled = false;
    try {
      const r = await client.callTool("check-bridge", {});
      expect(r.parsed.ok).toBe(false);
      expect(r.parsed.problem).toMatch(/No response/i);
      expect(r.parsed.stalePanelDetected).toBe(false);
      // The expected version is surfaced so a user can compare it by eye.
      expect(r.parsed.expectedBridgeVersion).toBe(EXPECTED_VERSION);
    } finally {
      ae.enabled = true;
    }
  }, 20000);

  it("still writes the command file, so the panel can pick it up late", async () => {
    const cmd = JSON.parse(fs.readFileSync(path.join(dir, "ae_command.json"), "utf8"));
    expect(cmd.command).toBe("ping");
    expect(cmd.status).toBe("pending");
    expect(typeof cmd.commandId).toBe("string");
    expect(cmd.commandId.length).toBeGreaterThan(0);
  });

  it("reports ok with a matching panel version", async () => {
    ae.pingAs(EXPECTED_VERSION);
    const r = await client.callTool("check-bridge", {});
    expect(r.parsed.ok).toBe(true);
    expect(r.parsed.bridgeResponding).toBe(true);
    expect(r.parsed.versionMatch).toBe(true);
    expect(r.parsed.versionWarning).toBeNull();
    expect(r.parsed.aeVersion).toMatch(/SIMULATED/);
    expect(r.parsed.project).toMatch(/SIMULATED/);
  }, 20000);

  it("warns, but still reports ok, when the panel is an older version", async () => {
    ae.pingAs("1.1.0-mcp-enhanced");
    const r = await client.callTool("check-bridge", {});
    expect(r.parsed.ok).toBe(true);
    expect(r.parsed.versionMatch).toBe(false);
    expect(r.parsed.versionWarning).toBeTruthy();
    expect(r.parsed.versionWarning).toMatch(/install-bridge/);
    expect(r.parsed.bridgeVersion).toBe("1.1.0-mcp-enhanced");
  }, 20000);

  it("detects a STALE panel that answers ping but never echoes _commandId", async () => {
    // The trap this probe exists for: such a panel often reports the CORRECT
    // version string, yet every tool times out because no result can be matched.
    ae.echoTracking = false;
    ae.pingAs(EXPECTED_VERSION);
    try {
      const r = await client.callTool("check-bridge", {});
      expect(r.parsed.ok).toBe(false);
      expect(r.parsed.stalePanelDetected).toBe(true);
      expect(r.parsed.panelReportedVersion).toBe(EXPECTED_VERSION);
      expect(r.parsed.problem).toMatch(/Stale bridge panel/i);
    } finally {
      ae.echoTracking = true;
    }
  }, 20000);
});

describe("command round trip", () => {
  it("delivers the command and its args to the panel unchanged", async () => {
    ae.responder = (cmd) => ({ status: "success", echo: cmd.args });
    const r = await client.callTool("execute-script", {
      script: "app.project.numItems",
      timeoutMs: 8000,
    });
    expect(r.parsed.echo.script).toBe("app.project.numItems");
  }, 20000);

  it("surfaces an AE-side error as isError instead of timing out", async () => {
    ae.responder = () => ({ status: "error", message: "AE_BOOM", line: 42 });
    const r = await client.callTool("execute-script", {
      script: 'throw new Error("x")',
      timeoutMs: 8000,
    });
    expect(r.text).not.toMatch(/Timed out/);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/AE_BOOM/);
  }, 20000);

  it("synthesizes a timeout result rather than hanging or throwing", async () => {
    ae.enabled = false;
    try {
      const r = await client.callTool("execute-script", { script: "1+1", timeoutMs: 1500 });
      expect(r.parsed.error).toMatch(/Timed out waiting for bridge result/);
    } finally {
      ae.enabled = true;
    }
  }, 20000);

  it("round trips Arabic text through the bridge folder byte for byte", async () => {
    const arabic = "مرحبا بالعالم، هذه طبقة نص عربية";
    ae.responder = (cmd) => ({ status: "success", text: cmd.args.script });
    const r = await client.callTool("execute-script", { script: arabic, timeoutMs: 8000 });
    expect(r.parsed.text).toBe(arabic);
    expect(r.parsed.text).not.toContain("�");
  }, 20000);
});

describe("concurrency", () => {
  it("gives two concurrent calls their OWN results, with no clobbering", async () => {
    // There is exactly one command file and one result file, so without the
    // mutex plus id-matching these two would overwrite each other.
    ae.responder = (cmd) => ({ status: "success", echo: cmd.args.script });
    const [a, b] = await Promise.all([
      client.callTool("execute-script", { script: "MARKER_ONE", timeoutMs: 10000 }),
      client.callTool("execute-script", { script: "MARKER_TWO", timeoutMs: 10000 }),
    ]);
    expect(a.text).not.toMatch(/Timed out/);
    expect(b.text).not.toMatch(/Timed out/);
    const echoes = [a.parsed.echo, b.parsed.echo].sort();
    expect(echoes).toEqual(["MARKER_ONE", "MARKER_TWO"]);
  }, 30000);

  it("never reuses a command id across calls", async () => {
    const ids = ae.seen.map((c) => c.commandId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
