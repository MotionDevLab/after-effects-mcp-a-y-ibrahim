import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  cwd: "C:\\Users\\renat\\after-effects-mcp-a-y-ibrahim",
  stderr: "pipe",
});

const client = new Client({ name: "layer-comp-management-test", version: "1.0.0" });
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

// compIndex's positional index is not stable creation order (see CONTEXT.md
// "Known limitations") - a handful of tools still on the older
// LayerIdentifierSchema convention (apply-effect, list-layer-effects,
// set-effect-property, add-marker) need the CURRENT raw project-item index,
// not a value captured earlier. Resolve it fresh right before each use.
async function resolveItemIndex(name) {
  const info = await call("run-script", { script: "getProjectInfo" });
  const idx = (info.parsed?.items || []).findIndex((it) => it.name === name) + 1;
  return idx;
}

// ---- Save + close real project ----
const info0 = await call("run-script", { script: "getProjectInfo" });
const originalPath = info0.parsed?.path;
assert(!!originalPath, "original project path captured");
await call("save-project", {});
await call("close-project", { saveFirst: false });

// ---- Set up scratch project ----
await call("create-project", { saveFirst: false });
await call("create-composition", { name: "LcmTest", width: 640, height: 360, frameRate: 30, duration: 8 });

// ==================== duplicate-composition / delete-composition ====================
const dup = await call("duplicate-composition", { compName: "LcmTest", newName: "LcmTest Copy" });
assert(dup.parsed?.status === "success", "duplicate-composition succeeded");
assert(dup.parsed?.duplicate?.name === "LcmTest Copy", "duplicate has the requested new name");
assert(dup.parsed?.duplicate?.id !== dup.parsed?.original?.id, "duplicate has a different item id than the original");

const projAfterDup = await call("run-script", { script: "getProjectInfo" });
assert((projAfterDup.parsed?.items || []).some((it) => it.name === "LcmTest Copy"), "duplicate comp is present in the project");

const del = await call("delete-composition", { compName: "LcmTest Copy" });
assert(del.parsed?.status === "success" && del.parsed?.deleted?.name === "LcmTest Copy", "delete-composition succeeded");
const projAfterDel = await call("run-script", { script: "getProjectInfo" });
assert(!(projAfterDel.parsed?.items || []).some((it) => it.name === "LcmTest Copy"), "duplicate comp is gone after delete-composition");

// ==================== solids + add-light-layer ====================
await call("run-script", { script: "createSolidLayer", parameters: { compName: "LcmTest", name: "LayerA", color: [1, 0, 0], size: [100, 100] } });
await call("run-script", { script: "createSolidLayer", parameters: { compName: "LcmTest", name: "LayerB", color: [0, 1, 0], size: [100, 100] } });
await call("run-script", { script: "createSolidLayer", parameters: { compName: "LcmTest", name: "LayerC", color: [0, 0, 1], size: [100, 100] } });

const lightRes = await call("add-light-layer", { compName: "LcmTest", name: "MyLight", type: "SPOT", color: [1, 0, 0], intensity: 150 });
assert(lightRes.parsed?.status === "success", "add-light-layer succeeded");

const compAfterLight = await call("inspect-comp", { compName: "LcmTest" });
const lightLayer = compAfterLight.parsed?.layers?.find((l) => l.name === "MyLight");
assert(lightLayer?.type === "LightLayer", `light layer created with correct type (got ${lightLayer?.type})`);
const layerAIdx = compAfterLight.parsed?.layers?.find((l) => l.name === "LayerA")?.index;
const layerBIdx = compAfterLight.parsed?.layers?.find((l) => l.name === "LayerB")?.index;
const layerCIdx = compAfterLight.parsed?.layers?.find((l) => l.name === "LayerC")?.index;
assert(!!layerAIdx && !!layerBIdx && !!layerCIdx, `resolved current indices for LayerA(${layerAIdx})/LayerB(${layerBIdx})/LayerC(${layerCIdx})`);

