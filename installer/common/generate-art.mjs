// Renders an app's installer artwork in the Conform Labs frame from its logo (on its tile, if app.json has one),
// name and accent (installer/app.json), with the Conform Labs fonts (installer/common/fonts):
//
//   Windows (NSIS)  <out.windows>/wizard-<w>.bmp   welcome/finish sidebar: the square tile, the wordmark ("Surehand"
//                                                  600 + "MCP" 500 muted, Space Grotesk) and the Conform Labs
//                                                  endorsement, on paper-sunk; one per WIZARD_SIZES entry
//                   <out.windows>/header-<w>.bmp   header band: the square tile at the right, one per HEADER_SIZES
//                   <out.windows>/glyph-<kind>-<bg>-<px>.bmp   status squares (GLYPH_KINDS x GLYPH_BACKGROUNDS x
//                                                  GLYPH_SIZES), pre-composited on the background they sit on
//   Mac (pkg)       <out.mac>/background-dark.tiff, background-light.tiff   the same lockup for the bottom of the
//                                                  Installer's sidebar: 152x120 points with a @2x image
//
//   node installer/common/generate-art.mjs [--app installer/app.json] [--preview <dir>]
//
// --preview also writes PNGs of every image, and of the installers' pages at their real size: the Windows Setup's
// pages as HTML mock-ups of conformlabs.nsh's layout (dialog units at Segoe UI 9, 100 %) and the Mac Installer's
// welcome, choices and conclusion pages (light and dark).
// Needs Google Chrome or Chromium (headless; set CHROME=/path/to/chrome) to draw; the Mac images also need sips and
// tiffutil (macOS). Uses Node.js built-ins only. The output is committed; re-run it when the logo or colours change.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { COLORS, GLYPH_BACKGROUNDS, GLYPH_KINDS, GLYPH_SIZES, HEADER_SIZES, ROOT, WIZARD_SIZES, appArt, fontFaces, loadApp, macPage, wordmark } from "./frame.mjs";

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
    "--allow-file-access-from-files", "--virtual-time-budget=3000", `--user-data-dir=${join(tmp, "profile")}`,
    `--force-device-scale-factor=${scale}`, `--window-size=${w},${h}`, "--font-render-hinting=none",
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

/** A part of an RGBA image. */
const crop = ({ w, rgba }, x0, y0, cw, ch) => {
  const out = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) rgba.copy(out, y * cw * 4, ((y0 + y) * w + x0) * 4, ((y0 + y) * w + x0 + cw) * 4);
  return { w: cw, h: ch, rgba: out };
};

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
const svgUri = (file, { recolor, square } = {}) => {
  let svg = readFileSync(join(ROOT, file), "utf8");
  if (recolor) svg = svg.replace(/fill="#[0-9A-Fa-f]{6}"/g, `fill="${recolor}"`);
  // the installers show the tile square (the design's square tile), the After Effects panel rounded
  if (square) svg = svg.replace(/(<rect\b[^>]*?)\s+rx="[^"]*"/, "$1");
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
};
const ENDORSEMENT = { dark: "brand/conformlabs-endorsement-reversed.svg", light: "brand/conformlabs-endorsement.svg" };
const FONT_CSS = fontFaces(["display", "displayMedium", "text", "textStrong", "mono", "monoMedium"]);
const doc = (body, bg = "transparent", css = "") =>
  `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${FONT_CSS}
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${bg}}img{position:absolute;display:block}${css}</style></head><body>${body}</body></html>`;

// The app's art (frame.mjs appArt): a tile fills its square (drawn square); a bare mark has room around it, so it is
// drawn larger. size = the visual size wanted for a tile; returns the <img> box size.
const art = (mode) => appArt(app, mode);
const box = (a, size) => Math.round(a.tiled ? size : size * 1.55);
const artUri = (mode) => svgUri(art(mode).file, { square: art(mode).tiled });
const [WORD, WORD_LIGHT] = wordmark(app);

/**
 * The lockup: tile, wordmark, endorsement, stacked from (left, top). Sizes in pixels: the design's Windows sidebar
 * (tile 56, wordmark 16 on a 20 line, endorsement 124 wide, 8 apart) times s, or the Mac sidebar's own (z).
 */
function lockup(left, top, s, mode = "dark", z = { tile: 56 * s, word: 16 * s, line: 20 * s, endorse: 124 * s, gap: 8 * s }) {
  const a = art(mode), t = Math.round(z.tile);
  const ink = mode === "dark" ? COLORS.ink : COLORS.light.ink, muted = mode === "dark" ? COLORS.inkMuted : COLORS.light.inkMuted;
  const wordTop = top + t + Math.round(z.gap), endorseTop = wordTop + Math.round(z.line) + Math.round(z.gap);
  return `<img src="${artUri(mode)}" style="width:${box(a, t)}px;height:${box(a, t)}px;left:${left}px;top:${top}px">` +
    `<div style="position:absolute;left:${left}px;top:${wordTop}px;font:600 ${z.word}px/${z.line}px 'Space Grotesk';letter-spacing:-.01em;color:${ink};white-space:nowrap">${WORD}${WORD_LIGHT ? ` <span style="font-weight:500;color:${muted}">${WORD_LIGHT}</span>` : ""}</div>` +
    `<img src="${svgUri(ENDORSEMENT[mode], { recolor: muted })}" style="width:${Math.round(z.endorse)}px;left:${left}px;top:${endorseTop}px">`;
}

