/* The Surehand panel: status, "What the AI may do", Pause AI, approval cards ("ask" mode), and a
 * short feed of what the AI did. Settings and tools live in After Effects' own panel menu (☰),
 * whose screens slide over the feed. If the background bridge extension isn't running (some
 * hosts don't honour StartOn for invisible extensions), the panel starts the bridge itself.
 * Answers, Pause / Resume and the panel's own jobs carry the panel secret (control.js), which the AI
 * app never has.
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
    if (opts.since && !(rt.panelCommands >= 1) && rt.version && UI.cmpVersions(rt.version, opts.since) < 0) return cb({ friendly: TOO_OLD });
    var env = {};
    Object.keys(process.env).forEach(function (k) { env[k] = process.env[k]; });
    env.AEMCP_NO_AUTOSETUP = "1";
    delete env.SUREHAND_AE_PANEL_SECRET;
    delete env.AEMCP_PANEL_SECRET;
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
    return UI.statusFor({
      bridgeError: S.bridgeError, paused: isPausedNow(), pendingCount: S.pending.length,
      client: UI.lastClient(S.activity), everConnected: S.activity.length > 0,
    });
  }
  function isPausedNow() { return S.bridgePaused === null ? !!S.cfg.paused : S.bridgePaused; }
  function renderHeader() {
    var st = status();
    $("status").className = "status " + st.kind;
    $("statusText").textContent = S.layout === "narrow" ? st.short : st.text;
    $("status").title = st.text;
    $("tile").setAttribute("class", "tile " + st.tile);
    var paused = isPausedNow();
    $("pause").hidden = paused;
    $("resume").hidden = !paused;
    var note = $("pausedNote");
    note.hidden = !paused;
    if (paused) {
      var n = S.paused && S.paused.refused || 0;
      note.textContent = "Nothing runs in After Effects. AI calls are refused at once, so the AI stops instead of waiting." +
        (n ? " " + n + " refused so far." : "");
    }
    var host = AEMCPBridge.hostInfo();
    $("hostLabel").textContent = UI.aeLabel(host.appVersion);
    var upd = S.update && S.update.latest && UI.cmpVersions(S.update.latest, AEMCPBridge.VERSION) > 0;
    $("ver").textContent = AEMCPBridge.VERSION + (upd ? " \u00b7 update ready" : "");
    $("ver").className = "link" + (upd ? " update" : "");
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
  $("resume").onclick = function () { setPaused(false); };

  // ---------- mode switch (config permissions.mode) ----------
  var MODE_ICONS = {
    full: function (ink) { return '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6.8 1 2.5 6.8h3L5 11l4.5-6H6.4z" fill="' + ink + '"></path></svg>'; },
    ask: function (ink) { return '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="' + ink + '" stroke-width="1.4" aria-hidden="true"><path d="M3.5 6.5V3.2a.9.9 0 0 1 1.8 0v2.6M5.3 5.4V2.4a.9.9 0 0 1 1.8 0v3M7.1 5.4V3a.9.9 0 0 1 1.8 0v3.8c0 2-1.4 3.7-3.3 3.7-1.4 0-2.2-.7-2.9-1.9L1.9 7a.9.9 0 0 1 1.6-.9"></path></svg>'; },
    "read-only": function (ink) { return '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="' + ink + '" stroke-width="1.4" aria-hidden="true"><path d="M1 6s2-3.6 5-3.6S11 6 11 6 9 9.6 6 9.6 1 6 1 6z"></path><circle cx="6" cy="6" r="1.5"></circle></svg>'; },
  };
  var shownModes = "";
  function renderModes() {
    var mode = UI.modeOf(S.cfg), key = mode + S.layout;
    if (key === shownModes) return;
    shownModes = key;
    var box = $("modes");
    box.innerHTML = "";
    UI.MODES.forEach(function (m) {
      var on = m.id === mode;
      var label = S.layout === "narrow" ? m.short : m.label;
      var b = el("button", { type: "button", role: "radio", "aria-checked": on ? "true" : "false", "aria-label": m.label, tabindex: on ? "0" : "-1", "data-mode": m.id });
      b.innerHTML = MODE_ICONS[m.id](on ? "#14161A" : "#C9C6BF") + "<span></span>";
      b.lastChild.textContent = label;
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
    var def = UI.MODES.filter(function (m) { return m.id === mode; })[0];
    $("modeDesc").textContent = S.layout === "narrow" ? def.narrow : def.desc;
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
      return;
    }
    $("askGone").hidden = true;
    $("ask").hidden = !p;
    if (!p) { shownAsk = null; return; }
    var waiting = S.pending.filter(function (x) { return !S.answering[x.id]; }).length;
    $("askTime").textContent = UI.countdown(p.deadline || new Date(Date.parse(p.at) + 600000).toISOString(), Date.now());
    $("askHint").textContent = "Esc denies" + (waiting > 1 ? " \u00b7 " + (waiting - 1) + " more after this" : "");
    if (shownAsk === p.id) return;
    shownAsk = p.id;
    askOpen = false;
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
    $("askShow").textContent = /script/i.test(p.tool) ? "Show the script" : "Show the details";
    $("askShow").setAttribute("aria-expanded", "false");
    $("askCode").textContent = v.code;
    $("askCode").hidden = true;
    pollPending(); // tell the bridge which request is on screen
  }
  $("askShow").onclick = function () {
    askOpen = !askOpen;
    $("askCode").hidden = !askOpen;
    $("askShow").setAttribute("aria-expanded", askOpen ? "true" : "false");
    $("askShow").textContent = (askOpen ? "Hide" : "Show") + (/script/.test($("askShow").textContent) ? " the script" : " the details");
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
    });
  }

  // ---------- keyboard: Esc denies (or closes a screen); there is no key that allows ----------
  document.addEventListener("keydown", function (e) {
    if (e.keyCode === 9) document.body.classList.add("kbd");
    var tag = e.target && e.target.tagName;
    if (S.screen) {
      if (e.keyCode === 27) { e.preventDefault(); goBack(); }
      return;
    }
    // Enter never allows, not even on a focused Allow button (Space or a click does, deliberately)
    if (e.keyCode === 13 && e.target && e.target.id === "allow") { e.preventDefault(); return; }
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
    box.hidden = st.kind !== "idle";
    if (box.hidden) return;
    // ChatGPT on the web has its own screen (a secure link, not a setting): not offered here
    var list = (S.clients && S.clients.list || []).filter(function (c) { return c.action !== "start"; });
    var configured = list.filter(function (c) { return c.configured; });
    var todo = list.filter(function (c) { return c.installed !== false && !c.configured && c.connectable !== false; });
    var pick = todo.filter(function (c) { return /claude.?desktop/i.test(c.id + " " + c.name); })[0] || todo[0];
    if (configured.length) {
      $("setupText").textContent = configured[0].name + " is set up. Restart it to connect.";
      $("setupBtn").hidden = true;
      $("setupHint").textContent = "Other apps: \u2630 \u203a Connect an AI app.";
    } else if (pick) {
      $("setupText").textContent = pick.name + " isn\u2019t set up yet.";
      $("setupBtn").hidden = false;
      $("setupBtn").textContent = "Set it up";
      $("setupBtn").onclick = function () { connectClient(pick, true); };
      $("setupHint").textContent = "Then restart " + pick.name + ". Other apps: \u2630 \u203a Connect an AI app.";
    } else {
      $("setupText").textContent = "No AI app has used Surehand yet.";
      $("setupBtn").hidden = false;
      $("setupBtn").textContent = "Connect an AI app";
      $("setupBtn").onclick = function () { openScreen("connect"); };
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
  var ICONS = {
    change: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1 9 5 5 9 1 5z" fill="#3DD68C"></path></svg>',
    problem: '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="#FF8A80" stroke-width="1.6" aria-hidden="true"><path d="M5 1.8v4M5 7.8v.4"></path></svg>',
    proof: '<svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="#3DD68C" stroke-width="1.7" aria-hidden="true"><path d="m2 5.8 2.2 2.2L9 3"></path></svg>',
    read: '<svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="#8E8B85" stroke-width="1.2" aria-hidden="true"><path d="M1 5.5S3 2 5.5 2 10 5.5 10 5.5 8 9 5.5 9 1 5.5 1 5.5z"></path><circle cx="5.5" cy="5.5" r="1.4"></circle></svg>',
    render: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 1.5v7L8.5 5z" fill="#14161A"></path></svg>',
  };
  var shownFeed = "";
  function renderFeed(force) {
    var limit = S.layout === "wide" ? 5 : S.layout === "narrow" ? 6 : 7;
    var running = {};
    S.renders.forEach(function (r) { running[r.id] = true; });
    var items = UI.feedItems(S.activity, { limit: Math.max(1, limit - S.renders.length), undone: S.undone, runningRenders: running, current: S.current });
    var key = JSON.stringify([S.layout, S.renders, items.map(function (i) { return [i.at, i.title, i.line, i.undoable, !!S.open[UI.entryKey(i.entry)]]; })]);
    if (!force && key === shownFeed) return;
    shownFeed = key;
    var feed = $("feed");
    feed.innerHTML = "";
    S.renders.forEach(function (r) { feed.appendChild(renderItem(r)); });
    items.forEach(function (it, k) { feed.appendChild(feedItem(it, k === 0)); });
    if (!items.length && !S.renders.length) feed.appendChild(el("div", { cls: "empty", text: "What the AI does in After Effects shows up here." }));
  }
  function renderItem(r) {
    var pct = r.pct === null || r.pct === undefined ? null : r.pct;
    var label = pct === null ? "frame " + (r.frame || 0) : pct + "%";
    var bar = el("div", { cls: "bar" + (pct === null ? " indet" : ""), "aria-hidden": "true" }, [el("div", { style: "width:" + (pct || 0) + "%" })]);
    var title = "Rendering " + (r.comp || "in the background");
    var body = el("div", { cls: "body" }, [
      el("div", { cls: "row1" }, [el("span", { cls: "title", text: title }), el("span", { cls: "pct num", text: label })]),
      bar,
    ]);
    var side = el("span", { cls: "side-act pct num", text: label + (r.left && S.layout === "wide" ? " \u00b7 " + r.left : "") });
    var ico = el("span", { cls: "ico render", html: ICONS.render });
    return el("div", { cls: "item render", role: "listitem", "aria-label": title + ", " + label }, [ico, body, side]);
  }
  function feedItem(it, first) {
    var k = UI.entryKey(it.entry), open = !!S.open[k];
    var cls = "item " + it.kind + (first && it.kind === "change" ? " top-change" : "");
    var time = UI.hhmm(it.at);
    var title = el("span", { cls: "title", text: it.title });
    var inline = el("span", { cls: "inline", text: (it.line ? " \u00b7 " + it.line : "") + " \u00b7 " + time });
    var row1 = el("div", { cls: "row1" }, [el("span", { style: "min-width:0;overflow:hidden;text-overflow:ellipsis" }, [title, inline]), el("span", { cls: "time", text: time })]);
    var body = el("div", { cls: "body" }, [row1]);
    var details = it.kind === "read" && !it.line ? null : function () { toggleDetails(k); };
    if (it.kind !== "read") body.appendChild(el("div", { cls: "line", text: it.line }));
    var acts = el("div", { cls: "acts" });
    var side = el("div", { cls: "side-act" });
    if (it.undoable) {
      acts.appendChild(button("link green", "Undo", function () { undo(it); }, { "aria-label": "Undo " + it.title }));
      side.appendChild(button("link green", "Undo", function () { undo(it); }, { "aria-label": "Undo " + it.title }));
    }
    if (it.kind === "change" || it.kind === "problem") {
      acts.appendChild(button("link", open ? "Hide details" : "Details", details, { "aria-expanded": open ? "true" : "false" }));
      // the two-column layout has room for "Show" on problems (the boards show it there only)
      if (!it.undoable && it.kind === "problem") side.appendChild(button("link wide-only", open ? "Hide" : "Show", details, { "aria-expanded": open ? "true" : "false", "aria-label": "Show " + it.title }));
    }
    if (acts.children.length && first) body.appendChild(acts);
    var node = el("div", { cls: cls, role: "listitem" }, [el("span", { cls: "ico " + it.kind, html: ICONS[it.kind] }), body, side]);
    if (open) {
      var pre = el("pre", { cls: "details", text: UI.entryDetails(it.entry) });
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
   * This After Effects and its open project ({ port, pid, project, revision }), for Undo: read only
   * while the newest entry could be undone here (a tiny script, at most every 3 s, never while busy).
   */
  var lastCurrentAt = 0;
  function updateCurrent() {
    var e = S.activity[0], h = S.health;
    if (!e || !e.undoGroup || typeof e.revision !== "number" || e.undoSteps !== 1 || !e.instance || !h || S.undone[UI.entryKey(e)]) { S.current = null; return; }
    if (e.instance.port !== myPort || e.instance.pid !== h.pid) { S.current = null; return; }
    if (h.busy || Date.now() - lastCurrentAt < 3000 || !secret()) return;
    lastCurrentAt = Date.now();
    var script = "(function(){var r='';try{r=String(app.project.revision);}catch(x){}return r+'|'+(app.project&&app.project.file?app.project.file.fsName:'');})()";
    evalAE(script, "panel: project state", function (err, r) {
      if (err || typeof r !== "string" || r.indexOf("|") < 0) { S.current = null; return renderFeed(); }
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
  function copyDiagnostics() {
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
      if (copyText(lines.join("\n"))) toast("Diagnostics copied: paste them in a bug report or a chat");
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
      item("hdrShell", "AI may run shell commands", { disabled: true }) + item("shellYes", "Yes", { check: shell }) + item("shellNo", "No", { check: !shell }) + sep +
      item("hdrTools", "Tools the AI sees", { disabled: true }) + item("toolsCore", "Core (faster)", { check: !all }) + item("toolsAll", "All tools", { check: all }) + sep +
      item("connect", "Connect an AI app\u2026") + item("checkpoints", "Checkpoints\u2026") + item("history", "Activity history\u2026") + sep +
      item("test", "Test the connection") + item("diag", "Copy diagnostics") + sep +
      item("update", "Check for updates\u2026") + item("about", "About & help\u2026") +
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
    connect: { title: "Connect an AI app", render: screenConnect },
    checkpoints: { title: "Checkpoints", render: screenCheckpoints },
    history: { title: "Activity history", render: screenHistory },
    test: { title: "Connection test", render: screenTest },
    chatgpt: { title: "ChatGPT on the web", render: screenChatgpt, parent: "connect" },
    update: { title: "Updates", render: screenUpdate },
    about: { title: "About & help", render: screenAbout },
  };
  var lastFocus = null, screenToken = 0;
  function openScreen(id) {
    if (!S.screen) lastFocus = document.activeElement;
    S.screen = id;
    screenToken++;
    $("screenTitle").textContent = SCREENS[id].title;
    $("screenAction").innerHTML = "";
    $("screenBody").innerHTML = "";
    $("screen").hidden = false;
    SCREENS[id].render($("screenBody"), $("screenAction"), screenToken);
    $("back").focus();
  }
  function closeScreen() {
    S.screen = null;
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
    return function () { if (id && token === screenToken && S.screen === id) openScreen(id); };
  }
  /** Back (and Esc): a sub-screen goes back to the screen it came from. */
  function goBack() {
    var parent = S.screen && SCREENS[S.screen] && SCREENS[S.screen].parent;
    if (parent) openScreen(parent);
    else closeScreen();
  }
  $("back").onclick = goBack;
  $("ver").onclick = function () { openScreen("update"); };
  function loading(body, text) { body.innerHTML = ""; body.appendChild(el("div", { cls: "loading", text: text || "Loading\u2026" })); }
  function message(body, text) { body.appendChild(el("div", { cls: "msg", text: text })); }
  var TUNNEL_HELP_URL = WIKI_URL + "/ChatGPT-on-the-web";
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
          btn = button(c.configured ? "secondary pill sm" : "primary pill sm", c.configured ? "Open" : "Start", function () { openScreen("chatgpt"); },
            { "aria-label": (c.configured ? "Open " : "Start ") + c.name });
        } else {
          state = c.configured ? (inUse ? "Connected \u00b7 in use now" : "Connected" + (c.note ? " \u00b7 " + shortNote(c.note) : ""))
            : c.installed === false ? "Not installed" : "Not connected" + (c.note ? " \u00b7 " + shortNote(c.note) : "");
          if (c.configured) btn = button("link", "Remove", function () { disconnectClient(c); }, { "aria-label": "Remove " + c.name });
          else if (c.installed !== false) btn = button("primary pill sm", "Set up", function () { connectClient(c); }, { "aria-label": "Set up " + c.name });
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
      box.appendChild(el("div", { cls: "line", text: "Install it in a terminal with:" }));
      box.appendChild(copyBox(cmd, function () { if (copyText(cmd)) toast("Command copied."); else toast("Could not copy to the clipboard.", true); }));
      box.appendChild(el("div", { cls: "acts" }, [button("primary pill sm", "Try again", start),
        button("link", "Step-by-step guide", function () { openUrl(TUNNEL_HELP_URL); })]));
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
      action.appendChild(button("primary pill sm", "Save one now", function (ev) { saveCheckpoint(project, token, ev && ev.target); }));
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
    if (canCompare) acts.appendChild(button("btn-green-outline", "Compare with now", function () {
      out.hidden = false;
      out.textContent = "Comparing\u2026";
      runCli(["checkpoint-diff", cp.id, "--project", project], still(token, function (err, json, text) {
        drawDiff(out, err ? err.friendly : (json && (json.text || json.message || json.error)) || text || "No differences.");
      }), { since: "1.4.0", text: true, timeout: 120000, asPanel: true });
    }));
    acts.appendChild(button("btn-plain", "Open a copy", function () { openCheckpoint(project, cp); }));
    if (fromCli && !canCompare) acts.appendChild(el("span", { cls: "muted2", text: "no history snapshot" }));
    return el("div", { cls: "cp" }, [
      el("div", { cls: "cp-row" }, [el("span", { cls: "ink", style: "font-weight:600", text: cp.label || cp.id }), el("span", { cls: "muted2", text: UI.whenLabel(cp.at, Date.now()) })]),
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
    var search = el("input", { id: "hsearch", placeholder: "Search layers, comps, tools\u2026", type: "search", autocomplete: "off" });
    var filters = el("div", { cls: "filters", role: "group", "aria-label": "Show" });
    [["all", "All"], ["change", "Changes"], ["problem", "Problems" + (problems ? " " + problems : "")]].forEach(function (f) {
      var b = button("", f[1], function () { filter = f[0]; draw(); });
      b.setAttribute("data-f", f[0]);
      filters.appendChild(b);
    });
    body.appendChild(el("div", { cls: "hsearch" }, [el("label", { "for": "hsearch", cls: "sr", text: "Search the history" }), search, filters]));
    var list = el("div", { cls: "list", style: "gap:0" });
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
        var sub = [x.item.line, UI.clientName(x.e.client)].filter(Boolean).join(" \u00b7 ");
        var row = el("button", { type: "button", cls: "hrow" + (x.item.kind === "problem" ? " bad" : ""), "aria-expanded": open[k] ? "true" : "false" }, [
          el("span", { cls: "htime", text: UI.hhmm(x.e.at) }),
          el("span", { cls: "hmain" }, [el("span", { cls: "htitle", text: x.item.title }), sub ? el("span", { cls: "hline", text: sub }) : null]),
        ]);
        row.onclick = function () { if (open[k]) delete open[k]; else open[k] = true; draw(); };
        list.appendChild(row);
        if (open[k]) list.appendChild(el("pre", { cls: "details", style: "margin:0 6px 6px 50px", text: UI.entryDetails(x.e) }));
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
  var CHECK = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="#3DD68C" stroke-width="2" aria-hidden="true"><path d="m3 7.4 2.6 2.6L11 4.4"></path></svg>';
  var CROSS = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="#FF8A80" stroke-width="2" aria-hidden="true"><path d="m3.5 3.5 7 7M10.5 3.5l-7 7"></path></svg>';
  function screenTest(body, action, token) {
    action.innerHTML = "";
    var again = button("secondary pill sm", "Run again", function () { openScreen("test"); });
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
      evalAE("'After Effects ' + app.version", "panel test", function (e2, r) {
        checks.push({ ok: !e2, name: e2 ? "Scripts don\u2019t run: " + e2.message : "Scripts run (" + r + ")" });
        cb(checks);
      });
    });
  }
  function showChecks(body, checks, again, note) {
    again.disabled = false;
    body.innerHTML = "";
    var passed = checks.filter(function (c) { return c.ok; }).length, failed = checks.length - passed;
    // as on the board: green while it basically works (a check or two to fix), red when it doesn't
    var broken = !passed || (checks[0] && !checks[0].ok);
    body.appendChild(el("div", { cls: "summary" + (broken ? " bad" : "") }, [
      el("span", { cls: "badge", html: broken ? '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#14161A" stroke-width="2" aria-hidden="true"><path d="M7 3v5M7 10.5v.5"></path></svg>' : '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#14161A" stroke-width="2" aria-hidden="true"><path d="m3 7.4 2.6 2.6L11 4.4"></path></svg>' }),
      el("div", {}, [el("div", { cls: "big", text: passed + " of " + checks.length + " checks passed" }),
        el("div", { cls: "sub", text: failed ? (failed === 1 ? "One thing to fix below" : failed + " things to fix below") : "Everything works" })]),
    ]));
    var list = el("div", { cls: "list", style: "gap:2px" });
    checks.forEach(function (c) {
      // the server's message says what was checked and what was found; its name ("update", "config"...) is a small label
      var name = c.name || c.label || c.title || c.id;
      var text = c.message || name;
      var fixId = c.fix && (c.fix.connect || c.fix.client);
      var fix = fixId ? button("primary pill sm", "Fix", function () { connectClient({ id: fixId, name: c.fix.name || name }); },
        { title: c.fix.label || null, "aria-label": c.fix.label || "Fix: " + text }) : null;
      list.appendChild(el("div", { cls: "check" + (c.ok ? "" : " bad") }, [
        el("span", { html: c.ok ? CHECK : CROSS }),
        el("span", { cls: "ctext" }, [c.message && name ? el("span", { cls: "clabel", text: name }) : null, el("span", { cls: "cmain", text: text })]),
        fix,
      ]));
    });
    body.appendChild(list);
    if (note) message(body, note);
  }

  // Updates
  function screenUpdate(body, action, token) {
    var cached = readJson(P().updateCheck);
    drawUpdate(body, cached, true);
    runCli(["update", "--check", "--json"], still(token, function (err, json) {
      if (!err && json) { S.update = json; drawUpdate(body, json, false); }
      else drawUpdate(body, cached, false, err && err.friendly);
    }), { since: "1.4.0", timeout: 30000 });
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
      if (notes && notes.length) card.appendChild(el("ul", {}, notes.slice(0, 5).map(function (n) { return el("li", { text: n }); })));
      var b = button("primary big", updating ? "Updating\u2026" : rt ? "Update now" : "Download", function () {
        if (!rt) return openUrl(u.url || REPO_URL + "/releases/latest");
        runUpdate(body, latest);
      });
      b.disabled = updating;
      card.appendChild(b);
      card.appendChild(el("div", { cls: "note", text: rt ? "Takes a few seconds. Restart After Effects and your AI apps afterwards." : "Download the installer and run it." }));
    } else {
      card.appendChild(el("div", { cls: "upd-head" }, [el("span", { cls: "v", text: checking ? "Checking\u2026" : "You\u2019re up to date" }), el("span", { cls: "have", text: "version " + current })]));
    }
    body.appendChild(card);
    var auto = S.cfg.updateCheck === false ? "off" : "once a day";
    body.appendChild(el("div", { cls: "kv" }, [
      el("div", {}, [el("span", { text: "Check automatically" }), el("span", { style: "color:#7FE3B2", text: auto })]),
      el("div", {}, [el("span", { text: "Last checked" }), el("span", { style: "color:#A9A69F", text: u && u.checkedAt ? UI.whenLabel(u.checkedAt, Date.now()) : "not yet" })]),
      button("link green", "See all release notes", function () { openUrl(REPO_URL + "/releases"); }),
    ]));
    if (note) { body.appendChild(el("div", { style: "height:10px" })); message(body, note); }
    body.appendChild(el("div", { cls: "spacer" }));
    body.appendChild(el("div", { cls: "sfoot", text: "Updates come only from the official release and are checked before they\u2019re installed." }));
  }
  function runUpdate(body, latest) {
    var token = screenToken;
    updating = true;
    drawUpdate(body, readJson(P().updateCheck) || { latest: latest }, false);
    runCli(["update", "--json"], function (err, r) {
      updating = false;
      if (r && r.ok && r.updated) { updatedTo = r.to; toast("Updated to " + r.to + ". Restart After Effects and your AI apps."); }
      else toast((r && r.message) || (err && err.friendly) || "The update did not finish.", true);
      if (token === screenToken && S.screen === "update") drawUpdate(body, readJson(P().updateCheck) || { latest: latest }, false);
    }, { timeout: 180000 });
  }

  // About & help
  function screenAbout(body) {
    var logo = '<svg width="64" height="64" viewBox="0 0 200 200" role="img" aria-label="Surehand MCP"><rect width="200" height="200" rx="46" fill="#3DD68C"></rect><g transform="translate(28 28) scale(0.72)"><path d="M150 62 C128 18 50.5 50.5 78.8 78.8 L121.2 121.2 C149.5 149.5 72 182 50 138" fill="none" stroke="#14161A" stroke-width="20" stroke-linecap="round"></path><line x1="57.6" y1="57.6" x2="142.4" y2="142.4" stroke="#14161A" stroke-width="8" stroke-linecap="round"></line><circle cx="57.6" cy="57.6" r="12" fill="#14161A"></circle><circle cx="142.4" cy="142.4" r="12" fill="#14161A"></circle><rect x="87" y="87" width="26" height="26" fill="#3DD68C" stroke="#14161A" stroke-width="8"></rect></g></svg>';
    body.appendChild(el("div", { cls: "about" }, [el("span", { html: logo }),
      el("div", {}, [el("div", { cls: "t", text: "Surehand MCP" }), el("div", { cls: "s", text: "for Adobe\u00ae After Effects\u00ae \u00b7 version " + AEMCPBridge.VERSION })])]));
    var links = el("div", { cls: "links" });
    [["Getting started", WIKI_URL], ["Troubleshooting", WIKI_URL + "/Troubleshooting"], ["Report a problem", REPO_URL + "/issues"]].forEach(function (l) {
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
    S.update = S.update || readJson(P().updateCheck);
    setMenu();
    renderModes();
    call("GET", "/health", null, function (err, h) {
      if (err) {
        // the bridge extension starts with After Effects: give it ~8 s before starting the panel's own
        healthFailures++;
        if (!triedStart && healthFailures >= START_AFTER_FAILURES) {
          triedStart = true;
          AEMCPBridge.start();
          setTimeout(function () { findMyPort(refresh); }, 500);
          return;
        }
        if (!triedStart) findMyPort(function () {}); // the real bridge may have registered meanwhile
        S.bridgeError = AEMCPBridge.state.error ? "Bridge problem: " + AEMCPBridge.state.error : "Bridge not running";
        renderHeader();
        return;
      }
      healthFailures = 0;
      if (++yieldTick % 5 === 0) yieldOwnBridge();
      S.health = h;
      S.bridgeError = h.configProblem && h.authorized === false ? "Settings file can\u2019t be read: " + h.configProblem
        : h.authorized === false ? "Token mismatch: re-run the installer" : null;
      if (h.paused !== undefined) { S.paused = h.paused; S.bridgePaused = !!h.paused; }
      renderHeader();
      if (!secret()) Control.hello();
      if (!S.bridgeError) pollPending(); // cheap local request; also the panel's heartbeat for the bridge
      updateCurrent();
    });
    readActivity();
    S.renders = readRenders();
    renderFeed(); // redraws only when something changed
    renderHeader();
    renderAsk();
    renderSetup();
  }

  window.addEventListener("resize", applyLayout);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
  window.SurehandPanel = { pickPort: pickPort, state: S, menu: onMenu, refresh: refresh, menuXml: menuXml, openScreen: openScreen, closeScreen: closeScreen, answer: answer };

  readActivity();
  applyLayout();
  renderModes();
  Control.hello();
  findMyPort(refresh);
  loadClients();
  setInterval(refresh, POLL_MS);
})();