// ==================== reorder-effects / copy-effects ====================
const lcmIdxForEffects = await resolveItemIndex("LcmTest");
await call("apply-effect", { compIndex: lcmIdxForEffects, layerIndex: layerAIdx, effectMatchName: "ADBE Gaussian Blur 2", effectSettings: { Blurriness: 20 } });
await call("apply-effect", { compIndex: lcmIdxForEffects, layerIndex: layerAIdx, effectMatchName: "ADBE HUE SATURATION" });
// Put an expression on the blur's Blurriness so copy-effects has a
// keyframed/expression-driven property to warn about (the bug fix vs ishu86's
// silent swallow).
await call("set-effect-property", { compIndex: lcmIdxForEffects, layerIndex: layerAIdx, effectMatchName: "ADBE Gaussian Blur 2", propertyName: "Blurriness", expressionString: "10" });

const effectsBefore = await call("list-layer-effects", { compIndex: lcmIdxForEffects, layerIndex: layerAIdx });
assert(effectsBefore.parsed?.effectCount === 2, `LayerA has 2 effects before reorder (got ${effectsBefore.parsed?.effectCount})`);
const blurIndexBefore = effectsBefore.parsed?.effects?.find((e) => e.matchName === "ADBE Gaussian Blur 2")?.index;
const hueIndexBefore = effectsBefore.parsed?.effects?.find((e) => e.matchName === "ADBE HUE SATURATION")?.index;
assert(blurIndexBefore === 1 && hueIndexBefore === 2, `effects in creation order before reorder (blur=${blurIndexBefore}, hue=${hueIndexBefore})`);

const reorderRes = await call("reorder-effects", { compName: "LcmTest", layerName: "LayerA", effectIndex: hueIndexBefore, newIndex: 1 });
assert(reorderRes.parsed?.status === "success", "reorder-effects succeeded");
const effectsAfter = await call("list-layer-effects", { compIndex: lcmIdxForEffects, layerIndex: layerAIdx });
const hueIndexAfter = effectsAfter.parsed?.effects?.find((e) => e.matchName === "ADBE HUE SATURATION")?.index;
assert(hueIndexAfter === 1, `Hue/Saturation moved to position 1 after reorder-effects (got ${hueIndexAfter})`);

const copyRes = await call("copy-effects", { compName: "LcmTest", sourceLayerName: "LayerA", targetLayerName: "LayerB" });
assert(copyRes.parsed?.status === "success" && copyRes.parsed?.count === 2, `copy-effects copied both effects to LayerB (count ${copyRes.parsed?.count})`);
assert(Array.isArray(copyRes.parsed?.warnings) && copyRes.parsed.warnings.some((w) => /Blurriness/.test(w) && /expression/i.test(w)), "copy-effects warned about the expression-driven Blurriness property instead of silently copying only its static value");

const layerBIdxForEffects = layerBIdx; // unchanged since no layers added/removed since resolution
const effectsOnB = await call("list-layer-effects", { compIndex: lcmIdxForEffects, layerIndex: layerBIdxForEffects });
assert(effectsOnB.parsed?.effectCount === 2, `LayerB now has 2 copied effects (got ${effectsOnB.parsed?.effectCount})`);

// ==================== precompose-layers ====================
const precomposeRes = await call("precompose-layers", { compName: "LcmTest", layerIndices: [layerBIdx, layerCIdx].sort((a, b) => a - b), name: "PrecompXY", moveAttributes: true });
assert(precomposeRes.parsed?.status === "success" && precomposeRes.parsed?.precomposedLayer?.name === "PrecompXY", "precompose-layers succeeded");

const compAfterPrecompose = await call("inspect-comp", { compName: "LcmTest" });
assert(!!compAfterPrecompose.parsed?.layers?.find((l) => l.name === "PrecompXY"), "PrecompXY layer now present in LcmTest");
assert(!compAfterPrecompose.parsed?.layers?.some((l) => l.name === "LayerB" || l.name === "LayerC"), "LayerB/LayerC replaced by the precomp layer");
const projAfterPrecompose = await call("run-script", { script: "getProjectInfo" });
assert((projAfterPrecompose.parsed?.items || []).some((it) => it.name === "PrecompXY"), "PrecompXY composition created in the project");

