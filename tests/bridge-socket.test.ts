import { describe, it, expect } from "vitest";
import {
  SOCKET_PORT_BASE,
  SOCKET_PORT_TRIES,
  PROTOCOL_VERSION,
  REDISCOVER_MS,
  isValidPort,
  candidatePorts,
  rendezvousFileName,
  parseRendezvousFileName,
  parseRendezvous,
  isSupportedRendezvous,
  isStaleRendezvous,
  selectRendezvous,
  encodeCommandLine,
  isAckLine,
  createFrameReader,
  readTransportMode,
  readPinnedPort,
  shouldRediscover,
  type Rendezvous,
} from "../src/lib/bridge-socket";

function rv(port: number, over: Partial<Rendezvous> = {}): Rendezvous {
  return {
    v: PROTOCOL_VERSION,
    port,
    token: "deadbeef",
    bridgeVersion: "1.12.0-mcp-socket",
    aeVersion: "26.0x67",
    boundAt: "2026-07-30T10:00:00.000Z",
    project: "Scratch.aep",
    ...over,
  };
}

describe("isValidPort", () => {
  it("accepts the usable TCP range", () => {
    expect(isValidPort(1)).toBe(true);
    expect(isValidPort(SOCKET_PORT_BASE)).toBe(true);
    expect(isValidPort(65535)).toBe(true);
  });

  it("rejects 0, negatives, out of range, non-integers and non-numbers", () => {
    expect(isValidPort(0)).toBe(false);
    expect(isValidPort(-1)).toBe(false);
    expect(isValidPort(65536)).toBe(false);
    expect(isValidPort(47800.5)).toBe(false);
    expect(isValidPort("47800")).toBe(false);
    expect(isValidPort(null)).toBe(false);
    expect(isValidPort(undefined)).toBe(false);
    expect(isValidPort(NaN)).toBe(false);
  });
});

describe("candidatePorts", () => {
  it("scans the full band from the base port", () => {
    const ports = candidatePorts();
    expect(ports).toHaveLength(SOCKET_PORT_TRIES);
    expect(ports[0]).toBe(SOCKET_PORT_BASE);
    expect(ports[ports.length - 1]).toBe(SOCKET_PORT_BASE + SOCKET_PORT_TRIES - 1);
  });

  it("puts a preferred port first without repeating it later in the scan", () => {
    const ports = candidatePorts(SOCKET_PORT_BASE + 5);
    expect(ports[0]).toBe(SOCKET_PORT_BASE + 5);
    expect(ports.filter((p) => p === SOCKET_PORT_BASE + 5)).toHaveLength(1);
    // Preferred is inside the band, so the list length is unchanged.
    expect(ports).toHaveLength(SOCKET_PORT_TRIES);
  });

  it("keeps a preferred port outside the band and still offers the full scan", () => {
    const ports = candidatePorts(9999);
    expect(ports[0]).toBe(9999);
    expect(ports).toHaveLength(SOCKET_PORT_TRIES + 1);
    expect(ports[1]).toBe(SOCKET_PORT_BASE);
  });

  it("ignores an invalid preferred port instead of failing the scan", () => {
    expect(candidatePorts(0)[0]).toBe(SOCKET_PORT_BASE);
    expect(candidatePorts(-5)[0]).toBe(SOCKET_PORT_BASE);
    expect(candidatePorts(null)[0]).toBe(SOCKET_PORT_BASE);
    expect(candidatePorts(undefined)[0]).toBe(SOCKET_PORT_BASE);
  });

  it("never produces a port above the valid range", () => {
    const ports = candidatePorts(null, 65530, 16);
    expect(ports[ports.length - 1]).toBe(65535);
    expect(ports.every(isValidPort)).toBe(true);
  });
});

describe("rendezvous file names", () => {
  it("round trips a port through the file name", () => {
    const name = rendezvousFileName(47803);
    expect(name).toBe("ae_bridge_port_47803.json");
    expect(parseRendezvousFileName(name)).toBe(47803);
  });

  it("rejects names that are not rendezvous files", () => {
    expect(parseRendezvousFileName("ae_command.json")).toBeNull();
    expect(parseRendezvousFileName("ae_mcp_result.json")).toBeNull();
    expect(parseRendezvousFileName("ae_bridge_port_.json")).toBeNull();
    expect(parseRendezvousFileName("ae_bridge_port_47800.json.tmp")).toBeNull();
    expect(parseRendezvousFileName("ae_bridge_port_abc.json")).toBeNull();
    expect(parseRendezvousFileName("prefix_ae_bridge_port_47800.json")).toBeNull();
  });

  it("rejects a syntactically valid name carrying an out of range port", () => {
    expect(parseRendezvousFileName("ae_bridge_port_99999.json")).toBeNull();
    expect(parseRendezvousFileName("ae_bridge_port_0.json")).toBeNull();
  });
});

