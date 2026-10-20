// PNG previews of the in-chat views with the test fixture's data, dark and light, to compare with the approved
// mockup: each view runs in a small fake AI app (a page that hosts it in an iframe and answers the MCP Apps
// messages), screenshotted by headless Chrome. Nothing here talks to After Effects.
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

// the fixture's view data, a made-up frame (JPEG, as ae_view_frame sends it) and the fonts, computed by the real code
const entry = `
import { fixtureInput, fixtureArgs } from "./test/fixtures/preflight-view.ts";
import { preflightView } from "./src/preflight/view.ts";
import { withFonts } from "./src/views/fonts.ts";
import { encodeJpeg } from "./src/jpeg.ts";
import { readFileSync } from "node:fs";
export const data = preflightView(fixtureInput);
export const args = fixtureArgs;
export const fonts = (html) => withFonts(html, (f) => readFileSync(new URL("../extension/fonts/" + f, ${JSON.stringify(pathToFileURL(process.cwd() + "/").href)})).toString("base64"));
// a 480x270 frame: a dark blue gradient, and a lower third (its box from the finding) low in the frame
export function frame(box) {
  const w = 480, h = 270, s = w / 1920, px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2, p = (y * w + x) * 4;
      let r = 43 + (18 - 43) * t, g = 58 + (24 - 58) * t, b = 85 + (32 - 85) * t;
      const X = x / s, Y = y / s;
      if (X >= box[0] && X <= box[2] && Y >= box[1] && Y <= box[3]) {
        r = 242; g = 239; b = 232;
        const ix = (X - box[0]) / (box[2] - box[0]), iy = (Y - box[1]) / (box[3] - box[1]);
        if (ix > 0.06 && ix < 0.66 && iy > 0.3 && iy < 0.48) r = g = b = 20;
      }
      px[p] = r; px[p + 1] = g; px[p + 2] = b; px[p + 3] = 255;
    }
  return encodeJpeg(w, h, px, 80).toString("base64");
}`;
const bundle = buildSync({ stdin: { contents: entry, resolveDir: process.cwd(), loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false }).outputFiles[0].text;
writeFileSync(join(work, "fixture.mjs"), bundle);
const fx = await import(pathToFileURL(join(work, "fixture.mjs")).href);

const html = fx.fonts(buildViews().preflight);
// the row the mockup shows open: the safe-area finding
const openRow = fx.data.findings.findIndex((f) => f.area);
const frameB64 = fx.frame(fx.data.findings[openRow].box);

// the fake AI app: answers ui/initialize, sends the tool input and result, serves ae_view_frame, opens the first row
const host = (theme) => `<!doctype html><html><head><meta charset="utf-8"><style>
body { margin: 0; background: ${theme === "light" ? "#F5F4EF" : "#262624"}; color: ${theme === "light" ? "#1F1E1D" : "#E8E6E1"}; font: 14px/1.5 -apple-system, sans-serif; }
.chat { padding: 18px; } .bubble { margin: 0 0 10px; } .toolline { font: 12px Menlo, monospace; opacity: .65; margin: 0 0 8px; }
iframe { border: 0; width: 100%; display: block; }
</style></head><body><div class="chat"><p class="bubble">Check Main against our broadcast spec before I send it.</p><p class="toolline">⚙ ae_preflight · Surehand</p>
<iframe id="v"></iframe></div><script>
const data = ${JSON.stringify(fx.data)}, args = ${JSON.stringify(fx.args)}, frame = ${JSON.stringify(frameB64)};
const f = document.getElementById("v");
f.srcdoc = ${JSON.stringify(html).replace(/<\//g, "<\\/")};
const post = (m) => f.contentWindow.postMessage({ jsonrpc: "2.0", ...m }, "*");
window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m || m.jsonrpc !== "2.0") return;
  if (m.method === "ui/initialize")
    post({ id: m.id, result: { protocolVersion: "2026-01-26", hostInfo: { name: "preview", version: "1" }, hostCapabilities: { serverTools: {}, message: {} }, hostContext: { theme: "${theme}", displayMode: "inline" } } });
  else if (m.method === "ui/notifications/initialized") {
    post({ method: "ui/notifications/tool-input", params: { arguments: args } });
    post({ method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: data.verdictLine }], _meta: { "surehand/view": data } } });
    setTimeout(() => f.contentDocument.querySelector('[data-k="row${openRow}"]').click(), 200);
    // headless Chrome's virtual time doesn't always deliver the view's size-changed: measure it too
    for (const ms of [700, 2000]) setTimeout(() => (f.style.height = f.contentDocument.documentElement.scrollHeight + "px"), ms);
  } else if (m.method === "ui/notifications/size-changed") f.style.height = m.params.height + "px";
  else if (m.method === "tools/call" && m.params.name === "ae_view_frame")
    post({ id: m.id, result: { content: [{ type: "image", data: frame, mimeType: "image/jpeg" }, { type: "text", text: "Frame" }], _meta: { "surehand/view": { view: "frame", comp: "Main", time: 12.4, compWidth: 1920, compHeight: 1080, width: 480, height: 270 } } } });
  else if (m.id !== undefined) post({ id: m.id, result: {} });
});
</script></body></html>`;

for (const theme of ["dark", "light"]) {
  const page = join(work, `preflight-${theme}.html`), png = join(out, `preflight-${theme}.png`);
  writeFileSync(page, host(theme));
  const r = spawnSync(chrome, ["--headless=new", "--disable-gpu", "--enable-logging=stderr", "--v=0", "--hide-scrollbars", "--force-device-scale-factor=2", "--window-size=760,1080", "--virtual-time-budget=4000", `--screenshot=${png}`, pathToFileURL(page).href], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`Chrome failed: ${r.stderr}`);
  // the pages' console errors (e.g. a view that didn't start)
  for (const l of r.stderr.split("\n")) if (process.env.PREVIEW_DEBUG ? /CONSOLE/.test(l) : /CONSOLE.*(error|Uncaught)/i.test(l)) console.error(l.slice(0, 500));
  console.log(png);
}
rmSync(work, { recursive: true, force: true });
// the fake AI app page too, to click around in a browser
writeFileSync(join(out, "preflight-host.html"), host("dark"));
