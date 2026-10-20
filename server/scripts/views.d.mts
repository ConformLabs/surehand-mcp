export const VIEW_NAMES: string[];
/** name -> the view's HTML document (fonts not yet inserted: FONT_SLOT) */
export function buildViews(): Record<string, string>;
/** The views as one brotli-compressed, base64 string (what the bundle embeds). */
export function packViews(views?: Record<string, string>): string;
