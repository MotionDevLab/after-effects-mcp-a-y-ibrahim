/*
 * End-to-end verification for set-shape-path / get-shape-path and the
 * set-layer-mask tangent retrofit (GAPS.md #1).
 *
 * Requires the 1.11.0 bridge panel: npm run build && npm run install-bridge,
 * then CLOSE AND REOPEN Window > mcp-bridge-auto.jsx in After Effects.
 *
 * Follows the mandated project-safety flow: save + close the real project, do
 * everything in a scratch project, reopen the real one and assert it survived.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  cwd: "C:\\Users\\renat\\after-effects-mcp-a-y-ibrahim",
  stderr: "pipe",
});

const client = new Client({ name: "shape-path-test", version: "1.0.0" });
await client.connect(transport);
transport.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));

let stepNum = 0;
let failures = 0;
async function call(name, args = {}, { quiet = false } = {}) {
  stepNum++;
  console.log(`\n=== STEP ${stepNum}: ${name} ${JSON.stringify(args).slice(0, 220)} ===`);
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? JSON.stringify(res);
  if (!quiet) console.log(String(text).slice(0, 1100));
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  return { res, parsed, text, isError: !!res.isError };
}
function assert(cond, msg) {
  if (!cond) { console.log(`!!! FAILED: ${msg}`); failures++; }
  else console.log(`OK: ${msg}`);
}
function close(a, b, eps = 0.001) {
  return Math.abs(a - b) <= eps;
}

// ---- Bridge version gate: everything below is meaningless against an old panel.
const health = await call("check-bridge", {});
assert(
  health.parsed?.versionMatch === true,
  `bridge panel is the expected version (got ${health.parsed?.bridgeVersion}, expected ${health.parsed?.expectedBridgeVersion})`,
);
if (health.parsed?.versionMatch !== true) {
  console.log("\n!!! ABORTING: reopen Window > mcp-bridge-auto.jsx in After Effects first.");
  await client.close();
  process.exit(1);
}

// ---- Save + close the real project ----
const info0 = await call("run-script", { script: "getProjectInfo" });
const originalPath = info0.parsed?.path;
assert(!!originalPath, `original project path captured (${originalPath})`);
await call("save-project", {});
await call("close-project", { saveFirst: false });

// ---- Scratch project ----
await call("create-project", { saveFirst: false });
await call("create-composition", {
  name: "ShapeTest", width: 640, height: 360, frameRate: 30, duration: 5,
});

// ==================== raw vertices + tangents round-trip ====================
const raw = await call("set-shape-path", {
  compName: "ShapeTest",
  createLayer: true,
  layerName: "RawPath",
  vertices: [[-100, -60], [100, -60], [100, 60], [-100, 60]],
  inTangents: [[-30, 0], [-30, 0], [30, 0], [30, 0]],
  outTangents: [[30, 0], [30, 0], [-30, 0], [-30, 0]],
  closed: true,
  fillColor: [1, 0.2, 0.2],
});
assert(raw.parsed?.status === "success", "set-shape-path (raw vertices) succeeded");
assert(raw.parsed?.layer?.created === true, "createLayer added a new shape layer");
assert(raw.parsed?.createdGroup === true && raw.parsed?.createdPath === true, "a new group and path were appended");
assert(raw.parsed?.addedDefaultFill === false, "no default fill added when fillColor was supplied");

const readBack = await call("get-shape-path", { compName: "ShapeTest", layerName: "RawPath" });
assert(readBack.parsed?.status === "success", "get-shape-path succeeded");
const path0 = readBack.parsed?.groups?.[0]?.paths?.[0];
assert(path0?.value?.numVertices === 4, `read back 4 vertices (got ${path0?.value?.numVertices})`);
assert(
  JSON.stringify(path0?.value?.vertices) === JSON.stringify([[-100, -60], [100, -60], [100, 60], [-100, 60]]),
  "vertices round-trip EXACTLY through get-shape-path",
);
assert(
  JSON.stringify(path0?.value?.outTangents) === JSON.stringify([[30, 0], [30, 0], [-30, 0], [-30, 0]]),
  "outTangents round-trip EXACTLY (shape paths are full precision, unlike mask paths)",
);
assert(path0?.value?.closed === true, "closed flag round-trips");
// get-shape-path must also expose the non-path items, so a caller can see the fill.
const items = readBack.parsed?.groups?.[0]?.items ?? [];
assert(
  items.some((i) => i.matchName === "ADBE Vector Graphic - Fill"),
  "group items list includes the Fill, so structure is discoverable",
);

// ==================== the four generators ====================
const genCases = [
  { name: "GenRoundRect", generator: { type: "roundedRect", width: 200, height: 120, radius: 30 }, expect: 8 },
  { name: "GenEllipse", generator: { type: "ellipse", width: 160, height: 160 }, expect: 4 },
  { name: "GenPolygon", generator: { type: "polygon", points: 6, radius: 80 }, expect: 6 },
  { name: "GenStar", generator: { type: "star", points: 5, outerRadius: 90, innerRadius: 35 }, expect: 10 },
];
for (const g of genCases) {
  const r = await call("set-shape-path", {
    compName: "ShapeTest",
    createLayer: true,
    layerName: g.name,
    generator: g.generator,
    fillColor: [0.2, 0.6, 1],
  }, { quiet: true });
  assert(
    r.parsed?.status === "success" && r.parsed?.path?.numVertices === g.expect,
    `generator ${g.generator.type} produced ${g.expect} vertices (got ${r.parsed?.path?.numVertices})`,
  );
}

// The rounded rect must actually be curved: its corner handles are non-zero.
const rr = await call("get-shape-path", { compName: "ShapeTest", layerName: "GenRoundRect" }, { quiet: true });
const rrOut = rr.parsed?.groups?.[0]?.paths?.[0]?.value?.outTangents ?? [];
assert(
  rrOut.some((t) => Math.abs(t[0]) > 0.01 || Math.abs(t[1]) > 0.01),
  "roundedRect corner handles survive the trip to AE (it is genuinely rounded, not a polygon)",
);
// Ellipse handles should be radius * KAPPA = 80 * 0.5522847... = 44.18
const el = await call("get-shape-path", { compName: "ShapeTest", layerName: "GenEllipse" }, { quiet: true });
const elOut = el.parsed?.groups?.[0]?.paths?.[0]?.value?.outTangents?.[0];
assert(close(elOut?.[0], 80 * 0.5522847498307936, 0.01), `ellipse handle is radius*KAPPA (got ${elOut?.[0]})`);

// ==================== default fill when neither fill nor stroke ====================
const bare = await call("set-shape-path", {
  compName: "ShapeTest",
  createLayer: true,
  layerName: "BarePath",
  generator: { type: "polygon", points: 3, radius: 50 },
});
assert(bare.parsed?.addedDefaultFill === true, "a default fill is added when neither fillColor nor strokeColor is given");
assert(
  (bare.parsed?.notes ?? []).some((n) => /renders nothing/.test(n)),
  "the response explains why the default fill was added",
);

// ==================== path morph (3 matching keyframes) ====================
const morph = await call("set-shape-path", {
  compName: "ShapeTest",
  createLayer: true,
  layerName: "MorphPath",
  strokeColor: [1, 1, 0],
  strokeWidth: 6,
  // All three keyframes resolve to 10 vertices (a 10-gon and a 5-point star,
  // which has points*2 = 10 vertices) - assertMorphCompatible requires that.
  keyframes: [
    { time: 0, generator: { type: "polygon", points: 10, radius: 40 } },
    { time: 1, generator: { type: "polygon", points: 10, radius: 100 } },
    { time: 2, generator: { type: "star", points: 5, outerRadius: 100, innerRadius: 40 } },
  ],
});
assert(morph.parsed?.status === "success", "3-keyframe path morph succeeded");
assert(morph.parsed?.numKeys === 3, `path property has 3 keyframes (got ${morph.parsed?.numKeys})`);
assert(morph.parsed?.isTimeVarying === true, "path property is time-varying after the morph");
assert(
  (morph.parsed?.keyframeResults ?? []).every((k) => k.status === "success"),
  "every morph keyframe reported success",
);

const morphRead = await call("get-shape-path", { compName: "ShapeTest", layerName: "MorphPath" }, { quiet: true });
const morphKeys = morphRead.parsed?.groups?.[0]?.paths?.[0]?.keys ?? [];
assert(morphKeys.length === 3, `get-shape-path returns all 3 keys (got ${morphKeys.length})`);
assert(
  morphKeys.every((k) => k.numVertices === 10),
  "all morph keys have 10 vertices - the 5-point polygon was NOT silently left at 5",
);

// ==================== mismatched morph is rejected CLIENT-side ====================
const badMorph = await call("set-shape-path", {
  compName: "ShapeTest",
  createLayer: true,
  layerName: "BadMorph",
  keyframes: [
    { time: 0, generator: { type: "polygon", points: 4, radius: 50 } },
    { time: 1, generator: { type: "polygon", points: 7, radius: 50 } },
  ],
});
assert(badMorph.isError === true, "mismatched-vertex-count morph is rejected, not silently torn by AE");
assert(
  /same vertex count/.test(badMorph.text),
  "the rejection explains the vertex-count requirement",
);

// ==================== bad tangent lengths rejected CLIENT-side ====================
const badTangents = await call("set-shape-path", {
  compName: "ShapeTest",
  createLayer: true,
  layerName: "BadTangents",
  vertices: [[0, 0], [50, 0], [50, 50]],
  inTangents: [[0, 0], [0, 0]],
});
assert(badTangents.isError === true, "tangent/vertex length mismatch is rejected (AE would zero-fill it silently)");
assert(/inTangents has 2 entries but there are 3 vertices/.test(badTangents.text), "the rejection names the exact mismatch");

// ==================== targeting an existing path (groupIndex/pathIndex) ====================
const overwrite = await call("set-shape-path", {
  compName: "ShapeTest",
  layerName: "RawPath",
  groupIndex: 1,
  pathIndex: 1,
  generator: { type: "ellipse", width: 120, height: 120 },
});
assert(overwrite.parsed?.status === "success", "overwriting an existing path by group/path index succeeded");
assert(
  overwrite.parsed?.createdGroup === false && overwrite.parsed?.createdPath === false,
  "no new group or path was appended when indices were supplied",
);
assert(overwrite.parsed?.path?.numVertices === 4, "the existing path now holds the ellipse's 4 vertices");

// ==================== pointing pathIndex at a non-path errors cleanly ====================
const fillIdx = (readBack.parsed?.groups?.[0]?.items ?? []).find(
  (i) => i.matchName === "ADBE Vector Graphic - Fill",
)?.index;
const wrongTarget = await call("set-shape-path", {
  compName: "ShapeTest",
  layerName: "RawPath",
  groupIndex: 1,
  pathIndex: fillIdx,
  generator: { type: "polygon", points: 3, radius: 20 },
});
assert(
  wrongTarget.parsed?.status === "error" && /not a freeform path/.test(wrongTarget.parsed?.message ?? ""),
  "pointing pathIndex at a Fill returns a clear error instead of a crash",
);

// ==================== non-shape layer is refused ====================
await call("create-text-layer", { compName: "ShapeTest", text: "NotAShape" }, { quiet: true });
const onText = await call("set-shape-path", {
  compName: "ShapeTest",
  layerName: "NotAShape",
  generator: { type: "polygon", points: 3, radius: 20 },
});
assert(
  onText.parsed?.status === "error" && /not a shape layer/.test(onText.parsed?.message ?? ""),
  "set-shape-path on a text layer errors and points at set-layer-mask",
);

// ==================== set-layer-mask: BACKWARD COMPATIBILITY ====================
// createSolidLayer has no dedicated tool; it's reachable only via run-script.
await call("run-script", { script: "createSolidLayer", parameters: { compName: "ShapeTest", name: "MaskTarget", color: [1, 1, 1] } }, { quiet: true });
const oldStyle = await call("set-layer-mask", {
  compName: "ShapeTest",
  layerName: "MaskTarget",
  maskPath: [[50, 50], [200, 50], [200, 200], [50, 200]],
  maskMode: "add",
});
assert(oldStyle.parsed?.status === "success", "set-layer-mask still works with the pre-existing arg set");
assert(oldStyle.parsed?.mask?.mode === "add", "mask mode still applied");

// ==================== set-layer-mask: curved mask via tangents ====================
const curved = await call("set-layer-mask", {
  compName: "ShapeTest",
  layerName: "MaskTarget",
  maskPath: [[100, 100], [300, 100], [300, 250], [100, 250]],
  maskInTangents: [[0, 0], [-40, 0], [0, -40], [40, 0]],
  maskOutTangents: [[40, 0], [0, 40], [-40, 0], [0, -40]],
  maskMode: "add",
});
assert(curved.parsed?.status === "success", "set-layer-mask accepts inTangents/outTangents (curved masks)");

// ==================== set-layer-mask: open path + keyframed mask ====================
const openMask = await call("set-layer-mask", {
  compName: "ShapeTest",
  layerName: "MaskTarget",
  maskIndex: 1,
  maskPath: [[20, 20], [120, 90], [220, 20]],
  maskClosed: false,
});
assert(openMask.parsed?.status === "success", "set-layer-mask accepts maskClosed:false (open path)");

const maskKey = await call("set-layer-mask", {
  compName: "ShapeTest",
  layerName: "MaskTarget",
  maskIndex: 1,
  maskPath: [[40, 40], [260, 40], [260, 300], [40, 300]],
  time: 1.5,
});
assert(maskKey.parsed?.status === "success", "set-layer-mask writes a mask-shape KEYFRAME when time is given");
assert(
  (maskKey.parsed?.mask?.changedProperties ?? []).includes("maskPathKeyframe"),
  "the response reports that a keyframe (not a static value) was written",
);

// ==================== visual confirmation ====================
// A path that round-trips numerically can still render wrong.
await call("see-frame", { compName: "ShapeTest", times: [0] }, { quiet: true });
console.log("see-frame rendered - inspect the image to confirm the shapes actually draw.");

// ==================== Restore the real project ====================
await call("close-project", { saveFirst: false });
const reopen = await call("open-project", { filePath: originalPath, saveFirst: false });
assert(reopen.parsed?.status === "success", "real project reopened");
const compCheck = await call("inspect-comp", { compName: "Comp 1" }, { quiet: true });
assert(compCheck.parsed?.comp?.numLayers === 3, `restored 'Comp 1' still has its 3 original layers (got ${compCheck.parsed?.comp?.numLayers})`);

console.log(`\n=== DONE: ${failures === 0 ? "ALL ASSERTIONS PASSED" : failures + " FAILED"} ===`);
await client.close();
process.exit(failures === 0 ? 0 : 1);
