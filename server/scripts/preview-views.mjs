// PNG previews of the in-chat views with the test fixtures' data, dark and light, to compare with the approved
// mockup: each view runs in a small fake AI app (a page that hosts it in an iframe and answers the MCP Apps
// messages, with canned results for the view's own tool calls), screenshotted by headless Chrome. Nothing here
// talks to After Effects.
//
//   node scripts/preview-views.mjs <out-dir> [chrome]
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { buildViews } from "./views.mjs";

const out = process.argv[2];
if (!out) throw new Error("usage: node scripts/preview-views.mjs <out-dir> [chrome]");
const chrome = process.argv[3] || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
mkdirSync(out, { recursive: true });
const work = join(tmpdir(), `surehand-preview-${process.pid}`);
mkdirSync(work, { recursive: true });

// the fixtures' view data, made-up frames (JPEG, as the app-only tools send them) and the fonts, by the real code
const entry = `
import { fixtureInput, fixtureArgs } from "./test/fixtures/preflight-view.ts";
import { identical, differs, editChanges, historyFrom, historyTo } from "./test/fixtures/changes-view.ts";
import { preflightView } from "./src/preflight/view.ts";
import { proofView } from "./src/tools/prove.ts";
import { historyView } from "./src/tools/history.ts";
import { diffSnapshots } from "./src/history-diff.ts";
import { withFonts } from "./src/views/fonts.ts";
import { encodeJpeg } from "./src/jpeg.ts";
import { readFileSync } from "node:fs";
export const preflight = preflightView(fixtureInput);
export const preflightArgs = fixtureArgs;
export const proofIdentical = proofView(identical, { changes: editChanges });
export const proofDiffers = proofView(differs, { changes: editChanges });
export const history = historyView("/Jobs/Promo_Q4_v12.aep", { snapshot: historyFrom, current: false }, { snapshot: historyTo, current: true }, diffSnapshots(historyFrom, historyTo));
export const fonts = (html) => withFonts(html, (f) => readFileSync(new URL("../extension/fonts/" + f, ${JSON.stringify(pathToFileURL(process.cwd() + "/").href)})).toString("base64"));
const jpeg = (w, h, f) => {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = (y * w + x) * 4, c = f(x / w, y / h); px[p] = c[0]; px[p + 1] = c[1]; px[p + 2] = c[2]; px[p + 3] = 255; }
  return encodeJpeg(w, h, px, 80).toString("base64");
};
const grad = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const inBox = (x, y, b) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
// a 480x270 frame: a dark blue gradient, and a lower third (its box, in comp pixels) low in the frame
export function frame(box) {
  return jpeg(480, 270, (u, v) => {
    const X = u * 1920, Y = v * 1080;
    if (inBox(X, Y, box)) { const ix = (X - box[0]) / (box[2] - box[0]), iy = (Y - box[1]) / (box[3] - box[1]); return ix > 0.06 && ix < 0.66 && iy > 0.3 && iy < 0.48 ? [20, 20, 20] : [242, 239, 232]; }
    return grad([43, 58, 85], [18, 24, 32], (u + v) / 2);
  });
}
// before / after of the end card (a purple gradient and a logo bar), and their difference x50 (a small patch, or almost black)
export function proofStills(diff) {
  const card = (u, v) => (inBox(u, v, [0.3, 0.46, 0.7, 0.58]) ? [242, 239, 232] : grad([58, 43, 85], [18, 24, 32], (u + v) / 2));
  const heat = (u, v) => {
    const d = Math.hypot((u - 0.61) * 1.8, v - 0.34);
    return d < 0.07 ? (diff ? [232, 179, 74] : [40, 30, 12]).map((c) => c * (1 - d / 0.07)) : [8, 9, 11];
  };
  return [jpeg(320, 180, card), jpeg(320, 180, card), jpeg(320, 180, heat)];
}`;
const bundle = buildSync({ stdin: { contents: entry, resolveDir: process.cwd(), loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false, define: { __AEMCP_VERSION__: '"preview"', __AEMCP_CEP_FILES__: "{}", __AEMCP_CEP_BINARY__: "{}", __AEMCP_CEP_HASH__: '""', __SUREHAND_VIEWS__: '""' }, loader: { ".jsxinc": "text" }, alias: { "@babel/standalone": "@babel/standalone/babel.min.js" } }).outputFiles[0].text;
writeFileSync(join(work, "fixture.mjs"), "import { createRequire } from 'module'; const require = createRequire(import.meta.url);\n" + bundle);
const fx = await import(pathToFileURL(join(work, "fixture.mjs")).href);
const views = buildViews();

// the row the Preflight mockup shows open: the safe-area finding
const openRow = fx.preflight.findings.findIndex((f) => f.area);
const frameResult = { content: [{ type: "image", data: fx.frame(fx.preflight.findings[openRow].box), mimeType: "image/jpeg" }, { type: "text", text: "Frame" }] };
const stills = (diff) => ({ content: [...fx.proofStills(diff).map((data) => ({ type: "image", data, mimeType: "image/jpeg" })), { type: "text", text: "Frames" }] });

const PAGES = [
  { name: "preflight", view: "preflight", ask: "Check Main against our broadcast spec before I send it.", tool: "ae_preflight", data: fx.preflight, args: fx.preflightArgs, calls: { ae_view_frame: frameResult }, click: `[data-k="row${openRow}"]` },
  { name: "proof", view: "changes", ask: "Un-precompose Logo_Lockup and prove nothing changed on screen.", tool: "ae_prove_identical", data: fx.proofIdentical, calls: { ae_view_proof_frame: stills(false) } },
  { name: "proof-differs", view: "changes", ask: "Un-precompose Logo_Lockup and prove nothing changed on screen.", tool: "ae_prove_identical", data: fx.proofDiffers, calls: { ae_view_proof_frame: stills(true) } },
  { name: "history", view: "changes", ask: "What changed since the checkpoint?", tool: "ae_project_history", data: fx.history, calls: {} },
];

// the fake AI app: answers ui/initialize, sends the tool input and result, answers the view's tool calls
const host = (p, theme) => `<!doctype html><html><head><meta charset="utf-8"><style>
body { margin: 0; background: ${theme === "light" ? "#F5F4EF" : "#262624"}; color: ${theme === "light" ? "#1F1E1D" : "#E8E6E1"}; font: 14px/1.5 -apple-system, sans-serif; }
.chat { padding: 18px; } .bubble { margin: 0 0 10px; } .toolline { font: 12px Menlo, monospace; opacity: .65; margin: 0 0 8px; }
iframe { border: 0; width: 100%; display: block; }
</style></head><body><div class="chat"><p class="bubble">${p.ask}</p><p class="toolline">⚙ ${p.tool} · Surehand</p>
<iframe id="v"></iframe></div><script>
const data = ${JSON.stringify(p.data)}, args = ${JSON.stringify(p.args ?? {})}, calls = ${JSON.stringify(p.calls).replace(/<\//g, "<\\/")};
const f = document.getElementById("v");
f.srcdoc = ${JSON.stringify(fx.fonts(views[p.view])).replace(/<\//g, "<\\/")};
const post = (m) => f.contentWindow.postMessage({ jsonrpc: "2.0", ...m }, "*");
window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m || m.jsonrpc !== "2.0") return;
  if (m.method === "ui/initialize")
    post({ id: m.id, result: { protocolVersion: "2026-01-26", hostInfo: { name: "preview", version: "1" }, hostCapabilities: { serverTools: {}, message: {} }, hostContext: { theme: "${theme}", displayMode: "inline" } } });
  else if (m.method === "ui/notifications/initialized") {
    post({ method: "ui/notifications/tool-input", params: { arguments: args } });
    post({ method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: "report" }], _meta: { "surehand/view": data } } });
    ${p.click ? `setTimeout(() => f.contentDocument.querySelector('${p.click}').click(), 200);` : ""}
    // headless Chrome's virtual time doesn't always deliver the view's size-changed: measure it too
    for (const ms of [700, 2000]) setTimeout(() => (f.style.height = f.contentDocument.documentElement.scrollHeight + "px"), ms);
  } else if (m.method === "ui/notifications/size-changed") f.style.height = m.params.height + "px";
  else if (m.method === "tools/call" && calls[m.params.name]) post({ id: m.id, result: calls[m.params.name] });
  else if (m.id !== undefined) post({ id: m.id, result: {} });
});
</script></body></html>`;

for (const p of PAGES)
  for (const theme of ["dark", "light"]) {
    const page = join(work, `${p.name}-${theme}.html`), png = join(out, `${p.name}-${theme}.png`);
    writeFileSync(page, host(p, theme));
    const r = spawnSync(chrome, ["--headless=new", "--disable-gpu", "--enable-logging=stderr", "--v=0", "--hide-scrollbars", "--force-device-scale-factor=2", "--window-size=760,1080", "--virtual-time-budget=4000", `--screenshot=${png}`, pathToFileURL(page).href], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`Chrome failed: ${r.stderr}`);
    // the pages' console errors (e.g. a view that didn't start)
    for (const l of r.stderr.split("\n")) if (process.env.PREVIEW_DEBUG ? /CONSOLE/.test(l) : /CONSOLE.*(error|Uncaught)/i.test(l)) console.error(l.slice(0, 500));
    console.log(png);
    // the fake AI app pages too, to click around in a browser
    if (theme === "dark") writeFileSync(join(out, `${p.name}-host.html`), host(p, theme));
  }
rmSync(work, { recursive: true, force: true });
