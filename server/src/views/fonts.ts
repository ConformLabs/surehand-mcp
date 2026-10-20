// The panel's fonts (extension/fonts), inlined into every in-chat view as data: URLs, so a view loads nothing
// from the network. The bundle carries the font files once (with the extension): src/tools/views.ts puts them
// into a view's HTML at FONT_SLOT when an AI app asks for it.

export const VIEW_FONTS: { file: string; family: string; weight: number }[] = [
  { file: "ibm-plex-sans-latin-400-normal.woff2", family: "IBM Plex Sans", weight: 400 },
  { file: "ibm-plex-sans-latin-600-normal.woff2", family: "IBM Plex Sans", weight: 600 },
  { file: "space-grotesk-latin-600-normal.woff2", family: "Space Grotesk", weight: 600 },
  { file: "ibm-plex-mono-latin-400-normal.woff2", family: "IBM Plex Mono", weight: 400 },
  { file: "ibm-plex-mono-latin-500-normal.woff2", family: "IBM Plex Mono", weight: 500 },
];

/** Where a view's HTML takes the fonts (scripts/views.mjs puts it at the top of its <style>). */
export const FONT_SLOT = "/*surehand:fonts*/";

/** @font-face rules with the fonts as data: URLs; `read` gives a font file's base64 (missing ones are left out). */
export function fontFaceCss(read: (file: string) => string | undefined): string {
  return VIEW_FONTS.map((f) => {
    const b64 = read(f.file);
    return b64 ? `@font-face{font-family:"${f.family}";src:url(data:font/woff2;base64,${b64}) format("woff2");font-weight:${f.weight};font-style:normal}` : "";
  }).join("");
}

/** A built view's HTML with the fonts in. */
export const withFonts = (html: string, read: (file: string) => string | undefined) => html.replace(FONT_SLOT, () => fontFaceCss(read));
