// End-to-end smoke test against a running After Effects: node scripts/smoke.mjs [path/to/surehand-ae.mjs]
// Safe to run with a real project open: it only touches items it creates (named "__aemcp_smoke...")
// and removes them at the end. Pass --with-undo to also test ae_undo/ae_redo (affects AE's undo history).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const serverPath = process.argv.slice(2).find((a) => !a.startsWith("--")) || fileURLToPath(new URL("../dist/surehand-ae.mjs", import.meta.url));
const client = new Client({ name: "aemcp-smoke", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath, "--tools", "full"] }));

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
// remember the project state, so cleanup only ever touches items created by this test
const before = await client.callTool({ name: "ae_run_script", arguments: { undoGroup: "", report: false, code: "var m = 0; for (var i = 1; i <= app.project.numItems; i++) m = Math.max(m, app.project.item(i).id); return { n: app.project.numItems, maxId: m };" } });
const { n: itemsBefore, maxId } = JSON.parse(before.content[0].text);
await call("ae_status");
await call("ae_run_script", { code: "return app.project.numItems + 1;" });
await call("ae_run_script", { code: "log('hello', [1,2]);\nvar x = ;" }, true);
await call("ae_run_script", { code: "var a = 1;\nnull.foo();" }, true);
const comp = await call("ae_create_comp", { name: "__aemcp_smoke", width: 1920, height: 1080, duration: 5, frameRate: 25, bgColor: "#101820" });
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
await call("ae_precompose", { layers: ["Dot"], name: "__aemcp_smoke_precomp" });
await call("ae_set_comp_settings", { time: 1.2 });
await call("ae_find_properties", { query: "opacity" });
await call("ae_find_properties", { onlyExpressions: true });
await call("ae_get_effect_params", { effect: "ADBE Drop Shadow" });
await call("ae_get_effect_params", { effect: "Drop Shadow", layer: "Hello After Effects" }); // AE renames text layers to their text
await call("ae_get_layer_bounds", {});
await call("ae_get_comp_map", {});
await call("ae_sample_pixels", { points: [[960, 540], [5, 5]] });
await call("ae_render_frame", { region: [760, 340, 400, 400], background: "checkerboard", maxSize: 512 });
await call("ae_render_frame", { layers: [1], compareWith: { time: 0 }, maxSize: 512 });
await call("ae_run_script", { code: "const names = [];\nfor (let i = 1; i <= app.project.activeItem.numLayers; i++) names.push(app.project.activeItem.layer(i).name);\nreturn names.filter((n) => n.length > 2).map((n) => n.toUpperCase()) ?? [];" });
await call("ae_run_script", { code: "const x = 1;\nreturn app.project.item(0).name;" }, true);
const sheet = await call("ae_render_contact_sheet", { frames: 6, columns: 3, width: 1200 });
const sheetImg = sheet.content.find((c) => c.type === "image");
if (sheetImg) writeFileSync(new URL("./smoke-sheet.png", import.meta.url), Buffer.from(sheetImg.data, "base64"));
const frame = await call("ae_render_frame", { time: 1.2, maxSize: 960 });
const img = frame.content.find((c) => c.type === "image");
if (img) writeFileSync(new URL("./smoke-frame.png", import.meta.url), Buffer.from(img.data, "base64"));
await call("ae_add_to_render_queue", { outputPath: "/tmp/aemcp-smoke.mov" });
await call("ae_list_render_queue");
// remove only our own render queue item
await call("ae_run_script", { code: "var rq = app.project.renderQueue; for (var i = rq.numItems; i >= 1; i--) if (rq.item(i).comp.name === '__aemcp_smoke') rq.item(i).remove(); return rq.numItems;" });
await call("ae_get_fonts", { nameContains: "arial", limit: 3 });
await call("ae_system_info");
if (process.argv.includes("--with-undo")) {
  await call("ae_undo");
  await call("ae_redo");
}
await call("ae_execute_menu_command", { command: "Deselect All" });
await call("ae_status");
await call("ae_get_layer_info", { layer: "does not exist" }, true);
await call("ae_get_scripting_guide");
// clean up everything we created
const cleanup = await client.callTool({ name: "ae_run_script", arguments: { undoGroup: "Surehand MCP smoke cleanup", report: false, code: `
var p = app.project, gone = [];
for (var i = p.numItems; i >= 1; i--) {
  var it = p.item(i);
  if (it.id > args.maxId && it.name.indexOf("__aemcp_smoke") === 0) { gone.push(it.name); it.remove(); }
}
// solids created by the test comps live in a "Solids" folder: remove the unused ones we made
for (var j = p.numItems; j >= 1; j--) {
  var s = p.item(j);
  if (s.id > args.maxId && s instanceof FootageItem && s.usedIn.length === 0 && s.mainSource instanceof SolidSource) { gone.push(s.name); s.remove(); }
}
// a "Solids" folder created by this test, if now empty
for (var k = p.numItems; k >= 1; k--) { var f = p.item(k); if (f.id > args.maxId && f instanceof FolderItem && f.numItems === 0) { gone.push(f.name); f.remove(); } }
return { removed: gone.length, numItems: p.numItems };`, args: { maxId } } });
console.log("cleanup:", cleanup.content[0].text.replace(/\s+/g, " "));
const after = Number(JSON.parse(cleanup.content[0].text).numItems);
if (after !== itemsBefore) { failures++; console.log(`FAIL project item count changed: ${itemsBefore} -> ${after}`); }
console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASSED");
await client.close();
process.exit(failures ? 1 : 0);
