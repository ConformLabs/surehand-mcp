// The Conform Labs installer frame: what every Conform Labs app's installer shares. An app adds only its own part
// (installer/app.json: name, "for ..." line, logo SVGs or a logo on a tile, accent colour; and its own payload and
// wording).
//
//   frame.mjs           colours, fonts, bitmap sizes, the Mac welcome/conclusion page frame (this file)
//   generate-art.mjs    renders the app's logo into the Windows bitmaps and the Mac background images
//   conformlabs.nsh     the Windows (NSIS, Modern UI 2) frame: dark colours, the Conform Labs fonts, sized bitmaps,
//                       the maintenance page (update / uninstall when Setup runs again)
//   mac/page.html       the Mac Installer page frame (type and colours, light and dark mode)
//   fonts/              Space Grotesk, IBM Plex Sans and IBM Plex Mono (SIL Open Font License, licences there)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const COMMON = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(COMMON, "..", "..");

// Conform Labs product colours: the design system's dark theme tokens (ds/conformlabs/tokens.css). The app brings
// its own accent (its product colour), used only for the one main button and the "verified" glyph.
export const COLORS = {
  paper: "#14161A", // page body
  paperRaised: "#1C1F24",
  paperSunk: "#0D0E11", // title bar, sidebar, header band, results box
  ink: "#F2EFE8", // text
  inkMuted: "#A6A49D",
  rule: "#2C3036", // hairlines
  ruleStrong: "#6E727A",
  refused: "#FF7A6B", // failed
  // the light theme (the Mac Installer in light mode)
  light: { paper: "#F2EFE8", paperSunk: "#E6E2D8", ink: "#14161A", inkMuted: "#5C5E62", rule: "#D6D1C6", refused: "#B42318" },
};

// The Conform Labs typefaces (SIL Open Font License; installer/common/fonts, with their licences). Static latin
// subsets from the Fontsource packages (@fontsource/space-grotesk, ibm-plex-sans and ibm-plex-mono 5.3.0, from
// `npm pack`), as WOFF2 for the Mac pages and the artwork, and as TrueType (woff2_decompress) for the Windows Setup,
// which loads them privately (AddFontResourceEx, FR_PRIVATE) for its own labels only. gdi: the name Windows knows
// the TrueType by (name ID 1), which conformlabs.nsh passes to CreateFont with the weight.
export const FONTS = {
  display: { family: "Space Grotesk", weight: 600, woff2: "SpaceGrotesk-SemiBold.woff2", ttf: "SpaceGrotesk-SemiBold.ttf", gdi: "Space Grotesk Light SemiBold" },
  displayMedium: { family: "Space Grotesk", weight: 500, woff2: "SpaceGrotesk-Medium.woff2" },
  text: { family: "IBM Plex Sans", weight: 400, woff2: "IBMPlexSans-Regular.woff2" },
  textStrong: { family: "IBM Plex Sans", weight: 600, woff2: "IBMPlexSans-SemiBold.woff2", ttf: "IBMPlexSans-SemiBold.ttf", gdi: "IBM Plex Sans SemiBold" },
  mono: { family: "IBM Plex Mono", weight: 400, woff2: "IBMPlexMono-Regular.woff2", ttf: "IBMPlexMono-Regular.ttf", gdi: "IBM Plex Mono" },
  monoMedium: { family: "IBM Plex Mono", weight: 500, woff2: "IBMPlexMono-Medium.woff2", ttf: "IBMPlexMono-Medium.ttf", gdi: "IBM Plex Mono Medium" },
};
export const FONT_DIR = join(COMMON, "fonts");

/** @font-face rules for these fonts (keys of FONTS): the files inlined as data: URIs, or file:// URLs (inline: false). */
export function fontFaces(keys = Object.keys(FONTS), { inline = true } = {}) {
  return keys
    .map((k) => {
      const f = FONTS[k], file = join(FONT_DIR, f.woff2);
      const src = inline ? `data:font/woff2;base64,${readFileSync(file).toString("base64")}` : `file://${file}`;
      return `@font-face{font-family:"${f.family}";font-weight:${f.weight};font-style:normal;src:url("${src}") format("woff2")}`;
    })
    .join("\n");
}

