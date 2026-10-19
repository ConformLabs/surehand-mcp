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
 * - while the config says "paused": true, every call from the AI is refused at once (nothing
 *   runs); the panel's own calls (marked fromPanel) still run. */
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
  var POPUP_ID = "com.aemcp.approval";
  var PORT_RANGE = 10;
  var APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
  // the panel / pop-up poll every 1.5s: without a poll for this long it is closed (or frozen)
  var UI_STALE_MS = 4000;
  // a pop-up that was asked to open gets this long to load and report in
  var POPUP_GRACE_MS = 6000;
  var PAUSED_MESSAGE = "Paused in the Surehand panel: nothing was run. Ask the user to resume.";

  function paths() { return global.SurehandPaths.current(nodeRequire); }

  function loadConfig() {
    var file = paths().config;
    var cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}
    var changed = false;
    if (!cfg.token) { cfg.token = crypto.randomBytes(24).toString("hex"); changed = true; }
    if (!cfg.bridgePort) { cfg.bridgePort = 8765; changed = true; }
    if (!cfg.httpPort) { cfg.httpPort = 8766; changed = true; }
    if (changed) {
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(cfg, null, 2)); } catch (e) {}
    }
    return cfg;
  }

  function permissionMode() {
    var p = loadConfig().permissions;
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
    pause: null, // { key, refused } while the config says paused
    // heartbeats of the panel / pop-up, when the bridge asked for the pop-up, which requests were shown
    ui: { panel: null, popup: null, requestedAt: 0, fellBackFor: 0, presented: {} },
  };

  // ---------- pause ----------
  /** Is the AI paused (config "paused": true)? Counts refusals per pause (pausedAt). */
  function isPaused() {
    var cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(paths().config, "utf8")); } catch (e) {}
    if (!cfg.paused) { state.pause = null; return false; }
    var key = String(cfg.pausedAt || "on");
    if (!state.pause || state.pause.key !== key) state.pause = { key: key, since: cfg.pausedAt || null, refused: 0 };
    return true;
  }
  function pauseInfo() { return isPaused() ? { since: state.pause.since, refused: state.pause.refused } : null; }
  function refusePaused(label) {
    if (state.pause) state.pause.refused++;
    addLog({ at: new Date().toISOString(), ms: 0, ok: false, paused: true, label: label || null, preview: "refused: paused in the Surehand panel" });
    return { ok: false, paused: true, error: PAUSED_MESSAGE };
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

  function unregister() {
    try { if (state.listening) fs.unlinkSync(instanceFile()); } catch (e) {}
  }

  // CEP accepts scripts even while a dialog (Project Settings, a render...) blocks ExtendScript,
  // and After Effects runs them whenever it is free again: possibly long after the AI gave up.
  // So each job first sends this no-op, and the job itself is only sent once it has come back
  // (AE is free right now) and only if the job is still wanted.
  var READY_SCRIPT = "'aemcp-ready'";

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
    evalScript(READY_SCRIPT, function () {
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

  function authorized(req, token) {
    var h = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!h || h.length !== token.length) return false;
    try { return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(token)); } catch (e) { return false; }
  }

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
      paused: pauseInfo(),
      startedAt: state.startedAt, lastActivated: state.lastActivated, authorized: authorized(req, token),
    };
  }

  function handleEval(req, res, body) {
    if (!body || typeof body.script !== "string") return send(res, 400, { ok: false, error: "missing script" });
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
      done: function (result) { finish(200, { ok: true, result: result }); },
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

    if (body.approval && permissionMode() === "ask") {
      // hold the edit until the user allows or denies it in the Surehand MCP panel
      var now = Date.now();
      var p = {
        id: crypto.randomBytes(6).toString("hex"), at: new Date(now).toISOString(), deadline: new Date(now + APPROVAL_TIMEOUT_MS).toISOString(),
        tool: body.approval.tool || "edit", summary: String(body.approval.summary || "").slice(0, 4000),
        client: body.approval.client ? String(body.approval.client).slice(0, 80) : undefined, job: job, answered: false,
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

  function dropPending(job) {
    state.pending = state.pending.filter(function (x) { return x.job !== job; });
  }

  function start() {
    if (state.started) return state;
    state.started = true;
    var cfg = loadConfig();
    var base = cfg.bridgePort;
    var server = http.createServer(function (req, res) {
      // Reject browser-originated requests (DNS-rebinding / CSRF protection)
      if (req.headers.origin) return send(res, 403, { ok: false, error: "forbidden" });
      var token = loadConfig().token;
      var q = String(req.url || "").indexOf("?");
      var route = q < 0 ? req.url : req.url.slice(0, q), u = { query: q < 0 ? {} : querystring.parse(req.url.slice(q + 1)) };
      if (req.method === "GET" && route === "/health") return send(res, 200, health(req, token));
      if (!authorized(req, token)) return send(res, 401, { ok: false, error: "unauthorized" });
      if (req.method === "GET" && route === "/log") return send(res, 200, { ok: true, log: state.log });
      if (req.method === "GET" && route === "/pending") {
        // the panel and the pop-up poll this: it is also their heartbeat
        var who = u.query.ui;
        if (who === "panel" || who === "popup") state.ui[who] = { at: Date.now(), visible: u.query.visible !== "0" };
        if (who) checkPopup();
        return send(res, 200, {
          ok: true, paused: pauseInfo(),
          pending: state.pending.map(function (p) { return { id: p.id, at: p.at, deadline: p.deadline, tool: p.tool, summary: p.summary, client: p.client }; }),
        });
      }
      if (req.method === "POST" && route === "/approve") {
        return readBody(req, function (err, b) {
          if (err) return send(res, 400, { ok: false, error: "invalid JSON" });
          var p = state.pending.filter(function (x) { return x.id === b.id; })[0];
          if (!p || !p.resolve(!!b.allow, b.by)) return send(res, 404, { ok: false, answered: true, error: "no such request (already answered or cancelled)" });
          send(res, 200, { ok: true });
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
    setInterval(writeStatus, 60 * 1000); // heartbeat
    // a panel closed while a request waits: show the pop-up
    setInterval(function () { if (state.pending.length) checkPopup(); }, 1000);
    try { global.addEventListener("unload", unregister); } catch (e) {}
    try { process.on("exit", unregister); } catch (e) {}
    return state;
  }

  var api = {
    start: start, state: state, loadConfig: loadConfig, hostInfo: hostInfo, permissionMode: permissionMode, paths: paths,
    popupDecision: popupDecision, checkPopup: checkPopup, isPaused: isPaused,
    VERSION: VERSION, PAUSED_MESSAGE: PAUSED_MESSAGE, PANEL_ID: PANEL_ID, POPUP_ID: POPUP_ID,
  };
  // where the files are right now (an update may migrate ~/.aemcp to ~/.surehand/ae while AE runs)
  Object.defineProperty(api, "CONFIG_FILE", { enumerable: true, get: function () { return paths().config; } });
  Object.defineProperty(api, "CONFIG_DIR", { enumerable: true, get: function () { return paths().dir; } });
  global.AEMCPBridge = api;
})(window);
