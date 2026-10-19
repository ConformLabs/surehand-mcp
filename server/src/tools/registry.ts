import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BridgeError } from "../bridge.js";
import { loadConfig } from "../config.js";
import { formatChanges, runJsx, type RunResult } from "../jsx.js";
import { approvalSummary, permissions, READ_ONLY_REFUSAL } from "../permissions.js";

export interface JsxTool {
  name: string;
  title: string;
  description: string;
  input: z.ZodRawShape;
  /** ExtendScript function body. Sees `args` (validated input) and `log()`; has the `aemcp` helpers. */
  jsx: string;
  readOnly?: boolean;
  /** Mutating, but must not run inside an undo group (open/close project, undo itself...). */
  noUndo?: boolean;
  /** Read-only for the user, but creates and removes temporary items: wrap them in one undo step. */
  tempItems?: boolean;
  // Hints for AI apps only (permissions use readOnly / tempItems); meanings in test/annotations.test.ts.
  /** May delete content, overwrite files, close the project or clear the undo history. */
  destructive?: boolean;
  /** Repeating the call with the same arguments has no further effect (implied by readOnly). */
  idempotent?: boolean;
  /** Allowed in read-only mode, but changes what the user sees (viewer, selection): not hinted read-only. */
  uiState?: boolean;
  /** Include a change report (default: for every tool that edits, i.e. not readOnly / noUndo). */
  report?: boolean;
  timeoutMs?: number;
  /** Turns the JSX result into the tool's text (analysis done in TypeScript). */
  format?: (result: unknown, args: Record<string, unknown>) => string;
}

// ---- shared argument schemas ----
export const compRef = z
  .union([z.number().int(), z.string()])
  .optional()
  .describe('Composition: item id (number) or exact name. Omit (or "active") for the active/open composition.');
export const layerRef = z
  .union([z.number().int(), z.string()])
  .describe("Layer: 1-based index (number) or exact layer name.");
export const itemRef = z.union([z.number().int(), z.string()]).describe("Project item id (number) or exact name.");
export const propPath = z
  .union([z.string(), z.array(z.union([z.string(), z.number().int()]))])
  .describe(
    'Property path from the layer, "/"-separated display names or match names, e.g. "Transform/Position", ' +
      '"Effects/Gaussian Blur/Blurriness", "ADBE Transform Group/ADBE Opacity", "Contents/Rectangle 1/Fill 1/Color".',
  );
export const colorSchema = z
  .union([z.string(), z.array(z.number()).min(3).max(4)])
  .describe('Color as "#rrggbb" or [r,g,b] (0-1 or 0-255).');
export const anyValue = z.any().describe("Value: number, array ([x,y] / [x,y,z] / color), string for text, or object for text style / shape path.");

/** Keep a single result well below what AI apps accept (~25k tokens); say how to get the rest. */
export const MAX_RESULT_CHARS = 60_000;
export function capText(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return (
    text.slice(0, MAX_RESULT_CHARS) +
    `\n\n[Result truncated: ${text.length.toLocaleString("en-US")} characters, showing the first ${MAX_RESULT_CHARS.toLocaleString("en-US")}. ` +
    "Ask for less: use offset/limit, a smaller depth, a filter, or return only the fields you need from ae_run_script.]"
  );
}

/** quietNoChanges: leave out "Changes: none" (e.g. for scripts that only read). */
export function formatResult(r: RunResult, opts: { quietNoChanges?: boolean } = {}): CallToolResult {
  const logs = r.logs?.length ? `\n\nlog output:\n${r.logs.join("\n")}` : "";
  if (!r.ok) {
    const e = r.error!;
    const where = e.line && !e.user ? ` (line ${e.line})` : "";
    const changes = formatChanges(r.changes);
    const changed = changes && changes !== "Changes: none" ? `\n\nThe call failed, but these changes were already made (one undo step reverts them):\n${changes}` : "";
    return { isError: true, content: [{ type: "text", text: `${e.name && !e.user ? e.name + ": " : ""}${e.message}${where}${logs}${changed}` }] };
  }
  // compact JSON: indentation can cost a third of the tokens of a result
  const text = r.result === undefined || r.result === null ? "OK (no return value)" : typeof r.result === "string" ? r.result : JSON.stringify(r.result);
  let changes = formatChanges(r.changes);
  if (opts.quietNoChanges && changes === "Changes: none") changes = null;
  return { content: [{ type: "text", text: capText(text) + logs + (changes ? `\n\n${capText(changes)}` : "") }] };
}

/** Change reports are on unless "changeReport": false in ~/.surehand/ae/config.json. */
export function reportScope(args: Record<string, unknown> | undefined): unknown[] | undefined {
  if (loadConfig().changeReport === false) return undefined;
  const refs: unknown[] = [];
  if (args && args.comp !== undefined && args.comp !== null) refs.push(args.comp);
  return refs;
}

export function errorResult(e: unknown): CallToolResult {
  const msg = e instanceof BridgeError || e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: "text", text: msg }] };
}

/** The MCP hints sent to AI apps for a JsxTool. Temporary items and UI changes are not read-only. */
export function jsxAnnotations(t: JsxTool) {
  const readOnlyHint = !!t.readOnly && !t.tempItems && !t.uiState;
  return { readOnlyHint, destructiveHint: !readOnlyHint && !!t.destructive, idempotentHint: !!t.readOnly || !!t.idempotent, openWorldHint: false };
}

/** Runs a tool's own formatter; a formatter bug must never hide the result (or the edits it reports): fall back to plain JSON. */
export function applyFormat(format: NonNullable<JsxTool["format"]>, result: unknown, args: Record<string, unknown>): string {
  try {
    return format(result, args);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return `${JSON.stringify(result) ?? "null"}\n(The summary for this result could not be built (${why}); this is the raw result.)`;
  }
}

export function registerJsxTools(server: McpServer, tools: JsxTool[]) {
  for (const t of tools) {
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: t.input,
        annotations: jsxAnnotations(t),
      },
      async (args: Record<string, unknown>) => {
        try {
          const edits = !t.readOnly && !t.tempItems;
          const perm = permissions();
          if (edits && perm.mode === "read-only") return { isError: true, content: [{ type: "text", text: READ_ONLY_REFUSAL }] };
          const timeoutMs = typeof args.timeoutSeconds === "number" ? args.timeoutSeconds * 1000 : t.timeoutMs;
          const wantsReport = t.report ?? (!t.readOnly && !t.noUndo);
          const r = await runJsx(t.jsx, args, {
            undoGroup: t.tempItems ? "Surehand MCP " + t.title : t.readOnly || t.noUndo ? false : t.title,
            timeoutMs,
            report: wantsReport ? reportScope(args) : undefined,
            bridge: edits && perm.mode === "ask" ? { approval: { tool: t.title, summary: approvalSummary(t.name, args) } } : undefined,
          });
          if (r.ok && t.format) r.result = applyFormat(t.format, r.result, args);
          return formatResult(r);
        } catch (e) {
          return errorResult(e);
        }
      },
    );
  }
}
