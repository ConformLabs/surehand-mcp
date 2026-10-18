// ae_tools + ae_call: every tool is reachable from the small core set. The AI lists or describes
// tools only when it needs them, so their definitions don't take up context in every chat.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CATEGORIES, type CatalogEntry } from "./profile.js";
import { errorResult } from "./registry.js";

const SELF = new Set(["ae_tools", "ae_call"]);

function firstSentence(d = ""): string {
  const s = d.split(/(?<=[.!?])\s|\n/)[0] ?? "";
  return s.length > 150 ? s.slice(0, 147) + "..." : s;
}

export function registerOnDemandTools(server: McpServer, catalog: Map<string, CatalogEntry>) {
  const category = (name: string) => Object.entries(CATEGORIES).find(([, names]) => names.includes(name))?.[0] ?? "other";

  server.registerTool(
    "ae_tools",
    {
      title: "More tools",
      description:
        "Discover every After Effects tool, including ones not loaded in this chat: list them by category (one line each), or describe " +
        "chosen tools (full parameters). Then run any of them with ae_call. Categories: " + Object.keys(CATEGORIES).join(", ") + ".",
      inputSchema: {
        describe: z.array(z.string()).max(10).optional().describe("Tool names to get full parameter details for."),
        category: z.string().optional().describe("Only list this category."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ describe, category: only }) => {
      if (describe?.length) {
        const out = describe.map((name) => {
          const t = catalog.get(name);
          if (!t || SELF.has(name)) return { name, error: "unknown tool (use ae_tools without arguments to list them)" };
          let input: unknown = {};
          try {
            input = z.toJSONSchema(z.object(t.config.inputSchema ?? {}));
          } catch {
            input = "(schema unavailable)";
          }
          return { name, title: t.config.title, description: t.config.description, input, callDirectly: t.direct };
        });
        return { content: [{ type: "text", text: JSON.stringify(out) }] };
      }
      const groups: Record<string, string[]> = {};
      for (const t of catalog.values()) {
        if (SELF.has(t.name)) continue;
        const cat = category(t.name);
        if (only && cat.toLowerCase() !== only.toLowerCase()) continue;
        (groups[cat] ||= []).push(`${t.name}${t.direct ? "" : "*"}: ${firstSentence(t.config.description)}`);
      }
      const text =
        Object.entries(groups)
          .map(([cat, lines]) => `## ${cat}\n${lines.join("\n")}`)
          .join("\n\n") + "\n\n* = not loaded in this chat: run it with ae_call (use ae_tools {describe: [...]} for its parameters).";
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "ae_call",
    {
      title: "Run any tool",
      description:
        "Run any After Effects tool by name with its arguments, e.g. tools listed by ae_tools that aren't loaded in this chat. " +
        "Same validation, permissions, change report and activity log as calling the tool directly. Get the parameters with ae_tools {describe: [name]}.",
      inputSchema: {
        tool: z.string().describe('Tool name, e.g. "ae_set_camera".'),
        args: z.record(z.string(), z.any()).optional().describe("The tool's arguments."),
      },
      // runs any tool, including ae_run_script
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ tool, args }, extra) => {
      const t = catalog.get(tool);
      if (!t || SELF.has(tool)) return errorResult(`Unknown tool "${tool}". Use ae_tools to list the available tools.`);
      const parsed = z.object(t.config.inputSchema ?? {}).safeParse(args ?? {});
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`).join("; ");
        return errorResult(`Invalid arguments for ${tool}: ${issues}. Use ae_tools {describe: ["${tool}"]} for its parameters.`);
      }
      return t.run(parsed.data, extra);
    },
  );
}
