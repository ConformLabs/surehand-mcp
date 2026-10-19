// What moves app.project.revision? Runs harmless actions and edits one by one against every After
// Effects open here (or on a PC over SSH) and prints a table: "same" or "moved" per action.
// Read-only mode trusts an unchanged revision to mean "no property changed" (aemcp.jsxinc).
//
//   npm run revision-matrix                       (every After Effects open on this computer)
//   npm run revision-matrix -- --ssh ron-pc       (the After Effects open on a PC, over SSH)
//   npm run revision-matrix -- --guided           (also asks you to click/type in AE, step by step)
//
// It works in temporary comps named __aemcp_rev* and removes them afterwards. To keep your work
// safe it only runs in an empty project (File > New > New Project), unless you pass --any-project.
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const argv = process.argv.slice(2);
const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const sshHost = opt("--ssh");
const guided = argv.includes("--guided");
const anyProject = argv.includes("--any-project");
const SSH = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- where After Effects is ----------
let token, targets = [], tunnel = null;
if (sshHost) {
  const ps = (cmd) => spawnSync("ssh", [...SSH, sshHost, `powershell -NoProfile -Command "${cmd}"`], { encoding: "utf8" }).stdout || "";
  token = JSON.parse(ps("Get-Content $env:USERPROFILE\\.surehand\\ae\\config.json -Raw")).token;
  const ports = ps("Get-ChildItem $env:USERPROFILE\\.surehand\\ae\\instances\\*.json -ErrorAction SilentlyContinue | ForEach-Object { (Get-Content $_ -Raw | ConvertFrom-Json).port }")
    .split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
  const fwd = ports.flatMap((p, i) => ["-L", `${28700 + i}:127.0.0.1:${p}`]);
  if (ports.length) {
    tunnel = spawn("ssh", [...SSH, "-N", ...fwd, sshHost], { stdio: "ignore" });
    await sleep(2500);
  }
  targets = ports.map((p, i) => ({ port: 28700 + i, where: `${sshHost}:${p}` }));
} else {
  token = JSON.parse(readFileSync(join(homedir(), ".surehand", "ae", "config.json"), "utf8")).token;
  try {
    targets = readdirSync(join(homedir(), ".surehand", "ae", "instances")).filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(homedir(), ".surehand", "ae", "instances", f), "utf8")).port).map((port) => ({ port, where: `port ${port}` }));
  } catch {}
}

async function ev(port, script) {
  const r = await fetch(`http://127.0.0.1:${port}/eval`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ script, timeoutMs: 60000, label: "revision matrix" }),
  });
  const j = await r.json();
  if (j.ok === false) throw new Error(j.error);
  return j.result;
}

// ---------- the actions ----------
const C = 'var p=app.project,c=null;for(var i=1;i<=p.numItems;i++)if(p.item(i).name==="__aemcp_rev")c=p.item(i);var L1=c.layer(1),L2=c.layer(2),T=c.layer(3);';
// harmless: these must NOT move revision
const HARMLESS = [
  ["read-only script (every layer and property: value, valueAtTime, keys, expression, text)", 'var n=0;for(var i=1;i<=p.numItems;i++){var it=p.item(i);if(!(it instanceof CompItem))continue;for(var j=1;j<=it.numLayers;j++){var L=it.layer(j),g=L.property("ADBE Transform Group");for(var q=1;q<=g.numProperties;q++){var pr=g.property(q);try{pr.value;pr.valueAtTime(0.5,false);pr.numKeys;pr.expression;}catch(e){}}if(L instanceof TextLayer){L.sourceRectAtTime(0,false);L.property("ADBE Text Properties").property("ADBE Text Document").value.text;}}}'],
  ["empty undo group (what read-only mode wraps scripts in)", 'app.beginUndoGroup("Surehand MCP Script (read-only check)");app.endUndoGroup();'],
  ["open the comp in the viewer", "c.openInViewer();"],
  ["move the time indicator (comp.time)", "c.time=2;"],
  ["select a layer", "L2.selected=true;"],
  ["select an item in the Project panel", "c.selected=true;"],
  ["Edit > Select All / Deselect All", 'c.openInViewer();app.executeCommand(app.findMenuCommandId("Select All"));app.executeCommand(app.findMenuCommandId("Deselect All"));'],
];
// edits: "moved" expected; the ones marked false are known not to move it (the change report still compares them)
const EDITS = [
  ["layer name", 'L1.name="renamed";', true], ["property value", 'L1.property("ADBE Transform Group").property("ADBE Opacity").setValue(50);', true],
  ["keyframe", 'L1.property("ADBE Transform Group").property("ADBE Position").setValueAtTime(1,[5,5]);', true],
  ["expression", 'L1.property("ADBE Transform Group").property("ADBE Rotate Z").expression="time*10";', true],
  ["effect", 'L1.property("ADBE Effect Parade").addProperty("ADBE Gaussian Blur 2");', true],
  ["text", 'var td=T.property("ADBE Text Properties").property("ADBE Text Document"),v=td.value;v.text="changed";td.setValue(v);', true],
  ["layer switch (shy)", "L1.shy=true;", true], ["comp size", "c.width=642;", true],
  ["Edit > Undo (of the comp size)", "app.executeCommand(16);", true], ["blend mode (moves it on most layers)", "L2.blendingMode=BlendingMode.ADD;", null],
  ["item comment", 'c.comment="x";', false], ["item label", "c.label=5;", false], ["comp work area", "c.workAreaStart=1;", false],
  ["project expression engine", 'p.expressionEngine=p.expressionEngine==="javascript-1.0"?"extendscript":"javascript-1.0";', false],
];
const GUIDED = [
  "click a layer in the timeline", "press Page Down a few times (time indicator)", "double-click another comp in the Project panel",
  "click an item in the Project panel", "press Space twice (preview start/stop)", "scroll/zoom the timeline",
];

