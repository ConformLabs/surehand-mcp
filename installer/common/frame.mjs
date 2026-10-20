// The Conform Labs installer frame: what every Conform Labs app's installer shares. An app adds only its own part
// (installer/app.json: name, "for ..." line, logo SVGs, accent colour; and its own payload and wording).
//
//   frame.mjs           colours, bitmap sizes, the Mac welcome/conclusion page frame (this file)
//   generate-art.mjs    renders the app's logo into the Windows bitmaps and the Mac background images
//   conformlabs.nsh     the Windows (NSIS, Modern UI 2) frame: dark colours, Segoe UI, sized bitmaps,
//                       the maintenance page (update / reinstall / uninstall when Setup runs again)
//   mac/page.html       the Mac Installer page frame (type and colours, light and dark mode)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const COMMON = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(COMMON, "..", "..");

// Conform Labs product colours (dark UI). The app brings its own accent.
export const COLORS = {
  ink: "#14161A", // dark background
  panel: "#17191D", // page body
  header: "#101215", // header strip, sidebar
  text: "#F2EFE8", // ivory
  text2: "#D8D6D0",
  text3: "#A9A69F",
  line: "#2A2D33",
  // on light backgrounds (Mac Installer in light mode)
  inkText: "#14161A",
  text3Light: "#6E6B65",
};

// Windows bitmaps. The welcome/finish image control is 109x193 dialog units and the header image 100x35; their
// size in pixels depends on the dialog font and the display scaling. These are the sizes for MS Shell Dlg 8 (the
// classic 164x314 / 150x57) and for Segoe UI 9 at 100, 125, 150, 175 and 200 %. conformlabs.nsh measures the
// control at run time and loads the nearest one, so the logo is not blurred by stretching.
export const WIZARD_SIZES = [[164, 314], [191, 362], [238, 452], [286, 543], [334, 634], [382, 724]];
export const HEADER_SIZES = [[150, 57], [175, 66], [219, 82], [262, 99], [306, 115], [350, 132]];

export function loadApp(file = join(ROOT, "installer", "app.json")) {
  const app = JSON.parse(readFileSync(file, "utf8"));
  for (const k of ["name", "for"]) if (typeof app[k] !== "string" || !app[k]) throw new Error(`${file}: "${k}" is missing`);
  for (const k of ["dark", "light"]) {
    if (!/^#[0-9A-Fa-f]{6}$/.test(app.accent?.[k] ?? "")) throw new Error(`${file}: accent.${k} must be #RRGGBB`);
    if (!app.logo?.[k]) throw new Error(`${file}: logo.${k} is missing`);
  }
  return app;
}

const html = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// The Mac Installer's welcome or conclusion page: the app's body (resources/<page>.body.html) in the shared frame.
// Placeholders in the body: @NAME@, @FOR@, @VERSION@.
export function macPage(page, { version, app = loadApp(), bodyDir = join(ROOT, "installer", "mac", "pkg", "resources") } = {}) {
  const frame = readFileSync(join(COMMON, "mac", "page.html"), "utf8");
  const fill = (s) =>
    s.replaceAll("@NAME@", html(app.name)).replaceAll("@FOR@", html(app.for)).replaceAll("@VERSION@", html(version))
      .replaceAll("@ACCENT_DARK@", app.accent.dark).replaceAll("@ACCENT_LIGHT@", app.accent.light);
  const body = readFileSync(join(bodyDir, `${page}.body.html`), "utf8");
  return fill(frame.replace("@BODY@", () => body.trim()));
}
