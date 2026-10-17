#!/usr/bin/env node
// AE MCP installer (macOS + Windows). Usage: node installer/install.mjs [--skip-clients] [--no-claude-desktop] [--no-claude-code] [--no-cursor] [--no-codex]
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AEMCP_DIR, CONFIG_FILE, CSXS_VERSIONS, EXTENSION_ID, ROOT, SERVER_FILE, SERVER_NAME,
  bold, cepExtensionsDir, claudeCodeConfig, claudeDesktopConfig, stableNodePath, codexBlock, codexConfig, cursorConfig, dim, fail, findClaudeCli,
  isMac, isWin, ok, readJson, removeCodexBlock, run, step, warn, writeJsonWithBackup,
} from "./common.mjs";

const flags = new Set(process.argv.slice(2));
const want = (name) => !flags.has("--skip-clients") && !flags.has(`--no-${name}`);

console.log(bold("\nAfter Effects MCP installer"));
console.log(dim(`platform: ${process.platform}, node ${process.version}`));

// 1. Node version
const major = Number(process.versions.node.split(".")[0]);
if (major < 18) {
  fail(`Node.js 18 or newer is required (found ${process.version}). Install the LTS from https://nodejs.org and run again.`);
  process.exit(1);
}
if (!isMac && !isWin) warn("After Effects only runs on macOS and Windows; continuing anyway.");

// 2. MCP server (single-file bundle)
step("1/5  Installing MCP server");
const bundle = join(ROOT, "server", "dist", "ae-mcp.mjs");
if (!existsSync(bundle)) {
  console.log(dim("  server/dist not found - building from source (npm install + build)..."));
  const npm = isWin ? "npm.cmd" : "npm";
  for (const args of [["install", "--no-audit", "--no-fund"], ["run", "build"]]) {
    const r = spawnSync(npm, args, { cwd: join(ROOT, "server"), stdio: "inherit", shell: isWin });
    if (r.status !== 0) {
      fail(`npm ${args.join(" ")} failed`);
      process.exit(1);
    }
  }
}
mkdirSync(dirname(SERVER_FILE), { recursive: true });
copyFileSync(bundle, SERVER_FILE);
if (!isWin) chmodSync(SERVER_FILE, 0o755);
ok(`Server installed to ${SERVER_FILE}`);

// 3. Shared config (keep an existing token so already-configured clients keep working)
step("2/5  Writing configuration");
const cfg = readJson(CONFIG_FILE, {});
cfg.token ||= randomBytes(24).toString("hex");
cfg.bridgePort ||= 8765;
cfg.httpPort ||= 8766;
mkdirSync(AEMCP_DIR, { recursive: true });
writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
ok(`Config: ${CONFIG_FILE} (bridge port ${cfg.bridgePort}, HTTP port ${cfg.httpPort})`);

// 4. CEP extension
step("3/5  Installing the After Effects extension");
const extDir = join(cepExtensionsDir(), EXTENSION_ID);
try {
  rmSync(extDir, { recursive: true, force: true });
  mkdirSync(dirname(extDir), { recursive: true });
  cpSync(join(ROOT, "cep-panel"), extDir, { recursive: true });
  ok(`Extension copied to ${extDir}`);
} catch (e) {
  fail(`Could not copy extension: ${e.message}`);
  process.exit(1);
}

// Unsigned extensions need PlayerDebugMode
let debugOk = 0;
for (const v of CSXS_VERSIONS) {
  try {
    if (isWin) run("reg", ["add", `HKCU\\Software\\Adobe\\CSXS.${v}`, "/v", "PlayerDebugMode", "/t", "REG_SZ", "/d", "1", "/f"]);
    else if (isMac) run("defaults", ["write", `com.adobe.CSXS.${v}`, "PlayerDebugMode", "1"]);
    debugOk++;
  } catch (e) {
    warn(`Could not enable PlayerDebugMode for CSXS.${v}: ${e.message.split("\n")[0]}`);
  }
}
ok(`Enabled unsigned extensions (PlayerDebugMode) for CSXS ${CSXS_VERSIONS[0]}-${CSXS_VERSIONS.at(-1)}`);

