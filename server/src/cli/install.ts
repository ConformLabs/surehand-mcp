import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../config.js";
import { ensureConfig, ensureDebugMode, ensureExtension } from "./setup.js";
import {
  CONFIG_FILE, INSTALLED_SERVER, SERVER_NAME, ask, bold, claudeCodeConfig, claudeDesktopConfig, claudeDesktopDir, claudeDesktopExe,
  codexBlock, codexConfig, cursorConfig, dim, extensionDir, fail, findClaudeCli, isMac, isWin, ok, readJson, removeCodexBlock, run,
  sleep, stableNodePath, step, warn, writeJsonWithBackup, CSXS_VERSIONS,
} from "./util.js";

/** True if the Claude Desktop extension (.mcpb) version of AE MCP is installed. */
function mcpbInstalled(): boolean {
  try {
    return readdirSync(join(claudeDesktopDir(), "Claude Extensions")).some((n) => /after-effects/i.test(n) && !n.endsWith(".json"));
  } catch {
    return false;
  }
}

function claudeDesktopRunning(): boolean {
  if (isMac)
    return (spawnSync("ps", ["-axo", "comm="], { encoding: "utf8" }).stdout || "").split("\n").some((l) => l.trim().endsWith(".app/Contents/MacOS/Claude"));
  if (isWin) return (spawnSync("tasklist", ["/FI", "IMAGENAME eq claude.exe", "/NH"], { encoding: "utf8" }).stdout || "").toLowerCase().includes("claude.exe");
  return false;
}

async function quitClaudeDesktop(): Promise<boolean> {
  if (isMac) spawnSync("osascript", ["-e", 'tell application "Claude" to quit']);
  else if (isWin) spawnSync("taskkill", ["/IM", "claude.exe", "/T"]);
  for (let i = 0; i < 40; i++) {
    if (!claudeDesktopRunning()) return true;
    await sleep(500);
  }
  if (isWin) {
    spawnSync("taskkill", ["/IM", "claude.exe", "/T", "/F"]);
    await sleep(1000);
  }
  return !claudeDesktopRunning();
}

function startClaudeDesktop() {
  if (isMac) spawnSync("open", ["-a", "Claude"]);
  else if (isWin && existsSync(claudeDesktopExe())) spawn(claudeDesktopExe(), [], { detached: true, stdio: "ignore" }).unref();
}

