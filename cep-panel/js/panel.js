/* Status panel. If the background bridge extension isn't running (some hosts don't honour
 * StartOn for invisible extensions), the panel starts the bridge itself. */
(function () {
  "use strict";
  var http = require("http");
  var $ = function (id) { return document.getElementById(id); };

  function call(method, path, body, cb) {
    var cfg = AEMCPBridge.loadConfig();
    var data = body ? JSON.stringify(body) : null;
    var req = http.request({ host: "127.0.0.1", port: cfg.bridgePort, path: path, method: method,
      headers: { authorization: "Bearer " + cfg.token, "content-type": "application/json" } }, function (res) {
      var chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () { try { cb(null, JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { cb(e); } });
    });
    req.on("error", function (e) { cb(e); });
    req.setTimeout(path === "/eval" ? 30000 : 3000, function () { req.destroy(new Error("timeout")); });
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
      var t = new Date(e.at);
      li.innerHTML = '<span class="t"></span><span class="s"></span> <span class="p"></span>';
      li.querySelector(".t").textContent = t.toLocaleTimeString() + " · " + e.ms + "ms";
      li.querySelector(".s").textContent = e.ok ? "ok" : "error";
      li.querySelector(".p").textContent = e.preview;
      ul.appendChild(li);
    });
  }

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
        var st = AEMCPBridge.state;
        setStatus("bad", st.error || "Bridge not running: " + err.message);
        return;
      }
      if (!h.authorized) { setStatus("bad", "Token mismatch: re-run the installer"); return; }
      var cfg = AEMCPBridge.loadConfig();
      setStatus("ok", "Listening on 127.0.0.1:" + cfg.bridgePort + (h.busy ? " · busy" : "") + (h.queue ? " · queue " + h.queue : ""));
      call("GET", "/log", null, function (e2, r) { if (!e2) renderLog(r.log); });
    });
  }

  $("refresh").onclick = refresh;
  $("test").onclick = function () {
    call("POST", "/eval", { script: "'After Effects ' + app.version", timeoutMs: 10000 }, function (err, r) {
      alert(err ? "Error: " + err.message : r.ok ? "Bridge OK\n" + r.result : "Error: " + r.error);
      refresh();
    });
  };
  $("foot").textContent = "Bridge v" + AEMCPBridge.VERSION + " · config: " + AEMCPBridge.CONFIG_FILE;
  refresh();
  setInterval(refresh, 3000);
})();
