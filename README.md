<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/png/lockup-dark.png">
    <img src="brand/png/lockup-light.png" width="520" alt="Surehand MCP for Adobe® After Effects®">
  </picture>
</h1>

[![CI](https://github.com/ConformLabs/surehand-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ConformLabs/surehand-mcp/actions/workflows/ci.yml)

*Formerly AE MCP. Same tools, same install folder and AI-app settings; only the name changed.*

Surehand MCP connects **Claude** (Desktop / Code), **ChatGPT** (desktop app or web), Cursor, Codex, or any MCP client to **Adobe® After Effects®**.
The AI can run any script inside After Effects (modern JavaScript, converted for AE's ExtendScript engine automatically),
read information back, and use up to 98 ready-made tools for projects, comps, layers, keyframes (Graph Editor level),
text styling and animators, footage, effects, shapes, masks, 3D cameras/lights/materials, audio, color management,
Essential Graphics and rendering (including background renders with aerender). Batch edits run many steps as one
undo step, checkpoints keep safety copies of the project, structural changes can be proven not to change the render,
project history shows what changed between versions, and your own scripts can be listed and run. It can *see* and *measure* its work (frames, contact sheets, zoomed regions, difference
images, exact layer bounds, pixel colors), and every edit returns an exact list of what changed in the project.

```
Claude / ChatGPT ──MCP──> surehand-ae server (Node) ──localhost──> Surehand MCP bridge (extension inside After Effects) ──> ExtendScript
```

## Download

**[⬇ Download the latest release](https://github.com/ConformLabs/surehand-mcp/releases/latest)**: get
`Surehand-MCP-<version>.zip` (everything, Mac + Windows), or just `Surehand-MCP.mcpb` if you only use Claude Desktop.
Unzip it and open `START HERE.txt`.

## Requirements

- After Effects 2020 (17.0) or newer on macOS or Windows, in any language (tested on After Effects 2025-2026; older versions best effort)
- Nothing else: the `.mcpb` uses Claude Desktop's built-in Node.js, and the installer downloads Node.js if it is missing

## Install

Get the release folder (`npm run package` in `server/` builds `dist-zip/Surehand-MCP/` and a zip). It looks like this:

```
Surehand-MCP/
  START HERE.txt
  1. Claude Desktop (easiest)/   Surehand-MCP.mcpb
  2. Mac/                        1. Install, 2. Test Installation, 3. Connect ChatGPT, 4. Uninstall (.command)
  3. Windows/                    1. Install, 2. Test Installation, 3. Connect ChatGPT, 4. Uninstall (.bat)
  Support files/                 run.sh, run.ps1, surehand-ae.mjs, this README
```

Then:

**Claude Desktop only (easiest):** double-click **`Surehand-MCP.mcpb`** and click Install in Claude Desktop. Restart After Effects once.
On first start the server installs its After Effects extension by itself.

**Any app (Claude Desktop, Claude Code, ChatGPT desktop, Cursor, Codex):** double-click **1. Install** in the
`2. Mac` or `3. Windows` folder, then restart After Effects once.
Use either the `.mcpb` or the installer for Claude Desktop, not both.

**Check it:** with After Effects open, double-click **2. Test Installation** in the same folder.

`START HERE.txt` (from `installer/START HERE.txt` in this repo) has the same steps in plain language for people you share it with, including what to do if
macOS Gatekeeper or Windows SmartScreen blocks the files.

The installer:
- uses the Node.js on your PATH, or downloads a private Node.js 22 LTS into `~/.surehand/node` (checksum-verified)
- copies the MCP server to `~/.surehand/ae/server/surehand-ae.mjs` (one self-contained file)
- installs the After Effects extension (`com.aemcp`) into your user CEP extensions folder. The extension
  is signed, so it loads without enabling unsigned extensions (`PlayerDebugMode`)
- creates `~/.surehand/ae/config.json` with a random access token
- registers the server with **Claude Desktop**, **Claude Code**, **ChatGPT desktop / Codex** (`~/.codex/config.toml`,
  created if the ChatGPT or Codex app is installed) and **Cursor** if they are installed
  under the name `surehand-ae` (original config files are backed up once as `*.surehand.bak`); if Claude Desktop is open it offers to restart it,
  because a running Claude Desktop overwrites its config file

The server also checks the After Effects extension every time it starts and installs or updates it if needed, so
updating is just: replace the `.mcpb` (or re-run the installer) and restart After Effects.

The bridge starts automatically with After Effects; nothing needs to be opened.
To see its status, open **Window > Extensions > Surehand MCP** (green dot = connected, plus a log of recent calls).

To uninstall: double-click **4. Uninstall** (and remove the `.mcpb` in Claude Desktop >
Settings > Extensions if you used it).

## Testing on Windows

Confirmed working on Windows 11: install (including the automatic Node.js download), self-test, and the
ChatGPT desktop app. Use this checklist to test other machines.


You need a Windows 10/11 PC (or VM) with After Effects. Your Creative Cloud license allows two activations,
so a second machine works. On a Mac, a Windows VM in Parallels/VMware also works, but performance under
x64 emulation on Apple Silicon may be slow, so a real PC is better.

1. Copy `Surehand-MCP-<version>.zip` to the PC, right-click > **Extract All**.
2. Make sure After Effects is **closed**, then open `3. Windows` and double-click **1. Install**.
   - If SmartScreen appears: **More info > Run anyway**.
   - Expect: Node.js downloads if missing, then check marks for the server, the extension ("Extension is signed") and apps found.
3. Start After Effects and wait for it to finish loading.
4. Double-click **2. Test Installation** (same folder). All lines should show check marks, ending with
   "All checks passed".
5. In After Effects, open **Window > Extensions > Surehand MCP**: the dot should be green.
6. Open Claude Desktop (restart it if it was open during the install) and ask:
   *"Check After Effects is connected, then make a 1080p comp with an animated title and show me frame 1."*
7. Optional, more thorough: with Node installed, run `node server\scripts\smoke.mjs` from a full source checkout
   (`npm install` in `server\` first). This calls all major tools and needs After Effects open.
8. Also try the `.mcpb`: run **4. Uninstall**, double-click `1. Claude Desktop (easiest)\\Surehand-MCP.mcpb`, install it in Claude Desktop,
   ask Claude to check the connection (it should say to restart After Effects), restart AE, ask again.

Things worth checking specifically on Windows: paths with spaces or non-English characters in the user name,
a machine without Node.js (tests the automatic download), and Windows on ARM.
If something fails, send the full output of **2. Test Installation** and `%USERPROFILE%\.surehand\ae\bridge-status.json`.

### Other MCP clients

Point them at the installed server (stdio):

```json
{
  "mcpServers": {
    "surehand-ae": { "command": "/path/to/node", "args": ["/Users/<you>/.surehand/ae/server/surehand-ae.mjs"] }
  }
}
```

## ChatGPT

**ChatGPT desktop app (Mac/Windows): no tunnel needed.** It runs local MCP servers itself and reads the same
`~/.codex/config.toml` as Codex, which **1. Install** fills in. Restart ChatGPT after installing; **surehand-ae**
appears under **Settings > Plugins > Servers** (switch on). To add it by hand: **Add > MCP server > STDIO**, command =
the Node path printed by the installer, argument = `~/.surehand/ae/server/surehand-ae.mjs`. Tested working on Windows.

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
To rotate the token, delete `token` from `~/.surehand/ae/config.json` and re-run the installer, then restart After Effects.

## What the AI can do

**Run anything** (the core feature):

| Tool | |
|---|---|
| `ae_run_script` | Run JavaScript in After Effects; `return` a value to get it back as JSON. Modern syntax (let/const, arrows, template strings, destructuring, classes, `?.`, `??`, `for...of`) and common built-ins (`map`, `filter`, `Object.keys`, `JSON`...) work: the code is converted for AE's ES3 engine with Babel, keeping line numbers. Errors come back with the failing line, the code around it, and a hint. `log()` output is returned. One undo step per call. |
| `ae_run_script_file` | Run a `.jsx` / `.jsxbin` file from disk with arguments. |
| `ae_get_scripting_guide` | ExtendScript cheat sheet for the model (also an MCP resource `aemcp://docs/extendscript`). |

**Tool profiles.** Every tool description is sent to the AI in every chat, so by default only a **core set of
29 tools** is loaded (about 9k tokens instead of 27k for all 98), and **every other tool stays available on demand**:
`ae_tools` lists all tools by category (or gives full parameter details of chosen ones), and `ae_call` runs any tool by
name with the same validation, permissions, change report and activity log. Loading everything up front is optional:
switch to **Full** in After Effects (**Window > Extensions > Surehand MCP > AI tools**), in Claude Desktop's
extension settings ("Enable all tools") for the `.mcpb`, or with `"toolProfile": "full"` in `~/.surehand/ae/config.json`, then
restart the AI app. Advanced: `"toolProfile": "core,ae_import_files,ae_render_queue_start"` adds single tools.

Core set: `ae_status`, `ae_run_script`, `ae_get_scripting_guide`, `ae_render_frame`, `ae_render_contact_sheet`,
`ae_get_project_info`, `ae_get_comp_info`, `ae_get_layer_info`, `ae_get_selection`, `ae_get_properties`,
`ae_find_properties`, `ae_get_layer_bounds`, `ae_get_comp_map`, `ae_create_comp`, `ae_add_layer`, `ae_add_shape`, `ae_set_property`, `ae_set_keyframes`,
`ae_set_expression`, `ae_apply_effect`, `ae_get_effect_params`, `ae_undo`, `ae_batch`, `ae_checkpoint`, `ae_prove_identical`,
`ae_list_scripts`, `ae_run_script_file`, `ae_tools`, `ae_call`.

**Any After Effects language.** Property, effect and menu names are translated in non-English After Effects. Common
English names still work everywhere: property paths like `Transform/Opacity`, effects like "Gaussian Blur" and menu
commands like "Pre-compose..." are mapped to internal match names and command ids, which are the same in every
language. Match names (`ADBE ...`, as returned by `ae_get_properties` / `ae_get_effect_params`) always work, and an
unknown effect name gets suggestions.

**All tools (Full profile):**

- **Workflow:** `ae_batch` (many tool steps or scripts in one call and ONE undo step, with one change report; atomic by
  default: if a step fails everything is undone), `ae_checkpoint` (save a timestamped copy of the project, list, restore
  as a new file next to the original; the original is never overwritten; each checkpoint also gets a history snapshot),
  `ae_project_history` (snapshot the project, list snapshots and checkpoints, diff any two of them or the current
  project: see Project history below), `ae_prove_identical` (evidence that a
  structural change left the render unchanged, see "Proven edits" below), `ae_list_scripts` (your scripts: AE's Scripts
  folder, ScriptUI Panels, and folders listed as `"scriptFolders"` in `~/.surehand/ae/config.json`, with their descriptions)
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
- **Existing files are not replaced silently:** Save As in `ae_save_project` and the `outputPath` of `ae_render_frame` and
  `ae_render_contact_sheet` refuse when a file is already there, and the error says to pass `overwrite: true` to replace it
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
- **Checks:** `ae_preflight` (check the delivered comp and its render against your own delivery spec; see Preflight below)
- **Project:** `ae_project_health` (missing footage/fonts/effects, expression errors, unused footage, empty comps/folders,
  duplicate comp names); `ae_project_xray` (explains an inherited project: what the render queue pulls in, what
  every expression depends on and which links are fragile, what is missing, footage specs, what makes it heavy)
- **Render:** `ae_list_render_queue`, `ae_add_to_render_queue`, `ae_get_render_settings` / `ae_set_render_settings` (every
  render-settings and output-module setting as editable key/value pairs), `ae_queue_in_media_encoder`,
  `ae_render_background` + `ae_render_jobs` (aerender in a separate process, with progress and cancel; After Effects stays
  usable), `ae_render_queue_start`, `ae_clear_render_queue`

Comps can be referenced by id, name, or omitted for the active comp; layers by 1-based index or name; properties by
paths like `"Transform/Position"` or `"Effects/Gaussian Blur/Blurriness"` (display names or match names).

### Project X-ray

Opening someone else's project? Ask the AI to X-ray it (`ae_project_xray`). It reads the whole project without changing
anything and explains how it works instead of tidying it: which comps the render queue actually renders and the
precomps each one pulls in (and which comps nothing renders), what every expression reads and which layers the rig
hangs on, which links are already broken or will break when a layer is renamed or reordered or the project is opened
in another After Effects language, which plug-ins, footage and fonts are missing, how the footage is specified
(frame rates that don't match their comps, very large sources) and what makes it slow to render (heavy effects, effects
hidden on shy or disabled layers, high motion blur samples, the 3D renderer, frame blending, footage scaled far down).
You get a plain-language answer; the AI gets precise locations (comp > layer > property). Big projects are read
within a time budget and say so when the answer is partial; `comps` and `sections` narrow it down.

### Preflight

Before you deliver, ask the AI to preflight the comp (`ae_preflight`). It checks the project, and optionally the
rendered file, against **your delivery spec**: a small JSON file with the numbers from your client's or
broadcaster's delivery document (or the same thing inline in the chat). Nothing is built in: there are no house
presets, every section of the spec is optional, and a check only runs when its section is there. The AI can help you
write the spec (`action: "schema"` gives it the fields).

In the project, for the delivered comp (`comp` in the spec, otherwise the active comp):

- **Video:** comp size, frame rate, pixel aspect ratio and duration (exact, with a tolerance in frames, or a range).
- **Project:** bit depth, working color space, missing footage, fonts and effects, expression errors, disabled layers
  that still carry effects (the same collector as Project X-ray, limited to the delivered comp and its precomps).
- **Safe areas over time:** every visible text layer, and any layer you name (wildcards like `Logo*`), on every frame
  (or every Nth frame) where it is visible: its box after position, scale, rotation, anchor point and parents, and through
  the precomps it sits in, against title-safe, action-safe or the frame. Problems come back as time ranges, for example
  "Title: outside title-safe 00:00:02:03–00:00:03:10 (2.12s–3.40s), 46 px past it on the right at most". Layers that are off,
  transparent (opacity 0) or outside their in/out points are not visible and are not checked. 3D layers are reported
  as not checked (check them with `ae_get_layer_bounds`, which projects through the camera); auto-orient, and effects
  that move or scale the pixels outside the transform (Transform, Offset, layer styles, text animators), are flagged as
  a warning that the bounds may be off. A `layersMustBeIn` name that matches no layer is a warning, not a pass.
- **Text:** smallest cap height (estimated as 0.7 x the font size x the layer's scale, since real fonts vary from about
  0.65 to 0.75), reading speed (characters per second while the text is visible, spaces included, line breaks not),
  shortest time on screen, paragraph text that overflows its box (After Effects 24.6 or later), and characters the font
  has no glyph for (After Effects 25.1 or later); on older versions the report says the check isn't available.

On a rendered file (`target: "file"` or `"both"`): codec, container, bit depth, chroma subsampling, alpha, field order,
color tags, legal range, black and frozen frames, loudness and true peak, and a flash check. File checks need ffmpeg:
the one on your system, or a one-time download. The flash check is a **pre-check** to catch obvious problems early; it
is not a certified PSE / Harding test.

The report starts with the verdict: **FAIL (n)** when anything failed; otherwise **INCOMPLETE (n checks not run)**
when a check the spec asks for couldn't run or ran on incomplete data (no ffmpeg, an RGB file for legal range, a check
that needs a newer After Effects, a file that couldn't be read to the end), so a check that didn't run is never a pass;
otherwise **WARNINGS (n)** or **PASS**. Then the checks that were requested but not run and why, the findings grouped by
check (failures first, then warnings, by time), with timecode in the comp's frame rate and seconds, where the problem is
(comp > layer) and a short fix, then what this run doesn't cover (a section not in the spec, a file check on a project
target). For files it also shows what ffprobe found and up to four frames at the worst problems. Preflight changes
nothing in the project and leaves no undo step, so it also runs in read-only mode. Long comps are checked within a
time budget (`timeBudgetSeconds`, default 120 s); a partial check says so.

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
second per edit; turn it off with `"changeReport": false` in `~/.surehand/ae/config.json`, or per script with `report: false`.

### Preflight: rendered files

Preflight also checks the rendered file itself against the same delivery spec, with ffprobe and one ffmpeg pass over
the picture and sound. Each check runs only when its section is in the spec; a requested check that can't run is listed
with the reason (no ffmpeg, an RGB file for legal range, a value ffmpeg didn't report...) and makes the verdict
INCOMPLETE. A file with no audio stream fails when the spec asks for audio (usually Audio Output was off in the output
module). Every decoded frame is counted against the picture's own duration: a truncated or damaged file fails ("only
2.8 s of 8 s could be decoded") instead of passing on the part that was read, and decoding errors are a warning.
Durations (and black / frozen at the end) are the picture's, not the container's; sound that runs longer or shorter
than the picture by more than a frame is a warning.

| Spec section | What is measured in the file |
|---|---|
| `video` | container (file extension), codec, frame size, pixel aspect, frame rate (`30000/1001` is 29.97, not 30), duration (± `durationToleranceFrames`), bit depth, chroma subsampling, alpha, field order, and the signalled color primaries / transfer / matrix / range (a tag that isn't there is a warning) |
| `audio` | sample rate, channels, `required`; loudness per ITU-R BS.1770 / EBU R128 (ffmpeg `ebur128`): integrated, loudness range, true peak, highest short-term (3 s) loudness |
| `legalRange` | every pixel of every frame, in the file's own bit depth scaled to 8-bit (a 10-bit 941 is 235.25: out of 16-235); a frame fails when more than `maxOutOfRangePercent` of its pixels are outside the luma / chroma range. Reported as time ranges, with the worst frame and its code values. YUV files only |
| `black`, `frozen` | ffmpeg `blackdetect` / `freezedetect`: runs longer than `maxSeconds` (black allowed at the start / end per `allowAtStart` / `allowAtEnd`; a black run isn't reported again as frozen) |
| `flash` | a **pre-check, not a certified PSE / Harding test**: the picture as a 32x18 grid, relative luminance per cell; a transition is a change of at least `minLuminanceChange` where the darker state is below 0.8, a flash is a pair of opposing transitions over at least `minAreaFraction` of the screen; more than `maxFlashesPerSecond` in any second fails. Saturated red flashes (R/(R+G+B) >= 0.8, change of (R-G-B)x320 > 20) are checked too unless `redFlash` is false (definitions after ITU-R BT.1702 / WCAG 2.x) |

Times in the findings are seconds in the file. Up to four JPEG frames (960 px wide at most) from the most important
failing times are written to `~/.surehand/ae/tmp`, shown in the report and deleted right after (also when the check is
cancelled; leftovers older than a day are swept). A one-minute 1080p ProRes 422 HQ file with every check takes about 4 s on
an Apple Silicon Mac (legal range marks the out-of-range pixels and measures that mask averaged down to a small grid,
which is exact and much faster than full statistics on every frame).

**ffmpeg.** Surehand MCP uses, in this order: `"ffmpegPath"` / `"ffprobePath"` in `~/.surehand/ae/config.json`, a private
copy in `~/.surehand/ffmpeg`, then the PATH (plus `/opt/homebrew/bin` and `/usr/local/bin` on a Mac). If there is none, it
can download FFmpeg 9.0.2 once into `~/.surehand/ffmpeg`, only after you allow it (in "ask" permission mode you also
approve it in the Surehand MCP panel; in read-only mode it never downloads). The download is a pinned build checked
against a SHA-256 written in the source, and must start and report the expected version before it is used; anything
else is refused and nothing is installed:

- macOS (Apple Silicon and Intel): Martin Riedl's static release builds ([ffmpeg.martin-riedl.de](https://ffmpeg.martin-riedl.de)),
  `ffmpeg.zip` + `ffprobe.zip`, about 60 MB. These are GPL v3 builds (they include x264 / x265).
- Windows x64 (and Windows on Arm, which runs x64 programs): [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds)
  `ffmpeg-n9.0.2-...-win64-lgpl-shared-9.0.zip` from a month-end release (those are kept), about 77 MB. LGPL v2.1+.

Surehand MCP doesn't ship or redistribute FFmpeg: it downloads the publisher's own file on your machine and runs it as a
separate program, so FFmpeg's licence (the GPL / LGPL terms above, with its source available from ffmpeg.org) applies to
that copy and not to Surehand MCP. `~/.surehand/ffmpeg/SOURCE.json` records what was installed and from where. To use your
own FFmpeg instead, install it (`brew install ffmpeg`, `winget install ffmpeg`) or set `"ffmpegPath"`.

### Proven edits

Some changes should not change the picture at all: un-precomposing, duplicating a comp deeply, baking or collapsing
expressions, reordering effects, simplifying a rig. `ae_prove_identical` checks that. It renders reference frames of the
comps (by default the active comp, 5 frames across the work area, full size, at most 1920 px), you or the AI make the
change, and it renders the same frames again and compares them pixel by pixel. The answer is **identical**,
**identical within tolerance** (by default less than half an 8-bit step, so only the rounding of 16/32-bit projects passes; `tolerance: 0` asks for bit-identical), or **differs**, with, for each frame, the largest
channel difference, how many pixels changed, the largest color difference (ΔE), the area that changed, and a
difference image of the worst frame (black = identical). If a comp was deleted or resized since the capture, it says so.
What is compared is the sampled video frames, alpha included: audio, the comp's background color and the times between
the sampled frames are not, and 32-bit values above 1.0 are clamped when the frames are saved, so differences in
over-bright areas can be missed. Comp ids belong to one project: a proof captured in a saved project is only compared in
that same file (otherwise the verdict is not proven); one captured in an unsaved project is compared if every comp still
has its name, with a note that the project itself couldn't be confirmed.
`action: "run"` does it in one call: capture, the edits as `ae_batch` steps (one undo step, all or nothing), compare.
Reference frames are stored in `~/.surehand/ae/proofs/` for 7 days (30 proofs at most). Rendering works like
`ae_render_frame`: through a temporary comp that is removed again and leaves no undo step behind (After Effects still
marks the project as changed); if the temporary comp can't be removed, the result says so. Capture and compare are
allowed in read-only mode; `run` makes edits, so it follows the same permissions as `ae_batch`.

### Project history

"What changed between v11 and v12?" `ae_project_history` answers it. A **snapshot** is a record of the open project:
every item (comps, footage with its file paths, solids, folders), comp settings, every layer with its switches,
timing, parent and track matte, every property that isn't at its default or is animated (values, keyframes with
interpolation and easing), expressions, effects, masks, text, markers and the render queue. Taking one doesn't change
the project and adds no undo step; snapshots are kept in `~/.surehand/ae/history` (the last 100 per project), and every
`ae_checkpoint save` stores one too, so checkpoints can be compared (with a 15 s time budget, so saving stays quick; if
that isn't enough, the checkpoint says the snapshot is partial and a full one can be taken with `snapshot`). A **diff** compares two snapshots, or a snapshot with
the project as it is now, and lists what changed, grouped by comp, with a summary first:

```
Summary: 1 layer added, 1 layer renamed, 2 values changed, 1 keyframe change, 1 expression changed, 1 effect added
Comp "Main" (id 12):
  + layer #1 "Logo" (shape)
  ~ layer #2 "Title": renamed from "Headline"
  + Title > Effects/Glow (ADBE Glo2)
  ~ Title > Transform/Opacity: keyframes: @1s 100 -> 80
  ~ Title > Transform/Position: expression changed:
        - wiggle(2, 10)
        + wiggle(3, 10)
```

Refer to versions by label ("v11"), snapshot or checkpoint id, `latest`, `previous` or `current`. Long diffs are cut
with a count of what's left; `detail` shows one comp in full. A big project takes a while to read (seconds for
thousands of layers): `comps` limits a snapshot to some comps and `timeBudgetSeconds` caps the time (comps not reached
are reported, never silently skipped). Checkpoints saved before this feature have no snapshot; comparing them would
mean opening the old `.aep` in place of your project, so it isn't done automatically.

### Example prompts

- "Make a 10 second 1080p comp with a dark gradient background and the title 'Summer Sale' that pops in with an overshoot, then show me frame 1s."
- "List every expression in the active comp that has an error and fix them."
- "Rename all layers in the selected comp to Title Case and color-label text layers yellow."
- "Un-precompose 'Logo Precomp' into the main comp and prove the render didn't change."
- "Import /Users/me/footage/*.mov, make a comp for each clip and add them all to the render queue as ProRes."

## Control and trust

**Permissions** (After Effects: Window > Extensions > Surehand MCP, or `"permissions"` in `~/.surehand/ae/config.json`; applies to
the next request, no restart):

| Mode | What happens |
|---|---|
| Full access (default) | Everything runs. Your AI app may still ask you before each tool call. |
| Ask before every change | Every edit and script waits in the Surehand MCP panel, showing the exact code or arguments, until you click **Allow** or **Deny**. The panel opens by itself. Reads are not held. |
| Read-only | Tools that edit are refused. Scripts still run (to read information), but if one changes the project it is undone immediately and the AI is told what it tried to change. Scripts that touch the undo history (`executeCommand`, `beginUndoGroup`, `endUndoGroup`, `purge`) or do things that can't be undone (opening, closing or saving projects, `newProject`, `quit`, rendering, `scheduleTask`, saving preferences) are refused before they run. This is a text check (comments are ignored, escapes are decoded; a name inside a string or on another object counts too): a call assembled at runtime gets past it, and is then undone at most once, checked with a temporary undo marker, and reported if the project isn't back. |

**Shell commands** (`system.callSystem`) can be blocked separately. These are safeguards against mistakes, not a
sandbox: a script can still read and write files.

**Activity log.** Every tool call is recorded in `~/.surehand/ae/activity.jsonl` with time, AI app, tool, arguments
(including the full script code), duration and result. The Surehand MCP panel shows the latest calls (click one for its code),
**Open log** reveals the file, and `surehand-ae activity` prints it.

**Several After Effects versions at once.** Each running After Effects registers its own bridge (ports 8765+). The AI
controls the one you used most recently; `ae_status` lists all of them and switches with `instance: "2025"` (or a
version or port). Set a permanent preference with `"instance": "2026"` in the config.

**Cancel and stuck detection.** When the AI app cancels a request, it is dropped if After Effects hasn't started it yet.
If After Effects doesn't answer, the error says what it is busy with and for how long, and suggests checking for an open
dialog. `ae_status` shows the same.

**Compatibility check.** `surehand-ae selftest --full` runs every major tool (over 60 steps) against temporary comps (removed
afterwards; if the open project has no unsaved changes, the Save As and checkpoint-restore checks briefly switch to a
scratch project and then reopen it), lists which scripting features your After Effects version has, and saves a report to `~/.surehand/ae/compat/`.
All steps pass on After Effects 2025 (25.6) and 2026 (26.5) on macOS and on 2026 on Windows 11, also with 2025 and 2026
running side by side; the panel, permissions, approvals and background rendering are verified on macOS and Windows.
Please share reports from other versions.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Cannot reach After Effects" | Make sure AE is running. Open **Window > Extensions > Surehand MCP** to see the bridge status. If **Surehand MCP** is missing from the menu, re-run the installer and fully restart AE. |
| Extension missing from the menu | Run `selftest`: it checks the extension's files against its signature (After Effects silently skips a signed extension whose files changed). Re-running the installer rewrites them. As a last resort, allowing unsigned extensions also works: set `PlayerDebugMode` to `1` with `defaults write com.adobe.CSXS.12 PlayerDebugMode 1` (macOS) or in the registry under `HKCU\Software\Adobe\CSXS.12` (Windows). |
| "Port 8765 is already in use" | Only one After Effects instance can host the bridge. Close the other instance, or change `bridgePort` in `~/.surehand/ae/config.json` and restart AE + your AI app. |
| "Token mismatch" | Re-run the installer (it keeps the existing token) and restart AE. |
| Scripts can't write files or use the network | Enable **Settings > Scripting & Expressions > Allow Scripts to Write Files and Access Network** in After Effects. Frame previews and the built-in tools work without it. |
| A call times out | ExtendScript can't be interrupted: long scripts or renders keep AE busy, and modal dialogs block it. Check AE, then retry. Pass `timeoutSeconds` for long jobs. |
| "After Effects is busy or showing a dialog" | A dialog or settings window (Project Settings, Preferences, an alert) is open in AE, or AE is still starting. Close it and retry: the call did not run and won't run later. Reported after 3s; change with `"blockedAfterSeconds"` in `~/.surehand/ae/config.json` (`0` waits for the full timeout). Scripts that have started are never cut short. |
| Claude Desktop doesn't show the tools | Quit Claude Desktop completely (menu bar / tray) and reopen it. Check `claude_desktop_config.json` contains `surehand-ae`. |

**Reporting a problem:** run **2. Test Installation**. If anything fails, it prints a diagnostics report at the end
(no secrets in it). You can also click **Copy diagnostics** in the Surehand MCP panel, or run `surehand-ae diagnostics`.
The panel also shows recent calls, and a banner when a new version is out (checked against GitHub at most once a day;
turn off with `"updateCheck": false` in `~/.surehand/ae/config.json`).

**Updating:** click **Update** in that banner, or run `surehand-ae update` (`node ~/.surehand/ae/server/surehand-ae.mjs update`;
`update --check` only reports). It downloads the server from the latest GitHub release, checks its SHA-256 checksum and that it
starts, replaces the installed one (the old one is kept as `surehand-ae.mjs.previous`) and updates the After Effects extension. Restart After Effects and your
AI apps afterwards. If you use the Claude Desktop extension (.mcpb), install the new `Surehand-MCP.mcpb` from the release page
instead.

**Upgrading from 1.3: automatic.** Version 1.3 kept everything in `~/.aemcp`. The first time 1.4 runs (installer, update,
or just starting), it moves it: settings, checkpoints, project history and your other files to `~/.surehand/ae`, the private
Node.js and ffmpeg to `~/.surehand`, and points the AI apps that ran the old server at the new one (`after-effects` becomes
`surehand-ae`; an `after-effects` entry that isn't ours is left alone). Nothing is deleted: if something can't be moved
(a file in use), everything stays where it was, keeps working from there, and the move is tried again later; the reason
is in `~/.surehand/migration.log`. Until After Effects is restarted once, the old extension still runs in it and uses
`~/.aemcp`, so a copy of `config.json`, an `instances` folder, a small `server/ae-mcp.mjs` that starts the new server and
`MOVED.txt` stay there; uninstalling removes them too.
With the Claude Desktop extension: the 1.4 `.mcpb` is a new extension to Claude Desktop (named `surehand-ae`), so after
installing it remove the old Surehand MCP entry in **Settings > Extensions**.

**Environment variables** (each also works with the older `AEMCP_` prefix): `SUREHAND_AE_CONFIG` (config file; instances are
looked up next to it), `SUREHAND_AE_BRIDGE_PORT`, `SUREHAND_AE_TOKEN`, `SUREHAND_AE_HTTP_PORT`, `SUREHAND_AE_HTTP_TOKEN`,
`SUREHAND_AE_TOOLS` (`core` / `full`), `SUREHAND_AE_INSTANCE`, `SUREHAND_AE_BLOCKED_AFTER_SECONDS`,
`SUREHAND_AE_STARTUP_WAIT_SECONDS`, `SUREHAND_AE_NO_UPDATE_CHECK`, `SUREHAND_AE_NO_AUTOSETUP`, `SUREHAND_AE_NO_ACTIVITY_LOG`.

**Commands for the panel** (all print JSON with `--json` and never ask anything): `clients` (the AI apps and whether they
are connected), `connect <app>` / `disconnect <app>` (`claude-desktop`, `claude-code`, `codex`, `cursor`), `checkpoints
[--project <path>]`, `checkpoint-diff <id> [--project <path>]` (needs After Effects: it compares with the open project),
`test --json` (the quick self-test as `[{name, ok, detail, fix}]`) and `update --check`. The panel runs them with the Node
and server named in `~/.surehand/ae/runtime.json`.

## Security

- The bridge listens on `127.0.0.1` only and requires the token from `~/.surehand/ae/config.json` (file mode 600);
  requests from web pages (with an `Origin` header) are rejected.
- `ae_run_script` can do anything an After Effects script can, including reading/writing files and running shell
  commands via `system.callSystem`. Only connect AI apps you trust, and keep the ChatGPT tunnel running only while you use it.

## Development

```
server/              MCP server (TypeScript) -> bundled into server/dist/surehand-ae.mjs
  src/aemcp.jsxinc     ExtendScript helper library, loaded into AE on demand (reloaded when it changes)
  src/tools/           tool definitions (each tool is a small ExtendScript function body)
  src/cli/             install / uninstall / selftest / chatgpt / setup commands (surehand-ae <command>)
  scripts/smoke.mjs    end-to-end test against a running After Effects
  scripts/package.mjs  builds the shareable release folder, zip and .mcpb
  scripts/release.mjs  cuts a release: version, sign, check, Mac + Windows tests, package, installers, release PR, CI, merge, GitHub release
  scripts/test-mac.mjs      installs the build on this Mac and runs the full self-test on each open After Effects
  scripts/test-windows.mjs  the same on a Windows PC over SSH
  scripts/test-guard.mjs    lock and build checks so parallel test:mac runs don't test each other's build
  scripts/sign-extension.mjs  signs the After Effects extension
  scripts/package-mac-pkg.mjs        the signed, notarized Mac installer (.pkg)
  scripts/package-win-installer.mjs  the Windows installer (.exe, NSIS, built on the Mac)
  scripts/sign-win.mjs               signs Windows files with the Certum certificate (SimplySign)
  scripts/ci-check.mjs assertions for the CI install / uninstall dry runs
extension/           After Effects extension (signed): invisible bridge (auto-starts) + status panel
installer/           run.sh / run.ps1: find or download Node.js, then run a surehand-ae command
  START HERE.txt       plain-language install guide (copied into the release)
  mac/, windows/       double-click launchers for a source checkout (the release generates its own)
brand/               the logo: master SVGs, PNG sizes, Surehand.icns / Surehand.ico (see brand/README.md)
.github/workflows/   CI: unit tests + real launcher install/test/uninstall on macOS and Windows
```

```bash
cd server
npm install
npm run check            # what CI runs: type-check, all tests, build (run before pushing)
npm test                 # unit tests only
npm run build            # -> dist/surehand-ae.mjs
node scripts/smoke.mjs   # live test: needs After Effects running with the bridge
npm run package          # -> ../dist-zip/Surehand-MCP/ (launchers, server, Surehand-MCP.mcpb) + zip
npm run sign             # re-sign the After Effects extension after changing extension/ or the version
                         # (needs the certificate in ~/.aemcp-signing; see scripts/sign-extension.mjs)
npm run test:mac         # install this build here and run the full self-test on each open After Effects
                         # (one run per Mac at a time: waits for ~/.surehand/test-mac.lock; reports the commit tested)
npm run test:windows     # the same on the Windows PC over SSH
npm run package:mac-pkg       # -> ../dist-zip/Surehand-MCP-<version>.pkg, signed and notarized (--no-notarize: faster)
npm run package:win-installer # -> ../dist-zip/Surehand-MCP-Setup-<version>.exe (--sign: needs SimplySign logged in)
npm run release -- 1.4.0 --notes notes.md   # everything above, then a release PR, its CI, merge and the GitHub release
                                            # (1.4.0-beta.1 makes a GitHub pre-release; --skip-installers skips both installers)
```

The After Effects extension in `extension/` is embedded in the server bundle at build time, and the server installs
or updates it when it starts. After changing the server or the panel: rebuild, re-run the installer, restart After Effects.

To add a tool, add an entry to one of the arrays in `server/src/tools/*.ts`: a zod input schema plus an ExtendScript
function body that receives `args` and can use the `aemcp` helpers.

**Names.** The family is Surehand (Photoshop and Premiere may follow), so this app's names are `surehand-ae`: the command
(`ae-mcp` stays as an alias), the server file `surehand-ae.mjs`, the MCP server name and the key in each AI app's settings
(`SERVER_NAME`; 1.3 used `after-effects`), the `.mcpb` `name` (its `display_name` is "Surehand MCP"), and the folders
`~/.surehand/ae` (this app) and `~/.surehand` (shared: `node/`, `ffmpeg/`); all in `server/src/paths.ts`. Unchanged so
scripts and the extension keep working: the tool names (`ae_*`), the After Effects extension id `com.aemcp` (and its
bundle ids), the `aemcp` helper object and `aemcp://` resource URIs. Environment variables are `SUREHAND_AE_*`; the
`AEMCP_*` names still work. Releases carry the server as `surehand-ae.mjs` and also as `ae-mcp.mjs` (what 1.3's updater
downloads). The npm package name is `surehand-mcp`.

## License

MIT, see [LICENSE](LICENSE). Created and maintained by Ron Yitzhaki ([@ronyitzhaki](https://github.com/ronyitzhaki)).

Adobe and After Effects are either registered trademarks or trademarks of Adobe in the United States and/or other
countries. Surehand MCP is not affiliated with or endorsed by Adobe.
