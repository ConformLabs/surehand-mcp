/* Status panel. If the background bridge extension isn't running (some hosts don't honour
 * StartOn for invisible extensions), the panel starts the bridge itself. */
(function () {
  "use strict";
  var http = require("http");
  var fs = require("fs");
  var os = require("os");
  var path = require("path");
  var $ = function (id) { return document.getElementById(id); };
  var AEMCP_DIR = path.join(os.homedir(), ".aemcp");

  function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return null; }
  }

  function call(method, p, body, cb) {
    var cfg = AEMCPBridge.loadConfig();
    var data = body ? JSON.stringify(body) : null;
    var req = http.request({ host: "127.0.0.1", port: cfg.bridgePort, path: p, method: method,
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

  function setStatus(kind, text) {
    $("dot").className = "dot " + kind;
    $("sub").textContent = text;
  }

  function renderLog(log) {
    var ul = $("log");
    ul.innerHTML = "";
    if (!log || !log.length) { ul.innerHTML = '<li class="muted">No calls yet</li>'; return; }
    log.slice(0, 20).forEach(function (e) {
      var li = document.createElement("li");
      li.className = e.ok ? "ok" : "err";
      li.innerHTML = '<span class="t"></span><span class="s"></span> <span class="p"></span>';
      li.querySelector(".t").textContent = new Date(e.at).toLocaleTimeString() + " · " + e.ms + "ms";
      li.querySelector(".s").textContent = e.ok ? "ok" : "error";
      li.querySelector(".p").textContent = e.preview;
      ul.appendChild(li);
    });
  }

  // --- update banner (the MCP server checks GitHub at most daily and caches the result) ---
  function cmpVersions(a, b) {
    var pa = String(a).replace(/^v/, "").split("."), pb = String(b).replace(/^v/, "").split(".");
    for (var i = 0; i < 3; i++) { var x = parseInt(pa[i], 10) || 0, y = parseInt(pb[i], 10) || 0; if (x !== y) return x > y ? 1 : -1; }
    return 0;
  }
  function showUpdate() {
    var u = readJson(path.join(AEMCP_DIR, "update-check.json"));
    if (u && u.latest && cmpVersions(u.latest, AEMCPBridge.VERSION) > 0) {
      $("updateText").textContent = "Update available: v" + u.latest;
      $("updateBtn").onclick = function () {
        try { window.cep.util.openURLInDefaultBrowser(u.url); } catch (e) { alert(u.url); }
      };
      $("update").hidden = false;
    } else $("update").hidden = true;
  }

  // --- tool profile (read by the MCP server when the AI app starts it) ---
  function loadProfile() {
    var cfg = readJson(AEMCPBridge.CONFIG_FILE) || {};
    $("profile").value = cfg.toolProfile === "full" ? "full" : "core";
  }
  $("profile").onchange = function () {
    var cfg = readJson(AEMCPBridge.CONFIG_FILE) || AEMCPBridge.loadConfig();
    cfg.toolProfile = $("profile").value;
    try {
      fs.writeFileSync(AEMCPBridge.CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
      $("profileNote").hidden = false;
    } catch (e) { alert("Could not save: " + e.message); }
  };

  // --- diagnostics ---
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
    lines.push("host: " + host.appName + " " + host.appVersion + " · bridge v" + AEMCPBridge.VERSION);
    lines.push("os: " + process.platform + " " + os.release() + " " + os.arch() + " · CEP node " + process.versions.node);
    try { lines.push("extension: " + decodeURI(window.__adobe_cep__.getSystemPath("extension")).replace(/^file:\/\//, "")); } catch (e) {}
    var cfg = readJson(AEMCPBridge.CONFIG_FILE);
    if (cfg) { if (cfg.token) cfg.token = "<set, " + cfg.token.length + " chars>"; lines.push("config: " + JSON.stringify(cfg)); }
    else lines.push("config: MISSING (" + AEMCPBridge.CONFIG_FILE + ")");
    lines.push("bridge status: " + JSON.stringify(readJson(path.join(AEMCP_DIR, "bridge-status.json"))));
    lines.push("update check: " + JSON.stringify(readJson(path.join(AEMCP_DIR, "update-check.json"))));
    lines.push("server installed: " + fs.existsSync(path.join(AEMCP_DIR, "server", "ae-mcp.mjs")));
    var script = "(function(){var w=null;try{w=app.preferences.getPrefAsLong('Main Pref Section','Pref_SCRIPTING_FILE_NETWORK_SECURITY')===1;}catch(e){}" +
      "return 'ae: '+app.version+' · '+$.os+' · items '+app.project.numItems+' · scriptsCanWriteFiles '+w+' · helpers '+(typeof aemcp==='undefined'?'not loaded':aemcp.version);})()";
    call("POST", "/eval", { script: script, timeoutMs: 10000 }, function (err, r) {
      lines.push(err ? "bridge eval: ERROR " + err.message : String(r.result));
      call("GET", "/log", null, function (e2, lg) {
        lines.push("recent calls:");
        if (!e2 && lg.log) lg.log.slice(0, 15).forEach(function (e) { lines.push("  " + e.at + " " + (e.ok ? "ok " : "ERR") + " " + e.ms + "ms " + e.preview); });
        var text = lines.join("\n");
        alert(copyText(text) ? "Diagnostics copied to the clipboard." : text);
      });
    });
  };

  var triedStart = false;
  function refresh() {
    call("GET", "/health", null, function (err, h) {
      if (err) {
        if (!triedStart) {
          triedStart = true;
          AEMCPBridge.start();
          setTimeout(refresh, 500);
          return;
        }
        setStatus("bad", AEMCPBridge.state.error || "Bridge not running: " + err.message);
        return;
      }
      if (!h.authorized) { setStatus("bad", "Token mismatch: re-run the installer"); return; }
      var cfg = AEMCPBridge.loadConfig();
      setStatus("ok", "Listening on 127.0.0.1:" + cfg.bridgePort + (h.busy ? " · busy" : "") + (h.queue ? " · queue " + h.queue : ""));
      call("GET", "/log", null, function (e2, r) { if (!e2) renderLog(r.log); });
    });
    showUpdate();
  }

  $("refresh").onclick = refresh;
  $("test").onclick = function () {
    call("POST", "/eval", { script: "'After Effects ' + app.version", timeoutMs: 10000 }, function (err, r) {
      alert(err ? "Error: " + err.message : r.ok ? "Bridge OK\n" + r.result : "Error: " + r.error);
      refresh();
    });
  };
  $("foot").textContent = "v" + AEMCPBridge.VERSION + " · config: " + AEMCPBridge.CONFIG_FILE;
  loadProfile();
  refresh();
  setInterval(refresh, 3000);
})();
