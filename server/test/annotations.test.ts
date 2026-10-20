// MCP tool hints (readOnlyHint, destructiveHint, idempotentHint, openWorldHint) for every tool.
// AI apps use them to decide which calls to confirm with the user, so they must be explicit and
// accurate. A tool that is added without an entry here fails this test.
//
// What the hints mean here:
// - readOnly: changes nothing at all: not the project, not what the user sees (viewer, selection),
//   not the undo history, no files. Tools that create and remove temporary items or write files are
//   not read-only, even where read-only permission mode allows them.
// - destructive (only when not read-only): may delete content (items, layers, keyframes, effects,
//   expressions, render queue items), overwrite a file on disk, close the project or discard unsaved
//   work, clear the undo history, stop a render, or run arbitrary code / menu commands. Changing a
//   value or a setting that Edit > Undo restores is not destructive.
// - idempotent: calling it again with the same arguments has no further effect.
// - openWorld: can reach beyond After Effects and its files (shell commands, the network): only the
//   tools that run arbitrary scripts.
//
// The hints only change what AI apps are told. Permission modes (read-only / ask / full) use the
// tools' own readOnly / tempItems flags and are not affected by this table.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server.js";
import { ALL_JSX_TOOLS } from "../src/tools/all.js";
import { CORE_TOOLS, resolveProfile, type ToolProfile } from "../src/tools/profile.js";

type Hints = [readOnly: boolean, destructive: boolean, idempotent: boolean, openWorld: boolean];
const R: Hints = [true, false, true, false]; // read-only
const E: Hints = [false, false, false, false]; // edit (adds or changes)
const EI: Hints = [false, false, true, false]; // edit, idempotent
const D: Hints = [false, true, false, false]; // destructive
const DI: Hints = [false, true, true, false]; // destructive, idempotent
const SCRIPT: Hints = [false, true, false, true]; // arbitrary code: anything, incl. shell and network

