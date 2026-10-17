/* AE MCP bridge: a tiny HTTP server inside After Effects (CEP + Node) that evaluates
 * ExtendScript sent by the ae-mcp server. Binds to 127.0.0.1 only and requires the
 * shared token from ~/.aemcp/config.json.
 *
 * Several After Effects instances (e.g. 2025 and 2026) can run at once: each bridge takes the
 * first free port from bridgePort upwards and registers itself in ~/.aemcp/instances/, so the
 * server can list them and pick one. */
(function (global) {
  "use strict";
  var nodeRequire = typeof require !== "undefined" ? require : global.cep_node && global.cep_node.require;
  var http = nodeRequire("http");
  var fs = nodeRequire("fs");
  var os = nodeRequire("os");
  var path = nodeRequire("path");
  var crypto = nodeRequire("crypto");

  var VERSION = "__AEMCP_VERSION__"; // replaced with the release version at build time
  var CONFIG_DIR = path.join(os.homedir(), ".aemcp");
  var CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
  var STATUS_FILE = path.join(CONFIG_DIR, "bridge-status.json");
  var INSTANCES_DIR = path.join(CONFIG_DIR, "instances");
  var PANEL_ID = "com.aemcp.panel";
  var PORT_RANGE = 10;

  function loadConfig() {
    var cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch (e) {}
    var changed = false;
    if (!cfg.token) { cfg.token = crypto.randomBytes(24).toString("hex"); changed = true; }
    if (!cfg.bridgePort) { cfg.bridgePort = 8765; changed = true; }
    if (!cfg.httpPort) { cfg.httpPort = 8766; changed = true; }
    if (changed) {
      try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch (e) {}
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
  };

  function addLog(entry) {
    state.log.unshift(entry);
    if (state.log.length > 50) state.log.length = 50;
  }

  function instanceFile() { return path.join(INSTANCES_DIR, String(state.port) + ".json"); }

  function writeStatus() {
    var info = {
      listening: state.listening, port: state.port, error: state.error, pid: process.pid, host: hostInfo(), version: VERSION,
      startedAt: state.startedAt, lastActivated: state.lastActivated, at: new Date().toISOString(),
    };
    try { fs.writeFileSync(STATUS_FILE, JSON.stringify(info, null, 2)); } catch (e) {}
    if (state.listening) {
      try { fs.mkdirSync(INSTANCES_DIR, { recursive: true }); fs.writeFileSync(instanceFile(), JSON.stringify(info, null, 2)); } catch (e) {}
    }
  }

  function unregister() {
    try { if (state.listening) fs.unlinkSync(instanceFile()); } catch (e) {}
  }

  // ExtendScript is single threaded: run one script at a time.
  function pump() {
    if (state.busy || !state.queue.length) return;
    var job = state.queue.shift();
    if (job.cancelled) return pump();
    state.busy = true;
    var t0 = Date.now();
    state.current = { startedAt: t0, label: job.label };
    evalScript(job.script, function (result) {
      state.busy = false;
      state.current = null;
      var ms = Date.now() - t0;
      var ok = result !== "EvalScript error." && result.indexOf('{"ok":false') !== 0;
      addLog({ at: new Date().toISOString(), ms: ms, ok: ok, size: job.script.length, label: job.label, preview: String(result).slice(0, 160) });
      job.done(result);
      pump();
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

  function openPanel() {
    try { global.__adobe_cep__.requestOpenExtension(PANEL_ID, ""); } catch (e) {}
  }

  function health(req, token) {
    var cur = state.current;
    return {
      ok: true, name: "aemcp-bridge", version: VERSION, host: hostInfo(), port: state.port, pid: process.pid,
      busy: state.busy, busyForMs: cur ? Date.now() - cur.startedAt : 0, busyWith: cur ? cur.label || null : null,
      queue: state.queue.length, pendingApprovals: state.pending.length, permissionMode: permissionMode(),
      startedAt: state.startedAt, lastActivated: state.lastActivated, authorized: authorized(req, token),
    };
  }

  function handleEval(req, res, body) {
    if (!body || typeof body.script !== "string") return send(res, 400, { ok: false, error: "missing script" });
    var finished = false;
    var job = {
      script: body.script,
      label: body.label || null,
      done: function (result) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        send(res, 200, { ok: true, result: result });
      },
    };
    var timeoutMs = Math.max(1000, Math.min(Number(body.timeoutMs) || 120000, 24 * 3600 * 1000));
    var timer = null;
    var startTimer = function () {
      timer = setTimeout(function () {
        if (finished) return;
        finished = true;
        job.cancelled = true; // drop it if it has not started yet
        send(res, 504, { ok: false, error: "Timed out after " + Math.round(timeoutMs / 1000) + "s waiting for After Effects (it may be busy, rendering, or showing a dialog)." });
      }, timeoutMs);
    };
    // client went away (or the AI app cancelled the request) before we answered: don't run it if still queued
    res.on("close", function () { if (!finished) { finished = true; job.cancelled = true; clearTimeout(timer); dropPending(job); } });

    if (body.approval && permissionMode() === "ask") {
      // hold the edit until the user allows or denies it in the AE MCP panel
      var p = {
        id: crypto.randomBytes(6).toString("hex"), at: new Date().toISOString(), tool: body.approval.tool || "edit",
        summary: String(body.approval.summary || "").slice(0, 4000), job: job,
      };
      p.resolve = function (allow) {
        state.pending = state.pending.filter(function (x) { return x !== p; });
        if (finished) return;
        if (!allow) {
          finished = true;
          addLog({ at: new Date().toISOString(), ms: 0, ok: false, label: p.tool, preview: "denied in the AE MCP panel" });
          return send(res, 200, { ok: false, denied: true, error: "The user denied this change in After Effects (AE MCP panel)." });
        }
        startTimer();
        state.queue.push(job);
        pump();
      };
      state.pending.push(p);
      openPanel();
      // waiting for a person: allow up to 10 minutes before giving up
      setTimeout(function () { if (!finished && state.pending.indexOf(p) >= 0) { state.pending = state.pending.filter(function (x) { return x !== p; }); finished = true; send(res, 200, { ok: false, denied: true, error: "No one approved this change in the AE MCP panel within 10 minutes." }); } }, 10 * 60 * 1000);
      return;
    }
    startTimer();
    state.queue.push(job);
    pump();
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
      if (req.method === "GET" && req.url === "/health") return send(res, 200, health(req, token));
      if (!authorized(req, token)) return send(res, 401, { ok: false, error: "unauthorized" });
      if (req.method === "GET" && req.url === "/log") return send(res, 200, { ok: true, log: state.log });
      if (req.method === "GET" && req.url === "/pending") {
        return send(res, 200, { ok: true, pending: state.pending.map(function (p) { return { id: p.id, at: p.at, tool: p.tool, summary: p.summary }; }) });
      }
      if (req.method === "POST" && req.url === "/approve") {
        return readBody(req, function (err, b) {
          if (err) return send(res, 400, { ok: false, error: "invalid JSON" });
          var p = state.pending.filter(function (x) { return x.id === b.id; })[0];
          if (!p) return send(res, 404, { ok: false, error: "no such request (already answered or cancelled)" });
          p.resolve(!!b.allow);
          send(res, 200, { ok: true });
        });
      }
      if (req.method === "POST" && req.url === "/eval") {
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
    try { global.addEventListener("unload", unregister); } catch (e) {}
    try { process.on("exit", unregister); } catch (e) {}
    return state;
  }

  global.AEMCPBridge = {
    start: start, state: state, loadConfig: loadConfig, hostInfo: hostInfo, permissionMode: permissionMode,
    VERSION: VERSION, CONFIG_FILE: CONFIG_FILE, CONFIG_DIR: CONFIG_DIR,
  };
})(window);
