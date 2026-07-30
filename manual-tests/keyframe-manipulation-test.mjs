import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  cwd: "C:\\Users\\renat\\after-effects-mcp-a-y-ibrahim",
  stderr: "pipe",
});

const client = new Client({ name: "keyframe-manip-test", version: "1.0.0" });
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
function findByTime(keys, t) {
  return keys?.find((k) => Math.abs(k.time - t) < 0.01);
}

// ---- Save + close real project ----
const info0 = await call("run-script", { script: "getProjectInfo" });
const originalPath = info0.parsed?.path;
assert(!!originalPath, "original project path captured");
await call("save-project", {});
await call("close-project", { saveFirst: false });

// ---- Set up scratch project + two layers ----
await call("create-project", { saveFirst: false });
await call("create-composition", { name: "KfTest", width: 640, height: 360, frameRate: 30, duration: 10 });
await call("run-script", { script: "createSolidLayer", parameters: { compName: "KfTest", name: "LayerA", color: [1, 0, 0], size: [100, 100] } });
await call("run-script", { script: "createSolidLayer", parameters: { compName: "KfTest", name: "LayerB", color: [0, 1, 0], size: [100, 100] } });

// ==================== BLOCK 1: offset / scale on Position ====================
// Note: setLayerKeyframe seeds an extra keyframe at comp.time (0) on its very
// first call for a given property (existing, deliberate behavior - see
// mcp-bridge-auto.jsx setLayerKeyframe lines ~611-613) - so 3 explicit calls
// at t=1,3,5 actually produce 4 keyframes (0,1,3,5). Assertions below look up
// by time value rather than assuming fixed array positions, to be robust to
// that and to the destroy/rebuild nature of these tools.
await client.callTool({ name: "setLayerKeyframe", arguments: { compIndex: 1, layerIndex: 1, propertyName: "Position", timeInSeconds: 1, value: [100, 100] } });
await client.callTool({ name: "setLayerKeyframe", arguments: { compIndex: 1, layerIndex: 1, propertyName: "Position", timeInSeconds: 3, value: [300, 300] } });
await client.callTool({ name: "setLayerKeyframe", arguments: { compIndex: 1, layerIndex: 1, propertyName: "Position", timeInSeconds: 5, value: [500, 500] } });

const gk1 = await call("get-keyframes", { compIndex: 1, layerIndex: 1, propertyName: "Position" });
assert(gk1.parsed?.numKeys === 4, `4 keyframes present incl. the seeded t=0 one (got ${gk1.parsed?.numKeys})`);
assert(!!findByTime(gk1.parsed?.keys, 0) && !!findByTime(gk1.parsed?.keys, 1) && !!findByTime(gk1.parsed?.keys, 3) && !!findByTime(gk1.parsed?.keys, 5), "keyframes exist at 0, 1, 3, 5");

const off1 = await call("offset-keyframes", { compIndex: 1, layerIndex: 1, propertyName: "Position", offsetSeconds: 2 });
assert(off1.parsed?.keyframesMoved === 4, `offset moved all 4 keyframes (got ${off1.parsed?.keyframesMoved})`);
assert(!off1.parsed?.note, "no drop note for a purely-positive offset");
const gk2 = await call("get-keyframes", { compIndex: 1, layerIndex: 1, propertyName: "Position" });
assert(!!findByTime(gk2.parsed?.keys, 2) && !!findByTime(gk2.parsed?.keys, 3) && !!findByTime(gk2.parsed?.keys, 5) && !!findByTime(gk2.parsed?.keys, 7), "all 4 times shifted by +2 correctly (now 2,3,5,7)");

// Large negative offset: times are 2,3,5,7 -> -4 offset -> -2,-1,1,3: first two go negative and should be dropped.
const off2 = await call("offset-keyframes", { compIndex: 1, layerIndex: 1, propertyName: "Position", offsetSeconds: -4 });
assert(off2.parsed?.keyframesMoved === 2, `offset correctly reports only 2 keyframes actually moved (got ${off2.parsed?.keyframesMoved})`);
assert(!!off2.parsed?.note, "a note explains the dropped keyframes (the bug fix vs ishu86)");

const gk3 = await call("get-keyframes", { compIndex: 1, layerIndex: 1, propertyName: "Position" });
const anchor = gk3.parsed?.keys?.[0]?.time;
const secondTimeBeforeScale = gk3.parsed?.keys?.[1]?.time;
const scaleRes = await call("scale-keyframe-timing", { compIndex: 1, layerIndex: 1, propertyName: "Position", scale: 2 });
assert(scaleRes.parsed?.status === "success" && scaleRes.parsed?.keyframesScaled === 2, "scale-keyframe-timing succeeded on both remaining keyframes");
const gk4 = await call("get-keyframes", { compIndex: 1, layerIndex: 1, propertyName: "Position" });
const expectedSecond = anchor + (secondTimeBeforeScale - anchor) * 2;
assert(!!findByTime(gk4.parsed?.keys, expectedSecond), `second keyframe scaled correctly around anchor (expected time ~${expectedSecond})`);

