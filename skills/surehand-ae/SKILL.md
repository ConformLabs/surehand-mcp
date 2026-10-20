---
name: surehand-ae
description: Works in Adobe After Effects (AE) through Surehand MCP. Reads the project first, edits comps, layers, keyframes and expressions, verifies every change. Use for any AE or .aep task.
license: MIT
---

# Working in After Effects with Surehand MCP

The Surehand MCP server (surehand-ae) runs tools inside the user's open After Effects. Every edit reports exactly
what it changed, and every tool call is one undo step. This is the working method; the other Surehand skills
(delivery, safe restructure, timing and layout) build on it.

## Before anything

- [ ] ae_status: confirms After Effects is reachable and shows the version, the open project, the active item and
      the permission mode. If it fails, report what it says. Don't retry in a loop.
- [ ] Read before editing:
  - ae_get_project_info: the items in the project.
  - ae_get_comp_info: a comp's settings and layers.
  - ae_get_comp_map: nested precomps, parenting and expression links.
  - ae_get_properties (or ae_find_properties): the exact property paths and match names. Never guess a path.
- [ ] Refer to comps and layers by name or id, not by whatever happens to be active.

## Editing

- Prefer the specific tools: ae_create_comp, ae_add_layer, ae_add_shape, ae_set_property, ae_set_keyframes,
  ae_set_expression, ae_apply_effect.
- Use ae_run_script only for what they don't cover. Read the resource aemcp://docs/extendscript (or call
  ae_get_scripting_guide) first, and references/extendscript-traps.md in this skill.
- Many related edits: one ae_batch call (one undo step, atomic by default), not a long script or many calls.
- Before a large or risky change: ae_checkpoint {action: "save", label: "..."}. Restoring opens a new file and
  never overwrites the original.
- On-demand tools: a chat may have only the core tools loaded. ae_tools lists every tool,
  ae_tools {describe: ["name"]} gives its parameters, and ae_call {tool, args} runs one that isn't loaded.

## Verify every edit

1. Read the Changes list the edit returns. Confirm it changed what was meant, and nothing else.
2. Look at anything visible:
   - ae_render_frame: one frame. region zooms in, layers isolates, background "checkerboard" shows transparency,
     compareWith gives a difference image against another time or comp.
   - ae_render_contact_sheet: motion over time.
   - ae_get_layer_bounds: positions, overlaps and safe areas in numbers.
3. Wrong result: ae_undo (one call reverts one tool call), then do it right. Don't stack fixes on a wrong edit.
4. Tell the user what changed, from the Changes list, not from what you intended.

## Permissions and refusals

The user picks a mode in the Surehand panel: Full, Ask (each edit waits for Allow or Deny in After Effects) or
Read-only.

- A refusal, a Deny, a pause, or a call the panel lists as NOT RUN is final. Report it in one line and stop that
  action.
- Never reach the same result another way: not with another tool, ae_run_script, ae_batch or a script file.
- If the edit is needed, say which mode would allow it. Changing the mode is the user's decision.

## Handing a project off

To send the project to someone else, package and prove it with ae_handoff_package. Follow references/handoff.md in
this skill.

## Files

Tools never replace an existing file silently: ae_save_project, ae_export_frames and the outputPath of
ae_render_frame and ae_render_contact_sheet refuse when the file exists. Pass overwrite: true only when the user
wants that file replaced.
