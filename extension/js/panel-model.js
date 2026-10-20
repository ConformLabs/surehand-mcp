/* What the Surehand panel and the approval pop-up show, as pure functions (no DOM, no Node):
 * status, mode texts, feed items from the activity log, approval cards, layout, render progress.
 * ES5 only (CEP 9 runs an old Chromium). Tested in server/test/panel-model.test.ts. */
(function (global) {
  "use strict";

  // ---------- layout ----------
  /** narrow below 260 px; wide (two columns) when wider than 560 px and at most 300 px tall. */
  function layoutFor(width, height) {
    if (width < 260) return "narrow";
    if (width > 560 && height <= 300) return "wide";
    return "default";
  }

  // ---------- modes (config permissions.mode) ----------
  // one line everywhere (the boards); "Read-only" is spelled out also when narrow
  var MODES = [
    { id: "full", label: "Full", short: "Full", desc: "Edits directly; every step can be undone." },
    { id: "ask", label: "Ask", short: "Ask", desc: "Every change waits for your OK here." },
    { id: "read-only", label: "Read-only", short: "Read-only", desc: "Looks and previews; changes nothing." },
  ];
  MODES.forEach(function (m) { m.narrow = m.desc; });
  function modeOf(cfg) {
    var m = cfg && cfg.permissions && cfg.permissions.mode;
    return m === "ask" || m === "read-only" ? m : "full";
  }

  // ---------- AI apps ----------
  var CLIENTS = [
    [/^claude-ai$|claude.?desktop/i, "Claude Desktop"],
    [/claude.?code/i, "Claude Code"],
    [/cursor/i, "Cursor"],
    [/codex/i, "Codex"],
    [/chatgpt|openai/i, "ChatGPT"],
    [/windsurf|codeium/i, "Windsurf"],
    [/devin/i, "Devin Desktop"],
    [/lm.?studio/i, "LM Studio"],
    [/vscode|visual studio code|copilot/i, "VS Code"],
    [/zed/i, "Zed"],
  ];
  /** "claude-ai" -> "Claude Desktop" (MCP clientInfo names are not meant for people). */
  function clientName(raw) {
    if (!raw) return null;
    for (var i = 0; i < CLIENTS.length; i++) if (CLIENTS[i][0].test(raw)) return CLIENTS[i][1];
    return String(raw).replace(/[-_]+/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  /** The AI app seen most recently in the activity log (newest first). */
  function lastClient(activity) {
    for (var i = 0; i < activity.length; i++) if (activity[i] && activity[i].client) return clientName(activity[i].client);
    return null;
  }

  // ---------- status ----------
  /**
   * s: { bridgeError, paused, pendingCount, client, everConnected }
   * -> { kind: "problem"|"paused"|"waiting"|"idle"|"ready", tile, glyph, text, short } (glyph: the status square: "verified", "waiting" (amber), "pending" (dotted), "failed")
   */
  function statusFor(s) {
    if (s.bridgeError) {
      return { kind: "problem", tile: "gray", glyph: /^Not connected/.test(s.bridgeError) ? "pending" : "failed", text: s.bridgeError, short: "Problem" };
    }
    if (s.paused) return { kind: "paused", tile: "amber", glyph: "waiting", text: "AI paused", short: "Paused" };
    if (s.pendingCount) {
      return { kind: "waiting", tile: "green", glyph: "waiting", short: "Waiting",
        text: "Waiting for you" + (s.pendingCount > 1 ? " · " + s.pendingCount : "") };
    }
    // s.apps: the AI apps connected right now (their servers run), or null when not known
    if (s.apps && s.apps.length) return { kind: "ready", tile: "green", glyph: "verified", text: "Connected \u00b7 " + appsText(s.apps), short: "Connected" };
    if (s.apps && s.everConnected) return { kind: "idle", tile: "gray", glyph: "pending", text: "No AI app open", short: "No AI app" };
    if (!s.everConnected) return { kind: "idle", tile: "gray", glyph: "pending", text: "No AI app connected", short: "Not connected" };
    return { kind: "ready", tile: "green", glyph: "verified", text: "Ready" + (s.client ? " · " + s.client : ""), short: "Ready" };
  }
  /** "Claude Desktop", "Claude Desktop and Cursor", "Claude Desktop +2" */
  function appsText(apps) {
    if (apps.length === 1) return apps[0];
    if (apps.length === 2) return apps[0] + " and " + apps[1];
    return apps[0] + " +" + (apps.length - 1);
  }
  /**
   * The menu's "Connect an AI app" subtitle from the clients the panel loaded ({name, configured, action}):
   * "Claude Desktop, Cursor connected", or null when none is set up. ChatGPT on the web has its own row.
   */
  function connectedClientsText(list) {
    var names = (list || []).filter(function (c) { return c && c.configured && c.action !== "start"; }).map(function (c) { return c.name; });
    if (!names.length) return null;
    return (names.length > 3 ? names.slice(0, 3).join(", ") + " +" + (names.length - 3) : names.join(", ")) + " connected";
  }
  /** The connected apps from the servers' session files ({pid, client}) whose process still runs. */
  function connectedApps(sessions, alive) {
    var out = [];
    (sessions || []).forEach(function (x) {
      if (!x || !x.pid || !alive(x.pid)) return;
      var n = clientName(x.client) || "An AI app";
      if (out.indexOf(n) < 0) out.push(n);
    });
    return out;
  }

  // ---------- readable tool names ----------
  var NAMES = {
    ae_run_script: "Run script", ae_run_script_file: "Run script file", ae_batch: "Batch", ae_undo: "Undo", ae_redo: "Redo",
    ae_get_project_info: "Read project", ae_get_comp_info: "Read comp", ae_get_layer_info: "Read layer", ae_get_comp_map: "Read comp map",
    ae_get_properties: "Read properties", ae_find_properties: "Find properties", ae_get_selection: "Read selection",
    ae_get_layer_bounds: "Measure layer", ae_render_frame: "Preview frame", ae_render_contact_sheet: "Contact sheet",
    ae_status: "Check connection", ae_preflight: "Preflight", ae_prove_identical: "Prove identical", ae_checkpoint: "Checkpoint",
    ae_render_background: "Background render", ae_render_jobs: "Render jobs", ae_project_xray: "Project X-ray",
    ae_project_history: "Project history", ae_get_scripting_guide: "Read the scripting guide", ae_tools: "List tools", ae_call: "Tool",
    // called by the in-chat views (MCP Apps), not the AI: navigation and looking only
    ae_view_reveal: "Show in After Effects", ae_view_frame: "Frame for the chat", ae_view_proof_frame: "Proof frames for the chat", ae_view_xray_node: "X-ray details for the chat",
  };
  function toolName(tool, args) {
    if (tool === "ae_call" && args && args.tool) return toolName(String(args.tool), args.args);
    var n = NAMES[tool] || String(tool || "").replace(/^ae_/, "").replace(/_/g, " ").replace(/^\w/, function (c) { return c.toUpperCase(); });
    var target = args && (typeof args.comp === "string" ? args.comp : typeof args.layer === "string" ? args.layer : null);
    if (target && /^(Read|Measure|Preview)/.test(n)) n += " " + target;
    return n;
  }
  var READ_TOOL = /^ae_(get_|list_|find_|view_|render_frame|render_contact_sheet|status|sample_|project_xray|project_history|tools|check_expression|system_info|project_health)/;

  function plural(n, one, many) { return n + " " + (n === 1 ? one : many || one + "s"); }

  /** "~ layer "Title" in "Main": Position ..." -> "Title › Position ..." (the change report's own lines). */
  function changeLine(line) {
    return String(line).replace(/^[+~-]\s+/, "").replace(/^layer "([^"]+)" in "[^"]+":\s*/, "$1 › ")
      .replace(/^(\S[^>]*?) > /, "$1 › ").replace(/"/g, "");
  }

  /**
   * One activity-log entry as a feed item: { kind, title, line, details, at, undoable }.
   * kind: "change" (edited the project), "problem" (failed, or Preflight found problems), "proof"
   * (proven identical / Preflight passed), "read" (looked only).
   */
  function describeEntry(e) {
    var args = e.args || {};
    var tool = e.tool === "ae_call" && args.tool ? String(args.tool) : e.tool;
    var summary = String(e.summary || "");
    var item = { at: e.at, tool: tool, kind: "read", title: toolName(e.tool, args), line: "", undoable: false, entry: e };
    if (tool === "ae_preflight") {
      var m = /^(FAIL|WARNINGS|INCOMPLETE|PASS)\b(?:\s*\((\d+))?/.exec(summary);
      // a spec file is named by its file name (the whole path is in Details)
      var spec = args.spec && (args.spec.name || (typeof args.spec === "string" ? args.spec.split(/[\\/]/).pop() : null));
      item.line = [spec, typeof args.comp === "string" ? args.comp : null].filter(Boolean).join(" · ");
      if (!e.ok || !m) { item.kind = "problem"; item.title = "Preflight did not finish"; item.line = summary; }
      else if (m[1] === "PASS") { item.kind = "proof"; item.title = "Preflight passed"; }
      else if (m[1] === "INCOMPLETE") { item.kind = "problem"; item.title = "Preflight incomplete"; }
      else { item.kind = "problem"; item.title = "Preflight: " + plural(Number(m[2]) || 1, m[1] === "FAIL" ? "problem" : "warning"); }
      return item;
    }
    var proof = /Verdict: (IDENTICAL WITHIN TOLERANCE|IDENTICAL|DIFFERS|NOT PROVEN)[^\d]*(\d+)?/.exec(summary);
    if (proof || tool === "ae_prove_identical") {
      var frames = proof && proof[2] ? plural(Number(proof[2]), "frame") : "";
      if (proof && /^IDENTICAL/.test(proof[1])) { item.kind = "proof"; item.title = "Proven identical"; }
      else if (proof) { item.kind = "problem"; item.title = proof[1] === "DIFFERS" ? "Not identical" : "Not proven"; }
      item.line = frames;
      if (!proof) item.line = summary;
      if (!e.ok && !proof) item.kind = "problem";
      return item;
    }
    if (!e.ok) {
      var why = refusal(summary, e);
      if (why) { item.kind = "blocked"; item.line = why; return item; }
      // the title is the tool; the FAILED word and the red square say that it failed
      item.kind = "problem";
      item.line = readableError(summary);
      return item;
    }
    var changes = Number(e.changes) || 0;
    var list = e.changeList || e.changeLines; // newer servers: the change report's lines
    if (changes || (list && list.length) || (!READ_TOOL.test(tool) && tool !== "ae_undo" && tool !== "ae_redo" && /^Changes: (?!none)/.test(summary))) {
      item.kind = "change";
      item.undoable = true;
      if (list && list.length) item.line = list.slice(0, 2).map(changeLine).join(" · ") + (list.length > 2 ? " · +" + (list.length - 2) : "");
      else {
        // the result's first line is often compact JSON: name what was edited instead
        var readable = summary && !/^[\[{"]|^OK \(no return|^Changes/.test(summary) ? summary.slice(0, 120) : null;
        var where = [args.layer, args.comp].filter(function (x) { return typeof x === "string"; }).join(" in ");
        item.line = [readable || where || null, changes ? plural(changes, "change") : null].filter(Boolean).join(" · ");
      }
      if (tool === "ae_batch" && args.steps && args.steps.length) item.title = "Batch: " + plural(args.steps.length, "step");
      return item;
    }
    if (tool === "ae_checkpoint" && args.action === "save") { item.kind = "change"; item.title = "Checkpoint saved"; item.line = args.label || ""; return item; }
    item.line = "";
    return item;
  }

  /**
   * A feed item's status square and word: { glyph, word }. glyph: "changed" (hollow amber), "verified"
   * (filled green), "failed" (red cross), "notrun" (grey bar), "pending" (dotted grey: looked only).
   * word: "Changed" / "Passed" / "Identical" / "Failed" / "Not run", shown in mono capitals; reads have none.
   */
  function statusOf(item) {
    switch (item && item.kind) {
      case "change": return { glyph: "changed", word: "Changed" };
      case "proof": return { glyph: "verified", word: item.tool === "ae_preflight" ? "Passed" : "Identical" };
      case "problem": return { glyph: "failed", word: "Failed" };
      case "blocked": return { glyph: "notrun", word: "Not run" };
      default: return { glyph: "pending", word: "" };
    }
  }

  /**
   * One change-report line for the machine-output box: { path, from, to } when it says "x: old -> new"
   * (the old value is shown struck through), else { path }.
   */
  function changeParts(line) {
    var t = changeLine(line), m = /^(.*?):\s*(.+?)\s*->\s*(.+)$/.exec(t);
    return m ? { path: m[1], from: m[2], to: m[3] } : { path: t };
  }

  /**
   * Calls that were not run because of a choice the user made (Pause, Deny, Read-only, shell commands off) or
   * because nobody answered: not failures. Returns the reason in the user's words, or null.
   */
  function refusal(summary, e) {
    var s = String(summary || "");
    // the row says NOT RUN; the line says why and how to allow it
    if ((e && e.paused) || /^Paused in the Surehand panel/.test(s)) return "The AI was paused. Resume to allow it.";
    if (/denied this change|denied in the Surehand/i.test(s)) return "You denied it.";
    if (/No one approved this change/i.test(s)) return "No answer within 10 minutes.";
    if (/read-only mode/i.test(s) && !/can.t undo|couldn.t reliably/i.test(s)) return "Read-only mode. Switch to Full or Ask to allow it.";
    if (/Shell commands .*(disabled|blocked)/i.test(s)) return "Shell commands are off in the menu.";
    return null;
  }
  /** A failure's first line for people: the known ones in plain words (with the fix), others cut to their first sentence. */
  function readableError(summary) {
    var s = String(summary || "").replace(/^Error:\s*/, "");
    if (/^Cannot reach After Effects/i.test(s)) return "After Effects wasn\u2019t reachable. Is it open?";
    if (/busy or showing a dialog|modal dialog/i.test(s)) return "After Effects was showing a dialog. Close it and ask again.";
    var t = /^Timed out after (\d+)s/.exec(s);
    if (t) return "Took longer than " + t[1] + " s: After Effects may have been busy.";
    var first = /^(.{12,}?[.!?])(\s|$)/.exec(s);
    s = first ? first[1] : s;
    return s.length > 160 ? s.slice(0, 157) + "\u2026" : s;
  }

  /** The change list for Details (newer logs carry it; older ones only the first line and the call itself). */
  function entryDetails(e, group) {
    if (group && group.length > 1) return group.map(function (x) { return hhmm(x.at) + "  " + toolName(x.tool, x.args); }).join("\n");
    var list = e.changeList || e.changeLines;
    if (list && list.length) return list.join("\n");
    var args = e.args || {};
    var body = typeof args.code === "string" ? args.code : JSON.stringify(args, null, 2);
    return (e.summary ? e.summary + "\n\n" : "") + body;
  }

  /**
   * May the panel offer Undo for this activity entry? Edit > Undo undoes whatever was done last in
   * the After Effects it runs in, so only when that is certainly this call's one step: the entry
   * names its undo step and the project's revision after it, it made exactly one undo step, it ran
   * in this After Effects (bridge port and process) and in the project open now, and the project
   * hasn't changed since (current revision === the entry's). `cur`: { port, pid, project, revision }.
   */
  function canUndo(e, cur) {
    if (!e || !cur || !e.undoGroup || typeof e.revision !== "number" || e.undoSteps !== 1) return false;
    if (!e.instance || e.instance.port !== cur.port || e.instance.pid !== cur.pid) return false;
    if (typeof e.project !== "string" || e.project !== cur.project) return false;
    return cur.revision === e.revision;
  }

  /**
   * Feed items, newest first: running renders on top, then up to `limit` log entries. The newest
   * entry may get Undo (only it, only if it changed the project, wasn't undone already, and canUndo
   * with opts.current).
   */
  function feedItems(activity, opts) {
    opts = opts || {};
    var limit = opts.limit || 6, undone = opts.undone || {};
    var out = [];
    for (var i = 0; i < activity.length; i++) {
      var e = activity[i];
      if (!e || !e.tool) continue;
      if (e.tool === "ae_render_background" && e.ok && opts.runningRenders && opts.runningRenders[renderIdOf(e)]) continue;
      var it = describeEntry(e), prev = out[out.length - 1];
      // looking around is one row: consecutive reads are grouped (the newest one's time)
      if (it.kind === "read" && prev && prev.kind === "read") { addRead(prev, it); continue; }
      if (out.length >= limit) break;
      out.push(it);
    }
    out.forEach(function (it) { if (it.group) finishReads(it); });
    out.forEach(function (it, k) {
      var newest = it.undoable && k === 0 && it.entry === activity[0] && !undone[entryKey(it.entry)];
      it.undoable = newest && canUndo(it.entry, opts.current);
      // it would be undoable, but the project changed since (or another one is open): say so instead of a dead button
      it.undoBlocked = !!(newest && !it.undoable && opts.current && it.entry.undoGroup && it.entry.undoSteps === 1);
    });
    return out;
  }
  function entryKey(e) { return e.at + "|" + e.tool; }
  function addRead(row, it) {
    if (!row.group) row.group = [row.entry];
    row.group.push(it.entry);
  }
  /** "Read comp Main" ×3, or "Read N items" with what it read. */
  function finishReads(row) {
    var titles = [], seen = {};
    row.group.forEach(function (e) {
      var t = toolName(e.tool, e.args);
      if (!seen[t]) { seen[t] = true; titles.push(t); }
    });
    var n = row.group.length;
    if (titles.length === 1) { row.title = titles[0]; row.line = plural(n, "time"); }
    else {
      // "Read 2 items" with what it read ("comp Main · layer Title", shown in mono)
      row.title = "Read " + plural(titles.length, "item");
      titles = titles.map(readItemName);
      row.line = titles.slice(0, 3).join(" \u00b7 ") + (titles.length > 3 ? " \u00b7 +" + (titles.length - 3) : "");
    }
    row.count = n;
  }

  /** "Read comp Main" -> "comp Main"; "Measure layer Title" -> "measure layer Title". */
  function readItemName(title) {
    return /^Read /.test(title) ? title.slice(5) : title.charAt(0).toLowerCase() + title.slice(1);
  }

  // ---------- what the AI is doing right now ----------
  function secsText(ms) { var s = Math.round((ms || 0) / 1000); return s >= 2 ? (s < 120 ? s + " s" : Math.floor(s / 60) + " min") : ""; }
  /**
   * What the AI is doing right now, for the row above the feed: { text, time, line, waiting }, or null.
   * h: the bridge's /health while an AI call runs (busyWith: its tool; not the panel's own small jobs).
   * unreachableMs: how long the bridge, which answered before, hasn't answered: it lives inside After
   * Effects and can't answer while After Effects runs a script (which freezes this panel too); after a
   * minute that is worth saying.
   */
  function workingView(h, unreachableMs) {
    if (!h && typeof unreachableMs === "number" && unreachableMs >= 0) {
      if (unreachableMs > 60000) return { text: "After Effects isn\u2019t answering", time: secsText(unreachableMs), waiting: true,
        line: "It may be running a long script, rendering, or showing a dialog. Surehand picks up again when it\u2019s free." };
      return null; // the panel itself is frozen while After Effects runs a script: nothing to draw
    }
    if (!h || !h.busy || !h.busyWith || /^panel|^diagnostics/.test(h.busyWith)) return null;
    if ((h.waitingForMs || 0) > 4000) {
      return { text: "Waiting for After Effects", time: secsText(h.waitingForMs), waiting: true,
        line: "It\u2019s busy or showing a dialog. " + toolName(h.busyWith) + " runs when it\u2019s free." };
    }
    return { text: "Working \u00b7 " + toolName(h.busyWith), time: secsText(h.busyForMs), line: "", waiting: false };
  }

  // ---------- "Allow Scripts to Write Files and Access Network" ----------
  /** Where the setting is: "After Effects › Settings › Scripting & Expressions" (Windows: Edit › Preferences). */
  function writeAccessWhere(platform) {
    return platform === "win32" ? "Edit \u203a Preferences \u203a Scripting & Expressions" : "After Effects \u203a Settings \u203a Scripting & Expressions";
  }
  /**
   * The Test screen's row for the setting (canWrite: true / false), or null when it isn't known. Off, scripts can't
   * run shell commands or use the network; Surehand's own tools need neither, so it is a passed row that says so
   * (no standing notice in the panel).
   */
  function writeAccessCheck(canWrite, platform) {
    if (canWrite === true) return { ok: true, name: "scripting-prefs", message: "Scripts may run shell commands and use the network" };
    if (canWrite === false) return { ok: true, name: "scripting-prefs",
      message: "Off: scripts can\u2019t run shell commands or use the network (Surehand\u2019s tools don\u2019t need either). " +
        "To allow it, turn on Allow Scripts to Write Files and Access Network in " + writeAccessWhere(platform) + "." };
    return null;
  }

  // ---------- background renders ----------
  function renderIdOf(e) {
    var m = /job (r[0-9a-z]+)/.exec(String(e.summary || ""));
    return m ? m[1] : null;
  }
  /** From the activity entry "Background render started: job r123 (Main, 300 frames) from ...". */
  function renderStartInfo(e) {
    var m = /job (r[0-9a-z]+) \((.+?), (\d+|\?) frames\)/.exec(String(e.summary || ""));
    return m ? { id: m[1], comp: m[2], frames: Number(m[3]) || 0 } : null;
  }
  function timecodeFrames(tc, fps) {
    var p = String(tc).split(/[:;]/).map(Number);
    if (p.length !== 4 || !fps) return 0;
    return Math.round(((p[0] * 60 + p[1]) * 60 + p[2]) * fps + p[3]);
  }
  /**
   * aerender's log -> { done, failed, comp, frame, frames, pct }. Frames come from the activity
   * entry when known, else from the log's Duration / Frame Rate lines.
   */
  function renderProgress(log, info) {
    log = String(log || "");
    var r = { done: false, failed: false, comp: info && info.comp || null, frame: 0, frames: info && info.frames || 0, pct: null };
    if (/Total Time Elapsed|Finished composition/i.test(log)) r.done = true;
    if (/aerender ERROR|^ERROR/im.test(log)) r.failed = true;
    var comp = /composition\s+[“"](.+?)[”"]/i.exec(log);
    if (!r.comp && comp) r.comp = comp[1];
    if (!r.frames) {
      var dur = /Duration:\s*([\d:;]+)/.exec(log), fps = /Frame Rate:\s*([\d.]+)/.exec(log);
      if (dur && fps) r.frames = timecodeFrames(dur[1], Number(fps[1]));
    }
    var re = /PROGRESS:.*?\((\d+)\)/g, m;
    while ((m = re.exec(log))) r.frame = Math.max(r.frame, Number(m[1]));
    if (r.frames) r.pct = Math.min(100, Math.round((r.frame / r.frames) * 100));
    return r;
  }
  /** "1:12 left" from progress so far (null until there's enough to say). */
  function timeLeft(pct, elapsedMs) {
    if (!pct || pct < 2 || pct >= 100 || !(elapsedMs > 0)) return null;
    var s = Math.round((elapsedMs * (100 - pct)) / pct / 1000);
    return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2) + " left";
  }

  // ---------- approvals ----------
  var RISKS = [
    [/\.remove\s*\(|delete_layers|remove_items|remove_effect|remove_keyframes|"delete/i, "deletes", true],
    [/callSystem|system\s*\[/, "runs a shell command", true],
    [/\.save\s*\(|saveAs|save_project|"save"\s*:\s*true/i, "saves the project", true],
    [/"overwrite"\s*:\s*true|\.write\s*\(|\.writeln\s*\(/, "writes files", true],
    [/app\.(open|newProject)\s*\(|open_project|new_project|\.close\s*\(/i, "closes or opens a project", true],
    [/executeCommand|execute_menu_command/i, "runs menu commands", false],
    [/importFile|import_files|replace_footage/i, "imports files", false],
    [/new File\s*\(|\.open\s*\(\s*["']r/i, "reads files", false],
    [/addComp|create_comp|precompose/i, "creates comps", false],
    [/\.add(Solid|Text|Shape|Null|Light|Camera|BoxText)\b|add_layer|add_shape/i, "adds layers", false],
    [/setValue|setValueAtTime|set_property|set_keyframes|expression/i, "changes properties", false],
  ];
  /** Chips for an approval request, from its text (all of the script or the call's arguments). */
  function riskChips(summary, tool) {
    var text = String(tool || "") + "\n" + String(summary || ""), out = [];
    for (var i = 0; i < RISKS.length && out.length < 4; i++) if (RISKS[i][0].test(text)) out.push({ text: RISKS[i][1], danger: RISKS[i][2] });
    return out;
  }
  /**
   * { title, says, chips, client, code } for an approval card. The title is the tool (what will run);
   * a script's first comment is the AI's own description, so it is only quoted ("The AI says: ..."),
   * never presented as the title. Chips come from the bridge, which checked the whole text (the card
   * may show only its start); older bridges: from the shown text.
   */
  function approvalView(p, fallbackClient) {
    var summary = String(p.summary || "");
    var title = p.tool || "Change the project";
    var first = /^\s*\/\/\s*(.{3,120})/.exec(summary) || /^\s*\/\*+\s*(.{3,120}?)\s*(\*\/|$)/m.exec(summary);
    var says = /script/i.test(title) && first ? first[1].replace(/\s*\*\/\s*$/, "") : null;
    var chips = Object.prototype.toString.call(p.chips) === "[object Array]" ? p.chips : riskChips(summary, p.tool);
    return { title: title, says: says, chips: chips, client: clientName(p.client) || fallbackClient || "Your AI app", code: summary };
  }
  /** "0:42": time left to answer (requests give up after 10 minutes). */
  function countdown(deadline, now) {
    var ms = Date.parse(deadline) - now;
    if (!(ms > 0)) return "0:00";
    var s = Math.ceil(ms / 1000);
    return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2);
  }
  /** { text: "1:18 left", urgent }: urgent (shown amber) under a minute. */
  function countdownView(deadline, now) {
    var ms = Date.parse(deadline) - now;
    return { text: countdown(deadline, now) + " left", urgent: !(ms >= 60000) };
  }
  var PREVIEW_LINES = 6;
  /**
   * The approval's script preview. With a danger chip it opens by itself, capped at 6 lines with
   * "Show all N lines"; otherwise it stays closed behind "Show the script" (or "Show the details").
   * -> { open, text, toggle (the link's text, or null for none) }. `state`: { open, full } after clicks.
   */
  function previewView(v, isScript, state) {
    state = state || {};
    var danger = v.chips.some(function (c) { return c.danger; });
    var lines = String(v.code || "").replace(/\s+$/, "").split(/\r?\n/), n = lines.length;
    var noun = isScript ? "the script" : "the details";
    if (danger) {
      if (n <= PREVIEW_LINES) return { open: true, text: lines.join("\n"), toggle: null, danger: true };
      if (state.full) return { open: true, text: lines.join("\n"), toggle: "Show fewer lines", danger: true };
      return { open: true, text: lines.slice(0, PREVIEW_LINES).join("\n"), toggle: "Show all " + n + " lines", danger: true };
    }
    return { open: !!state.open, text: lines.join("\n"), toggle: (state.open ? "Hide " : "Show ") + noun, danger: danger };
  }

  // ---------- small helpers ----------
  function hhmm(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }
  function dayLabel(iso, now) {
    var d = new Date(iso), n = new Date(now);
    var a = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), b = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
    var days = Math.round((b - a) / 86400000);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  }
  function whenLabel(iso, now) {
    var day = dayLabel(iso, now);
    return (day === "Today" || day === "Yesterday" ? day.toLowerCase() : day) + " " + hhmm(iso);
  }
  /** The JSON a CLI command printed (the last line that parses), or null. */
  function parseCliJson(stdout) {
    var lines = String(stdout || "").trim().split(/\r?\n/);
    for (var i = lines.length - 1; i >= 0; i--) {
      var l = lines[i].trim();
      if (l.charAt(0) !== "{" && l.charAt(0) !== "[") continue;
      try { return JSON.parse(l); } catch (e) {}
    }
    try { return JSON.parse(String(stdout)); } catch (e) { return null; }
  }
  /** -1 / 0 / 1, like the server's compareVersions: a pre-release comes before its release (1.4.0-beta.3 < 1.4.0). */
  function cmpVersions(a, b) {
    function parse(v) {
      v = String(v).replace(/^v/, "");
      var dash = v.indexOf("-");
      return { n: (dash < 0 ? v : v.slice(0, dash)).split("."), pre: dash < 0 ? null : v.slice(dash + 1).split(".") };
    }
    var pa = parse(a), pb = parse(b), i;
    for (i = 0; i < 3; i++) { var x = parseInt(pa.n[i], 10) || 0, y = parseInt(pb.n[i], 10) || 0; if (x !== y) return x > y ? 1 : -1; }
    if (!pa.pre || !pb.pre) return pa.pre ? -1 : pb.pre ? 1 : 0;
    for (i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
      var p = pa.pre[i], q = pb.pre[i];
      if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
      if (p === q) continue;
      var np = /^\d+$/.test(p), nq = /^\d+$/.test(q);
      if (np && nq) return Number(p) > Number(q) ? 1 : -1;
      if (np !== nq) return np ? -1 : 1;
      return p > q ? 1 : -1;
    }
    return 0;
  }

  // ---------- updates ----------
  /** "beta" | "stable" (the default), from config.json's updateChannel. */
  function updateChannel(cfg) { return cfg && cfg.updateChannel === "beta" ? "beta" : "stable"; }
  /** An update check (update-check.json or `update --check --json`) if it was made on this channel (older ones have none: stable). */
  function updateFor(u, channel) { return u && u.latest && (u.channel || "stable") === channel ? u : null; }
  /** The line under Settings › Beta updates. */
  function betaSwitchText(channel, version) {
    if (channel === "beta") return "Pre-releases too: new features first, less tested.";
    return String(version).indexOf("-") > 0 ? "Stable only. Your beta stays until a newer stable release is out." : "Stable releases only.";
  }
  /** On stable with a beta installed that is newer than the latest stable release: the one line saying it stays; else null. */
  function keptBetaText(channel, latest, version) {
    if (channel !== "stable" || !latest || String(version).indexOf("-") < 0 || cmpVersions(latest, version) >= 0) return null;
    return "You have a beta, newer than the latest stable release (" + latest + "): it stays until a newer stable release is out.";
  }
  /**
   * A release-notes line (Markdown) as plain text pieces: { heading, parts: [{ text, bold?, code? }] }. Only
   * **bold**, `code`, [links](url) (their text) and a leading "#" heading are understood; any other mark is
   * dropped or left as text. The panel puts each piece in as text, so nothing in the notes becomes HTML.
   */
  function noteView(line) {
    var s = String(line || "").replace(/^\s*(?:[-*+]\s+)/, "");
    var heading = /^#{1,6}\s+/.test(s);
    if (heading) s = s.replace(/^#{1,6}\s+/, "");
    var parts = [], re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\([^)]*\)/g, at = 0, m;
    function plain(t) {
      t = t.replace(/\*\*|__/g, "").replace(/(^|[\s(])[*_]([^*_\s][^*_]*)[*_](?=[\s.,;:!?)]|$)/g, "$1$2"); // stray or *italic* marks
      if (t) parts.push({ text: t });
    }
    while ((m = re.exec(s))) {
      plain(s.slice(at, m.index));
      if (m[1] !== undefined) parts.push({ text: m[1], bold: true });
      else if (m[2] !== undefined) parts.push({ text: m[2], code: true });
      else parts.push({ text: m[3] });
      at = re.lastIndex;
    }
    plain(s.slice(at));
    return { heading: heading, parts: parts };
  }
  /** The toast after switching. */
  function channelToast(channel) {
    return channel === "beta" ? "Beta updates on: Surehand offers pre-releases too." : "Beta updates off: stable releases only.";
  }
  /** "After Effects 2026" from "26.5". */
  function aeLabel(v) {
    var major = parseInt(v, 10);
    return major >= 17 ? "After Effects " + (2000 + major) : "After Effects" + (v ? " " + v : "");
  }

  var api = {
    layoutFor: layoutFor, MODES: MODES, connectedApps: connectedApps, appsText: appsText, connectedClientsText: connectedClientsText, modeOf: modeOf, clientName: clientName, lastClient: lastClient, statusFor: statusFor,
    toolName: toolName, describeEntry: describeEntry, statusOf: statusOf, changeParts: changeParts, refusal: refusal, readableError: readableError, workingView: workingView, writeAccessCheck: writeAccessCheck, writeAccessWhere: writeAccessWhere, entryDetails: entryDetails, feedItems: feedItems, entryKey: entryKey, canUndo: canUndo,
    renderIdOf: renderIdOf, renderStartInfo: renderStartInfo, renderProgress: renderProgress, timeLeft: timeLeft,
    riskChips: riskChips, approvalView: approvalView, countdown: countdown, countdownView: countdownView, previewView: previewView,
    hhmm: hhmm, dayLabel: dayLabel, whenLabel: whenLabel, parseCliJson: parseCliJson, cmpVersions: cmpVersions, aeLabel: aeLabel,
    updateChannel: updateChannel, updateFor: updateFor, betaSwitchText: betaSwitchText, keptBetaText: keptBetaText, channelToast: channelToast, noteView: noteView,
  };
  global.SurehandUI = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);
