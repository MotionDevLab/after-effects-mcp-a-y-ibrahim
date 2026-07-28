import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  cwd: "C:\\Users\\renat\\after-effects-mcp-a-y-ibrahim",
  stderr: "pipe",
});

const client = new Client({ name: "keyframe-test", version: "1.0.0" });
await client.connect(transport);
transport.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));

async function call(name, args = {}) {
  console.log(`\n=== ${name} ${JSON.stringify(args)} ===`);
  try {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content?.[0]?.text ?? JSON.stringify(res).slice(0, 400);
    console.log(String(text).slice(0, 4000));
    return res;
  } catch (e) {
    console.log("EXCEPTION:", e.message);
  }
}

// Keyframe 1: Position at t=0
await call("setLayerKeyframe", {
  compIndex: 1,
  layerIndex: 1,
  propertyName: "Position",
  timeInSeconds: 0,
  value: [200, 200],
});

// Keyframe 2: Position at t=2
await call("setLayerKeyframe", {
  compIndex: 1,
  layerIndex: 1,
  propertyName: "Position",
  timeInSeconds: 2,
  value: [1720, 880],
});

// Also test Opacity keyframe
await call("setLayerKeyframe", {
  compIndex: 1,
  layerIndex: 1,
  propertyName: "Opacity",
  timeInSeconds: 0,
  value: 0,
});
await call("setLayerKeyframe", {
  compIndex: 1,
  layerIndex: 1,
  propertyName: "Opacity",
  timeInSeconds: 1,
  value: 100,
});

// Verify via inspect-layer
await call("inspect-layer", { compIndex: 1, layerIndex: 1, includeKeyframes: true });

await client.close();
process.exit(0);
