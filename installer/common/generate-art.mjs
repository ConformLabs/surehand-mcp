// Renders an app's installer artwork in the Conform Labs frame from its logo SVGs and accent (installer/app.json):
//
//   Windows (NSIS)  <out.windows>/wizard-<w>.bmp   welcome/finish sidebar, 24-bit BMP, one per WIZARD_SIZES entry
//                   <out.windows>/header-<w>.bmp   page header image, one per HEADER_SIZES entry
//   Mac (pkg)       <out.mac>/background-dark.tiff, background-light.tiff   180x180 with a 360x360 @2x image
//
//   node installer/common/generate-art.mjs [--app installer/app.json] [--preview <dir>]
//
// --preview also writes PNGs of every image and of the Mac welcome/conclusion pages (light and dark) for review.
// Needs Google Chrome or Chromium (headless; set CHROME=/path/to/chrome) to draw the SVGs; the Mac images also need
// sips and tiffutil (macOS). Uses Node.js built-ins only. The output is committed; re-run it when the logo changes.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { COLORS, HEADER_SIZES, ROOT, WIZARD_SIZES, loadApp, macPage } from "./frame.mjs";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const app = loadApp(arg("--app") ? resolve(arg("--app")) : undefined);
const preview = arg("--preview") ? resolve(arg("--preview")) : undefined;
const winOut = join(ROOT, app.out?.windows ?? "installer/windows/nsis/art");
const macOut = join(ROOT, app.out?.mac ?? "installer/mac/pkg/resources");

// ---------- headless Chrome ----------
const CHROME = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => p && existsSync(p));
if (!CHROME) throw new Error("Google Chrome or Chromium not found (set CHROME=/path/to/chrome)");

const tmp = mkdtempSync(join(tmpdir(), "cl-art-"));
let n = 0;
function screenshot(page, w, h, { scale = 1, transparent = false, dark = false } = {}) {
  const htmlFile = join(tmp, `p${++n}.html`);
  const png = join(tmp, `p${n}.png`);
  writeFileSync(htmlFile, page);
  const r = spawnSync(CHROME, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
    "--allow-file-access-from-files", `--user-data-dir=${join(tmp, "profile")}`,
    `--force-device-scale-factor=${scale}`, `--window-size=${w},${h}`,
    ...(transparent ? ["--default-background-color=00000000"] : []),
    ...(dark ? ["--force-dark-mode", "--blink-settings=preferredColorScheme=0"] : ["--blink-settings=preferredColorScheme=1"]),
    `--screenshot=${png}`, `file://${htmlFile}`,
  ], { encoding: "utf8", timeout: 60_000 });
  if (!existsSync(png)) throw new Error(`Chrome did not render ${htmlFile}:\n${r.stderr}`);
  const img = decodePng(readFileSync(png));
  if (img.w !== Math.round(w * scale) || img.h !== Math.round(h * scale)) throw new Error(`Chrome rendered ${img.w}x${img.h}, expected ${w * scale}x${h * scale}`);
  return { ...img, png: readFileSync(png) };
}

// ---------- PNG (8-bit RGB/RGBA, non-interlaced) -> RGBA ----------
function decodePng(buf) {
  let w = 0, h = 0, type = 0;
  const idat = [];
  for (let p = 8; p < buf.length; ) {
    const len = buf.readUInt32BE(p), kind = buf.toString("latin1", p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (kind === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4); type = data[9];
      if (data[8] !== 8 || (type !== 6 && type !== 2) || data[12] !== 0) throw new Error("unsupported PNG");
    } else if (kind === "IDAT") idat.push(data);
    p += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3, stride = w * bpp, raw = inflateSync(Buffer.concat(idat)), out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      line[i] = (line[i] + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]) & 255;
    }
    for (let x = 0; x < w; x++) {
      for (let k = 0; k < bpp; k++) out[(y * w + x) * 4 + k] = line[x * bpp + k];
      if (bpp === 3) out[(y * w + x) * 4 + 3] = 255;
    }
    prev = line;
  }
  return { w, h, rgba: out };
}