// ==================== delete-marker ====================
let freshIdx = await resolveItemIndex("LcmTest");
await call("add-marker", { compIndex: freshIdx, markerType: "comp", timeInSeconds: 1, comment: "M1" });
await call("add-marker", { compIndex: freshIdx, markerType: "comp", timeInSeconds: 2, comment: "M2" });

const delMarker1 = await call("delete-marker", { compName: "LcmTest", markerIndex: 1 });
assert(delMarker1.parsed?.status === "success" && delMarker1.parsed?.source === "composition" && delMarker1.parsed?.deletedIndex === 1, "delete-marker removed composition marker 1");

const markerCheck = await call("execute-script", {
  script: `
    var comp = null;
    for (var i = 1; i <= app.project.numItems; i++) { var it = app.project.item(i); if (it instanceof CompItem && it.name === "LcmTest") { comp = it; break; } }
    var mk = comp.markerProperty;
    return { numKeys: mk.numKeys, comment: mk.numKeys > 0 ? mk.keyValue(1).comment : null };
  `,
});
assert(markerCheck.parsed?.result?.numKeys === 1 && markerCheck.parsed?.result?.comment === "M2", `only M2 remains after deleting marker 1 (${JSON.stringify(markerCheck.parsed)})`);

const delMarkerOOR = await call("delete-marker", { compName: "LcmTest", markerIndex: 99 });
assert(delMarkerOOR.parsed?.status === "error", "delete-marker rejects an out-of-range markerIndex instead of throwing raw");

freshIdx = await resolveItemIndex("LcmTest");
await call("add-marker", { compIndex: freshIdx, markerType: "layer", layerName: "LayerA", timeInSeconds: 1, comment: "LM1" });
const delLayerMarker = await call("delete-marker", { compName: "LcmTest", layerName: "LayerA", markerIndex: 1 });
assert(delLayerMarker.parsed?.status === "success" && delLayerMarker.parsed?.source === "layer" && delLayerMarker.parsed?.layer?.name === "LayerA", "delete-marker removed the layer marker on LayerA");

const layerMarkerCheck = await call("execute-script", {
  script: `
    var comp = null;
    for (var i = 1; i <= app.project.numItems; i++) { var it = app.project.item(i); if (it instanceof CompItem && it.name === "LcmTest") { comp = it; break; } }
    var layer = null;
    for (var j = 1; j <= comp.numLayers; j++) { if (comp.layer(j).name === "LayerA") { layer = comp.layer(j); break; } }
    return { numKeys: layer.property("ADBE Marker").numKeys };
  `,
});
assert(layerMarkerCheck.parsed?.result?.numKeys === 0, "LayerA has no markers left after delete-marker");

// ==================== set-work-area ====================
const workAreaRes = await call("set-work-area", { compName: "LcmTest", start: 1, duration: 3 });
assert(workAreaRes.parsed?.status === "success" && Math.abs(workAreaRes.parsed.workAreaStart - 1) < 0.01 && Math.abs(workAreaRes.parsed.workAreaDuration - 3) < 0.01, "set-work-area applied the requested start/duration");

// Real AE behavior (confirmed live, contradicts ishu86's own assumption that AE
// clamps workArea silently): setting workAreaDuration beyond comp.duration
// THROWS a native AE error rather than clamping - our bridge function's
// try/catch correctly surfaces that as a status:"error" result instead of
// silently succeeding with a wrong value.
const workAreaOOB = await call("set-work-area", { compName: "LcmTest", start: 5, duration: 100 });
assert(workAreaOOB.parsed?.status === "error", "set-work-area surfaces AE's native out-of-range error instead of silently clamping or succeeding");

// ==================== Restore real project ====================
await call("close-project", { saveFirst: false });
const reopen = await call("open-project", { filePath: originalPath, saveFirst: false });
assert(reopen.parsed?.status === "success", "real project reopened");
const compCheck = await call("inspect-comp", { compName: "Comp 1" });
assert(compCheck.parsed?.comp?.numLayers === 3, "restored 'Comp 1' has all 3 original layers");

console.log(`\n=== DONE: ${failures === 0 ? "ALL ASSERTIONS PASSED" : failures + " FAILED"} ===`);
await client.close();
process.exit(failures === 0 ? 0 : 1);
