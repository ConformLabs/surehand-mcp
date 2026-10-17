/* AE MCP bridge: a tiny HTTP server inside After Effects (CEP + Node) that evaluates
 * ExtendScript sent by the ae-mcp server. Binds to 127.0.0.1 only and requires the
 * shared token from ~/.aemcp/config.json. */
(function (global) {
  "use strict";
  var nodeRequire = typeof require !== "undefined" ? require : global.cep_node && global.cep_node.require;
  var http = nodeRequire("http");
  var fs = nodeRequire("fs");
  var os = nodeRequire("os");
  var path = nodeRequire("path");
  var crypto = nodeRequire("crypto");

  var VERSION = "1.0.0";
  var CONFIG_DIR = path.join(os.homedir(), ".aemcp");
  var CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
  var STATUS_FILE = path.join(CONFIG_DIR, "bridge-status.json");

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

  function hostInfo() {
    try {
      var env = JSON.parse(global.__adobe_cep__.getHostEnvironment());
      return { appName: env.appName, appVersion: env.appVersion };
    } catch (e) { return {}; }
  }

  function evalScript(script, cb) {
    global.__adobe_cep__.evalScript(script, function (r) { cb(r); });
  }

  var state = { started: false, listening: false, error: null, port: null, busy: false, queue: [], log: [], startedAt: null };

  function addLog(entry) {
    state.log.unshift(entry);
    if (state.log.length > 50) state.log.length = 50;
  }

  function writeStatus() {
    try {
      fs.writeFileSync(STATUS_FILE, JSON.stringify({ listening: state.listening, port: state.port, error: state.error, pid: process.pid, host: hostInfo(), version: VERSION, at: new Date().toISOString() }, null, 2));
    } catch (e) {}
  }

  // ExtendScript is single threaded: run one script at a time.
  function pump() {
    if (state.busy || !state.queue.length) return;
    var job = state.queue.shift();
    if (job.cancelled) return pump();
    state.busy = true;
    var t0 = Date.now();
    evalScript(job.script, function (result) {
      state.busy = false;
      var ms = Date.now() - t0;
      var ok = result !== "EvalScript error." && result.indexOf('{"ok":false') !== 0;
      addLog({ at: new Date().toISOString(), ms: ms, ok: ok, size: job.script.length, preview: String(result).slice(0, 160) });
      job.done(result);
      pump();
    });
  }

  function send(res, status, obj) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  }

  function authorized(req, token) {
    var h = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!h || h.length !== token.length) return false;
    try { return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(token)); } catch (e) { return false; }
  }

  function start() {
    if (state.started) return state;
    state.started = true;
    var cfg = loadConfig();
    state.port = cfg.bridgePort;

    var server = http.createServer(function (req, res) {
      // Reject browser-originated requests (DNS-rebinding / CSRF protection)
      if (req.headers.origin) return send(res, 403, { ok: false, error: "forbidden" });
      var token = loadConfig().token;
      if (req.method === "GET" && req.url === "/health") {
        return send(res, 200, { ok: true, name: "aemcp-bridge", version: VERSION, host: hostInfo(), busy: state.busy, queue: state.queue.length, authorized: authorized(req, token) });
      }
      if (!authorized(req, token)) return send(res, 401, { ok: false, error: "unauthorized" });
      if (req.method === "GET" && req.url === "/log") return send(res, 200, { ok: true, log: state.log });
      if (req.method === "POST" && req.url === "/eval") {
        var chunks = [];
        req.on("data", function (c) { chunks.push(c); });
        req.on("end", function () {
          var body;
          try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (e) { return send(res, 400, { ok: false, error: "invalid JSON" }); }
          if (!body || typeof body.script !== "string") return send(res, 400, { ok: false, error: "missing script" });
          var finished = false;
          var job = {
            script: body.script,
            done: function (result) {
              if (finished) return;
              finished = true;
              clearTimeout(timer);
              send(res, 200, { ok: true, result: result });
            },
          };
          var timeoutMs = Math.max(1000, Math.min(Number(body.timeoutMs) || 120000, 24 * 3600 * 1000));
          var timer = setTimeout(function () {
            if (finished) return;
            finished = true;
            job.cancelled = true; // drop it if it has not started yet
            send(res, 504, { ok: false, error: "Timed out after " + timeoutMs + "ms waiting for After Effects (it may be busy, rendering, or showing a dialog)." });
          }, timeoutMs);
          // client went away before we answered: don't run it if it is still queued
          res.on("close", function () { if (!finished) { job.cancelled = true; } });
          state.queue.push(job);
          pump();
        });
        return;
      }
      send(res, 404, { ok: false, error: "not found" });
    });

    server.on("error", function (e) {
      state.listening = false;
      state.error = e.code === "EADDRINUSE"
        ? "Port " + state.port + " is already in use (another After Effects instance running the bridge?)"
        : String(e.message || e);
      writeStatus();
    });
    server.listen(state.port, "127.0.0.1", function () {
      state.listening = true;
      state.error = null;
      state.startedAt = new Date().toISOString();
      writeStatus();
    });
    state.server = server;
    return state;
  }

  global.AEMCPBridge = { start: start, state: state, loadConfig: loadConfig, hostInfo: hostInfo, VERSION: VERSION, CONFIG_FILE: CONFIG_FILE };
})(window);
