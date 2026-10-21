---
name: surehand-ae-delivery
description: Checks After Effects comps and renders against the user's delivery spec, stress-tests them, builds checked versions, readies farm renders. Use for QC, stress tests, versions, localization, farms.
license: MIT
---

# Delivery QC against the user's spec

Uses ae_preflight from the Surehand MCP server (surehand-ae). Preflight changes nothing in the project. In a chat
with only the core tools loaded, run it as ae_call {tool: "ae_preflight", args: {...}}. Follow the surehand-ae
skill for every edit.

## Rules

- The spec is the user's own. Every number comes from their delivery document (client, broadcaster, platform).
  Never invent, assume or fill in a "standard" value. A missing number is a question for the user, or a section
  left out.
- Report the verdict word exactly as the tool gives it: PASS, FAIL (n), WARNINGS (n) or INCOMPLETE (...).
- Never call something PASS when a check didn't run. INCOMPLETE is not a pass; say which checks didn't run and why.
- Quote timecodes exactly as the report gives them. Don't convert them to seconds or frames.
- ffmpeg (for the file checks) is downloaded only with the user's explicit consent. Ask first (it is about
  60-80 MB); only after a yes, pass allowFfmpegDownload: true.

## Workflow

1. **Write the spec.**
   - ae_preflight {action: "schema"} returns the shape and the JSON schema.
   - Fill in only what the delivery document states. Leave out sections it doesn't cover: a check runs only when
     its section is in the spec.
   - Show the spec to the user, then save it as a .json file next to the project (pass its path as spec) or pass
     it inline.
2. **Check the project:** ae_preflight {spec, target: "project"}. comp overrides spec.comp.
3. **Fix what fails.**
   - Fix only what the report flags. Don't restyle, retime or "improve" anything else.
   - When a fix is a creative decision (moving a title, shortening text that reads too fast, changing a color),
     ask first.
   - Related fixes go in one ae_batch. List every edit from its Changes list.
4. **Check again** with the same spec. Repeat until nothing fails, or what remains needs the user's decision.
5. **Check the rendered file.**
   - Render with the user's own render settings (ae_add_to_render_queue, ae_render_background), or ask the user
     for the file.
   - Then ae_preflight {spec, target: "file", file} or target: "both".
6. **Report:**
   - the verdict word;
   - the remaining findings with their timecodes;
   - every edit made;
   - every check that didn't run, and why.

## Versions from data

When a CSV / JSON file becomes many versions of a comp (names, scores, prices, bars, photos), use
ae_versions_from_data: it builds every row in one undo step and checks every row (values, text overflow and frame,
glyphs, fonts, bar sizes, footage). Follow references/versions-from-data.md for the workflow.

## Stress test

Before a comp goes to editors or a client, ae_stress_test measures what breaks with worst-case inputs (long
German, Arabic, CJK, empty, huge numbers, the user's own rows) on a scratch copy, and which expressions break in
After Effects in another language. Follow references/stress-test.md for the workflow.

## Render farm and chunked renders

When a render goes to a farm or another machine, or a long render should be split across processes or machines, use
ae_farm: a manifest of exactly what the render needs, a check of a node against it, a chunk plan with aerender
commands and scripts built from the render queue item's own settings, local parallel runs, and a verify that proves
every frame is there once and complete. Follow references/render-farm.md for the workflow.

## Localization

For translations (export the texts, import a version per language, fit by the user's rules, Hebrew and Arabic right
to left), use ae_localize. Follow references/localization.md for the workflow.

## Notes

- maxFindings shortens the list; the counts stay complete.
- timeBudgetSeconds bounds the frame-by-frame project checks. When the budget stops a check, the report says so:
  pass that on.
