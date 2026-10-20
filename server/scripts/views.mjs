// Builds the in-chat views (src/views/<name>.ts + shared.css + <name>.css) into complete, self-contained HTML
// documents: the script (with the MCP Apps SDK) and the styles inline, nothing loaded from the network. The
// fonts go in at runtime from the extension's own copies (src/tools/views.ts, FONT_SLOT), so the bundle carries
// them once. Shared by build.mjs (which embeds them, brotli-compressed) and vitest.config.ts.
import { buildSync } from "esbuild";
import { readFileSync } from "node:fs";
import { brotliCompressSync, constants } from "node:zlib";

export const VIEW_NAMES = ["preflight", "changes", "xray"];
const SRC = new URL("../src/views/", import.meta.url);
/** must match FONT_SLOT in src/views/fonts.ts */
const FONT_SLOT = "/*surehand:fonts*/";

/** name -> HTML document */
export function buildViews() {
  const shared = readFileSync(new URL("shared.css", SRC), "utf8");
  const out = {};
  for (const name of VIEW_NAMES) {
    const js = buildSync({
      entryPoints: [new URL(`${name}.ts`, SRC).pathname.replace(/^\/([A-Za-z]:)/, "$1")],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      target: "es2020",
      minify: true,
      legalComments: "none",
    }).outputFiles[0].text;
    const css = shared + "\n" + readFileSync(new URL(`${name}.css`, SRC), "utf8");
    out[name] =
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      `<title>Surehand</title><style>${FONT_SLOT}\n${css}</style></head><body><div id="app"></div>` +
      // a "</script" inside the code would end the element early
      `<script>${js.replace(/<\/(script)/gi, "<\\/$1")}</script></body></html>`;
  }
  return out;
}

/** The views as one brotli-compressed, base64 string (they share the SDK: compressed together, it's stored about once). */
export function packViews(views = buildViews()) {
  const json = Buffer.from(JSON.stringify(views), "utf8");
  return brotliCompressSync(json, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 24, [constants.BROTLI_PARAM_SIZE_HINT]: json.length } }).toString("base64");
}
