/* Status panel: connection, approvals ("ask" mode), permissions, activity log, diagnostics.
 * If the background bridge extension isn't running (some hosts don't honour StartOn for
 * invisible extensions), the panel starts the bridge itself. */
(function () {
  "use strict";
  var http = require("http");
  var fs = require("fs");
  var os = require("os");
  var path = require("path");
  var childProcess = require("child_process");
  var $ = function (id) { return document.getElementById(id); };
  var AEMCP_DIR = path.join(os.homedir(), ".aemcp");
  var ACTIVITY_FILE = path.join(AEMCP_DIR, "activity.jsonl");
  var myPort = null; // the bridge of THIS After Effects instance

  function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return null; }
  }

  function call(method, p, body, cb) {
    var cfg = AEMCPBridge.loadConfig();
    var data = body ? JSON.stringify(body) : null;
    var port = myPort || AEMCPBridge.state.port || cfg.bridgePort;
    var req = http.request({ host: "127.0.0.1", port: port, path: p, method: method,
      headers: { authorization: "Bearer " + cfg.token, "content-type": "application/json" } }, function (res) {
      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () { try { cb(null, JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { cb(e); } });
    });
    req.on("error", function (e) { cb(e); });
    req.setTimeout(p === "/eval" ? 30000 : 3000, function () { req.destroy(new Error("timeout")); });
    if (data) req.write(data);
    req.end();
  }

  // The bridge of this instance: the bridge extension writes bridge-status.json with its pid and port;
  // with several AE instances, match on this AE's version.
  function findMyPort(cb) {
    var host = AEMCPBridge.hostInfo();
    var dir = path.join(AEMCP_DIR, "instances"), best = null;
    try {
      fs.readdirSync(dir).forEach(function (f) {
        var info = readJson(path.join(dir, f));
        if (info && info.host && info.host.appVersion === host.appVersion) best = info.port;
      });
    } catch (e) {}
    myPort = best || AEMCPBridge.state.port || AEMCPBridge.loadConfig().bridgePort;
    cb();
  }

  function setStatus(kind, text) {
    $("dot").className = "dot " + kind;
    $("sub").textContent = text;
  }

  function note(text) {
    $("note").textContent = text;
    $("note").hidden = false;
  }

  // ---------- config (permissions, tool profile) ----------
  function readConfig() { return readJson(AEMCPBridge.CONFIG_FILE) || AEMCPBridge.loadConfig(); }
  function writeConfig(cfg) {
    try { fs.writeFileSync(AEMCPBridge.CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n"); return true; }
    catch (e) { alert("Could not save settings: " + e.message); return false; }
  }
  function loadSettings() {
    var cfg = readConfig(), p = cfg.permissions || {};
    $("perm").value = p.mode === "ask" || p.mode === "read-only" ? p.mode : "full";
    $("shell").value = p.allowShell === false ? "off" : "on";
    $("profile").value = cfg.toolProfile === "full" ? "full" : "core";
  }
  $("perm").onchange = $("shell").onchange = function () {
    var cfg = readConfig();
    cfg.permissions = { mode: $("perm").value, allowShell: $("shell").value === "on" };
    if (writeConfig(cfg)) note("Permissions saved. They apply to the next request (no restart needed).");
  };
  $("profile").onchange = function () {
    var cfg = readConfig();
    cfg.toolProfile = $("profile").value;
    if (writeConfig(cfg)) note("Saved. Restart your AI app to apply the tool set.");
  };

  // ---------- approvals ----------
  var shownPending = null; // ids currently on screen (null = nothing rendered yet)
  function renderPending(list) {
    var key = list.map(function (p) { return p.id; }).join(",");
    if (key === shownPending) return;
    shownPending = key;
    var box = $("approvalList");
    box.innerHTML = "";
    $("approvals").hidden = !list.length;
    list.forEach(function (p) {
      var d = document.createElement("div");
      d.className = "approval";
      d.innerHTML = '<div class="what"></div><pre></pre><div class="row"><button class="allow">Allow</button><button class="deny">Deny</button></div>';
      d.querySelector(".what").textContent = p.tool + " · " + new Date(p.at).toLocaleTimeString();
      d.querySelector("pre").textContent = p.summary;
      d.querySelector(".allow").onclick = function () { answer(p.id, true, d); };
      d.querySelector(".deny").onclick = function () { answer(p.id, false, d); };
      box.appendChild(d);
    });
  }
  function answer(id, allow, card) {
    // remove the card right away; the next poll redraws from the bridge's list either way
    if (card && card.parentNode) card.parentNode.removeChild(card);
    if (!$("approvalList").children.length) $("approvals").hidden = true;
    call("POST", "/approve", { id: id, allow: allow }, function () { shownPending = null; pollPending(); });
  }
  function pollPending() {
    call("GET", "/pending", null, function (err, r) { if (!err && r && r.pending) renderPending(r.pending); });
  }

  // ---------- activity ----------
  function readActivity(limit) {
    try {
      var lines = fs.readFileSync(ACTIVITY_FILE, "utf8").trim().split("\n");
      return lines.slice(-limit).map(function (l) { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean).reverse();
    } catch (e) { return []; }
  }
  var shownActivity = "", openEntry = null;
  function renderActivity() {
    var list = readActivity(30);
    var key = list.length ? list[0].at + list.length : "";
    if (key === shownActivity) return;
    shownActivity = key;
    var ul = $("log");
    ul.innerHTML = "";
    if (!list.length) { ul.innerHTML = '<li class="muted">No calls yet</li>'; return; }
    list.forEach(function (e) {
      var li = document.createElement("li");
      li.className = e.ok ? "ok" : "err";
      li.innerHTML = '<span class="t"></span><span class="s"></span> <span class="p"></span> <span class="c"></span>';
      li.querySelector(".t").textContent = new Date(e.at).toLocaleTimeString() + " · " + e.ms + "ms";
      li.querySelector(".s").textContent = e.tool;
      li.querySelector(".p").textContent = (e.summary || "").slice(0, 120);
      li.querySelector(".c").textContent = (e.client ? " · " + e.client : "") + (e.changes ? " · " + e.changes + " changes" : "");
      li.onclick = function () {
        var pre = li.querySelector("pre");
        if (pre) { li.removeChild(pre); openEntry = null; return; }
        pre = document.createElement("pre");
        pre.textContent = e.args && typeof e.args.code === "string" ? e.args.code : JSON.stringify(e.args, null, 2);
        li.appendChild(pre);
        openEntry = e.at;
      };
      ul.appendChild(li);
      if (openEntry === e.at) li.onclick();
    });
  }
  $("openLog").onclick = function () {
    var cmd = process.platform === "win32" ? 'explorer /select,"' + ACTIVITY_FILE + '"' : 'open -R "' + ACTIVITY_FILE + '"';
    if (!fs.existsSync(ACTIVITY_FILE)) return alert("No activity yet.");
    childProcess.exec(cmd);
  };

  // ---------- update banner (the MCP server checks GitHub at most daily and caches the result) ----------
  function cmpVersions(a, b) {
    var pa = String(a).replace(/^v/, "").split("."), pb = String(b).replace(/^v/, "").split(".");
    for (var i = 0; i < 3; i++) { var x = parseInt(pa[i], 10) || 0, y = parseInt(pb[i], 10) || 0; if (x !== y) return x > y ? 1 : -1; }
    return 0;
  }
  function showUpdate() {
    var u = readJson(path.join(AEMCP_DIR, "update-check.json"));
    if (u && u.latest && cmpVersions(u.latest, AEMCPBridge.VERSION) > 0) {
      $("updateText").textContent = "Update available: v" + u.latest;
      $("updateBtn").onclick = function () { try { window.cep.util.openURLInDefaultBrowser(u.url); } catch (e) { alert(u.url); } };
      $("update").hidden = false;
    } else $("update").hidden = true;
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
  $("diag").onclick = function () {
    var lines = ["### AE MCP diagnostics", "time: " + new Date().toISOString()];
    var host = AEMCPBridge.hostInfo();
    lines.push("host: " + host.appName + " " + host.appVersion + " · bridge v" + AEMCPBridge.VERSION + " · port " + myPort);
    lines.push("os: " + process.platform + " " + os.release() + " " + os.arch() + " · CEP node " + process.versions.node);
    // file:///C:/... on Windows: drop the slash before the drive letter
    try { lines.push("extension: " + decodeURI(window.__adobe_cep__.getSystemPath("extension")).replace(/^file:\/\//, "").replace(/^\/([A-Za-z]:)/, "$1")); } catch (e) {}
    var cfg = readJson(AEMCPBridge.CONFIG_FILE);
    if (cfg) { if (cfg.token) cfg.token = "<set, " + cfg.token.length + " chars>"; lines.push("config: " + JSON.stringify(cfg)); }
    else lines.push("config: MISSING (" + AEMCPBridge.CONFIG_FILE + ")");
    lines.push("bridge status: " + JSON.stringify(readJson(path.join(AEMCP_DIR, "bridge-status.json"))));
    try { lines.push("instances: " + fs.readdirSync(path.join(AEMCP_DIR, "instances")).join(", ")); } catch (e) {}
    lines.push("update check: " + JSON.stringify(readJson(path.join(AEMCP_DIR, "update-check.json"))));
    lines.push("server installed: " + fs.existsSync(path.join(AEMCP_DIR, "server", "ae-mcp.mjs")));
    var script = "(function(){var w=null;try{w=app.preferences.getPrefAsLong('Main Pref Section','Pref_SCRIPTING_FILE_NETWORK_SECURITY')===1;}catch(e){}" +
      "return 'ae: '+app.version+' · '+$.os+' · items '+app.project.numItems+' · scriptsCanWriteFiles '+w+' · helpers '+(typeof aemcp==='undefined'?'not loaded':aemcp.version);})()";
    call("POST", "/eval", { script: script, timeoutMs: 10000, label: "diagnostics" }, function (err, r) {
      lines.push(err ? "bridge eval: ERROR " + err.message : String(r.result));
      lines.push("recent activity:");
      readActivity(15).forEach(function (e) { lines.push("  " + e.at + " " + (e.ok ? "ok " : "ERR") + " " + e.ms + "ms " + e.tool + " " + (e.summary || "").slice(0, 120)); });
      var text = lines.join("\n");
      alert(copyText(text) ? "Diagnostics copied to the clipboard." : text);
    });
  };

  // ---------- status ----------
  var triedStart = false;
  function refresh() {
    call("GET", "/health", null, function (err, h) {
      if (err) {
        if (!triedStart) {
          triedStart = true;
          AEMCPBridge.start();
          setTimeout(function () { findMyPort(refresh); }, 500);
          return;
        }
        setStatus("bad", AEMCPBridge.state.error || "Bridge not running: " + err.message);
        return;
      }
      if (!h.authorized) { setStatus("bad", "Token mismatch: re-run the installer"); return; }
      var extra = [];
      if (h.busy) extra.push("busy " + Math.round(h.busyForMs / 1000) + "s" + (h.busyWith ? " (" + h.busyWith + ")" : ""));
      if (h.queue) extra.push("queue " + h.queue);
      if (h.permissionMode && h.permissionMode !== "full") extra.push(h.permissionMode === "ask" ? "asks before changes" : "read-only");
      setStatus(h.busy && h.busyForMs > 15000 ? "warn" : "ok", "Connected · port " + h.port + (extra.length ? " · " + extra.join(" · ") : ""));
      pollPending(); // cheap local request; also clears cards answered elsewhere or cancelled by the AI app
    });
    renderActivity();
    showUpdate();
  }

  $("test").onclick = function () {
    call("POST", "/eval", { script: "'After Effects ' + app.version", timeoutMs: 10000, label: "panel test" }, function (err, r) {
      alert(err ? "Error: " + err.message : r.ok ? "Bridge OK\n" + r.result : "Error: " + r.error);
      refresh();
    });
  };
  $("foot").textContent = "v" + AEMCPBridge.VERSION + " · " + AEMCP_DIR;
  loadSettings();
  findMyPort(refresh);
  setInterval(refresh, 1500);
})();