describe("parseRendezvous", () => {
  const good = JSON.stringify(rv(47800));

  it("parses a well formed file", () => {
    const r = parseRendezvous(good, 47800);
    expect(r).not.toBeNull();
    expect(r!.port).toBe(47800);
    expect(r!.token).toBe("deadbeef");
    expect(r!.project).toBe("Scratch.aep");
  });

  it("never throws on garbage, truncation or empty input", () => {
    expect(parseRendezvous("")).toBeNull();
    expect(parseRendezvous("not json at all")).toBeNull();
    expect(parseRendezvous('{"v":1,"port":47800,"tok')).toBeNull();
    expect(parseRendezvous("null")).toBeNull();
    expect(parseRendezvous("[]")).toBeNull();
    expect(parseRendezvous("42")).toBeNull();
  });

  it("rejects a file with no usable port or token", () => {
    expect(parseRendezvous(JSON.stringify({ v: 1, token: "x" }))).toBeNull();
    expect(parseRendezvous(JSON.stringify({ v: 1, port: 47800 }))).toBeNull();
    expect(parseRendezvous(JSON.stringify({ v: 1, port: 47800, token: "" }))).toBeNull();
    expect(parseRendezvous(JSON.stringify({ v: 1, port: "47800", token: "x" }))).toBeNull();
  });

  it("rejects a file whose contents disagree with its name", () => {
    // A copied or corrupted file: trusting either number would aim commands at
    // a port nobody is serving.
    expect(parseRendezvous(good, 47801)).toBeNull();
  });

  it("tolerates missing optional metadata", () => {
    const r = parseRendezvous(JSON.stringify({ v: 1, port: 47800, token: "t" }));
    expect(r).not.toBeNull();
    expect(r!.bridgeVersion).toBe("");
    expect(r!.aeVersion).toBe("");
    expect(r!.project).toBe("");
  });

  it("preserves an unknown protocol version so callers can report a mismatch", () => {
    const r = parseRendezvous(JSON.stringify(rv(47800, { v: 99 })), 47800);
    expect(r).not.toBeNull();
    expect(r!.v).toBe(99);
    expect(isSupportedRendezvous(r!)).toBe(false);
    expect(isSupportedRendezvous(rv(47800))).toBe(true);
  });
});

describe("isStaleRendezvous", () => {
  const now = Date.parse("2026-07-30T10:00:00.000Z");

  it("is not stale when freshly bound", () => {
    expect(isStaleRendezvous(rv(47800, { boundAt: "2026-07-30T09:59:00.000Z" }), now)).toBe(false);
  });

  it("is stale well past the max age", () => {
    expect(isStaleRendezvous(rv(47800, { boundAt: "2026-07-27T10:00:00.000Z" }), now)).toBe(true);
  });

  it("treats an unparseable timestamp as NOT stale", () => {
    // Better to leave a file we do not understand than to delete a live listener's.
    expect(isStaleRendezvous(rv(47800, { boundAt: "" }), now)).toBe(false);
    expect(isStaleRendezvous(rv(47800, { boundAt: "yesterday" }), now)).toBe(false);
  });
});

describe("selectRendezvous", () => {
  it("returns null with no listeners", () => {
    expect(selectRendezvous([])).toBeNull();
  });

  it("picks the LOWEST port so a second AE cannot silently re-target the user", () => {
    const chosen = selectRendezvous([rv(47802), rv(47800), rv(47801)]);
    expect(chosen!.port).toBe(47800);
  });

  it("ignores boundAt entirely, so restart order does not change the target", () => {
    const older = rv(47800, { boundAt: "2020-01-01T00:00:00.000Z" });
    const newer = rv(47801, { boundAt: "2026-07-30T23:59:00.000Z" });
    expect(selectRendezvous([newer, older])!.port).toBe(47800);
  });

  it("honors a pinned port exactly", () => {
    const chosen = selectRendezvous([rv(47800), rv(47801)], 47801);
    expect(chosen!.port).toBe(47801);
  });

  it("returns null rather than drifting when the pinned port has no listener", () => {
    expect(selectRendezvous([rv(47800), rv(47802)], 47801)).toBeNull();
  });

  it("falls back to lowest when the pin is invalid", () => {
    expect(selectRendezvous([rv(47801), rv(47800)], 0)!.port).toBe(47800);
    expect(selectRendezvous([rv(47801), rv(47800)], null)!.port).toBe(47800);
  });
});

