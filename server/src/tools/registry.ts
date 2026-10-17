import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BridgeError } from "../bridge.js";
import { runJsx, type RunResult } from "../jsx.js";

export interface JsxTool {
  name: string;
  title: string;
  description: string;
  input: z.ZodRawShape;
  /** ExtendScript function body. Sees `args` (validated input) and `log()`; has the `aemcp` helpers. */
  jsx: string;
  readOnly?: boolean;
  destructive?: boolean;
  /** Mutating, but must not run inside an undo group (open/close project, undo itself...). */
  noUndo?: boolean;
  /** Read-only for the user, but creates and removes temporary items: wrap them in one undo step. */
  tempItems?: boolean;
  timeoutMs?: number;
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

export function formatResult(r: RunResult): CallToolResult {
  const logs = r.logs?.length ? `\n\nlog output:\n${r.logs.join("\n")}` : "";
  if (!r.ok) {
    const e = r.error!;
    const where = e.line && !e.user ? ` (line ${e.line})` : "";
    return { isError: true, content: [{ type: "text", text: `${e.name && !e.user ? e.name + ": " : ""}${e.message}${where}${logs}` }] };
  }
  const text = r.result === undefined || r.result === null ? "OK (no return value)" : typeof r.result === "string" ? r.result : JSON.stringify(r.result, null, 2);
  return { content: [{ type: "text", text: text + logs }] };
}

export function errorResult(e: unknown): CallToolResult {
  const msg = e instanceof BridgeError || e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: "text", text: msg }] };
}

export function registerJsxTools(server: McpServer, tools: JsxTool[]) {
  for (const t of tools) {
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: t.input,
        annotations: { readOnlyHint: !!t.readOnly, destructiveHint: !!t.destructive, openWorldHint: false },
      },
      async (args: Record<string, unknown>) => {
        try {
          const timeoutMs = typeof args.timeoutSeconds === "number" ? args.timeoutSeconds * 1000 : t.timeoutMs;
          return formatResult(await runJsx(t.jsx, args, { undoGroup: t.tempItems ? "AE MCP " + t.title : t.readOnly || t.noUndo ? false : t.title, timeoutMs }));
        } catch (e) {
          return errorResult(e);
        }
      },
    );
  }
}
