import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../config.js";
import { claudeDesktopRunning, connectClient, isOurEntry, mcpbInstalled, moveFromLegacy } from "./clients.js";
import { bundledExtensionSigned, ensureConfig, ensureDebugMode, ensureExtension, runtimeFile } from "./setup.js";
import {
  LEGACY_SERVER_NAME, SERVER_NAME, ask, bold, claudeCodeConfig, claudeDesktopConfig, claudeDesktopDir, claudeDesktopExe, chatgptDesktopInstalled, codexConfig, configPath,
  cursorConfig, dim, extensionDir, fail, findClaudeCli, installedServer, isMac, isWin, ok, readJson, sleep, stableNodePath, step, warn, CSXS_VERSIONS,
} from "./util.js";

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

  console.log(bold(`\nSurehand MCP installer v${VERSION}`));
  console.log(dim(`${process.platform} · node ${process.version}`));
  if (!isMac && !isWin) warn("After Effects only runs on macOS and Windows; continuing anyway.");

  step("1/4  Installing the MCP server");
  // a 1.3 installation (~/.aemcp) moves to ~/.surehand/ae first
  const moved = moveFromLegacy({ force: true });
  if (moved.status === "migrated") {
    ok(`Moved your settings and files from the previous version to ${dirname(dirname(installedServer()))}${moved.kept.length ? ` (left in place: ${moved.kept.join("; ")})` : ""}`);
    if (moved.repointed.length) ok(`Updated the connection settings of ${moved.repointed.join(", ")}`);
  } else if (moved.status === "failed")
    warn(`Your files from the previous version could not be moved (${moved.error}); everything keeps working from there. Details: ${moved.log}`);
  const self = fileURLToPath(import.meta.url);
  const INSTALLED_SERVER = installedServer();
  // the Mac .pkg and the Windows installer run the already installed copy; there is no release folder with launchers
  const fromInstaller = self === INSTALLED_SERVER;
  mkdirSync(dirname(INSTALLED_SERVER), { recursive: true });
  if (self !== INSTALLED_SERVER) copyFileSync(self, INSTALLED_SERVER);
  if (!isWin) chmodSync(INSTALLED_SERVER, 0o755);
  ok(`Server: ${INSTALLED_SERVER}`);
  writeFileSync(runtimeFile(), JSON.stringify({ node: stableNodePath(), server: INSTALLED_SERVER, version: VERSION }, null, 2));
  ensureConfig();
  ok(`Config: ${configPath()}`);

  step("2/4  Installing the After Effects extension");
  try {
    ensureExtension(true);
    ok(`Extension: ${extensionDir()}`);
  } catch (e: any) {
    fail(`Could not install the extension: ${e.message}`);
    process.exit(1);
  }
  if (bundledExtensionSigned) ok("Extension is signed (no PlayerDebugMode needed)");
  else {
    try {
      ensureDebugMode();
      ok(`Unsigned extensions enabled (PlayerDebugMode, CSXS ${CSXS_VERSIONS[0]}-${CSXS_VERSIONS.at(-1)})`);
    } catch (e: any) {
      warn(`${e.message}. The extension will not load until PlayerDebugMode is enabled (see README > Troubleshooting).`);
    }
  }

  step("3/4  Connecting AI apps");
  const nodePath = stableNodePath();
  const entry = { command: nodePath, args: [INSTALLED_SERVER] };
  const registered: string[] = [];
  const connect = (id: string, label: string) => {
    const r = connectClient(id, entry);
    if (r.ok) {
      ok(label);
      registered.push(label);
    } else warn(`${label}: ${r.message}`);
  };

  let restartClaude = false;
  if (want("claude-desktop")) {
    if (mcpbInstalled()) {
      ok("Claude Desktop: already connected through the Surehand MCP extension (.mcpb)");
      registered.push("Claude Desktop");
    } else if (existsSync(claudeDesktopDir())) {
      const cfg = readJson<any>(claudeDesktopConfig(), {});
      // An existing entry that runs our installed server with a Node that still exists is fine as is
      // (a 1.3 "after-effects" entry of ours is renamed).
      const cur = cfg.mcpServers?.[SERVER_NAME];
      const already = !!cur && cur.args?.[0] === INSTALLED_SERVER && typeof cur.command === "string" && existsSync(cur.command) && !isOurEntry(cfg.mcpServers?.[LEGACY_SERVER_NAME]);
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
      } else connect("claude-desktop", "Claude Desktop");
    } else console.log(dim("  - Claude Desktop not installed (skipped)"));
  }

  if (want("claude-code")) {
    if (findClaudeCli() || existsSync(claudeCodeConfig())) connect("claude-code", "Claude Code");
    else console.log(dim("  - Claude Code not installed (skipped)"));
  }

  if (want("cursor") && existsSync(dirname(cursorConfig()))) connect("cursor", "Cursor");

  // ChatGPT desktop and Codex read ~/.codex/config.toml; create it if the app is installed but has never written it
  if (want("codex") && (existsSync(dirname(codexConfig())) || chatgptDesktopInstalled())) connect("codex", "ChatGPT desktop");
  if (restartClaude) {
    startClaudeDesktop();
    ok("Claude Desktop restarted");
  }

  step("4/4  Done!");
  console.log(`
  ${bold("Restart After Effects")} if it is open. The connection starts automatically with it.
  ${registered.length ? `Connected: ${registered.join(", ")}. Restart ${registered.filter((r) => r !== "Claude Desktop" || !restartClaude).join(", ") || "nothing else"} if open.` : flags.has("--skip-clients") ? "AI apps were left as they are (--skip-clients)." : "No AI apps were found to connect."}

  Try asking Claude: ${bold('"Check After Effects is connected, then make a 1080p comp with an animated title."')}
  Check the installation any time with ${fromInstaller ? bold(`"${nodePath}" "${INSTALLED_SERVER}" selftest`) : `${bold("2. Test Installation")} (in the ${isWin ? "Windows" : "Mac"} folder)`}.
${registered.includes("ChatGPT desktop") ? "  ChatGPT desktop app: restart it; ${SERVER_NAME} appears under Settings > Plugins > Servers.\n" : ""}  ChatGPT on the web: run ${fromInstaller ? bold(`"${nodePath}" "${INSTALLED_SERVER}" chatgpt`) : `${bold("3. Connect ChatGPT")} from the same folder`}.

  Other MCP apps can use:  command ${nodePath}
                           args    ["${INSTALLED_SERVER}"]
`);
}
