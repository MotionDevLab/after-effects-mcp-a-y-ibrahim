import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  cwd: "C:\\Users\\renat\\after-effects-mcp-a-y-ibrahim",
  stderr: "pipe",
});

const client = new Client({ name: "frame-index-param-test", version: "1.0.0" });
await client.connect(transport);
transport.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));

let stepNum = 0;
let failures = 0;
async function call(name, args = {}) {
  stepNum++;
  console.log(`\n=== STEP ${stepNum}: ${name} ${JSON.stringify(args)} ===`);
  const res = await client.callTool({ name, arguments: args });
  const textBlock = res.content?.find((b) => b.type === "text");
  const imageBlocks = res.content?.filter((b) => b.type === "image") || [];
  console.log(`(text: ${textBlock?.text?.slice(0, 300) ?? "none"}) (imageBlocks: ${imageBlocks.length})`);
  return { res, textBlock, imageCount: imageBlocks.length };
}
function assert(cond, msg) {
  if (!cond) { console.log(`!!! FAILED: ${msg}`); failures++; }
  else console.log(`OK: ${msg}`);
}

// see-frame is read-only (renders to a transient temp PNG, cleans up any
// temp comp it creates) - safe to run directly against whatever project is
// currently open, no scratch-project swap needed.
const info = await call("run-script", { script: "getProjectInfo" });

// This fork's own test project's "Comp 1" runs at 29.97 fps (confirmed
// earlier this session) - a good non-round-rate case to actually exercise
// the rounding-avoidance this param exists for.
const byTime = await call("see-frame", { comp: 1, times: 1, maxWidth: 64 });
assert(byTime.imageCount === 1, "see-frame with times:1 returns one image (baseline, unchanged behavior)");

const byFrame = await call("see-frame", { comp: 1, frameNumbers: 30, maxWidth: 64 });
assert(byFrame.imageCount === 1, "see-frame with frameNumbers:30 (~1s at 29.97fps) returns one image");

const combined = await call("see-frame", { comp: 1, times: [0], frameNumbers: [30, 60], maxWidth: 64 });
assert(combined.imageCount === 3, `times and frameNumbers combine into one capture list (got ${combined.imageCount} images)`);

const arrayForm = await call("see-frame", { comp: 1, frameNumbers: [0, 15], maxWidth: 64 });
assert(arrayForm.imageCount === 2, "frameNumbers accepts an array, same as times does");

console.log(`\n=== DONE: ${failures === 0 ? "ALL ASSERTIONS PASSED" : failures + " FAILED"} ===`);
await client.close();
process.exit(failures === 0 ? 0 : 1);
