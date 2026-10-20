// Shared by the in-chat views (browser code, bundled into each view by scripts/views.mjs): the MCP Apps
// connection, the AI app's theme, calling Surehand's tools with short errors, and building DOM.
import { App } from "@modelcontextprotocol/ext-apps";
import { VIEW_ERROR_KEY, VIEW_META_KEY } from "./types.js";

type Child = Node | string | null | undefined | false;

/** el("div", { class: "row", onclick: f }, child, ...): attributes, event handlers (on*), and children. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v as EventListener);
    else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

/** The S tile, the only logo (as in the panel). */
export function tile(): HTMLElement {
  const t = el("span", { class: "tile", "aria-hidden": "true" });
  t.innerHTML =
    '<svg viewBox="0 0 200 200"><path d="M150 62 C128 18 50.5 50.5 78.8 78.8 L121.2 121.2 C149.5 149.5 72 182 50 138" fill="none" stroke="#14161A" stroke-width="26" stroke-linecap="round"/></svg>';
  return t;
}

/** "outside title-safe by 18 px" -> "Outside title-safe by 18 px." */
export function sentence(s: string): string {
  const t = s.trim();
  if (!t) return t;
  return t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?…)]$/.test(t) ? "" : ".");
}

/** What the view says when a tool call didn't work: short, in the view's own words. */
export function errorText(code: string | undefined, text: string | undefined): string {
  switch (code) {
    case "NOT_RUNNING":
    case "STARTING":
      return "After Effects isn't open. Open it, then try again.";
    case "BLOCKED":
    case "TIMEOUT":
      return "After Effects is busy. Try again in a moment.";
    case "PAUSED":
      return "Surehand is paused in the After Effects panel.";
    case "CANCELLED":
      return "Stopped.";
  }
  const first = (text ?? "").split("\n")[0].trim();
  return first ? (first.length > 160 ? first.slice(0, 157) + "…" : first) : "That didn't work. Try again.";
}

export type ToolResult = { content?: { type: string; text?: string; data?: string; mimeType?: string }[]; _meta?: Record<string, unknown>; isError?: boolean };

/** The view data a result carries (types.ts), if any. */
export const viewData = <T>(r: ToolResult | undefined): T | undefined => r?._meta?.[VIEW_META_KEY] as T | undefined;

/** Light or dark, as the AI app says (data-theme on <html>); without a theme the system's applies (shared.css). */
export function applyTheme(theme: unknown) {
  if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-theme", theme);
}

export interface View {
  app: App;
  /** run one of Surehand's tools: the result, or the short message to show */
  call(name: string, args: Record<string, unknown>): Promise<{ ok: true; result: ToolResult } | { ok: false; message: string }>;
  /** write a request into the chat, as the user */
  ask(text: string): Promise<boolean>;
}

/**
 * Connect to the AI app. onInput gets the tool call's arguments, onResult its result (once; fresh data needs a
 * tool call from the view).
 */
export async function startView(name: string, h: { onInput?: (args: Record<string, unknown>) => void; onResult: (r: ToolResult) => void }): Promise<View> {
  const app = new App({ name: `Surehand ${name}`, version: "1" });
  app.ontoolinput = (p) => h.onInput?.((p.arguments ?? {}) as Record<string, unknown>);
  app.ontoolresult = (p) => h.onResult(p as ToolResult);
  app.onhostcontextchanged = (c) => applyTheme(c.theme);
  const view: View = {
    app,
    async call(tool, args) {
      try {
        const r = (await app.callServerTool({ name: tool, arguments: args })) as ToolResult;
        if (!r.isError) return { ok: true, result: r };
        const text = r.content?.find((c) => c.type === "text")?.text;
        return { ok: false, message: errorText(r._meta?.[VIEW_ERROR_KEY] as string | undefined, text) };
      } catch (e) {
        return { ok: false, message: "Couldn't reach Surehand. Try again." };
      }
    },
    async ask(text) {
      try {
        const r = await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
        return !r?.isError;
      } catch {
        return false;
      }
    },
  };
  await app.connect();
  applyTheme(app.getHostContext()?.theme);
  return view;
}
