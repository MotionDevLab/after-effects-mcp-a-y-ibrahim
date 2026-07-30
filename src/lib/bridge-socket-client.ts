// The Node side of the socket transport: connect to the After Effects panel,
// send one command, read one result, close.
//
// This lives in src/lib rather than index.ts on purpose. index.ts starts an MCP
// server on import, so it gets neither unit tests nor coverage, whereas this
// module can be driven end to end in CI against a plain Node `net` server
// standing in for the panel. Given that its output decides whether a
// non-idempotent command may be retried over the file transport, it is exactly
// the code that must not be untested.

import * as net from "net";
import {
  ACK_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  classifyControlLine,
  createFrameReader,
  encodeCommandLine,
} from "./bridge-socket.js";

/**
 * Where the attempt stopped. This is the input to the fallback decision, so the
 * distinctions are load bearing rather than cosmetic:
 *
 *   connect  - nothing was ever written to a socket
 *   ack      - the peer never produced a valid ACK
 *   auth     - the peer explicitly refused before dispatching
 *   io       - the connection failed AFTER a valid ACK
 *   deadline - the caller's total timeout elapsed after a valid ACK
 *
 * The panel writes its ACK BEFORE handing the command to executeCommand, so the
 * first three prove no command ran and are safe to retry over files. The last
 * two do not: the command may already have executed, and deleteLayer is not
 * idempotent. See canFallbackFrom.
 */
export type SendPhase = "connect" | "ack" | "auth" | "io" | "deadline";

export type SendResult =
  | { ok: true; raw: string; ackMs: number; totalMs: number }
  | {
      ok: false;
      phase: SendPhase;
      /** Machine-readable detail for check-bridge, e.g. "unauthorized", "ECONNREFUSED". */
      reason: string;
      error: string;
      canFallback: boolean;
      totalMs: number;
    };

/**
 * THE SAFETY RULE. Fall back to the file transport only from a state that
 * proves nothing executed.
 *
 * Everything else in this module exists to classify the failure accurately
 * enough for this one function to be correct.
 */
export function canFallbackFrom(phase: SendPhase): boolean {
  return phase === "connect" || phase === "ack" || phase === "auth";
}

export interface SendOverSocketOptions {
  port: number;
  token: string;
  commandId: string;
  command: string;
  args?: unknown;
  /** Total deadline measured from the call, matching the file transport's timeoutMs. */
  timeoutMs: number;
  host?: string;
  connectTimeoutMs?: number;
  ackTimeoutMs?: number;
}

/**
 * Send one command to the panel and resolve with its raw result string.
 * Never rejects: every failure comes back as a classified SendResult.
 *
 * On timeouts, note what is deliberately NOT used here: `socket.setTimeout`.
 * Node's socket timeout is an IDLE timer, and a long render is pure idle time
 * (the panel is blocked inside rq.render() for minutes with the connection open
 * but silent), so an idle timeout would kill exactly the commands it is meant to
 * protect. Instead there are three explicit timers, all measuring real elapsed
 * time: connect, ACK, and the caller's total deadline. `setKeepAlive` is
 * likewise omitted; on loopback a dead peer surfaces immediately as FIN or RST.
 */
