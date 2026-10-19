import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AEMCP_DIR, SERVER_NAME, bold, claudeCodeConfig, claudeDesktopConfig, codexConfig, cursorConfig, extensionDir, findClaudeCli, ok,
  readJson, removeCodexBlock, run, warn, writeJsonWithBackup,
} from "./util.js";

// Files and folders in ~/.aemcp that Surehand MCP creates. Everything else there is the user's.
export const OWN_FILES = [
  "server", "config.json", "runtime.json", "extension-hash", "bridge-status.json", "instances", "update-check.json",
  "activity.jsonl", "tmp", "renders", "compat", "install.log",
];

export function uninstall(argv: string[]) {
  console.log(bold("\nSurehand MCP uninstaller\n"));
  const keepConfig = argv.includes("--keep-config");
  const all = argv.includes("--all");

  if (existsSync(extensionDir())) {
    rmSync(extensionDir(), { recursive: true, force: true });
    ok(`Removed the After Effects extension`);
  }
  // Only what Surehand MCP itself writes is removed. Checkpoints (copies of the user's projects) and
  // anything else in ~/.aemcp stay unless --all is passed. ~/.aemcp/node (a Node runtime the installer
  // may have downloaded) may be running this very process, so the uninstall wrapper deletes it after we exit.
  const kept: string[] = [];
  if (existsSync(AEMCP_DIR)) {
    for (const name of readdirSync(AEMCP_DIR)) {
      if (name === "node" || (keepConfig && name === "config.json")) continue;
      if (all || OWN_FILES.includes(name)) rmSync(join(AEMCP_DIR, name), { recursive: true, force: true });
      else kept.push(name);
    }
    if (!readdirSync(AEMCP_DIR).length) rmSync(AEMCP_DIR, { recursive: true, force: true });
  }
  ok(keepConfig ? "Removed the server (kept ~/.aemcp/config.json)" : "Removed the server");
  if (kept.length) warn(`Kept your files in ${AEMCP_DIR}: ${kept.join(", ")} (delete them yourself, or uninstall with --all)`);

  for (const [label, file] of [["Claude Desktop", claudeDesktopConfig()], ["Cursor", cursorConfig()], ["Claude Code", claudeCodeConfig()]] as const) {
    const data = readJson<any>(file, null);
    if (data?.mcpServers?.[SERVER_NAME]) {
      delete data.mcpServers[SERVER_NAME];
      writeJsonWithBackup(file, data);
      ok(`Removed from ${label}`);
    }
  }
  const claude = findClaudeCli();
  if (claude) {
    try {
      run(claude, ["mcp", "remove", SERVER_NAME, "--scope", "user"]);
      ok("Removed from Claude Code");
    } catch {}
  }
  if (existsSync(codexConfig())) {
    const t = readFileSync(codexConfig(), "utf8");
    const n = removeCodexBlock(t);
    if (n !== t) {
      writeFileSync(codexConfig(), n.trimEnd() + "\n");
      ok("Removed from Codex");
    }
  }
  console.log("\nDone. Restart After Effects and your AI apps.");
  console.log("If you installed the Claude Desktop extension (.mcpb), remove it in Claude Desktop > Settings > Extensions.");
  warn("PlayerDebugMode, if an earlier version enabled it, was left as is (harmless; other extensions may rely on it).");
}
