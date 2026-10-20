// `surehand-ae install`: the server, the After Effects extension, the config, and the AI apps.
//
//   install [--skip-clients] [--no-<app>]   everything; connects every AI app found (except --no-<app>)
//   install --clients claude-desktop,cursor  connects only these (the installers' app list); "" connects none
//   install --connect-only --clients <ids>   only the connecting step (the server is installed already): the
//                                            installers run it once per app, to show each app's result
//   install ... --result <file>              also writes what happened as JSON (InstallResult) for the installers'
//                                            finish pages; the text output stays as it is
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../config.js";
import { writeFileAtomic } from "../fsutil.js";
import { claudeDesktopRunning, CLIENT_IDS, CLIENT_NAMES, clientInstalled, connectClient, isOurEntry, mcpbInstalled, moveFromLegacy, repointLegacyClients, type ClientId } from "./clients.js";
import { bundledExtensionSigned, ensureConfig, ensureDebugMode, ensureExtension, PANEL_COMMANDS, runtimeFile } from "./setup.js";
import {
  LEGACY_SERVER_NAME, SERVER_NAME, ask, bold, claudeDesktopConfig, claudeDesktopExe, configPath,
  dim, extensionDir, fail, installedServer, isMac, isWin, ok, readJson, sleep, stableNodePath, step, warn, CSXS_VERSIONS,
} from "./util.js";

export type ClientOutcome = "connected" | "failed" | "not-found" | "not-chosen";
export interface InstallResult {
  ok: boolean;
  version: string;
  /** the server and the extension were installed (false with --connect-only) */
  setup: boolean;
  error?: string;
  /** "After Effects 2025", ... (installed copies found) */
  afterEffects: string[];
  clients: { id: ClientId; name: string; outcome: ClientOutcome; message?: string }[];
}

/** The After Effects versions installed: "After Effects 2025", "After Effects (Beta)". `roots` for tests. */
export function afterEffectsVersions(roots?: string[]): string[] {
  const dirs = roots ?? (isMac ? ["/Applications"] : isWin ? [join(process.env.ProgramFiles || "C:\\Program Files", "Adobe")] : []);
  const found = new Set<string>();
  for (const d of dirs) {
    let names: string[] = [];
    try {
      names = readdirSync(d);
    } catch {}
    for (const n of names) {
      const m = /^Adobe After Effects (\d{4}|\(Beta\))$/.exec(n);
      if (m) found.add(`After Effects ${m[1]}`);
    }
  }
  return [...found].sort();
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

const argValue = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};

