import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  cwd: "C:\\Users\\renat\\after-effects-mcp-a-y-ibrahim",
  stderr: "pipe",
});

const client = new Client({ name: "time-remap-test", version: "1.0.0" });
await client.connect(transport);
transport.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));

let stepNum = 0;
let failures = 0;
async function call(name, args = {}) {
  stepNum++;
  console.log(`\n=== STEP ${stepNum}: ${name} ${JSON.stringify(args)} ===`);
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? JSON.stringify(res);
  console.log(String(text).slice(0, 900));
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  return { res, parsed, text };
}
function assert(cond, msg) {
  if (!cond) { console.log(`!!! FAILED: ${msg}`); failures++; }
  else console.log(`OK: ${msg}`);
}
function findKeyNear(keys, time, epsilon = 0.05) {
  return (keys || []).find((k) => Math.abs(k.time - time) <= epsilon);
}

// ---- Save + close real project ----
const info0 = await call("run-script", { script: "getProjectInfo" });
const originalPath = info0.parsed?.path;
assert(!!originalPath, "original project path captured");
await call("save-project", {});
await call("close-project", { saveFirst: false });

// ---- Set up scratch project ----
await call("create-project", { saveFirst: false });
await call("create-composition", { name: "TrxOuter", width: 640, height: 360, frameRate: 30, duration: 8 });

// A text layer with a wiggle expression gives the precomp genuine
// time-varying content - a plain solid/text layer alone has none, and
// time remap needs real source motion to be meaningfully testable.
await call("create-text-layer", { compName: "TrxOuter", text: "Wiggler" });
const batchExpr = await call("batch-set-expression", {
  compName: "TrxOuter",
  propertyName: "Position",
  expressionString: "wiggle(2,20)",
  targets: [{ layerName: "Wiggler" }],
});
assert(batchExpr.parsed?.successCount === 1, "wiggle expression applied to Wiggler layer");

// ==================== precompose to get a real AV layer with a time-based source ====================
const precomp = await call("precompose-layers", {
  compName: "TrxOuter",
  layerIndices: [1],
  name: "TrxInner",
});
assert(precomp.parsed?.status === "success", "precompose-layers succeeded");
const precompLayerName = precomp.parsed?.precomposedLayer?.name;
assert(!!precompLayerName, `precomposed layer name captured (${precompLayerName})`);

// ==================== set-time-remap: default enable (no keyframes) ====================
const enableDefault = await call("set-time-remap", {
  compName: "TrxOuter",
  layerName: precompLayerName,
});
assert(enableDefault.parsed?.status === "success", "set-time-remap (default enable) returned success");
assert(enableDefault.parsed?.timeRemapEnabled === true, "timeRemapEnabled is true after enabling");
assert(enableDefault.parsed?.numKeys === 2, `AE auto-created 2 default keyframes (numKeys=${enableDefault.parsed?.numKeys})`);

// ==================== set-time-remap: freeze frame (equal values) ====================
const freeze = await call("set-time-remap", {
  compName: "TrxOuter",
  layerName: precompLayerName,
  keyframes: [
    { time: 1, value: 0.5 },
    { time: 3, value: 0.5 },
  ],
});
assert(freeze.parsed?.status === "success", "set-time-remap (freeze frame) returned success");
assert(
  (freeze.parsed?.keyframeResults || []).every((r) => r.status === "success"),
  "both freeze-frame keyframes reported success",
);
const freezeKeyA = findKeyNear(freeze.parsed?.keys, 1);
const freezeKeyB = findKeyNear(freeze.parsed?.keys, 3);
assert(freezeKeyA?.value === 0.5 && freezeKeyB?.value === 0.5, "freeze-frame keys round-trip with value 0.5 at both t=1 and t=3");

// ==================== set-time-remap: speed ramp (differing values) ====================
const ramp = await call("set-time-remap", {
  compName: "TrxOuter",
  layerName: precompLayerName,
  keyframes: [
    { time: 4, value: 1 },
    { time: 5, value: 3 },
  ],
});
assert(ramp.parsed?.status === "success", "set-time-remap (speed ramp) returned success");
assert(
  (ramp.parsed?.keyframeResults || []).every((r) => r.status === "success"),
  "both speed-ramp keyframes reported success",
);
const rampKeyA = findKeyNear(ramp.parsed?.keys, 4);
const rampKeyB = findKeyNear(ramp.parsed?.keys, 5);
assert(rampKeyA?.value === 1 && rampKeyB?.value === 3, "speed-ramp keys round-trip with distinct values (1 and 3)");

// ==================== set-time-remap: negative-time keyframe robustness ====================
// Discovered live (not assumed): unlike the generic _rebuildKeyframesAtNewTimes
// path elsewhere in this codebase (which deliberately skips negative newTime
// values as a design choice, not an AE restriction), Time Remap's own
// setValueAtTime does NOT reject a negative `time` - AE happily inserts the
// keyframe before the layer's nominal start. This confirms the per-keyframe
// try/catch doesn't accidentally swallow good input, and documents the real
// (permissive) behavior for CONTEXT.md rather than an assumed one.
const negativeTime = await call("set-time-remap", {
  compName: "TrxOuter",
  layerName: precompLayerName,
  keyframes: [
    { time: 6, value: 1.5 },
    { time: -5, value: 0 },
  ],
});
assert(negativeTime.parsed?.status === "success", "set-time-remap (mixed batch) still returns top-level success, not a crash");
const goodKf = negativeTime.parsed?.keyframeResults?.find((r) => r.time === 6);
const negKf = negativeTime.parsed?.keyframeResults?.find((r) => r.time === -5);
assert(goodKf?.status === "success", "valid keyframe (t=6) succeeded");
assert(negKf?.status === "success", "negative-time keyframe (t=-5) also succeeded - AE's Time Remap accepts it rather than throwing (a real finding, not a bug)");

// ==================== set-time-remap: disable then re-enable resets keyframes ====================
const disable = await call("set-time-remap", {
  compName: "TrxOuter",
  layerName: precompLayerName,
  enabled: false,
});
assert(disable.parsed?.status === "success" && disable.parsed?.timeRemapEnabled === false, "set-time-remap (enabled: false) disabled time remapping");

const reenable = await call("set-time-remap", {
  compName: "TrxOuter",
  layerName: precompLayerName,
});
assert(reenable.parsed?.status === "success" && reenable.parsed?.timeRemapEnabled === true, "set-time-remap re-enabled time remapping");
assert(reenable.parsed?.numKeys === 2, `re-enabling reset to a fresh default 2-keyframe state (numKeys=${reenable.parsed?.numKeys}), confirming disable actually removed prior custom keyframes`);

// ==================== Restore real project ====================
await call("close-project", { saveFirst: false });
const reopen = await call("open-project", { filePath: originalPath, saveFirst: false });
assert(reopen.parsed?.status === "success", "real project reopened");
const compCheck = await call("inspect-comp", { compName: "Comp 1" });
assert(compCheck.parsed?.comp?.numLayers === 3, "restored 'Comp 1' has all 3 original layers");

console.log(`\n=== DONE: ${failures === 0 ? "ALL ASSERTIONS PASSED" : failures + " FAILED"} ===`);
await client.close();
process.exit(failures === 0 ? 0 : 1);
