/* Where Surehand MCP keeps its files (shared by the bridge, the panel and the approval pop-up).
 *
 *   root      ~/.surehand            shared: node/, ffmpeg/
 *   app dir   ~/.surehand/ae         config.json, instances/, activity.jsonl, runtime.json,
 *                                    update-check.json, bridge-status.json, checkpoints/, renders/
 *
 * A 1.3 install that has not been migrated yet keeps everything in ~/.aemcp: when
 * ~/.surehand/ae/config.json doesn't exist but ~/.aemcp/config.json does, every file is used
 * from there. SUREHAND_AE_CONFIG (or AEMCP_CONFIG) names the config file; the app dir is then
 * the folder it is in. Resolved on every call: an update may migrate the files while AE runs. */
(function (global) {
  "use strict";

  function resolve(opts) {
    var path = opts.path, home = opts.home, env = opts.env || {}, exists = opts.exists;
    var root = path.join(home, ".surehand");
    var legacyDir = path.join(home, ".aemcp");
    var appDir = path.join(root, "ae");
    var override = env.SUREHAND_AE_CONFIG || env.AEMCP_CONFIG;
    var config, legacy = false;
    if (override) {
      config = override;
      appDir = path.dirname(override);
    } else if (!exists(path.join(appDir, "config.json")) && exists(path.join(legacyDir, "config.json"))) {
      legacy = true;
      appDir = legacyDir;
      config = path.join(legacyDir, "config.json");
    } else {
      config = path.join(appDir, "config.json");
    }
    var shared = legacy ? legacyDir : root;
    return {
      legacy: legacy,
      root: root,
      dir: appDir,
      config: config,
      instances: path.join(appDir, "instances"),
      sessions: path.join(appDir, "sessions"),
      chatgpt: path.join(appDir, "chatgpt.json"),
      activity: path.join(appDir, "activity.jsonl"),
      runtime: path.join(appDir, "runtime.json"),
      updateCheck: path.join(appDir, "update-check.json"),
      bridgeStatus: path.join(appDir, "bridge-status.json"),
      checkpoints: path.join(appDir, "checkpoints"),
      renders: path.join(appDir, "renders"),
      node: path.join(shared, "node"),
      ffmpeg: path.join(shared, "ffmpeg"),
    };
  }

  /** The paths on this computer, with Node's own modules. */
  function current(nodeRequire) {
    var r = nodeRequire || (typeof require !== "undefined" ? require : global.cep_node && global.cep_node.require);
    var fs = r("fs"), os = r("os"), path = r("path");
    return resolve({
      path: path,
      home: os.homedir(),
      env: (typeof process !== "undefined" && process.env) || {},
      exists: function (p) { try { return fs.existsSync(p); } catch (e) { return false; } },
    });
  }

  var api = { resolve: resolve, current: current };
  global.SurehandPaths = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);
