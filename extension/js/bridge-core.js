/* Surehand MCP bridge: a tiny HTTP server inside After Effects (CEP + Node) that evaluates
 * ExtendScript sent by the MCP server. Binds to 127.0.0.1 only and requires the shared token
 * from the config file (~/.surehand/ae/config.json, or ~/.aemcp/config.json on a 1.3 install
 * that has not been migrated: see paths.js, which must be loaded first).
 *
 * Several After Effects instances (e.g. 2025 and 2026) can run at once: each bridge takes the
 * first free port from bridgePort upwards and registers itself in the instances folder next to
 * the config, so the server can list them and pick one.
 *
 * The bridge is the single source of truth for approvals ("ask" mode) and for "Pause AI":
 * - pending approvals live here; the panel and the approval pop-up only show them and answer
 *   through /approve, which accepts the first answer and refuses any later one;
 * - the panel and the pop-up poll /pending?ui=panel|popup, which doubles as a heartbeat: when a
 *   request waits and neither is showing, the bridge opens the pop-up (com.aemcp.approval);
 * - while paused, every call from the AI is refused at once (nothing runs); the panel's own calls
 *   (marked fromPanel) still run.
 *
 * Who may do what. The token in config.json lets a program talk to the bridge (the MCP server, i.e.
 * the AI app, has it). Answering approvals, pausing / resuming and running the panel's own jobs
 * (fromPanel) also need the panel secret: random, made at start, kept only in this bridge's memory and
 * handed out only through a CEP event (com.surehand.ae.hello -> com.surehand.ae.welcome), which only
 * code running inside this After Effects' extensions can send or receive. So an AI app can't approve
 * its own requests or get past a pause, even though it has the token.
 *
 * config.json is written atomically (temporary file + rename) and never regenerated when it is there
 * but can't be read: the last good copy is used meanwhile, and without one nothing is accepted. */