describe("encodeCommandLine", () => {
  it("emits exactly one newline, at the very end", () => {
    const line = encodeCommandLine({
      token: "t",
      commandId: "1760000000000-7",
      command: "getCompFull",
      args: { compIndex: 1 },
    });
    expect(line.endsWith("\n")).toBe(true);
    expect(line.split("\n")).toHaveLength(2);
  });

  it("stamps the protocol version, token, id and command", () => {
    const parsed = JSON.parse(
      encodeCommandLine({ token: "abc", commandId: "id-1", command: "ping", args: { a: 1 } }),
    );
    expect(parsed).toEqual({
      v: PROTOCOL_VERSION,
      token: "abc",
      commandId: "id-1",
      command: "ping",
      args: { a: 1 },
    });
  });

  it("defaults missing args to an empty object", () => {
    const parsed = JSON.parse(
      encodeCommandLine({ token: "t", commandId: "i", command: "c", args: undefined }),
    );
    expect(parsed.args).toEqual({});
  });

  it("escapes embedded newlines, carriage returns, tabs and quotes so framing holds", () => {
    const nasty = 'line1\nline2\r\nline3\ttabbed "quoted" \\ backslash';
    const line = encodeCommandLine({
      token: "t",
      commandId: "i",
      command: "create-text-layer",
      args: { text: nasty },
    });
    expect(line.split("\n")).toHaveLength(2);
    expect(JSON.parse(line).args.text).toBe(nasty);
  });

  it("round trips Arabic text unchanged", () => {
    const arabic = "مرحبا بالعالم";
    const line = encodeCommandLine({
      token: "t",
      commandId: "i",
      command: "create-text-layer",
      args: { text: arabic },
    });
    expect(JSON.parse(line).args.text).toBe(arabic);
  });
});

describe("isAckLine", () => {
  it("accepts the panel's ACK for the matching command id", () => {
    const ack = JSON.stringify({ _ack: 1, commandId: "id-1", bridgeVersion: "1.12.0-mcp-socket" });
    expect(isAckLine(ack, "id-1")).toBe(true);
    expect(isAckLine(ack)).toBe(true);
  });

  it("rejects an ACK for a different command id", () => {
    const ack = JSON.stringify({ _ack: 1, commandId: "id-2" });
    expect(isAckLine(ack, "id-1")).toBe(false);
  });

  it("rejects a result line, garbage and non-objects", () => {
    expect(isAckLine(JSON.stringify({ status: "success", _commandId: "id-1" }), "id-1")).toBe(
      false,
    );
    expect(isAckLine("not json")).toBe(false);
    expect(isAckLine("")).toBe(false);
    expect(isAckLine("null")).toBe(false);
    expect(isAckLine("1")).toBe(false);
  });

  it("requires _ack to be exactly 1, not merely truthy", () => {
    expect(isAckLine(JSON.stringify({ _ack: true, commandId: "id-1" }), "id-1")).toBe(false);
    expect(isAckLine(JSON.stringify({ _ack: "1", commandId: "id-1" }), "id-1")).toBe(false);
  });
});