// welcome/finish sidebar (the design's 164 px sidebar, scaled to the bitmap): the lockup at the top left on
// paper-sunk, a hairline on the right edge. The version is a label conformlabs.nsh draws over it (it changes).
function wizardPage(w, h) {
  const s = w / 164, line = Math.max(1, Math.round(s));
  return doc(lockup(Math.round(20 * s), Math.round(32 * s), s) +
    `<div style="position:absolute;right:0;top:0;bottom:0;width:${line}px;background:${COLORS.rule}"></div>`, COLORS.paperSunk);
}
// header band: the square tile at the right (MUI_HEADERIMAGE_RIGHT), on paper-sunk
function headerPage(w, h) {
  const a = art("dark"), t = Math.round(h * 0.46), right = Math.round(h * 0.34);
  return doc(`<img src="${artUri("dark")}" style="width:${box(a, t)}px;height:${box(a, t)}px;left:${w - right - box(a, t)}px;top:${Math.round((h - box(a, t)) / 2)}px">`, COLORS.paperSunk);
}
// status glyphs: one strip of GLYPH_KINDS squares of `px` pixels, 4 px apart, on `bg`
function glyphStrip(px, bg) {
  const b = Math.max(1, Math.round(px / 7)); // the design's 2 px border on a 14 px square (1.5x)
  const cell = (k) => {
    const st = `position:absolute;box-sizing:border-box;width:${px}px;height:${px}px;top:2px`;
    if (k === "done") return `<div style="${st};background:${app.accent.dark}"></div>`;
    if (k === "skipped") return `<div style="${st};border:${b}px dotted ${COLORS.inkMuted}"></div>`;
    if (k === "waiting") return `<div style="${st};border:${b}px dotted ${COLORS.inkMuted};opacity:.5"></div>`;
    return `<div style="${st};border:${b}px solid ${COLORS.refused}"><svg width="100%" height="100%" viewBox="0 0 10 10" style="position:absolute;inset:0" preserveAspectRatio="none"><path d="M1 1 9 9M9 1 1 9" stroke="${COLORS.refused}" stroke-width="${(b * 10) / (px - 2 * b)}" fill="none"/></svg></div>`;
  };
  return doc(GLYPH_KINDS.map((k, i) => cell(k).replace("position:absolute;", `position:absolute;left:${2 + i * (px + 4)}px;`)).join(""), bg);
}
// Mac Installer background (bottom left, under the step list of the 152 pt sidebar): the lockup at the design's
// 44 pt tile, 16 pt from the left and 20 pt from the bottom
function macBackground(mode) {
  return doc(lockup(16, 16, 1, mode, { tile: 44, word: 14, line: 18, endorse: 112, gap: 8 }));
}

mkdirSync(winOut, { recursive: true });
for (const f of readdirSync(winOut)) if (/^(wizard|header|glyph)-[\w-]+\.bmp$/.test(f)) rmSync(join(winOut, f));
if (preview) mkdirSync(preview, { recursive: true });
const written = [];
for (const [kind, sizes, page] of [["wizard", WIZARD_SIZES, wizardPage], ["header", HEADER_SIZES, headerPage]])
  for (const [w, h] of sizes) {
    const img = screenshot(page(w, h), w, h);
    writeFileSync(join(winOut, `${kind}-${w}.bmp`), bmp24(img, COLORS.paperSunk));
    if (preview) writeFileSync(join(preview, `win-${kind}-${w}.png`), img.png);
    written.push(`${kind}-${w}.bmp ${w}x${h}`);
  }
for (const [bgName, colorKey] of Object.entries(GLYPH_BACKGROUNDS))
  for (const px of GLYPH_SIZES) {
    const bg = COLORS[colorKey], stripW = 4 + GLYPH_KINDS.length * (px + 4), img = screenshot(glyphStrip(px, bg), stripW, px + 4);
    GLYPH_KINDS.forEach((k, i) => writeFileSync(join(winOut, `glyph-${k}-${bgName}-${px}.bmp`), bmp24(crop(img, 2 + i * (px + 4), 2, px, px), bg)));
    if (preview && px === 18) writeFileSync(join(preview, `win-glyphs-${bgName}-${px}.png`), img.png);
    written.push(`glyph-*-${bgName}-${px}.bmp`);
  }
console.log(`Windows: ${winOut}\n  ${written.join("\n  ")}`);

const MAC_BG = [152, 120];
if (process.platform === "darwin") {
  mkdirSync(macOut, { recursive: true });
  for (const mode of ["light", "dark"]) {
    const parts = [1, 2].map((scale) => {
      const img = screenshot(macBackground(mode), MAC_BG[0], MAC_BG[1], { scale, transparent: true });
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
    console.log(`Mac: ${out} (${MAC_BG.join("x")} + @2x)`);
  }
} else console.log("Mac background images skipped (needs macOS: sips, tiffutil)");

// ---------- previews of the pages ----------
if (preview) {
  const version = JSON.parse(readFileSync(join(ROOT, "server", "package.json"), "utf8")).version;
  const { winPages } = await import("./preview-win.mjs");
  for (const [name, html] of Object.entries(winPages({ app, version, art: winOut, fonts: FONT_CSS }))) {
    const img = screenshot(html.page, html.w, html.h, { scale: 2 });
    writeFileSync(join(preview, `win-page-${name}.png`), img.png);
  }
  const { macPages } = await import("./preview-mac.mjs");
  for (const [name, html] of Object.entries(macPages({ app, version, preview, macPage })))
    for (const mode of ["light", "dark"]) {
      const img = screenshot(html(mode), 620, 440, { scale: 2, dark: mode === "dark" });
      writeFileSync(join(preview, `mac-page-${name}-${mode}.png`), img.png);
    }
  console.log(`Previews: ${preview}`);
}
rmSync(tmp, { recursive: true, force: true });
