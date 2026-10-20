import { existsSync, lstatSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { join, sep } from "node:path";
import { migrationLog } from "../migrate.js";
import { appDir, legacyDir, MOVED_NOTE, newAppDir, surehandRoot } from "../paths.js";
import { stopBackground } from "./chatgpt.js";
import { CLIENT_IDS, disconnectClient } from "./clients.js";
import { removeOwnCloudflared } from "./tunnel-install.js";
import { uninstallSkills } from "./skills.js";
import { agyConnected } from "../chat/agents.js";
import { disconnectAgySync } from "../chat/runner.js";
import { bold, extensionDir, ok, warn } from "./util.js";

// Files and folders in ~/.surehand/ae (and, from 1.3, ~/.aemcp) that Surehand MCP creates. Everything else there is the user's.
// installer/run.sh and installer/run.ps1 (uninstall without Node.js) carry the same list: a test keeps them equal.
export const OWN_FILES = [
  "server", "config.json", "runtime.json", "extension-hash", "bridge-status.json", "instances", "update-check.json",
  "activity.jsonl", "tmp", "renders", "compat", "install.log", "install-result.json", "chatgpt.json", "chatgpt.lock", "sessions", "skills", "xray", "chat", MOVED_NOTE,
];

/**
 * ~/.aemcp/node and ~/.aemcp/ffmpeg are always ours: 1.3's private runtimes, a copy the move left because the
 * original was in use, or a link to the shared one in ~/.surehand. A link goes (only the link); a real folder
 * too, unless it runs this process (the launcher removes it after we exit). ffmpeg stays when it is the only copy.
 */
function removeLegacyRuntime(p: string, name: string, all: boolean) {
  try {
    if (lstatSync(p).isSymbolicLink()) return unlinkSync(p);
  } catch {
    return;
  }
  if (process.execPath.startsWith(p + sep)) return;
  if (name === "ffmpeg" && !all && !existsSync(join(surehandRoot(), "ffmpeg"))) return;
  rmSync(p, { recursive: true, force: true });
}

/** Removes our own entries of `dir` (all with `all`); returns what was kept. `node` in ~/.surehand/ae is left to the launcher. */
function clean(dir: string, keepConfig: boolean, all: boolean): string[] {
  const kept: string[] = [];
  if (!existsSync(dir)) return kept;
  const legacy = dir === legacyDir();
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (legacy && (name === "node" || name === "ffmpeg")) {
      // a Node.js in use stays; it no longer makes a reinstall treat ~/.aemcp as a 1.3 installation (paths.ts)
      try {
        removeLegacyRuntime(p, name, all);
      } catch {}
      continue;
    }
    if (name === "node") {
      try {
        if (lstatSync(p).isSymbolicLink()) unlinkSync(p);
      } catch {}
      continue;
    }
    if (keepConfig && name === "config.json") continue;
    if (all || OWN_FILES.includes(name)) rmSync(p, { recursive: true, force: true });
    else kept.push(name);
  }
  if (!readdirSync(dir).length) rmSync(dir, { recursive: true, force: true });
  return kept;
}

export function uninstall(argv: string[]) {
  console.log(bold("\nSurehand MCP uninstaller\n"));
  const keepConfig = argv.includes("--keep-config");
  const all = argv.includes("--all");

  if (existsSync(extensionDir())) {
    rmSync(extensionDir(), { recursive: true, force: true });
    ok(`Removed the After Effects extension`);
  }
  // Only what Surehand MCP itself writes is removed. Checkpoints (copies of the user's projects) and
  // anything else stay unless --all is passed. ~/.surehand/node (a Node runtime the installer may have
  // downloaded) may be running this very process, so the uninstall wrapper deletes it after we exit.
  // ChatGPT on the web, if it runs in the background (its status file holds the connector address with the token)
  try {
    if (stopBackground().stopped) ok("Stopped ChatGPT on the web");
  } catch {}
  // our Agent Skills (only our own folders in ~/.claude/skills and ~/.agents/skills, and the zips)
  try {
    if (uninstallSkills().length) ok("Removed the Surehand skills");
  } catch (e: any) {
    warn(`Could not remove the Surehand skills: ${e.message}`);
  }
  const dir = appDir();
  const kept = clean(dir, keepConfig, all);
  // after the move from 1.3, ~/.aemcp only holds compatibility files (and whatever of the user's was left there);
  // before it (it failed), ~/.surehand/ae may hold a server an installer put there. --keep-config keeps
  // the config in use only: a second copy of the token (the one left in ~/.aemcp for the 1.3 extension) goes
  const otherKept = clean(dir === legacyDir() ? newAppDir() : legacyDir(), false, all);
  rmSync(migrationLog(), { force: true });
  if (all) rmSync(join(surehandRoot(), "ffmpeg"), { recursive: true, force: true });
  // cloudflared in the shared ~/.surehand/bin: only when Surehand downloaded it (its marker matches the file)
  try {
    if (removeOwnCloudflared()) ok("Removed cloudflared (downloaded for ChatGPT on the web)");
  } catch {}
  // the private Node.js is shared by the Surehand apps: removed here only when no other one is installed and it
  // isn't running this process (then the launcher removes it after we exit)
  const R = surehandRoot(), node = join(R, "node");
  let others: string[] = [];
  try {
    // shared folders (node, ffmpeg, bin) aren't apps
    others = readdirSync(R).filter((n) => !["ae", "node", "ffmpeg", "bin"].includes(n) && !n.startsWith("."));
  } catch {}
  if (!others.length && existsSync(node) && !process.execPath.startsWith(node + sep)) rmSync(node, { recursive: true, force: true });
  try {
    if (!readdirSync(surehandRoot()).length) rmSync(surehandRoot(), { recursive: true, force: true });
  } catch {}
  ok(keepConfig ? `Removed the server (kept ${join(dir, "config.json")})` : "Removed the server");
  if (kept.length) warn(`Kept your files in ${dir}: ${kept.join(", ")} (delete them yourself, or uninstall with --all)`);
  if (otherKept.length) warn(`Kept your files in ${dir === legacyDir() ? newAppDir() : legacyDir()}: ${otherKept.join(", ")}`);

  for (const id of CLIENT_IDS) {
    const r = disconnectClient(id);
    if (r.ok && r.restartHint) ok(r.message);
  }
  // Antigravity, if the panel's Chat connected it (its own `agy mcp remove`)
  if (agyConnected()) {
    const r = disconnectAgySync();
    if (r.ok) ok(r.message);
    else warn(r.message);
  }
  console.log("\nDone. Restart After Effects and your AI apps.");
  console.log("If you installed the Claude Desktop extension (.mcpb), remove it in Claude Desktop > Settings > Extensions.");
  warn("PlayerDebugMode, if an earlier version enabled it, was left as is (harmless; other extensions may rely on it).");
}
