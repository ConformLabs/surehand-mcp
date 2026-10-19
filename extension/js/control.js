/* The panel secret: what lets the Surehand panel and the approval pop-up answer approvals, pause or
 * resume the AI and run the panel's own jobs (see the top of bridge-core.js). The bridge hands it out
 * only as a CEP event, which only code running inside this After Effects' extensions can send or
 * receive; the AI app, which has the token in config.json, never sees it.
 * The panel / pop-up sends com.surehand.ae.hello; each bridge answers com.surehand.ae.welcome with
 * { port, secret }. When the panel started the bridge itself (same page), the secret is read directly.
 * ES5 only. */
(function (global) {
  "use strict";
  var HELLO = "com.surehand.ae.hello", WELCOME = "com.surehand.ae.welcome";
  var secrets = {}; // bridge port -> secret
  var listening = false;

  function cep() { return global.__adobe_cep__; }
  function listen() {
    if (listening) return;
    listening = true;
    try {
      cep().addEventListener(WELCOME, function (ev) {
        var d = ev && ev.data;
        if (typeof d === "string") { try { d = JSON.parse(d); } catch (e) { return; } }
        if (d && d.port && typeof d.secret === "string" && d.secret) secrets[d.port] = d.secret;
      });
    } catch (e) {}
  }
  /** Asks this After Effects' bridges for the secret (answered with a welcome event). */
  function hello() {
    listen();
    var host = {};
    try { host = JSON.parse(cep().getHostEnvironment()); } catch (e) {}
    // After Effects drops a CEP event whose extensionId is empty (seen in AE 2026): send our own id
    var me = "";
    try { me = cep().getExtensionId(); } catch (e) {}
    try { cep().dispatchEvent({ type: HELLO, scope: "APPLICATION", appId: host.appId || "AEFT", extensionId: me || "com.aemcp.panel", data: "{}" }); } catch (e) {}
  }
  /** The secret of the bridge on `port`, or null (not known yet: call hello()). */
  function secretFor(port) {
    var b = global.AEMCPBridge;
    if (b && b.state && b.state.started && b.state.port === port && b.state.panelSecret) return b.state.panelSecret;
    return secrets[port] || null;
  }
  /** Request headers for the bridge on `port`: the token, and the secret when known. */
  function headers(port, token) {
    var h = { authorization: "Bearer " + (token || ""), "content-type": "application/json" };
    var s = secretFor(port);
    if (s) h["x-surehand-panel"] = s;
    return h;
  }

  listen();
  global.SurehandControl = { hello: hello, secretFor: secretFor, headers: headers, HELLO: HELLO, WELCOME: WELCOME };
})(typeof window !== "undefined" ? window : this);