export function sendOverSocket(opts: SendOverSocketOptions): Promise<SendResult> {
  const host = opts.host ?? "127.0.0.1";
  const connectMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const ackMs = opts.ackTimeoutMs ?? ACK_TIMEOUT_MS;
  const startedAt = Date.now();

  return new Promise<SendResult>((resolve) => {
    const reader = createFrameReader();
    let settled = false;
    let phase: "connecting" | "await-ack" | "await-result" = "connecting";
    let ackAt = 0;
    // Whether the peer sent ANY bytes before the ACK completed. A connection
    // that dies mid-ACK is not the same as one that never answered: the panel
    // was already writing, so it may have gone on to dispatch. Treat that as io.
    let sawBytesBeforeAck = false;

    let connectTimer: NodeJS.Timeout | null = null;
    let ackTimer: NodeJS.Timeout | null = null;
    let deadlineTimer: NodeJS.Timeout | null = null;

    const socket = net.connect({ port: opts.port, host });
    socket.setNoDelay(true);

    const clearTimers = (): void => {
      if (connectTimer) clearTimeout(connectTimer);
      if (ackTimer) clearTimeout(ackTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      connectTimer = ackTimer = deadlineTimer = null;
    };

    const finish = (result: SendResult): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      socket.destroy();
      resolve(result);
    };

    const fail = (p: SendPhase, reason: string, message: string): void => {
      finish({
        ok: false,
        phase: p,
        reason,
        error: message,
        canFallback: canFallbackFrom(p),
        totalMs: Date.now() - startedAt,
      });
    };

    deadlineTimer = setTimeout(() => {
      // Before the ACK, an elapsed deadline still proves nothing was dispatched,
      // so it is reported as an ack failure and stays fallback eligible.
      if (phase === "await-result") {
        fail("deadline", "timeout", `Timed out after ${opts.timeoutMs} ms waiting for the result.`);
      } else {
        fail(
          "ack",
          "timeout",
          `Timed out after ${opts.timeoutMs} ms before the bridge acknowledged.`,
        );
      }
    }, opts.timeoutMs);

    connectTimer = setTimeout(() => {
      fail(
        "connect",
        "connect-timeout",
        `Could not connect to ${host}:${opts.port} in ${connectMs} ms.`,
      );
    }, connectMs);

    socket.on("connect", () => {
      if (settled) return;
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      phase = "await-ack";
      ackTimer = setTimeout(() => {
        // Every bridge >= 1.12 publishes a rendezvous file AND acknowledges, so
        // silence here means whatever holds this port is not our panel.
        fail(
          "ack",
          "no-ack",
          `No bridge acknowledgement from ${host}:${opts.port} within ${ackMs} ms.`,
        );
      }, ackMs);

      try {
        socket.write(
          encodeCommandLine({
            token: opts.token,
            commandId: opts.commandId,
            command: opts.command,
            args: opts.args,
          }),
          "utf8",
        );
      } catch (e) {
        fail("connect", "write-failed", `Failed to send the command: ${String(e)}`);
      }
    });

    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (phase === "await-ack") sawBytesBeforeAck = true;

      for (const line of reader.push(chunk)) {
        if (settled) return;

        if (phase === "await-ack") {
          const control = classifyControlLine(line, opts.commandId);
          if (control.kind === "ack") {
            phase = "await-result";
            ackAt = Date.now();
            if (ackTimer) {
              clearTimeout(ackTimer);
              ackTimer = null;
            }
            continue;
          }
          if (control.kind === "reject") {
            // The panel refused before dispatching, so nothing ran.
            fail("auth", control.reason, `The AE bridge refused the command: ${control.reason}.`);
            return;
          }
          fail(
            "ack",
            "protocol-violation",
            `Unexpected first line from ${host}:${opts.port}; this port is not the AE bridge.`,
          );
          return;
        }

        // Post-ACK: the next line correlated to this command is the result.
        // A line carrying somebody else's id is skipped rather than returned,
        // so a confused peer can never cross wires between two commands.
        let parsed: any = null;
        try {
          parsed = JSON.parse(line);
        } catch {
          /* opaque text: the file transport passes it through too, so we do the same */
        }
        if (parsed && parsed._commandId !== undefined && parsed._commandId !== opts.commandId) {
          continue;
        }
        finish({ ok: true, raw: line, ackMs: ackAt - startedAt, totalMs: Date.now() - startedAt });
        return;
      }
    });

    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      const code = err.code || "EUNKNOWN";
      if (phase === "connecting") {
        fail("connect", code, `Could not reach the AE bridge at ${host}:${opts.port} (${code}).`);
      } else if (phase === "await-ack" && !sawBytesBeforeAck) {
        fail("ack", code, `The AE bridge closed the connection before acknowledging (${code}).`);
      } else {
        fail("io", code, `The AE bridge connection failed after acknowledging (${code}).`);
      }
    });

    socket.on("close", () => {
      if (settled) return;
      // A peer that closed without a trailing newline still owes us its last
      // frame; take it before deciding this was a failure.
      const rest = reader.flush();
      if (rest !== null && rest.length > 0 && phase === "await-result") {
        finish({ ok: true, raw: rest, ackMs: ackAt - startedAt, totalMs: Date.now() - startedAt });
        return;
      }
      if (phase === "connecting") {
        fail(
          "connect",
          "closed",
          `The connection to ${host}:${opts.port} closed before it opened.`,
        );
      } else if (phase === "await-ack" && !sawBytesBeforeAck) {
        fail("ack", "closed", `The AE bridge closed the connection before acknowledging.`);
      } else {
        fail("io", "closed", `The AE bridge closed the connection before returning a result.`);
      }
    });
  });
}
