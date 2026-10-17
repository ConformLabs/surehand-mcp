// End-to-end smoke test against a running After Effects: node scripts/smoke.mjs [path/to/ae-mcp.mjs]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const serverPath = process.argv[2] || fileURLToPath(new URL("../dist/ae-mcp.mjs", import.meta.url));
const client = new Client({ name: "aemcp-smoke", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath] }));

let failures = 0;
async function call(name, args = {}, expectError = false) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const bad = !!r.isError !== expectError;
  if (bad) failures++;
  console.log(`${bad ? "FAIL" : "ok  "} ${name} (${Date.now() - t0}ms) ${text.replace(/\s+/g, " ").slice(0, 220)}`);
  return r;
}

const { tools } = await client.listTools();
console.log(`${tools.length} tools`);
await call("ae_status");
await call("ae_run_script", { code: "return app.project.numItems + 1;" });
await call("ae_run_script", { code: "log('hello', [1,2]);\nvar x = ;" }, true);
await call("ae_run_script", { code: "var a = 1;\nnull.foo();" }, true);
const comp = await call("ae_create_comp", { name: "AEMCP Smoke", width: 1920, height: 1080, duration: 5, frameRate: 25, bgColor: "#101820" });
await call("ae_add_layer", { type: "solid", name: "BG", color: "#203040" });
await call("ae_add_layer", { type: "text", text: "Hello MCP", fontSize: 140, fillColor: "#ffcc00", justification: "CENTER_JUSTIFY", position: [960, 540] });
await call("ae_set_keyframes", { layer: "Hello MCP", path: "Transform/Scale", keyframes: [{ time: 0, value: [0, 0, 100] }, { time: 1, value: [100, 100, 100], easeIn: 80 }], easyEase: true });
await call("ae_set_keyframes", { layer: "Hello MCP", path: "Transform/Position", keyframes: [{ time: 0, value: [960, 700] }, { time: 1, value: [960, 540] }], easyEase: true });
await call("ae_set_property", { layer: "Hello MCP", path: "Transform/Opacity", value: 90 });
await call("ae_set_expression", { layer: "Hello MCP", path: "Transform/Rotation", expression: "wiggle(1, 3)" });
await call("ae_set_expression", { layer: "BG", path: "Transform/Rotation", expression: "thisIsBroken(" });
await call("ae_apply_effect", { layer: "Hello MCP", effect: "ADBE Drop Shadow", params: { Distance: 12, Softness: 20 } });
await call("ae_apply_effect", { layer: "BG", effect: "Gradient Ramp" });
await call("ae_add_shape", { shape: "ellipse", size: [300, 300], fill: "#ff3366", stroke: "#ffffff", strokeWidth: 6, name: "Dot" });
await call("ae_add_shape", { shape: "star", points: 5, outerRadius: 120, fill: [0.2, 0.8, 0.4] });
await call("ae_add_mask", { layer: "BG", shape: "ellipse", rect: [200, 100, 1520, 880], feather: 200 });
await call("ae_add_layer", { type: "null", name: "Ctrl" });
await call("ae_set_layer_attributes", { layer: "Dot", parent: "Ctrl", blendingMode: "SCREEN", label: 9 });
await call("ae_add_comp_marker", { time: 1, comment: "title in" });
await call("ae_get_layer_info", { layer: "Hello MCP" });
await call("ae_get_properties", { layer: "Hello MCP", path: "Transform", depth: 1, keyframes: true });
await call("ae_get_expressions", {});
await call("ae_get_comp_info", {});
await call("ae_list_items", { type: "comp" });
await call("ae_list_available_effects", { nameContains: "blur", limit: 5 });
await call("ae_get_selection");
await call("ae_set_text", { layer: "Hello MCP", text: "Hello After Effects", fontSize: 120 });
await call("ae_precompose", { layers: ["Dot"], name: "Dot Precomp" });
await call("ae_set_comp_settings", { time: 1.2 });
const frame = await call("ae_render_frame", { time: 1.2, maxSize: 960 });
const img = frame.content.find((c) => c.type === "image");
if (img) writeFileSync(new URL("./smoke-frame.png", import.meta.url), Buffer.from(img.data, "base64"));
await call("ae_add_to_render_queue", { outputPath: "/tmp/aemcp-smoke.mov" });
await call("ae_list_render_queue");
await call("ae_clear_render_queue");
await call("ae_get_fonts", { nameContains: "arial", limit: 3 });
await call("ae_system_info");
await call("ae_undo");
await call("ae_redo");
await call("ae_execute_menu_command", { command: "Deselect All" });
await call("ae_get_layer_info", { layer: "does not exist" }, true);
await call("ae_get_scripting_guide");
console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASSED");
await client.close();
process.exit(failures ? 1 : 0);
