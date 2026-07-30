import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "fs";
import path from "path";

const ASSETS = "C:\\Users\\renat\\AppData\\Local\\Temp\\claude\\C--Users-renat-Claude-projects\\7026eba2-cfa2-4d5f-a83b-a82df29683f3\\scratchpad\\asset-test-assets";
const SCRATCH_DIR = "C:\\Users\\renat\\AppData\\Local\\Temp\\claude\\C--Users-renat-Claude-projects\\7026eba2-cfa2-4d5f-a83b-a82df29683f3\\scratchpad";

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  cwd: "C:\\Users\\renat\\after-effects-mcp-a-y-ibrahim",
  stderr: "pipe",
});

const client = new Client({ name: "asset-mgmt-test", version: "1.0.0" });
await client.connect(transport);
transport.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));

let stepNum = 0;
let failures = 0;
async function call(name, args = {}) {
  stepNum++;
  console.log(`\n=== STEP ${stepNum}: ${name} ${JSON.stringify(args)} ===`);
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? JSON.stringify(res);
  console.log(String(text).slice(0, 800));
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { res, parsed, text };
}

function assert(cond, msg) {
  if (!cond) {
    console.log(`\n!!! ASSERTION FAILED: ${msg}`);
    failures++;
  } else {
    console.log(`OK: ${msg}`);
  }
}

// ---- Phase 0: capture + save + close the REAL project safely ----
const info0 = await call("run-script", { script: "getProjectInfo" });
const originalPath = info0.parsed?.path;
assert(!!originalPath, "original project has a real file path");
if (!originalPath) {
  console.log("ABORTING: no original path captured.");
  await client.close();
  process.exit(1);
}
const save0 = await call("save-project", {});
assert(save0.parsed?.status === "success", "real project saved before touching anything");
const close0 = await call("close-project", { saveFirst: false });
assert(close0.parsed?.status === "success", "real project closed safely (already saved, nothing lost)");

// ================= BLOCK 1: import-footage, import-folder, organize (type) =================
await call("create-project", { saveFirst: false });
const scratch1Path = path.join(SCRATCH_DIR, "scratch1.aep");
const saveScratch1 = await call("save-project", { filePath: scratch1Path });
assert(saveScratch1.parsed?.status === "success", "scratch project 1 saved to a temp path");

const importFootage1 = await call("import-footage", { filePath: path.join(ASSETS, "footage-a.png") });
assert(importFootage1.parsed?.status === "success" && importFootage1.parsed?.item?.id, "import-footage succeeded, item id returned");

const importFolder1 = await call("import-folder", { folderPath: path.join(ASSETS, "import-folder-test"), recursive: false });
assert(importFolder1.parsed?.status === "success", "import-folder succeeded");
assert(importFolder1.parsed?.importedCount === 2, `import-folder imported exactly 2 supported files (got ${importFolder1.parsed?.importedCount})`);
assert(!!importFolder1.parsed?.note && importFolder1.parsed.note.indexOf("unsupported.txt") !== -1, "import-folder reported the unsupported.txt failure in note, not silently dropped");

await call("create-composition", { name: "TestComp1", width: 640, height: 360, frameRate: 30, duration: 5 });

const organizeType = await call("organize-project-items", { structure: "type" });
assert(organizeType.parsed?.status === "success", "organize-project-items type mode succeeded");
// Only footage-a.png and TestComp1 are at project root at this point - import-folder
// itself creates a root "import-folder-test" FolderItem and parents img1.png/img2.png
// INSIDE it, so they were never top-level and correctly aren't touched by organize.
assert(organizeType.parsed?.organizedCount === 2, `type mode organized exactly the 2 actual top-level items (got ${organizeType.parsed?.organizedCount})`);

const infoAfterOrganize = await call("run-script", { script: "getProjectInfo" });
const folderNames = (infoAfterOrganize.parsed?.items || []).filter((i) => i.type === "Folder").map((i) => i.name);
assert(folderNames.indexOf("Compositions") !== -1, "Compositions folder was created");
assert(folderNames.indexOf("Footage") !== -1, "Footage folder was created");