export async function install(argv: string[]) {
  const flags = new Set(argv);
  const want = (name: string) => !flags.has("--skip-clients") && !flags.has(`--no-${name}`);

  console.log(bold(`\nAfter Effects MCP installer v${VERSION}`));
  console.log(dim(`${process.platform} · node ${process.version}`));
  if (!isMac && !isWin) warn("After Effects only runs on macOS and Windows; continuing anyway.");

  step("1/4  Installing the MCP server");
  const self = fileURLToPath(import.meta.url);
  mkdirSync(dirname(INSTALLED_SERVER), { recursive: true });
  if (self !== INSTALLED_SERVER) copyFileSync(self, INSTALLED_SERVER);
  if (!isWin) chmodSync(INSTALLED_SERVER, 0o755);
  ok(`Server: ${INSTALLED_SERVER}`);
  ensureConfig();
  ok(`Config: ${CONFIG_FILE}`);

  step("2/4  Installing the After Effects extension");
  try {
    ensureExtension(true);
    ok(`Extension: ${extensionDir()}`);
  } catch (e: any) {
    fail(`Could not install the extension: ${e.message}`);
    process.exit(1);
  }
  try {
    ensureDebugMode();
    ok(`Unsigned extensions enabled (PlayerDebugMode, CSXS ${CSXS_VERSIONS[0]}-${CSXS_VERSIONS.at(-1)})`);
  } catch (e: any) {
    warn(`${e.message}. The extension will not load until PlayerDebugMode is enabled (see README > Troubleshooting).`);
  }

  step("3/4  Connecting AI apps");
  const nodePath = stableNodePath();
  const entry = { command: nodePath, args: [INSTALLED_SERVER] };
  const registered: string[] = [];

  const addJson = (label: string, file: string, value: object = entry) => {
    try {
      const data = readJson<any>(file, {});
      data.mcpServers ||= {};
      data.mcpServers[SERVER_NAME] = value;
      writeJsonWithBackup(file, data);
      ok(`${label}`);
      registered.push(label);
    } catch (e: any) {
      warn(`${label}: could not update ${file}: ${e.message}`);
    }
  };

  let restartClaude = false;
  if (want("claude-desktop")) {
    if (mcpbInstalled()) {
      ok("Claude Desktop: already connected through the AE MCP extension (.mcpb)");
      registered.push("Claude Desktop");
    } else if (existsSync(claudeDesktopDir())) {
      const cfg = readJson<any>(claudeDesktopConfig(), {});
      // An existing entry that runs our installed server with a Node that still exists is fine as is.
      const cur = cfg.mcpServers?.[SERVER_NAME];
      const already = !!cur && cur.args?.[0] === INSTALLED_SERVER && typeof cur.command === "string" && existsSync(cur.command);
      if (!already && claudeDesktopRunning()) {
        // A running Claude Desktop rewrites its config from memory and would drop the new entry.
        console.log("  Claude Desktop is open. It must be closed while it is connected, then it reopens.");
        if (await ask("Restart Claude Desktop now?", true)) {
          if (await quitClaudeDesktop()) restartClaude = true;
          else warn("Could not close Claude Desktop. Quit it manually and run the installer again.");
        } else warn("Quit Claude Desktop (Cmd+Q / tray > Quit) and run this installer again, or the setting may be lost.");
      }
      if (already) {
        ok("Claude Desktop (already connected)");
        registered.push("Claude Desktop");
      } else addJson("Claude Desktop", claudeDesktopConfig());
    } else console.log(dim("  - Claude Desktop not installed (skipped)"));
  }

  if (want("claude-code")) {
    const claude = findClaudeCli();
    if (claude) {
      try {
        try { run(claude, ["mcp", "remove", SERVER_NAME, "--scope", "user"]); } catch {}
        run(claude, ["mcp", "add", "--scope", "user", SERVER_NAME, "--", nodePath, INSTALLED_SERVER]);
        ok("Claude Code");
        registered.push("Claude Code");
      } catch (e: any) {
        warn(`Claude Code: ${String(e.stderr || e.message).split("\n")[0]}`);
      }
    } else if (existsSync(claudeCodeConfig())) addJson("Claude Code", claudeCodeConfig(), { type: "stdio", ...entry, env: {} });
    else console.log(dim("  - Claude Code not installed (skipped)"));
  }

  if (want("cursor") && existsSync(dirname(cursorConfig()))) addJson("Cursor", cursorConfig());

  if (want("codex") && existsSync(dirname(codexConfig()))) {
    try {
      const file = codexConfig();
      const text = existsSync(file) ? readFileSync(file, "utf8") : "";
      if (existsSync(file) && !existsSync(file + ".aemcp.bak")) copyFileSync(file, file + ".aemcp.bak");
      writeFileSync(file, removeCodexBlock(text).trimEnd() + "\n\n" + codexBlock(nodePath, INSTALLED_SERVER));
      ok("Codex (OpenAI)");
      registered.push("Codex");
    } catch (e: any) {
      warn(`Codex: ${e.message}`);
    }
  }
  if (restartClaude) {
    startClaudeDesktop();
    ok("Claude Desktop restarted");
  }

  step("4/4  Done!");
  console.log(`
  ${bold("Restart After Effects")} if it is open. The connection starts automatically with it.
  ${registered.length ? `Connected: ${registered.join(", ")}. Restart ${registered.filter((r) => r !== "Claude Desktop" || !restartClaude).join(", ") || "nothing else"} if open.` : "No AI apps were found to connect."}

  Try asking Claude: ${bold('"Check After Effects is connected, then make a 1080p comp with an animated title."')}
  Check the installation any time with ${bold("Test Installation")} (in the ${isWin ? "Windows" : "Mac"} folder).
  ChatGPT: run ${bold("Connect ChatGPT")} from the same folder.

  Other MCP apps can use:  command ${nodePath}
                           args    ["${INSTALLED_SERVER}"]
`);
}
