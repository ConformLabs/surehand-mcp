declare module "*.jsxinc" {
  const src: string;
  export default src;
}

declare const __AEMCP_VERSION__: string;
declare const __AEMCP_CEP_FILES__: Record<string, string>;
/** The extension's binary files (the panel's fonts), base64. */
declare const __AEMCP_CEP_BINARY__: Record<string, string>;
declare const __AEMCP_CEP_HASH__: string;
/** The in-chat views' HTML ({ name: html }), brotli-compressed JSON in base64 (scripts/views.mjs). */
declare const __SUREHAND_VIEWS__: string;
/** The Agent Skills (skills/ in the repo): "surehand-ae/SKILL.md" -> its text. */
declare const __AEMCP_SKILLS__: Record<string, string>;
declare module "@babel/standalone" {
  export function transform(code: string, options: Record<string, unknown>): { code?: string | null };
}
