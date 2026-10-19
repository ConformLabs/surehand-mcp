/* The approval pop-up (com.aemcp.approval): the bridge opens it when an edit waits for approval
 * ("ask" mode) and the Surehand panel isn't showing. It shows the oldest waiting request, answers
 * it through the bridge (which accepts only the first answer, from here or the panel), shows
 * "Allowed · closing" for a moment, then the next request or closes itself.
 * Needs paths.js and panel-model.js. ES5 only. */
(function () {
  "use strict";
  var http = require("http");
  var fs = require("fs");
  var path = require("path");
  var UI = window.SurehandUI;
  var $ = function (id) { return document.getElementById(id); };
  var PANEL_ID = "com.aemcp.panel";
  var CLOSE_AFTER_MS = window.SUREHAND_POPUP_CLOSE_MS || 1100;

  function P() { return window.SurehandPaths.current(require); }
  function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return null; } }
  function hostVersion() {
    try { return JSON.parse(window.__adobe_cep__.getHostEnvironment()).appVersion; } catch (e) { return null; }
  }
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
    var cfg = readJson(P().config) || {};
    var req = http.request({ host: "127.0.0.1", port: port(cfg), path: p, method: method,
      headers: { authorization: "Bearer " + (cfg.token || ""), "content-type": "application/json" } }, function (res) {
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

  var shown = null, pending = [], answering = false, closed = false, misses = 0;
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
  function show(p) {
    $("pBody").hidden = false;
    $("pDone").hidden = true;
    if (shown && shown.id === p.id) return tick();
    shown = p;
    var v = UI.approvalView(p, lastClient());
    $("pAsks").textContent = v.client + " asks to";
    $("pWhat").textContent = v.title;
    var chips = $("pChips");
    chips.innerHTML = "";
    v.chips.forEach(function (c) {
      var s = document.createElement("span");
      s.className = "chip" + (c.danger ? " danger" : "");
      s.textContent = c.text;
      chips.appendChild(s);
    });
    tick();
  }
  function tick() {
    if (!shown) return;
    $("pTime").textContent = UI.countdown(shown.deadline || new Date(Date.parse(shown.at) + 600000).toISOString(), Date.now());
    var more = pending.length - 1;
    $("pMore").textContent = more > 0 ? more + " more after this" : "Closes after you answer";
  }
  function poll() {
    if (closed) return;
    call("GET", "/pending?ui=popup", null, function (err, r) {
      if (err || !r || !r.pending) { if (++misses >= 5) close(); return; } // the bridge went away
      misses = 0;
      pending = r.pending;
      if (answering) return;
      if (!pending.length) return close(); // answered in the panel, cancelled, or timed out
      show(pending[0]);
    });
  }
  function answer(allow) {
    if (!shown || answering) return;
    answering = true;
    var p = shown;
    call("POST", "/approve", { id: p.id, allow: allow, by: "popup" }, function (err, r) {
      var msg = err ? "Could not answer: " + err.message
        : r.httpStatus === 404 ? "Already answered · closing"
        : allow ? "Allowed · closing" : "Denied · closing";
      $("pBody").hidden = true;
      $("pDone").hidden = false;
      $("pDoneMsg").className = "done" + (allow && !err ? "" : " denied");
      $("pDoneMsg").innerHTML = allow && !err && r.httpStatus !== 404 ? '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="#3DD68C" stroke-width="2" aria-hidden="true"><path d="m3 7.4 2.6 2.6L11 4.4"></path></svg>' : "";
      $("pDoneMsg").appendChild(document.createTextNode(msg));
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
    if (answering) return;
    var t = e.target && e.target.tagName === "BUTTON" ? e.target.id : null;
    if (e.keyCode === 13 && (!t || t === "pAllow")) { e.preventDefault(); answer(true); }
    else if (e.keyCode === 27) { e.preventDefault(); answer(false); }
  });
  document.addEventListener("mousedown", function () { document.body.classList.remove("kbd"); });

  window.SurehandApproval = { poll: poll, answer: answer, isClosed: function () { return closed; } };
  poll();
  setInterval(poll, 1000);
  setInterval(tick, 1000);
})();
