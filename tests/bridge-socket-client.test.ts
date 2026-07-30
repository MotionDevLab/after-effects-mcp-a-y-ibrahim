import { describe, it, expect, afterEach } from "vitest";
import * as net from "net";
import { sendOverSocket, canFallbackFrom, type SendResult } from "../src/lib/bridge-socket-client";
import { ACK_TIMEOUT_MS } from "../src/lib/bridge-socket";

const TOKEN = "0123456789abcdef";

interface FakeAE {
  port: number;
  close: () => Promise<void>;
}

/**
 * Stand in for the After Effects panel: accept one connection, read one
 * newline-delimited command, and hand it to `handler` along with the socket so
 * each test can decide exactly how the panel misbehaves.
 */
async function startFakeAE(
  handler: (socket: net.Socket, cmd: any) => void | Promise<void>,
): Promise<FakeAE> {
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let cmd: any = null;
      try {
        cmd = JSON.parse(line);
      } catch {
        /* let the handler see null */
      }
      void handler(socket, cmd);
    });
    socket.on("error", () => {
      /* the client destroys sockets on purpose in several tests */
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** The normal panel: ACK, then the result, then close. */
function ackAndReply(payload: Record<string, unknown>) {
  return (socket: net.Socket, cmd: any) => {
    socket.write(JSON.stringify({ _ack: 1, commandId: cmd.commandId }) + "\n");
    socket.write(JSON.stringify({ ...payload, _commandId: cmd.commandId }) + "\n");
    socket.end();
  };
}

function send(port: number, over: Partial<Parameters<typeof sendOverSocket>[0]> = {}) {
  return sendOverSocket({
    port,
    token: TOKEN,
    commandId: "1760000000000-1",
    command: "getCompFull",
    args: { compIndex: 1 },
    timeoutMs: 5000,
    ...over,
  });
}

function expectFailure(r: SendResult): Extract<SendResult, { ok: false }> {
  expect(r.ok).toBe(false);
  return r as Extract<SendResult, { ok: false }>;
}

let running: FakeAE | null = null;
afterEach(async () => {
  if (running) await running.close();
  running = null;
});

describe("canFallbackFrom", () => {
  it("allows the file fallback only from states that prove nothing executed", () => {
    expect(canFallbackFrom("connect")).toBe(true);
    expect(canFallbackFrom("ack")).toBe(true);
    expect(canFallbackFrom("auth")).toBe(true);
    // The command may already have run, and deleteLayer is not idempotent.
    expect(canFallbackFrom("io")).toBe(false);
    expect(canFallbackFrom("deadline")).toBe(false);
  });
});

describe("sendOverSocket happy path", () => {
  it("sends the command and returns the raw result line", async () => {
    let received: any = null;
    running = await startFakeAE((socket, cmd) => {
      received = cmd;
      ackAndReply({ status: "success", value: 42 })(socket, cmd);
    });

    const r = await send(running.port);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.parse(r.raw)).toMatchObject({ status: "success", value: 42 });

    expect(received.v).toBe(1);
    expect(received.token).toBe(TOKEN);
    expect(received.command).toBe("getCompFull");
    expect(received.commandId).toBe("1760000000000-1");
    expect(received.args).toEqual({ compIndex: 1 });
  });

  it("passes non-JSON output through untouched, as the file transport does", async () => {
    running = await startFakeAE((socket, cmd) => {
      socket.write(JSON.stringify({ _ack: 1, commandId: cmd.commandId }) + "\n");
      socket.write("not json at all\n");
      socket.end();
    });
    const r = await send(running.port);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.raw).toBe("not json at all");
  });

  it("accepts a final result that arrives without a trailing newline before close", async () => {
    running = await startFakeAE((socket, cmd) => {
      socket.write(JSON.stringify({ _ack: 1, commandId: cmd.commandId }) + "\n");
      socket.end(JSON.stringify({ status: "success", _commandId: cmd.commandId }));
    });
    const r = await send(running.port);
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.parse(r.raw).status).toBe("success");
  });

  it("round trips Arabic text byte for byte", async () => {
    const arabic = "مرحبا بالعالم، هذه طبقة نص عربية";
    let sent: any = null;
    running = await startFakeAE((socket, cmd) => {
      sent = cmd;
      ackAndReply({ status: "success", text: cmd.args.text })(socket, cmd);
    });

    const r = await send(running.port, {
      command: "create-text-layer",
      args: { text: arabic },
    });
    expect(sent.args.text).toBe(arabic);
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.parse(r.raw).text).toBe(arabic);
  });

  it("reassembles a 1 MB result split across 200 writes", async () => {
    const big = "م".repeat(300_000); // ~600 KB as UTF-8, plus JSON overhead
    running = await startFakeAE((socket, cmd) => {
      socket.write(JSON.stringify({ _ack: 1, commandId: cmd.commandId }) + "\n");
      const payload =
        JSON.stringify({ status: "success", blob: big, _commandId: cmd.commandId }) + "\n";
      const bytes = Buffer.from(payload, "utf8");
      const step = Math.ceil(bytes.length / 200);
      for (let i = 0; i < bytes.length; i += step) {
        socket.write(bytes.subarray(i, Math.min(i + step, bytes.length)));
      }
      socket.end();
    });

    const r = await send(running.port, { timeoutMs: 20000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = JSON.parse(r.raw);
    expect(parsed.blob).toBe(big);
    expect(parsed.blob).not.toContain("�");
  }, 30000);
});

