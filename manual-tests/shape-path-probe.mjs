/*
 * Phase 0 feasibility probe for shape-layer bezier path authoring (GAPS.md #1).
 *
 * Answers P1-P10 from the plan against a LIVE After Effects, using the existing
 * `execute-script` tool only - no bridge changes, no rebuild, no panel reopen.
 * This mirrors the discipline that caught the layer-styles block (GAPS.md #3):
 * prove the AE scripting API actually supports the write path BEFORE building a
 * tool around it.
 *
 * Follows the mandated project-safety flow: save + close the real project, do
 * everything in a scratch project, then reopen the real one and assert it is
 * unchanged.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  cwd: "C:\\Users\\renat\\after-effects-mcp-a-y-ibrahim",
  stderr: "pipe",
});

const client = new Client({ name: "shape-path-probe", version: "1.0.0" });
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
  try { parsed = JSON.parse(text); } catch {}
  return { res, parsed, text };
}

// `create-composition` does NOT make the new comp the active item - verified
// live: every probe using app.project.activeItem failed with "null is not an
// object". Resolve by name instead, the same way _resolveComp does bridge-side.
const PRELUDE = `
function _probeComp() {
  for (var _i = 1; _i <= app.project.numItems; _i++) {
    var _it = app.project.item(_i);
    if (_it instanceof CompItem && _it.name === "ShapeProbe") return _it;
  }
  throw new Error("ShapeProbe comp not found");
}
`;

// execute-script returns {status:"success", result: <returned value>}
async function probe(label, script) {
  const { parsed } = await call("execute-script", { script: PRELUDE + script });
  if (parsed?.status !== "success") {
    console.log(`!!! ${label}: execute-script itself failed`);
    failures++;
    findings[label] = { error: parsed?.error ?? "unknown" };
    return null;
  }
  findings[label] = parsed.result;
  return parsed.result;
}

function assert(cond, msg) {
  if (!cond) { console.log(`!!! FAILED: ${msg}`); failures++; }
  else console.log(`OK: ${msg}`);
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
  name: "ShapeProbe", width: 640, height: 360, frameRate: 30, duration: 5,
});

// =====================================================================
// P1 - Is the freeform path group addable, and is its Path property real?
// =====================================================================
const p1 = await probe("P1", `
var comp = _probeComp();
var layer = comp.layers.addShape();
layer.name = "P1_Layer";
var contents = layer.property("ADBE Root Vectors Group");
var out = { contentsFound: !!contents };
var group = contents.addProperty("ADBE Vector Group");
out.groupAdded = !!group;
out.groupMatchName = group.matchName;
var gc = group.property("ADBE Vectors Group");
out.groupContentsFound = !!gc;
var pathGroup = gc.addProperty("ADBE Vector Shape - Group");
out.pathGroupAdded = !!pathGroup;
out.pathGroupMatchName = pathGroup.matchName;
out.pathGroupName = pathGroup.name;
var pathProp = pathGroup.property("ADBE Vector Shape");
out.pathPropFound = !!pathProp;
if (pathProp) {
  out.pathPropName = pathProp.name;
  out.pathPropMatchName = pathProp.matchName;
  out.propertyValueType = pathProp.propertyValueType;
  out.isShapeValueType = (pathProp.propertyValueType === PropertyValueType.SHAPE);
  out.canVaryOverTime = pathProp.canVaryOverTime;
  out.canSetExpression = pathProp.canSetExpression;
  out.isModified = pathProp.isModified;
  // The layer-styles blocker signature - check for it explicitly.
  try { out.canSetEnabled = pathGroup.canSetEnabled; } catch (e) { out.canSetEnabled = "n/a: " + e.toString(); }
}
return out;
`);
assert(p1?.pathGroupAdded === true, "P1: 'ADBE Vector Shape - Group' can be added");
assert(p1?.pathPropFound === true, "P1: 'ADBE Vector Shape' Path property exists on it");
assert(p1?.isShapeValueType === true, "P1: Path property is PropertyValueType.SHAPE");
assert(p1?.canVaryOverTime === true, "P1: Path property canVaryOverTime (keyframing possible in principle)");

// =====================================================================
// P2 - Do vertices AND tangents round-trip through setValue?
// =====================================================================
const p2 = await probe("P2", `
var comp = _probeComp();
var layer = comp.layer("P1_Layer");
var pathProp = layer.property("ADBE Root Vectors Group").property(1)
  .property("ADBE Vectors Group").property(1).property("ADBE Vector Shape");
var s = new Shape();
s.vertices    = [[0,0], [100,0], [100,100], [0,100]];
s.inTangents  = [[0,0], [-25,0], [0,-25], [25,0]];
s.outTangents = [[25,0], [0,25], [-25,0], [0,-25]];
s.closed = true;
pathProp.setValue(s);
var v = pathProp.value;
return {
  vertices: v.vertices,
  inTangents: v.inTangents,
  outTangents: v.outTangents,
  closed: v.closed,
  numVertices: v.vertices.length,
  numIn: v.inTangents.length,
  numOut: v.outTangents.length
};
`);
assert(p2?.numVertices === 4, "P2: 4 vertices round-tripped");
assert(
  JSON.stringify(p2?.outTangents) === JSON.stringify([[25,0],[0,25],[-25,0],[0,-25]]),
  "P2: outTangents round-trip EXACTLY as written (not dropped, not transformed)",
);
assert(p2?.closed === true, "P2: closed flag round-tripped");

// =====================================================================
// P3 - Relative or absolute tangents? Vertex far from origin + one handle.
// =====================================================================
const p3 = await probe("P3", `
var comp = _probeComp();
var layer = comp.layers.addShape();
layer.name = "P3_Layer";
var gc = layer.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group")
  .property("ADBE Vectors Group");
var pathProp = gc.addProperty("ADBE Vector Shape - Group").property("ADBE Vector Shape");
var s = new Shape();
// Vertex deliberately far from the origin: if AE stored tangents in absolute
// coords it would have to rewrite [50,0] into something near [250,200].
s.vertices    = [[200,200], [300,200]];
s.inTangents  = [[0,0], [0,0]];
s.outTangents = [[50,0], [0,0]];
s.closed = false;
pathProp.setValue(s);
var v = pathProp.value;
var fill = gc.addProperty("ADBE Vector Graphic - Stroke");
fill.property("ADBE Vector Stroke Color").setValue([1,1,0]);
fill.property("ADBE Vector Stroke Width").setValue(6);
return {
  writtenOutTangent0: [50,0],
  readBackOutTangent0: v.outTangents[0],
  readBackVertex0: v.vertices[0],
  interpretation: (v.outTangents[0][0] === 50 && v.outTangents[0][1] === 0)
    ? "RELATIVE (stored verbatim relative to its vertex)"
    : "NOT verbatim - inspect readBackOutTangent0",
  closedRoundTrip: v.closed
};
`);
assert(
  JSON.stringify(p3?.readBackOutTangent0) === JSON.stringify([50, 0]),
  `P3: tangents are RELATIVE to their vertex (read back ${JSON.stringify(p3?.readBackOutTangent0)})`,
);
assert(p3?.closedRoundTrip === false, "P3: closed:false round-trips (open paths supported)");

// =====================================================================
// P4 - What does AE do with mismatched array lengths?
// =====================================================================
const p4 = await probe("P4", `
var comp = _probeComp();
var layer = comp.layer("P1_Layer");
var pathProp = layer.property("ADBE Root Vectors Group").property(1)
  .property("ADBE Vectors Group").property(1).property("ADBE Vector Shape");
var out = {};
try {
  var s = new Shape();
  s.vertices    = [[0,0],[10,0],[10,10]];
  s.inTangents  = [[0,0],[0,0]];            // deliberately 1 short
  s.outTangents = [[0,0],[0,0],[0,0]];
  s.closed = true;
  pathProp.setValue(s);
  var v = pathProp.value;
  out.threw = false;
  out.resultVertices = v.vertices;
  out.resultIn = v.inTangents;
  out.note = "AE ACCEPTED a mismatched Shape - silent coercion, so validation MUST be client-side";
} catch (e) {
  out.threw = true;
  out.error = e.toString();
  out.note = "AE rejected it; error text above is what a caller would otherwise see";
}
return out;
`);
console.log(`P4 finding: threw=${p4?.threw} :: ${p4?.error ?? p4?.note}`);

// =====================================================================
// P5 - Keyframing: setValueAtTime, then MISMATCHED vertex counts across keys
// =====================================================================
const p5 = await probe("P5", `
var comp = _probeComp();
var layer = comp.layers.addShape();
layer.name = "P5_Layer";
var gc = layer.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group")
  .property("ADBE Vectors Group");
var pathGroup = gc.addProperty("ADBE Vector Shape - Group");
var staleRef = pathGroup.property("ADBE Vector Shape");
var fill = gc.addProperty("ADBE Vector Graphic - Fill");
fill.property("ADBE Vector Fill Color").setValue([0,0.6,1]);

// P5-pre: does adding a sibling (Fill) to the same group INVALIDATE a Path
// reference grabbed beforehand? First run of this probe died here with
// "ReferenceError: Object is invalid", so pin the cause down explicitly
// instead of assuming.
var invalidation = {};
try {
  var probeVal = staleRef.value;
  invalidation.staleRefStillUsable = true;
} catch (eStale) {
  invalidation.staleRefStillUsable = false;
  invalidation.staleRefError = eStale.toString();
}
// Re-resolve after the mutation - this is the pattern the tool must use.
var pathProp = gc.property(1).property("ADBE Vector Shape");
try {
  var v2 = pathProp.value;
  invalidation.reResolvedUsable = true;
} catch (eFresh) {
  invalidation.reResolvedUsable = false;
  invalidation.reResolvedError = eFresh.toString();
}

function sq(scale) {
  var s = new Shape();
  s.vertices = [[-50*scale,-50*scale],[50*scale,-50*scale],[50*scale,50*scale],[-50*scale,50*scale]];
  s.inTangents  = [[0,0],[0,0],[0,0],[0,0]];
  s.outTangents = [[0,0],[0,0],[0,0],[0,0]];
  s.closed = true;
  return s;
}
var out = { invalidation: invalidation };
pathProp.setValueAtTime(0, sq(1));
pathProp.setValueAtTime(1, sq(2));
out.numKeysAfterMatched = pathProp.numKeys;
out.isTimeVarying = pathProp.isTimeVarying;
out.key1Vertices = pathProp.keyValue(1).vertices;
out.key2Vertices = pathProp.keyValue(2).vertices;

// Now a THIRD key with a different vertex count (5, not 4).
try {
  var tri = new Shape();
  tri.vertices    = [[0,-60],[60,-20],[40,50],[-40,50],[-60,-20]];
  tri.inTangents  = [[0,0],[0,0],[0,0],[0,0],[0,0]];
  tri.outTangents = [[0,0],[0,0],[0,0],[0,0],[0,0]];
  tri.closed = true;
  pathProp.setValueAtTime(2, tri);
  out.mismatchThrew = false;
  out.numKeysAfterMismatch = pathProp.numKeys;
  out.key3VertexCount = pathProp.keyValue(3).vertices.length;
  out.key1VertexCountAfter = pathProp.keyValue(1).vertices.length;
  out.mismatchNote = "AE ACCEPTED differing vertex counts across keys";
} catch (e) {
  out.mismatchThrew = true;
  out.mismatchError = e.toString();
}
return out;
`);
assert(p5?.numKeysAfterMatched === 2, `P5: setValueAtTime created 2 path keyframes (got ${p5?.numKeysAfterMatched})`);
assert(p5?.isTimeVarying === true, "P5: Path property reports isTimeVarying - path morphs are animatable");
console.log(`P5 mismatch finding: threw=${p5?.mismatchThrew} :: ${p5?.mismatchError ?? p5?.mismatchNote}`);

// =====================================================================
// P6 - Coordinate space: where does vertex [0,0] actually land?
// =====================================================================
const p6 = await probe("P6", `
var comp = _probeComp();
var layer = comp.layers.addShape();
layer.name = "P6_Layer";
var tg = layer.property("ADBE Transform Group");
var out = {
  compSize: [comp.width, comp.height],
  defaultAnchorPoint: tg.property("ADBE Anchor Point").value,
  defaultPosition: tg.property("ADBE Position").value
};
var gc = layer.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group")
  .property("ADBE Vectors Group");
var pathProp = gc.addProperty("ADBE Vector Shape - Group").property("ADBE Vector Shape");
// A small square whose TOP-LEFT corner sits exactly on the path origin [0,0].
var s = new Shape();
s.vertices    = [[0,0],[80,0],[80,80],[0,80]];
s.inTangents  = [[0,0],[0,0],[0,0],[0,0]];
s.outTangents = [[0,0],[0,0],[0,0],[0,0]];
s.closed = true;
pathProp.setValue(s);
var fill = gc.addProperty("ADBE Vector Graphic - Fill");
fill.property("ADBE Vector Fill Color").setValue([1,0,0]);
// Hide the other probe layers so the render is unambiguous.
for (var i = 1; i <= comp.numLayers; i++) {
  if (comp.layer(i).name !== "P6_Layer") { comp.layer(i).enabled = false; }
}
out.note = "Red 80x80 square drawn with its top-left vertex at path coords [0,0]";
return out;
`);
console.log(`P6: comp ${JSON.stringify(p6?.compSize)}, default anchor ${JSON.stringify(p6?.defaultAnchorPoint)}, default position ${JSON.stringify(p6?.defaultPosition)}`);

// Visual: a numeric round-trip can still render wrong. Look at the actual frame.
await call("see-frame", { compName: "ShapeProbe", times: [0] }, { quiet: true });
console.log("P6: see-frame rendered - inspect the image to locate path origin [0,0] on screen.");

// =====================================================================
// P7 - Does a parametric shape (Rect) expose a writable Path property?
// =====================================================================
const p7 = await probe("P7", `
var comp = _probeComp();
var layer = comp.layers.addShape();
layer.name = "P7_Layer";
var gc = layer.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group")
  .property("ADBE Vectors Group");
var rect = gc.addProperty("ADBE Vector Shape - Rect");
var out = { rectMatchName: rect.matchName, childCount: rect.numProperties, children: [] };
for (var i = 1; i <= rect.numProperties; i++) {
  out.children.push({ name: rect.property(i).name, matchName: rect.property(i).matchName });
}
var maybePath = null;
try { maybePath = rect.property("ADBE Vector Shape"); } catch (e) { maybePath = null; }
out.parametricHasPathProp = !!maybePath;
out.conclusion = maybePath
  ? "Rect exposes a Path property - in-place conversion may be possible"
  : "Rect has NO Path property - a freeform path needs its own 'ADBE Vector Shape - Group'";
return out;
`);
assert(
  p7?.parametricHasPathProp === false,
  `P7: parametric Rect has no 'ADBE Vector Shape' (${p7?.conclusion})`,
);

// =====================================================================
// P8 / P9 - Mask paths: do they accept tangents, and can they be keyframed?
// =====================================================================
const p89 = await probe("P8_P9", `
var comp = _probeComp();
var solid = comp.layers.addSolid([1,1,1], "MaskProbe", comp.width, comp.height, 1);
var masks = solid.property("ADBE Mask Parade");
var mask = masks.addProperty("ADBE Mask Atom");
var pathProp = mask.property("ADBE Mask Shape");
var out = {};

// P8: tangents on a mask path
var s = new Shape();
s.vertices    = [[100,100],[300,100],[300,250],[100,250]];
s.inTangents  = [[0,0],[-40,0],[0,-40],[40,0]];
s.outTangents = [[40,0],[0,40],[-40,0],[0,-40]];
s.closed = true;
pathProp.setValue(s);
var v = pathProp.value;
// Mask paths store at lower precision than shape paths: 40 comes back as
// 39.9999847412109. Compare with an epsilon, and record the max drift - shape
// paths (P2) round-trip EXACTLY, masks do not.
var expected = [[40,0],[0,40],[-40,0],[0,-40]];
var maxDrift = 0;
for (var mi = 0; mi < expected.length; mi++) {
  for (var mj = 0; mj < 2; mj++) {
    var d = Math.abs(v.outTangents[mi][mj] - expected[mi][mj]);
    if (d > maxDrift) maxDrift = d;
  }
}
out.maskTangentMaxDrift = maxDrift;
out.maskTangentsRoundTrip = (maxDrift < 0.001);
out.maskOutTangentsReadBack = v.outTangents;

// Also: does a mask accept an OPEN path? (setLayerMask hardcodes closed=true)
try {
  var o = new Shape();
  o.vertices = [[10,10],[50,50],[90,10]];
  o.inTangents = [[0,0],[0,0],[0,0]];
  o.outTangents = [[0,0],[0,0],[0,0]];
  o.closed = false;
  pathProp.setValue(o);
  out.maskOpenPathClosedReadBack = pathProp.value.closed;
  out.maskAcceptsOpenPath = true;
} catch (e) {
  out.maskAcceptsOpenPath = false;
  out.maskOpenPathError = e.toString();
}

// P9: keyframing a mask path
try {
  pathProp.setValueAtTime(0, s);
  var s2 = new Shape();
  s2.vertices    = [[50,50],[350,50],[350,300],[50,300]];
  s2.inTangents  = [[0,0],[0,0],[0,0],[0,0]];
  s2.outTangents = [[0,0],[0,0],[0,0],[0,0]];
  s2.closed = true;
  pathProp.setValueAtTime(1, s2);
  out.maskNumKeys = pathProp.numKeys;
  out.maskIsTimeVarying = pathProp.isTimeVarying;
  out.maskKeyframable = true;
} catch (e) {
  out.maskKeyframable = false;
  out.maskKeyframeError = e.toString();
}
return out;
`);
assert(
  p89?.maskTangentsRoundTrip === true,
  `P8: mask paths accept and round-trip tangents within epsilon (max drift ${p89?.maskTangentMaxDrift}) - curved masks are buildable`,
);
assert(p89?.maskKeyframable === true && p89?.maskNumKeys === 2, `P9: mask paths are keyframable (numKeys=${p89?.maskNumKeys})`);
console.log(`P8 extra: mask accepts open path = ${p89?.maskAcceptsOpenPath}, closed read back = ${p89?.maskOpenPathClosedReadBack}`);

// =====================================================================
// P10 - Does a path group with no Fill/Stroke render anything?
// =====================================================================
const p10 = await probe("P10", `
var comp = _probeComp();
for (var i = 1; i <= comp.numLayers; i++) { comp.layer(i).enabled = false; }
var layer = comp.layers.addShape();
layer.name = "P10_Layer";
var gc = layer.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group")
  .property("ADBE Vectors Group");
var pathProp = gc.addProperty("ADBE Vector Shape - Group").property("ADBE Vector Shape");
var s = new Shape();
s.vertices    = [[-100,-80],[100,-80],[100,80],[-100,80]];
s.inTangents  = [[0,0],[0,0],[0,0],[0,0]];
s.outTangents = [[0,0],[0,0],[0,0],[0,0]];
s.closed = true;
pathProp.setValue(s);
return { note: "Path group with NO fill and NO stroke; all other layers disabled", groupChildren: gc.numProperties };
`);
await call("see-frame", { compName: "ShapeProbe", times: [0] }, { quiet: true });
console.log("P10a: see-frame with a bare path (no fill/stroke) - expect an EMPTY frame if fill is required.");

await probe("P10_withFill", `
var comp = _probeComp();
var layer = comp.layer("P10_Layer");
var gc = layer.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group");
var fill = gc.addProperty("ADBE Vector Graphic - Fill");
fill.property("ADBE Vector Fill Color").setValue([0,1,0]);
return { note: "Green fill added to the same group", groupChildren: gc.numProperties };
`);
await call("see-frame", { compName: "ShapeProbe", times: [0] }, { quiet: true });
console.log("P10b: see-frame after adding a Fill - expect a green rectangle.");

// ---- Restore the real project ----
await call("close-project", { saveFirst: false });
const reopen = await call("open-project", { filePath: originalPath, saveFirst: false });
assert(reopen.parsed?.status === "success", "real project reopened");

console.log("\n\n================ PROBE FINDINGS (JSON) ================");
console.log(JSON.stringify(findings, null, 2));
console.log("\n=== GATE: P1 (addable+writable), P2 (tangents round-trip), P5 (keyframable) must all pass ===");
console.log(`=== DONE: ${failures === 0 ? "ALL ASSERTIONS PASSED" : failures + " FAILED"} ===`);
await client.close();
process.exit(failures === 0 ? 0 : 1);
