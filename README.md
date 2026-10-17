# After Effects MCP

Connect **Claude** (Desktop / Code), **ChatGPT**, Cursor, Codex, or any MCP client to **Adobe After Effects**.
The AI can run any ExtendScript (JSX) inside After Effects, read information back, and use 58 ready-made tools
for projects, comps, layers, keyframes, expressions, effects, shapes, masks, rendering, and frame previews it can *see*.

```
Claude / ChatGPT ──MCP──> ae-mcp server (Node) ──localhost──> AE MCP bridge (extension inside After Effects) ──> ExtendScript
```

## Requirements

- After Effects 2020 (17.0) or newer on macOS or Windows (tested on AE 2026 / macOS)
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

**Any app (Claude Desktop, Claude Code, Cursor, Codex) + ChatGPT:** double-click **1. Install** in the
`2. Mac` or `3. Windows` folder, then restart After Effects once.
Use either the `.mcpb` or the installer for Claude Desktop, not both.

**Check it:** with After Effects open, double-click **2. Test Installation** in the same folder.

`START HERE.txt` (from `INSTALL.txt` in this repo) has the same steps in plain language for people you share it with, including what to do if
macOS Gatekeeper or Windows SmartScreen blocks the files.

The installer:
- uses the Node.js on your PATH, or downloads a private Node.js 22 LTS into `~/.aemcp/node` (checksum-verified)
- copies the MCP server to `~/.aemcp/server/ae-mcp.mjs` (one self-contained file)
- installs the After Effects extension (`com.aemcp`) into your user CEP extensions folder and enables
  unsigned extensions (`PlayerDebugMode`) for CSXS 9-14
- creates `~/.aemcp/config.json` with a random access token
- registers the server with **Claude Desktop**, **Claude Code**, **Cursor** and **Codex** if they are installed
  (original config files are backed up once as `*.aemcp.bak`); if Claude Desktop is open it offers to restart it,
  because a running Claude Desktop overwrites its config file

The server also checks the After Effects extension every time it starts and installs or updates it if needed, so
updating is just: replace the `.mcpb` (or re-run the installer) and restart After Effects.

The bridge starts automatically with After Effects; nothing needs to be opened.
To see its status, open **Window > Extensions > AE MCP** (green dot = connected, plus a log of recent calls).

To uninstall: double-click **4. Uninstall** (and remove the `.mcpb` in Claude Desktop >
Settings > Extensions if you used it).

## Testing on Windows

You need a Windows 10/11 PC (or VM) with After Effects. Your Creative Cloud license allows two activations,
so a second machine works. On a Mac, a Windows VM in Parallels/VMware also works, but performance under
x64 emulation on Apple Silicon may be slow, so a real PC is better.

1. Copy `AE-MCP-<version>.zip` to the PC, right-click > **Extract All**.
2. Make sure After Effects is **closed**, then open `3. Windows` and double-click **1. Install**.
   - If SmartScreen appears: **More info > Run anyway**.
   - Expect: Node.js downloads if missing, then check marks for the server, extension, PlayerDebugMode and apps found.
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

ChatGPT connects to MCP servers over HTTPS, so the server runs in HTTP mode behind a temporary public tunnel:

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
| `ae_run_script` | Run ExtendScript code; `return` a value to get it back as JSON. Errors come back with line numbers; `log()` output is returned. One undo step per call. |
| `ae_run_script_file` | Run a `.jsx` / `.jsxbin` file from disk with arguments. |
| `ae_get_scripting_guide` | ExtendScript cheat sheet for the model (also an MCP resource `aemcp://docs/extendscript`). |

**Built-in tools:**