// 5. Register with MCP clients
step("4/5  Connecting AI apps");
const nodePath = stableNodePath(); // absolute path: GUI apps often don't have node on PATH
const entry = { command: nodePath, args: [SERVER_FILE] };
const registered = [];

function addToJsonClient(label, file, onlyIfDirExists = true) {
  if (onlyIfDirExists && !existsSync(dirname(file))) return;
  try {
    const data = readJson(file, {});
    data.mcpServers ||= {};
    data.mcpServers[SERVER_NAME] = entry;
    writeJsonWithBackup(file, data);
    ok(`${label}: ${file}`);
    registered.push(label);
  } catch (e) {
    warn(`${label}: could not update ${file}: ${e.message}`);
  }
}

if (want("claude-desktop")) {
  if (existsSync(dirname(claudeDesktopConfig()))) {
    addToJsonClient("Claude Desktop", claudeDesktopConfig());
    // A running Claude Desktop rewrites its config from memory and would drop our entry
    const running = isWin
      ? spawnSync("tasklist", ["/FI", "IMAGENAME eq Claude.exe"], { encoding: "utf8" }).stdout?.includes("Claude.exe")
      : spawnSync("pgrep", ["-f", "Claude.app/Contents/MacOS/Claude"], { encoding: "utf8" }).status === 0;
    if (running)
      warn(bold("Claude Desktop is running: quit it completely (Cmd+Q / tray > Quit) and run this installer again,") +
        "\n    otherwise Claude Desktop may overwrite the new setting when it closes.");
  } else warn("Claude Desktop not found (skipped). Install it, then re-run this installer.");
}
if (want("claude-code")) {
  const claude = findClaudeCli();
  if (claude) {
    try {
      try { run(claude, ["mcp", "remove", SERVER_NAME, "--scope", "user"]); } catch {}
      run(claude, ["mcp", "add", "--scope", "user", SERVER_NAME, "--", nodePath, SERVER_FILE]);
      ok("Claude Code: added (user scope)");
      registered.push("Claude Code");
    } catch (e) {
      warn(`Claude Code: 'claude mcp add' failed: ${(e.stderr || e.message).toString().split("\n")[0]}`);
    }
  } else if (existsSync(claudeCodeConfig())) {
    try {
      const data = readJson(claudeCodeConfig(), null);
      if (!data) throw new Error("could not parse");
      data.mcpServers ||= {};
      data.mcpServers[SERVER_NAME] = { type: "stdio", ...entry, env: {} };
      writeJsonWithBackup(claudeCodeConfig(), data);
      ok(`Claude Code: ${claudeCodeConfig()} (user scope)`);
      registered.push("Claude Code");
    } catch (e) {
      warn(`Claude Code: could not update ${claudeCodeConfig()}: ${e.message}`);
    }
  } else console.log(dim("  - Claude Code not found (skipped)"));
}
if (want("cursor") && existsSync(join(dirname(cursorConfig())))) addToJsonClient("Cursor", cursorConfig());
if (want("codex") && existsSync(dirname(codexConfig()))) {
  try {
    const file = codexConfig();
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (existsSync(file) && !existsSync(file + ".aemcp.bak")) copyFileSync(file, file + ".aemcp.bak");
    writeFileSync(file, removeCodexBlock(text).trimEnd() + "\n\n" + codexBlock(nodePath, SERVER_FILE));
    ok(`Codex (OpenAI): ${file}`);
    registered.push("Codex");
  } catch (e) {
    warn(`Codex: ${e.message}`);
  }
}

// 6. Done
step("5/5  Done!");
console.log(`
${bold("Next steps")}
  1. ${bold("Restart After Effects")} (and ${registered.length ? registered.join(", ") : "your AI app"}).
     The bridge starts automatically with After Effects.
     Optional status panel: Window > Extensions > AE MCP.
  2. Ask Claude something like: "Using After Effects, create a 1080p comp with an animated title."
  3. ChatGPT: run ${bold(isWin ? "start-chatgpt.bat" : "start-chatgpt.command")} and follow the instructions (see README).

  Manual MCP config for other apps:
    command: ${nodePath}
    args:    ["${SERVER_FILE}"]
`);
if (debugOk === 0) warn("PlayerDebugMode could not be set: the extension will not load until it is enabled (see README > Troubleshooting).");