describe("createFrameReader", () => {
  it("returns complete lines and buffers the partial remainder", () => {
    const r = createFrameReader();
    expect(r.push(Buffer.from("one\ntwo\nthr"))).toEqual(["one", "two"]);
    expect(r.pending()).toBe(3);
    expect(r.push(Buffer.from("ee\n"))).toEqual(["three"]);
    expect(r.pending()).toBe(0);
  });

  it("returns nothing until a terminator arrives", () => {
    const r = createFrameReader();
    expect(r.push(Buffer.from('{"a":'))).toEqual([]);
    expect(r.push(Buffer.from("1}"))).toEqual([]);
    expect(r.push(Buffer.from("\n"))).toEqual(['{"a":1}']);
  });

  it("splits many frames arriving in one chunk", () => {
    const r = createFrameReader();
    expect(r.push(Buffer.from("a\nb\nc\n"))).toEqual(["a", "b", "c"]);
  });

  it("emits empty lines rather than swallowing them", () => {
    const r = createFrameReader();
    expect(r.push(Buffer.from("\n\n"))).toEqual(["", ""]);
  });

  it("tolerates CRLF even though the panel writes a bare LF", () => {
    const r = createFrameReader();
    expect(r.push(Buffer.from("a\r\nb\n"))).toEqual(["a", "b"]);
  });

  it("survives a chunk boundary in the MIDDLE of a multibyte Arabic character", () => {
    // This is the exact corruption class that a naive chunk.toString("utf8")
    // accumulator produces: the trailing byte of م decodes to U+FFFD on its own.
    const payload = JSON.stringify({ status: "success", text: "مرحبا بالعالم" }) + "\n";
    const bytes = Buffer.from(payload, "utf8");
    const firstArabicByte = bytes.indexOf(0xd9);
    expect(firstArabicByte).toBeGreaterThan(-1);

    const r = createFrameReader();
    const split = firstArabicByte + 1; // dead centre of a 2 byte sequence
    expect(r.push(bytes.subarray(0, split))).toEqual([]);
    const lines = r.push(bytes.subarray(split));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).text).toBe("مرحبا بالعالم");
    expect(lines[0]).not.toContain("�");
  });

  it("reassembles a large payload delivered one byte at a time", () => {
    const payload = JSON.stringify({ text: "مرحبا".repeat(500), n: 12345 }) + "\n";
    const bytes = Buffer.from(payload, "utf8");
    const r = createFrameReader();
    const out: string[] = [];
    for (let i = 0; i < bytes.length; i++) out.push(...r.push(bytes.subarray(i, i + 1)));
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]).text).toBe("مرحبا".repeat(500));
  });

  it("flush() yields unterminated trailing bytes exactly once", () => {
    const r = createFrameReader();
    r.push(Buffer.from("done\npartial"));
    expect(r.flush()).toBe("partial");
    expect(r.flush()).toBeNull();
    expect(r.pending()).toBe(0);
  });

  it("flush() is null when everything was terminated", () => {
    const r = createFrameReader();
    r.push(Buffer.from("done\n"));
    expect(r.flush()).toBeNull();
  });

  it("is unaffected by the caller reusing the chunk buffer afterwards", () => {
    const r = createFrameReader();
    const chunk = Buffer.from("part");
    r.push(chunk);
    chunk.fill(0x58); // simulate a pooled buffer being overwritten
    expect(r.push(Buffer.from("ial\n"))).toEqual(["partial"]);
  });
});

describe("readTransportMode", () => {
  it("defaults to auto when unset", () => {
    expect(readTransportMode({})).toBe("auto");
    expect(readTransportMode({ AE_MCP_BRIDGE_TRANSPORT: "" })).toBe("auto");
  });

  it("reads the three valid modes, case and whitespace insensitively", () => {
    expect(readTransportMode({ AE_MCP_BRIDGE_TRANSPORT: "socket" })).toBe("socket");
    expect(readTransportMode({ AE_MCP_BRIDGE_TRANSPORT: " FILE " })).toBe("file");
    expect(readTransportMode({ AE_MCP_BRIDGE_TRANSPORT: "Auto" })).toBe("auto");
  });

  it("treats an unrecognized value as auto rather than disabling the bridge", () => {
    expect(readTransportMode({ AE_MCP_BRIDGE_TRANSPORT: "sockett" })).toBe("auto");
    expect(readTransportMode({ AE_MCP_BRIDGE_TRANSPORT: "tcp" })).toBe("auto");
  });
});

describe("readPinnedPort", () => {
  it("is null when unset or blank", () => {
    expect(readPinnedPort({})).toBeNull();
    expect(readPinnedPort({ AE_MCP_BRIDGE_PORT: "   " })).toBeNull();
  });

  it("reads a valid port", () => {
    expect(readPinnedPort({ AE_MCP_BRIDGE_PORT: "47805" })).toBe(47805);
    expect(readPinnedPort({ AE_MCP_BRIDGE_PORT: " 47805 " })).toBe(47805);
  });

  it("is null for values that are not usable ports", () => {
    expect(readPinnedPort({ AE_MCP_BRIDGE_PORT: "0" })).toBeNull();
    expect(readPinnedPort({ AE_MCP_BRIDGE_PORT: "70000" })).toBeNull();
    expect(readPinnedPort({ AE_MCP_BRIDGE_PORT: "abc" })).toBeNull();
    expect(readPinnedPort({ AE_MCP_BRIDGE_PORT: "478.5" })).toBeNull();
  });
});

describe("shouldRediscover", () => {
  it("always discovers when nothing is cached", () => {
    expect(shouldRediscover(null, 1_000_000)).toBe(true);
  });

  it("reuses the cache inside the TTL", () => {
    expect(shouldRediscover(1_000_000, 1_000_000 + REDISCOVER_MS - 1)).toBe(false);
  });

  it("re-reads once the TTL has elapsed", () => {
    expect(shouldRediscover(1_000_000, 1_000_000 + REDISCOVER_MS)).toBe(true);
    expect(shouldRediscover(1_000_000, 1_000_000 + REDISCOVER_MS * 10)).toBe(true);
  });
});