- **Status & app:** `ae_status`, `ae_system_info`, `ae_execute_menu_command`, `ae_undo`, `ae_redo`, `ae_purge`, `ae_get_fonts`, `ae_reload_helpers`
- **Project:** `ae_get_project_info`, `ae_list_items`, `ae_get_item_info`, `ae_import_files`, `ae_create_folder`, `ae_move_items`, `ae_rename_item`, `ae_remove_items`, `ae_replace_footage`, `ae_save_project`, `ae_open_project`, `ae_new_project`
- **Compositions:** `ae_list_comps`, `ae_get_comp_info`, `ae_create_comp`, `ae_set_comp_settings`, `ae_duplicate_comp`, `ae_open_comp`, `ae_precompose`, `ae_add_comp_marker`, `ae_render_frame` (returns a PNG the model can look at)
- **Layers:** `ae_get_layer_info`, `ae_add_layer` (solid, text, shape, null, adjustment, camera, light, footage/comp), `ae_set_layer_attributes` (switches, timing, parent, blend mode, track matte, order...), `ae_delete_layers`, `ae_duplicate_layer`, `ae_split_layer`, `ae_get_selection`, `ae_select_layers`, `ae_set_text`
- **Properties & animation:** `ae_get_properties`, `ae_set_property`, `ae_set_keyframes` (interpolation + easing), `ae_remove_keyframes`, `ae_set_expression`, `ae_get_expressions`
- **Effects, shapes & masks:** `ae_list_available_effects`, `ae_apply_effect`, `ae_set_effect_params`, `ae_remove_effect`, `ae_apply_preset`, `ae_add_shape`, `ae_add_mask`
- **Render:** `ae_list_render_queue`, `ae_add_to_render_queue`, `ae_render_queue_start`, `ae_clear_render_queue`

Comps can be referenced by id, name, or omitted for the active comp; layers by 1-based index or name; properties by
paths like `"Transform/Position"` or `"Effects/Gaussian Blur/Blurriness"` (display names or match names).

### Example prompts

- "Make a 10 second 1080p comp with a dark gradient background and the title 'Summer Sale' that pops in with an overshoot, then show me frame 1s."
- "List every expression in the active comp that has an error and fix them."
- "Rename all layers in the selected comp to Title Case and color-label text layers yellow."
- "Import /Users/me/footage/*.mov, make a comp for each clip and add them all to the render queue as ProRes."

## Troubleshooting

| Problem | Fix |
|---|---|
| "Cannot reach After Effects" | Make sure AE is running. Open **Window > Extensions > AE MCP** to see the bridge status. If **AE MCP** is missing from the menu, re-run the installer and fully restart AE. |
| Extension missing from the menu | Unsigned extensions must be allowed. The installer sets `PlayerDebugMode=1`; check with `defaults read com.adobe.CSXS.12` (macOS) or in the registry under `HKCU\Software\Adobe\CSXS.12` (Windows). |
| "Port 8765 is already in use" | Only one After Effects instance can host the bridge. Close the other instance, or change `bridgePort` in `~/.aemcp/config.json` and restart AE + your AI app. |
| "Token mismatch" | Re-run the installer (it keeps the existing token) and restart AE. |
| Frame previews / file writes fail | Enable **Settings > Scripting & Expressions > Allow Scripts to Write Files and Access Network** in After Effects. |
| A call times out | ExtendScript can't be interrupted: long scripts or renders keep AE busy, and modal dialogs block it. Check AE, then retry. Pass `timeoutSeconds` for long jobs. |
| Claude Desktop doesn't show the tools | Quit Claude Desktop completely (menu bar / tray) and reopen it. Check `claude_desktop_config.json` contains `after-effects`. |

Logs: the AE MCP panel shows recent calls; `~/.aemcp/bridge-status.json` shows whether the bridge is listening.

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
cep-panel/           After Effects extension: invisible bridge (auto-starts) + status panel
installer/           run.sh / run.ps1: find or download Node.js, then run an ae-mcp command
*.command, *.bat     double-click launchers for a source checkout (the release has its own, in folders)
```

```bash
cd server
npm install
npm test                 # unit tests (wrapper, bridge protocol, ES3 lint of every tool)
npm run build            # -> dist/ae-mcp.mjs
node scripts/smoke.mjs   # live test: needs After Effects running with the bridge
npm run package          # -> ../dist-zip/AE-MCP/ (launchers, server, AE-MCP.mcpb) + zip
```

The After Effects extension in `cep-panel/` is embedded in the server bundle at build time, and the server installs
or updates it when it starts. After changing the server or the panel: rebuild, re-run the installer, restart After Effects.

To add a tool, add an entry to one of the arrays in `server/src/tools/*.ts`: a zod input schema plus an ExtendScript
function body that receives `args` and can use the `aemcp` helpers.