// ---------- RGBA -> 24-bit BMP (bottom-up), composited on an opaque background ----------
function bmp24({ w, h, rgba }, bg) {
  const [br, bgG, bb] = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16));
  const rowSize = Math.ceil((w * 3) / 4) * 4, size = 54 + rowSize * h, b = Buffer.alloc(size);
  b.write("BM", 0, "latin1"); b.writeUInt32LE(size, 2); b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14); b.writeInt32LE(w, 18); b.writeInt32LE(h, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28);
  b.writeUInt32LE(rowSize * h, 34); b.writeInt32LE(2835, 38); b.writeInt32LE(2835, 42);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = (y * w + x) * 4, a = rgba[s + 3] / 255, d = 54 + (h - 1 - y) * rowSize + x * 3;
    b[d] = Math.round(rgba[s + 2] * a + bb * (1 - a));
    b[d + 1] = Math.round(rgba[s + 1] * a + bgG * (1 - a));
    b[d + 2] = Math.round(rgba[s] * a + br * (1 - a));
  }
  return b;
}

// ---------- artwork ----------
const svgUri = (file, recolor) => {
  let svg = readFileSync(join(ROOT, file), "utf8");
  if (recolor) svg = svg.replace(/fill="#[0-9A-Fa-f]{6}"/g, `fill="${recolor}"`);
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
};
const ENDORSEMENT = { dark: "brand/conformlabs-endorsement-reversed.svg", light: "brand/conformlabs-endorsement.svg" };
const doc = (body, bg = "transparent") =>
  `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${bg}}img{position:absolute;display:block}</style></head><body>${body}</body></html>`;

// welcome/finish sidebar: the app's logo on the header colour, the Conform Labs endorsement at the bottom, a hairline
// on the right edge
function wizardPage(w, h) {
  const s = w / 164, logo = Math.round(112 * s), line = Math.max(1, Math.round(s)), endorse = Math.round(132 * s);
  return doc(`<img src="${svgUri(app.logo.dark)}" style="width:${logo}px;height:${logo}px;left:${Math.round((w - line - logo) / 2)}px;top:${Math.round(34 * (h / 314))}px">` +
    `<img src="${svgUri(ENDORSEMENT.dark, COLORS.text3)}" style="width:${endorse}px;left:${Math.round((w - line - endorse) / 2)}px;bottom:${Math.round(18 * s)}px">` +
    `<div style="position:absolute;right:0;top:0;bottom:0;width:${line}px;background:${COLORS.line}"></div>`, COLORS.header);
}
// header: the logo at the right (MUI_HEADERIMAGE_RIGHT), on the header colour
function headerPage(w, h) {
  const logo = Math.round(h * 0.96);
  return doc(`<img src="${svgUri(app.logo.dark)}" style="width:${logo}px;height:${logo}px;right:${Math.round(h * 0.12)}px;top:${Math.round((h - logo) / 2)}px">`, COLORS.header);
}
// Mac Installer background (bottom left, under the step list): the logo and the Conform Labs endorsement line
function macBackground(mode) {
  const secondary = mode === "dark" ? COLORS.text3 : COLORS.text3Light;
  return doc(`<img src="${svgUri(app.logo[mode])}" style="width:128px;height:128px;left:22px;top:6px">` +
    `<img src="${svgUri(ENDORSEMENT[mode], secondary)}" style="width:128px;left:26px;top:146px">`);
}

mkdirSync(winOut, { recursive: true });
for (const f of readdirSync(winOut)) if (/^(wizard|header)-\d+\.bmp$/.test(f)) rmSync(join(winOut, f));
if (preview) mkdirSync(preview, { recursive: true });
const written = [];
for (const [kind, sizes, page] of [["wizard", WIZARD_SIZES, wizardPage], ["header", HEADER_SIZES, headerPage]])
  for (const [w, h] of sizes) {
    const img = screenshot(page(w, h), w, h);
    writeFileSync(join(winOut, `${kind}-${w}.bmp`), bmp24(img, COLORS.header));
    if (preview) writeFileSync(join(preview, `win-${kind}-${w}.png`), img.png);
    written.push(`${kind}-${w}.bmp ${w}x${h}`);
  }