const EXPECTED: Record<string, Hints> = {
  // connection, scripts, seeing
  ae_run_script: SCRIPT,
  ae_run_script_file: SCRIPT,
  ae_status: R, // `instance` only switches which AE this session talks to
  ae_reload_helpers: R,
  ae_render_frame: DI, // temporary comp + undo step; outputPath replaces an existing file
  ae_render_contact_sheet: DI,
  ae_get_scripting_guide: R,
  // project
  ae_get_project_info: R,
  ae_list_items: R,
  ae_get_item_info: R,
  ae_import_files: E,
  ae_create_folder: E,
  ae_move_items: EI,
  ae_rename_item: EI,
  ae_remove_items: D,
  ae_replace_footage: EI,
  ae_save_project: DI, // overwrites the .aep on disk
  ae_open_project: D, // closes the current project (discardChanges drops unsaved work)
  ae_new_project: D,
  ae_project_health: R,
  ae_project_xray: R,
  ae_color_settings: EI,
  // comps
  ae_list_comps: R,
  ae_get_comp_info: R,
  ae_create_comp: E,
  ae_set_comp_settings: EI,
  ae_duplicate_comp: E,
  ae_open_comp: EI, // changes the active viewer
  ae_precompose: E,
  ae_add_comp_marker: E,
  ae_get_comp_map: R,
  // layers
  ae_get_layer_info: R,
  ae_add_layer: E,
  ae_set_layer_attributes: EI,
  ae_delete_layers: D,
  ae_duplicate_layer: E,
  ae_split_layer: E,
  ae_get_selection: R,
  ae_select_layers: EI, // replaces the user's selection
  ae_set_time_remap: DI, // removes time-remap keyframes it doesn't keep; enabled:false drops them all
  // properties & keyframes
  ae_get_properties: R,
  ae_find_properties: R,
  ae_set_property: EI,
  ae_set_keyframes: DI, // clearExisting removes keyframes
  ae_edit_keyframes: D, // remove deletes keyframes (by index: a repeat removes others)
  ae_copy_keyframes: D, // replace deletes the target's keyframes
  ae_remove_keyframes: DI,
  ae_set_expression: DI, // "" deletes the expression
  ae_get_expressions: R,
  ae_check_expression: EI, // sets the expression on the real property, then restores it
  ae_replace_in_expressions: E, // a repeat replaces again (e.g. "a" -> "ab")
  // precision: keyframe tables, easing, retiming, measured layout
  ae_get_keyframes: R,
  ae_set_keyframe_table: DI, // replace removes the property's keys first
  ae_copy_ease: EI,
  ae_audit_easing: R,
  ae_retime_keyframes: E, // offset/stagger again shifts again
  ae_align_layers: EI, // measures with a temporary probe inside its own undo step
  // files & export
  ae_find_files: R, // runs in the MCP server, reads the file system only
  ae_export_frames: DI, // overwrite replaces existing PNGs; the temporary comp leaves no undo step
  // effects, shapes & masks
  ae_list_available_effects: R,
  ae_get_effect_params: EI, // temporary layer
  ae_apply_effect: E,
  ae_set_effect_params: EI,
  ae_remove_effect: D,
  ae_apply_preset: E,
  ae_add_shape: E,
  ae_add_mask: E,
  // text
  ae_set_text: EI,
  ae_style_text_range: EI,
  ae_set_paragraph: EI,
  ae_add_text_animator: E,
  // 3D
  ae_set_camera: E, // can create a camera
  ae_set_light: E, // can create a light
  ae_set_material: EI,
  // audio
  ae_audio_to_keyframes: E,
  ae_audio_markers: E,
  // footage
  ae_set_footage_interpretation: EI,
  ae_set_proxy: DI, // remove drops the proxy
  ae_relink_footage: EI,
  // see & measure
  ae_get_layer_bounds: EI, // temporary items
  ae_sample_pixels: EI, // temporary items
  // essential graphics
  ae_essential_graphics: E,
  ae_export_mogrt: DI, // overwrite replaces an existing .mogrt
  // render
  ae_list_render_queue: R,
  ae_add_to_render_queue: E,
  ae_get_render_settings: R,
  ae_set_render_settings: EI,
  ae_queue_in_media_encoder: D, // start encodes to the output paths, replacing existing files
  ae_render_queue_start: D, // renders to the output paths, replacing existing files
  ae_clear_render_queue: DI,
  ae_render_background: D, // writes the output file; save:true saves the project
  ae_render_jobs: DI, // cancel stops a render
  // status & app
  ae_execute_menu_command: D, // any menu command
  ae_undo: E, // reversible with ae_redo
  ae_redo: E,
  ae_purge: DI, // can clear the undo history
  ae_get_fonts: R,
  ae_system_info: EI, // temporary items
  // workflow
  ae_batch: SCRIPT, // steps can be ae_run_script
  ae_checkpoint: D, // save overwrites the .aep; restore closes the open project
  ae_prove_identical: SCRIPT, // run executes ae_batch steps (can be ae_run_script); capture/compare only render
  ae_project_history: E, // never changes the project, but writes (and prunes) its snapshot files under ~/.surehand/ae/history
  ae_list_scripts: R,
  // checks
  ae_reformat: D, // a new comp (and precomp copies) in one undo step; checkpoint: true saves the project (overwrites the .aep) first
  ae_preflight: [false, false, true, true], // never changes the project; may download ffmpeg (with consent) and writes temporary thumbnails
  ae_tools: R,
  ae_call: SCRIPT, // runs any tool, including ae_run_script
};

const FULL: ToolProfile = { name: "full", allows: () => true };

async function listTools(profile: ToolProfile) {
  const server = createMcpServer(profile);
  const client = new Client({ name: "annotations-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

const hints = (t: { annotations?: Record<string, unknown> }) => {
  const a = t.annotations ?? {};
  return [a.readOnlyHint, a.destructiveHint, a.idempotentHint, a.openWorldHint];
};

describe("tool annotations", () => {
  it("every tool (all of them, as listed in the .mcpb manifest) has the expected hints", async () => {
    const tools = await listTools(FULL);
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const t of tools) expect(hints(t), t.name).toEqual(EXPECTED[t.name]);
  });

  it("the core profile is a subset of the table, with the same hints", async () => {
    const tools = await listTools(resolveProfile(["node", "ae-mcp", "--tools", "core"]));
    expect(tools.map((t) => t.name).sort()).toEqual([...CORE_TOOLS].sort());
    for (const t of tools) expect(hints(t), t.name).toEqual(EXPECTED[t.name]);
  });

  it("no tool is hinted read-only while it edits (or needs temporary items) under the permission checks", () => {
    for (const t of ALL_JSX_TOOLS) {
      if (EXPECTED[t.name]?.[0]) expect(!!t.readOnly && !t.tempItems, t.name).toBe(true);
    }
  });

  it("the .mcpb manifest is built from the full tool list", () => {
    const pkg = readFileSync(fileURLToPath(new URL("../scripts/package.mjs", import.meta.url)), "utf8");
    expect(pkg).toMatch(/"--tools", "full"/);
    expect(pkg).toMatch(/tools: tools\.map/);
  });
});
