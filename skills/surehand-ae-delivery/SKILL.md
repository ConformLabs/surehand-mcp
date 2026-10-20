---
name: surehand-ae-delivery
description: Checks an After Effects comp and its rendered file against the user's own delivery spec (QC preflight), fixes what fails and reports the exact verdict. Use for delivery specs, QC, renders.
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

## Notes

- maxFindings shortens the list; the counts stay complete.
- timeBudgetSeconds bounds the frame-by-frame project checks. When the budget stops a check, the report says so:
  pass that on.
