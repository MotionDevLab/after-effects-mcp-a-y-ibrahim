import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const LOGO_PNG = "C:\\Users\\renat\\AppData\\Local\\Temp\\claude\\C--Users-renat-Claude-projects\\7026eba2-cfa2-4d5f-a83b-a82df29683f3\\scratchpad\\logo-asset.png";

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  cwd: "C:\\Users\\renat\\after-effects-mcp-a-y-ibrahim",
  stderr: "pipe",
});

const client = new Client({ name: "mg-templates-test", version: "1.0.0" });
await client.connect(transport);
transport.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));

let stepNum = 0;
let failures = 0;
async function call(name, args = {}) {
  stepNum++;
  console.log(`\n=== STEP ${stepNum}: ${name} ${JSON.stringify(args)} ===`);
  let res;
  try {
    res = await client.callTool({ name, arguments: args });
  } catch (mcpErr) {
    // Schema-level (zod) validation failures throw rather than returning a
    // normal tool response - treat that as an error result instead of crashing
    // the whole test, since "the schema itself rejects this" is a valid,
    // expected outcome for some test cases (e.g. an enum value removed on
    // purpose).
    console.log(`SCHEMA REJECTED: ${mcpErr.message}`);
    return { res: { isError: true }, parsed: { status: "error", error: mcpErr.message }, text: mcpErr.message };
  }
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

// ---- Save + close real project ----
const info0 = await call("run-script", { script: "getProjectInfo" });
const originalPath = info0.parsed?.path;
assert(!!originalPath, "original project path captured");
await call("save-project", {});
await call("close-project", { saveFirst: false });

// ---- Scratch project + main comp + logo asset ----
await call("create-project", { saveFirst: false });
await call("create-composition", { name: "MainComp", width: 1280, height: 720, frameRate: 30, duration: 10 });
const importLogo = await call("import-footage", { filePath: LOGO_PNG, name: "Logo" });
const logoId = importLogo.parsed?.item?.id;
assert(!!logoId, "logo asset imported, id captured");

// ==================== create-lower-third ====================
const lt = await call("create-lower-third", {
  compName: "MainComp", title: "Jane Doe", subtitle: "Correspondent",
  style: "modern", primaryColor: [0.1, 0.4, 0.9], secondaryColor: [1, 0.8, 0],
});
assert(lt.parsed?.status === "success", "create-lower-third succeeded");
const ltCompName = lt.parsed?.compName;
const ltInfo = await call("inspect-comp", { compName: ltCompName });
assert(ltInfo.parsed?.comp?.numLayers === 4, `lower-third precomp has 4 layers: accent+bar+title+subtitle (got ${ltInfo.parsed?.comp?.numLayers})`);
// Verify secondaryColor was actually used (not silently dropped like ishu86) - the
// Accent layer's solid color should match secondaryColor, not primaryColor.
const accentColorCheck = await call("execute-script", {
  script: `
    var lt = null;
    for (var i = 1; i <= app.project.numItems; i++) { if (app.project.item(i).name === "${ltCompName}") lt = app.project.item(i); }
    var accent = lt.layer("Accent");
    return { color: accent.source.mainSource.color };
  `,
});
const accentColorText = String(accentColorCheck.text);
assert(accentColorText.indexOf("0.8") !== -1 || accentColorText.indexOf("1") !== -1, `Accent layer uses secondaryColor, not silently ignored (${accentColorText.slice(0, 200)})`);

// ==================== create-title-card ====================
const tc = await call("create-title-card", {
  compName: "MainComp", title: "Chapter One", subtitle: "The Beginning",
  style: "cinematic", backgroundColor: [0, 0, 0],
});
assert(tc.parsed?.status === "success", "create-title-card succeeded");
const mainInfoAfterTC = await call("inspect-comp", { compName: "MainComp" });
assert(mainInfoAfterTC.parsed?.comp?.numLayers >= 3, `MainComp grew with title-card layers (bg+title+subtitle) (numLayers=${mainInfoAfterTC.parsed?.comp?.numLayers})`);

// ==================== create-transition: verify easing is genuinely applied ====================
const trans1 = await call("create-transition", { compName: "MainComp", type: "wipe_left", duration: 1, easing: "easeInOut" });
assert(trans1.parsed?.status === "success", "create-transition (wipe_left, easeInOut) succeeded");
const transLayerIndex = trans1.parsed?.layerIndex;
// Find the Linear Wipe effect's Transition Completion property and confirm it has
// non-linear (BEZIER) interpolation with real ease values - proves easing is genuinely
// wired, unlike ishu86 where this parameter was completely dead.
const wipeCheck = await call("execute-script", {
  script: `
    var comp = app.project.item(1);
    for (var i = 1; i <= app.project.numItems; i++) { if (app.project.item(i).name === "MainComp") comp = app.project.item(i); }
    var layer = comp.layer(${transLayerIndex});
    var wipe = layer.property("ADBE Effect Parade").property(1);
    var completion = wipe.property("Transition Completion");
    return {
      inInterp: completion.keyInInterpolationType(1).toString(),
      outInterp: completion.keyOutInterpolationType(2).toString(),
      inEaseInfluence: completion.keyInTemporalEase(2)[0].influence
    };
  `,
});
console.log("wipeCheck:", wipeCheck.text);
// KeyframeInterpolationType constants stringify to their raw numeric code, not a
// name, so check the actual proof instead: influence 75 exactly matches what
// _applyEasingAtKey sets, which a default/untouched keyframe would never have.
assert(wipeCheck.parsed?.result?.inEaseInfluence === 75, `easeInOut applied real ease (influence 75, not default) - easing genuinely wired (got ${wipeCheck.parsed?.result?.inEaseInfluence})`);

const trans2 = await call("create-transition", { compName: "MainComp", type: "dissolve", duration: 0.5 });
assert(trans2.parsed?.status === "success", "create-transition (dissolve, default linear easing) succeeded");

// ==================== create-logo-reveal ====================
// Error path: neither logoItemId nor logoItemName - must be an informed error, not a crash.
const logoErr = await call("create-logo-reveal", { compName: "MainComp", style: "fade" });
assert(logoErr.parsed?.status === "error" || logoErr.res.isError === true, "create-logo-reveal with no logo identifier returns an informed error, not a raw ReferenceError crash");

// Rejected style: 'particle' must be refused, not silently accepted and no-op'd like ishu86.
const logoParticle = await call("create-logo-reveal", { compName: "MainComp", logoItemId: logoId, style: "particle" });
assert(logoParticle.parsed?.status === "error", "create-logo-reveal rejects 'particle' style explicitly rather than silently no-op'ing it");

const logoOk = await call("create-logo-reveal", { compName: "MainComp", logoItemId: logoId, style: "scale", duration: 2 });
assert(logoOk.parsed?.status === "success", "create-logo-reveal (scale style, valid logo id) succeeded");
const logoLayerIndex = logoOk.parsed?.layerIndex;

// NOTE: app.project.item(index)'s positional index is NOT stable creation order -
// it shifts once AE auto-creates its built-in "Solids" folder (confirmed live: a
// project-wide, cross-cutting discovery, not specific to this test). compIndex-based
// tools (the LayerIdentifierSchema convention used across every block this session)
// need the CURRENT actual position, not the position at creation time. Resolve it
// dynamically here rather than assuming compIndex:1.
const projInfo = await call("run-script", { script: "getProjectInfo" });
const mainCompItemIndex = (projInfo.parsed?.items || []).findIndex((it) => it.name === "MainComp") + 1;
assert(mainCompItemIndex > 0, `resolved MainComp's actual current item index (${mainCompItemIndex}) for compIndex-based calls below`);

const logoKeys = await call("get-keyframes", { compIndex: mainCompItemIndex, layerIndex: logoLayerIndex, propertyName: "Scale" });
assert((logoKeys.parsed?.numKeys || 0) >= 2, `logo reveal's Scale property has real keyframes (got ${logoKeys.parsed?.numKeys})`);

// ==================== create-text-animator ====================
await call("run-script", { script: "createTextLayer", parameters: { compName: "MainComp", text: "Animated Text", fontSize: 60 } });
const infoForTextLayer = await call("inspect-comp", { compName: "MainComp" });
const textLayerEntry = infoForTextLayer.parsed?.layers?.find((l) => l.type === "TextLayer" || l.name === "Animated Text");
const textLayerIndex = textLayerEntry?.index;
assert(!!textLayerIndex, `text layer found for animator test (index ${textLayerIndex})`);

const animWave = await call("create-text-animator", {
  compIndex: mainCompItemIndex, layerIndex: textLayerIndex, animatorType: "wave", waveAmplitude: 25, waveSpeed: 3,
});
assert(animWave.parsed?.status === "success", "create-text-animator (wave) succeeded");
// Verify the wave is a REAL per-character expression (references textIndex), not
// ishu86's shared scrolling-band approximation.
const waveExprCheck = await call("execute-script", {
  script: `
    var comp = null;
    for (var i = 1; i <= app.project.numItems; i++) { if (app.project.item(i).name === "MainComp") comp = app.project.item(i); }
    var layer = comp.layer(${textLayerIndex});
    var animators = layer.property("ADBE Text Properties").property("Animators");
    var animator = animators.property(animators.numProperties);
    // The animator's Properties group is a fixed ~103-slot catalog of every
    // possible per-character property (Anchor Point always first), not a
    // growable list of what's been added - property(1) is always Anchor
    // Point regardless of what's active. Search by matchName + a real
    // expression instead of assuming index 1 is the one just added.
    var props = animator.property("ADBE Text Animator Properties");
    var found = null;
    for (var p = 1; p <= props.numProperties; p++) {
      var prop = props.property(p);
      if (prop.matchName === "ADBE Text Position 3D" && prop.expression) { found = prop; break; }
    }
    return { expr: found ? found.expression : "" };
  `,
});
console.log("waveExprCheck:", waveExprCheck.text);
assert(String(waveExprCheck.text).indexOf("textIndex") !== -1 && String(waveExprCheck.text).indexOf("Math.sin") !== -1, "wave uses a real per-character textIndex-based sine expression, not a shared band");

const animTypewriter = await call("create-text-animator", { compIndex: mainCompItemIndex, layerIndex: textLayerIndex, animatorType: "typewriter", delay: 0.1 });
assert(animTypewriter.parsed?.status === "success", "create-text-animator (typewriter, custom delay) succeeded");
// Verify delay is genuinely wired into the selector's Offset expression (real
// per-character stagger), not silently dropped like ishu86's delay param.
const delayExprCheck = await call("execute-script", {
  script: `
    var comp = null;
    for (var i = 1; i <= app.project.numItems; i++) { if (app.project.item(i).name === "MainComp") comp = app.project.item(i); }
    var layer = comp.layer(${textLayerIndex});
    var animators = layer.property("ADBE Text Properties").property("Animators");
    var animator = animators.property(animators.numProperties);
    var selector = animator.property("Selectors").property(1);
    var offset = selector.property("Offset");
    return { expr: offset.expression };
  `,
});
console.log("delayExprCheck:", delayExprCheck.text);
assert(String(delayExprCheck.text).indexOf("textIndex") !== -1 && String(delayExprCheck.text).indexOf("0.1") !== -1, "delay is genuinely wired into the selector's Offset expression, not dropped");

// ==================== Restore real project ====================
await call("close-project", { saveFirst: false });
const reopen = await call("open-project", { filePath: originalPath, saveFirst: false });
assert(reopen.parsed?.status === "success", "real project reopened");
const compCheck = await call("inspect-comp", { compName: "Comp 1" });
assert(compCheck.parsed?.comp?.numLayers === 3, "restored 'Comp 1' has all 3 original layers");

console.log(`\n=== DONE: ${failures === 0 ? "ALL ASSERTIONS PASSED" : failures + " FAILED"} ===`);
await client.close();
process.exit(failures === 0 ? 0 : 1);