describe("sendOverSocket fallback eligible failures", () => {
  it("reports connect when nothing is listening, and does so fast", async () => {
    // Bind then release a port so we know for certain it is closed.
    const probe = await startFakeAE(() => {});
    const deadPort = probe.port;
    await probe.close();

    const started = Date.now();
    const r = expectFailure(await send(deadPort));
    expect(r.phase).toBe("connect");
    expect(r.canFallback).toBe(true);
    // A refusal on loopback is immediate; this is why discovery costs nothing
    // in the happy path even when the panel is closed.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("reports auth when the panel refuses the token, and stays fallback eligible", async () => {
    running = await startFakeAE((socket) => {
      socket.write(JSON.stringify({ _ack: 0, error: "unauthorized" }) + "\n");
      socket.end();
    });
    const r = expectFailure(await send(running.port));
    expect(r.phase).toBe("auth");
    expect(r.reason).toBe("unauthorized");
    expect(r.canFallback).toBe(true);
  });

  it("preserves the refusal reason so check-bridge can classify it", async () => {
    running = await startFakeAE((socket) => {
      socket.write(JSON.stringify({ _ack: 0, error: "protocol-mismatch" }) + "\n");
      socket.end();
    });
    const r = expectFailure(await send(running.port));
    expect(r.phase).toBe("auth");
    expect(r.reason).toBe("protocol-mismatch");
  });

  it("reports ack when a listener accepts but never acknowledges", async () => {
    running = await startFakeAE(() => {
      /* silence: some other process squatting the port */
    });
    const r = expectFailure(await send(running.port, { ackTimeoutMs: 250 }));
    expect(r.phase).toBe("ack");
    expect(r.reason).toBe("no-ack");
    expect(r.canFallback).toBe(true);
  });

  it("reports ack when the first line is not a control line at all", async () => {
    running = await startFakeAE((socket) => {
      socket.write("HTTP/1.1 400 Bad Request\r\n");
    });
    const r = expectFailure(await send(running.port, { ackTimeoutMs: 500 }));
    expect(r.phase).toBe("ack");
    expect(r.reason).toBe("protocol-violation");
    expect(r.canFallback).toBe(true);
  });

  it("reports ack when the ACK carries somebody else's command id", async () => {
    running = await startFakeAE((socket) => {
      socket.write(JSON.stringify({ _ack: 1, commandId: "someone-else" }) + "\n");
    });
    const r = expectFailure(await send(running.port, { ackTimeoutMs: 500 }));
    expect(r.phase).toBe("ack");
    expect(r.canFallback).toBe(true);
  });

  it("reports ack when the peer closes without saying anything", async () => {
    running = await startFakeAE((socket) => socket.destroy());
    const r = expectFailure(await send(running.port));
    expect(r.phase).toBe("ack");
    expect(r.canFallback).toBe(true);
  });

  it("reports ack when the deadline expires before any acknowledgement", async () => {
    running = await startFakeAE(() => {
      /* silence */
    });
    const r = expectFailure(await send(running.port, { timeoutMs: 200, ackTimeoutMs: 60000 }));
    expect(r.phase).toBe("ack");
    expect(r.reason).toBe("timeout");
    // Still safe: no ACK means the panel never dispatched.
    expect(r.canFallback).toBe(true);
  });
});