async function matrix({ port, where }) {
  const rows = [];
  const version = await ev(port, "app.version");
  const state = JSON.parse(await ev(port, '(function(){var p=app.project,m=0;for(var i=1;i<=p.numItems;i++)m=Math.max(m,p.item(i).id);return "{\\"items\\":"+p.numItems+",\\"maxId\\":"+m+",\\"engine\\":\\""+p.expressionEngine+"\\",\\"rev\\":"+(typeof p.revision==="number"?p.revision:-1)+"}";})()'));
  console.log(`\n== After Effects ${version} (${where})`);
  if (state.rev < 0) return console.log("  this After Effects has no app.project.revision: read-only mode keeps the full snapshot");
  if (state.items && !anyProject) return console.log(`  skipped: the open project has ${state.items} item(s). Open an empty project (File > New > New Project) or pass --any-project.`);
  await ev(port, 'app.beginUndoGroup("rev setup");var a=app.project.items.addComp("__aemcp_rev",640,360,1,10,25),b=app.project.items.addComp("__aemcp_rev_2",640,360,1,10,25);a.layers.addText("t");a.layers.addSolid([0,1,0],"__aemcp_rev B",64,64,1);a.layers.addSolid([1,0,0],"__aemcp_rev A",64,64,1);b.layers.addNull();app.endUndoGroup();"ok"');
  const rev = async () => Number(await ev(port, "app.project.revision"));
  const one = async (kind, name, code, expect) => {
    const a = await rev();
    let note = "";
    try {
      // errors come back as text: an uncaught one would look like an empty result
      const r = await ev(port, `(function(){try{${C}${code}return "ok";}catch(e){return "error: "+e.message;}})()`);
      if (r !== "ok") note = String(r).slice(0, 90);
    } catch (e) {
      note = "error: " + e.message.slice(0, 80);
    }
    await sleep(300);
    const b = await rev();
    const moved = b !== a;
    const bad = expect !== null && moved !== expect;
    rows.push([kind, name, moved ? `moved (+${b - a})` : "same", bad ? "UNEXPECTED" : "", note]);
  };
  for (const [n, code] of HARMLESS) await one("harmless", n, code, false);
  for (const [n, code, expect] of EDITS) await one("edit", n, code, expect);
  if (guided) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    for (const g of GUIDED) {
      const a = await rev();
      const ans = await rl.question(`  In After Effects ${version}: ${g}, then press Enter here (s = skip): `);
      if (ans.trim() === "s") continue;
      const b = await rev();
      rows.push(["by hand", g, b !== a ? `moved (+${b - a})` : "same", b !== a ? "UNEXPECTED" : "", ""]);
    }
    rl.close();
  }
  // remove everything created here (newer ids), put the expression engine back
  await ev(port, `(function(){var p=app.project;for(var i=p.numItems;i>=1;i--){var it=p.item(i);if(it.id>${state.maxId})it.remove();}p.expressionEngine=${JSON.stringify(state.engine)};return "ok";})()`);
  console.log("\n| | action | revision | | note |\n|---|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.join(" | ")} |`);
  return rows.filter((r) => r[3]).length;
}

let unexpected = 0;
try {
  if (!targets.length) console.log(sshHost ? `No After Effects open on ${sshHost}.` : "No After Effects open here.");
  for (const t of targets) unexpected += (await matrix(t)) || 0;
} finally {
  tunnel?.kill();
}
console.log(unexpected ? `\n${unexpected} unexpected result(s): read-only mode's fast path needs another look.` : "\nNo unexpected results.");
process.exit(unexpected ? 1 : 0);
