/* The Surehand panel: status, "What the AI may do", Pause AI, approval cards ("ask" mode), and a
 * short feed of what the AI did. Settings and tools live in After Effects' own panel menu (☰),
 * whose screens slide over the feed. If the background bridge extension isn't running (some
 * hosts don't honour StartOn for invisible extensions), the panel starts the bridge itself.
 * Answers, Pause / Resume and the panel's own jobs carry the panel secret (control.js), which the AI
 * app never has. ☰ › Chat with your AI app runs the user's own AI agent with Surehand's tools.
 * Needs paths.js, panel-model.js, bridge-core.js and control.js. ES5 only. */
(function () {
  "use strict";
  var http = require("http");
  var fs = require("fs");
  var os = require("os");
  var path = require("path");
  var crypto = require("crypto");
  var childProcess = require("child_process");
  var UI = window.SurehandUI;
  var $ = function (id) { return document.getElementById(id); };
  var REPO_URL = "https://github.com/ConformLabs/surehand-mcp";
  var WIKI_URL = REPO_URL + "/wiki";
  var POLL_MS = 1500;
  // a new request can't be answered for this long (no answer meant for the previous card lands on it)
  // (a little more than the bridge's 1 s, which counts from when the panel reports the card shown)
  var ARM_MS = window.SUREHAND_ARM_MS || 1200;
  // "That request was withdrawn" stays this long before the next request shows
  var GONE_MS = window.SUREHAND_GONE_MS || 1500;
  var myPort = null; // the bridge of THIS After Effects instance
  var Control = window.SurehandControl;

  function P() { return window.SurehandPaths.current(require); }
  function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return null; }
  }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === undefined || v === null || v === false) return;
      if (k === "text") n.textContent = v;
      else if (k === "html") n.innerHTML = v;
      else if (k === "onclick") n.onclick = v;
      else if (k === "cls") n.className = v;
      else n.setAttribute(k, v === true ? "" : v);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function button(cls, text, onclick, attrs) {
    var b = el("button", attrs || {}, [text]);
    b.type = "button";
    b.className = cls;
    b.onclick = onclick;
    return b;
  }

  // ---------- bridge requests ----------
  function call(method, p, body, cb, timeoutMs) {
    var cfg = AEMCPBridge.loadConfig();
    var data = body ? JSON.stringify(body) : null;
    var port = myPort || AEMCPBridge.state.port || cfg.bridgePort;
    var req = http.request({ host: "127.0.0.1", port: port, path: p, method: method,
      headers: Control.headers(port, cfg.token) }, function (res) {
      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        var r = null;
        try { r = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (e) { return cb(e); }
        if (r && typeof r === "object") r.httpStatus = res.statusCode;
        cb(null, r);
      });
    });
    req.on("error", function (e) { cb(e); });
    req.setTimeout(timeoutMs || (p === "/eval" ? 30000 : 3000), function () { req.destroy(new Error("timeout")); });
    if (data) req.write(data);
    req.end();
  }
  /** The panel secret for this After Effects' bridge, asking for it when it isn't known yet. */
  function secret() {
    var port = myPort || AEMCPBridge.state.port;
    var s = port ? Control.secretFor(port) : null;
    if (!s) Control.hello();
    return s;
  }
  var NO_SECRET = "The Surehand bridge in this After Effects hasn\u2019t answered yet. Try again in a moment.";
  /** Run ExtendScript for the panel itself (allowed while the AI is paused). */
  function evalAE(script, label, cb, timeoutMs) {
    if (!secret()) return setTimeout(function () { cb(new Error(NO_SECRET)); }, 0);
    call("POST", "/eval", { script: script, timeoutMs: timeoutMs || 10000, label: label, fromPanel: true }, function (err, r) {
      if (err) return cb(err);
      if (!r.ok) return cb(new Error(r.error || "After Effects did not run it"));
      cb(null, r.result);
    }, (timeoutMs || 10000) + 5000);
  }

  // The bridge of this instance: with several AE instances, match on this AE's version.
  /**
   * The bridge of this After Effects that the AI uses: the bridge extension's, never the panel's own fallback
   * bridge when the real one is running (two bridges in one After Effects would split approvals and pause).
   * Among this AE version's live instances: not this page's own, then the configured port, then the oldest.
   */
  function candidates() {
    var host = AEMCPBridge.hostInfo(), dir = P().instances, list = [];
    try {
      fs.readdirSync(dir).forEach(function (f) {
        var info = readJson(path.join(dir, f));
        if (info && info.listening && info.host && info.host.appVersion === host.appVersion) list.push(info);
      });
    } catch (e) {}
    return list;
  }
  function pickPort(list, ownPort, cfgPort) {
    var others = list.filter(function (i) { return i.port !== ownPort; });
    var pool = others.length ? others : list;
    pool.sort(function (a, b) {
      if ((a.port === cfgPort) !== (b.port === cfgPort)) return a.port === cfgPort ? -1 : 1;
      return String(a.startedAt || "").localeCompare(String(b.startedAt || ""));
    });
    return pool.length ? pool[0].port : null;
  }
  function ownPort() { return AEMCPBridge.state && AEMCPBridge.state.started ? AEMCPBridge.state.port : null; }
  function findMyPort(cb) {
    var cfg = AEMCPBridge.loadConfig();
    myPort = pickPort(candidates(), ownPort(), cfg.bridgePort) || ownPort() || (AEMCPBridge.state && AEMCPBridge.state.port) || cfg.bridgePort;
    cb();
  }
  /** The panel started its own bridge (the real one wasn't up yet) and the real one is up now: step aside. */
  function yieldOwnBridge() {
    var own = ownPort();
    if (!own) return;
    var other = pickPort(candidates().filter(function (i) { return i.port !== own; }), null, AEMCPBridge.loadConfig().bridgePort);
    if (!other) return;
    http.get({ host: "127.0.0.1", port: other, path: "/health", headers: Control.headers(other, AEMCPBridge.loadConfig().token) }, function (res) {
      res.resume();
      if (res.statusCode === 200) { try { AEMCPBridge.stop(); } catch (e) {} myPort = other; Control.hello(); }
    }).on("error", function () {});
  }

  // ---------- the server's command line (menu screens) ----------
  function runtime() {
    var rt = readJson(P().runtime);
    return rt && rt.node && rt.server && fs.existsSync(rt.node) && fs.existsSync(rt.server) ? rt : null;
  }
  var NO_RUNTIME = "This needs the Surehand MCP app installed with its installer. With only the Claude Desktop extension it isn't available here.";
  var TOO_OLD = "This needs a newer Surehand MCP server. Update it from \u2630 \u203a Check for updates.";
  /** The server commands' environment: never the panel secret (only a job the user started here gets it, asPanel). */
  function cliEnv() {
    var env = {};
    Object.keys(process.env).forEach(function (k) { env[k] = process.env[k]; });
    env.AEMCP_NO_AUTOSETUP = "1";
    delete env.SUREHAND_AE_PANEL_SECRET;
    delete env.AEMCP_PANEL_SECRET;
    return env;
  }
  /**
   * `<node> <server> args...` -> cb(err, json, text). err.friendly says what to show. Commands added in
   * 1.4 aren't run on an older server (it would start an MCP server instead of answering).
   */
  function runCli(args, cb, opts) {
    opts = opts || {};
    var rt = runtime();
    if (!rt) return cb({ friendly: NO_RUNTIME });
    // the server says which panel commands it has (runtime.json panelCommands); the version number alone
    // can't tell (a beta or dev build of 1.4 still says 1.3.x until it's released)
    if (opts.since && !(rt.panelCommands >= 1) && rt.version && UI.cmpVersions(String(rt.version).split("-")[0], opts.since) < 0) return cb({ friendly: TOO_OLD });
    var env = cliEnv();
    if (opts.asPanel) {
      // read-only checks the user started here (Compare with now, Test the connection): their jobs run as
      // the panel's own, on this After Effects' bridge, also while the AI is paused
      var sec = secret();
      if (sec && myPort) { env.SUREHAND_AE_PANEL_SECRET = sec; env.SUREHAND_AE_BRIDGE_PORT = String(myPort); }
    }
    var child;
    try {
      child = childProcess.execFile(rt.node, [rt.server].concat(args), { timeout: opts.timeout || 30000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: env }, function (err, stdout, stderr) {
        var text = String(stdout || "");
        var json = UI.parseCliJson(text);
        if (opts.text) return cb(err && !text ? { friendly: "It did not finish: " + (err.message || err) } : null, json, text);
        if (!json) return cb({ friendly: /unknown|usage/i.test(text + stderr) || !text ? TOO_OLD : "Unexpected answer: " + text.slice(0, 200) }, null, text);
        cb(null, json, text);
      });
    } catch (e) { return cb({ friendly: "Could not start the Surehand MCP server: " + e.message }); }
    // never leave a server waiting for input
    try { if (child && child.stdin) child.stdin.end(); } catch (e) {}
  }

  // ---------- toast (no alert() pop-ups) ----------
  var toastTimer = null;
  function toast(text, bad) {
    $("toastText").textContent = text;
    $("toast").className = "toast" + (bad ? " bad" : "");
    $("toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $("toast").hidden = true; }, bad ? 6000 : 3500);
  }

  // ---------- config ----------
  var goodCfg = null; // the last config.json that could be read
  /** { cfg } | { missing } | { error } */
  function readConfigFile() {
    var raw;
    try { raw = fs.readFileSync(P().config, "utf8"); } catch (e) { return e.code === "ENOENT" ? { missing: true } : { error: e.code || e.message }; }
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    try { var c = JSON.parse(raw); return c && typeof c === "object" ? { cfg: c } : { error: "not a JSON object" }; } catch (e) { return { error: "not valid JSON" }; }
  }
  /** The settings to show: the file, or the last good copy while it can't be read (never defaults). */
  function readConfig() {
    var r = readConfigFile();
    if (r.cfg) { goodCfg = r.cfg; return r.cfg; }
    if (r.missing && !goodCfg) return AEMCPBridge.loadConfig(); // creates it
    return goodCfg || {};
  }
  /**
   * Changes config.json: read again right before, written atomically (temporary file + rename,
   * readable only by the user). Refused while the file can't be read: writing would replace it.
   */
  function writeConfig(change) {
    var file = P().config, r = readConfigFile();
    if (r.error) r = readConfigFile(); // a torn read while someone writes it?
    if (r.error) { toast("Not saved: the settings file can\u2019t be read (" + r.error + "). Check " + file, true); return false; }
    var cfg = r.cfg || {};
    change(cfg);
    var tmp = path.join(path.dirname(file), "." + path.basename(file) + "." + process.pid + "." + Date.now().toString(36) + ".tmp");
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 384 });
      fs.renameSync(tmp, file);
      if (process.platform !== "win32") { try { fs.chmodSync(file, 384); } catch (e) {} }
      goodCfg = cfg;
      return true;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (x) {}
      toast("Could not save the setting: " + e.message, true);
      return false;
    }
  }

  // ---------- state ----------
  var S = {
    layout: "default", cfg: {}, health: null, bridgeError: null, authorized: true, pending: [], paused: null,
    activity: [], renders: [], undone: {}, open: {}, clients: null, update: null, screen: null, answering: {},
    // the bridge says whether it is paused (null: not known yet, then the config's flag is shown)
    bridgePaused: null,
    // this After Effects and its open project, for Undo: { port, pid, project, revision }
    current: null,
  };

  // ---------- layout ----------
  function applyLayout() {
    var l = UI.layoutFor(window.innerWidth || 320, window.innerHeight || 560);
    if (l === S.layout) return;
    S.layout = l;
    document.body.className = document.body.className.replace(/\blayout-\w+\b/, "") + " layout-" + l;
    renderModes();
    renderFeed(true);
  }

  // ---------- header: status, pause ----------
  function status() {
    if (S.connecting) return { kind: "idle", tile: "gray", glyph: "pending", text: "Connecting to After Effects\u2026", short: "Connecting", connecting: true };
    var w = !isPausedNow() && !S.pending.length && UI.workingView(S.health, S.busySince ? Date.now() - S.busySince : null);
    if (w && w.waiting) return { kind: "ready", tile: "green", glyph: "waiting", text: "Waiting for After Effects", short: "Waiting" };
    if (w) return { kind: "ready", tile: "green", glyph: "verified", text: "Working\u2026", short: "Working" };
    return UI.statusFor({
      bridgeError: S.bridgeError, paused: isPausedNow(), pendingCount: S.pending.length,
      client: UI.lastClient(S.activity), everConnected: S.activity.length > 0, apps: S.apps,
    });
  }
  /**
   * The AI apps connected right now: each one's Surehand server writes sessions/<pid>.json when the app has
   * said hello (and removes it when it quits); ChatGPT on the web counts while its secure link runs.
   */
  function alive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
  }
  function readApps() {
    var p = P(), list = [];
    try {
      fs.readdirSync(p.sessions).forEach(function (f) { if (/\.json$/.test(f)) list.push(readJson(path.join(p.sessions, f))); });
    } catch (e) { return null; } // no folder yet (no app has connected since 1.4): not known
    var apps = UI.connectedApps(list, alive);
    var web = readJson(p.chatgpt);
    if (web && web.state === "running" && web.pid && alive(web.pid) && apps.indexOf("ChatGPT (web)") < 0) apps.push("ChatGPT (web)");
    return apps;
  }
  function isPausedNow() { return S.bridgePaused === null ? !!S.cfg.paused : S.bridgePaused; }
  function renderHeader() {
    var st = status();
    $("status").className = "status " + st.kind;
    $("statusGlyph").className = "g g-sm g-" + st.glyph;
    $("statusText").textContent = S.layout === "narrow" ? st.short : st.text;
    $("status").title = st.text;
    var paused = isPausedNow();
    $("pause").hidden = paused;
    $("resume").hidden = !paused;
    $("pausedNote").hidden = !paused;
    var n = paused && S.paused && S.paused.refused || 0;
    $("pausedCount").hidden = !n;
    $("pausedN").textContent = n ? String(n) : "";
    renderModeDesc();
    var host = AEMCPBridge.hostInfo();
    $("hostLabel").textContent = UI.aeLabel(host.appVersion);
    var upd = S.update && S.update.latest && UI.cmpVersions(S.update.latest, AEMCPBridge.VERSION) > 0;
    $("ver").textContent = AEMCPBridge.VERSION + (upd ? " \u00b7 update ready" : "");
    $("ver").className = "link" + (upd ? " update" : "");
    var rn = UI.restartNote(AEMCPBridge.VERSION, updatedTo || installedVersion());
    $("restartNote").hidden = !rn;
  }
  /** The installed server's version (runtime.json), read at most once a minute: an update this After Effects hasn't loaded. */
  var installedSeen = { at: 0, v: null };
  function installedVersion() {
    if (!installedSeen || Date.now() - installedSeen.at > 60000) { var rt = readJson(P().runtime); installedSeen = { at: Date.now(), v: rt && rt.version || null }; }
    return installedSeen.v;
  }
  /** Pause / Resume: the bridge holds it (and saves it in the config); only the panel can change it. */
  function setPaused(on) {
    if (!secret()) return toast(NO_SECRET, true);
    call("POST", "/pause", { paused: on }, function (err, r) {
      if (err || !r || !r.ok) return toast("Could not " + (on ? "pause" : "resume") + ": " + (err ? err.message : (r && r.error) || "no answer"), true);
      S.bridgePaused = !!r.paused;
      S.paused = r.paused || null;
      S.cfg = readConfig();
      renderHeader();
      renderSetup();
      toast((on ? "AI paused: its calls are refused until you resume." : "Resumed: the AI can work again.") + (r.saved === false ? " (Not saved in the settings file: it can\u2019t be read.)" : ""));
      (on ? $("resume") : $("pause")).focus();
    });
  }
  $("pause").onclick = function () { setPaused(true); };
  $("menuBtn").onclick = function () { openScreen("menu"); };
  $("chatBtn").onclick = function () { openScreen("chat"); };
  $("resume").onclick = function () { setPaused(false); };

  // ---------- mode switch (config permissions.mode) ----------
  var shownModes = "";
  /**
   * The mode's one line under the switch. While paused the block is dimmed and says when it applies;
   * while an approval waits the card says enough, so the line goes.
   */
  function renderModeDesc() {
    var paused = isPausedNow(), def = UI.MODES.filter(function (m) { return m.id === UI.modeOf(S.cfg); })[0];
    $("modeBox").className = "modes" + (paused ? " dim" : "");
    $("modeDesc").textContent = paused ? "Applies when you resume." : def.desc;
    $("modeDesc").hidden = !paused && !$("ask").hidden;
  }
  function renderModes() {
    var mode = UI.modeOf(S.cfg), key = mode + S.layout;
    if (key === shownModes) return;
    shownModes = key;
    var box = $("modes");
    box.innerHTML = "";
    UI.MODES.forEach(function (m) {
      var on = m.id === mode;
      var label = S.layout === "default" ? m.label : m.short;
      var b = el("button", { type: "button", role: "radio", "aria-checked": on ? "true" : "false", "aria-label": m.label, tabindex: on ? "0" : "-1", "data-mode": m.id, text: label });
      b.onclick = function () { setMode(m.id); };
      b.onkeydown = function (e) {
        var i = UI.MODES.indexOf(m), d = e.keyCode === 39 || e.keyCode === 40 ? 1 : e.keyCode === 37 || e.keyCode === 38 ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        var next = UI.MODES[(i + d + UI.MODES.length) % UI.MODES.length];
        setMode(next.id);
        var nb = box.querySelector('[data-mode="' + next.id + '"]');
        if (nb) nb.focus();
      };
      box.appendChild(b);
    });
    renderModeDesc();
  }
  function setMode(id) {
    if (UI.modeOf(S.cfg) === id) return;
    if (!writeConfig(function (cfg) {
      var p = cfg.permissions || {};
      cfg.permissions = { mode: id, allowShell: p.allowShell !== false };
    })) return;
    S.cfg = readConfig();
    renderModes();
  }

  // ---------- approvals ----------
  // The card shows the oldest request. A new card can't be answered for ARM_MS (its buttons show "…"),
  // so a click or key meant for the previous card never lands on it. When the shown request goes away
  // without an answer from here (answered in the pop-up, cancelled, timed out), "That request was
  // withdrawn" shows for GONE_MS before the next one. Every answer names the request it is for.
  var shownAsk = null, askOpen = false, armedAt = 0, goneUntil = 0, armTimer = null;
  var answeredHere = {}; // requests answered in this panel (they go away without "withdrawn")
  function currentAsk() {
    for (var i = 0; i < S.pending.length; i++) if (!S.answering[S.pending[i].id]) return S.pending[i];
    return null;
  }
  function armed() { return shownAsk && Date.now() - armedAt >= ARM_MS; }
  function setArmed(on) {
    $("allow").disabled = !on;
    $("deny").disabled = !on;
    $("allow").textContent = on ? "Allow" : "\u2026";
    $("deny").textContent = on ? "Deny" : "\u2026";
  }
  function renderAsk() {
    var p = currentAsk();
    if (shownAsk && (!p || p.id !== shownAsk) && !S.answering[shownAsk] && !answeredHere[shownAsk]) {
      // the request on screen went away without an answer from here: say so before showing another
      goneUntil = Date.now() + GONE_MS;
      shownAsk = null;
      setTimeout(renderAsk, GONE_MS + 20);
    }
    if (Date.now() < goneUntil) {
      $("ask").hidden = true;
      $("askGone").hidden = false;
      renderModeDesc();
      return;
    }
    $("askGone").hidden = true;
    $("ask").hidden = !p;
    renderModeDesc();
    if (!p) { shownAsk = null; return; }
    var waiting = S.pending.filter(function (x) { return !S.answering[x.id]; }).length;
    var left = UI.countdownView(p.deadline || new Date(Date.parse(p.at) + 600000).toISOString(), Date.now());
    $("askTime").textContent = left.text;
    $("askTime").className = "time num" + (left.urgent ? " urgent" : "");
    $("askHint").textContent = "Esc denies \u00b7 no key allows" + (waiting > 1 ? " \u00b7 " + (waiting - 1) + " more after this" : "");
    if (shownAsk === p.id) return;
    shownAsk = p.id;
    askOpen = false;
    askFull = false;
    armedAt = Date.now();
    setArmed(false);
    clearTimeout(armTimer);
    armTimer = setTimeout(function () { if (shownAsk === p.id) setArmed(true); }, ARM_MS);
    var v = UI.approvalView(p, UI.lastClient(S.activity));
    $("askWho").textContent = v.client + " asks";
    $("askTitle").textContent = v.title;
    $("askSays").textContent = v.says || "";
    $("askSays").hidden = !v.says;
    var chips = $("askChips");
    chips.innerHTML = "";
    v.chips.forEach(function (c) { chips.appendChild(el("span", { cls: "chip" + (c.danger ? " danger" : ""), text: c.text })); });
    askView = v;
    askIsScript = /script/i.test(p.tool);
    drawPreview();
    pollPending(); // tell the bridge which request is on screen
  }
  /** The script (or the call's details): opened by itself, capped, when a chip is a danger chip (UI.previewView). */
  var askView = null, askIsScript = false, askFull = false;
  function drawPreview() {
    var pv = UI.previewView(askView, askIsScript, { open: askOpen, full: askFull });
    $("askCode").textContent = pv.text;
    $("askCode").hidden = !pv.open;
    $("askShow").hidden = !pv.toggle;
    $("askShow").textContent = pv.toggle || "";
    $("askShow").setAttribute("aria-expanded", (pv.danger ? askFull : askOpen) ? "true" : "false");
  }
  $("askShow").onclick = function () {
    if (!askView) return;
    if (UI.previewView(askView, askIsScript, {}).danger) askFull = !askFull;
    else askOpen = !askOpen;
    drawPreview();
  };
  function answer(allow) {
    var p = currentAsk();
    // only the request on screen, and only once it has been there long enough to be read
    if (!p || p.id !== shownAsk || !armed() || $("ask").hidden) return;
    if (!secret()) return toast(NO_SECRET, true);
    S.answering[p.id] = true; // hide it at once; the bridge's list is the truth on the next poll
    answeredHere[p.id] = true;
    renderAsk();
    renderHeader();
    call("POST", "/approve", { id: p.id, allow: allow, by: "panel" }, function (err, r) {
      if (err) { delete S.answering[p.id]; delete answeredHere[p.id]; toast("Could not answer: " + err.message, true); }
      else if (r && r.httpStatus === 404) toast("Already answered (or the AI app cancelled it).");
      else if (r && !r.ok) { delete S.answering[p.id]; delete answeredHere[p.id]; toast("Not answered: " + (r.error || "the bridge refused it"), true); }
      pollPending();
    });
  }
  $("allow").onclick = function () { answer(true); };
  $("deny").onclick = function () { answer(false); };
  function pollPending() {
    var visible = document.visibilityState ? document.visibilityState !== "hidden" : true;
    var showing = shownAsk && !$("ask").hidden ? "&showing=" + encodeURIComponent(shownAsk) : "";
    call("GET", "/pending?ui=panel&visible=" + (visible ? "1" : "0") + showing, null, function (err, r) {
      if (err || !r || !r.pending) return;
      S.pending = r.pending;
      S.paused = r.paused || null;
      if (r.paused !== undefined) S.bridgePaused = !!r.paused;
      Object.keys(S.answering).forEach(function (id) {
        if (!r.pending.some(function (x) { return x.id === id; })) delete S.answering[id];
      });
      renderAsk();
      renderHeader();
      // the chat's header and field say when an approval waits
      var asking = !$("ask").hidden;
      if (S.screen === "chat" && asking !== chatAsking) { chatAsking = asking; drawChat(); }
    });
  }
  var chatAsking = false;

  // ---------- keyboard: Esc denies (or closes a screen); there is no key that allows ----------
  document.addEventListener("keydown", function (e) {
    if (e.keyCode === 9) document.body.classList.add("kbd");
    var tag = e.target && e.target.tagName;
    // Enter never allows, not even on a focused Allow button (Space or a click does, deliberately)
    if (e.keyCode === 13 && e.target && e.target.id === "allow") { e.preventDefault(); return; }
    if (S.screen) {
      // in the chat, Esc denies the approval card shown there (as in the main view); otherwise it goes back
      if (e.keyCode === 27 && S.screen === "chat" && !$("ask").hidden) { e.preventDefault(); answer(false); return; }
      if (e.keyCode === 27) { e.preventDefault(); goBack(); }
      return;
    }
    if ($("ask").hidden || tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.keyCode === 27) {
      e.preventDefault();
      answer(false);
    }
  });
  document.addEventListener("mousedown", function () { document.body.classList.remove("kbd"); });

  // ---------- not connected: set up an AI app ----------
  function renderSetup() {
    var st = status();
    var box = $("setup");
    box.hidden = !(st.kind === "idle" && !st.connecting) && st.kind !== "problem";
    if (box.hidden) return;
    // the main action is green; "Connect another AI app" next to apps that are set up is not
    var setBtn = function (text, main, onclick) {
      $("setupBtn").hidden = false;
      $("setupBtn").textContent = text;
      $("setupBtn").className = "btn small" + (main ? " main" : "");
      $("setupBtn").onclick = onclick;
    };
    $("setupLabel").textContent = st.kind === "problem" ? "Problem" : "Next";
    if (st.kind === "problem") {
      $("setupText").textContent = st.text + ".";
      setBtn("Test the connection", true, function () { openScreen("test"); });
      $("setupHint").textContent = "It finds what\u2019s wrong and how to fix it.";
      return;
    }
    // ChatGPT on the web has its own screen (a secure link, not a setting): not offered here
    var list = (S.clients && S.clients.list || []).filter(function (c) { return c.action !== "start"; });
    var configured = list.filter(function (c) { return c.configured; });
    var todo = list.filter(function (c) { return c.installed !== false && !c.configured && c.connectable !== false; });
    var pick = todo.filter(function (c) { return /claude.?desktop/i.test(c.id + " " + c.name); })[0] || todo[0];
    if (configured.length) {
      var names = configured.map(function (c) { return c.name; });
      $("setupText").textContent = (names.length > 2 ? names.slice(0, 2).join(", ") + " and others are" : names.join(" and ") + (names.length > 1 ? " are" : " is")) +
        " set up. Open " + (names.length > 1 ? "one" : "it") + " (or restart it), then ask it something about your After Effects project, like \u201cWhat\u2019s in my project?\u201d";
      setBtn("Connect another AI app", false, function () { openScreen("connect"); });
      $("setupHint").textContent = "It shows as connected here as soon as the app has started.";
    } else if (pick) {
      $("setupText").textContent = pick.name + " isn\u2019t set up yet.";
      setBtn("Set it up", true, function () { connectClient(pick, true); });
      $("setupHint").textContent = "Then restart " + pick.name + ". Other apps: \u2630 \u203a Connect an AI app.";
    } else if (S.activity.length) {
      $("setupText").textContent = "Open your AI app, then ask it something about your After Effects project.";
      setBtn("Connect an AI app", true, function () { openScreen("connect"); });
      $("setupHint").textContent = "It shows as connected here as soon as the app has started.";
    } else {
      $("setupText").textContent = "No AI app has used Surehand yet.";
      setBtn("Connect an AI app", true, function () { openScreen("connect"); });
      $("setupHint").textContent = "Set one up, then restart that app.";
    }
  }
  function loadClients(cb) {
    runCli(["clients", "--json"], function (err, json) {
      if (err) { S.clients = { error: err.friendly, list: [] }; }
      else {
        var raw = Array.isArray(json) ? json : json.clients || [];
        S.clients = { list: raw.map(function (c) {
          return {
            id: c.id, name: c.name || c.label || c.id, installed: c.installed, configured: !!(c.configured || c.setUp || c.connected),
            inUse: c.inUse, note: c.note || c.detail || c.status, connectable: c.connectable, action: c.action,
          };
        }), snippet: json.snippet || json.settings || null };
      }
      renderSetup();
      if (cb) cb();
    }, { since: "1.4.0" });
  }
  function connectClient(c, fromSetup) {
    if (c.id === "chatgpt-web") return openScreen("chatgpt");
    var redraw = redrawLater();
    runCli(["connect", c.id, "--json"], function (err, r) {
      if (err) return toast(err.friendly, true);
      toast(r.message || (r.ok === false ? "Could not set up " + c.name + "." : c.name + " is set up. Restart it to use Surehand."), r.ok === false);
      loadClients(redraw);
    }, { since: "1.4.0", timeout: 60000 });
    if (fromSetup) $("setupBtn").disabled = true;
    setTimeout(function () { $("setupBtn").disabled = false; }, 3000);
  }

  // ---------- activity log and renders ----------
  /** The last part of a (possibly large) log file: only the tail is read. */
  function readTail(file, bytes) {
    var fd = null;
    try {
      var st = fs.statSync(file);
      var len = Math.min(st.size, bytes), buf = Buffer.alloc(len);
      fd = fs.openSync(file, "r");
      fs.readSync(fd, buf, 0, len, st.size - len);
      var text = buf.toString("utf8");
      if (len < st.size) text = text.slice(text.indexOf("\n") + 1); // drop the partial first line
      return text;
    } catch (e) { return ""; } finally { if (fd !== null) try { fs.closeSync(fd); } catch (e) {} }
  }
  var activityStamp = "";
  /** Newest first. Re-read only when the file changed. */
  function readActivity(bytes, force) {
    var file = P().activity, stamp = "";
    try { var st = fs.statSync(file); stamp = file + st.size + ":" + st.mtime.getTime(); } catch (e) { stamp = "none"; }
    if (!force && stamp === activityStamp) return false;
    activityStamp = stamp;
    S.activity = parseActivity(readTail(file, bytes || 512 * 1024));
    return true;
  }
  function parseActivity(text) {
    return text.split("\n").map(function (l) { try { return l.trim() ? JSON.parse(l) : null; } catch (e) { return null; } })
      .filter(Boolean).reverse();
  }
  /** Background renders still running: renders/<id>.log written recently and not finished. */
  function readRenders() {
    var dir = P().renders, out = [];
    var starts = {};
    S.activity.forEach(function (e) {
      if (e.tool !== "ae_render_background" && !(e.tool === "ae_call" && e.args && e.args.tool === "ae_render_background")) return;
      var info = UI.renderStartInfo(e);
      if (info) { info.at = e.at; starts[info.id] = info; }
    });
    var files = [];
    try { files = fs.readdirSync(dir).filter(function (f) { return /\.log$/.test(f); }); } catch (e) { return out; }
    files.forEach(function (f) {
      var file = path.join(dir, f), st;
      try { st = fs.statSync(file); } catch (e) { return; }
      if (Date.now() - st.mtime.getTime() > 3 * 60 * 1000) return; // finished or abandoned long ago
      var id = f.replace(/\.log$/, "");
      var head = "";
      try { var fd = fs.openSync(file, "r"), b = Buffer.alloc(Math.min(st.size, 4096)); fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd); head = b.toString("utf8"); } catch (e) {}
      var prog = UI.renderProgress(head + "\n" + readTail(file, 8192), starts[id]);
      if (prog.done || prog.failed) return;
      var started = starts[id] ? Date.parse(starts[id].at) : (st.birthtime || st.ctime).getTime();
      prog.id = id;
      prog.left = UI.timeLeft(prog.pct, Date.now() - started);
      out.push(prog);
    });
    return out;
  }

  // ---------- feed ----------
  // each row: a 12px status square, the title, the status word (CHANGED, PASSED, ...) and the time; below,
  // what it did (the change list in the machine-output box for the newest change) and its actions
  var PLAY = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 1v10l9-5z" fill="#F2EFE8"></path></svg>';
  function glyph(name, label) {
    return el("span", { cls: "g g-" + name, role: label ? "img" : null, "aria-label": label || null, "aria-hidden": label ? null : "true" });
  }
  var shownWorking = "";
  function renderWorking() {
    var w = UI.workingView(S.health, S.busySince ? Date.now() - S.busySince : null), box = $("working");
    var key = w ? w.text + "|" + w.time + "|" + w.line + "|" + w.waiting : "";
    if (key === shownWorking) return;
    shownWorking = key;
    box.hidden = !w;
    box.innerHTML = "";
    if (!w) return;
    // waiting for After Effects: the amber note with its label; working: a quiet row with a pulsing square
    box.className = "working" + (w.waiting ? " waiting" : "");
    var head = w.waiting ? el("span", { cls: "wtitle" }, [el("span", { cls: "label", text: w.text })])
      : el("span", { cls: "wtitle" }, [el("span", { cls: "g g-pending pulse", "aria-hidden": "true" }), el("span", { cls: "ttl", text: w.text })]);
    box.appendChild(el("div", { cls: "row1" }, [head, el("span", { cls: "time num", text: w.time })]));
    if (w.line) box.appendChild(el("div", { cls: "line", text: w.line }));
  }
  $("allActivity").onclick = function () { openScreen("history"); };
  var shownFeed = "";
  function renderFeed(force) {
    var limit = S.layout === "wide" ? 5 : S.layout === "narrow" ? 6 : 7;
    var running = {};
    S.renders.forEach(function (r) { running[r.id] = true; });
    var items = UI.feedItems(S.activity, { limit: Math.max(1, limit - S.renders.length), undone: S.undone, runningRenders: running, current: S.current });
    var key = JSON.stringify([S.layout, S.renders, S.activity.length, S.apps, items.map(function (i) { return [i.at, i.title, i.line, i.undoable, i.undoBlocked, !!S.open[UI.entryKey(i.entry)]]; })]);
    if (!force && key === shownFeed) return;
    shownFeed = key;
    var feed = $("feed");
    feed.innerHTML = "";
    S.renders.forEach(function (r) { feed.appendChild(renderItem(r)); });
    items.forEach(function (it, k) { feed.appendChild(feedItem(it, k === 0)); });
    if (!items.length && !S.renders.length) feed.appendChild(el("div", { cls: "empty", text: S.apps && S.apps.length
      ? UI.appsText(S.apps) + (S.apps.length > 1 ? " are" : " is") + " connected. Ask it something about your After Effects project, like “What’s in my project?” What it does shows up here."
      : "What the AI does in After Effects shows up here." }));
    var shownEntries = items.reduce(function (n, i) { return n + (i.count || 1); }, 0);
    $("allActivity").hidden = S.layout === "narrow" || S.activity.length <= shownEntries;
  }
  /** A background render: play glyph, "Background render · Main", a 4px bar, "frame 126 of 300 · 1:12 left". */
  function renderItem(r) {
    var pct = r.pct === null || r.pct === undefined ? null : r.pct;
    var label = pct === null ? "frame " + (r.frame || 0) : pct + "%";
    var bar = el("div", { cls: "bar" + (pct === null ? " indet" : ""), "aria-hidden": "true" }, [el("div", { style: "width:" + (pct || 0) + "%" })]);
    var title = "Background render · " + (r.comp || "in the background");
    var sub = [r.frames ? "frame " + (r.frame || 0) + " of " + r.frames : "frame " + (r.frame || 0), r.left].filter(Boolean).join(" · ");
    var body = el("div", { cls: "body" }, [
      el("div", { cls: "row1" }, [el("span", { cls: "tline" }, [el("span", { cls: "title", text: title })]), el("span", { cls: "pct num", text: label })]),
      bar,
      el("div", { cls: "rsub mono-s num", text: sub }),
    ]);
    var side = el("span", { cls: "side-act pct num", text: label + (r.left && S.layout === "wide" ? " · " + r.left : "") });
    var ico = el("span", { html: PLAY, "aria-hidden": "true" }).firstChild;
    return el("div", { cls: "item render", role: "listitem", "aria-label": title + ", " + label }, [ico, body, side]);
  }
  /** The change list in the machine-output box: "Title › Opacity" then "<s>100</s> → 0" (at most 2, then "+N more"). */
  function changeReport(list) {
    var box = el("div", { cls: "report" });
    list.slice(0, 2).forEach(function (l) {
      var c = UI.changeParts(l);
      box.appendChild(el("span", { text: c.path }));
      if (c.from !== undefined) box.appendChild(el("span", {}, [el("s", { text: c.from }), " → " + c.to]));
    });
    if (list.length > 2) box.appendChild(el("span", { cls: "muted", text: "+" + (list.length - 2) + " more" }));
    return box;
  }
  /** One line for a change: "Title › Opacity <s>100</s> → 0 · +1" (the first change, then how many more). */
  function changeInline(list) {
    var c = UI.changeParts(list[0]), out = [c.path];
    if (c.from !== undefined) out.push(" ", el("s", { text: c.from }), " \u2192 " + c.to);
    if (list.length > 1) out.push(" \u00b7 +" + (list.length - 1));
    return out;
  }
  function feedItem(it, first) {
    var k = UI.entryKey(it.entry), open = !!S.open[k];
    var st = UI.statusOf(it);
    var cls = "item " + it.kind + (it.undoable ? " can-undo" : "");
    var time = UI.hhmm(it.at);
    var list = it.entry.changeList || it.entry.changeLines;
    // the software's own words (file names, change lists, what was read) are mono
    var monoLine = it.kind === "read" || it.kind === "proof" || it.kind === "change";
    var title = el("span", { cls: "title", text: it.title });
    var lineKids = list && list.length && it.kind === "change" ? changeInline(list) : [it.line];
    var inline = el("span", { cls: "inline" + (monoLine ? " time" : " muted") }, it.line ? [" "].concat(lineKids) : []);
    var meta = el("span", { cls: "meta" }, [st.word ? el("span", { cls: "st st-" + st.glyph, text: st.word }) : null, el("span", { cls: "time num", text: time })]);
    var row1 = el("div", { cls: "row1" }, [el("span", { cls: "tline" }, [title, inline]), meta]);
    var body = el("div", { cls: "body" }, [row1]);
    var details = it.kind === "read" && !it.group ? null : function () { toggleDetails(k); };
    if (first && it.kind === "change" && list && list.length) body.appendChild(changeReport(list));
    else body.appendChild(el("div", { cls: "line" + (monoLine ? " mono" : "") }, it.line ? lineKids : []));
    var acts = el("div", { cls: "acts" });
    var side = el("div", { cls: "side-act" });
    if (it.undoable) {
      acts.appendChild(button("btn small", "Undo", function () { undo(it); }, { "aria-label": "Undo " + it.title }));
      side.appendChild(button("btn small", "Undo", function () { undo(it); }, { "aria-label": "Undo " + it.title }));
    }
    if (it.kind === "change" || it.kind === "problem") {
      if (first) acts.appendChild(button("link under", open ? "Hide details" : "Details", details, { "aria-expanded": open ? "true" : "false" }));
      // the two-column layout has room for "Show" on problems (the boards show it there only)
      if (!it.undoable && it.kind === "problem") side.appendChild(button("btn small wide-only", open ? "Hide" : "Show", details, { "aria-expanded": open ? "true" : "false", "aria-label": "Show " + it.title }));
    }
    if (acts.children.length) body.appendChild(acts);
    // Undo isn't possible any more: say why, instead of a button that can't work
    if (it.undoBlocked) body.appendChild(el("div", { cls: "noundo", text: "Can’t undo here: the project changed since. Use Edit › Undo in After Effects." }));
    var node = el("div", { cls: cls + (details ? " clickable" : ""), role: "listitem" }, [glyph(st.glyph, st.word || "Read only"), body, side]);
    if (details) {
      node.title = open ? "Click to hide what happened" : "Click for what happened";
      node.onclick = function (ev) { if (ev.target.tagName !== "BUTTON" && !(window.getSelection && String(window.getSelection()))) details(); };
    }
    if (open) {
      var pre = el("pre", { cls: "details", text: UI.entryDetails(it.entry, it.group) });
      if (S.layout === "wide") node.appendChild(pre);
      else body.appendChild(pre);
    }
    return node;
  }
  function toggleDetails(k) {
    if (S.open[k]) delete S.open[k];
    else S.open[k] = true;
    renderFeed(true);
  }
  /**
   * Undo the most recent change: Edit > Undo, like ae_undo. When the log records the project
   * revision after the call (newer servers), only if nothing changed the project since.
   */
  function undo(it) {
    var e = it.entry;
    if (!UI.canUndo(e, S.current)) return toast("The project changed since then: use Edit \u203a Undo in After Effects.", true);
    // checked again inside After Effects, right before: same project, nothing changed since
    var script = "(function(){if(!app.project)return 'no project';" +
      "var f=app.project.file?app.project.file.fsName:'';if(f!==" + JSON.stringify(e.project) + ")return 'changed';" +
      "try{if(app.project.revision!==" + e.revision + ")return 'changed';}catch(x){return 'changed';}" +
      "app.executeCommand(16);return 'undone';})()";
    evalAE(script, "panel undo", function (err, r) {
      if (err) return toast("Could not undo: " + err.message, true);
      if (r === "changed") return toast("The project changed since then: use Edit \u203a Undo in After Effects.", true);
      if (r !== "undone") return toast("Nothing to undo: no project is open.", true);
      S.undone[UI.entryKey(e)] = true;
      renderFeed(true);
      toast("Undone: " + it.title + ". Edit \u203a Redo brings it back.");
    });
  }

  /**
   * This After Effects and its open project ({ port, pid, project, revision }), for Undo: read once for each
   * newest entry that could be undone here, right after the AI's call (After Effects just took a script, so no
   * dialog is open), never while busy. Not polled: a script sent while a dialog is open makes After Effects show
   * "Cannot run a script while a modal dialog is waiting for response" (seen live). Undo checks again anyway.
   */
  var checkedKey = null;
  function updateCurrent() {
    var e = S.activity[0], h = S.health;
    if (!e || !e.undoGroup || typeof e.revision !== "number" || e.undoSteps !== 1 || !e.instance || !h || S.undone[UI.entryKey(e)]) { S.current = null; return; }
    if (e.instance.port !== myPort || e.instance.pid !== h.pid) { S.current = null; return; }
    if (h.busy || checkedKey === UI.entryKey(e) || !secret()) return;
    checkedKey = UI.entryKey(e);
    var script = "(function(){var r='';try{r=String(app.project.revision);}catch(x){}return r+'|'+(app.project&&app.project.file?app.project.file.fsName:'');})()";
    evalAE(script, "panel: project state", function (err, r) {
      if (err || typeof r !== "string" || r.indexOf("|") < 0) { S.current = null; return renderFeed(); } // no retry: it could be a dialog
      var i = r.indexOf("|"), rev = r.slice(0, i);
      S.current = { port: myPort, pid: h.pid, project: r.slice(i + 1), revision: rev === "" ? null : Number(rev) };
      renderFeed();
    });
  }

  // ---------- diagnostics ----------
  function copyText(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
    return ok;
  }
  /** done(ok): the menu's row shows COPIED itself; otherwise (After Effects' flyout) a toast says so. */
  function copyDiagnostics(done) {
    var p = P();
    var lines = ["### Surehand MCP diagnostics", "time: " + new Date().toISOString()];
    var host = AEMCPBridge.hostInfo();
    lines.push("host: " + host.appName + " " + host.appVersion + " \u00b7 bridge v" + AEMCPBridge.VERSION + " \u00b7 port " + myPort);
    lines.push("os: " + process.platform + " " + os.release() + " " + os.arch() + " \u00b7 CEP node " + process.versions.node);
    // file:///C:/... on Windows: drop the slash before the drive letter
    try { lines.push("extension: " + decodeURI(window.__adobe_cep__.getSystemPath("extension")).replace(/^file:\/\//, "").replace(/^\/([A-Za-z]:)/, "$1")); } catch (e) {}
    lines.push("files: " + p.dir + (p.legacy ? " (1.3 location, not migrated yet)" : ""));
    var cfg = readJson(p.config);
    if (cfg) { if (cfg.token) cfg.token = "<set, " + cfg.token.length + " chars>"; lines.push("config: " + JSON.stringify(cfg)); }
    else lines.push("config: MISSING (" + p.config + ")");
    lines.push("bridge status: " + JSON.stringify(readJson(p.bridgeStatus)));
    try { lines.push("instances: " + fs.readdirSync(p.instances).join(", ")); } catch (e) {}
    lines.push("update check: " + JSON.stringify(readJson(p.updateCheck)));
    lines.push("runtime: " + JSON.stringify(readJson(p.runtime)));
    var script = "(function(){var w=null;try{w=app.preferences.getPrefAsLong('Main Pref Section','Pref_SCRIPTING_FILE_NETWORK_SECURITY')===1;}catch(e){}" +
      "return 'ae: '+app.version+' \u00b7 '+$.os+' \u00b7 items '+app.project.numItems+' \u00b7 scriptsCanWriteFiles '+w+' \u00b7 helpers '+(typeof aemcp==='undefined'?'not loaded':aemcp.version);})()";
    evalAE(script, "diagnostics", function (err, r) {
      lines.push(err ? "bridge eval: ERROR " + err.message : String(r));
      lines.push("recent activity:");
      S.activity.slice(0, 15).reverse().forEach(function (e) { lines.push("  " + e.at + " " + (e.ok ? "ok " : "ERR") + " " + e.ms + "ms " + e.tool + " " + (e.summary || "").slice(0, 120)); });
      var ok = copyText(lines.join("\n"));
      if (ok && done) return done(true);
      if (ok) toast("Diagnostics copied: paste them in a bug report or a chat");
      else toast("Could not copy to the clipboard.", true);
    });
  }

  // ---------- ☰ panel menu (After Effects' own flyout) ----------
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
  function menuXml(cfg) {
    var shell = !(cfg.permissions && cfg.permissions.allowShell === false);
    var all = cfg.toolProfile === "full";
    function item(id, label, opts) {
      opts = opts || {};
      return '<MenuItem Id="' + id + '" Label="' + esc(label) + '" Enabled="' + (opts.disabled ? "false" : "true") + '"' +
        (opts.check !== undefined ? ' Checkable="true" Checked="' + (opts.check ? "true" : "false") + '"' : "") + "/>";
    }
    var sep = '<MenuItem Label="---"/>';
    return "<Menu>" +
      item("hdrShell", "Shell commands in scripts", { disabled: true }) + item("shellYes", "Allowed", { check: shell }) + item("shellNo", "Off", { check: !shell }) + sep +
      item("hdrTools", "Tools the AI sees", { disabled: true }) + item("toolsCore", "Core (faster)", { check: !all }) + item("toolsAll", "All tools", { check: all }) + sep +
      item("connect", "Connect an AI app\u2026") + item("checkpoints", "Checkpoints\u2026") + item("history", "Activity history\u2026") + sep +
      item("test", "Test the connection") + item("diag", "Copy diagnostics") + sep +
      item("update", "Check for updates\u2026") + item("about", "About and help\u2026") +
      "</Menu>";
  }
  var shownMenu = "";
  function setMenu() {
    var xml = menuXml(S.cfg);
    if (xml === shownMenu) return;
    shownMenu = xml;
    try { window.__adobe_cep__.invokeSync("setPanelFlyoutMenu", xml); } catch (e) {}
  }
  function onMenu(id) {
    if (id === "shellYes" || id === "shellNo") {
      if (!writeConfig(function (cfg) { var p = cfg.permissions || {}; cfg.permissions = { mode: p.mode || "full", allowShell: id === "shellYes" }; })) return;
      S.cfg = readConfig();
      setMenu();
      return toast(id === "shellYes" ? "Scripts may run shell commands." : "Shell commands are blocked.");
    }
    if (id === "toolsCore" || id === "toolsAll") {
      if (!writeConfig(function (cfg) { cfg.toolProfile = id === "toolsAll" ? "full" : "core"; })) return;
      S.cfg = readConfig();
      setMenu();
      return toast("Saved. Restart your AI app to apply the tool set.");
    }
    if (id === "diag") return copyDiagnostics();
    if (SCREENS[id]) openScreen(id);
  }
  function menuIdOf(ev) {
    var d = ev && ev.data;
    if (typeof d === "string") {
      try { d = JSON.parse(d); } catch (e) {
        var m = /<menuId>([^<]+)<\/menuId>/.exec(d);
        return m ? m[1] : d;
      }
    }
    return d && (d.menuId || d.menuName);
  }
  try {
    window.__adobe_cep__.addEventListener("com.adobe.csxs.events.flyoutMenuClicked", function (ev) { onMenu(menuIdOf(ev)); });
  } catch (e) {}

  // ---------- ☰ screens ----------
  var SCREENS = {
    menu: { title: "Surehand", render: screenMenu },
    chat: { title: "Chat", render: screenChat },
    chatApps: { title: "AI apps for chat", render: screenChatApps },
    connect: { title: "Connect an AI app", render: screenConnect },
    checkpoints: { title: "Checkpoints", render: screenCheckpoints },
    history: { title: "Activity history", render: screenHistory },
    test: { title: "Connection test", render: screenTest },
    chatgpt: { title: "ChatGPT on the web", render: screenChatgpt, parent: "connect" },
    update: { title: "Updates", render: screenUpdate },
    about: { title: "About and help", render: screenAbout },
  };
  var lastFocus = null, screenToken = 0;
  function openScreen(id, from, backTo) {
    if (!S.screen) lastFocus = document.activeElement;
    // Back goes here instead of the screen's parent (ChatGPT on the web opened from the menu goes back to it)
    S.backTo = backTo || null;
    // Back from a screen opened in the menu goes to the menu; sub-screens keep their parent
    if (from !== undefined) S.from = from;
    else if (id === "menu" || !S.screen) S.from = null;
    else if (S.screen === "menu") S.from = "menu";
    // the chat comes back (from the activity history) with where it was opened from
    if (id === "chat") { if (from !== undefined) chat.from = S.from; else S.from = chat.from; }
    if (S.screen === "chat" && id !== "chat") { placeAsk(false); chatUI = null; }
    S.screen = id;
    screenToken++;
    $("screenTitle").textContent = SCREENS[id].title;
    $("screenStatus").hidden = id !== "chat" && id !== "chatApps";
    $("screenStatusGlyph").hidden = false;
    $("screenAction").innerHTML = "";
    $("screenBody").innerHTML = "";
    $("screenBody").className = "screen-body";
    $("screen").hidden = false;
    SCREENS[id].render($("screenBody"), $("screenAction"), screenToken);
    $("back").focus();
  }
  function closeScreen() {
    if (S.screen === "chat") { placeAsk(false); chatUI = null; }
    S.screen = null;
    S.from = null;
    S.backTo = null;
    screenToken++;
    $("screen").hidden = true;
    if (lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch (e) {}
  }
  /** cb runs only if the same screen is still open (answers can come back late). */
  function still(token, cb) { return function () { if (token === screenToken) cb.apply(null, arguments); }; }
  /**
   * For an answer that comes back later: draws the screen that is open now again, but only if it is still
   * the same one (the user may have opened another meanwhile: never draw a screen over a different one).
   */
  function redrawLater() {
    var token = screenToken, id = S.screen;
    var from = S.from;
    var backTo = S.backTo;
    return function () { if (id && token === screenToken && S.screen === id) openScreen(id, from, backTo); };
  }
  /** Back (and Esc): a sub-screen goes back to the screen it came from. */
  function goBack() {
    var parent = S.backTo || S.screen && SCREENS[S.screen] && SCREENS[S.screen].parent || (S.screen !== "menu" && S.from);
    if (parent) openScreen(parent);
    else closeScreen();
  }
  $("back").onclick = goBack;
  $("ver").onclick = function () { openScreen("update"); };
  function loading(body, text) { body.innerHTML = ""; body.appendChild(el("div", { cls: "loading", text: text || "Loading\u2026" })); }
  function message(body, text) { body.appendChild(el("div", { cls: "msg", text: text })); }
  var TUNNEL_HELP_URL = "https://github.com/ConformLabs/surehand-mcp/wiki/ChatGPT-on-the-web";
  function openUrl(u) {
    try { window.cep.util.openURLInDefaultBrowser(u); } catch (e) { copyText(u); toast("Link copied: " + u); }
  }

  // Connect an AI app
  function screenConnect(body, action, token) {
    loading(body);
    loadClients(still(token, function () {
      body.innerHTML = "";
      body.appendChild(el("div", { cls: "intro", text: "Surehand works with the AI apps on this computer. Set one up, then restart that app." }));
      var list = el("div", { cls: "list" });
      body.appendChild(list);
      if (S.clients.error) message(list, S.clients.error);
      var recent = UI.lastClient(S.activity), recentAt = S.activity[0] ? Date.parse(S.activity[0].at) : 0;
      S.clients.list.forEach(function (c) {
        var web = c.action === "start"; // ChatGPT on the web: a secure link that runs, not a setting
        var inUse = web ? c.configured : c.inUse !== undefined ? c.inUse : c.configured && recent === c.name && Date.now() - recentAt < 15 * 60 * 1000;
        var state, btn = null;
        if (web) {
          state = c.note || (c.configured ? "Running" : "Not running");
          btn = button("btn small", c.configured ? "Open" : "Start", function () { openScreen("chatgpt"); },
            { "aria-label": (c.configured ? "Open " : "Start ") + c.name });
        } else {
          state = c.configured ? (inUse ? "Connected \u00b7 in use now" : "Connected" + (c.note ? " \u00b7 " + shortNote(c.note) : ""))
            : c.installed === false ? "Not installed" : "Not connected" + (c.note ? " \u00b7 " + shortNote(c.note) : "");
          if (c.configured) btn = button("link", "Remove", function () { disconnectClient(c); }, { "aria-label": "Remove " + c.name });
          else if (c.installed !== false) btn = button("btn small", "Set up", function () { connectClient(c); }, { "aria-label": "Set up " + c.name });
        }
        list.appendChild(el("div", { cls: "client" + (c.configured ? "" : " unset") }, [
          el("span", { cls: "cdot", "aria-hidden": "true" }),
          el("div", { style: "flex-grow:1;min-width:0" }, [el("div", { cls: "cname", text: c.name }),
            el("div", { cls: "cstate" + (inUse ? " live" : ""), text: state, title: c.note && !web ? c.note : null })]),
          btn,
        ]));
      });
      var foot = el("div", { cls: "sfoot" }, [el("span", {}, ["Another MCP app? Use command ", el("span", { cls: "mono", text: "surehand-ae" }), " \u00b7 ",
        button("link green", "Copy the settings", copySettings)])]);
      body.appendChild(foot);
    }));
  }
  /** A note from the server, cut to its first part for the row (the whole one is the row's tooltip). */
  function shortNote(note) {
    var n = String(note).split(/[;(]/)[0].replace(/\s+$/, "");
    return n.length > 48 ? n.slice(0, 46) + "\u2026" : n;
  }
  function disconnectClient(c) {
    var redraw = redrawLater();
    runCli(["disconnect", c.id, "--json"], function (err, r) {
      if (err) return toast(err.friendly, true);
      toast(r.message || (r.ok === false ? "Could not remove " + c.name + "." : "Removed from " + c.name + ". Restart it to apply."), r.ok === false);
      loadClients(redraw);
    }, { since: "1.4.0" });
  }
  /** The MCP settings for any other app: this install's node + server. */
  function copySettings() {
    var rt = runtime();
    var snippet = S.clients && S.clients.snippet;
    if (!snippet && !rt) return toast(NO_RUNTIME, true);
    var text = typeof snippet === "string" ? snippet : JSON.stringify(snippet || { mcpServers: { "surehand-ae": { command: rt.node, args: [rt.server] } } }, null, 2);
    if (copyText(text)) toast("Settings copied: paste them into your app\u2019s MCP settings.");
    else toast("Could not copy to the clipboard.", true);
  }

  // ChatGPT on the web: the server and a secure link (tunnel) run in the background, also with this panel
  // closed (`chatgpt --background / --status / --stop`). The address contains the access key: shown here
  // and copied on request, never written to the activity feed.
  var CHAT_POLL_MS = window.SUREHAND_CHAT_POLL_MS || 1000, CHAT_WAIT_MS = window.SUREHAND_CHAT_WAIT_MS || 60000;
  var chatWaitSince = 0;
  function screenChatgpt(body, action, token) {
    loading(body);
    chatgptCli("--status", token, body);
  }
  function chatgptCli(what, token, body) {
    runCli(["chatgpt", what, "--json"], still(token, function (err, s) {
      if (err) { body.innerHTML = ""; return message(body, err.friendly); }
      drawChatgpt(body, s || {}, token);
    }), { since: "1.4.0", timeout: 30000 });
  }
  function installCommand(s) {
    return s.installCommand || (process.platform === "win32" ? "winget install --id Cloudflare.cloudflared" : "brew install cloudflared");
  }
  function copyBox(text, onCopy) {
    return el("div", { cls: "urlbox" }, [el("span", { cls: "mono", text: text }), button("btn-green-outline", "Copy", onCopy)]);
  }
  function drawChatgpt(body, s, token) {
    body.innerHTML = "";
    var st = s.state || "stopped";
    if (st !== "starting") chatWaitSince = 0;
    var box = el("div", { cls: "cg" });
    body.appendChild(box);
    var start = function () {
      chatWaitSince = Date.now();
      drawChatgpt(body, { state: "starting" }, token);
      chatgptCli("--background", token, body);
    };
    if (st === "starting") {
      if (!chatWaitSince) chatWaitSince = Date.now();
      if (Date.now() - chatWaitSince > CHAT_WAIT_MS) {
        chatWaitSince = 0;
        return drawChatgpt(body, { state: "error", error: "The secure link didn\u2019t start within a minute. Check the internet connection." }, token);
      }
      box.appendChild(el("div", { cls: "lead", role: "status", text: "Starting the secure link\u2026" }));
      box.appendChild(el("div", { cls: "line", text: "This takes a few seconds." }));
      setTimeout(still(token, function () { chatgptCli("--status", token, body); }), CHAT_POLL_MS);
    } else if (st === "running" && s.url) {
      box.appendChild(el("div", { cls: "lead", text: "ChatGPT can reach After Effects through this address." }));
      box.appendChild(copyBox(s.url, function () {
        if (copyText(s.url)) toast("Copied \u2014 keep it private: it contains your access key");
        else toast("Could not copy to the clipboard.", true);
      }));
      box.appendChild(el("ol", { cls: "steps" }, [
        el("li", { text: "In ChatGPT: Settings \u203a Apps & Connectors \u203a Advanced settings \u203a Developer mode on." }),
        el("li", { text: "Create a connector and paste this address. Authentication: No authentication." }),
        el("li", { text: "Keep this computer awake while you use it." }),
      ]));
      box.appendChild(el("div", { cls: "acts" }, [button("secondary pill sm", "Stop", function (ev) {
        ev.target.disabled = true;
        runCli(["chatgpt", "--stop", "--json"], still(token, function (err) {
          if (err) { ev.target.disabled = false; return toast(err.friendly, true); }
          toast("Stopped. ChatGPT can\u2019t reach After Effects until you start it again.");
          drawChatgpt(body, { state: "stopped" }, token);
        }), { since: "1.4.0", timeout: 30000 });
      })]));
    } else if (st === "needs-tunnel") {
      var cmd = installCommand(s);
      box.appendChild(el("div", { cls: "lead", text: "ChatGPT needs a free tunnel tool, cloudflared." }));
      box.appendChild(el("div", { cls: "line", text: "Surehand can download Cloudflare\u2019s official cloudflared into its own folder. No administrator rights needed." }));
      var progress = el("div", { cls: "line", role: "status", hidden: true });
      box.appendChild(progress);
      box.appendChild(el("div", { cls: "acts" }, [button("primary pill sm", "Install it for me", function (ev) {
        var b = ev.target;
        b.disabled = true;
        progress.hidden = false;
        progress.className = "line";
        progress.textContent = "Downloading cloudflared\u2026 This can take a minute.";
        // `chatgpt --install-tunnel`: pinned and checked (SHA-256) download into ~/.surehand/bin; then start
        runCli(["chatgpt", "--install-tunnel", "--json"], still(token, function (err, r) {
          if (err || !r || !r.ok) {
            b.disabled = false;
            progress.className = "line bad";
            progress.textContent = "Could not install cloudflared: " + (err ? err.friendly : (r && r.error) || "no answer") + ". Try again, or install it yourself (below).";
            return;
          }
          toast("cloudflared is installed.");
          start();
        }), { since: "1.4.0", timeout: 600000 });
      }), button("link", "Step-by-step guide", function () { openUrl(TUNNEL_HELP_URL); })]));
      box.appendChild(el("div", { cls: "line", text: "Or install it yourself in a terminal:" }));
      box.appendChild(copyBox(cmd, function () { if (copyText(cmd)) toast("Command copied."); else toast("Could not copy to the clipboard.", true); }));
      box.appendChild(el("div", { cls: "acts" }, [button("secondary pill sm", "Try again", start)]));
    } else if (st === "error") {
      box.appendChild(el("div", { cls: "lead bad", text: "The secure link didn\u2019t start." }));
      if (s.error) box.appendChild(el("div", { cls: "line", text: s.error }));
      box.appendChild(el("div", { cls: "acts" }, [button("primary pill sm", "Try again", start)]));
    } else {
      box.appendChild(el("div", { cls: "line", text: "ChatGPT on the web can\u2019t start programs on this computer, so Surehand opens a secure link it can reach." }));
      box.appendChild(el("div", { cls: "line", text: "It keeps running, also with this panel closed, until you stop it." }));
      box.appendChild(el("div", { cls: "acts" }, [button("primary pill sm", "Start", start)]));
    }
    if (st !== "starting") loadClients(); // the Connect screen's row
  }

  // Checkpoints
  var PROJECT_SCRIPT = "(function(){return app.project&&app.project.file?app.project.file.fsName:'';})()";
  function checkpointDir(project) {
    var name = path.basename(project, path.extname(project)).replace(/[^\w.-]+/g, "_").slice(0, 60);
    return path.join(P().checkpoints, name + "-" + crypto.createHash("sha1").update(project).digest("hex").slice(0, 8));
  }
  function readIndex(project) { return readJson(path.join(checkpointDir(project), "index.json")) || []; }
  function screenCheckpoints(body, action, token) {
    loading(body);
    action.innerHTML = "";
    evalAE(PROJECT_SCRIPT, "panel: project", still(token, function (err, project) {
      body.innerHTML = "";
      if (err) return message(body, "After Effects isn\u2019t answering: " + err.message);
      if (!project) return message(body, "Save your project first: checkpoints are copies of a saved project.");
      action.appendChild(button("btn small main", "Save one now", function (ev) { saveCheckpoint(project, token, ev && ev.target); }));
      var intro = el("div", { cls: "intro" }, ["Safety copies of ", el("span", { cls: "ink", text: path.basename(project) }),
        ". Opening one makes a new file next to your project; your project is never overwritten."]);
      body.appendChild(intro);
      var list = el("div", { cls: "list" }, [el("div", { cls: "loading", text: "Loading\u2026" })]);
      body.appendChild(list);
      body.appendChild(el("div", { cls: "sfoot", text: "50 kept per project \u00b7 oldest are removed first" }));
      runCli(["checkpoints", "--json", "--project", project], still(token, function (e2, json) {
        // without the command (older server), read the checkpoint index directly
        var cps = !e2 && json ? (Array.isArray(json) ? json : json.checkpoints || []) : readIndex(project).slice();
        // newest first (the server's list and the index file are oldest first)
        cps.sort(function (a, b) { return String(b.at || "").localeCompare(String(a.at || "")) || String(b.id).localeCompare(String(a.id)); });
        list.innerHTML = "";
        if (!cps.length) return list.appendChild(el("div", { cls: "empty", text: "No checkpoints yet for this project." }));
        cps.forEach(function (cp) { list.appendChild(checkpointCard(project, cp, token, !e2)); });
      }), { since: "1.4.0" });
    }));
  }
  function checkpointCard(project, cp, token, fromCli) {
    var acts = el("div", { cls: "cp-acts" });
    var out = el("div", { cls: "diffout", hidden: true });
    var canCompare = fromCli && (cp.history || cp.hasHistory || cp.canCompare || cp.snapshot);
    if (canCompare) acts.appendChild(button("btn small", "Compare with now", function () {
      out.hidden = false;
      out.textContent = "Comparing\u2026";
      runCli(["checkpoint-diff", cp.id, "--project", project], still(token, function (err, json, text) {
        drawDiff(out, err ? err.friendly : (json && (json.text || json.message || json.error)) || text || "No differences.");
      }), { since: "1.4.0", text: true, timeout: 120000, asPanel: true });
    }));
    acts.appendChild(button("btn small", "Open a copy", function () { openCheckpoint(project, cp); }));
    if (fromCli && !canCompare) acts.appendChild(el("span", { cls: "muted2", text: "no history snapshot" }));
    return el("div", { cls: "cp" }, [
      el("div", { cls: "cp-row" }, [el("span", { cls: "ink", style: "font-weight:600", text: cp.label || cp.id }), el("span", { cls: "muted2 num", text: UI.whenLabel(cp.at, Date.now()) })]),
      acts, out,
    ]);
  }
  /**
   * A diff from the server: the "Summary:" line first, then the changes, and where it compares from and to
   * ("From: ...", "To: ...") last, small.
   */
  function drawDiff(out, text) {
    out.innerHTML = "";
    var lines = String(text).replace(/\s+$/, "").split(/\r?\n/), head = [], sum = [], rest = [];
    lines.forEach(function (l) {
      if (/^(From|To):/.test(l)) head.push(l.replace(/\s+/g, " "));
      else if (/^Summary:/.test(l)) sum.push(l.replace(/^Summary:\s*/, ""));
      else rest.push(l);
    });
    while (rest.length && !rest[0].trim()) rest.shift();
    if (sum.length) out.appendChild(el("div", { cls: "diff-sum", text: sum.join(" ") }));
    if (rest.length) out.appendChild(el("pre", { cls: "details", text: rest.join("\n") }));
    if (head.length) out.appendChild(el("div", { cls: "diff-meta", text: head.join("\n") }));
  }
  /**
   * Save one now: through the server, as ae_checkpoint save (with its project history snapshot, so it can be
   * compared), as the panel's own job (also while the AI is paused). An older server: saved here, without one.
   */
  function saveCheckpoint(project, token, btn) {
    if (btn) btn.disabled = true;
    var done = function () { if (btn) btn.disabled = false; };
    runCli(["checkpoint-save", "--json", "--label", "saved in the panel", "--project", project], function (err, r) {
      if (err && (err.friendly === TOO_OLD || err.friendly === NO_RUNTIME)) return saveCheckpointHere(project, token, done);
      done();
      if (err || !r || r.ok === false) return toast("Could not save the checkpoint: " + ((r && (r.error || r.message)) || (err && err.friendly) || "no answer"), true);
      toast(r.checkpoint && r.checkpoint.history ? "Checkpoint saved." : "Checkpoint saved (no history snapshot, so it can\u2019t be compared).");
      if (token === screenToken && S.screen === "checkpoints") openScreen("checkpoints");
    }, { since: "1.4.0", asPanel: true, timeout: 300000 });
  }
  /** As ae_checkpoint save, without the history snapshot: save the project, keep a timestamped copy (50 per project). */
  function saveCheckpointHere(project, token, done) {
    evalAE("(function(){var p=app.project;if(!p.file)return '';p.save();return p.file.fsName;})()", "panel: checkpoint", function (err, saved) {
      if (err || !saved) { done(); return toast(err ? "Could not save: " + err.message : "Save your project first.", true); }
      try {
        var dir = checkpointDir(saved);
        fs.mkdirSync(dir, { recursive: true });
        var id = new Date().toISOString().replace(/[:T]/g, "-").replace(/\..+$/, "");
        var file = path.join(dir, id + "-saved_in_the_panel.aep");
        fs.copyFileSync(saved, file);
        var index = readIndex(saved);
        index.push({ id: id, at: new Date().toISOString(), label: "saved in the panel", file: file, project: saved });
        while (index.length > 50) { var old = index.shift(); try { fs.unlinkSync(old.file); } catch (e) {} }
        fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(index, null, 2));
        toast("Checkpoint saved (no history snapshot: update the Surehand server to compare checkpoints).");
        if (token === screenToken && S.screen === "checkpoints") openScreen("checkpoints");
      } catch (e) { toast("Could not save the checkpoint: " + e.message, true); }
      done();
    }, 300000);
  }
  /** As ae_checkpoint restore: copy it next to the project under a new name and open that. */
  function openCheckpoint(project, cp) {
    if (!cp.file || !fs.existsSync(cp.file)) return toast("That checkpoint file is missing.", true);
    evalAE("(function(){return app.project.dirty?'dirty':'clean';})()", "panel: project", function (err, d) {
      if (err) return toast("After Effects isn\u2019t answering: " + err.message, true);
      if (d === "dirty") return toast("Save your project first: it has unsaved changes.", true);
      var base = path.join(path.dirname(project), path.basename(project, path.extname(project)) + " (restored " + cp.id), target;
      for (var n = 1; ; n++) { target = base + (n > 1 ? " " + n : "") + ").aep"; if (!fs.existsSync(target)) break; }
      try { fs.copyFileSync(cp.file, target, fs.constants.COPYFILE_EXCL); } catch (e) { return toast("Could not copy it: " + e.message, true); }
      var script = "(function(){var f=new File(" + JSON.stringify(target) + ");app.open(f);return app.project.file&&app.project.file.fsName===f.fsName?'ok':'no';})()";
      evalAE(script, "panel: open checkpoint", function (e2, r) {
        if (e2 || r !== "ok") { try { fs.unlinkSync(target); } catch (x) {} return toast("After Effects did not open the copy.", true); }
        toast("Opened a copy: " + path.basename(target));
        closeScreen();
      }, 300000);
    });
  }

  // Activity history
  function screenHistory(body) {
    readActivity(4 * 1024 * 1024, true);
    var all = S.activity.map(function (e) { return { item: UI.describeEntry(e), e: e }; });
    var filter = "all", query = "";
    var problems = all.filter(function (x) { return x.item.kind === "problem"; }).length;
    var apps = {};
    all.forEach(function (x) { if (x.e.client) apps[UI.clientName(x.e.client)] = true; });
    var manyApps = Object.keys(apps).length > 1;
    var search = el("input", { id: "hsearch", placeholder: "Search layers, comps, tools\u2026", type: "search", autocomplete: "off" });
    var filters = el("div", { cls: "filters", role: "group", "aria-label": "Show" });
    [["all", "All"], ["change", "Changes"], ["problem", "Problems" + (problems ? " " + problems : "")]].forEach(function (f) {
      var b = button("", f[1], function () { filter = f[0]; draw(); });
      b.setAttribute("data-f", f[0]);
      filters.appendChild(b);
    });
    body.appendChild(el("div", { cls: "hsearch" }, [el("label", { "for": "hsearch", cls: "sr", text: "Search the history" }), search, filters]));
    var list = el("div", { cls: "list" });
    body.appendChild(list);
    body.appendChild(el("div", { cls: "sfoot" }, [el("span", { text: "Click an entry for what changed" }), button("link green", "Open log file", openLogFile)]));
    var open = {};
    function draw() {
      Array.prototype.forEach.call(filters.children, function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-f") === filter ? "true" : "false"); });
      list.innerHTML = "";
      var day = null, shown = 0;
      all.forEach(function (x) {
        if (filter !== "all" && x.item.kind !== filter) return;
        var hay = (x.item.title + " " + x.item.line + " " + x.e.tool + " " + (x.e.client || "") + " " + JSON.stringify(x.e.args || {})).toLowerCase();
        if (query && hay.indexOf(query) < 0) return;
        if (shown >= 300) return;
        shown++;
        var d = UI.dayLabel(x.e.at, Date.now());
        if (d !== day) { day = d; list.appendChild(el("div", { cls: "day", text: d })); }
        var k = UI.entryKey(x.e);
        var sub = [x.item.line, manyApps ? UI.clientName(x.e.client) : null].filter(Boolean).join(" \u00b7 ");
        var st = UI.statusOf(x.item);
        var row = el("button", { type: "button", cls: "hrow " + x.item.kind + (x.item.kind === "problem" ? " bad" : ""), "aria-expanded": open[k] ? "true" : "false" }, [
          el("span", { cls: "g g-" + st.glyph, role: "img", "aria-label": st.word || "Read only" }),
          el("span", { cls: "htime num", text: UI.hhmm(x.e.at) }),
          el("span", { cls: "hmain" }, [el("span", { cls: "htitle", text: x.item.title }), sub ? el("span", { cls: "hline", text: sub }) : null]),
        ]);
        row.onclick = function () { if (open[k]) delete open[k]; else open[k] = true; draw(); };
        list.appendChild(row);
        if (open[k]) list.appendChild(el("pre", { cls: "details", text: UI.entryDetails(x.e) }));
      });
      if (!shown) list.appendChild(el("div", { cls: "empty", text: all.length ? "Nothing matches." : "No activity yet." }));
    }
    search.oninput = function () { query = search.value.trim().toLowerCase(); draw(); };
    draw();
  }
  function openLogFile() {
    var file = P().activity;
    if (!fs.existsSync(file)) return toast("No activity yet.");
    if (process.platform === "win32") childProcess.execFile("explorer", ["/select,", file]);
    else childProcess.execFile("open", ["-R", file]);
  }

  // Connection test
  function screenTest(body, action, token) {
    action.innerHTML = "";
    var again = button("btn", "Run again", function () { openScreen("test"); });
    again.disabled = true;
    action.appendChild(again);
    loading(body, "Testing\u2026");
    runCli(["test", "--json"], still(token, function (err, json) {
      if (!err && json && json.checks) return showChecks(body, json.checks, again);
      // the panel's own checks when the server can't run them
      localChecks(still(token, function (checks) { showChecks(body, checks, again, err && err.friendly); }));
    }), { since: "1.4.0", timeout: 120000, asPanel: true });
  }
  function localChecks(cb) {
    var checks = [], host = AEMCPBridge.hostInfo();
    call("GET", "/health", null, function (err, h) {
      checks.push({ ok: !err && h && h.authorized !== false, name: err ? "The bridge isn\u2019t answering: " + err.message : "Bridge running in " + UI.aeLabel(host.appVersion) });
      checks.push({ ok: !!readJson(P().config), name: readJson(P().config) ? "Settings file found" : "Settings file missing" });
      var rt = runtime();
      checks.push({ ok: !!rt, name: rt ? "Server " + (rt.version || "") + " installed" : "Server not installed with the installer" });
      var script = "(function(){var w='?';try{w=app.preferences.getPrefAsLong('Main Pref Section','Pref_SCRIPTING_FILE_NETWORK_SECURITY');}catch(e){}" +
        "return 'After Effects '+app.version+'|'+w;})()";
      evalAE(script, "panel test", function (e2, r) {
        var parts = String(r).split("|");
        checks.push({ ok: !e2, name: e2 ? "Scripts don\u2019t run: " + e2.message : "Scripts run (" + parts[0] + ")" });
        var write = !e2 && UI.writeAccessCheck(parts[1] === "1" ? true : parts[1] === "0" ? false : null, process.platform);
        if (write) checks.push(write);
        cb(checks);
      });
    });
  }
  var CHECK_NAMES = { update: "Updates", config: "Settings file", extension: "After Effects extension", signature: "Extension signature",
    bridge: "Bridge", extendscript: "Scripting", "scripting-prefs": "Shell and network", node: "Node.js", server: "Server", ffmpeg: "ffmpeg", migration: "Move from 1.3" };
  function tilde(t) { var h = os.homedir(); return h ? String(t).split(h).join("~") : String(t); }
  function showChecks(body, checks, again, note) {
    again.disabled = false;
    body.innerHTML = "";
    var passed = checks.filter(function (c) { return c.ok; }).length, failed = checks.length - passed;
    // "8 of 9 checks passed" (numbers in mono), then "1 to fix · checked 14:06"
    body.appendChild(el("div", { cls: "tsum" }, [
      el("div", { cls: "tsum-title" }, [el("span", { cls: "mono", text: String(passed) }), " of ", el("span", { cls: "mono", text: String(checks.length) }), " checks passed"]),
      el("span", { cls: "mono-s num", text: (failed ? failed + " to fix" : "Nothing to fix") + " · checked " + UI.hhmm(new Date().toISOString()) }),
    ]));
    // failing checks first, open, with what to do; the passing ones one line each
    var list = el("div", { cls: "tlist" });
    checks.filter(function (c) { return !c.ok; }).forEach(function (c) { list.appendChild(failedCheck(c)); });
    checks.filter(function (c) { return c.ok; }).forEach(function (c) { list.appendChild(passedCheck(c)); });
    body.appendChild(list);
    if (note) message(body, note);
  }
  /**
   * A check as { label, text }: the server's message says what was checked and what was found; a known name
   * ("update", "config"...) is the label, and "Claude Desktop: its settings ..." gives its own.
   */
  function checkText(c) {
    var name = c.name || c.label || c.title || c.id;
    var text = tilde(c.message || "");
    var label = CHECK_NAMES[name] || null;
    if (!label && text) {
      var m = /^([^:.]{2,40}):\s+(.+)$/.exec(text);
      if (m) { label = m[1]; text = m[2].charAt(0).toUpperCase() + m[2].slice(1); }
    }
    if (!text) text = tilde(name);
    return { label: label, text: text };
  }
  /** Versions, years and paths in mono (what the software says or measures). */
  function withMono(text) {
    var out = [], re = /(~[\\/][^\s,;]+|\b\d+(?:\.\d+)+\b|\b(?:19|20)\d\d\b)/g, at = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > at) out.push(text.slice(at, m.index));
      out.push(el("span", { cls: "mono", text: m[1] }));
      at = m.index + m[1].length;
    }
    if (at < text.length) out.push(text.slice(at));
    return out;
  }
  function passedCheck(c) {
    var t = checkText(c), text = t.text.replace(/\.$/, "");
    return el("div", { cls: "check", title: (t.label ? t.label + ": " : "") + t.text }, [
      el("span", { cls: "g g-verified", role: "img", "aria-label": "Passed" }),
      el("span", { cls: "ctext" }, (t.label ? [el("span", { cls: "clabel-s", text: t.label + " · " })] : []).concat(withMono(text))),
      el("span", { cls: "st st-verified", text: "Passed" }),
    ]);
  }
  function failedCheck(c) {
    var t = checkText(c);
    var fixId = c.fix && (c.fix.connect || c.fix.client);
    var label = c.fix && c.fix.label;
    var fix = fixId ? button("btn small main", label || "Fix", function () { connectClient({ id: fixId, name: c.fix.name || t.label || fixId }); },
      { "aria-label": label || "Fix: " + t.text }) : null;
    return el("div", { cls: "check bad" }, [
      el("span", { cls: "g g-failed", role: "img", "aria-label": "Failed" }),
      el("div", { cls: "cbody" }, [
        el("div", { cls: "chead" }, [el("span", { cls: "clabel", text: t.label || t.text }), el("span", { cls: "st st-failed", text: "Failed" })]),
        t.label ? el("span", { cls: "cmain" }, withMono(t.text)) : null,
        fix,
      ]),
    ]);
  }
  // Updates
  /**
   * The last update check on the channel set in config.json (Settings › Beta updates): this session's, else
   * update-check.json, which the server writes. Read from the file, never from After Effects; null when the
   * check was made on the other channel.
   */
  function knownUpdate() {
    var ch = UI.updateChannel(S.cfg);
    return UI.updateFor(S.update, ch) || UI.updateFor(readJson(P().updateCheck), ch);
  }
  function screenUpdate(body, action, token) {
    var cached = knownUpdate();
    drawUpdate(body, cached, true);
    runCli(["update", "--check", "--json"], still(token, function (err, json) {
      if (!err && json) { S.update = json; drawUpdate(body, json, false); }
      else drawUpdate(body, cached, false, err && err.friendly);
    }), { since: "1.4.0", timeout: 30000 });
  }
  /** Settings › Beta updates: config.json updateChannel ("beta", or no key for stable), which the server's update reads. */
  function saveChannel(channel) {
    if (!writeConfig(function (cfg) { if (channel === "beta") cfg.updateChannel = "beta"; else delete cfg.updateChannel; })) return false;
    S.cfg = readConfig();
    S.update = knownUpdate(); // the last check on the other channel no longer counts
    renderHeader();
    toast(UI.channelToast(channel));
    return true;
  }
  /** Checks on the new channel in the background (the server's command line, not After Effects): "update ready" follows. */
  function checkChannel() {
    var redraw = redrawLater();
    runCli(["update", "--check", "--json"], function (err, json) {
      if (err || !json || !json.latest) return;
      S.update = json;
      renderHeader();
      if (S.screen === "menu") redraw();
    }, { since: "1.4.0", timeout: 30000 });
  }
  /** A release-notes line: bold, inline code in the mono font, a heading as a bold line; all of it as text, never HTML. */
  function noteItem(line) {
    var v = UI.noteView(line);
    return el("li", { cls: v.heading ? "h" : null }, noteParts(v.parts, v.heading));
  }
  /** noteView's pieces as text nodes: bold, inline code in the mono font (also the chat's answers). */
  function noteParts(parts, allBold) {
    return parts.map(function (p) {
      return p.bold || allBold ? el("b", { text: p.text, cls: p.code ? "mono" : null }) : p.code ? el("span", { cls: "mono", text: p.text }) : p.text;
    });
  }
  var updating = false, updatedTo = null;
  function drawUpdate(body, u, checking, note) {
    body.innerHTML = "";
    var current = AEMCPBridge.VERSION, latest = u && u.latest;
    var avail = latest && UI.cmpVersions(latest, current) > 0;
    var rt = runtime();
    var card = el("div", { cls: "upd" + (avail ? "" : " current") });
    if (updatedTo) {
      card.appendChild(el("div", { cls: "upd-head" }, [el("span", { cls: "v", text: "Updated to " + updatedTo })]));
      card.appendChild(el("div", { cls: "note", text: "Restart After Effects and your AI apps to finish." }));
    } else if (avail) {
      card.appendChild(el("div", { cls: "upd-head" }, [el("span", { cls: "v", text: latest + " is ready" }), el("span", { cls: "have", text: "you have " + current })]));
      var notes = u.notes || u.highlights;
      if (notes && notes.length) card.appendChild(el("ul", {}, notes.slice(0, 5).map(noteItem)));
      if (u.url) card.appendChild(button("link green under", "What’s new", function () { openUrl(u.url); }));
      var b = button("btn main big", updating ? "Updating\u2026" : rt ? "Update now" : "Download", function () {
        if (!rt) return openUrl(u.url || REPO_URL + "/releases/latest");
        runUpdate(body, latest);
      });
      b.disabled = updating;
      card.appendChild(b);
      card.appendChild(el("div", { cls: "note", text: rt ? "Takes a few seconds. Restart After Effects and your AI apps afterwards." : "Download the installer and run it." }));
    } else {
      card.appendChild(el("div", { cls: "upd-head" }, [el("span", { cls: "v", text: checking ? "Checking\u2026" : "You\u2019re up to date" }), el("span", { cls: "have", text: "version " + current })]));
      // back on stable with a newer beta: it stays (an update never goes back)
      var kept = !checking && UI.keptBetaText(UI.updateChannel(S.cfg), latest, current);
      if (kept) card.appendChild(el("div", { cls: "note", text: kept }));
    }
    body.appendChild(card);
    var autoOn = S.cfg.updateCheck !== false;
    var autoBtn = button("link green", autoOn ? "once a day" : "off", function () {
      if (!writeConfig(function (cfg) { if (autoOn) cfg.updateCheck = false; else delete cfg.updateCheck; })) return;
      S.cfg = readConfig();
      toast(autoOn ? "Surehand won\u2019t look for updates by itself." : "Surehand looks for updates once a day.");
      drawUpdate(body, u, checking, note);
    }, { title: "Click to turn " + (autoOn ? "off" : "on"), "aria-label": "Check automatically: " + (autoOn ? "once a day" : "off") + ". Click to turn " + (autoOn ? "off" : "on") });
    if (!autoOn) autoBtn.style.color = "#A6A49D";
    body.appendChild(el("div", { cls: "kv" }, [
      el("div", {}, [el("span", { text: "Check automatically" }), autoBtn]),
      el("div", {}, [el("span", { text: "Last checked" }), el("span", { cls: "mono-s num", text: u && u.checkedAt ? UI.whenLabel(u.checkedAt, Date.now()) : "not yet" })]),
      button("link green", "See all release notes", function () { openUrl(REPO_URL + "/releases"); }),
    ]));
    if (note) { body.appendChild(el("div", { style: "height:10px" })); message(body, note); }
    body.appendChild(el("div", { cls: "spacer" }));
    body.appendChild(el("div", { cls: "sfoot", text: "Updates come only from the official release and are checked before they\u2019re installed." }));
  }
  function runUpdate(body, latest) {
    var token = screenToken;
    updating = true;
    drawUpdate(body, knownUpdate() || { latest: latest }, false);
    runCli(["update", "--json"], function (err, r) {
      updating = false;
      if (r && r.ok && r.updated) { updatedTo = r.to; renderHeader(); toast("Updated to " + r.to + ". Restart After Effects and your AI apps to finish."); }
      else toast((r && r.message) || (err && err.friendly) || "The update did not finish.", true);
      if (token === screenToken && S.screen === "update") drawUpdate(body, knownUpdate() || { latest: latest }, false);
    }, { timeout: 180000 });
  }

  // Chat with your AI app: an agent the user already has (Codex, Claude Code, Antigravity), on their own sign-in,
  // with Surehand as its only tools (`surehand-ae chat`, server/src/chat). Its calls are an AI app's calls: the
  // mode (Full / Ask / Read-only), Pause and the approval card apply, and the feed lists them. Each turn is a
  // process of its own, so the panel never waits; Stop asks it to end the agent. The approval card moves into the
  // chat while it is open (the same card, the same answers).
  var CHAT_LEVEL = 2; // runtime.json panelCommands that has `chat`
  var chat = S.chat = { agents: null, agent: null, items: [], running: false, session: null, proc: null, loading: false, used: {}, from: null, error: null };
  try { chat.agent = window.localStorage.getItem("surehand.chat.agent"); } catch (e) {}
  function chatTooOld() { var rt = runtime(); return !!(rt && !(rt.panelCommands >= CHAT_LEVEL) && rt.version); }
  function loadAgents(cb) {
    if (chat.loading) return;
    if (chatTooOld()) { chat.error = TOO_OLD; if (cb) cb(); return; }
    chat.loading = true;
    runCli(["chat", "--agents", "--json"], function (err, json) {
      chat.loading = false;
      if (err || !json || !json.agents) chat.error = err ? err.friendly : "No answer.";
      else { chat.error = null; chat.agents = json.agents; }
      if (chat.agents && !chat.running) chat.agent = UI.chatPick(chat.agents, chat.agent);
      if (cb) cb();
    }, { timeout: 45000 });
  }
  function setChatAgent(id) {
    if (chat.running || id === chat.agent) return;
    chat.agent = id;
    chat.items = [];
    chat.session = null;
    try { window.localStorage.setItem("surehand.chat.agent", id); } catch (e) {}
    drawChat();
  }
  /** The open project, as the activity log last saw it (the agent is told to look anyway). */
  function chatProject() {
    for (var i = 0; i < S.activity.length; i++) if (S.activity[i] && typeof S.activity[i].project === "string" && S.activity[i].project) return S.activity[i].project;
    return null;
  }
  function chatSend(text) {
    text = String(text || "").replace(/\s+$/, "");
    if (!text || chat.running || !chat.agent) return;
    var rt = runtime();
    if (!rt) return toast(NO_RUNTIME, true);
    if (chatTooOld()) return toast(TOO_OLD, true);
    var args = [rt.server, "chat", "--agent", chat.agent];
    if (chat.session) args.push("--session", chat.session);
    var child;
    try { child = childProcess.spawn(rt.node, args, { env: cliEnv(), windowsHide: true }); } catch (e) { return toast("Could not start the chat: " + e.message, true); }
    chat.items.push({ kind: "user", text: text, at: new Date().toISOString() });
    chat.running = true;
    chat.replyHead = true;
    chat.proc = child;
    var buf = "", ended = false;
    function finish(ev) {
      if (ended) return;
      ended = true;
      if (chat.proc === child) chat.proc = null;
      UI.chatApply(chat, ev, new Date().toISOString());
      drawChat();
    }
    child.stdout.on("data", function (d) {
      buf += d;
      var lines = buf.split("\n");
      buf = lines.pop();
      lines.forEach(function (l) {
        var ev = null;
        try { ev = JSON.parse(l); } catch (e) { return; }
        if (!ev || ended) return;
        if (ev.type === "done") return finish(ev);
        UI.chatApply(chat, ev, new Date().toISOString());
        drawChatSoon();
      });
    });
    child.stdin.on("error", function () {});
    child.on("error", function (e) { UI.chatApply(chat, { type: "error", message: "Could not start the chat: " + e.message }, new Date().toISOString()); finish({ type: "done", ok: false }); });
    child.on("close", function () { finish({ type: "done", ok: false }); });
    child.stdin.write(JSON.stringify({ text: text, project: chatProject() }) + "\n");
    drawChat();
  }
  /** Stop: the runner ends the agent (and what it started); killed here if it doesn't within 8 s. */
  function chatStop() {
    var child = chat.proc;
    if (!child) return;
    try { child.stdin.write(JSON.stringify({ stop: true }) + "\n"); } catch (e) {}
    setTimeout(function () { if (chat.proc === child) try { child.kill(); } catch (e) {} }, 8000);
  }
  function chatNew() {
    chatStop();
    chat.items = [];
    chat.session = null;
    chat.running = false;
    chat.proc = null;
    drawChat();
    if (chatUI) chatUI.input.focus();
  }
  function chatAction(id) {
    if (id === "check") { chat.agents = null; chat.error = null; drawChat(); return loadAgents(drawChat); }
    if (id === "apps") return openScreen("chatApps", "chat", "chat");
    if (id.indexOf("use:") === 0) return setChatAgent(id.slice(4));
    if (id === "connect") {
      runCli(["chat", "--connect", "agy", "--json"], function (err, r) {
        if (err) return toast(err.friendly, true);
        toast(r.message || (r.ok ? "Connected." : "Could not connect."), r.ok === false);
        loadAgents(drawChat);
      }, { timeout: 60000 });
    }
  }

  // the screen: built once when opened (the text field keeps what's typed), then drawn again on every event
  var chatUI = null, chatTimer = null;
  function screenChat(body, action) {
    body.className = "screen-body chat";
    var newBtn = button("btn", "New chat", chatNew);
    action.appendChild(newBtn);
    var input = el("textarea", { id: "chatInput", cls: "cinput", rows: "3" });
    var send = button("btn main", "Send", function () { if (chat.running) chatStop(); else { var t = input.value; input.value = ""; chatSend(t); } });
    input.onkeydown = function (e) {
      if (e.keyCode === 13 && !e.shiftKey) {
        e.preventDefault();
        if (!chat.running && !send.disabled) { var t = input.value; input.value = ""; chatSend(t); }
      }
    };
    chatUI = {
      newBtn: newBtn, input: input, send: send,
      top: el("div"), list: el("div", { cls: "clist", role: "log", "aria-label": "Chat", "aria-live": "polite" }), msgs: el("div", { cls: "cmsgs" }),
      hint: el("span", { cls: "time" }),
    };
    chatUI.list.appendChild(chatUI.msgs);
    body.appendChild(chatUI.top);
    body.appendChild(chatUI.list);
    body.appendChild(el("div", { cls: "cfoot" }, [el("label", { cls: "label", "for": "chatInput", text: "Message" }), input, el("div", { cls: "cbar" }, [chatUI.hint, send])]));
    drawChat();
    if (!chat.agents) loadAgents(drawChat);
  }
  function drawChatSoon() {
    if (chatTimer) return;
    chatTimer = setTimeout(function () { chatTimer = null; drawChat(); }, 60);
  }
  /** The approval card and "withdrawn" go into the chat while it is open, back to the main view after. */
  function placeAsk(inChat) {
    var ask = $("ask"), gone = $("askGone"), right = document.querySelector("main.right");
    if (inChat && chatUI) { chatUI.list.appendChild(gone); chatUI.list.appendChild(ask); }
    else if (right && ask.parentNode !== right) { right.insertBefore(ask, $("setup")); right.insertBefore(gone, ask); }
  }
  function chatState() {
    return { agents: chat.agents, agent: chat.agent, items: chat.items, running: chat.running, asking: chat.running && !$("ask").hidden, error: chat.error };
  }
  function drawChat() {
    if (S.screen !== "chat" || !chatUI) return;
    var v = UI.chatView(chatState(), process.platform), a = chatUI;
    // no AI app ready: "AI apps for chat" says how to set one up (Back goes where the chat would)
    if (v.apps) return setTimeout(function () { if (S.screen === "chat") openScreen("chatApps", chat.from, chat.from); }, 0);
    $("screenStatusGlyph").className = "g g-sm g-" + v.status.glyph;
    $("screenStatusText").textContent = v.status.text;
    a.newBtn.disabled = v.newChat.disabled;
    // top: the agent picker and what it does, or what to do first
    a.top.innerHTML = "";
    if (v.picker || v.single) {
      // the AI apps that are ready: a choice with two or more, its name with one
      var pick = v.single ? el("div", { cls: "title", text: v.single }) : el("div", { cls: "seg", role: "radiogroup", "aria-labelledby": "chatWith", style: "grid-template-columns:repeat(" + v.picker.length + ",minmax(0,1fr))" });
      (v.picker || []).forEach(function (p) {
        pick.appendChild(button("", p.label, function () { setChatAgent(p.id); }, { role: "radio", "aria-checked": p.checked ? "true" : "false", tabindex: p.checked ? "0" : "-1" }));
      });
      a.top.appendChild(el("div", { cls: "modes" }, [el("span", { id: "chatWith", cls: "label", text: "Chat with" }), pick, v.desc ? el("div", { cls: "desc", text: v.desc }) : null,
        v.addLink ? button("link", v.addLink, function () { chatAction("apps"); }) : null]));
    }
    if (v.note) {
      var acts = el("div", { cls: "setup-acts" });
      v.note.buttons.forEach(function (b) { acts.appendChild(button("btn small" + (b.main ? " main" : ""), b.text, function () { chatAction(b.id); })); });
      a.top.appendChild(el("div", { cls: "notebox" + (v.note.kind === "none" ? "" : " amber") }, [
        el("span", { cls: "title", text: v.note.title }),
        el("span", { cls: "muted", text: v.note.text }),
        v.note.steps.length ? el("ol", { cls: "steps" }, v.note.steps.map(function (s) {
          return el("li", {}, s.map(function (p) { return typeof p === "string" ? p : el("span", { cls: "mono", text: p.mono }); }));
        })) : null,
        v.note.says ? el("span", { cls: "mono-s", text: UI.chatLabel(chat.agent) + " says: " + v.note.says }) : null,
        acts,
      ]));
    }
    // the conversation (or what to try)
    var stick = a.list.scrollHeight - a.list.scrollTop - a.list.clientHeight < 40;
    a.msgs.innerHTML = "";
    a.list.className = "clist" + (chat.items.length ? "" : " fresh");
    if (v.tries) {
      a.msgs.appendChild(el("div", { cls: "tries" }, [el("span", { cls: "label", text: "Try" })].concat(v.tries.map(function (t) {
        return button("btn", t, function () { chatSend(t); });
      }))));
    }
    drawChatItems(a.msgs);
    placeAsk(true);
    if (stick || chat.running) a.list.scrollTop = a.list.scrollHeight;
    // the message field
    a.input.disabled = v.input.disabled;
    a.input.placeholder = v.input.placeholder;
    a.hint.textContent = v.hint || "";
    a.hint.hidden = !v.hint;
    a.send.textContent = v.button.text;
    a.send.className = "btn" + (v.button.main ? " main" : "");
    a.send.disabled = v.button.disabled;
  }
  // AI apps for chat: each one's state as its own command line says, and how to set it up
  function screenChatApps(body, action, token) {
    action.appendChild(button("btn", "Check again", function () {
      chat.agents = null;
      chat.error = null;
      drawChatApps(body);
      loadAgents(still(token, function () { drawChatApps(body); }));
    }));
    drawChatApps(body);
    if (!chat.agents) loadAgents(still(token, function () { drawChatApps(body); }));
  }
  function drawChatApps(body) {
    $("screenStatusGlyph").hidden = true;
    body.innerHTML = "";
    if (!chat.agents) {
      $("screenStatusText").textContent = chat.error ? "Couldn\u2019t look for AI apps" : "Checking\u2026";
      return chat.error ? message(body, chat.error) : loading(body, "Checking your AI apps\u2026");
    }
    var v = UI.chatAppsView(chat.agents, process.platform);
    $("screenStatusText").textContent = v.sub;
    var list = el("div", { cls: "capps" });
    v.rows.forEach(function (r) {
      var kids = [el("div", { cls: "row1" }, [el("span", { cls: "tline" }, [el("span", { cls: "title", text: r.label })]), el("span", { cls: "meta" }, [el("span", { cls: "st st-" + r.glyph, text: r.word })])])];
      r.lines.forEach(function (l) {
        if (typeof l === "string") kids.push(el("div", { cls: "line", text: l }));
        else if (l.report) kids.push(el("div", { cls: "report" }, [el("span", { text: l.report })]));
        else if (l.says) kids.push(el("div", { cls: "line mono", text: r.label + " says: " + l.says }));
      });
      list.appendChild(el("div", { cls: "item", role: "listitem" }, [glyph(r.glyph, r.word), el("div", { cls: "body" }, kids)]));
    });
    body.appendChild(list);
    body.appendChild(el("div", { cls: "spacer" }));
    body.appendChild(el("div", { cls: "sfoot", text: v.foot }));
  }
  /** An answer's Markdown as the panel's own text: paragraphs, headings, lists, code (never HTML). */
  function chatText(text) {
    return el("div", { cls: "ctext md" }, UI.chatBlocks(text).map(function (b) {
      if (b.kind === "code") return el("pre", { cls: "code", text: b.text });
      if (b.kind === "ul" || b.kind === "ol") return el(b.kind, {}, b.items.map(function (parts) { return el("li", {}, noteParts(parts)); }));
      return el("div", { cls: b.kind === "h" ? "mh" : "mp" }, noteParts(b.parts, b.kind === "h"));
    }));
  }
  function drawChatItems(box) {
    var label = UI.chatLabel(chat.agent);
    chat.items.forEach(function (it) {
      if (it.kind === "user") {
        box.appendChild(el("div", { cls: "cmsg user" }, [el("div", { cls: "row1" }, [el("span", { cls: "label", text: "You" }), el("span", { cls: "time num", text: UI.hhmm(it.at) })]),
          el("div", { cls: "ctext", text: it.text })]));
        return;
      }
      if (it.head) box.appendChild(el("div", { cls: "cmsg rhead" }, [el("div", { cls: "row1" }, [el("span", { cls: "label", text: label }), el("span", { cls: "time num", text: UI.hhmm(it.at) })])]));
      if (it.kind === "agent") { if (it.text) box.appendChild(el("div", { cls: "cmsg" }, [chatText(it.text)])); return; }
      if (it.kind === "notice") { box.appendChild(el("div", { cls: "cmsg" }, [el("div", { cls: "muted", text: it.text })])); return; }
      if (it.kind === "error") {
        box.appendChild(el("div", { cls: "item ctool" }, [glyph("failed", "Failed"), el("div", { cls: "body" }, [el("div", { cls: "row1" }, [el("span", { cls: "tline" }, [el("span", { cls: "title", text: it.title || (it.auth ? "Not signed in" : "It stopped with an error") })]), el("span", { cls: "meta" }, [el("span", { cls: "st st-failed", text: "Failed" })])]), el("div", { cls: "line", text: it.text })])]));
        return;
      }
      // a tool call: the feed's row once the activity log has it (click: Activity history)
      if (!it.entry && it.state !== "running") { it.entry = UI.chatEntryFor(it, S.activity, chat.used); if (it.entry) chat.used[UI.entryKey(it.entry)] = true; }
      var t = UI.chatToolView(it, it.entry);
      var meta = el("span", { cls: "meta" }, [t.word ? el("span", { cls: "st st-" + t.glyph, text: t.word }) : null, el("span", { cls: "time num", text: UI.hhmm(it.endedAt || it.at) })]);
      var body = el("div", { cls: "body" }, [el("div", { cls: "row1" }, [el("span", { cls: "tline" }, [el("span", { cls: "title", text: t.title })]), meta])]);
      if (t.list) body.appendChild(changeReport(t.list));
      else if (t.line) body.appendChild(el("div", { cls: "line mono", text: t.line }));
      var row = el("div", { cls: "item ctool clickable" + (t.muted ? " read" : ""), role: "button", tabindex: "0", title: "In the activity history", "aria-label": t.title + (t.word ? ", " + t.word : "") },
        [glyph(t.glyph, t.word || "Read only"), body]);
      row.onclick = function () { openScreen("history", "chat", "chat"); };
      row.onkeydown = function (e) { if (e.keyCode === 13 || e.keyCode === 32) { e.preventDefault(); row.onclick(); } };
      box.appendChild(row);
    });
  }

  // The panel's own menu (the same as After Effects' ☰ flyout, which many people never open)
  function screenMenu(body) {
    var current = AEMCPBridge.VERSION;
    var upd = S.update && S.update.latest && UI.cmpVersions(S.update.latest, current) > 0;
    function row(id, label, sub, opts) {
      opts = opts || {};
      var b = button("mrow", "", function () { if (opts.onclick) opts.onclick(b); else openScreen(id, "menu"); });
      b.appendChild(el("span", { cls: "mtext" }, [el("span", { cls: "mlabel", text: label }), sub ? el("span", { cls: "msub" + (opts.mono ? " mono-s" : "") }, typeof sub === "string" ? [sub] : sub) : null]));
      b.appendChild(el("span", { cls: "chev", text: opts.onclick && !opts.chevron ? "" : "›", "aria-hidden": "true" }));
      return b;
    }
    function group(title, kids) { return el("div", { cls: "mgroup" }, [el("div", { cls: "label", text: title })].concat(kids)); }
    function choice(label, sub, options, current, onPick) {
      var seg = el("div", { cls: "mini-seg", role: "radiogroup", "aria-label": label });
      options.forEach(function (o) {
        var on = o[0] === current;
        seg.appendChild(button(on ? "on" : "", o[1], function () { if (!on) onPick(o[0]); }, { role: "radio", "aria-checked": on ? "true" : "false" }));
      });
      return el("div", { cls: "mset" }, [el("div", { cls: "mtext" }, [el("span", { cls: "mlabel", text: label }), el("span", { cls: "msub", text: sub })]), seg]);
    }
    var shell = !(S.cfg.permissions && S.cfg.permissions.allowShell === false);
    var all = S.cfg.toolProfile === "full";
    var channel = UI.updateChannel(S.cfg);
    // the subtitles come from what the panel already knows: the AI apps it loaded, the checkpoint index
    var clients = S.clients && S.clients.list || [];
    var web = clients.filter(function (c) { return c.action === "start"; })[0];
    var cps = S.current && S.current.project ? readIndex(S.current.project).length : 0;
    if (!chat.agents && !chat.loading && !chat.error) loadAgents(redrawLater());
    body.appendChild(group("Work", [
      row("chat", "Chat with your AI app", UI.chatMenuSub(chat.agents, chat.agent)),
      row("connect", "Connect an AI app", UI.connectedClientsText(clients) || "Claude, ChatGPT, Cursor and others"),
      row("chatgpt", "ChatGPT on the web", web ? (web.configured ? "Running" : web.note || "Off") : "A secure link ChatGPT can reach",
        { chevron: true, onclick: function () { openScreen("chatgpt", "menu", "menu"); } }),
      row("checkpoints", "Checkpoints", cps ? ["Safety copies of this project · ", el("span", { cls: "mono", text: String(cps) })] : "Safety copies of this project"),
      row("history", "Activity history", "Everything the AI did, searchable"),
    ]));
    body.appendChild(group("Settings", [
      choice("Panel opens on", "What you see first when After Effects starts.", [["activity", "Activity"], ["chat", "Chat"]], UI.opensOn(S.cfg),
        function (v) { if (writeConfig(function (cfg) { if (v === "chat") cfg.panelOpensOn = "chat"; else delete cfg.panelOpensOn; })) S.cfg = readConfig(); openScreen("menu"); }),
      choice("Tools the AI sees", all ? "All: more to choose from, a bigger prompt." : "Core: faster. The AI can still ask for the rest.", [["core", "Core"], ["all", "All"]], all ? "all" : "core",
        function (v) { onMenu(v === "all" ? "toolsAll" : "toolsCore"); openScreen("menu"); }),
      choice("Shell commands in scripts", shell ? "Scripts may run programs on this computer" : "Scripts can’t run programs", [["yes", "Allowed"], ["no", "Off"]], shell ? "yes" : "no",
        function (v) { onMenu(v === "yes" ? "shellYes" : "shellNo"); openScreen("menu"); }),
      choice("Beta updates", UI.betaSwitchText(channel, current), [["on", "On"], ["off", "Off"]], channel === "beta" ? "on" : "off",
        function (v) { if (saveChannel(v === "on" ? "beta" : "stable")) { openScreen("menu"); checkChannel(); } }),
    ]));
    var copiedTimer = null;
    body.appendChild(group("Help", [
      row("test", "Test the connection", null),
      row("diag", "Copy diagnostics", null, { onclick: function (b) {
        copyDiagnostics(function () {
          // "COPIED" in the row for 2 s instead of a toast
          var chev = b.lastChild;
          chev.className = "st st-verified";
          chev.textContent = "Copied";
          clearTimeout(copiedTimer);
          copiedTimer = setTimeout(function () { chev.className = "chev"; chev.textContent = ""; }, 2000);
        });
      } }),
      row("update", "Updates", upd ? [el("span", { cls: "ink", text: S.update.latest + " is ready" }), " · you have " + current] : "You have " + current, { mono: true }),
      row("about", "About and help", null),
    ]));
  }
  // About and help
  function screenAbout(body) {
    var logo = '<svg width="64" height="64" viewBox="0 0 200 200" role="img" aria-label="Surehand MCP"><rect width="200" height="200" fill="#3DD68C"></rect><g transform="translate(28 28) scale(0.72)"><path d="M150 62 C128 18 50.5 50.5 78.8 78.8 L121.2 121.2 C149.5 149.5 72 182 50 138" fill="none" stroke="#14161A" stroke-width="20" stroke-linecap="round"></path><line x1="57.6" y1="57.6" x2="142.4" y2="142.4" stroke="#14161A" stroke-width="8" stroke-linecap="round"></line><circle cx="57.6" cy="57.6" r="12" fill="#14161A"></circle><circle cx="142.4" cy="142.4" r="12" fill="#14161A"></circle><rect x="87" y="87" width="26" height="26" fill="#3DD68C" stroke="#14161A" stroke-width="8"></rect></g></svg>';
    body.appendChild(el("div", { cls: "about" }, [el("span", { html: logo }),
      el("div", {}, [el("div", { cls: "t", text: "Surehand MCP" }), el("div", { cls: "s", text: "for Adobe\u00ae After Effects\u00ae \u00b7 version " + AEMCPBridge.VERSION })])]));
    var links = el("div", { cls: "links" });
    [["Getting started", WIKI_URL], ["The Surehand panel", WIKI_URL + "/The-Surehand-panel"], ["Troubleshooting", WIKI_URL + "/Troubleshooting"], ["Report a problem", REPO_URL + "/issues"]].forEach(function (l) {
      var b = button("", "", function () { openUrl(l[1]); });
      b.appendChild(el("span", { text: l[0] }));
      b.appendChild(el("span", { text: "\u203a", "aria-hidden": "true" }));
      links.appendChild(b);
    });
    body.appendChild(links);
    body.appendChild(el("div", { cls: "spacer" }));
    body.appendChild(el("div", { cls: "sfoot", text: "Made by Ron Yitzhaki \u00b7 MIT licence. Adobe and After Effects are trademarks of Adobe; Surehand MCP is not affiliated with Adobe." }));
  }

  // ---------- refresh loop ----------
  var triedStart = false, healthFailures = 0, yieldTick = 0;
  var START_AFTER_FAILURES = Math.max(1, Math.round(8000 / POLL_MS));
  function refresh() {
    S.cfg = readConfig();
    S.update = knownUpdate();
    S.apps = readApps();
    setMenu();
    renderModes();
    call("GET", "/health", null, function (err, h) {
      if (err) {
        S.health = null;
        healthFailures++;
        // It answered before, so it runs: the bridge lives inside After Effects and can't answer while After
        // Effects runs something long (a script, a dialog). Never start a second bridge then.
        if (S.lastHealthyAt) {
          S.busySince = S.busySince || S.lastHealthyAt;
          renderWorking();
          renderHeader();
          return;
        }
        // the bridge extension starts with After Effects: give it ~8 s before starting the panel's own
        if (!triedStart && healthFailures >= START_AFTER_FAILURES) {
          triedStart = true;
          AEMCPBridge.start();
          setTimeout(function () { findMyPort(refresh); }, 500);
          return;
        }
        if (!triedStart) findMyPort(function () {}); // the real bridge may have registered meanwhile
        S.bridgeError = AEMCPBridge.state.error ? "Bridge problem: " + AEMCPBridge.state.error
          : healthFailures < START_AFTER_FAILURES && !triedStart ? null : "Not connected to After Effects";
        S.connecting = !S.bridgeError && !S.health;
        renderHeader();
        return;
      }
      healthFailures = 0;
      S.connecting = false;
      S.lastHealthyAt = Date.now();
      S.busySince = null;
      if (++yieldTick % 5 === 0) yieldOwnBridge();
      S.health = h;
      S.bridgeError = h.configProblem && h.authorized === false ? "Settings file can\u2019t be read: " + h.configProblem
        : h.authorized === false ? "Token mismatch: re-run the installer" : null;
      if (h.paused !== undefined) { S.paused = h.paused; S.bridgePaused = !!h.paused; }
      renderHeader();
      if (!secret()) Control.hello();
      if (!S.bridgeError) pollPending(); // cheap local request; also the panel's heartbeat for the bridge
      updateCurrent();
      renderWorking();
    });
    // a chat's tool rows become the feed's rows once the activity log has them
    if (readActivity() && S.screen === "chat") drawChatSoon();
    S.renders = readRenders();
    renderFeed(); // redraws only when something changed
    renderHeader();
    renderAsk();
    renderSetup();
  }

  window.addEventListener("resize", applyLayout);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
  window.SurehandPanel = { pickPort: pickPort, state: S, chat: chat, menu: onMenu, refresh: refresh, menuXml: menuXml, openScreen: openScreen, closeScreen: closeScreen, answer: answer };

  readActivity();
  applyLayout();
  renderModes();
  Control.hello();
  findMyPort(refresh);
  loadClients();
  // Settings › Panel opens on: Chat (or AI apps for chat when none is ready)
  if (UI.opensOn(readConfig()) === "chat") openScreen("chat");
  setInterval(refresh, POLL_MS);
})();