await call("close-project", { saveFirst: false });

// ================= BLOCK 2: organize (usage) =================
await call("create-project", { saveFirst: false });
await call("import-footage", { filePath: path.join(ASSETS, "footage-a.png") });
await call("create-composition", { name: "TestComp2", width: 640, height: 360, frameRate: 30, duration: 5 });

const organizeUsage = await call("organize-project-items", { structure: "usage" });
assert(organizeUsage.parsed?.status === "success", "organize-project-items usage mode succeeded");

const infoAfterUsage = await call("run-script", { script: "getProjectInfo" });
const usageFolderNames = (infoAfterUsage.parsed?.items || []).filter((i) => i.type === "Folder").map((i) => i.name);
assert(usageFolderNames.indexOf("Used") !== -1, "Used folder was created");
assert(usageFolderNames.indexOf("Unused") !== -1, "Unused folder was created");

await call("close-project", { saveFirst: false });

// ================= BLOCK 3: organize (custom), incl. an intentional not-found entry =================
await call("create-project", { saveFirst: false });
const importForCustom = await call("import-footage", { filePath: path.join(ASSETS, "footage-a.png"), name: "CustomTargetItem" });
assert(importForCustom.parsed?.status === "success", "footage imported for custom-mode test");

const organizeCustom = await call("organize-project-items", {
  structure: "custom",
  customFolders: [
    { folderName: "MyCustomFolder", itemNames: ["CustomTargetItem", "DoesNotExistItem"] },
  ],
});
assert(organizeCustom.parsed?.status === "success", "organize-project-items custom mode succeeded");
assert(organizeCustom.parsed?.organizedCount === 1, `custom mode moved exactly 1 item (got ${organizeCustom.parsed?.organizedCount})`);
assert(!!organizeCustom.parsed?.note && organizeCustom.parsed.note.indexOf("DoesNotExistItem") !== -1, "custom mode reported the not-found item in note");

const infoAfterCustom = await call("run-script", { script: "getProjectInfo" });
const customFolderNames = (infoAfterCustom.parsed?.items || []).filter((i) => i.type === "Folder").map((i) => i.name);
assert(customFolderNames.indexOf("MyCustomFolder") !== -1, "MyCustomFolder was actually created (the feature ishu86 never finished)");

await call("close-project", { saveFirst: false });

// ================= BLOCK 4: replace-footage, verified via execute-script (not just the success message) =================
await call("create-project", { saveFirst: false });
const importForReplace = await call("import-footage", { filePath: path.join(ASSETS, "footage-a.png") });
const replaceItemId = importForReplace.parsed?.item?.id;
assert(!!replaceItemId, "footage imported for replace test, id captured");

const replaceResult = await call("replace-footage", { itemId: replaceItemId, newPath: path.join(ASSETS, "footage-b.png") });
assert(replaceResult.parsed?.status === "success", "replace-footage reported success");

const verifyReplace = await call("execute-script", {
  script: `var it = app.project.itemByID(${replaceItemId}); return { name: it.name, file: (it.file ? it.file.fsName : null) };`,
});
const replacedFileMatches = String(verifyReplace.text).indexOf("footage-b.png") !== -1;
assert(replacedFileMatches, "underlying file path actually changed to footage-b.png (verified via execute-script, not just the tool's success message)");

// ================= BLOCK 5: find-missing-footage sanity (best-effort; AE's missing-detection refresh timing is not something to hard-assert on) =================
const missingCheck = await call("find-missing-footage", {});
assert(missingCheck.parsed?.status === "success", "find-missing-footage returns a clean response");
console.log(`(informational, not asserted) missingCount reported: ${missingCheck.parsed?.missingCount}`);

await call("close-project", { saveFirst: false });