describe("sendOverSocket failures that must NOT fall back", () => {
  it("reports io when the connection dies after a valid ACK", async () => {
    // SC-10. The panel acknowledged, so the command may already be running
    // inside After Effects. Replaying it over the file transport could delete a
    // layer twice.
    running = await startFakeAE((socket, cmd) => {
      socket.write(JSON.stringify({ _ack: 1, commandId: cmd.commandId }) + "\n");
      setTimeout(() => socket.destroy(), 50);
    });
    const r = expectFailure(await send(running.port));
    expect(r.phase).toBe("io");
    expect(r.canFallback).toBe(false);
  });

  it("reports io when the peer dies MID-ACK rather than before it", async () => {
    // Bytes were already flowing, so the panel was writing and may have gone on
    // to dispatch. Only total silence proves nothing ran.
    running = await startFakeAE((socket) => {
      socket.write('{"_ack":1,"comm');
      setTimeout(() => socket.destroy(), 50);
    });
    const r = expectFailure(await send(running.port, { ackTimeoutMs: 2000 }));
    expect(r.phase).toBe("io");
    expect(r.canFallback).toBe(false);
  });

  it("reports deadline when the result never arrives after a valid ACK", async () => {
    running = await startFakeAE((socket, cmd) => {
      socket.write(JSON.stringify({ _ack: 1, commandId: cmd.commandId }) + "\n");
      // Never replies: stands in for a command still running inside AE.
    });
    const started = Date.now();
    const r = expectFailure(await send(running.port, { timeoutMs: 400 }));
    expect(r.phase).toBe("deadline");
    expect(r.canFallback).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
  });
});

describe("sendOverSocket long blocking commands", () => {
  it("survives a long idle gap after the ACK", async () => {
    // THE REGRESSION GUARD. During rq.render() the panel is blocked for minutes
    // with the connection open and completely silent. If anyone reintroduces
    // socket.setTimeout (an IDLE timer) or forgets to clear the ACK timer, this
    // fails and every render breaks. The gap deliberately exceeds ACK_TIMEOUT_MS.
    const idleMs = ACK_TIMEOUT_MS + 300;
    running = await startFakeAE((socket, cmd) => {
      socket.write(JSON.stringify({ _ack: 1, commandId: cmd.commandId }) + "\n");
      setTimeout(() => {
        socket.write(JSON.stringify({ status: "success", _commandId: cmd.commandId }) + "\n");
        socket.end();
      }, idleMs);
    });

    const r = await send(running.port, { timeoutMs: 20000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.parse(r.raw).status).toBe("success");
    expect(r.totalMs).toBeGreaterThanOrEqual(idleMs);
    // The ACK landed promptly even though the result did not.
    expect(r.ackMs).toBeLessThan(1000);
  }, 30000);
});

describe("sendOverSocket correlation", () => {
  it("skips a result carrying a different command id and waits for its own", async () => {
    running = await startFakeAE((socket, cmd) => {
      socket.write(JSON.stringify({ _ack: 1, commandId: cmd.commandId }) + "\n");
      socket.write(JSON.stringify({ status: "success", who: "stray", _commandId: "other" }) + "\n");
      socket.write(
        JSON.stringify({ status: "success", who: "mine", _commandId: cmd.commandId }) + "\n",
      );
      socket.end();
    });
    const r = await send(running.port);
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.parse(r.raw).who).toBe("mine");
  });

  it("keeps two concurrent commands on separate connections and results", async () => {
    running = await startFakeAE((socket, cmd) => {
      const delay = cmd.commandId.endsWith("-a") ? 120 : 10;
      socket.write(JSON.stringify({ _ack: 1, commandId: cmd.commandId }) + "\n");
      setTimeout(() => {
        socket.write(JSON.stringify({ echo: cmd.commandId, _commandId: cmd.commandId }) + "\n");
        socket.end();
      }, delay);
    });

    const [a, b] = await Promise.all([
      send(running.port, { commandId: "id-a" }),
      send(running.port, { commandId: "id-b" }),
    ]);
    expect(a.ok && JSON.parse(a.raw).echo).toBe("id-a");
    expect(b.ok && JSON.parse(b.raw).echo).toBe("id-b");
  });
});
