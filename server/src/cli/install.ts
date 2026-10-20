// `surehand-ae install`: the server, the After Effects extension, the config, and the AI apps.
//
//   install [--skip-clients] [--no-<app>]    everything; connects every AI app found (except --no-<app>)
//   install --clients claude-desktop,cursor   connects only these (the installers' app lists); "none" (or "")
//                                             connects none
//   install --tunnel                          also gets cloudflared for ChatGPT on the web (installTunnel)
//   install --connect-only --clients <ids> [--disconnect <ids>] [--tunnel]
//                                             only the AI app step (the server is installed already): the installers
//                                             run it once per app, so each app has its own progress step and result
//   install --summary                         prints the last install's results (the Mac Installer writes them at
//                                             the top of ~/.surehand/ae/install.log)
//
// Every run writes what happened as JSON (InstallResult) to ~/.surehand/ae/install-result.json (--result <file>
// elsewhere). A --connect-only run adds its apps to the results that are there. The Windows Setup shows the
// results on its finish page, the Mac Installer at the top of install.log, and `clients --json` gives the panel
// the reason an app could not be connected. The text output stays as it is.
//
// A full run (not --connect-only) also writes the Agent Skills (skills.ts) for the AI apps on this computer that
// read them, and the zips to upload in Claude Desktop chat.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../config.js";
import { readJsonFile, writeFileAtomic } from "../fsutil.js";
import { installTunnel } from "./chatgpt.js";
import {
  claudeDesktopRunning, CLIENT_NAMES, clientInstalled, connectClient, disconnectClient, INSTALLER_ORDER, installResultFile, isOurEntry, mcpbInstalled,
  moveFromLegacy, repointLegacyClients, type ClientId,
} from "./clients.js";
import { installSkills, type SkillsInstallResult } from "./skills.js";
import { bundledExtensionSigned, ensureConfig, ensureDebugMode, ensureExtension, PANEL_COMMANDS, runtimeFile } from "./setup.js";
import {
  LEGACY_SERVER_NAME, SERVER_NAME, ask, bold, claudeDesktopConfig, claudeDesktopExe, configPath,
  dim, extensionDir, fail, installedServer, isMac, isWin, ok, readJson, sleep, stableNodePath, step, warn, CSXS_VERSIONS,
} from "./util.js";

export type ClientOutcome = "connected" | "failed" | "not-found" | "not-chosen" | "disconnected";
export type TunnelOutcome = "installed" | "already" | "failed";
/** One line of the installers' results: done (filled green square), skipped (dotted), failed (red X). */
export interface SummaryRow {
  kind: "done" | "skipped" | "failed";
  text: string;
}
export interface InstallResult {
  ok: boolean;
  version: string;
  /** when it was written (ISO) */
  at: string;
  /** the server and the extension were installed (false when a --connect-only run started the file) */
  setup: boolean;
  error?: string;
  /** "After Effects 2025", "After Effects (Beta)" (installed copies found) */
  afterEffects: string[];
  afterEffectsRunning: boolean;
  clients: { id: ClientId; name: string; outcome: ClientOutcome; message?: string }[];
  /** cloudflared for ChatGPT on the web, when it was asked for (--tunnel) */
  tunnel?: { outcome: TunnelOutcome; path?: string; error?: string };
  /** the Agent Skills: the folders written and the zips for Claude Desktop chat (a full run; skills.ts) */
  skills?: { dirs: string[]; zips: string[]; error?: string; /** Claude Desktop is on this computer: the next steps say to upload the zips */ claudeDesktop?: boolean };
  /** the results as the installers show them (installResultView) */
  summary: SummaryRow[];
  /** the numbered next steps */
  next: string[];
}

export { installResultFile };

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