// ==================== BLOCK 2: reverse-keyframes swap check, on a FRESH property ====================
// Uses Rotation (untouched by the offset/scale block above) so the asymmetric
// interpolation set up here can't be destroyed by an earlier negative-offset drop.
await client.callTool({ name: "setLayerKeyframe", arguments: { compIndex: 1, layerIndex: 1, propertyName: "Rotation", timeInSeconds: 1, value: 0 } });
await client.callTool({ name: "setLayerKeyframe", arguments: { compIndex: 1, layerIndex: 1, propertyName: "Rotation", timeInSeconds: 5, value: 90 } });
await call("execute-script", {
  script: `
    var prop = app.project.item(1).layers[1].property("ADBE Transform Group").property("Rotation");
    for (var i = 1; i <= prop.numKeys; i++) {
      if (Math.abs(prop.keyTime(i) - 1) < 0.01) {
        prop.setInterpolationTypeAtKey(i, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.LINEAR);
      }
    }
    return { done: true };
  `,
});
const beforeReverse = await call("get-keyframes", { compIndex: 1, layerIndex: 1, propertyName: "Rotation" });
const targetBefore = beforeReverse.parsed?.keys?.find((k) => k.inInterp === "HOLD" && k.outInterp === "LINEAR");
assert(!!targetBefore, "Rotation keyframe with HOLD-in/LINEAR-out set up correctly before reversal");

const revRes = await call("reverse-keyframes", { compIndex: 1, layerIndex: 1, propertyName: "Rotation" });
assert(revRes.parsed?.status === "success" && revRes.parsed?.keyframesReversed === beforeReverse.parsed.numKeys, "reverse-keyframes succeeded on all keyframes");
const afterReverse = await call("get-keyframes", { compIndex: 1, layerIndex: 1, propertyName: "Rotation" });
assert(afterReverse.parsed?.numKeys === beforeReverse.parsed.numKeys, "same number of keyframes after reversal");
const swapped = afterReverse.parsed?.keys?.find((k) => k.inInterp === "LINEAR" && k.outInterp === "HOLD");
assert(!!swapped, "the keyframe's interpolation was correctly swapped (LINEAR-in/HOLD-out) after reversal, not just its time");

// ==================== BLOCK 3: copy-keyframes + apply-easy-ease on LayerB ====================
const copyRes = await call("copy-keyframes", { compIndex: 1, sourceLayerIndex: 1, sourceProperty: "Rotation", targetLayerIndex: 2, targetProperty: "Rotation", timeOffset: 1 });
assert(copyRes.parsed?.keysCopied === afterReverse.parsed.numKeys, `copy-keyframes copied all ${afterReverse.parsed.numKeys} keyframes`);
const gkB = await call("get-keyframes", { compIndex: 1, layerIndex: 2, propertyName: "Rotation" });
assert(gkB.parsed?.numKeys === afterReverse.parsed.numKeys, "target layer now has the copied keyframes");
const sourceFirstTime = afterReverse.parsed.keys[0].time;
assert(!!findByTime(gkB.parsed?.keys, sourceFirstTime + 1), "copied keyframe time includes the +1 timeOffset");

const easeRes = await call("apply-easy-ease", { compIndex: 1, layerIndex: 2, propertyName: "Rotation" });
assert(easeRes.parsed?.status === "success", "apply-easy-ease succeeded (no more dimension-mismatch crash)");
assert(easeRes.parsed?.keyframesEased === gkB.parsed.numKeys, `easy-ease applied to all ${gkB.parsed.numKeys} keyframes (omitted keyframeIndex)`);
const gkEased = await call("get-keyframes", { compIndex: 1, layerIndex: 2, propertyName: "Rotation" });
const allEased = gkEased.parsed?.keys?.every((k) => k.inEase?.speed === 0 && Math.abs(k.inEase?.influence - 33.33) < 0.01 && k.outEase?.speed === 0 && Math.abs(k.outEase?.influence - 33.33) < 0.01);
assert(allEased, "every keyframe now has speed:0, influence:~33.33 ease on both sides (AE's real Easy Ease default)");

// ==================== Restore real project ====================
await call("close-project", { saveFirst: false });
const reopen = await call("open-project", { filePath: originalPath, saveFirst: false });
assert(reopen.parsed?.status === "success", "real project reopened");
const compCheck = await call("inspect-comp", { compName: "Comp 1" });
assert(compCheck.parsed?.comp?.numLayers === 3, "restored 'Comp 1' has all 3 original layers");

console.log(`\n=== DONE: ${failures === 0 ? "ALL ASSERTIONS PASSED" : failures + " FAILED"} ===`);
await client.close();
process.exit(failures === 0 ? 0 : 1);
