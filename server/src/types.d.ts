declare module "*.jsxinc" {
  const src: string;
  export default src;
}

declare const __AEMCP_VERSION__: string;
declare const __AEMCP_CEP_FILES__: Record<string, string>;
declare const __AEMCP_CEP_HASH__: string;
declare module "@babel/standalone" {
  export function transform(code: string, options: Record<string, unknown>): { code?: string | null };
}