// ================= BLOCK 6: reduce-project - confirm gate, then actual reduction =================
await call("create-project", { saveFirst: false });
const importForReduceKeep = await call("import-footage", { filePath: path.join(ASSETS, "footage-a.png"), name: "KeptFootage" });
const importForReduceDrop = await call("import-footage", { filePath: path.join(ASSETS, "footage-b.png"), name: "DroppedFootage" });
await call("create-composition", { name: "KeepComp", width: 640, height: 360, frameRate: 30, duration: 5 });
await call("create-composition", { name: "DropComp", width: 640, height: 360, frameRate: 30, duration: 5 });
// Put KeptFootage into KeepComp so it's a real dependency; leave DroppedFootage and DropComp unused by KeepComp.
await call("execute-script", {
  script: `
    var keepComp = null, kept = null;
    for (var i = 1; i <= app.project.numItems; i++) {
      var it = app.project.item(i);
      if (it.name === "KeepComp") keepComp = it;
      if (it.name === "KeptFootage") kept = it;
    }
    keepComp.layers.add(kept);
    return { added: true };
  `,
});

const infoBeforeReduce = await call("run-script", { script: "getProjectInfo" });
const countBeforeReduce = infoBeforeReduce.parsed?.numItems;

const reduceNoConfirm = await call("reduce-project", { compNames: ["KeepComp"], confirm: false });
assert(reduceNoConfirm.parsed?.status === "error", "reduce-project without confirm:true refuses and does not touch the project");

const infoAfterRefusal = await call("run-script", { script: "getProjectInfo" });
assert(infoAfterRefusal.parsed?.numItems === countBeforeReduce, "project item count unchanged after the refused reduce-project call");

const reduceConfirmed = await call("reduce-project", { compNames: ["KeepComp"], confirm: true });
assert(reduceConfirmed.parsed?.status === "success", "reduce-project with confirm:true succeeded");

const infoAfterReduce = await call("run-script", { script: "getProjectInfo" });
assert(infoAfterReduce.parsed?.numItems < countBeforeReduce, `project item count decreased after reduce-project (before=${countBeforeReduce}, after=${infoAfterReduce.parsed?.numItems})`);
const remainingNames = (infoAfterReduce.parsed?.items || []).map((i) => i.name);
assert(remainingNames.indexOf("DropComp") === -1, "DropComp (unused by KeepComp) was actually removed");

// ================= BLOCK 7: collect-files - critically, confirm it does NOT repoint the live project =================
const scratchReducePath = path.join(SCRATCH_DIR, "scratch-reduce.aep");
const saveScratchReduce = await call("save-project", { filePath: scratchReducePath });
assert(saveScratchReduce.parsed?.status === "success", "reduce-project scratch project saved to a temp path before collect-files");

const collectOutput = path.join(SCRATCH_DIR, "collect-output");
const collectResult = await call("collect-files", { outputPath: collectOutput });
assert(collectResult.parsed?.status === "success", "collect-files succeeded");
assert(collectResult.parsed?.projectFileCopied === true, "collect-files copied the .aep file");
assert(fs.existsSync(path.join(collectOutput, "footage")), "footage subfolder was created in the output");

const infoAfterCollect = await call("run-script", { script: "getProjectInfo" });
// The critical assertion: the live project's path must still be exactly what it was
// saved to (scratchReducePath), never silently repointed to the collect-files output
// folder the way ishu86's app.project.save(newPath) approach would have done.
assert(
  infoAfterCollect.parsed?.path === scratchReducePath,
  "collect-files did NOT repoint the live project - path still matches what it was saved to (the ishu86 deviation, verified)",
);

await call("close-project", { saveFirst: false });

// ================= Restore the real project =================
const reopen = await call("open-project", { filePath: originalPath, saveFirst: false });
assert(reopen.parsed?.status === "success", "real project reopened");

const infoFinal = await call("run-script", { script: "getProjectInfo" });
assert(infoFinal.parsed?.path === originalPath, "restored project path matches original");

const compCheck = await call("inspect-comp", { compName: "Comp 1" });
assert(compCheck.parsed?.comp?.numLayers === 3, "restored 'Comp 1' has all 3 original layers");

console.log(`\n=== DONE: ${failures === 0 ? "ALL ASSERTIONS PASSED" : failures + " ASSERTION(S) FAILED"} ===`);
await client.close();
process.exit(failures === 0 ? 0 : 1);
