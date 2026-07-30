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
import * as net from "net";
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
          // The real panel stamps the transport in the same block as _commandId,
          // so an old panel that omits one omits the other.
          body._transport = "file";
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

  /**
   * A well formed ping reply from a panel claiming `version`. `extra` carries
   * the socket fields a bridge >= 1.12 reports about itself; omitting them
   * simulates an older panel, which must leave check-bridge's panelReported null
   * rather than letting it invent a state.
   */
  pingAs(version: string, extra: Record<string, unknown> = {}): void {
    this.responder = () => ({
      status: "success",
      pong: true,
      bridgeVersion: version,
      aeVersion: "26.0x67 (SIMULATED)",
      bridgeFolder: this.dir,
      project: "SIMULATED Project.aep",
      activeComp: "SIM Comp 1",
      ...extra,
    });
  }
}

/**
 * Fake After Effects panel over the SOCKET transport: a real TCP server plus the
 * rendezvous file that advertises it, speaking the same NDJSON protocol as
 * mcp-bridge-auto.jsx (ACK first, then the result, then close).
 *
 * It binds port 0 and publishes whatever the OS hands out, so a run never
 * collides with a real After Effects panel holding 47800-47815 on the same
 * machine. That is also why the port is read back from the listener rather than
 * assumed: the rendezvous file has to name the port actually bound, which is the
 * whole reason the file exists.
 */
class FakeSocketAE {
  port = 0;
  token = "0123456789abcdef0123456789abcdef";
  bridgeVersion = "";
  protocolVersion = 1;
  responder: (cmd: any) => Record<string, unknown> = () => ({ status: "success" });
  seen: any[] = [];

  private server: net.Server | null = null;

  constructor(private readonly dir: string) {}

  start(): Promise<void> {
    return new Promise((resolve) => {
      const srv = net.createServer((conn) => {
        conn.setEncoding("utf8");
        let buf = "";
        conn.on("error", () => {
          /* the client destroys the socket once it has its result */
        });
        conn.on("data", (d: string) => {
          buf += d;
          const nl = buf.indexOf("\n");
          if (nl < 0) return;
          const line = buf.slice(0, nl);
          buf = "";

          let cmd: any;
          try {
            cmd = JSON.parse(line);
          } catch {
            conn.end();
            return;
          }
          // Refuse BEFORE acknowledging, exactly like the panel, because that
          // ordering is what makes the server's file fallback safe here.
          if (cmd.token !== this.token) {
            conn.write(
              JSON.stringify({ _ack: 0, error: "unauthorized", commandId: cmd.commandId }) + "\n",
            );
            conn.end();
            return;
          }
          this.seen.push(cmd);
          conn.write(
            JSON.stringify({
              _ack: 1,
              commandId: cmd.commandId,
              bridgeVersion: this.bridgeVersion,
            }) + "\n",
          );

          const body: any = this.responder(cmd) || {};
          body._responseTimestamp = new Date().toISOString();
          body._commandExecuted = cmd.command;
          body._commandId = cmd.commandId;
          body._transport = "socket";
          conn.write(JSON.stringify(body) + "\n");
          conn.end();
        });
      });
      srv.listen(0, "127.0.0.1", () => {
        this.port = (srv.address() as net.AddressInfo).port;
        this.server = srv;
        this.writeRendezvous();
        resolve();
      });
    });
  }

  get rendezvousPath(): string {
    return path.join(this.dir, `ae_bridge_port_${this.port}.json`);
  }

  /** Publish the rendezvous file, optionally with a token that does not match. */
  writeRendezvous(token: string = this.token): void {
    fs.writeFileSync(
      this.rendezvousPath,
      JSON.stringify({
        v: this.protocolVersion,
        port: this.port,
        token,
        bridgeVersion: this.bridgeVersion,
        aeVersion: "26.0x67 (SOCKET SIM)",
        boundAt: new Date().toISOString(),
        project: "SOCKET Project.aep",
      }),
    );
  }

  removeRendezvous(): void {
    try {
      fs.unlinkSync(this.rendezvousPath);
    } catch {
      /* already gone */
    }
  }

