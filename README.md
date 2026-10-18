# After Effects MCP

[![CI](https://github.com/ronyitzhaki/after-effects-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ronyitzhaki/after-effects-mcp/actions/workflows/ci.yml)

Connect **Claude** (Desktop / Code), **ChatGPT** (desktop app or web), Cursor, Codex, or any MCP client to **Adobe After Effects**.
The AI can run any script inside After Effects (modern JavaScript, converted for AE's ExtendScript engine automatically),
read information back, and use up to 92 ready-made tools for projects, comps, layers, keyframes (Graph Editor level),
text styling and animators, footage, effects, shapes, masks, 3D cameras/lights/materials, audio, color management,
Essential Graphics and rendering (including background renders with aerender). Batch edits run many steps as one
undo step, checkpoints keep safety copies of the project, and your own scripts can be listed and run. It can *see* and *measure* its work (frames, contact sheets, zoomed regions, difference
images, exact layer bounds, pixel colors), and every edit returns an exact list of what changed in the project.

```
Claude / ChatGPT ──MCP──> ae-mcp server (Node) ──localhost──> AE MCP bridge (extension inside After Effects) ──> ExtendScript
```

## Download

**[⬇ Download the latest release](https://github.com/ronyitzhaki/after-effects-mcp/releases/latest)**: get
`AE-MCP-<version>.zip` (everything, Mac + Windows), or just `AE-MCP.mcpb` if you only use Claude Desktop.
Unzip it and open `START HERE.txt`.

## Requirements

- After Effects 2020 (17.0) or newer on macOS or Windows, in any language (tested with AE 2025 and 2026 on macOS, and
  AE 2026 on Windows 11)
- Nothing else: the `.mcpb` uses Claude Desktop's built-in Node.js, and the installer downloads Node.js if it is missing

## Install

Get the release folder (`npm run package` in `server/` builds `dist-zip/AE-MCP/` and a zip). It looks like this:

```
AE-MCP/
  START HERE.txt
  1. Claude Desktop (easiest)/   AE-MCP.mcpb
  2. Mac/                        1. Install, 2. Test Installation, 3. Connect ChatGPT, 4. Uninstall (.command)
  3. Windows/                    1. Install, 2. Test Installation, 3. Connect ChatGPT, 4. Uninstall (.bat)
  Support files/                 run.sh, run.ps1, ae-mcp.mjs, this README
```

Then:

**Claude Desktop only (easiest):** double-click **`AE-MCP.mcpb`** and click Install in Claude Desktop. Restart After Effects once.
On first start the server installs its After Effects extension by itself.

**Any app (Claude Desktop, Claude Code, ChatGPT desktop, Cursor, Codex):** double-click **1. Install** in the
`2. Mac` or `3. Windows` folder, then restart After Effects once.
Use either the `.mcpb` or the installer for Claude Desktop, not both.

**Check it:** with After Effects open, double-click **2. Test Installation** in the same folder.

`START HERE.txt` (from `installer/START HERE.txt` in this repo) has the same steps in plain language for people you share it with, including what to do if
macOS Gatekeeper or Windows SmartScreen blocks the files.

The installer:
- uses the Node.js on your PATH, or downloads a private Node.js 22 LTS into `~/.aemcp/node` (checksum-verified)
- copies the MCP server to `~/.aemcp/server/ae-mcp.mjs` (one self-contained file)
- installs the After Effects extension (`com.aemcp`) into your user CEP extensions folder. The extension
  is signed, so it loads without enabling unsigned extensions (`PlayerDebugMode`)
- creates `~/.aemcp/config.json` with a random access token
- registers the server with **Claude Desktop**, **Claude Code**, **ChatGPT desktop / Codex** (`~/.codex/config.toml`,
  created if the ChatGPT or Codex app is installed) and **Cursor** if they are installed
  (original config files are backed up once as `*.aemcp.bak`); if Claude Desktop is open it offers to restart it,
  because a running Claude Desktop overwrites its config file

The server also checks the After Effects extension every time it starts and installs or updates it if needed, so
updating is just: replace the `.mcpb` (or re-run the installer) and restart After Effects.

The bridge starts automatically with After Effects; nothing needs to be opened.
To see its status, open **Window > Extensions > AE MCP** (green dot = connected, plus a log of recent calls).

To uninstall: double-click **4. Uninstall** (and remove the `.mcpb` in Claude Desktop >
Settings > Extensions if you used it).

## Testing on Windows

Confirmed working on Windows 11: install (including the automatic Node.js download), self-test, and the
ChatGPT desktop app. Use this checklist to test other machines.


You need a Windows 10/11 PC (or VM) with After Effects. Your Creative Cloud license allows two activations,
so a second machine works. On a Mac, a Windows VM in Parallels/VMware also works, but performance under
x64 emulation on Apple Silicon may be slow, so a real PC is better.

1. Copy `AE-MCP-<version>.zip` to the PC, right-click > **Extract All**.
2. Make sure After Effects is **closed**, then open `3. Windows` and double-click **1. Install**.
   - If SmartScreen appears: **More info > Run anyway**.
   - Expect: Node.js downloads if missing, then check marks for the server, the extension ("Extension is signed") and apps found.
3. Start After Effects and wait for it to finish loading.
4. Double-click **2. Test Installation** (same folder). All lines should show check marks, ending with
   "All checks passed".
5. In After Effects, open **Window > Extensions > AE MCP**: the dot should be green.
6. Open Claude Desktop (restart it if it was open during the install) and ask:
   *"Check After Effects is connected, then make a 1080p comp with an animated title and show me frame 1."*
7. Optional, more thorough: with Node installed, run `node server\scripts\smoke.mjs` from a full source checkout
   (`npm install` in `server\` first). This calls all major tools and needs After Effects open.
8. Also try the `.mcpb`: run **4. Uninstall**, double-click `1. Claude Desktop (easiest)\\AE-MCP.mcpb`, install it in Claude Desktop,
   ask Claude to check the connection (it should say to restart After Effects), restart AE, ask again.

Things worth checking specifically on Windows: paths with spaces or non-English characters in the user name,
a machine without Node.js (tests the automatic download), and Windows on ARM.
If something fails, send the full output of **2. Test Installation** and `%USERPROFILE%\.aemcp\bridge-status.json`.

### Other MCP clients

Point them at the installed server (stdio):

```json
{
  "mcpServers": {
    "after-effects": { "command": "/path/to/node", "args": ["/Users/<you>/.aemcp/server/ae-mcp.mjs"] }
  }
}
```

## ChatGPT

**ChatGPT desktop app (Mac/Windows): no tunnel needed.** It runs local MCP servers itself and reads the same
`~/.codex/config.toml` as Codex, which **1. Install** fills in. Restart ChatGPT after installing; **after-effects**
appears under **Settings > Plugins > Servers** (switch on). To add it by hand: **Add > MCP server > STDIO**, command =
the Node path printed by the installer, argument = `~/.aemcp/server/ae-mcp.mjs`. Tested working on Windows.

**ChatGPT on the web (chatgpt.com):** it can only reach MCP servers over public HTTPS, so the server runs in HTTP mode
behind a temporary tunnel:

1. Install a tunnel tool once: **cloudflared** (no account needed: `brew install cloudflared` on macOS,
   `winget install --id Cloudflare.cloudflared` on Windows) or [ngrok](https://ngrok.com/download).
2. Double-click **3. Connect ChatGPT** in the `2. Mac` or `3. Windows` folder. It prints a URL like
   `https://xxxx.trycloudflare.com/mcp/<token>`.
3. In ChatGPT: **Settings > Apps & Connectors > Advanced settings > Developer mode** on, then **Create** a connector,
   paste the URL, choose **No authentication** (the token is in the URL), and save.
4. In a chat, enable the connector from the tools menu. Keep that window open while you use it.

The URL contains your secret token: anyone with it can run scripts on your machine while the tunnel is up.
Quick-tunnel URLs change on every start, so update the connector URL each time (or set up a named Cloudflare tunnel).
To rotate the token, delete `token` from `~/.aemcp/config.json` and re-run the installer, then restart After Effects.

## What the AI can do

**Run anything** (the core feature):

| Tool | |
|---|---|
| `ae_run_script` | Run JavaScript in After Effects; `return` a value to get it back as JSON. Modern syntax (let/const, arrows, template strings, destructuring, classes, `?.`, `??`, `for...of`) and common built-ins (`map`, `filter`, `Object.keys`, `JSON`...) work: the code is converted for AE's ES3 engine with Babel, keeping line numbers. Errors come back with the failing line, the code around it, and a hint. `log()` output is returned. One undo step per call. |
| `ae_run_script_file` | Run a `.jsx` / `.jsxbin` file from disk with arguments. |
| `ae_get_scripting_guide` | ExtendScript cheat sheet for the model (also an MCP resource `aemcp://docs/extendscript`). |

**Tool profiles.** Every tool description is sent to the AI in every chat, so by default only a **core set of
28 tools** is loaded (about 9k tokens instead of 26k for all 94), and **every other tool stays available on demand**:
`ae_tools` lists all tools by category (or gives full parameter details of chosen ones), and `ae_call` runs any tool by
name with the same validation, permissions, change report and activity log. Loading everything up front is optional:
switch to **Full** in After Effects (**Window > Extensions > AE MCP > AI tools**), in Claude Desktop's
extension settings ("Enable all tools") for the `.mcpb`, or with `"toolProfile": "full"` in `~/.aemcp/config.json`, then
restart the AI app. Advanced: `"toolProfile": "core,ae_import_files,ae_render_queue_start"` adds single tools.

Core set: `ae_status`, `ae_run_script`, `ae_get_scripting_guide`, `ae_render_frame`, `ae_render_contact_sheet`,
`ae_get_project_info`, `ae_get_comp_info`, `ae_get_layer_info`, `ae_get_selection`, `ae_get_properties`,
`ae_find_properties`, `ae_get_layer_bounds`, `ae_get_comp_map`, `ae_create_comp`, `ae_add_layer`, `ae_add_shape`, `ae_set_property`, `ae_set_keyframes`,
`ae_set_expression`, `ae_apply_effect`, `ae_get_effect_params`, `ae_undo`, `ae_batch`, `ae_checkpoint`, `ae_list_scripts`,
`ae_run_script_file`, `ae_tools`, `ae_call`.

**Any After Effects language.** Property, effect and menu names are translated in non-English After Effects. Common
English names still work everywhere: property paths like `Transform/Opacity`, effects like "Gaussian Blur" and menu
commands like "Pre-compose..." are mapped to internal match names and command ids, which are the same in every
language. Match names (`ADBE ...`, as returned by `ae_get_properties` / `ae_get_effect_params`) always work, and an
unknown effect name gets suggestions.

**All tools (Full profile):**

- **Workflow:** `ae_batch` (many tool steps or scripts in one call and ONE undo step, with one change report; atomic by
  default: if a step fails everything is undone), `ae_checkpoint` (save a timestamped copy of the project, list, restore
  as a new file next to the original; the original is never overwritten), `ae_list_scripts` (your scripts: AE's Scripts
  folder, ScriptUI Panels, and folders listed as `"scriptFolders"` in `~/.aemcp/config.json`, with their descriptions)
  + `ae_run_script_file`
- **3D:** `ae_set_camera` (one/two-node, focal length in mm, depth of field; reports angle of view), `ae_set_light`
  (type, color, intensity, cone, falloff, shadows), `ae_set_material` (material options, lists the 3D renderers)
- **Audio:** `ae_audio_to_keyframes` (Convert Audio to Keyframes), `ae_audio_markers` (markers at beats/peaks)
- **Expressions:** `ae_check_expression` (try an expression and see errors and values without keeping it),
  `ae_replace_in_expressions` (project-wide find & replace, dry run, errors after the change)
- **Color:** `ae_color_settings` (Adobe or OCIO color engine, working space, bit depth, linearization, OCIO spaces)

- **Seeing the result:** `ae_render_frame` (a frame as an image; options: zoom into a region, render only some layers,
  transparency on a checkerboard or a color, difference image against another time or comp), `ae_render_contact_sheet`
  (a grid of frames across time, labelled with time and frame number, to judge motion and easing)
- **Measuring:** `ae_get_layer_bounds` (exact on-screen boxes after transforms, parenting, 3D and camera; in-frame and
  action/title-safe checks), `ae_sample_pixels` (rendered RGBA/hex at points), `ae_get_comp_map` (nested precomps,
  parenting, track mattes, expression references)
- **Status & app:** `ae_status`, `ae_system_info`, `ae_execute_menu_command`, `ae_undo`, `ae_redo`, `ae_purge`, `ae_get_fonts`, `ae_reload_helpers`
- **Project:** `ae_get_project_info`, `ae_list_items`, `ae_get_item_info`, `ae_import_files`, `ae_create_folder`, `ae_move_items`, `ae_rename_item`, `ae_remove_items`, `ae_replace_footage`, `ae_save_project`, `ae_open_project`, `ae_new_project`
- **Compositions:** `ae_list_comps`, `ae_get_comp_info`, `ae_create_comp`, `ae_set_comp_settings`, `ae_duplicate_comp`, `ae_open_comp`, `ae_precompose`, `ae_add_comp_marker`
- **Layers:** `ae_get_layer_info`, `ae_add_layer` (solid, text, shape, null, adjustment, camera, light, footage/comp), `ae_set_layer_attributes` (switches, timing, parent, blend mode, track matte, order...), `ae_delete_layers`, `ae_duplicate_layer`, `ae_split_layer`, `ae_get_selection`, `ae_select_layers`, `ae_set_text`
- **Properties & animation:** `ae_get_properties`, `ae_find_properties` (search all layers by name/match name, or list animated / expression properties), `ae_set_property`, `ae_set_keyframes` (interpolation + easing), `ae_remove_keyframes`, `ae_set_expression`, `ae_get_expressions`
- **Effects, shapes & masks:** `ae_list_available_effects`, `ae_get_effect_params` (an effect's exact parameter names, types, defaults and ranges, without touching your layers), `ae_apply_effect`, `ae_set_effect_params`, `ae_remove_effect`, `ae_apply_preset`, `ae_add_shape`, `ae_add_mask`
- **Keyframes (Graph Editor level):** `ae_edit_keyframes` (value, move in time, in/out interpolation, speed + influence per
  dimension, continuous/auto-Bezier, spatial tangents, roving, keyframe color labels, delete), `ae_copy_keyframes` (between
  properties/layers/comps, time range, offset), `ae_set_time_remap` (keys or freeze frame)
- **Text:** `ae_style_text_range` (per-character styling by range or matching words), `ae_set_paragraph` (justification,
  indents, spacing, box size), `ae_add_text_animator` (animator properties + range/wiggly/expression selector)
- **Footage:** `ae_set_footage_interpretation` (conform frame rate, alpha, fields, pulldown, loop, pixel aspect),
  `ae_set_proxy`, `ae_relink_footage` (find missing files by name in a folder tree, keeps sequences)
- **Essential Graphics:** `ae_essential_graphics` (add properties as controllers, template name), `ae_export_mogrt`
- **Project:** `ae_project_health` (missing footage/fonts/effects, expression errors, unused footage, empty comps/folders,
  duplicate comp names)
- **Render:** `ae_list_render_queue`, `ae_add_to_render_queue`, `ae_get_render_settings` / `ae_set_render_settings` (every
  render-settings and output-module setting as editable key/value pairs), `ae_queue_in_media_encoder`,
  `ae_render_background` + `ae_render_jobs` (aerender in a separate process, with progress and cancel; After Effects stays
  usable), `ae_render_queue_start`, `ae_clear_render_queue`

Comps can be referenced by id, name, or omitted for the active comp; layers by 1-based index or name; properties by
paths like `"Transform/Position"` or `"Effects/Gaussian Blur/Blurriness"` (display names or match names).

### Change report

Every call that edits the project ends with a **Changes** list, computed by After Effects itself (a snapshot before
and after the call), for example:

```
Changes (layers/properties compared in: Main):
+ layer "Headline" in "Main"
~ layer "Plate" in "Main": name "Plate" -> "Background"; locked off -> on
+ Headline > Effects/Glow
~ Headline > Transform/Opacity: 100 -> 0, expression added
~ Headline > Transform/Position: [640,360] -> [640,800], keyframes 0 -> 2
```

Project items are always compared; layers, properties, keyframes, expressions, effects and masks are compared in the
active comp and any comp named in the call. If a script fails halfway, the report lists what it had already changed.
`ae_undo` reports what was reverted. On very large comps (tens of thousands of properties) this adds up to about a
second per edit; turn it off with `"changeReport": false` in `~/.aemcp/config.json`, or per script with `report: false`.

### Example prompts

- "Make a 10 second 1080p comp with a dark gradient background and the title 'Summer Sale' that pops in with an overshoot, then show me frame 1s."
- "List every expression in the active comp that has an error and fix them."
- "Rename all layers in the selected comp to Title Case and color-label text layers yellow."
- "Import /Users/me/footage/*.mov, make a comp for each clip and add them all to the render queue as ProRes."

## Control and trust

**Permissions** (After Effects: Window > Extensions > AE MCP, or `"permissions"` in `~/.aemcp/config.json`; applies to
the next request, no restart):

| Mode | What happens |
|---|---|
| Full access (default) | Everything runs. Your AI app may still ask you before each tool call. |
| Ask before every change | Every edit and script waits in the AE MCP panel, showing the exact code or arguments, until you click **Allow** or **Deny**. The panel opens by itself. Reads are not held. |
| Read-only | Tools that edit are refused. Scripts still run (to read information), but if one changes the project it is undone immediately and the AI is told what it tried to change. |

**Shell commands** (`system.callSystem`) can be blocked separately. These are safeguards against mistakes, not a
sandbox: a script can still read and write files.

**Activity log.** Every tool call is recorded in `~/.aemcp/activity.jsonl` with time, AI app, tool, arguments
(including the full script code), duration and result. The AE MCP panel shows the latest calls (click one for its code),
**Open log** reveals the file, and `ae-mcp activity` prints it.

**Several After Effects versions at once.** Each running After Effects registers its own bridge (ports 8765+). The AI
controls the one you used most recently; `ae_status` lists all of them and switches with `instance: "2025"` (or a
version or port). Set a permanent preference with `"instance": "2026"` in the config.

**Cancel and stuck detection.** When the AI app cancels a request, it is dropped if After Effects hasn't started it yet.
If After Effects doesn't answer, the error says what it is busy with and for how long, and suggests checking for an open
dialog. `ae_status` shows the same.

**Compatibility check.** `ae-mcp selftest --full` runs every major tool (39 steps) against temporary comps (removed
afterwards), lists which scripting features your After Effects version has, and saves a report to `~/.aemcp/compat/`.
All steps pass on After Effects 2025 (25.6) and 2026 (26.5) on macOS and on 2026 on Windows 11, also with 2025 and 2026
running side by side; the panel, permissions, approvals and background rendering are verified on macOS and Windows.
Please share reports from other versions.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Cannot reach After Effects" | Make sure AE is running. Open **Window > Extensions > AE MCP** to see the bridge status. If **AE MCP** is missing from the menu, re-run the installer and fully restart AE. |
| Extension missing from the menu | Run `selftest`: it checks the extension's files against its signature (After Effects silently skips a signed extension whose files changed). Re-running the installer rewrites them. As a last resort, allowing unsigned extensions also works: set `PlayerDebugMode` to `1` with `defaults write com.adobe.CSXS.12 PlayerDebugMode 1` (macOS) or in the registry under `HKCU\Software\Adobe\CSXS.12` (Windows). |
| "Port 8765 is already in use" | Only one After Effects instance can host the bridge. Close the other instance, or change `bridgePort` in `~/.aemcp/config.json` and restart AE + your AI app. |
| "Token mismatch" | Re-run the installer (it keeps the existing token) and restart AE. |
| Scripts can't write files or use the network | Enable **Settings > Scripting & Expressions > Allow Scripts to Write Files and Access Network** in After Effects. Frame previews and the built-in tools work without it. |
| A call times out | ExtendScript can't be interrupted: long scripts or renders keep AE busy, and modal dialogs block it. Check AE, then retry. Pass `timeoutSeconds` for long jobs. |
| Claude Desktop doesn't show the tools | Quit Claude Desktop completely (menu bar / tray) and reopen it. Check `claude_desktop_config.json` contains `after-effects`. |

**Reporting a problem:** run **2. Test Installation**. If anything fails, it prints a diagnostics report at the end
(no secrets in it). You can also click **Copy diagnostics** in the AE MCP panel, or run `ae-mcp diagnostics`.
The panel also shows recent calls, and a banner when a new version is out (checked against GitHub at most once a day;
turn off with `"updateCheck": false` in `~/.aemcp/config.json`).

**Updating:** click **Update** in that banner, or run `ae-mcp update` (`node ~/.aemcp/server/ae-mcp.mjs update`). It
downloads the server from the latest GitHub release, checks its SHA-256 checksum and that it starts, replaces the installed
one (the old one is kept as `ae-mcp.mjs.previous`) and updates the After Effects extension. Restart After Effects and your
AI apps afterwards. If you use the Claude Desktop extension (.mcpb), install the new `AE-MCP.mcpb` from the release page
instead.

## Security

- The bridge listens on `127.0.0.1` only and requires the token from `~/.aemcp/config.json` (file mode 600);
  requests from web pages (with an `Origin` header) are rejected.
- `ae_run_script` can do anything an After Effects script can, including reading/writing files and running shell
  commands via `system.callSystem`. Only connect AI apps you trust, and keep the ChatGPT tunnel running only while you use it.

## Development

```
server/              MCP server (TypeScript) -> bundled into server/dist/ae-mcp.mjs
  src/aemcp.jsxinc     ExtendScript helper library, loaded into AE on demand (reloaded when it changes)
  src/tools/           tool definitions (each tool is a small ExtendScript function body)
  src/cli/             install / uninstall / selftest / chatgpt / setup commands (ae-mcp <command>)
  scripts/smoke.mjs    end-to-end test against a running After Effects
  scripts/package.mjs  builds the shareable release folder, zip and .mcpb
  scripts/release.mjs  cuts a release: version, sign, check, Windows test, package, CI, GitHub release
  scripts/test-mac.mjs      installs the build on this Mac and runs the full self-test on each open After Effects
  scripts/test-windows.mjs  the same on a Windows PC over SSH
  scripts/test-guard.mjs    lock and build checks so parallel test:mac runs don't test each other's build
  scripts/sign-extension.mjs  signs the After Effects extension
  scripts/ci-check.mjs assertions for the CI install / uninstall dry runs
extension/           After Effects extension (signed): invisible bridge (auto-starts) + status panel
installer/           run.sh / run.ps1: find or download Node.js, then run an ae-mcp command
  START HERE.txt       plain-language install guide (copied into the release)
  mac/, windows/       double-click launchers for a source checkout (the release generates its own)
.github/workflows/   CI: unit tests + real launcher install/test/uninstall on macOS and Windows
```

```bash
cd server
npm install
npm run check            # what CI runs: type-check, all tests, build (run before pushing)
npm test                 # unit tests only
npm run build            # -> dist/ae-mcp.mjs
node scripts/smoke.mjs   # live test: needs After Effects running with the bridge
npm run package          # -> ../dist-zip/AE-MCP/ (launchers, server, AE-MCP.mcpb) + zip
npm run sign             # re-sign the After Effects extension after changing extension/ or the version
                         # (needs the certificate in ~/.aemcp-signing; see scripts/sign-extension.mjs)
npm run test:mac         # install this build here and run the full self-test on each open After Effects
                         # (one run per Mac at a time: waits for ~/.aemcp/test-mac.lock; reports the commit tested)
npm run test:windows     # the same on the Windows PC over SSH
npm run release -- 1.4.0 --notes notes.md   # everything above, then commit, CI and the GitHub release
```

The After Effects extension in `extension/` is embedded in the server bundle at build time, and the server installs
or updates it when it starts. After changing the server or the panel: rebuild, re-run the installer, restart After Effects.

To add a tool, add an entry to one of the arrays in `server/src/tools/*.ts`: a zod input schema plus an ExtendScript
function body that receives `args` and can use the `aemcp` helpers.

## License

MIT, see [LICENSE](LICENSE). Created and maintained by Ron Yitzhaki ([@ronyitzhaki](https://github.com/ronyitzhaki)).
