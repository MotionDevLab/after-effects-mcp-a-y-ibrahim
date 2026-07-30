import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  cwd: "C:\\Users\\renat\\after-effects-mcp-a-y-ibrahim",
  stderr: "pipe",
});

const client = new Client({ name: "expr-suite-test", version: "1.0.0" });
await client.connect(transport);
transport.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));

let stepNum = 0;
let failures = 0;
async function call(name, args = {}) {
  stepNum++;
  console.log(`\n=== STEP ${stepNum}: ${name} ${JSON.stringify(args)} ===`);
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? JSON.stringify(res);
  console.log(String(text).slice(0, 700));
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

// ---- Set up one disposable comp + layer ----
await call("create-project", { saveFirst: false });
await call("create-composition", { name: "ExprTest", width: 640, height: 360, frameRate: 30, duration: 5 });
await call("run-script", { script: "createSolidLayer", parameters: { compName: "ExprTest", name: "TargetLayer", color: [1, 0, 0], size: [100, 100] } });
await call("run-script", { script: "createSolidLayer", parameters: { compName: "ExprTest", name: "SourceLayer", color: [0, 1, 0], size: [100, 100] } });

// ---- get-expression on a property with no expression yet ----
const get1 = await call("get-expression", { compIndex: 1, layerIndex: 1, propertyName: "Position" });
assert(get1.parsed?.status === "success", "get-expression succeeds on a property with no expression");
assert(get1.parsed?.expression === "", "empty expression reported for a property with none set");

// ---- set via existing tool, then get-expression round-trip ----
const setExpr = await client.callTool({
  name: "setLayerExpression",
  arguments: { compIndex: 1, layerIndex: 1, propertyName: "Position", expressionString: "value + [10, 0]" },
});
console.log("setLayerExpression:", setExpr.content?.[0]?.text);
const get2 = await call("get-expression", { compIndex: 1, layerIndex: 1, propertyName: "Position" });
assert(get2.parsed?.expression === "value + [10, 0]", "get-expression reads back the exact string just set");
assert(get2.parsed?.expressionEnabled === true, "expression is enabled by default after being set");

// ---- enable-expression toggles without touching the string ----
const disable1 = await call("enable-expression", { compIndex: 1, layerIndex: 1, propertyName: "Position", enabled: false });
assert(disable1.parsed?.status === "success" && disable1.parsed?.expressionEnabled === false, "enable-expression disabled it");
const get3 = await call("get-expression", { compIndex: 1, layerIndex: 1, propertyName: "Position" });
assert(get3.parsed?.expression === "value + [10, 0]", "expression string unchanged after disabling (not clobbered)");
assert(get3.parsed?.expressionEnabled === false, "get-expression confirms disabled state");
const enable1 = await call("enable-expression", { compIndex: 1, layerIndex: 1, propertyName: "Position", enabled: true });
assert(enable1.parsed?.expressionEnabled === true, "enable-expression re-enabled it");

// ---- add-expression-control: slider (with default), dropdown (note expected) ----
const sliderCtl = await call("add-expression-control", {
  compIndex: 1, layerIndex: 1, controlType: "slider", controlName: "MySlider", defaultValue: 42,
});
assert(sliderCtl.parsed?.status === "success", "slider control added");
const verifySlider = await call("execute-script", {
  script: `var l = app.project.item(1).layers[1]; var e = l.Effects.property("MySlider"); return { value: e.property("Slider").value };`,
});
assert(String(verifySlider.text).indexOf("42") !== -1, "slider control's default value 42 actually applied (verified via execute-script)");

const dropdownCtl = await call("add-expression-control", {
  compIndex: 1, layerIndex: 1, controlType: "dropdown", controlName: "MyDropdown", defaultValue: 2,
});
assert(dropdownCtl.parsed?.status === "success", "dropdown control added");
assert(!!dropdownCtl.parsed?.note && dropdownCtl.parsed.note.indexOf("not settable") !== -1, "dropdown default-value limitation reported via note, not silently dropped");

// ---- link-properties: SourceLayer.Position follows TargetLayer.Position ----
const link1 = await call("link-properties", {
  compIndex: 1, sourceLayerIndex: 2, sourceProperty: "Position", targetLayerIndex: 1, targetProperty: "Position", offset: [5, 5],
});
assert(link1.parsed?.status === "success", "link-properties succeeded");
const get4 = await call("get-expression", { compIndex: 1, layerIndex: 2, propertyName: "Position" });
assert(String(get4.parsed?.expression || "").indexOf("thisComp.layer(1)") !== -1, "linked expression references the target layer by index");
assert(String(get4.parsed?.expression || "").indexOf("Position") !== -1, "linked expression references the target property");

// ---- apply-expression-template: wiggle with custom params, bounce with defaults ----
const wiggle1 = await call("apply-expression-template", {
  compIndex: 1, layerIndex: 1, propertyName: "Rotation", template: "wiggle", params: { freq: 5, amp: 30 },
});
assert(wiggle1.parsed?.status === "success", "wiggle template applied");
assert(String(wiggle1.parsed?.expression || "") === "wiggle(5, 30)", `wiggle params substituted correctly (got: ${wiggle1.parsed?.expression})`);

const bounce1 = await call("apply-expression-template", {
  compIndex: 1, layerIndex: 2, propertyName: "Scale", template: "bounce",
});
assert(bounce1.parsed?.status === "success", "bounce template applied with defaults");
assert(String(bounce1.parsed?.expression || "").indexOf("{{") === -1, "no leftover unsubstituted placeholder tokens in bounce template");

// ---- Restore real project ----
await call("close-project", { saveFirst: false });
const reopen = await call("open-project", { filePath: originalPath, saveFirst: false });
assert(reopen.parsed?.status === "success", "real project reopened");
const compCheck = await call("inspect-comp", { compName: "Comp 1" });
assert(compCheck.parsed?.comp?.numLayers === 3, "restored 'Comp 1' has all 3 original layers");

console.log(`\n=== DONE: ${failures === 0 ? "ALL ASSERTIONS PASSED" : failures + " FAILED"} ===`);
await client.close();
process.exit(failures === 0 ? 0 : 1);