/** Is After Effects open? (Windows: AfterFX.exe; Mac: the After Effects app's process) */
export function afterEffectsRunning(): boolean {
  try {
    if (isWin) return /afterfx\.exe/i.test(spawnSync("tasklist", ["/FI", "IMAGENAME eq AfterFX.exe", "/NH"], { encoding: "utf8", timeout: 15_000 }).stdout || "");
    if (isMac)
      return (spawnSync("ps", ["-axo", "comm="], { encoding: "utf8", timeout: 15_000 }).stdout || "").split("\n").some((l) => /\/Adobe After Effects[^/]*\.app\/Contents\/MacOS\//.test(l));
  } catch {}
  return false;
}

const list = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** "Adobe® After Effects® 2025, 2026" from ["After Effects 2025", "After Effects 2026"]. */
const aeNames = (versions: string[]) => `Adobe® After Effects® ${versions.map((v) => v.replace(/^After Effects /, "").replace(/^\((Beta)\)$/, "$1")).join(", ")}`;

/** The next step for Claude Desktop chat, which can't read skill files: the user uploads the zips (skills.ts). */
export const CLAUDE_CHAT_SKILLS = `For Claude Desktop chat: upload the skills in Customize › Skills › Upload a skill (files in ${
  isWin ? "%USERPROFILE%\\.surehand\\ae\\skills" : "~/.surehand/ae/skills"
}).`;

/** The results as the installers show them: rows (glyph + text) and the numbered next steps. */
export function installResultView(r: Omit<InstallResult, "summary" | "next">): { summary: SummaryRow[]; next: string[] } {
  const summary: SummaryRow[] = [];
  const by = (o: ClientOutcome) => r.clients.filter((c) => c.outcome === o);
  const connected = by("connected").map((c) => c.name);
  if (r.error) summary.push({ kind: "failed", text: `Setup did not finish: ${r.error}` });
  if (connected.length) summary.push({ kind: "done", text: `Connected ${connected.join(", ")}` });
  for (const c of by("failed")) summary.push({ kind: "failed", text: `${c.name} not connected: ${c.message ?? "unknown error"}` });
  if (by("disconnected").length) summary.push({ kind: "skipped", text: `Disconnected: ${by("disconnected").map((c) => c.name).join(", ")}` });
  if (by("not-chosen").length) summary.push({ kind: "skipped", text: `Not ticked: ${by("not-chosen").map((c) => c.name).join(", ")}` });
  if (by("not-found").length) summary.push({ kind: "skipped", text: `Not found: ${by("not-found").map((c) => c.name).join(", ")}` });
  if (r.afterEffects.length) summary.push({ kind: "done", text: aeNames(r.afterEffects) });
  else summary.push({ kind: "skipped", text: "Adobe® After Effects® not found. The panel loads once it is installed." });
  const t = r.tunnel;
  if (t?.outcome === "installed") summary.push({ kind: "done", text: "cloudflared downloaded for ChatGPT on the web" });
  else if (t?.outcome === "already") summary.push({ kind: "done", text: "cloudflared is already on this computer, for ChatGPT on the web" });
  else if (t?.outcome === "failed") summary.push({ kind: "failed", text: `cloudflared not downloaded: ${t.error ?? "unknown error"}. Panel › Menu › ChatGPT on the web installs it later.` });

  const next: string[] = [];
  if (r.afterEffectsRunning) next.push("Restart After Effects (it is open).");
  if (connected.length) {
    next.push(`Restart ${list(connected)}.`);
    next.push(`Ask ${connected.length > 1 ? "one of them" : "it"} “What's in my project?” The Surehand panel (Window › Extensions › Surehand MCP) shows when it's connected.`);
  } else next.push("Open After Effects and connect an AI app in the Surehand panel (Window › Extensions › Surehand MCP).");
  if (r.skills?.zips.length && r.skills.claudeDesktop) next.push(CLAUDE_CHAT_SKILLS);
  return { summary, next };
}

/** The results as plain text (the top of the Mac install.log; `install --summary`). */
export function installResultText(r: InstallResult): string {
  const mark = { done: "[done]   ", skipped: "[skipped]", failed: "[failed] " };
  return [
    `Surehand MCP ${r.version} ${r.ok ? "is installed" : "did not finish installing"} (${r.at})`,
    ...r.summary.map((s) => `  ${mark[s.kind]} ${s.text}`),
    "",
    "Next:",
    ...r.next.map((n, i) => `  ${i + 1}. ${n}`),
  ].join("\n");
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
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? "" : v;
};
/** "a,b" -> the known client ids in it ("none" or "" -> none); unknown ids are reported */
function idList(value: string | undefined, unknown: string[]): Set<ClientId> | null {
  if (value === undefined) return null;
  const ids = new Set<ClientId>();
  for (const s of value.split(",").map((x) => x.trim()).filter((x) => x && x !== "none")) {
    if ((INSTALLER_ORDER as string[]).includes(s)) ids.add(s as ClientId);
    else unknown.push(s);
  }
  return ids;
}

export async function install(argv: string[]) {
  const flags = new Set(argv);
  if (flags.has("--summary")) {
    const r = readJsonFile<InstallResult>(argValue(argv, "--result") || installResultFile());
    if (!r.ok || !Array.isArray(r.data?.summary)) {
      console.log("No install results yet.");
      process.exitCode = 1;
      return;
    }
    console.log(installResultText(r.data));
    return;
  }
  const resultFile = argValue(argv, "--result") || installResultFile();
  const unknown: string[] = [];
  const chosen = idList(argValue(argv, "--clients"), unknown);
  const unchosen = idList(argValue(argv, "--disconnect"), unknown) ?? new Set<ClientId>();
  const connectOnly = flags.has("--connect-only");
  // a --connect-only run connects only the apps it is given
  const want = (id: ClientId) => (chosen ? chosen.has(id) : !connectOnly && !flags.has("--skip-clients") && !flags.has(`--no-${id}`));
  for (const u of unknown) warn(`Unknown AI app "${u}" (known: ${INSTALLER_ORDER.join(", ")})`);

  // a --connect-only run adds to the results of the install that ran just before it
  const before = connectOnly ? readJsonFile<InstallResult>(resultFile) : null;
  const prior = before?.ok && before.data?.version === VERSION && Array.isArray(before.data.clients) ? before.data : null;
  const result: InstallResult = {
    ok: prior?.ok ?? true,
    version: VERSION,
    at: new Date().toISOString(),
    setup: prior?.setup ?? !connectOnly,
    ...(prior?.error ? { error: prior.error } : {}),
    afterEffects: afterEffectsVersions(),
    afterEffectsRunning: afterEffectsRunning(),
    clients: prior ? prior.clients.filter((c) => !(chosen?.has(c.id) || unchosen.has(c.id))) : [],
    ...(prior?.tunnel ? { tunnel: prior.tunnel } : {}),
    ...(prior?.skills ? { skills: prior.skills } : {}),
    summary: [],
    next: [],
  };
  const writeResult = () => {
    // in the installers' order, whatever order the steps ran in
    result.clients.sort((a, b) => INSTALLER_ORDER.indexOf(a.id) - INSTALLER_ORDER.indexOf(b.id));
    Object.assign(result, installResultView(result));
    try {
      mkdirSync(dirname(resultFile), { recursive: true });
      writeFileAtomic(resultFile, JSON.stringify(result, null, 2) + "\n");
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
      result.error = `could not install the After Effects extension: ${e.message}`;
      for (const id of INSTALLER_ORDER) result.clients.push({ id, name: CLIENT_NAMES[id], outcome: clientInstalled(id) ? "not-chosen" : "not-found" });
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
  const record = (id: ClientId, outcome: ClientOutcome, message?: string) => {
    result.clients = result.clients.filter((c) => c.id !== id);
    result.clients.push({ id, name: CLIENT_NAMES[id], outcome, ...(message ? { message } : {}) });
  };
  const connect = (id: ClientId, label: string) => {
    const r = connectClient(id, entry);
    if (r.ok) {
      ok(label);
      registered.push(label);
      record(id, "connected");
    } else {
      warn(`${label}: ${r.message}`);
      record(id, "failed", r.message.replace(new RegExp(`^${CLIENT_NAMES[id].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}: `), ""));
    }
  };

  let restartClaude = false;
  for (const id of INSTALLER_ORDER) {
    const label = id === "codex" ? "ChatGPT desktop" : CLIENT_NAMES[id];
    if (unchosen.has(id)) {
      // the installers' "change which AI apps are connected": an app that was connected and is no longer ticked
      const r = disconnectClient(id);
      if (r.ok) ok(r.message);
      else warn(r.message);
      record(id, r.ok ? "disconnected" : "failed", r.ok ? undefined : r.message);
      continue;
    }
    if (!want(id)) {
      // a --connect-only run only reports the apps it was given
      if (!connectOnly) record(id, clientInstalled(id) ? "not-chosen" : "not-found");
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
  if (flags.has("--tunnel")) {
    if (!connectOnly) step("ChatGPT on the web: cloudflared");
    const t = await installTunnel();
    if (t.ok) {
      ok(t.already ? `cloudflared is already installed: ${t.path}` : `cloudflared downloaded: ${t.path}`);
      result.tunnel = { outcome: t.already ? "already" : "installed", path: t.path };
    } else {
      warn(`cloudflared was not downloaded: ${t.error}`);
      result.tunnel = { outcome: "failed", error: t.error };
    }
  }
  if (!connectOnly) {
    // the Agent Skills, for the apps on this computer that read them (whether or not they were chosen above)
    const sk = installSkills();
    reportSkills(sk);
    result.skills = { dirs: sk.targets.filter((t) => t.written).map((t) => t.dir), zips: sk.zips, ...(sk.zipError ? { error: sk.zipError } : {}), claudeDesktop: clientInstalled("claude-desktop") };
  }
  writeResult();
  if (connectOnly) {
    // an installer step: exit code 3 when something it was asked for did not work
    const failed = result.clients.some((c) => (chosen?.has(c.id) || unchosen.has(c.id)) && c.outcome === "failed") || (flags.has("--tunnel") && result.tunnel?.outcome === "failed");
    if (failed) process.exitCode = 3;
    return;
  }

  step("4/4  Done!");
  console.log(`
  ${result.afterEffectsRunning ? `${bold("Restart After Effects")}: it is open. ` : ""}The connection starts automatically with After Effects.
  ${registered.length ? `Connected: ${registered.join(", ")}. Restart ${registered.filter((r) => r !== "Claude Desktop" || !restartClaude).join(", ") || "nothing else"} if open.` : flags.has("--skip-clients") || chosen?.size === 0 ? "AI apps were left as they are." : "No AI apps were found to connect."}

  Then open your AI app and ask it something about your After Effects project, like ${bold('"What\'s in my project?"')}
  Check the installation any time with ${fromInstaller ? bold(`"${nodePath}" "${INSTALLED_SERVER}" selftest`) : `${bold("2. Test Installation")} (in the ${isWin ? "Windows" : "Mac"} folder)`}.
${registered.includes("ChatGPT desktop") ? `  ChatGPT desktop app: restart it; ${SERVER_NAME} appears under Settings > Plugins > Servers.\n` : ""}${result.skills?.zips.length && result.skills.claudeDesktop ? `  ${CLAUDE_CHAT_SKILLS}\n` : ""}  ChatGPT on the web: run ${fromInstaller ? bold(`"${nodePath}" "${INSTALLED_SERVER}" chatgpt`) : `${bold("3. Connect ChatGPT")} from the same folder`}.

  Other MCP apps can use:  command ${nodePath}
                           args    ["${INSTALLED_SERVER}"]
`);
}


/** The skills step's lines (install, `skills install`). */
export function reportSkills(r: SkillsInstallResult) {
  for (const t of r.targets) {
    if (t.written) ok(`Skills for ${t.apps.join(", ")}: ${t.dir}`);
    else if (t.error) warn(`Skills not written to ${t.dir}: ${t.error}`);
    else console.log(dim(`  - Skills not written to ${t.dir} (${t.reason})`));
  }
  if (r.zips.length) ok(`Skills for Claude Desktop chat (to upload): ${dirname(r.zips[0])}`);
  else if (r.zipError) warn(`Skill zips not written: ${r.zipError}`);
}