(function (global) {
  "use strict";
  var nodeRequire = typeof require !== "undefined" ? require : global.cep_node && global.cep_node.require;
  var http = nodeRequire("http");
  var fs = nodeRequire("fs");
  var os = nodeRequire("os");
  var path = nodeRequire("path");
  var crypto = nodeRequire("crypto");
  var querystring = nodeRequire("querystring");

  var VERSION = "__AEMCP_VERSION__"; // replaced with the release version at build time
  var PANEL_ID = "com.aemcp.panel";
  var BRIDGE_ID = "com.aemcp.bridge";
  var POPUP_ID = "com.aemcp.approval";
  var PORT_RANGE = 10;
  var APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
  // the panel / pop-up poll every 1.5s: without a poll for this long it is closed (or frozen)
  var UI_STALE_MS = 4000;
  // a pop-up that was asked to open gets this long to load and report in
  var POPUP_GRACE_MS = 6000;
  var PAUSED_MESSAGE = "Paused in the Surehand panel: nothing was run. Ask the user to resume.";
  // how much of an approval's text the panel and the pop-up show (the rest is counted, and checked for risks)
  var SUMMARY_MAX = 5000;
  // an answer is accepted only for the oldest request, once a person could have seen it for this long
  var MIN_SHOWN_MS = 1000;
  var HELLO_EVENT = "com.surehand.ae.hello";
  var WELCOME_EVENT = "com.surehand.ae.welcome";

  function paths() { return global.SurehandPaths.current(nodeRequire); }

  // ---------- config.json ----------
  /** Writes a file atomically (temporary file next to it, then rename), readable only by the user. */
  function writeFileAtomic(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    var tmp = path.join(path.dirname(file), "." + path.basename(file) + "." + process.pid + "." + Date.now().toString(36) + ".tmp");
    fs.writeFileSync(tmp, text, { mode: 384 }); // 0600: the token is a secret
    try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch (x) {} throw e; }
    if (process.platform !== "win32") { try { fs.chmodSync(file, 384); } catch (e) {} }
  }
  /** { cfg } | { missing } | { error } (a BOM is ignored). */
  function readConfigFile(file) {
    var raw;
    try { raw = fs.readFileSync(file, "utf8"); } catch (e) { return e.code === "ENOENT" ? { missing: true } : { error: e.code || e.message }; }
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    try {
      var cfg = JSON.parse(raw);
      return cfg && typeof cfg === "object" && !(cfg instanceof Array) ? { cfg: cfg } : { error: "not a JSON object" };
    } catch (e) { return { error: raw.trim() ? "not valid JSON" : "empty" }; }
  }
  var lastGood = {}; // per file: the last config that parsed
  var configProblem = null;

  /**
   * The config, read on every call. A missing file is created (token, ports). One that is there but
   * can't be read (another process writing it right now, a half-saved edit) is never replaced: it is
   * read again a few times, then the last good copy is used; without one, the result has no token
   * (so nothing is accepted) and `unreadable` says why.
   */
  function loadConfig() {
    var file = paths().config, r = null;
    for (var i = 0; i < 3; i++) {
      r = readConfigFile(file);
      if (r.cfg || r.missing) break;
    }
    if (r.cfg) {
      configProblem = null;
      var cfg = r.cfg, changed = false;
      if (!cfg.token) { cfg.token = crypto.randomBytes(24).toString("hex"); changed = true; }
      if (!cfg.bridgePort) { cfg.bridgePort = 8765; changed = true; }
      if (!cfg.httpPort) { cfg.httpPort = 8766; changed = true; }
      if (changed) { try { writeFileAtomic(file, JSON.stringify(cfg, null, 2) + "\n"); } catch (e) {} }
      lastGood[file] = cfg;
      return cfg;
    }
    if (r.missing && !lastGood[file]) {
      configProblem = null;
      var fresh = { token: crypto.randomBytes(24).toString("hex"), bridgePort: 8765, httpPort: 8766 };
      try { writeFileAtomic(file, JSON.stringify(fresh, null, 2) + "\n"); } catch (e) {}
      lastGood[file] = fresh;
      return fresh;
    }
    configProblem = r.missing ? "it was removed" : r.error;
    if (lastGood[file]) return lastGood[file];
    return { unreadable: file + ": " + configProblem, bridgePort: 8765, httpPort: 8766 };
  }
  /**
   * Changes the config (read again just before, written atomically). Refuses (returns false) while
   * the file can't be read: writing would replace what is in it.
   */
  function updateConfig(change) {
    var file = paths().config, r = readConfigFile(file);
    if (r.error) { r = readConfigFile(file); }
    if (r.error) return false;
    var cfg = r.cfg || {};
    change(cfg);
    try { writeFileAtomic(file, JSON.stringify(cfg, null, 2) + "\n"); lastGood[file] = cfg; return true; } catch (e) { return false; }
  }

  function permissionMode() {
    var cfg = loadConfig();
    if (cfg.unreadable) return "unreadable";
    var p = cfg.permissions;
    return (p && p.mode) || "full";
  }

  function hostInfo() {
    try {
      var env = JSON.parse(global.__adobe_cep__.getHostEnvironment());
      return { appName: env.appName, appVersion: env.appVersion };
    } catch (e) { return {}; }
  }

  function evalScript(script, cb) {
    global.__adobe_cep__.evalScript(script, function (r) { cb(r); });
  }

  var state = {
    started: false, listening: false, error: null, port: null, busy: false, queue: [], log: [], startedAt: null,
    current: null, // { startedAt, label } of the script being evaluated
    pending: [], // edits waiting for approval in "ask" mode
    lastActivated: null,
    pause: null, // { key, since, refused } while paused
    // "Allow Scripts to Write Files and Access Network", as read before the last job (null: not known yet)
    writeAccess: null,
    // the pause set in this After Effects' panel (kept here, so editing config.json can't undo it)
    heldPause: null,
    panelSecret: null, // see the top of this file
    // heartbeats of the panel / pop-up, when the bridge asked for the pop-up, which requests were shown
    ui: { panel: null, popup: null, requestedAt: 0, fellBackFor: 0, presented: {} },
  };

  // ---------- pause ----------
  /**
   * Is the AI paused? Paused by this After Effects' panel (held in memory until resumed there), or by
   * "paused": true in the config (another After Effects' panel, or a pause from before a restart),
   * which is then held here as well. Counts refusals per pause.
   */
  function isPaused() {
    var cfg = loadConfig();
    if (cfg.paused && !state.heldPause) state.heldPause = { since: cfg.pausedAt || new Date().toISOString() };
    if (!state.heldPause) { state.pause = null; return false; }
    var key = String(state.heldPause.since);
    if (!state.pause || state.pause.key !== key) state.pause = { key: key, since: state.heldPause.since, refused: 0 };
    return true;
  }
  function pauseInfo() { return isPaused() ? { since: state.pause.since, refused: state.pause.refused } : null; }
  function refusePaused(label) {
    if (state.pause) state.pause.refused++;
    addLog({ at: new Date().toISOString(), ms: 0, ok: false, paused: true, label: label || null, preview: "refused: paused in the Surehand panel" });
    return { ok: false, paused: true, error: PAUSED_MESSAGE };
  }
  /** Pause / resume from the panel; also saved in the config (other After Effects windows, restarts). */
  function setPaused(on) {
    var at = new Date().toISOString();
    state.heldPause = on ? { since: at } : null;
    var saved = updateConfig(function (cfg) {
      if (on) { cfg.paused = true; cfg.pausedAt = at; }
      else { delete cfg.paused; delete cfg.pausedAt; }
    });
    return { ok: true, paused: pauseInfo(), saved: saved };
  }

  // ---------- approval pop-up ----------
  /**
   * Pure decision: should the bridge open the approval pop-up now? `s`: { now, pending: [ids],
   * presented: {id: true}, panel / popup: { at, visible } (last poll), requestedAt (last open request),
   * fellBackFor (the requestedAt for which the panel was opened instead) }.
   * Returns { open, openPanel, present } (present: mark the pending ids as shown to the user).
   */
  function popupDecision(s) {
    var none = { open: false, openPanel: false, present: false };
    var ids = s.pending || [];
    if (!ids.length) return none;
    var panelShowing = !!(s.panel && s.now - s.panel.at < UI_STALE_MS && s.panel.visible !== false);
    var popupShowing = !!(s.popup && s.now - s.popup.at < UI_STALE_MS);
    if (panelShowing || popupShowing) return { open: false, openPanel: false, present: true };
    if (s.requestedAt && s.now - s.requestedAt < POPUP_GRACE_MS) return none; // still opening
    // asked for the pop-up, but it never reported in (not supported here?): open the panel instead, once
    if (s.requestedAt && s.fellBackFor !== s.requestedAt && (!s.popup || s.popup.at < s.requestedAt)) return { open: false, openPanel: true, present: true };
    var fresh = ids.filter(function (id) { return !(s.presented && s.presented[id]); }).length;
    return { open: fresh > 0, openPanel: false, present: fresh > 0 };
  }

  function checkPopup() {
    var ui = state.ui, now = Date.now();
    var ids = state.pending.map(function (p) { return p.id; });
    var d = popupDecision({ now: now, pending: ids, presented: ui.presented, panel: ui.panel, popup: ui.popup, requestedAt: ui.requestedAt, fellBackFor: ui.fellBackFor });
    if (d.present) ids.forEach(function (id) { ui.presented[id] = true; });
    if (d.openPanel) { ui.fellBackFor = ui.requestedAt; openExtension(PANEL_ID); }
    if (d.open) { ui.requestedAt = now; openExtension(POPUP_ID); }
    // forget answered requests
    Object.keys(ui.presented).forEach(function (id) { if (ids.indexOf(id) < 0) delete ui.presented[id]; });
    return d;
  }

  function addLog(entry) {
    state.log.unshift(entry);
    if (state.log.length > 50) state.log.length = 50;
  }

  function instanceFile() { return path.join(paths().instances, String(state.port) + ".json"); }

  function writeStatus() {
    var info = {
      listening: state.listening, port: state.port, error: state.error, pid: process.pid, host: hostInfo(), version: VERSION,
      startedAt: state.startedAt, lastActivated: state.lastActivated, at: new Date().toISOString(),
    };
    var p = paths();
    try { fs.mkdirSync(p.dir, { recursive: true }); fs.writeFileSync(p.bridgeStatus, JSON.stringify(info, null, 2)); } catch (e) {}
    if (state.listening) {
      try { fs.mkdirSync(p.instances, { recursive: true }); fs.writeFileSync(instanceFile(), JSON.stringify(info, null, 2)); } catch (e) {}
    }
  }

  /** Answers a hello: the panel secret and where this bridge listens, as a CEP event (stays inside After Effects). */
  function welcome() {
    if (!state.listening) return;
    var host = {};
    try { host = JSON.parse(global.__adobe_cep__.getHostEnvironment()); } catch (e) {}
    try {
      global.__adobe_cep__.dispatchEvent({
        // After Effects drops a CEP event whose extensionId is empty: send the bridge's own id
        type: WELCOME_EVENT, scope: "APPLICATION", appId: host.appId || "AEFT", extensionId: BRIDGE_ID,
        data: JSON.stringify({ port: state.port, secret: state.panelSecret, pid: process.pid, version: VERSION }),
      });
    } catch (e) {}
  }

  /** Stops this bridge (the panel's own fallback bridge steps aside when the real one is running). */
  function stop() {
    unregister();
    try { if (state.server) state.server.close(); } catch (e) {}
    state.server = null; state.listening = false; state.started = false;
  }

  function unregister() {
    try { if (state.listening) fs.unlinkSync(instanceFile()); } catch (e) {}
  }

  // CEP accepts scripts even while a dialog (Project Settings, a render...) blocks ExtendScript,
  // and After Effects runs them whenever it is free again: possibly long after the AI gave up.
  // So each job first sends this no-op, and the job itself is only sent once it has come back
  // (AE is free right now) and only if the job is still wanted.
  // It also reads "Allow Scripts to Write Files and Access Network" (1 = on), so the bridge knows it
  // at no extra cost: never a script of its own, never on a timer (a dialog would make AE complain).
  var READY_SCRIPT = "(function(){try{return 'aemcp-ready:'+app.preferences.getPrefAsLong('Main Pref Section','Pref_SCRIPTING_FILE_NETWORK_SECURITY');}" +
    "catch(e){return 'aemcp-ready:?';}})()";
  /** The setting from the no-op's answer: true / false, or unchanged when it can't be told. */
  function noteWriteAccess(r) {
    var m = /^aemcp-ready:(\d+)$/.exec(String(r));
    if (m && (m[1] === "0" || m[1] === "1")) state.writeAccess = m[1] === "1";
  }

  // the client gave up on it (timeout or cancel), or its deadline has passed
  function dead(job) { return job.cancelled || Date.now() >= job.deadline; }

  function skip(job) {
    addLog({ at: new Date().toISOString(), ms: 0, ok: false, skipped: true, size: job.script.length, label: job.label, preview: "not run: the AI gave up before After Effects was free" });
  }

  // ExtendScript is single threaded: run one script at a time.
  function pump() {
    if (state.busy || !state.queue.length) return;
    var job = state.queue.shift();
    if (dead(job)) { skip(job); return pump(); }
    // paused while it waited in the queue: it hasn't started, so it never will
    if (!job.fromPanel && isPaused()) { job.fail(200, refusePaused(job.label)); return pump(); }
    state.busy = true;
    // waiting: the no-op has not come back yet, so After Effects isn't taking scripts right now
    state.current = { startedAt: Date.now(), label: job.label, waiting: true };
    evalScript(READY_SCRIPT, function (ready) {
      noteWriteAccess(ready);
      if (dead(job)) {
        state.busy = false;
        state.current = null;
        skip(job);
        return pump();
      }
      if (!job.fromPanel && isPaused()) {
        state.busy = false;
        state.current = null;
        job.fail(200, refusePaused(job.label));
        return pump();
      }
      state.current.waiting = false;
      job.started = true;
      var t0 = Date.now();
      evalScript(job.script, function (result) {
        state.busy = false;
        state.current = null;
        var ms = Date.now() - t0;
        var ok = result !== "EvalScript error." && result.indexOf('{"ok":false') !== 0;
        // a script AE has started can't be interrupted: say so if the client had given up meanwhile
        var late = !!job.cancelled;
        var preview = (late ? "ran after the AI gave up: " : "") + String(result).slice(0, 160);
        addLog({ at: new Date().toISOString(), ms: ms, ok: ok, late: late || undefined, size: job.script.length, label: job.label, preview: preview });
        job.done(result);
        pump();
      });
    });
  }

  function send(res, status, obj) {
    if (res.headersSent) return;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  }

  function same(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch (e) { return false; }
  }
  function authorized(req, token) {
    return same(String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""), String(token || ""));
  }
  /** The request comes from the panel or the pop-up of this After Effects (it knows the panel secret). */
  function fromUI(req) {
    return same(String(req.headers["x-surehand-panel"] || ""), state.panelSecret);
  }
  var UI_ONLY = "Only the Surehand panel or pop-up in After Effects can do this.";

  function readBody(req, cb) {
    var chunks = [];
    req.on("data", function (c) { chunks.push(c); });
    req.on("end", function () {
      try { cb(null, JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { cb(e); }
    });
  }

  function openExtension(id) {
    try { global.__adobe_cep__.requestOpenExtension(id, ""); } catch (e) {}
  }

  function health(req, token) {
    var cur = state.current;
    return {
      ok: true, name: "aemcp-bridge", version: VERSION, host: hostInfo(), port: state.port, pid: process.pid,
      busy: state.busy, busyForMs: cur ? Date.now() - cur.startedAt : 0, busyWith: cur ? cur.label || null : null,
      // AE has not accepted the no-op sent before the current job: a dialog is open, or AE is busy/starting
      waitingForAE: !!(cur && cur.waiting), waitingForMs: cur && cur.waiting ? Date.now() - cur.startedAt : 0,
      queue: state.queue.length, pendingApprovals: state.pending.length, permissionMode: permissionMode(),
      paused: pauseInfo(), configProblem: configProblem, scriptsCanWriteFiles: state.writeAccess,
      startedAt: state.startedAt, lastActivated: state.lastActivated, authorized: authorized(req, token),
    };
  }

  function handleEval(req, res, body) {
    if (!body || typeof body.script !== "string") return send(res, 400, { ok: false, error: "missing script" });
    // the panel's own jobs run also while paused: only the panel (or a command it started) may say so
    if (body.fromPanel && !fromUI(req)) return send(res, 403, { ok: false, error: UI_ONLY });
    // paused in the panel: refuse at once, so the AI stops instead of waiting (the panel's own calls still run)
    if (!body.fromPanel && isPaused()) return send(res, 200, refusePaused(body.label || (body.approval && body.approval.tool)));
    var finished = false;
    var timer = null;
    var watch = null;
    // answer the client once. From then on the job is unwanted: if it hasn't started it never will,
    // and if it is running its log entry says it finished after the AI gave up.
    function finish(status, obj) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(watch);
      job.cancelled = true;
      send(res, status, obj);
    }
    var job = {
      script: body.script,
      label: body.label || null,
      fromPanel: !!body.fromPanel,
      // which After Effects ran it (the panel offers Undo only there)
      done: function (result) { finish(200, { ok: true, result: result, instance: { port: state.port, pid: process.pid } }); },
      fail: function (status, obj) { finish(status, obj); },
    };
    var timeoutMs = Math.max(1000, Math.min(Number(body.timeoutMs) || 120000, 24 * 3600 * 1000));
    // optional (sent by newer servers): give up early if After Effects hasn't accepted any script for
    // this long, i.e. it is blocked by a dialog. Never applies to a script that has started.
    var startTimeoutMs = Number(body.startTimeoutMs) > 0 ? Math.max(500, Number(body.startTimeoutMs)) : 0;
    function checkBlocked() {
      if (finished || job.started) return clearInterval(watch);
      var cur = state.current;
      if (!cur || !cur.waiting) return; // idle, or queued behind a script that is running: keep waiting
      var waited = Date.now() - cur.startedAt;
      if (waited < startTimeoutMs) return;
      finish(503, {
        ok: false, blocked: true, waitingForMs: waited, waitingFor: cur.label || null,
        queue: state.queue.filter(function (j) { return j !== job && !j.cancelled; }).length, startedAt: state.startedAt,
        error: "After Effects is busy or showing a dialog: it has not accepted a script for " + Math.round(waited / 1000) + "s. " +
          "Close any open dialog in After Effects and retry. The script did not run and will not run later.",
      });
    }
    function enqueue() {
      job.deadline = Date.now() + timeoutMs; // never start it after this
      timer = setTimeout(function () {
        finish(504, {
          ok: false,
          error: "Timed out after " + Math.round(timeoutMs / 1000) + "s waiting for After Effects (it may be busy, rendering, or showing a dialog). " +
            (job.started
              ? "The script had already started: it can't be interrupted and will finish on its own."
              : "The script did not run and will not run later."),
        });
      }, timeoutMs);
      state.queue.push(job);
      pump();
      if (startTimeoutMs && !finished) {
        watch = setInterval(checkBlocked, Math.min(250, startTimeoutMs));
        checkBlocked();
      }
    }
    // client went away (or the AI app cancelled the request) before we answered: don't run it if still queued
    res.on("close", function () { if (!finished) { finished = true; job.cancelled = true; clearTimeout(timer); clearInterval(watch); dropPending(job); } });

    var mode = permissionMode();
    if (body.approval && mode === "unreadable") {
      // fail closed: without readable settings, edits that would need an OK don't run
      return send(res, 200, { ok: false, denied: true, error: "Surehand's settings file can't be read (" + configProblem + "), so changes aren't run. Ask the user to check it." });
    }
    if (body.approval && mode === "ask") {
      // hold the edit until the user allows or denies it in the Surehand MCP panel
      var now = Date.now();
      var tool = String(body.approval.tool || "edit").slice(0, 120);
      var text = String(body.approval.summary || "");
      var p = {
        id: crypto.randomBytes(6).toString("hex"), at: new Date(now).toISOString(), deadline: new Date(now + APPROVAL_TIMEOUT_MS).toISOString(),
        tool: tool, summary: shorten(text),
        // risks are found in all of it (the whole script / file), not only the part that is shown
        chips: risks(String(body.approval.full || text), tool),
        client: body.approval.client ? String(body.approval.client).slice(0, 80) : undefined, job: job, answered: false, shownAt: 0,
      };
      // the one place an approval is answered: the first answer wins, any later one is refused (returns false)
      p.resolve = function (allow, by) {
        if (p.answered) return false;
        p.answered = true;
        state.pending = state.pending.filter(function (x) { return x !== p; });
        if (finished) return true;
        if (!allow) {
          addLog({ at: new Date().toISOString(), ms: 0, ok: false, label: p.tool, preview: "denied in the Surehand panel" + (by === "popup" ? " (pop-up)" : "") });
          return finish(200, { ok: false, denied: true, error: "The user denied this change in After Effects (Surehand MCP panel)." }), true;
        }
        if (isPaused()) return finish(200, refusePaused(p.tool)), true;
        enqueue();
        return true;
      };
      state.pending.push(p);
      checkPopup();
      // waiting for a person: allow up to 10 minutes before giving up
      setTimeout(function () {
        if (finished || p.answered) return;
        p.answered = true;
        state.pending = state.pending.filter(function (x) { return x !== p; });
        finish(200, { ok: false, denied: true, error: "No one approved this change in the Surehand MCP panel within 10 minutes." });
      }, APPROVAL_TIMEOUT_MS);
      return;
    }
    enqueue();
  }

  /** At most SUMMARY_MAX characters, saying how many more there are. */
  function shorten(text) {
    return text.length > SUMMARY_MAX ? text.slice(0, SUMMARY_MAX) + "\n\u2026 " + (text.length - SUMMARY_MAX) + " more characters not shown" : text;
  }
  function risks(text, tool) {
    try { return global.SurehandUI ? global.SurehandUI.riskChips(text, tool) : []; } catch (e) { return []; }
  }

  /**
   * An answer from the panel or the pop-up: accepted only for the request it names, only if that is
   * the oldest one waiting (the one shown), and only once a person could have seen it for a moment.
   */
  function answerApproval(b) {
    var p = state.pending.filter(function (x) { return x.id === b.id; })[0];
    if (!p) return { status: 404, body: { ok: false, answered: true, error: "no such request (already answered or cancelled)" } };
    if (state.pending[0] !== p) return { status: 409, body: { ok: false, error: "not the request being shown (an older one waits)" } };
    if (!p.shownAt || Date.now() - p.shownAt < MIN_SHOWN_MS) return { status: 409, body: { ok: false, tooSoon: true, error: "answered before it could be read" } };
    if (!p.resolve(!!b.allow, b.by)) return { status: 404, body: { ok: false, answered: true, error: "no such request (already answered or cancelled)" } };
    return { status: 200, body: { ok: true } };
  }

  function dropPending(job) {
    state.pending = state.pending.filter(function (x) { return x.job !== job; });
  }

  function start() {
    if (state.started) return state;
    state.started = true;
    state.panelSecret = crypto.randomBytes(32).toString("hex");
    var cfg = loadConfig();
    var base = cfg.bridgePort;
    var server = http.createServer(function (req, res) {
      // Reject browser-originated requests (DNS-rebinding / CSRF protection)
      if (req.headers.origin) return send(res, 403, { ok: false, error: "forbidden" });
      var cfgNow = loadConfig(), token = cfgNow.token;
      var q = String(req.url || "").indexOf("?");
      var route = q < 0 ? req.url : req.url.slice(0, q), u = { query: q < 0 ? {} : querystring.parse(req.url.slice(q + 1)) };
      if (req.method === "GET" && route === "/health") return send(res, 200, health(req, token));
      if (!cfgNow.token) return send(res, 503, { ok: false, error: "Surehand's settings file can't be read (" + (configProblem || "unknown") + "): nothing is accepted until it is fixed." });
      if (!authorized(req, token)) return send(res, 401, { ok: false, error: "unauthorized" });
      if (req.method === "GET" && route === "/log") return send(res, 200, { ok: true, log: state.log });
      if (req.method === "GET" && route === "/pending") {
        // the panel and the pop-up poll this: it is also their heartbeat
        var who = u.query.ui, ui = fromUI(req);
        if (who === "panel" || who === "popup") state.ui[who] = { at: Date.now(), visible: u.query.visible !== "0" };
        // the request the panel / pop-up shows right now: from then on it may be answered (after MIN_SHOWN_MS)
        if (ui && u.query.showing) state.pending.forEach(function (p) { if (p.id === u.query.showing && !p.shownAt) p.shownAt = Date.now(); });
        if (who) checkPopup();
        return send(res, 200, {
          ok: true, paused: pauseInfo(), configProblem: configProblem,
          pending: state.pending.map(function (p) { return { id: p.id, at: p.at, deadline: p.deadline, tool: p.tool, summary: p.summary, chips: p.chips, client: p.client }; }),
        });
      }
      if (req.method === "POST" && route === "/approve") {
        // the AI app has the token: it must not be able to answer its own requests
        if (!fromUI(req)) return send(res, 403, { ok: false, error: UI_ONLY });
        return readBody(req, function (err, b) {
          if (err) return send(res, 400, { ok: false, error: "invalid JSON" });
          var a = answerApproval(b || {});
          send(res, a.status, a.body);
        });
      }
      if (req.method === "POST" && route === "/pause") {
        if (!fromUI(req)) return send(res, 403, { ok: false, error: UI_ONLY });
        return readBody(req, function (err, b) {
          if (err) return send(res, 400, { ok: false, error: "invalid JSON" });
          send(res, 200, setPaused(!!(b && b.paused)));
        });
      }
      if (req.method === "POST" && route === "/eval") {
        return readBody(req, function (err, b) {
          if (err) return send(res, 400, { ok: false, error: "invalid JSON" });
          handleEval(req, res, b);
        });
      }
      send(res, 404, { ok: false, error: "not found" });
    });

    var attempt = 0;
    server.on("error", function (e) {
      if (e.code === "EADDRINUSE" && attempt < PORT_RANGE - 1) {
        attempt++;
        // never take the port reserved for the MCP server's HTTP mode (ChatGPT)
        if (base + attempt === Number(cfg.httpPort)) attempt++;
        state.port = base + attempt;
        return server.listen(state.port, "127.0.0.1");
      }
      state.listening = false;
      state.error = e.code === "EADDRINUSE" ? "Ports " + base + "-" + (base + PORT_RANGE - 1) + " are all in use" : String(e.message || e);
      writeStatus();
    });
    server.on("listening", function () {
      state.listening = true;
      state.error = null;
      state.startedAt = new Date().toISOString();
      state.lastActivated = state.startedAt;
      writeStatus();
    });
    state.port = base;
    server.listen(state.port, "127.0.0.1");
    state.server = server;

    // remember when this After Effects window was last brought to the front: with several
    // instances open, the server uses the one you used most recently
    try {
      global.__adobe_cep__.addEventListener("com.adobe.csxs.events.ApplicationActivate", function () {
        state.lastActivated = new Date().toISOString();
        writeStatus();
      });
    } catch (e) {}
    // the panel secret, for the panel and the pop-up of this After Effects only (see the top)
    try { global.__adobe_cep__.addEventListener(HELLO_EVENT, function () { welcome(); }); } catch (e) {}
    setInterval(writeStatus, 60 * 1000); // heartbeat
    // a panel closed while a request waits: show the pop-up
    setInterval(function () { if (state.pending.length) checkPopup(); }, 1000);
    try { global.addEventListener("unload", unregister); } catch (e) {}
    try { process.on("exit", unregister); } catch (e) {}
    return state;
  }

  var api = {
    start: start, state: state, loadConfig: loadConfig, hostInfo: hostInfo, permissionMode: permissionMode, paths: paths,
    stop: stop, popupDecision: popupDecision, checkPopup: checkPopup, isPaused: isPaused, setPaused: setPaused, updateConfig: updateConfig, welcome: welcome,
    VERSION: VERSION, PAUSED_MESSAGE: PAUSED_MESSAGE, PANEL_ID: PANEL_ID, POPUP_ID: POPUP_ID, SUMMARY_MAX: SUMMARY_MAX, MIN_SHOWN_MS: MIN_SHOWN_MS,
    HELLO_EVENT: HELLO_EVENT, WELCOME_EVENT: WELCOME_EVENT,
  };
  // where the files are right now (an update may migrate ~/.aemcp to ~/.surehand/ae while AE runs)
  Object.defineProperty(api, "CONFIG_FILE", { enumerable: true, get: function () { return paths().config; } });
  Object.defineProperty(api, "CONFIG_DIR", { enumerable: true, get: function () { return paths().dir; } });
  global.AEMCPBridge = api;
})(window);