  /** Close the listener but LEAVE the rendezvous file: a panel the user closed. */
  closeListener(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  async stop(): Promise<void> {
    await this.closeListener();
    this.removeRendezvous();
  }

  pingAs(version: string, extra: Record<string, unknown> = {}): void {
    this.responder = () => ({
      status: "success",
      pong: true,
      bridgeVersion: version,
      aeVersion: "26.0x67 (SOCKET SIM)",
      bridgeFolder: this.dir,
      // Deliberately NOT the project name in the rendezvous file: the panel has
      // "opened a different project" since it bound, and check-bridge must
      // report the live one.
      project: "REOPENED Project.aep",
      activeComp: "SOCKET Comp 1",
      socketListening: true,
      socketPort: this.port,
      socketStatus: "listening",
      networkPermission: true,
      fileTransportEnabled: true,
      ...extra,
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

// MUST stay ahead of every describe that runs a command: the moment one
// succeeds the server has a cached result, and this file-reading path becomes
// unreachable for the rest of the process.
describe("get-results with nothing cached yet", () => {
  it("falls back to the result file when the server has run no command", async () => {
    const r = await client.callTool("get-results", {});
    expect(r.parsed.error).toMatch(/No results file found/i);
    expect(r.parsed._source).toBeUndefined();
  }, 20000);
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
    // A panel answering over files with no rendezvous file published: the
    // socket is unusable, but everything works, so `ok` stays true.
    expect(r.parsed.socket.problem).toBe("no-rendezvous");
    expect(r.parsed.socket.selectedPort).toBeNull();
    expect(r.parsed.socket.allListeners).toEqual([]);
    expect(r.parsed.socket.hint).toMatch(/mcp-bridge-auto/);
  }, 20000);

  it("leaves panelReported null for a panel too old to report its socket", async () => {
    // The old panel says nothing about sockets, so check-bridge must not invent
    // a state for it, and must not read a missing networkPermission as "off".
    ae.pingAs("1.11.0-mcp-enhanced");
    const r = await client.callTool("check-bridge", {});
    expect(r.parsed.socket.panelReported).toBeNull();
    expect(r.parsed.socket.problem).toBe("no-rendezvous");
  }, 20000);

  it("names the network permission as the cause when the panel reports it off", async () => {
    // Without the panel saying so this is indistinguishable from "no panel
    // open", "Socket checkbox unchecked" and "every port taken", which is the
    // whole reason ping reports it.
    ae.pingAs(EXPECTED_VERSION, {
      socketListening: false,
      socketPort: 0,
      socketStatus: "permission disabled",
      networkPermission: false,
      fileTransportEnabled: true,
    });
    const r = await client.callTool("check-bridge", {});
    expect(r.parsed.ok).toBe(true);
    expect(r.parsed.socket.problem).toBe("permission-disabled");
    expect(r.parsed.socket.hint).toMatch(/Allow Scripts to Write Files and Access Network/);
    expect(r.parsed.socket.panelReported.listening).toBe(false);
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

// Everything below publishes a real listener into the same bridge folder, so it
// runs last: once a rendezvous file exists the server prefers the socket, and
// the file-transport describes above would no longer be testing the file path.
describe("socket transport", () => {
  let sock: FakeSocketAE;

  beforeAll(async () => {
    sock = new FakeSocketAE(dir);
    sock.bridgeVersion = EXPECTED_VERSION;
    sock.pingAs(EXPECTED_VERSION);
    await sock.start();
    // The FILE panel has to answer ping too: several tests below break the
    // socket on purpose and then assert that the fallback still works.
    ae.pingAs(EXPECTED_VERSION);
  });

  afterAll(async () => {
    await sock?.stop();
  });

  it("reports a healthy socket, and says so only when commands really use it", async () => {
    const r = await client.callTool("check-bridge", {});
    expect(r.parsed.ok).toBe(true);
    expect(r.parsed.socket.problem).toBeNull();
    expect(r.parsed.socket.hint).toBeNull();
    expect(r.parsed.socket.selectedPort).toBe(sock.port);
    // problem:null must mean the tools ACTUALLY use the socket, not merely that
    // a listener answered a probe. The panel stamps this field itself.
    expect(r.parsed.transportInUse).toBe("socket");
    expect(r.parsed.socket.mode).toBe("auto");

    expect(r.parsed.socket.allListeners).toHaveLength(1);
    const only = r.parsed.socket.allListeners[0];
    expect(only.port).toBe(sock.port);
    expect(only.selected).toBe(true);
    expect(only.reachable).toBe(true);
    expect(only.problem).toBeNull();
    expect(only.aeVersion).toMatch(/SOCKET SIM/);
    // The live ping wins over the rendezvous file's bind-time snapshot, which
    // still says "SOCKET Project.aep".
    expect(only.project).toBe("REOPENED Project.aep");
  }, 20000);

  it("routes commands over the socket, never touching the command file", async () => {
    const before = ae.seen.length;
    sock.responder = (cmd) => ({ status: "success", echo: cmd.args.script });
    const r = await client.callTool("execute-script", {
      script: "SOCKET_MARKER",
      timeoutMs: 8000,
    });
    expect(r.parsed.echo).toBe("SOCKET_MARKER");
    expect(r.parsed._transport).toBe("socket");
    // The file panel must not have seen it: a command served on both transports
    // would be executed twice.
    expect(ae.seen.length).toBe(before);
  }, 20000);

  it("get-results returns the socket result, which was never written to a file", async () => {
    // The decisive case for C7: on the socket there IS no result file, so the
    // old implementation would have returned a stale file-transport result here.
    const r = await client.callTool("get-results", {});
    expect(r.parsed.echo).toBe("SOCKET_MARKER");
    expect(r.parsed._source).toBe("server-memory");
    expect(r.parsed._transport).toBe("socket");
    expect(typeof r.parsed._ageMs).toBe("number");
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "ae_mcp_result.json"), "utf8"));
    expect(onDisk.echo).not.toBe("SOCKET_MARKER");
  }, 20000);

  it("run-bridge-test returns its result instead of telling the caller to poll", async () => {
    sock.responder = () => ({ status: "success", effectsApplied: 3 });
    const r = await client.callTool("run-bridge-test", {});
    expect(r.isError).toBe(false);
    expect(r.parsed.effectsApplied).toBe(3);
    expect(r.parsed._commandExecuted).toBe("bridgeTestEffects");
    expect(r.text).not.toMatch(/has been queued/);
  }, 40000);

  it("classifies a rejected token, and still delivers the command over files", async () => {
    sock.pingAs(EXPECTED_VERSION);
    sock.writeRendezvous("a-token-the-panel-does-not-know");
    try {
      const r = await client.callTool("check-bridge", {});
      expect(r.parsed.socket.problem).toBe("token-rejected");
      expect(r.parsed.socket.allListeners[0].reachable).toBe(false);
      // A refusal happens BEFORE the panel dispatches, so retrying over files
      // cannot double-execute. check-bridge reads this from canFallbackFrom,
      // the same function sendBridgeCommand uses.
      expect(r.parsed.socket.allListeners[0].wouldFallBackToFile).toBe(true);
      // And it really does fall back: the health check itself came back over
      // the file transport while the socket was reporting token-rejected.
      expect(r.parsed.ok).toBe(true);
      expect(r.parsed.transportInUse).toBe("file");
    } finally {
      sock.writeRendezvous();
    }
  }, 20000);

  it("classifies a closed panel that left its rendezvous file behind", async () => {
    sock.pingAs(EXPECTED_VERSION);
    await sock.closeListener();
    try {
      const r = await client.callTool("check-bridge", {});
      expect(r.parsed.socket.problem).toBe("connection-refused");
      expect(r.parsed.socket.allListeners[0].reachable).toBe(false);
      expect(r.parsed.socket.allListeners[0].wouldFallBackToFile).toBe(true);
      expect(r.parsed.socket.hint).toMatch(new RegExp(String(sock.port)));
      // The stale file is NOT deleted: it is minutes old, and a panel that is
      // merely restarting must not have its rendezvous pulled out from under it.
      expect(fs.existsSync(sock.rendezvousPath)).toBe(true);
    } finally {
      sock.removeRendezvous();
      await sock.start();
      sock.pingAs(EXPECTED_VERSION);
    }
  }, 20000);

  it("reports a listener whose protocol version this server cannot speak", async () => {
    sock.pingAs(EXPECTED_VERSION);
    fs.writeFileSync(
      sock.rendezvousPath,
      JSON.stringify({
        v: 99,
        port: sock.port,
        token: sock.token,
        bridgeVersion: "2.0.0-future",
        aeVersion: "27.0 (FUTURE)",
        boundAt: new Date().toISOString(),
        project: "FUTURE.aep",
      }),
    );
    try {
      const r = await client.callTool("check-bridge", {});
      // The file it wrote is unreadable to us, but reporting "no listener" would
      // send the user off reinstalling a panel that is newer, not broken.
      expect(r.parsed.socket.problem).toBe("protocol-mismatch");
      expect(r.parsed.socket.selectedPort).toBeNull();
      expect(r.parsed.socket.allListeners[0].protocolVersion).toBe(99);
      expect(r.parsed.socket.allListeners[0].reachable).toBeNull();
      expect(r.parsed.socket.hint).toMatch(/newer bridge protocol/);
    } finally {
      sock.writeRendezvous();
    }
  }, 20000);

  it("lists two listeners and targets the lowest port", async () => {
    sock.pingAs(EXPECTED_VERSION);
    const second = new FakeSocketAE(dir);
    second.bridgeVersion = EXPECTED_VERSION;
    second.pingAs(EXPECTED_VERSION);
    await second.start();
    try {
      const r = await client.callTool("check-bridge", {});
      expect(r.parsed.socket.allListeners).toHaveLength(2);
      const lowest = Math.min(sock.port, second.port);
      expect(r.parsed.socket.selectedPort).toBe(lowest);
      // Both are probed, so the user can see the instance they are NOT talking
      // to is alive rather than guessing why commands land in the wrong AE.
      for (const l of r.parsed.socket.allListeners) {
        expect(l.reachable).toBe(true);
        expect(l.selected).toBe(l.port === lowest);
      }
    } finally {
      await second.stop();
    }
  }, 20000);
});