export async function install(argv: string[]) {
  const flags = new Set(argv);
  const resultFile = argValue(argv, "--result");
  const chosenArg = argValue(argv, "--clients");
  const chosen = chosenArg === undefined ? null : new Set(chosenArg.split(",").map((s) => s.trim()).filter(Boolean));
  const connectOnly = flags.has("--connect-only");
  const want = (id: ClientId) => (chosen ? chosen.has(id) : !flags.has("--skip-clients") && !flags.has(`--no-${id}`));
  const result: InstallResult = { ok: true, version: VERSION, setup: !connectOnly, afterEffects: afterEffectsVersions(), clients: [] };
  const writeResult = () => {
    if (!resultFile) return;
    try {
      mkdirSync(dirname(resultFile), { recursive: true });
      writeFileAtomic(resultFile, JSON.stringify(result, null, 2));
    } catch (e: any) {
      warn(`Could not write ${resultFile}: ${e.message}`);
    }
  };
  const self = fileURLToPath(import.meta.url);
  const INSTALLED_SERVER = installedServer();
  // the Mac .pkg and the Windows installer run the already installed copy; there is no release folder with launchers
  const fromInstaller = self === INSTALLED_SERVER;

  if (!connectOnly) {
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
    else if (moved.status === "not-needed") {
      // moved earlier: settings an app wrote back since (or one skipped then) still naming ~/.aemcp
      const problems: string[] = [];
      const fixed = repointLegacyClients(problems);
      if (fixed.length) ok(`Updated the connection settings of ${fixed.join(", ")}`);
      for (const p of problems) warn(p);
    }
    for (const n of moved.notes.filter((x) => x.startsWith("AI app settings"))) warn(n);
    mkdirSync(dirname(INSTALLED_SERVER), { recursive: true });
    if (self !== INSTALLED_SERVER) copyFileSync(self, INSTALLED_SERVER);
    if (!isWin) chmodSync(INSTALLED_SERVER, 0o755);
    ok(`Server: ${INSTALLED_SERVER}`);
    writeFileSync(runtimeFile(), JSON.stringify({ node: stableNodePath(), server: INSTALLED_SERVER, version: VERSION, panelCommands: PANEL_COMMANDS }, null, 2));
    ensureConfig();
    ok(`Config: ${configPath()}`);

    step("2/4  Installing the After Effects extension");
    try {
      ensureExtension(true);
      ok(`Extension: ${extensionDir()}`);
    } catch (e: any) {
      fail(`Could not install the extension: ${e.message}`);
      result.ok = false;
      result.error = `Could not install the After Effects extension: ${e.message}`;
      writeResult();
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
    if (result.afterEffects.length) ok(`After Effects found: ${result.afterEffects.join(", ")}`);
    else warn("After Effects was not found in its usual place; the extension loads once it is installed.");

    step("3/4  Connecting AI apps");
  }
  const nodePath = stableNodePath();
  const entry = { command: nodePath, args: [INSTALLED_SERVER] };
  const registered: string[] = [];
  const record = (id: ClientId, outcome: ClientOutcome, message?: string) => result.clients.push({ id, name: CLIENT_NAMES[id], outcome, ...(message ? { message } : {}) });
  const connect = (id: ClientId, label: string) => {
    const r = connectClient(id, entry);
    if (r.ok) {
      ok(label);
      registered.push(label);
      record(id, "connected");
    } else {
      warn(`${label}: ${r.message}`);
      record(id, "failed", r.message);
    }
  };

  let restartClaude = false;
  for (const id of CLIENT_IDS) {
    const label = id === "codex" ? "ChatGPT desktop" : CLIENT_NAMES[id];
    if (!want(id)) {
      if (!chosen || !connectOnly) record(id, clientInstalled(id) ? "not-chosen" : "not-found");
      continue;
    }
    if (id === "claude-desktop" && mcpbInstalled()) {
      ok("Claude Desktop: already connected through the Surehand MCP extension (.mcpb)");
      registered.push("Claude Desktop");
      record(id, "connected", "through the Claude Desktop extension (.mcpb)");
      continue;
    }
    if (!clientInstalled(id)) {
      if (id === "claude-desktop" || id === "claude-code") console.log(dim(`  - ${label} not installed (skipped)`));
      record(id, "not-found");
      continue;
    }
    if (id === "claude-desktop") {
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
        record(id, "connected");
        continue;
      }
    }
    connect(id, label);
  }
  if (restartClaude) {
    startClaudeDesktop();
    ok("Claude Desktop restarted");
  }
  writeResult();
  if (connectOnly) return;

  step("4/4  Done!");
  console.log(`
  ${bold("Restart After Effects")} if it is open. The connection starts automatically with it.
  ${registered.length ? `Connected: ${registered.join(", ")}. Restart ${registered.filter((r) => r !== "Claude Desktop" || !restartClaude).join(", ") || "nothing else"} if open.` : flags.has("--skip-clients") || chosen?.size === 0 ? "AI apps were left as they are." : "No AI apps were found to connect."}

  Then open your AI app and ask it something about your After Effects project, like ${bold('"What\'s in my project?"')}
  Check the installation any time with ${fromInstaller ? bold(`"${nodePath}" "${INSTALLED_SERVER}" selftest`) : `${bold("2. Test Installation")} (in the ${isWin ? "Windows" : "Mac"} folder)`}.
${registered.includes("ChatGPT desktop") ? `  ChatGPT desktop app: restart it; ${SERVER_NAME} appears under Settings > Plugins > Servers.\n` : ""}  ChatGPT on the web: run ${fromInstaller ? bold(`"${nodePath}" "${INSTALLED_SERVER}" chatgpt`) : `${bold("3. Connect ChatGPT")} from the same folder`}.

  Other MCP apps can use:  command ${nodePath}
                           args    ["${INSTALLED_SERVER}"]
`);
}
