/* The approval pop-up (com.aemcp.approval): the bridge opens it when an edit waits for approval
 * ("ask" mode) and the Surehand panel isn't showing. It shows the oldest waiting request, answers
 * it through the bridge (which accepts only the first answer, from here or the panel, and only with
 * the panel secret: see control.js), shows "Allowed · closing" for a moment, then the next request
 * or closes itself.
 * A request can't be answered in its first moment on screen (the buttons show "…"), so a click or key
 * meant for the previous one never lands on it; Esc denies, no key allows. When the request on screen
 * goes away without an answer from here, "That request was withdrawn" shows before the next one.
 * Needs paths.js, panel-model.js and control.js. ES5 only. */
(function () {
  "use strict";
  var http = require("http");
  var fs = require("fs");
  var path = require("path");
  var UI = window.SurehandUI;
  var Control = window.SurehandControl;
  var $ = function (id) { return document.getElementById(id); };
  var PANEL_ID = "com.aemcp.panel";
  var CLOSE_AFTER_MS = window.SUREHAND_POPUP_CLOSE_MS || 1100;
  var ARM_MS = window.SUREHAND_ARM_MS || 1200;
  var GONE_MS = window.SUREHAND_GONE_MS || 1500;

  function P() { return window.SurehandPaths.current(require); }
  function readJson(file) { try { var t = fs.readFileSync(file, "utf8"); if (t.charCodeAt(0) === 0xfeff) t = t.slice(1); return JSON.parse(t); } catch (e) { return null; } }
  function hostVersion() {
    try { return JSON.parse(window.__adobe_cep__.getHostEnvironment()).appVersion; } catch (e) { return null; }
  }
  var goodCfg = null;
  /** This After Effects' bridge: its instance file, else the configured port. */
  function port(cfg) {
    var v = hostVersion(), best = null, dir = P().instances;
    try {
      fs.readdirSync(dir).forEach(function (f) {
        var info = readJson(path.join(dir, f));
        if (info && info.host && info.host.appVersion === v) best = info.port;
      });
    } catch (e) {}
    return best || cfg.bridgePort || 8765;
  }
  function call(method, p, body, cb) {
    var cfg = readJson(P().config) || goodCfg || {};
    if (cfg.token) goodCfg = cfg;
    var to = port(cfg);
    if (!Control.secretFor(to)) Control.hello();
    var req = http.request({ host: "127.0.0.1", port: to, path: p, method: method, headers: Control.headers(to, cfg.token) }, function (res) {
      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        try { var r = JSON.parse(Buffer.concat(chunks).toString("utf8")); r.httpStatus = res.statusCode; cb(null, r); } catch (e) { cb(e); }
      });
    });
    req.on("error", function (e) { cb(e); });
    req.setTimeout(3000, function () { req.destroy(new Error("timeout")); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  }

  var shown = null, shownAt = 0, pending = [], answering = false, closed = false, misses = 0, goneUntil = 0, armTimer = null;
  function close() {
    if (closed) return;
    closed = true;
    try { window.__adobe_cep__.closeExtension(); } catch (e) {}
  }
  function lastClient() {
    // the AI app seen most recently, for requests from servers that don't name it
    try {
      var text = fs.readFileSync(P().activity, "utf8");
      var lines = text.slice(-64 * 1024).split("\n").reverse();
      for (var i = 0; i < lines.length; i++) { try { var e = JSON.parse(lines[i]); if (e.client) return UI.clientName(e.client); } catch (x) {} }
    } catch (e) {}
    return null;
  }
  function armed() { return shown && !answering && Date.now() - shownAt >= ARM_MS && Date.now() >= goneUntil; }
  function setArmed(on) {
    $("pAllow").disabled = !on;
    $("pDeny").disabled = !on;
    $("pAllow").textContent = on ? "Allow" : "…";
    $("pDeny").textContent = on ? "Deny" : "…";
    // the keyboard starts on Deny, never on Allow
    if (on) try { $("pDeny").focus(); } catch (e) {}
  }
  function message(text, ok) {
    $("pBody").hidden = true;
    $("pDone").hidden = false;
    $("pDoneMsg").className = "done" + (ok ? "" : " denied");
    $("pDoneMsg").innerHTML = ok ? '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="#3DD68C" stroke-width="2" aria-hidden="true"><path d="m3 7.4 2.6 2.6L11 4.4"></path></svg>' : "";
    $("pDoneMsg").appendChild(document.createTextNode(text));
  }
  function show(p) {
    if (shown && shown.id === p.id) return tick();
    $("pBody").hidden = false;
    $("pDone").hidden = true;
    shown = p;
    shownAt = Date.now();
    setArmed(false);
    clearTimeout(armTimer);
    armTimer = setTimeout(function () { if (shown === p) setArmed(true); }, ARM_MS);
    var v = UI.approvalView(p, lastClient());
    $("pAsks").textContent = v.client + " asks to";
    $("pWhat").textContent = v.title;
    $("pDetails").textContent = /script/i.test(v.title) ? "Show the script in the panel" : "Show details in the panel";
    $("pSays").textContent = v.says || "";
    $("pSays").hidden = !v.says;
    var chips = $("pChips");
    chips.innerHTML = "";
    v.chips.forEach(function (c) {
      var s = document.createElement("span");
      s.className = "chip" + (c.danger ? " danger" : "");
      s.textContent = c.text;
      chips.appendChild(s);
    });
    tick();
    report(); // tell the bridge which request is on screen
  }
  function tick() {
    if (!shown) return;
    var left = UI.countdownView(shown.deadline || new Date(Date.parse(shown.at) + 600000).toISOString(), Date.now());
    $("pTime").textContent = left.text;
    $("pTime").className = "time num" + (left.urgent ? " urgent" : "");
    var more = pending.length - 1;
    $("pMore").textContent = more > 0 ? more + " more after this" : "Closes after you answer";
  }
  function query() { return "/pending?ui=popup" + (shown ? "&showing=" + encodeURIComponent(shown.id) : ""); }
  function report() { call("GET", query(), null, function () {}); }
  function poll() {
    if (closed) return;
    call("GET", query(), null, function (err, r) {
      if (err || !r || !r.pending) { if (++misses >= 5) close(); return; } // the bridge went away
      misses = 0;
      pending = r.pending;
      if (answering || Date.now() < goneUntil) return;
      var still = shown && pending.some(function (x) { return x.id === shown.id; });
      if (shown && !still) {
        // answered in the panel, cancelled or timed out while on screen: say so before anything else
        shown = null;
        goneUntil = Date.now() + GONE_MS;
        message("That request was withdrawn", false);
        setTimeout(function () { if (!pending.length) close(); else poll(); }, GONE_MS + 20);
        return;
      }
      if (!pending.length) return close();
      show(pending[0]);
    });
  }
  function answer(allow) {
    if (!armed()) return;
    answering = true;
    var p = shown;
    call("POST", "/approve", { id: p.id, allow: allow, by: "popup" }, function (err, r) {
      var refused = !err && r.httpStatus !== 200 && r.httpStatus !== 404;
      var msg = err ? "Could not answer: " + err.message
        : r.httpStatus === 404 ? "Already answered · closing"
        : refused ? "Not answered: " + (r.error || "the bridge refused it")
        : allow ? "Allowed · closing" : "Denied · closing";
      message(msg, allow && !err && r.httpStatus === 200);
      setTimeout(function () {
        shown = null;
        answering = false;
        // the next request, if one waits; otherwise close
        call("GET", "/pending?ui=popup", null, function (e2, r2) {
          if (e2 || !r2 || !r2.pending || !r2.pending.length) return close();
          pending = r2.pending;
          show(pending[0]);
        });
      }, CLOSE_AFTER_MS);
    });
  }
  $("pAllow").onclick = function () { answer(true); };
  $("pDeny").onclick = function () { answer(false); };
  $("pDetails").onclick = function () {
    try { window.__adobe_cep__.requestOpenExtension(PANEL_ID, ""); } catch (e) {}
    setTimeout(close, 300); // the panel shows the same request, with the script
  };
  document.addEventListener("keydown", function (e) {
    if (e.keyCode === 9) document.body.classList.add("kbd");
    // Esc denies; Enter never allows, not even on a focused Allow button (Space or a click does, deliberately)
    if (e.keyCode === 13 && e.target && e.target.id === "pAllow") { e.preventDefault(); return; }
    if (e.keyCode === 27) { e.preventDefault(); answer(false); }
  });
  document.addEventListener("mousedown", function () { document.body.classList.remove("kbd"); });

  window.SurehandApproval = { poll: poll, answer: answer, isClosed: function () { return closed; } };
  Control.hello();
  poll();
  setInterval(poll, 1000);
  setInterval(tick, 1000);
})();
