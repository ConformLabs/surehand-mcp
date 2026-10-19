// Tool profiles. Every tool definition is sent to the AI in every chat, so the full set
// (98 tools, ~27k tokens) is costly. The "core" profile keeps the essentials; anything else
// can still be done with ae_run_script.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../config.js";
import { activityDetails, logActivity } from "../activity.js";
import { callContext, type CallContext } from "../context.js";
import { env as envVar } from "../paths.js";

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
  // workflow: batches, safety copies, the user's own scripts
  "ae_batch",
  "ae_checkpoint",
  "ae_prove_identical",
  "ae_list_scripts",
  "ae_run_script_file",
  // every other tool, on demand
  "ae_tools",
  "ae_call",
]);

export interface ToolProfile {
  name: "core" | "full" | "custom";
  allows(tool: string): boolean;
}

/**
 * Resolution order: --tools <v>, SUREHAND_AE_TOOLS / AEMCP_TOOLS, config.toolProfile, default "core".
 * Values: "core", "full" ("true"/"false" from the .mcpb checkbox map to full/core), or
 * "core,ae_import_files,..." to add individual tools to the core set.
 */
export function resolveProfile(argv = process.argv): ToolProfile {
  const i = argv.indexOf("--tools");
  // The .mcpb checkbox always sends "true"/"false"; "false" means "not chosen here", so the
  // panel / config.json setting still applies.
  const tools = envVar("TOOLS");
  const env = tools && tools.toLowerCase() !== "false" ? tools : undefined;
  const raw = (i >= 0 ? argv[i + 1] : undefined) ?? env ?? loadConfig().toolProfile ?? "core";
  const v = String(raw).trim().toLowerCase();
  if (v === "full" || v === "all" || v === "true") return { name: "full", allows: () => true };
  if (v === "core" || v === "false" || v === "") return { name: "core", allows: (t) => CORE_TOOLS.has(t) };
  const extra = new Set(v.split(",").map((s) => s.trim()).filter((s) => s && s !== "core"));
  return { name: "custom", allows: (t) => CORE_TOOLS.has(t) || extra.has(t) };
}

export interface CatalogEntry {
  name: string;
  config: { title?: string; description?: string; inputSchema?: Record<string, any>; annotations?: Record<string, unknown> };
  /** the instrumented handler (call context + activity log), same as when the tool is called directly */
  run: (args: any, extra: any) => Promise<any>;
  direct: boolean;
}

/**
 * Wraps server.registerTool: every tool call runs with a call context (tool name + the AI app's
 * cancel signal) and is written to the activity log. Every tool goes into a catalog; only tools in
 * the profile are registered with the AI app directly, the rest stay reachable through ae_call.
 */
export function applyProfile(server: McpServer, profile: ToolProfile): Map<string, CatalogEntry> {
  const catalog = new Map<string, CatalogEntry>();
  const original = server.registerTool.bind(server) as (...a: any[]) => any;
  (server as any).registerTool = (name: string, config: any, cb: (...a: any[]) => any) => {
    const wrapped = async (args: any, extra: any) => {
      const t0 = Date.now();
      let result: any;
      const client: string | undefined = (server.server as any).getClientVersion?.()?.name;
      const ctx: CallContext = { tool: name, signal: extra?.signal, client };
      try {
        result = await callContext.run(ctx, () => cb(args, extra));
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
          ...activityDetails(name, text, ctx.last, ctx),
        });
      }
    };
    const direct = profile.allows(name);
    catalog.set(name, { name, config, run: wrapped, direct });
    return direct ? original(name, config, wrapped) : undefined;
  };
  return catalog;
}

/** Tool categories for ae_tools (anything not listed falls under "other"). */
export const CATEGORIES: Record<string, string[]> = {
  "status & app": ["ae_status", "ae_system_info", "ae_execute_menu_command", "ae_undo", "ae_redo", "ae_purge", "ae_get_fonts", "ae_reload_helpers", "ae_get_scripting_guide"],
  scripts: ["ae_run_script", "ae_run_script_file", "ae_list_scripts", "ae_batch", "ae_checkpoint", "ae_prove_identical"],
  project: ["ae_get_project_info", "ae_list_items", "ae_get_item_info", "ae_import_files", "ae_create_folder", "ae_move_items", "ae_rename_item", "ae_remove_items", "ae_replace_footage", "ae_save_project", "ae_open_project", "ae_new_project", "ae_project_health", "ae_project_history", "ae_project_xray", "ae_color_settings"],
  comps: ["ae_list_comps", "ae_get_comp_info", "ae_create_comp", "ae_set_comp_settings", "ae_duplicate_comp", "ae_open_comp", "ae_precompose", "ae_add_comp_marker", "ae_get_comp_map"],
  layers: ["ae_get_layer_info", "ae_add_layer", "ae_set_layer_attributes", "ae_delete_layers", "ae_duplicate_layer", "ae_split_layer", "ae_get_selection", "ae_select_layers", "ae_set_time_remap", "ae_align_layers"],
  "properties & keyframes": ["ae_get_properties", "ae_find_properties", "ae_set_property", "ae_set_keyframes", "ae_edit_keyframes", "ae_copy_keyframes", "ae_remove_keyframes", "ae_get_keyframes", "ae_set_keyframe_table", "ae_copy_ease", "ae_audit_easing", "ae_retime_keyframes", "ae_set_expression", "ae_get_expressions", "ae_check_expression", "ae_replace_in_expressions"],
  "effects, shapes & masks": ["ae_list_available_effects", "ae_get_effect_params", "ae_apply_effect", "ae_set_effect_params", "ae_remove_effect", "ae_apply_preset", "ae_add_shape", "ae_add_mask"],
  text: ["ae_set_text", "ae_style_text_range", "ae_set_paragraph", "ae_add_text_animator"],
  "3D": ["ae_set_camera", "ae_set_light", "ae_set_material"],
  audio: ["ae_audio_to_keyframes", "ae_audio_markers"],
  footage: ["ae_set_footage_interpretation", "ae_set_proxy", "ae_relink_footage"],
  "files & export": ["ae_find_files", "ae_export_frames"],
  checks: ["ae_preflight"],
  "see & measure": ["ae_render_frame", "ae_render_contact_sheet", "ae_get_layer_bounds", "ae_sample_pixels"],
  "essential graphics": ["ae_essential_graphics", "ae_export_mogrt"],
  render: ["ae_list_render_queue", "ae_add_to_render_queue", "ae_get_render_settings", "ae_set_render_settings", "ae_queue_in_media_encoder", "ae_render_background", "ae_render_jobs", "ae_render_queue_start", "ae_clear_render_queue"],
};
