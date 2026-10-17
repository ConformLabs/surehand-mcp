// Tool profiles. Every tool definition is sent to the AI in every chat, so the full set
// (~60 tools, ~14k tokens) is costly. The "core" profile keeps the essentials; anything else
// can still be done with ae_run_script.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../config.js";
import { logActivity } from "../activity.js";
import { callContext } from "../context.js";

export const CORE_TOOLS = new Set([
  // connection, scripting, seeing
  "ae_status",
  "ae_run_script",
  "ae_get_scripting_guide",
  "ae_render_frame",
  "ae_render_contact_sheet",
  // understanding the project
  "ae_get_project_info",
  "ae_get_comp_info",
  "ae_get_layer_info",
  "ae_get_selection",
  "ae_get_properties",
  "ae_find_properties",
  "ae_get_layer_bounds",
  "ae_get_comp_map",
  // common edits
  "ae_create_comp",
  "ae_add_layer",
  "ae_add_shape",
  "ae_set_property",
  "ae_set_keyframes",
  "ae_set_expression",
  "ae_apply_effect",
  "ae_get_effect_params",
  "ae_undo",
]);

export interface ToolProfile {
  name: "core" | "full" | "custom";
  allows(tool: string): boolean;
}

/**
 * Resolution order: --tools <v>, AEMCP_TOOLS, config.toolProfile, default "core".
 * Values: "core", "full" ("true"/"false" from the .mcpb checkbox map to full/core), or
 * "core,ae_import_files,..." to add individual tools to the core set.
 */
export function resolveProfile(argv = process.argv): ToolProfile {
  const i = argv.indexOf("--tools");
  // The .mcpb checkbox always sends "true"/"false"; "false" means "not chosen here", so the
  // panel / config.json setting still applies.
  const env = process.env.AEMCP_TOOLS && process.env.AEMCP_TOOLS.toLowerCase() !== "false" ? process.env.AEMCP_TOOLS : undefined;
  const raw = (i >= 0 ? argv[i + 1] : undefined) ?? env ?? loadConfig().toolProfile ?? "core";
  const v = String(raw).trim().toLowerCase();
  if (v === "full" || v === "all" || v === "true") return { name: "full", allows: () => true };
  if (v === "core" || v === "false" || v === "") return { name: "core", allows: (t) => CORE_TOOLS.has(t) };
  const extra = new Set(v.split(",").map((s) => s.trim()).filter((s) => s && s !== "core"));
  return { name: "custom", allows: (t) => CORE_TOOLS.has(t) || extra.has(t) };
}

/**
 * Wraps server.registerTool so that tools outside the profile are never registered, and every
 * registered tool call runs with a call context (tool name + the AI app's cancel signal) and is
 * written to the activity log.
 */
export function applyProfile(server: McpServer, profile: ToolProfile) {
  const original = server.registerTool.bind(server) as (...a: any[]) => any;
  (server as any).registerTool = (name: string, config: any, cb: (...a: any[]) => any) => {
    if (!profile.allows(name)) return undefined;
    const wrapped = async (args: any, extra: any) => {
      const t0 = Date.now();
      let result: any;
      try {
        result = await callContext.run({ tool: name, signal: extra?.signal }, () => cb(args, extra));
        return result;
      } finally {
        const text: string = result?.content?.find((c: any) => c.type === "text")?.text ?? "";
        const changesAt = text.indexOf("\nChanges");
        logActivity({
          at: new Date(t0).toISOString(),
          client: (server.server as any).getClientVersion?.()?.name,
          tool: name,
          args,
          ms: Date.now() - t0,
          ok: !!result && !result.isError,
          summary: text.split("\n")[0].slice(0, 300) || (result ? undefined : "no result (exception)"),
          changes: changesAt >= 0 ? text.slice(changesAt).split("\n").filter((l) => /^[+~-] /.test(l)).length : undefined,
        });
      }
    };
    return original(name, config, wrapped);
  };
}
