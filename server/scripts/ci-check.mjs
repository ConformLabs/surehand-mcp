// CI assertions for the install / uninstall dry runs (no After Effects on CI machines).
// Usage: node ci-check.mjs installed <selftest-output-file> | uninstalled
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [, , phase, selftestOutput] = process.argv;
const isWin = process.platform === "win32";
const home = homedir();
const appdata = process.env.APPDATA || join(home, "AppData", "Roaming");
const ext = isWin
  ? join(appdata, "Adobe", "CEP", "extensions", "com.aemcp")
  : join(home, "Library", "Application Support", "Adobe", "CEP", "extensions", "com.aemcp");
const surehand = join(home, ".surehand");
const app = join(surehand, "ae");

const failures = [];
const expect = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures.push(msg);
};

if (phase === "installed") {
  expect(existsSync(join(app, "server", "surehand-ae.mjs")), "server copied to ~/.surehand/ae/server");
  expect(existsSync(join(app, "config.json")), "config created");
  expect(!existsSync(join(home, ".aemcp")), "nothing written to the 1.3 folder ~/.aemcp");
  const cfg = JSON.parse(readFileSync(join(app, "config.json"), "utf8"));
  expect(typeof cfg.token === "string" && cfg.token.length >= 32, "config has a random token");
  expect(existsSync(join(ext, "CSXS", "manifest.xml")), "After Effects extension installed");
  expect(existsSync(join(app, "extension-hash")), "extension version marker written (outside the extension)");
  expect(!existsSync(join(ext, ".aemcp-hash")), "no extra files inside the signed extension");
  expect(existsSync(join(ext, "META-INF", "signatures.xml")) && existsSync(join(ext, "mimetype")), "extension signature installed");
  expect(!readFileSync(join(ext, "js", "bridge-core.js"), "utf8").includes("__AEMCP_VERSION__"), "extension version stamped");
  expect(existsSync(join(app, "skills", "surehand-ae.zip")), "skill zips for Claude Desktop chat written to ~/.surehand/ae/skills");
  if (process.env.SUREHAND_AE_FORCE_NODE_DOWNLOAD || process.env.AEMCP_FORCE_NODE_DOWNLOAD)
    expect(existsSync(join(surehand, "node", isWin ? "node.exe" : "bin/node")), "private Node.js downloaded to ~/.surehand/node");
  if (selftestOutput) {
    const out = readFileSync(selftestOutput, "utf8");
    expect(/After Effects extension installed/.test(out), "selftest: extension check passes");
    expect(/Extension signature valid/.test(out), "selftest: installed extension matches its signature byte for byte");
    expect(/Bridge not reachable/.test(out), "selftest: reports After Effects not running (expected on CI)");
    expect(/### Surehand MCP diagnostics/.test(out), "selftest: prints diagnostics on failure");
    expect(!out.includes(cfg.token), "selftest/diagnostics never print the token");
  }
} else if (phase === "uninstalled") {
  expect(!existsSync(ext), "extension removed");
  expect(!existsSync(join(app, "server")), "server removed");
  expect(!existsSync(join(app, "config.json")), "config removed");
  expect(!existsSync(join(surehand, "node")), "private Node.js removed");
  expect(![".claude", ".agents"].some((d) => existsSync(join(home, d, "skills", "surehand-ae"))), "Surehand skills removed");
  expect(!existsSync(surehand), "~/.surehand removed (nothing of the user's was in it)");
} else {
  console.error("usage: ci-check.mjs installed [selftest-output] | uninstalled");
  process.exit(2);
}
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
