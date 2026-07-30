import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  cwd: "C:\\Users\\renat\\after-effects-mcp-a-y-ibrahim",
  stderr: "pipe",
});

const client = new Client({ name: "lifecycle-test", version: "1.0.0" });
await client.connect(transport);
transport.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));

let stepNum = 0;
async function call(name, args = {}) {
  stepNum++;
  console.log(`\n=== STEP ${stepNum}: ${name} ${JSON.stringify(args)} ===`);
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? JSON.stringify(res);
  console.log(String(text).slice(0, 700));
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { res, parsed, text };
}

function assert(cond, msg) {
  if (!cond) {
    console.log(`\n!!! ASSERTION FAILED: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`OK: ${msg}`);
  }
}

// STEP 1: read-only, capture current real project state before touching anything destructive.
const info1 = await call("run-script", { script: "getProjectInfo" });
const originalPath = info1.parsed?.path;
console.log(`\nCaptured original project path: "${originalPath}"`);
assert(!!originalPath, "original project has a real file path (required for safe round-trip)");

if (!originalPath) {
  console.log("\nABORTING remaining destructive tests: no file path captured for the real project.");
  await client.close();
  process.exit(1);
}

// STEP 2: ensure the real project is fully saved to disk before we do anything destructive.
const save1 = await call("save-project", {});
assert(save1.parsed?.status === "success", "real project saved cleanly before destructive tests");

// STEP 3: close the (now-saved, non-dirty) real project. saveFirst:false is safe here -
// nothing unsaved exists, so this only tests the close mechanics, not data loss.
const close1 = await call("close-project", { saveFirst: false });
assert(close1.parsed?.status === "success", "close-project succeeded on saved project");

// STEP 4: confirm AE auto-created a new blank project after close.
const info2 = await call("run-script", { script: "getProjectInfo" });
assert(
  !info2.parsed?.path || info2.parsed.path === "",
  "post-close project is a fresh blank/untitled project (no file path)",
);

// STEP 5: create-project on top of the (non-dirty) blank project - safe, nothing to lose.
const create1 = await call("create-project", { saveFirst: false });
assert(create1.parsed?.status === "success", "create-project succeeded");

// STEP 6: test save-project's "never saved, no filePath" error path on this disposable project.
const saveErr = await call("save-project", {});
assert(
  saveErr.parsed?.status === "error" || saveErr.res.isError === true,
  "save-project with no filePath on a never-saved project returns an informed error, not a crash",
);

// STEP 7: make the disposable project dirty (add a composition) so we can test the
// dirty + no-file-path + saveFirst:true informed-error path.
const comp1 = await call("create-composition", {
  name: "__lifecycle_test_comp__",
  width: 640,
  height: 360,
  frameRate: 30,
  duration: 5,
});
assert(comp1.parsed?.status === "success" || !comp1.res.isError, "throwaway composition created to dirty the disposable project");

// STEP 8: close-project with saveFirst:true on a dirty, never-saved project MUST return
// the informed error, not silently discard and not crash.
const closeErr = await call("close-project", { saveFirst: true });
assert(
  closeErr.parsed?.status === "error",
  "close-project saveFirst:true on dirty+unsaved project returns informed error (does not silently discard or crash)",
);

// STEP 9: close-project with saveFirst:false on the same dirty disposable project MUST
// succeed and discard - this is the explicit, informed-consent discard path.
const close2 = await call("close-project", { saveFirst: false });
assert(close2.parsed?.status === "success", "close-project saveFirst:false discards dirty disposable project and succeeds");

// STEP 10: confirm we're back on a fresh blank project again.
const info3 = await call("run-script", { script: "getProjectInfo" });
assert(
  !info3.parsed?.path || info3.parsed.path === "",
  "post-discard project is a fresh blank/untitled project",
);

// STEP 11: restore the user's real project.
const open1 = await call("open-project", { filePath: originalPath, saveFirst: false });
assert(open1.parsed?.status === "success", "open-project restored the real project");

// STEP 12: confirm the real project's content (3 layers) is back exactly as it was.
const info4 = await call("run-script", { script: "getProjectInfo" });
assert(info4.parsed?.path === originalPath, "restored project path matches original");

const compCheck = await call("inspect-comp", { compName: "Comp 1" });
assert(compCheck.parsed?.comp?.numLayers === 3, "restored 'Comp 1' has all 3 original layers");

console.log("\n=== DONE ===");
await client.close();
process.exit(0);
