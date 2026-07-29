import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  cwd: "C:\\Users\\renat\\after-effects-mcp-a-y-ibrahim",
  stderr: "pipe",
});

const client = new Client({ name: "batch-expression-test", version: "1.0.0" });
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

// get-expression is still on the older raw-positional LayerIdentifierSchema
// (see CONTEXT.md "Known limitations") - it needs the CURRENT raw
// project-item index, not a value captured earlier. Resolve it fresh right
// before each use.
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
await call("create-composition", { name: "BsxTest", width: 640, height: 360, frameRate: 30, duration: 8 });

await call("create-text-layer", { compName: "BsxTest", text: "TxtA" });
await call("create-text-layer", { compName: "BsxTest", text: "TxtB" });
await call("create-text-layer", { compName: "BsxTest", text: "TxtC" });

const compInfo = await call("inspect-comp", { compName: "BsxTest" });
const idxA = compInfo.parsed?.layers?.find((l) => l.name === "TxtA")?.index;
const idxB = compInfo.parsed?.layers?.find((l) => l.name === "TxtB")?.index;
const idxC = compInfo.parsed?.layers?.find((l) => l.name === "TxtC")?.index;
assert(!!idxA && !!idxB && !!idxC, `resolved indices for TxtA(${idxA})/TxtB(${idxB})/TxtC(${idxC})`);

// ==================== batch-set-expression: apply to all 3 ====================
const batchAll = await call("batch-set-expression", {
  compName: "BsxTest",
  propertyName: "Opacity",
  expressionString: "wiggle(2,20)",
  targets: [{ layerIndex: idxA }, { layerIndex: idxB }, { layerIndex: idxC }],
});
assert(batchAll.parsed?.status === "success", "batch-set-expression (all 3) returned top-level success");
assert(batchAll.parsed?.successCount === 3 && batchAll.parsed?.count === 3, `all 3 targets succeeded (successCount=${batchAll.parsed?.successCount})`);
assert((batchAll.parsed?.results || []).every((r) => r.status === "success"), "every per-layer result reports success");

// Verify via an independent read (get-expression), not just the tool's own
// success message - same discipline as the expression-suite test.
const rawIdxBsx = await resolveItemIndex("BsxTest");
const readBack = await call("get-expression", { compIndex: rawIdxBsx, layerIndex: idxA, propertyName: "Opacity" });
assert(readBack.parsed?.expression === "wiggle(2,20)", `get-expression round-trips the expression set via batch-set-expression (got '${readBack.parsed?.expression}')`);

// ==================== batch-set-expression: partial failure isolation ====================
const batchPartial = await call("batch-set-expression", {
  compName: "BsxTest",
  propertyName: "Rotation",
  expressionString: "time * 10",
  targets: [{ layerName: "TxtA" }, { layerName: "DoesNotExist" }],
});
assert(batchPartial.parsed?.status === "success", "batch-set-expression (partial) still returns top-level success");
assert(batchPartial.parsed?.successCount === 1 && batchPartial.parsed?.count === 2, `1 of 2 targets succeeded (successCount=${batchPartial.parsed?.successCount})`);
const okItem = batchPartial.parsed?.results?.find((r) => r.layerName === "TxtA" || r.status === "success");
const badItem = batchPartial.parsed?.results?.find((r) => r.status === "error");
assert(okItem?.status === "success", "valid target (TxtA) still succeeded");
assert(badItem?.status === "error" && /not found/i.test(badItem?.message || ""), `invalid layerName reported as a per-item error, not an aborted batch (message: '${badItem?.message}')`);

// ==================== batch-set-expression: invalid propertyName doesn't crash the batch ====================
const batchBadProp = await call("batch-set-expression", {
  compName: "BsxTest",
  propertyName: "NotAProperty",
  expressionString: "1",
  targets: [{ layerIndex: idxB }],
});
assert(batchBadProp.parsed?.status === "success", "batch-set-expression (bad propertyName) still returns top-level success, not a crash");
assert(batchBadProp.parsed?.results?.[0]?.status === "error" && /not found/i.test(batchBadProp.parsed.results[0].message || ""), `invalid propertyName reported as a per-item error (message: '${batchBadProp.parsed?.results?.[0]?.message}')`);

// ==================== batch-set-expression: empty string removes the expression ====================
const batchRemove = await call("batch-set-expression", {
  compName: "BsxTest",
  propertyName: "Opacity",
  expressionString: "",
  targets: [{ layerIndex: idxA }],
});
assert(batchRemove.parsed?.status === "success" && batchRemove.parsed?.results?.[0]?.status === "success", "batch-set-expression with empty string succeeded (remove path)");
const readBackRemoved = await call("get-expression", { compIndex: rawIdxBsx, layerIndex: idxA, propertyName: "Opacity" });
assert(readBackRemoved.parsed?.expression === "", `get-expression confirms the expression was actually removed (got '${readBackRemoved.parsed?.expression}')`);

// ==================== Restore real project ====================
await call("close-project", { saveFirst: false });
const reopen = await call("open-project", { filePath: originalPath, saveFirst: false });
assert(reopen.parsed?.status === "success", "real project reopened");
const compCheck = await call("inspect-comp", { compName: "Comp 1" });
assert(compCheck.parsed?.comp?.numLayers === 3, "restored 'Comp 1' has all 3 original layers");

console.log(`\n=== DONE: ${failures === 0 ? "ALL ASSERTIONS PASSED" : failures + " FAILED"} ===`);
await client.close();
process.exit(failures === 0 ? 0 : 1);
