<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/png/lockup-dark.png">
    <img src="brand/png/lockup-light.png" width="520" alt="Surehand MCP for Adobe® After Effects®">
  </picture>
</h1>
<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/conformlabs-endorsement-reversed.svg">
    <img src="brand/conformlabs-endorsement.svg" width="200" alt="A Conform Labs product">
  </picture>
</p>

[![CI](https://github.com/ConformLabs/surehand-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ConformLabs/surehand-mcp/actions/workflows/ci.yml)

**Surehand MCP lets the AI app you already use work inside Adobe® After Effects®, and shows you what it did.**
It is for motion designers, finishing artists and technical directors who can't deliver on "the AI says it's done".
Every edit is one undo step and comes back with an exact list of what changed. Structural changes come with pixel
proof that the picture didn't change. Deliveries are checked against your own spec, templates are pushed through
worst-case inputs, and every version built from data is checked row by row. Verified, not trusted.

- **AI apps:** Claude (Desktop and Code), ChatGPT (desktop app and web), Codex, Cursor, VS Code (GitHub Copilot),
  Windsurf / Devin Desktop, LM Studio, or any MCP client. Inside After Effects, the Surehand panel can also chat
  through Codex, Claude Code or Antigravity on your own sign-in.
- **After Effects:** 2025 and 2026 on macOS and Windows, in any language, are tested release by release. The
  extension loads in CC 2019 (16.0) and newer; versions before 2025 are best effort.
- **Install:** signed and notarized `.pkg` for Mac, signed `Setup.exe` for Windows. No administrator rights, no
  account. Free and open source (MIT).
- **Website and downloads:** [conformlabs.co/get](https://conformlabs.co/get).

It doesn't generate images and ships no presets or canned looks. It works on your project, by your rules, and
measures the result.

```
AI app ──MCP──> surehand-ae server (Node, on your computer) ──localhost──> Surehand panel (CEP, inside After Effects) ──> ExtendScript
```

<a name="example-prompts"></a>

## What you can ask it

Real requests, in your words. The AI picks the tool; the tool does the measuring.

| You ask | The tool |
|---|---|
| "Check Endcard against our broadcast spec before I send it." | `ae_preflight`: the comp and the rendered file against your delivery spec, with timecoded findings |
| "Stress-test the lower third with long German names and Arabic." | `ae_stress_test`: worst-case inputs through every control, each result measured, your comp left untouched |
| "Un-precompose Logo_Lockup and prove nothing changed." | `ae_precomp_surgery`: rehearsed on a scratch copy, applied only when the pixels match |
| "Why does this render slowly? Speed it up only where the picture stays identical." | `ae_render_profile`: a timeline cost map, then speed-ups kept only when proven identical |
| "Split the render across 3 processes and prove every frame is there." | `ae_farm`: chunks, aerender scripts, a local parallel run and a completeness check |
| "Make a version of Score Card for every row of scores.csv, and check each one before you queue them." | `ae_versions_from_data`: one undo step, every row read back and measured |
| "Export the texts for the Hebrew and French translators. When they come back, fit them: tracking down to -40, never below 36 px." | `ae_localize`: CSV or XLIFF out, a checked version per language back in |
| "Make a 9:16 of Promo. Logo pinned 80 px from the top, titles inside title-safe." | `ae_reformat`: your rules, checked on every frame |
| "I inherited this project. What does the render queue actually pull in, and what's fragile?" | `ae_project_xray`: a read-only explanation, with precise locations |
| "What changed between v11 and v12?" | `ae_project_history`: snapshots and a readable diff |

Everyday edits work the same way: comps, layers, keyframes at Graph Editor precision, expressions, effects, text,
masks, 3D, audio, footage, Essential Graphics and render settings, plus any After Effects script when no tool
fits. See the [full tool list](#all-tools).

<a name="download"></a><a name="requirements"></a>

## Install

**[Download the latest release](https://github.com/ConformLabs/surehand-mcp/releases/latest)**

| Your setup | Download |
|---|---|
| Mac | `Surehand-MCP-<version>.pkg` (signed and notarized) |
| Windows | `Surehand-MCP-Setup-<version>.exe` (signed) |
| Claude Desktop only | `Surehand-MCP.mcpb` |
| Setups the installers don't cover | `Surehand-MCP-<version>.zip` (Mac and Windows scripts; open `START HERE.txt`) |

Nothing else is needed: the `.pkg` and `Setup.exe` include Node.js 24, the `.mcpb` uses Claude Desktop's built-in
Node.js, and the zip's installer downloads Node.js if it is missing.

Step-by-step setup guides for each AI app: [Claude](https://conformlabs.co/surehand/claude/),
[ChatGPT and Codex](https://conformlabs.co/surehand/chatgpt/), [Cursor](https://conformlabs.co/surehand/cursor/),
[VS Code](https://conformlabs.co/surehand/vs-code/), [Windsurf](https://conformlabs.co/surehand/windsurf/),
[LM Studio](https://conformlabs.co/surehand/lm-studio/).

### Mac and Windows installers

1. **Mac:** double-click `Surehand-MCP-<version>.pkg` and follow the steps. No administrator password: everything
   goes into your own home folder.
   **Windows:** run `Surehand-MCP-Setup-<version>.exe`. It installs per user, with no administrator rights.
2. Restart After Effects once.
3. Restart the AI apps that were open during the install.

Both installers put a private Node.js 24, the server and the After Effects extension on your computer, connect the
AI apps they find, and write the Surehand skills for them (see [The installer](#the-installer)).

### First run

The bridge starts with After Effects; nothing needs to be opened. To see it, open **Window > Extensions > Surehand
MCP**. A green dot means connected. The panel shows the latest calls, the permission mode and **Pause AI**.

Then ask your AI app something simple:

*"Check After Effects is connected, then make a 1080p comp with an animated title and show me frame 1."*

If something is off, the panel's **☰ › Test the connection** (or `surehand-ae selftest`) says what and how to fix it.

### Claude Desktop only (`.mcpb`)

Double-click `Surehand-MCP.mcpb` and click **Install** in Claude Desktop, then restart After Effects once. On first
start the server installs its After Effects extension by itself. Use either the `.mcpb` or an installer for Claude
Desktop, not both.

### The zip

The same installer as double-click scripts, for setups the installers don't cover:

```
Surehand-MCP/
  START HERE.txt
  1. Claude Desktop (easiest)/   Surehand-MCP.mcpb
  2. Mac/                        1. Install, 2. Test Installation, 3. Connect ChatGPT, 4. Uninstall (.command)
  3. Windows/                    1. Install, 2. Test Installation, 3. Connect ChatGPT, 4. Uninstall (.bat)
  Support files/                 run.sh, run.ps1, surehand-ae.mjs, this README
```

Double-click **1. Install** in `2. Mac` or `3. Windows`, then restart After Effects once. With After Effects open,
**2. Test Installation** checks everything. `START HERE.txt` (from `installer/START HERE.txt`) has the same steps in
plain language, including what to do if macOS Gatekeeper or Windows SmartScreen blocks the files.

### The installer

What every installer (`.pkg`, `Setup.exe`, or **1. Install** from the zip) does:

- uses the private Node.js 24 that the `.pkg` / `Setup.exe` put in `~/.surehand/node`; the zip's scripts use the
  Node.js on your PATH, or download a private Node.js 22 LTS into `~/.surehand/node` (checksum-verified)
- copies the MCP server to `~/.surehand/ae/server/surehand-ae.mjs` (one self-contained file)
- installs the After Effects extension into your user CEP extensions folder. The extension is signed,
  so it loads without enabling unsigned extensions (`PlayerDebugMode`)
- creates `~/.surehand/ae/config.json` with a random access token
- registers the server, under the name `surehand-ae`, with the AI apps it finds: **Claude Desktop**, **Claude
  Code**, **ChatGPT desktop / Codex** (`~/.codex/config.toml`, created if the ChatGPT or Codex app is installed),
  **Cursor**, **VS Code** (its user `mcp.json`, used by GitHub Copilot's Agent mode), **Windsurf / Devin Desktop**
  (`~/.config/devin/mcp_config.json`, `%APPDATA%\devin` on Windows, and Windsurf's
  `~/.codeium/windsurf/mcp_config.json` while that folder is there) and **LM Studio** (`~/.lmstudio/mcp.json`).
  Before a config file is changed, a timestamped backup is made next to it (`*.surehand-<time>.bak`, the newest
  three are kept); the very first original also stays as `*.surehand.bak`. If Claude Desktop is open it offers to
  restart it, because a running Claude Desktop overwrites its config file
- writes the Surehand skills (see [Skills](#skills)) for the AI apps that read skill files, and the zips to upload
  in Claude Desktop chat

The server also checks the After Effects extension every time it starts and installs or updates it if needed.

To uninstall: double-click **4. Uninstall** from the zip, or run `surehand-ae uninstall` (and remove the `.mcpb` in
Claude Desktop > Settings > Extensions if you used it). Checkpoints are kept unless you pass `--all`.

### Skills

Four Agent Skills teach the AI how to work with Surehand well:

- `surehand-ae`: the basics. Check the connection, read before editing, confirm each edit with its change report,
  look at the result, never work around a refusal, plus the ExtendScript traps seen live.
- `surehand-ae-delivery`: preflight against your own delivery spec, stress tests, versions from data checked row by
  row, the localization round trip, farm renders.
- `surehand-ae-safe-restructure`: structural edits and render speed-ups with pixel proof.
- `surehand-ae-timing-layout`: exact keyframes, easing, measured alignment and reformats.

The source is `skills/` in this repo.

- The installer writes them to `~/.claude/skills/` (Claude Code; Cursor and VS Code read it too) and
  `~/.agents/skills/` (ChatGPT desktop / Codex, Cursor, VS Code, Windsurf / Devin Desktop); `%USERPROFILE%` on
  Windows. A folder is written only when one of those apps is on the computer (or the folder is there already).
  Only the four `surehand-ae*` folders are written, replaced on update and removed on uninstall; other skills are
  never touched.
- **For Claude Desktop chat:** upload the skills in **Customize › Skills › Upload a skill** (files in
  `~/.surehand/ae/skills`, one zip per skill). claude.ai takes the same zips.
- `surehand-ae skills [--json]` shows where they are installed; `surehand-ae skills install` / `uninstall` writes or
  removes them.

### Claude Code plugin

In Claude Code you can also install Surehand as a plugin (the server and the four skills, from the latest release;
needs Node.js on your PATH):

```
/plugin install surehand-ae --marketplace ConformLabs/surehand-mcp
```

The server installs the After Effects extension the first time it starts; restart After Effects afterwards.

### Other MCP clients

Point them at the installed server (stdio):

```json
{
  "mcpServers": {
    "surehand-ae": { "command": "/path/to/node", "args": ["/Users/<you>/.surehand/ae/server/surehand-ae.mjs"] }
  }
}
```

The panel's **☰ › Connect an AI app** shows which apps are connected and connects the others.

## ChatGPT

**ChatGPT desktop app (Mac and Windows): no tunnel needed.** It runs local MCP servers itself and reads the same
`~/.codex/config.toml` as Codex, which the installer fills in. Restart ChatGPT after installing; **surehand-ae**
appears under **Settings > Plugins > Servers** (switch it on). To add it by hand: **Add > MCP server > STDIO**,
command = the Node path printed by the installer, argument = `~/.surehand/ae/server/surehand-ae.mjs`.

**ChatGPT on the web (chatgpt.com)** can only reach MCP servers over public HTTPS, so the server runs in HTTP mode
behind a temporary tunnel. The panel's **☰ › ChatGPT on the web** screen runs it in the background (and can download
Cloudflare's cloudflared for you); see the [wiki page](https://github.com/ConformLabs/surehand-mcp/wiki/ChatGPT-on-the-web).
By hand:

1. Install a tunnel tool once: **cloudflared** (no account needed: `brew install cloudflared` on macOS,
   `winget install --id Cloudflare.cloudflared` on Windows) or [ngrok](https://ngrok.com/download).
2. Double-click **3. Connect ChatGPT** in the zip's `2. Mac` or `3. Windows` folder (or run `surehand-ae chatgpt`).
   It prints a URL like `https://xxxx.trycloudflare.com/mcp/<token>`.
3. In ChatGPT: **Settings > Apps & Connectors > Advanced settings > Developer mode** on, then **Create** a
   connector, paste the URL, choose **No authentication** (the token is in the URL), and save.
4. In a chat, enable the connector from the tools menu. Keep the tunnel running while you use it.

The URL contains your secret token: anyone with it can run scripts on your machine while the tunnel is up.
Quick-tunnel URLs change on every start, so update the connector URL each time (or set up a named Cloudflare
tunnel). To rotate the token, delete `token` from `~/.surehand/ae/config.json` and re-run the installer, then
restart After Effects.

<a name="control-and-trust"></a>

## Safety model

Surehand is built so that you stay in charge of the project, and so that what the AI says it did can be checked.

### Permissions, Pause AI and undo

**Permissions.** The mode selector **Full / Ask / Read-only** at the top of the Surehand panel (or `"permissions"`
in `~/.surehand/ae/config.json`) applies to the next request, with no restart:

| Mode | What happens |
|---|---|
| Full (default) | Everything runs. Your AI app may still ask you before each tool call. |
| Ask | Every edit and script waits in the Surehand panel, showing the exact code or arguments, until you click **Allow** or **Deny**. When the panel is closed, an approval pop-up appears instead. Reads are not held. |
| Read-only | Tools that edit are refused. Scripts still run (to read information), but if one changes the project it is undone immediately and the AI is told what it tried to change. Scripts that touch the undo history (`executeCommand`, `beginUndoGroup`, `endUndoGroup`, `purge`) or do things that can't be undone (opening, closing or saving projects, `newProject`, `quit`, rendering, `scheduleTask`, saving preferences) are refused before they run. This is a text check (comments are ignored, escapes are decoded; a name inside a string or on another object counts too): a call assembled at runtime gets past it, and is then undone at most once, checked with a temporary undo marker, and reported if the project isn't back. |

**Pause AI.** One click in the panel, and every AI call is refused until you resume.

**Undo.** Every tool call is one undo step, and `ae_undo` reverts it and reports what was reverted. `ae_batch` runs
many steps as one undo step, all or nothing by default. The panel's activity feed has **Undo** on the most recent
change, offered only when nothing has changed the project since. After Effects itself can split a few operations into
several undo steps (seen with comp duplicates, layer copies and source replacements); where that can happen, the
result names the exact way back instead (a checkpoint, or a command that removes exactly the copies it made). See
[Limits](#limits).

**Checkpoints.** `ae_checkpoint` saves a timestamped copy of the project, and restores one as a new file next to the
original; the original is never overwritten. Tools that make big changes (precomp surgery, render optimizations,
versions, reformats) can save one first. The panel lists them under **☰ › Checkpoints**.

**Existing files are never replaced silently.** Save As, frame and contact-sheet output paths, frame exports,
handoff packages, farm plans and farm renders refuse when a file is already there; the AI passes `overwrite: true`
only when replacing it is intended.

**Shell commands** in scripts (`system.callSystem`) can be switched off separately (**☰ › Shell commands in
scripts**).

### What the AI can and can't do

- It can do anything an After Effects script can: `ae_run_script` runs JavaScript in After Effects (modern syntax is
  converted for ExtendScript), and the ready-made tools cover the common work with checks built in.
- It can't approve its own requests, get past Pause AI, or press the panel's buttons. Approvals, Pause AI and the
  panel's own actions need a secret that the bridge keeps in memory and hands only to the Surehand panel and the
  approval pop-up through After Effects' extension events, never over the network or in a file. A new request
  can't be answered in its first second on screen, and Enter never allows.
- It sees what it asks to see: tool results, and frames it renders. Your project files stay on your computer; what
  your AI app sends to its provider (your messages, tool results, rendered frames) follows that provider's terms.
- Permissions are guardrails against mistakes, not a sandbox. A script can still read and write files. An AI app
  with full shell access as your user account can read and change everything Surehand can, including
  `config.json`.

**Activity log.** Every tool call is recorded in `~/.surehand/ae/activity.jsonl` with time, AI app, tool, arguments
(including the full script code), duration and result. The panel shows the latest calls, **☰ › Activity history**
lists them (click one for what changed), **Open log file** there reveals the file, and `surehand-ae activity`
prints it.

### Security

- The bridge listens on `127.0.0.1` only and requires the token from `~/.surehand/ae/config.json` (file mode 600);
  requests from web pages (with an `Origin` header) are rejected.
- `ae_run_script` can do anything an After Effects script can, including reading and writing files and running
  shell commands via `system.callSystem`. Only connect AI apps you trust, and keep the ChatGPT tunnel running only
  while you use it.
- What the token protects against: other users of the computer, and programs that can't read your files. What it
  doesn't: a program running as your own user account with access to your files.
- Chat in After Effects never stores or handles an API key or sign-in: the AI agent runs on its own sign-in.
- Settings files of AI apps are only changed when they can be read (a file with a mistake in it is left as it is
  and reported), with a timestamped backup first (the newest three are kept) and an atomic write.
- `surehand-ae diagnostics` and **Copy diagnostics** in the panel contain no secrets.

### Self-test

`surehand-ae selftest` (or **2. Test Installation**, or the panel's **Test the connection**) checks every link of the
chain: the config and token, the extension and its signature, the AI apps' settings, the bridge inside After
Effects, ExtendScript, the scripting preference, a small non-destructive test job (a temporary comp with text,
keyframes and an effect) and a frame preview. A failed check says how to fix it.

`surehand-ae selftest --full` runs every major tool (over 60 steps) against temporary comps (removed afterwards; if
the open project has no unsaved changes, the Save As and checkpoint-restore checks briefly switch to a scratch
project and then reopen it), lists which scripting features your After Effects version has, and saves a report to
`~/.surehand/ae/compat/`. All steps pass on After Effects 2025 (25.6) and 2026 (26.5) on macOS and on 2026 on
Windows 11, also with 2025 and 2026 running side by side; the panel, permissions, approvals and background
rendering are verified on macOS and Windows. Please share reports from other versions.

## What it does, by job

### Check and deliver

**Preflight** (`ae_preflight`) checks the comp, and optionally the rendered file, against your delivery spec: a small
JSON file with the numbers from your client's or broadcaster's document. Nothing is built in. It covers comp
settings, missing items, text inside safe areas on every frame, cap height and reading speed, and in the file:
codec, levels, loudness, black and frozen frames and a flash pre-check. A check that couldn't run makes the verdict
INCOMPLETE, never PASS. The **stress test** (`ae_stress_test`) pushes worst-case inputs (long German and Finnish
strings, Hebrew and Arabic, CJK, emoji, huge and negative numbers) through every control a template exposes and
measures each result on a scratch copy; it also lists expressions that break in other After Effects languages.
`ae_project_health` lists missing footage, fonts and effects, expression errors and unused items.
Details: [Preflight](#preflight), [Preflight: rendered files](#preflight-rendered-files), [Stress test](#stress-test).

### Restructure safely

Every edit returns a **change report** computed by After Effects itself. `ae_prove_identical` renders reference
frames, lets the edit happen and renders them again: **identical**, **identical within tolerance**, or **differs**
with a difference image. `ae_precomp_surgery` un-precomposes or deep-duplicates with every expression reference
rewritten, rehearses the change on a scratch copy and applies it only when the pixels match; what it can't reproduce
exactly is refused with the reason. `ae_replace_in_expressions` does project-wide find and replace with a dry run.
Details: [Change report](#change-report), [Proven edits](#proven-edits), [Precomp surgery](#precomp-surgery).

### Timing and layout

The keyframe table (`ae_get_keyframes`, `ae_set_keyframe_table`) reads and writes keys in frames or seconds with the
exact speed and influence After Effects stores. `ae_copy_ease` copies an ease to other keys, `ae_audit_easing` checks
motion against the project's own most-used curves, and `ae_retime_keyframes` scales, offsets, staggers or conforms
by whole frames. `ae_align_layers` aligns and distributes by measured on-screen bounds, not anchor points, and reports
any residual. `ae_get_layer_bounds`, `ae_sample_pixels`, `ae_render_frame` and `ae_render_contact_sheet` let the AI
measure and look at the result.

### Versions, localization and reformats

`ae_versions_from_data` turns a CSV or JSON file into versions of a template comp in one undo step, then reads every
row back where it renders: text, number format, colour rules, overflow, safe areas, bar sizes against your mapping.
`ae_localize` exports texts with their context to CSV or XLIFF and brings translations back as a version per
language, fitted only by the adjustments you allow, with right-to-left handled. `ae_reformat` makes 9:16, 1:1, 4:5 or
any size from your rules (cover, safe areas, pins, scale limits) and checks the result on every frame. When a rule
can't be met, the report says FAIL and why; it doesn't decide for you.
Details: [Versions from data](#versions-from-data), [Localization](#localization), [Reformat](#reformat).

### Renders and farms

`ae_render_profile` shows where render time goes across the whole timeline, then applies chosen speed-ups one at a
time and keeps only those proven identical, with the time saved. `ae_handoff_package` collects a project for someone
else with a manifest of what they need (fonts, plug-ins, colour settings) and can prove the package renders the same.
`ae_farm` lists what a render needs on a node and checks a node against it, splits a render into chunks for local
processes or other machines, runs them here in parallel, and proves the chunks add up. `ae_render_background` runs
aerender in a separate process while After Effects stays usable.
Details: [Render profile](#render-profile), [Handoff package](#handoff-package), [Render farm](#render-farm).

### Understand a project

`ae_project_xray` explains an inherited project without changing it: what the render queue renders, what every
expression depends on and which links are fragile, what is missing, footage specs and what makes it heavy.
`ae_project_history` snapshots the project and diffs any two versions or checkpoints into a readable change list.
`ae_get_comp_map` maps nested precomps, parenting, mattes and expression links.
Details: [Project X-ray](#project-x-ray), [Project history](#project-history).

### Chat in After Effects

**☰ › Chat with your AI app** in the Surehand panel runs Codex, Claude Code or Antigravity, on your own sign-in and
subscription, with Surehand's tools as its only tools. The same mode, approvals, Pause AI and activity log apply.
In AI apps that show interactive views (for example Claude Desktop, ChatGPT, VS Code and Cursor), Preflight, X-ray,
the stress test, proofs and history diffs come with an **in-chat view**: findings on a timeline, frames, before and
after. Other apps get the same results as text.
Details: [Chat with your AI app](#chat-with-your-ai-app), [In-chat views](#in-chat-views).

## Reference

<a name="what-the-ai-can-do"></a>

### All tools

Surehand has up to 114 ready-made tools, plus `ae_run_script` for anything else.

**Run anything:**

| Tool | |
|---|---|
| `ae_run_script` | Run JavaScript in After Effects; `return` a value to get it back as JSON. Modern syntax (let/const, arrows, template strings, destructuring, classes, `?.`, `??`, `for...of`) and common built-ins (`map`, `filter`, `Object.keys`, `JSON`...) work: the code is converted for AE's ES3 engine with Babel, keeping line numbers. Errors come back with the failing line, the code around it, and a hint. `log()` output is returned. One undo step per call. |
| `ae_run_script_file` | Run a `.jsx` / `.jsxbin` file from disk with arguments. |
| `ae_get_scripting_guide` | ExtendScript cheat sheet for the model (also an MCP resource `aemcp://docs/extendscript`). |

**By area:**

- **Workflow:** `ae_batch` (many tool steps or scripts in one call and ONE undo step, with one change report; atomic
  by default: if a step fails everything is undone), `ae_checkpoint` (save a timestamped copy of the project, list,
  restore as a new file next to the original; the original is never overwritten; each checkpoint also gets a history
  snapshot), `ae_list_scripts` (your scripts: AE's Scripts folder, ScriptUI Panels, and folders listed as
  `"scriptFolders"` in `~/.surehand/ae/config.json`, with their descriptions) + `ae_run_script_file`, `ae_tools` and
  `ae_call` (every tool on demand, see [Tool profiles](#tool-profiles))
- **Verification:** `ae_prove_identical` ([Proven edits](#proven-edits)), `ae_precomp_surgery`
  ([Precomp surgery](#precomp-surgery)), `ae_project_history` ([Project history](#project-history))
- **Checks and delivery:** `ae_preflight` ([Preflight](#preflight)), `ae_stress_test` ([Stress test](#stress-test)),
  `ae_project_health` (missing footage/fonts/effects, expression errors, unused footage, empty comps/folders,
  duplicate comp names)
- **Versions:** `ae_versions_from_data` ([Versions from data](#versions-from-data)), `ae_localize`
  ([Localization](#localization)), `ae_reformat` ([Reformat](#reformat))
- **Understanding:** `ae_project_xray` ([Project X-ray](#project-x-ray)), `ae_get_comp_map` (nested precomps,
  parenting, track mattes, expression references)
- **Seeing the result:** `ae_render_frame` (a frame as an image; options: zoom into a region, render only some layers,
  transparency on a checkerboard or a color, difference image against another time or comp),
  `ae_render_contact_sheet` (a grid of frames across time, labelled with time and frame number, to judge motion and
  easing). The temporary comp stays until After Effects has written the image, then it is removed and anything
  switched for the render set back by hand, and the project is compared with how it was. They never use Edit > Undo
  (it could revert your own last step); After Effects may list a "Surehand MCP preview" step, which only brings the
  preview's own changes back. In a 32 bpc project, or one with "Blend Colors Using 1.0 Gamma", frames are rendered
  at 16 bpc without it, so colors look as in the viewer (After Effects writes such frames far too dark); the project
  settings are put back. `ae_export_frames` does the same. `ae_prove_identical` always renders with the project's own
  settings, so a capture and its comparison match.
- **Measuring:** `ae_get_layer_bounds` (exact on-screen boxes after transforms, parenting, 3D and camera; in-frame
  and action/title-safe checks), `ae_sample_pixels` (rendered RGBA/hex at points)
- **Status & app:** `ae_status`, `ae_system_info`, `ae_execute_menu_command`, `ae_undo`, `ae_redo`, `ae_purge`,
  `ae_get_fonts`, `ae_reload_helpers`
- **Project:** `ae_get_project_info`, `ae_list_items`, `ae_get_item_info`, `ae_import_files`, `ae_create_folder`,
  `ae_move_items`, `ae_rename_item`, `ae_remove_items`, `ae_replace_footage`, `ae_save_project`, `ae_open_project`,
  `ae_new_project`
- **Compositions:** `ae_list_comps`, `ae_get_comp_info`, `ae_create_comp`, `ae_set_comp_settings`,
  `ae_duplicate_comp`, `ae_open_comp`, `ae_precompose`, `ae_add_comp_marker`
- **Layers:** `ae_get_layer_info`, `ae_add_layer` (solid, text, shape, null, adjustment, camera, light,
  footage/comp), `ae_set_layer_attributes` (switches, timing, parent, blend mode, track matte, order...),
  `ae_delete_layers`, `ae_duplicate_layer`, `ae_split_layer`, `ae_get_selection`, `ae_select_layers`, `ae_set_text`
- **Properties & animation:** `ae_get_properties`, `ae_find_properties` (search all layers by name/match name, or
  list animated / expression properties), `ae_set_property`, `ae_set_keyframes` (interpolation + easing),
  `ae_remove_keyframes`, `ae_set_expression`, `ae_get_expressions`
- **Expressions:** `ae_check_expression` (try an expression and see errors and values without keeping it),
  `ae_replace_in_expressions` (project-wide find & replace, dry run, errors after the change)
- **Keyframes (Graph Editor level):** `ae_edit_keyframes` (value, move in time, in/out interpolation, speed +
  influence per dimension, continuous/auto-Bezier, spatial tangents, roving, keyframe color labels, delete),
  `ae_copy_keyframes` (between properties/layers/comps, time range, offset), `ae_set_time_remap` (keys or freeze
  frame). The keyframe tools take whole frames (`frame`, `moveToFrame`, `frames`, `offsetFrames`) as well as seconds.
- **Precision timing and easing:** `ae_get_keyframes` (a keyframe table across many layers and properties: whole
  frame and exact time of every key, exact value, interpolation, speed + influence per dimension exactly as After
  Effects stores them, tangents, roving; keys between frames are flagged; optional normalised curve numbers per
  segment), `ae_set_keyframe_table` (write such a table back, many properties in one undo step, every attribute
  exact), `ae_copy_ease` (the exact ease of a reference key onto keys of other properties and layers, with a stated
  rule for different dimension counts), `ae_audit_easing` (motion consistency against the project's own most-used
  curves: lists the segments that match none), `ae_retime_keyframes` (scale around an anchor, offset or stagger by
  whole frames, conform to a new frame rate; keeps the curves' shape, refuses keys colliding on a frame)
- **Measured layout:** `ae_align_layers` (align, distribute and centre by real on-screen bounds, through parenting,
  scale, rotation and text glyph boxes, not anchor points; reports any residual after the move)
- **Effects, shapes & masks:** `ae_list_available_effects`, `ae_get_effect_params` (an effect's exact parameter
  names, types, defaults and ranges, without touching your layers), `ae_apply_effect`, `ae_set_effect_params`,
  `ae_remove_effect`, `ae_apply_preset` (an animation preset `.ffx` file by path), `ae_add_shape`, `ae_add_mask`
- **Text:** `ae_style_text_range` (per-character styling by range or matching words), `ae_set_paragraph`
  (justification, indents, spacing, box size), `ae_add_text_animator` (animator properties + range/wiggly/expression
  selector)
- **3D:** `ae_set_camera` (one/two-node, focal length in mm, depth of field; reports angle of view), `ae_set_light`
  (type, color, intensity, cone, falloff, shadows), `ae_set_material` (material options, lists the 3D renderers)
- **Audio:** `ae_audio_to_keyframes` (Convert Audio to Keyframes), `ae_audio_markers` (markers at beats/peaks)
- **Color:** `ae_color_settings` (Adobe or OCIO color engine, working space, bit depth, linearization, OCIO spaces)
- **Footage:** `ae_set_footage_interpretation` (conform frame rate, alpha, fields, pulldown, loop, pixel aspect),
  `ae_set_proxy`, `ae_relink_footage` (find missing files by name in a folder tree, keeps sequences)
- **Files and exports:** `ae_find_files` (globs, `~`, Unicode names in either normalisation, depth and result limits,
  no symlink loops; After Effects not needed), `ae_export_frames` (PNG stills of comps, single layers or footage,
  frame lists and ranges, several exports per call, never replacing a file without `overwrite: true`);
  `ae_import_files` says when a file couldn't be imported the way `importAs` asked
- **Essential Graphics:** `ae_essential_graphics` (add properties as controllers, template name), `ae_export_mogrt`
- **Render:** `ae_list_render_queue`, `ae_add_to_render_queue`, `ae_get_render_settings` / `ae_set_render_settings`
  (every render-settings and output-module setting as editable key/value pairs), `ae_queue_in_media_encoder`,
  `ae_render_background` + `ae_render_jobs` (aerender in a separate process, with progress and cancel; After Effects
  stays usable), `ae_render_queue_start`, `ae_clear_render_queue`, `ae_render_profile`
  ([Render profile](#render-profile)), `ae_handoff_package` ([Handoff package](#handoff-package)), `ae_farm`
  ([Render farm](#render-farm))

Comps can be referenced by id, name, or omitted for the active comp; layers by 1-based index or name; properties by
paths like `"Transform/Position"` or `"Effects/Gaussian Blur/Blurriness"` (display names or match names).

**Any After Effects language.** Property, effect and menu names are translated in non-English After Effects. Common
English names still work everywhere: property paths like `Transform/Opacity`, effects like "Gaussian Blur" and menu
commands like "Pre-compose..." are mapped to internal match names and command ids, which are the same in every
language. Match names (`ADBE ...`, as returned by `ae_get_properties` / `ae_get_effect_params`) always work, and an
unknown effect name gets suggestions.

### Tool profiles

Every tool description is sent to the AI in every chat, so by default only a **core set of 29 tools** is loaded
(about 9k tokens instead of 47k for all 114), and **every other tool stays available on demand**: `ae_tools` lists
all tools by category (or gives full parameter details of chosen ones), and `ae_call` runs any tool by name with the
same validation, permissions, change report and activity log. In AI apps that show in-chat views, the four tools with
a view (`ae_preflight`, `ae_project_xray`, `ae_project_history`, `ae_stress_test`) join the core set, because a view
only shows when the AI app calls the tool directly.

Loading everything up front is optional: switch to **All tools** in the Surehand panel (**☰ › Tools the AI sees ›
All tools**), in Claude Desktop's extension settings ("Enable all tools") for the `.mcpb`, or with
`"toolProfile": "full"` in `~/.surehand/ae/config.json`, then restart the AI app. Advanced:
`"toolProfile": "core,ae_import_files,ae_render_queue_start"` adds single tools.

Core set: `ae_status`, `ae_run_script`, `ae_get_scripting_guide`, `ae_render_frame`, `ae_render_contact_sheet`,
`ae_get_project_info`, `ae_get_comp_info`, `ae_get_layer_info`, `ae_get_selection`, `ae_get_properties`,
`ae_find_properties`, `ae_get_layer_bounds`, `ae_get_comp_map`, `ae_create_comp`, `ae_add_layer`, `ae_add_shape`,
`ae_set_property`, `ae_set_keyframes`, `ae_set_expression`, `ae_apply_effect`, `ae_get_effect_params`, `ae_undo`,
`ae_batch`, `ae_checkpoint`, `ae_prove_identical`, `ae_list_scripts`, `ae_run_script_file`, `ae_tools`, `ae_call`.

## Feature reference

How each verification feature works, what it checks and what it doesn't.

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

### Stress test

`ae_stress_test` finds what breaks in an editor's or client's hands before they do: it pushes worst-case inputs
through every variable a comp exposes and **measures** each result.

- **What it varies:** the comp's Essential Graphics controllers (text, numbers, checkboxes, menus, colours, media
  replacement) and text that reads data, or the layers you name. Inputs are test data, not looks: German and Finnish
  long strings scaled from the current text, Hebrew and Arabic with digits, Japanese, Chinese, Korean, Thai, Hindi,
  combining marks, emoji, all caps, empty, one character, no spaces; zero, negative, huge, past the slider limit,
  many decimals, both separator styles, percent; every checkbox and menu state. Your own values or CSV / JSON rows
  work too. Combinations are sampled evenly up to a cap, and the report says what was kept.
- **What it measures**, at the animation's key frames and where each text starts and stops being visible: box
  overflow and by how many pixels and lines (After Effects 24.6+), the frame / title- / action-safe area (your
  margins), the size text renders at (your minimum, or smaller than the comp's own text), missing glyphs (25.1+) and
  substituted fonts, right-to-left and complex scripts without the direction or composer they need, line count and
  breaks inside a word (24.3+), overlap with layers you name, and whether a number shows right in the text that shows
  it. What already fails in the comp as it is is listed once, as the baseline.
- **Expressions in other languages:** references by an English display name (`effect("Slider Control")("Slider")`,
  `thisLayer("Transform")("Opacity")`, default shape and mask names) break in After Effects in another language; each
  is listed with the language-safe form (index, match name or attribute).
- **Never touches your comp:** every variant is set on a scratch copy that the same step removes; your comp is read
  back afterwards (every property value) and must be identical, or the report says so (`proveUnchanged: true` adds a
  pixel proof). Read-only mode returns the plan and the expression scan.
- **The report:** PASS / FAIL with what breaks, where, at which frame and by how much ("Title overflows its box by
  184 px; 3 lines, the box shows 2 at f48"), a grid of variants and checks, and a contact sheet PNG per failing
  variant. Where the AI app shows views, the grid comes with each failing frame marked.

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
For un-precomposing and deep duplicates, `ae_precomp_surgery` (see Precomp surgery) makes the edit itself, with the
expression rewrites, and proves it the same way before applying it.
Reference frames are stored in `~/.surehand/ae/proofs/` for 7 days (30 proofs at most). Rendering works like
`ae_render_frame`: through a temporary comp that is removed again and leaves no undo step behind (After Effects still
marks the project as changed); if the temporary comp can't be removed, the result says so. Capture and compare are
allowed in read-only mode; `run` makes edits, so it follows the same permissions as `ae_batch`.

### Precomp surgery

Inherited projects often need restructuring: a precomp that should not be one, or a comp to copy with all its nested
precomps *unlinked* (a "deep duplicate"). After Effects' own commands and free scripts can drop what the precomp layer
did and silently break expressions such as `comp("Logo").layer("Title")` or `thisComp.layer(3)`. `ae_precomp_surgery`
does it exactly or not at all.

- **`unprecompose`** brings a precomp layer's layers into its comp at its place. A null carries the precomp layer's
  anchor point, position, scale and rotation (keyframes and expressions included) and the moved top-level layers are
  parented to it (parents inside the precomp are kept; `bakeNull` leaves the null out when the transform is the identity).
  Layers move by the precomp layer's start time and are trimmed to its span; a layer entirely outside it is moved
  switched off. Names that are taken in the comp get a number. Expressions are read with a real JavaScript parser
  and rewritten by position: in the moved layers `thisComp.layer("x")` points at the moved copy, `thisComp.layer(3)` at its
  new index, `thisComp.width` (and every other comp attribute) becomes `comp("<precomp>").width`; references by index to
  the comp's own layers, from anywhere in the project, follow the layers that move down. Track mattes and Layer Control
  parameters are pointed at the moved layers. One visible layer takes over the precomp layer's opacity and blend mode.
  The source comp is kept (`removeSource` removes it only if nothing else uses it).
- **`deep_duplicate`** copies a comp and every nested precomp, each once (a precomp used in several places maps to one
  copy), points the copies' precomp layers at the copies, and rewrites `comp("X")` in the copies when X is in the tree
  (references to comps outside it stay). `suffix` (default " copy", a number is added when the name is taken). The
  copies are made next to their originals: After Effects records every move into a folder as an undo step of its own,
  so moving them (`ae_move_items`) is left to a separate step. Footage and solids are shared, not copied.

**Refused, with the exact reason**, when it can't be reproduced exactly: effects, masks, layer styles, time remapping,
time stretch, track mattes, 3D, collapse transformations, motion blur or frame blending on the precomp layer; its blend
mode or opacity when the precomp has more than one visible layer; layers in the precomp that would interact with the
comp's other layers (blend modes, adjustment layers, Preserve Underlying Transparency, cameras, lights, 3D layers);
different frame rates or motion blur settings; Essential Graphics overrides; layers reaching outside the precomp's frame
where that part would show; and expressions whose references can't be rewritten safely: names or indices computed when
the expression runs, a layer's own `index` or `wiggle` / `random` (seeded by the layer index) when the index changes,
`time` when the layers move in time, `toComp` and friends, references to the precomp layer itself, ambiguous comp names,
expressions with an error before the surgery (they could start working). `override: ["expressions"]` or `["bounds"]`
goes ahead anyway: those are still listed, left as they are, and the proof decides. `dryRun` returns the plan only:
what moves, what is renamed, every expression rewrite (before → after) and every problem.

**Proof first, then the change.** A checkpoint is saved (the project must be saved), reference frames are rendered (by
default 6 frames across the precomp layer's time span, first and last included; deep duplicate: 5 across the work area),
and the surgery is **rehearsed on a scratch copy** (a duplicate of the parent comp; for a deep duplicate, the copies). The
scratch copy is compared with the original pixel by pixel, the same comparison as `ae_prove_identical` (default
tolerance), and removed again. Only when it is **IDENTICAL** is the same surgery applied to the project, in one undo group,
and the result is checked layer for layer against the rehearsal (otherwise it is undone at once). After Effects can split
such an undo group (seen with layer copies and source replacements), so `ae_undo` may take several steps and the result
says what the exact way back is instead: for an un-precompose, the checkpoint saved first (`ae_checkpoint` restore, with
its id); for a deep duplicate, which never changes the originals and only adds copies, `{action: "remove_copies", id}`
removes exactly the copies it lists (refused while anything outside them uses one). **DIFFERS** means nothing was applied: the result lists the frames that differ with the largest difference, a
difference image, and the likely cause (for example a precomp layer that is scaled: the precomp was resampled as a whole,
while the moved layers are transformed once). Expression rewrites in other comps are exact text edits; the pixel proof
covers the parent comp (or the copied tree).

### Versions from data

`ae_versions_from_data` turns a CSV or JSON file (or rows in the chat) into versions of a template comp, and then
**checks every row**. Filling data in is the easy part; this is about knowing that each version is right. Nothing is
built in: every format, colour, size and margin comes from your data and your own rules.

- **Mapping:** each column goes to a layer of the template comp (or an Essential Graphics controller): text; a number in
  your format (decimals, decimal and thousands separators, prefix, suffix, how negatives are written); a colour from the
  cell or from your rules (for example "below 0: #C62828, otherwise #2E7D32"); a footage file that replaces the layer's
  source; any property value; or a bar's on-screen width or height through your value-to-pixels mapping (for example
  0 → 0 px, 100 → 800 px). Names come from a pattern like `{comp} - {City}`.
- **Two modes.** `duplicate` (layer targets) duplicates the comp per row. Duplicating a comp doesn't duplicate the
  precomps inside it (every version shares them), so targets are layers of the template comp itself. `essentialGraphics`
  (controller targets) makes a comp per row with the template as a precomp and sets that row's Essential Graphics values,
  the way After Effects keeps per-instance values; a row's layout can't be measured there, so those checks don't run.
- **One undo step**, with the Changes list and an optional checkpoint first. `dryRun: true` checks the mapping against
  the template and the data and shows what each row would get, without changing anything. Names already in the
  project, keyframed targets and output files that exist are refused before anything is built.
- **Every row is checked:** each value is read back where it renders (with expressions applied), so the text shows
  exactly the formatted string and the colour is what the rule says; paragraph text must not overflow its box, and the
  mapped text must stay inside the frame (or title- / action-safe with your margins) on every frame, measured with
  Preflight's own code; characters the font has no glyph for and missing fonts fail the row; bars are measured on screen
  (through parents) against your mapping within a tolerance you set; footage files must exist.
- **The report:** a verdict (`FAIL (n of m rows)`, `INCOMPLETE`, `WARNINGS` or `PASS`), totals, then one line per row:
  PASS, or FAIL with what and where. A check that didn't run (an older After Effects, a layer not visible at the
  checked time, Essential Graphics mode) makes the row INCOMPLETE, never PASS.
- **Render (optional):** `queue` adds every version to the render queue with your output module template and an output
  path pattern (`/renders/{City}_{#3}.mov`); `render: true` renders only the versions that pass. Existing files are never
  replaced unless `overwrite: true`.

### Localization

`ae_localize` takes a comp's texts to translators and back, with every language checked.

- **Export** (`action: "export"`): every text layer of the comp and its precomps (visible or not; keyframed Source
  Text per keyframe) to a **CSV** for Excel (UTF-8 with a BOM, so Hebrew and Arabic open correctly; one column per
  language) or **XLIFF 1.2** for CAT tools (Trados, memoQ, Phrase...; one file per language). XLIFF 1.2 is the version
  CAT tools import most widely; 2.0 files are read too. Each string has its context: comp and layer, time on screen,
  the paragraph box or the width a point text has to the edge of the frame (or your safe area), a character limit
  (yours, or estimated from the box with `maxChars: "fromBox"`) and your notes.
- **Import** (`action: "import"`): one version per language. The comp tree is duplicated the way versions from data
  duplicates a comp: the root and every precomp that holds a translated text, the copies using each other
  (`"{comp} [{lang}]"`). One undo step with the Changes list; `dryRun: true` shows what each language gets; names
  already in the project are refused unless `overwrite: true`.
- **Fit by your rules, never invented:** the adjustments you allow, in your order: tracking down to a minimum, font
  size down to a minimum (or a minimum cap height in comp pixels, measured on the font), horizontal scale down to a
  minimum, the paragraph box growing by at most so many pixels (away from the edge the text is aligned to); point
  text within a width you give. Each step goes only as far as needed. A text that still doesn't fit is left at the
  best attempt and FAILs with what was tried; nothing goes below your minimum. Without rules nothing is adjusted.
- **Right to left:** Hebrew, Arabic, Persian, Urdu, Yiddish (by the language code, or `direction`) get right-to-left
  paragraph direction and the Universal composer (formerly South Asian and Middle Eastern, After Effects 24.0+), and
  their alignment is mirrored (left becomes right); a point text whose alignment flips keeps its place. Your font
  per language (`fonts: {"he": {"*": "YourHebrewFont"}}`). Not available to scripts, so not done: mirroring the
  layout itself, kashida justification, per-character direction.
- **Checks per language**, worded like Preflight (`FAIL (1 of 3 languages)`, `INCOMPLETE`, `PASS`): each text read
  back where it renders, the fit, the direction, box overflow, text inside the frame or safe area on every frame,
  missing glyphs (the common Hebrew / Arabic problem: a Latin font without those letters) and missing fonts.
  Untranslated strings FAIL (or warn with `allowUntranslated: true`).
- **Drift** (`action: "drift"`): which master texts changed since the export, per language, compared with the
  file's source text; the import warns about them too.

### Reformat

`ae_reformat` makes the comp at another size (16:9 to 9:16, 1:1, 4:5 or any size) by **rules you set**, then checks
the result on every frame. Nothing is guessed for you: no presets and no "smart crop".

- **Rules:** background layers that must cover or fit the new frame; layers that must stay inside title-safe,
  action-safe or the frame (with your margins); layers pinned to an edge or corner with a margin in px; which layers
  may scale and how far (a range in % of their size); a minimum text cap height; layers to switch off. Layers are
  named exactly or with wildcards (`Logo*`). A layer no rule names keeps its offset from the frame centre, as After
  Effects' own Composition Settings resize does with the centre anchor.
- **The edit:** a duplicate of the comp (the source is never changed), in one undo step, with an optional checkpoint
  first and the Changes list. Position and Scale keys are mapped by the same move and scale, with spatial tangents and
  ease speeds scaled too, so the motion keeps its shape. Parented layers are moved in their parent's space, a track
  matte moves with its layer, 3D layers move with the frame centre. Precomps are reused unless a rule names a layer
  inside a full-frame precomp: then that precomp is duplicated and reformatted too, and the report says why
  (`precomps: "reuse"` or `"duplicate"` to choose).
- **The check:** Preflight's project checks on the new comp (your safe-area rules and cap height, on every frame or
  every Nth), plus cover / fit and pins, plus the plan against what After Effects actually made. The verdict is
  Preflight's: PASS, FAIL (n), INCOMPLETE or WARNINGS (n).
- **When a rule can't be met** (a title too wide for 9:16 without going below the minimum cap height, a pin that
  conflicts with title-safe), the layer keeps the best attempt and the report says FAIL, with the reason and what you
  could decide: a shorter text, a line break, a smaller minimum, another scale limit. The AI doesn't pick one for you.
- `dryRun: true` shows the plan and the predicted result without changing anything.

### Render profile

After Effects' own profiler shows one frame. `ae_render_profile` shows where a comp's render time goes over the whole
timeline, and keeps a speed-up only when the picture is proven unchanged.

- **`measure`** times sampled frames (by default 24 across the work area, the image cache purged before each render,
  the median of 3 renders counts) and shows them as a text heat map with the slowest ranges. Then, at the slowest
  frames, it switches each layer and effect off in turn and times the difference (cost in ms and %). Findings come
  with their evidence: invisible layers that still cost time, 32 bpc where 16 bpc is proven to give the same
  picture, expressions recomputed under motion blur, oversized precomps, hidden costs. Each finding is marked
  **can apply** (optimize can apply and prove it), **advice** (you decide) or **unknown** (for example Multi-Frame
  Rendering support, which scripting can't read). `timeBudgetSeconds` (default 300) stops new measurements and the
  report says what was measured.
- **The project is left as it was.** Every switch is put back and read back, and the result says so ("Project
  unchanged"). The switches still show as steps in Edit > Undo history that cancel each other, and After Effects may
  mark the project as having unsaved changes. In read-only mode only the frame times are measured.
- **`optimize`** applies the findings you choose, one at a time, after a checkpoint. Each is proven with
  `ae_prove_identical` at the default tolerance; one that isn't identical is put back automatically. The result
  reports the time saved on the measured frames.
- **Limits:** frames between the samples are estimates; layer and effect costs overlap (mattes, adjustment layers,
  expressions), so they don't add up; the proof covers the sampled frames, not audio or the times between them.
  Profiles are kept in `~/.surehand/ae/profiles` for 7 days (30 at most).

### Handoff package

Sending a project to a client, another studio or a render farm? `ae_handoff_package` collects it into a folder you
choose, with the layout of **File > Dependencies > Collect Files**: the project, and the footage it uses in
`(Footage)/<Project panel folders>/`, each image sequence in a folder of its own, proxies included. The project in the
package is a copy relinked to the collected files (footage items keep their names, which expressions may use);
`collect: "all"` copies unused footage too, and `reduce: true` leaves unused items out of the copy. Files that are
already in the folder are never replaced without `overwrite: true`, and the package can never be written over your
project or its footage.

Next to the project it writes `handoff.json` (for tools) and `HANDOFF.txt` (for people): the fonts the project uses and
the layers using each one (with version and Adobe Fonts where After Effects says so), every effect by match name with
its display name, category and version (the version After Effects reports for a plug-in, where it reports one; it
isn't the version in a plug-in's About box), the After Effects version, the bit depth and color settings (working space,
OCIO config and color spaces, linearize, blending), the expressions engine, each footage item's specs and where it went,
what is missing (footage, placeholders, fonts, plug-ins), and the total size. The first line says **Opens clean** and
what the recipient needs (fonts, third-party plug-ins with their versions, an OCIO config), or what doesn't open
clean: missing items, footage still pointing outside the package, unused footage that would show as missing, expression
errors (every expression is evaluated in the copy).

`verify: true` proves the package renders the same as your project. aerender, After Effects' command-line renderer,
renders sample frames (default 5 per comp across the work area; the render queue's comps in any status, else the active comp, or `verifyComps`) from a
copy of your project and from the package's copy, each in a process of its own, and the frames are compared pixel by
pixel with the same comparison as `ae_prove_identical`. The verdict is **IDENTICAL**, **DIFFERS** (with the frames, the
area and a difference image) or **NOT VERIFIED** with the reason (aerender not found, no PNG output module, a render
that failed). It takes minutes: aerender starts its own After Effects twice. What it can't prove is listed every time:
fonts and plug-ins on the recipient's machine (only this machine is checked), the package moved elsewhere (After
Effects finds collected footage relative to the project, as with Collect Files), frames between the samples, audio,
and expressions at other times than each comp's work area start. In the copies used for the proof, the render queue
holds only the sample frames, so your own queued renders never run.

Your open project is never edited, but scripts in After Effects can't save a copy of a project without opening it: the
package is made with Save As, and your project is opened again from disk at the end. So the project must be saved (a
project with unsaved changes is refused), its undo history starts fresh, and the result confirms the file on disk is
unchanged (size, date and SHA-256) and that it reopened without unsaved changes. It follows the permission mode like
any edit (refused in read-only; one approval in ask mode, before anything is written).

### Render farm

A render that works here can fail on a farm node or a colleague's machine: a plug-in or font that isn't installed
there, footage on a path only this machine sees, another After Effects version, an OCIO config that isn't there.
`ae_farm` measures what a render needs instead of guessing, and splits long renders into chunks whose result is proven
complete. Your own render queue items and output modules are the source of truth: nothing is rendered with settings
of its own. It never runs anything on another machine; other machines get a manifest to check against and scripts to
run there.

- **`manifest`**: for the queued render queue items (or `rqIndex`), exactly what a node needs: the After Effects
  version and build, bit depth, colour settings (working space, linear blending, OCIO config and whether it is inside
  the project folder), expressions engine, Multi-Frame Rendering where the preference can be read, every effect by match
  name (third-party ones marked, versions where After Effects reports them, the comps using them), the fonts of the
  text layers the render reaches, and every file the render pulls in through its precomps: path, size, an image
  sequence's frame range and gaps, proxies the render uses, and whether the path is local to this machine (home folder,
  Desktop, a local disk) or on a share (a network mount, a UNC path, or a folder you name with `sharedPaths`).
  Output modules: format, codec where scripting exposes it, path, and whether the folder exists and is writable.
  `save: true` writes `<project>.farm-manifest.json` and `.txt` next to the project (never over existing ones without
  `overwrite: true`).
- **`check`**: a machine against a manifest: After Effects and aerender installed and the version, the project,
  footage (every frame of a sequence), proxies, OCIO config and output folders reachable, fonts in the font folders
  (PostScript names read from the font files), third-party plug-ins in the Plug-ins folders (by their match names), and
  the expressions engine. On a node, without After Effects:
  `surehand-ae farm check <manifest.json> [--map /Volumes/Jobs=J:\Jobs] [--ae <install folder>] [--json]`
  (exit code 0 ready, 1 missing or different, 3 not everything could be checked). In a chat, the running After
  Effects' own lists of effects and fonts count too.
- **`plan`**: one render queue item split into frame ranges for `processes` on this machine or for named `machines`
  (each with its platform, aerender, path map and relative speed). Each chunk gets its aerender command (`-project`,
  `-rqindex`, `-s` / `-e` as the frame numbers After Effects shows (from the comp's start frame: 90000-90099 for a
  4-second comp at 25 fps that starts at 01:00:00:00), an `-output` where needed, `-mfr` on a share of the CPU when several processes share a
  machine), and each machine a script (`.command` on macOS, `.bat` on Windows), written with `farm-plan.json` next to
  the project. Image sequences: every chunk writes into the same sequence; a plan is refused when the output module
  numbers files from "Starting #" (every chunk would overwrite the same files), and too short `[####]` padding is
  flagged. Movies: each chunk writes its own file, plus the ffmpeg concat step that joins them; the plan says when
  that isn't lossless (long-GOP codecs such as H.264, AAC audio, PCM joins that fall between samples) and recommends
  rendering an image sequence instead. Refused: several output modules on the item, render settings with their own
  frame rate, an audio-only output. The time estimate comes from `ae_render_profile`'s measurements of the comp, else
  from a few frames sampled now, and says what it leaves out (aerender's start-up, encoding).
- **`run_local`**: the chunks as parallel aerender processes on this machine, as background-render jobs (logs,
  progress, cancel, the panel's job files): at most as many at once as the cores and memory allow, the others start as
  those finish. On Windows each starts once the one before has rendered its first frame (two aerender processes
  started at the same moment collide there); a chunk whose aerender ends before its first frame is started again
  once, and `status` says so with its log. Without `plan` it uses the plan next to the open project (and says which), and refuses when several
  render queue items have one. Existing output is never rendered over without `overwrite: true`; a plan is refused
  once the project was saved again. The renders go on when the AI app reloads the server: `status` finds the run again
  from its files and shows each chunk's progress and time per frame (aerender's total time over its frames).
  `status` only reports (the latest run of the open project; `all: true` for every run): it never starts or retries
  a render. A run whose chunks were still waiting when the server stopped is reported as interrupted, with the
  aerender commands of what is left; `run_local` with its `run` resumes it, but only within 6 hours of its start
  and while the project is unchanged since its plan.
- **`verify`**: wherever the chunks ran, proof of the result. Sequences: every frame present once, no extras, no
  empty or cut-off files (a complete PNG, a JPEG end marker, a DPX size field; other formats by header), with the exact
  missing frames and the `-s` / `-e` ranges to render again (missing, empty and cut-off frames). A few frames are
  looked at: when they are all the same flat picture (what frames outside the comp render as), it fails. With After
  Effects open on the project, 2 sampled frames are also compared with its own render of them (a tolerance of 4/255
  for colour conversion; it fails on a different picture, by area: over 1% of the frame, or spread over a quarter of
  it; small local differences such as text edges, which aerender and the app anti-alias a little differently, are a
  note with their pixel count and place). Movies: each part's frame count and duration with ffprobe,
  then the joined file's frame count, size, frame rate and codec against the comp and the output module; `join: true`
  joins the parts when that is lossless (never over an existing file). `proveFrames` makes the pixel proof strict, on
  as many frames as asked (the `ae_prove_identical` comparison and tolerance). The verdict is **PASS**, **FAIL (n)** or
  **INCOMPLETE** with what couldn't be checked.

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

### Chat with your AI app

The Surehand panel's **☰ › Chat with your AI app** runs an AI agent you already have installed and signed in to:
**Codex**, **Claude Code** or **Antigravity**. Your own subscription runs the model; Surehand never stores or handles
a key or a sign-in. For each chat the agent gets Surehand's tools as its only tools, and it works on the open
project.

- **Nothing bypasses your controls.** The agent's calls are ordinary AI calls: Full / Ask / Read-only, Pause AI, the
  approval card and the activity log apply exactly as for any AI app. In Ask mode the approval card moves into the
  chat while it is open (Esc denies).
- **Built-in tools are off.** The agent's shell, file edits and web access are switched off or not allowed; the
  agent's own approval prompt for Surehand's tools is off, so Surehand's mode is the one that decides.
- **Your agent's settings are left alone** for Codex and Claude Code (options apply to the run only). Antigravity
  has no per-session MCP option, so the Chat screen asks once to **Connect**: it adds Surehand to Antigravity's MCP
  servers and one allow rule for Surehand's tools, after a backup; Disconnect and the uninstaller remove both.
- **Sign-in:** the **AI apps for chat** screen shows each app as Ready, Not signed in or Not installed, with how to
  sign in (`claude auth login`, `codex login`, or start `agy` once).

Design notes, command lines and what each agent's stream looks like: [docs/chat-in-ae.md](docs/chat-in-ae.md).

### In-chat views

In AI apps that show interactive views (MCP Apps; for example Claude Desktop, ChatGPT, VS Code and Cursor), some
results come with a view in the chat:

- **Preflight report:** the verdict, a timeline of the findings, and each finding's frame.
- **Project X-ray:** what renders, from the render queue down to the footage, with what's missing, fragile, heavy
  while hidden or unused.
- **Stress test:** a grid of variants and checks, each failing frame marked, and the expressions that break in other
  After Effects languages.
- **What changed, and the proof:** a proven edit's verdict with before, after and difference frames, and what
  changed in the project (also for the history diff).

Views only navigate and look; they never change the project. Every edit goes through the chat. AI apps without
views (Claude Code, Windsurf, LM Studio) get the same results as text.

## Command line

The installed server is also a command: `surehand-ae <command>` (or `node ~/.surehand/ae/server/surehand-ae.mjs
<command>`). `surehand-ae --help` lists everything.

| Command | What it does |
|---|---|
| `selftest [--full]` | Check the installation and the connection; `--full` runs every major tool and saves a compatibility report |
| `diagnostics` | A report to paste into a bug report (no secrets) |
| `activity [n]` | The last n tool calls |
| `clients`, `connect <app>`, `disconnect <app>` | The AI apps on this computer and whether they are connected (`claude-desktop`, `claude-code`, `codex`, `cursor`, `vscode`, `windsurf`, `lm-studio`) |
| `chatgpt` | HTTP server + public tunnel for ChatGPT on the web |
| `update [--check] [--channel beta\|stable]` | Install the latest release, or only report |
| `checkpoints`, `checkpoint-diff <id>`, `checkpoint-save` | A project's checkpoints, what changed since one, save one |
| `skills [install\|uninstall]` | Where the Surehand skills are installed; write or remove them |
| `farm check <manifest.json>` | On a render node, without After Effects: does it have what the render needs? |
| `install`, `uninstall`, `setup` | Install, remove, or only install/update the extension, config and skills |

**Commands for the panel** (with `--json` they print one JSON object and never ask anything; an unknown command exits
with an error): `clients` → `{clients: [{id, name, installed, configured, inUse?, note?, action?}], snippet?}`;
`connect <app>` / `disconnect <app>` → `{ok, message}`; `checkpoints [--project <path>]` →
`{checkpoints: [{id, at, label, file, history?}]}`; `checkpoint-diff <id> [--project <path>]` → text (`{text}`; needs
After Effects: it compares with the open project); `test --json` → `{checks: [{ok, name, message?, fix?: {connect,
label?}}]}`; `update --check` → `{latest, current, updateAvailable, url, checkedAt, channel, notes?, keptBeta?}`
(installs nothing). Errors come as `{error}`. The panel runs them with the Node and server named in
`~/.surehand/ae/runtime.json`. The activity log entries also carry `changeList`, `revision`, `undoGroup` and, for
`ae_preflight` / `ae_prove_identical`, `result: {verdict, summary}`; background renders keep
`~/.surehand/ae/renders/<id>.json` up to date.

**Environment variables:** `SUREHAND_AE_CONFIG` (config file;
instances are looked up next to it), `SUREHAND_AE_BRIDGE_PORT`, `SUREHAND_AE_TOKEN`, `SUREHAND_AE_HTTP_PORT`,
`SUREHAND_AE_HTTP_TOKEN`, `SUREHAND_AE_TOOLS` (`core` / `full`), `SUREHAND_AE_INSTANCE`,
`SUREHAND_AE_BLOCKED_AFTER_SECONDS`, `SUREHAND_AE_STARTUP_WAIT_SECONDS`, `SUREHAND_AE_NO_UPDATE_CHECK`,
`SUREHAND_AE_NO_AUTOSETUP`, `SUREHAND_AE_NO_ACTIVITY_LOG`.

## Updates

**Updating:** click the version at the bottom of the panel (or **☰ › Check for updates…**) and install from the
**Updates** screen, or run `surehand-ae update` (`update --check` only reports). It downloads the server from the
latest GitHub release, checks its SHA-256 checksum and that it starts, replaces the installed one (the old one is
kept as `surehand-ae.mjs.previous`) and updates the After Effects extension. Restart After Effects and your AI apps
afterwards. If you use the Claude Desktop extension (`.mcpb`), install the new `Surehand-MCP.mcpb` from the release
page instead. The panel shows **· update ready** next to the version when a new version is out (checked against
GitHub at most once a day; turn off with `"updateCheck": false` in `~/.surehand/ae/config.json`).

**Beta updates:** turn on **☰ › Settings › Beta updates** in the panel (or run `surehand-ae update --channel beta`;
`"updateChannel": "beta"` in `config.json`) to be offered pre-releases too: the newest of the betas and the stable
releases, checked and installed the same way. Turning it off (`--channel stable`) never goes back to an older
version: a newer beta stays until a newer stable release is out.

### Updating from 1.3

Automatic. The first time 1.4 runs (installer, update, or just starting), your settings, checkpoints, project
history, access token and AI app connections carry over, so a ChatGPT connector URL keeps working. Nothing is
deleted: if something can't be moved (a file in use), everything keeps working where it was and the move is tried
again later; the reason is in `~/.surehand/migration.log`. Restart After Effects once to load the new panel; until
then Surehand says so. With the Claude Desktop extension: the 1.4 `.mcpb` installs as a new extension
(`surehand-ae`), so after installing it remove the previous version's entry in **Settings > Extensions**. What moves
where is under [Names](#names) for developers.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Cannot reach After Effects" | Make sure AE is running. Open **Window > Extensions > Surehand MCP** to see the bridge status. If **Surehand MCP** is missing from the menu, re-run the installer and fully restart AE. |
| Extension missing from the menu | Run `selftest`: it checks the extension's files against its signature (After Effects silently skips a signed extension whose files changed). Re-running the installer rewrites them. As a last resort, allowing unsigned extensions also works: set `PlayerDebugMode` to `1` with `defaults write com.adobe.CSXS.12 PlayerDebugMode 1` (macOS) or in the registry under `HKCU\Software\Adobe\CSXS.12` (Windows). |
| "Ports 8765-8774 are all in use" | Each After Effects takes the first free port from 8765 to 8774, so this means ten bridges are running or other programs hold those ports. Close other After Effects instances (or the program using the ports), or change `bridgePort` (the first port of the range) in `~/.surehand/ae/config.json` and restart AE + your AI app. |
| "Token mismatch" | Re-run the installer (it keeps the existing token) and restart AE. |
| Scripts can't run shell commands or use the network ("Permission denied") | Enable **Settings > Scripting & Expressions > Allow Scripts to Write Files and Access Network** in After Effects (Windows: **Edit > Preferences > Scripting & Expressions**). Surehand's own tools don't need it, and scripts can read and write files without it; `ae_status` and the panel's Test screen show whether it is on. |
| A call times out | ExtendScript can't be interrupted: long scripts or renders keep AE busy, and modal dialogs block it. Check AE, then retry. Pass `timeoutSeconds` for long jobs. |
| "After Effects is busy or showing a dialog" | A dialog or settings window (Project Settings, Preferences, an alert) is open in AE, or AE is still starting. Close it and retry: the call did not run and won't run later. Reported after 3s; change with `"blockedAfterSeconds"` in `~/.surehand/ae/config.json` (`0` waits for the full timeout). Scripts that have started are never cut short. |
| Claude Desktop doesn't show the tools | Quit Claude Desktop completely (menu bar / tray) and reopen it. Check `claude_desktop_config.json` contains `surehand-ae`. |

**Reporting a problem:** run **2. Test Installation** or `surehand-ae selftest`. If anything fails, it prints a
diagnostics report at the end (no secrets in it). You can also click **Copy diagnostics** in the Surehand panel, or
run `surehand-ae diagnostics`, and [open an issue](https://github.com/ConformLabs/surehand-mcp/issues). More help:
the [wiki](https://github.com/ConformLabs/surehand-mcp/wiki) ([Troubleshooting](https://github.com/ConformLabs/surehand-mcp/wiki/Troubleshooting),
[The Surehand panel](https://github.com/ConformLabs/surehand-mcp/wiki/The-Surehand-panel)).

**Several After Effects versions at once.** Each running After Effects registers its own bridge (ports 8765–8774).
The AI controls the one you used most recently; `ae_status` lists all of them and switches with `instance: "2025"`
(or a version or port). Set a permanent preference with `"instance": "2026"` in the config.

**Cancel and stuck detection.** When the AI app cancels a request, it is dropped if After Effects hasn't started it
yet. If After Effects doesn't answer, the error says what it is busy with and for how long, and suggests checking
for an open dialog. `ae_status` shows the same.

## Limits

What Surehand doesn't do, or can't do yet. Each feature's own limits are in its [reference section](#feature-reference).

- **CEP today.** The panel and bridge are a CEP extension, the extension system After Effects supports today. Adobe
  is bringing UXP, its newer extension system, to After Effects; a UXP panel is planned, and the scripting layer
  stays the same.
- **After Effects must be running.** Surehand works through the open After Effects (a few things, such as
  `ae_find_files` and `surehand-ae farm check`, don't need it). Tested release by release on After Effects 2025 and 2026, macOS and
  Windows 11; older versions back to CC 2019 load the extension but are best effort, and some checks need a newer
  After Effects (paragraph overflow 24.6, missing-glyph checks 25.1) and say so instead of passing.
- **One undo step, with exceptions.** Every tool call is one undo group, but After Effects can split some groups
  (seen with comp duplicates, layer copies and source replacements). Precomp surgery and deep duplicates name the
  exact way back instead. The handoff package reopens your project from disk, so its undo history starts fresh. The
  panel's Undo only offers the most recent change, and only when nothing changed since.
- **"Allow Scripts to Write Files and Access Network".** Surehand's own tools don't need this After Effects setting,
  and scripts can read and write files without it. Scripts that run shell commands or use the network do; `ae_status`
  and the panel's test screen show whether it is on.
- **ffmpeg** is needed for Preflight's checks on rendered files and for the farm's movie chunks (counting frames,
  joining parts). Surehand uses yours, or downloads a pinned, checksum-verified build once, only after you allow it.
  Everything in the project itself works without it.
- **aerender** (installed with After Effects) is needed for background renders, the handoff package's render proof
  and the farm's local runs.
- **Proofs sample frames.** `ae_prove_identical`, precomp surgery and render optimizations compare the sampled video
  frames, alpha included. Audio, the comp's background colour and the times between samples are not compared.
- **Preflight's flash check is a pre-check**, not a certified PSE / Harding test.
- **Read-only mode and the permissions are guardrails, not a sandbox.** See [What the AI can and can't
  do](#what-the-ai-can-and-cant-do).
- **Chat in After Effects** supports Codex, Claude Code and Antigravity. Antigravity's output format isn't documented
  yet: Surehand reads the format Antigravity's CLI 1.4 writes, so a later Antigravity version may need an update.
- **Right to left:** paragraph direction, the composer and alignment are set; mirroring the layout itself, kashida
  justification and per-character direction are not available to scripts.

## FAQ

**Does it make motion graphics from a prompt?** No. It operates After Effects on your project: your layers,
keyframes, expressions and rules. It doesn't generate images and ships no presets or looks.

**Does my project leave my computer?** The project files stay local. Your AI app sends your messages and the tool
results (including frames the AI renders to look at) to its provider, under that provider's terms.

**Does it cost anything, or need an account?** No. It is free and MIT licensed. You need an AI app you already use;
its own plan applies.

**Which AI app works best?** Any app that supports MCP tools works. Apps that show in-chat views (Claude Desktop,
ChatGPT, VS Code, Cursor) also show the Preflight, X-ray, stress-test and proof views.

**Will the AI break my project?** It can make mistakes like anyone. That is why every edit is one undo step with a
change report, structural edits are proven, Ask mode shows you each edit first, and checkpoints keep safety copies.

**Is a non-English After Effects supported?** Yes. Property, effect and menu names are mapped to match names, which
are the same in every language, and the stress test and X-ray flag expressions that break in another language.

## Development

```
server/              MCP server (TypeScript) -> bundled into server/dist/surehand-ae.mjs
  src/aemcp.jsxinc     ExtendScript helper library, loaded into AE on demand (reloaded when it changes)
  src/tools/           tool definitions (each tool is a small ExtendScript function body)
  src/cli/             install / uninstall / selftest / chatgpt / setup commands (surehand-ae <command>)
  src/chat/            the panel's Chat with your AI app (agents, runner)
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
skills/              the Agent Skills (embedded in the server bundle; `install` writes them)
docs/                design notes (chat-in-ae.md)
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
or updates it when it starts. After changing the server or the panel: rebuild, re-run the installer, restart After
Effects.

To add a tool, add an entry to one of the arrays in `server/src/tools/*.ts`: a zod input schema plus an ExtendScript
function body that receives `args` and can use the `aemcp` helpers. The tool counts in this README are checked by
`server/test/readme-tool-count.test.ts`.

<a name="names"></a>

**Names.** The family is Surehand (Photoshop and Premiere may follow), so this app's names are `surehand-ae`: the
command (`ae-mcp` stays as an alias), the server file `surehand-ae.mjs`, the MCP server name and the key in each AI
app's settings (`SERVER_NAME`; 1.3 used `after-effects`), the `.mcpb` `name` (its `display_name` is "Surehand MCP"),
and the folders `~/.surehand/ae` (this app) and `~/.surehand` (shared: `node/`, `ffmpeg/`); all in
`server/src/paths.ts`. Unchanged so scripts and the extension keep working: the tool names (`ae_*`), the After
Effects extension id `com.aemcp` (and its bundle ids), the `aemcp` helper object and `aemcp://` resource URIs.
Environment variables are `SUREHAND_AE_*`; the `AEMCP_*` names still work. Releases carry the server as
`surehand-ae.mjs` and also as `ae-mcp.mjs` (what 1.3's updater downloads). The npm package name is `surehand-mcp`.

**Moving from 1.3** (`server/src/migrate.ts`): 1.3 kept everything in `~/.aemcp`. 1.4 moves settings,
checkpoints, project history and other files to `~/.surehand/ae`, the private Node.js and ffmpeg to `~/.surehand`,
and points AI apps that ran the old server at the new one (`after-effects` becomes `surehand-ae`; an
`after-effects` entry that isn't ours is left alone). Until After Effects is restarted once, the old extension still
runs and uses `~/.aemcp`, so a copy of `config.json`, an `instances` folder, a small `server/ae-mcp.mjs` that starts
the new server and `MOVED.txt` stay there; uninstalling removes them too.

<a name="testing-on-windows"></a>

### Testing a build on Windows

Confirmed working on Windows 11: install (including the automatic Node.js download), self-test, and the ChatGPT
desktop app. Use this checklist to test other machines.

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

<a name="license"></a>

## License and credits

MIT, see [LICENSE](LICENSE). A Conform Labs product, created and maintained by Ron Yitzhaki
([@ronyitzhaki](https://github.com/ronyitzhaki)).

Surehand doesn't ship FFmpeg: when you allow it, it downloads the publisher's own build (Martin Riedl's builds on
macOS, BtbN/FFmpeg-Builds on Windows) under that build's licence; see [ffmpeg](#preflight-rendered-files). JavaScript
in scripts is converted for ExtendScript with [Babel](https://babeljs.io).

Adobe and After Effects are either registered trademarks or trademarks of Adobe in the United States and/or other
countries. Surehand MCP is not affiliated with or endorsed by Adobe.