// Windows bitmaps. The welcome/finish image control is 109x193 dialog units and the header image 100x35; their
// size in pixels depends on the dialog font and the display scaling. These are the sizes for MS Shell Dlg 8 (the
// classic 164x314 / 150x57) and for Segoe UI 9 at 100, 125, 150, 175 and 200 %. conformlabs.nsh measures the
// control at run time and loads the nearest one, so the logo is not blurred by stretching.
export const WIZARD_SIZES = [[164, 314], [191, 362], [238, 452], [286, 543], [334, 634], [382, 724]];
export const HEADER_SIZES = [[150, 57], [175, 66], [219, 82], [262, 99], [306, 115], [350, 132]];
// Status glyphs (the finish page's results and the progress steps): squares 5 dialog units wide, in pixels for the
// same fonts and scalings, each kind on the background it is shown on (pre-composited: Windows draws them opaque),
// with a 1 px margin of that background: a centred bitmap control (SS_CENTERIMAGE) fills around it with its corner.
//   done: filled, the app's accent   skipped: dotted outline   failed: red outline with an X   waiting: dotted, dimmed
export const GLYPH_SIZES = [8, 9, 11, 13, 15, 18];
export const GLYPH_KINDS = ["done", "skipped", "failed", "waiting"];
export const GLYPH_BACKGROUNDS = { sunk: "paperSunk", paper: "paper" };

/**
 * The lines a row of the Windows finish page's results box needs (conformlabs.nsh cl.ResultLines does the same): 47
 * IBM Plex Mono characters to a line, words moved whole to the next line the way Windows wraps a label.
 */
export const RESULT_LINE_CHARS = 47;
export function resultLines(text) {
  let lines = 1, used = 0;
  for (const word of text.split(" ")) {
    let n = used > 0 ? used + 1 + word.length : word.length;
    if (used > 0 && n > RESULT_LINE_CHARS) {
      lines++;
      n = word.length;
    }
    while (n > RESULT_LINE_CHARS) {
      lines++;
      n -= RESULT_LINE_CHARS;
    }
    used = n;
  }
  return lines;
}

export function loadApp(file = join(ROOT, "installer", "app.json")) {
  const app = JSON.parse(readFileSync(file, "utf8"));
  for (const k of ["name", "for"]) if (typeof app[k] !== "string" || !app[k]) throw new Error(`${file}: "${k}" is missing`);
  for (const k of ["dark", "light"]) {
    if (!/^#[0-9A-Fa-f]{6}$/.test(app.accent?.[k] ?? "")) throw new Error(`${file}: accent.${k} must be #RRGGBB`);
    if (!app.logo?.[k]) throw new Error(`${file}: logo.${k} is missing`);
  }
  if (app.tile !== undefined && typeof app.tile !== "string" && !(app.tile?.dark && app.tile?.light)) throw new Error(`${file}: tile must be a file or { dark, light }`);
  return app;
}

// The artwork the installers show for the app: its logo on a tile (app.tile) when it has one, else the bare logo.
// mode: "dark" | "light". tiled: the image fills its square (a tile) rather than a mark with room around it.
export function appArt(app, mode) {
  if (app.tile) return { file: typeof app.tile === "string" ? app.tile : app.tile[mode], tiled: true };
  return { file: app.logo[mode], tiled: false };
}

/** The app's name split for the wordmark: "Surehand MCP" -> ["Surehand", "MCP"] (the last word is set lighter). */
export function wordmark(app) {
  const words = app.name.split(" ");
  return words.length > 1 ? [words.slice(0, -1).join(" "), words.at(-1)] : [app.name, ""];
}

const html = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// The Mac Installer's welcome or conclusion page: the app's body (resources/<page>.body.html) in the shared frame,
// with the Conform Labs fonts inlined. Placeholders in the body: @NAME@, @FOR@, @VERSION@.
export function macPage(page, { version, app = loadApp(), bodyDir = join(ROOT, "installer", "mac", "pkg", "resources") } = {}) {
  const frame = readFileSync(join(COMMON, "mac", "page.html"), "utf8");
  const fill = (s) =>
    s.replaceAll("@NAME@", html(app.name)).replaceAll("@FOR@", html(app.for)).replaceAll("@VERSION@", html(version))
      .replaceAll("@ACCENT_DARK@", app.accent.dark).replaceAll("@ACCENT_LIGHT@", app.accent.light);
  const body = readFileSync(join(bodyDir, `${page}.body.html`), "utf8");
  return fill(frame.replace("@FONTS@", () => fontFaces(["display", "text", "textStrong", "mono"])).replace("@BODY@", () => body.trim()));
}