console.log(`Windows: ${winOut}\n  ${written.join("\n  ")}`);

if (process.platform === "darwin") {
  mkdirSync(macOut, { recursive: true });
  for (const mode of ["light", "dark"]) {
    const parts = [1, 2].map((scale) => {
      const img = screenshot(macBackground(mode), 180, 180, { scale, transparent: true });
      const png = join(tmp, `bg-${mode}-${scale}.png`), tiff = join(tmp, `bg-${mode}-${scale}.tiff`);
      writeFileSync(png, img.png);
      if (preview) writeFileSync(join(preview, `mac-background-${mode}${scale === 2 ? "@2x" : ""}.png`), img.png);
      const s = spawnSync("sips", ["-s", "format", "tiff", png, "--out", tiff], { encoding: "utf8" });
      if (s.status !== 0) throw new Error(`sips: ${s.stderr}`);
      return tiff;
    });
    const out = join(macOut, `background-${mode}.tiff`);
    const t = spawnSync("tiffutil", ["-cathidpicheck", ...parts, "-out", out], { encoding: "utf8" });
    if (t.status !== 0) throw new Error(`tiffutil: ${t.stderr}`);
    console.log(`Mac: ${out} (180x180 + @2x)`);
  }
} else console.log("Mac background images skipped (needs macOS: sips, tiffutil)");

// ---------- previews of the Mac pages, in a frame shaped like the Installer window ----------
if (preview) {
  const version = JSON.parse(readFileSync(join(ROOT, "server", "package.json"), "utf8")).version;
  for (const page of ["welcome", "conclusion"]) {
    const file = join(preview, `mac-${page}.html`);
    writeFileSync(file, macPage(page, { version, app }));
    for (const mode of ["light", "dark"]) {
      const bg = join(preview, `mac-background-${mode}@2x.png`);
      const win = mode === "dark" ? "#1E1E1E" : "#ECECEC", pane = mode === "dark" ? "#2A2A2A" : "#FFFFFF";
      const steps = ["Introduction", "Destination Select", "Installation Type", "Installation", "Summary"]
        .map((s, i) => `<li style="${(page === "welcome" ? i === 0 : i === 4) ? "font-weight:600" : "opacity:.6"}">${s}</li>`).join("");
      const harness = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;background:${win};font:13px -apple-system,sans-serif;color:${mode === "dark" ? "#ddd" : "#222"}}
        .side{position:absolute;left:0;top:0;width:200px;height:520px;background:url('file://${bg}') no-repeat left bottom/180px 180px}
        .side ul{list-style:none;margin:28px 0 0 22px;padding:0;line-height:2}
        iframe{position:absolute;left:210px;top:20px;width:600px;height:430px;border:1px solid rgba(128,128,128,.25);border-radius:6px;background:${pane};padding:0}
        .btn{position:absolute;bottom:18px;padding:4px 14px;border-radius:6px;background:${mode === "dark" ? "#555" : "#fff"};border:1px solid rgba(128,128,128,.35)}</style></head>
        <body><div class="side"><ul>${steps}</ul></div><iframe src="file://${file}"></iframe>
        <div class="btn" style="right:110px">Go Back</div><div class="btn" style="right:20px">${page === "welcome" ? "Continue" : "Close"}</div></body></html>`;
      const img = screenshot(harness, 830, 520, { scale: 2, dark: mode === "dark" });
      writeFileSync(join(preview, `mac-${page}-${mode}.png`), img.png);
    }
  }
  console.log(`Previews: ${preview}`);
}
rmSync(tmp, { recursive: true, force: true });
