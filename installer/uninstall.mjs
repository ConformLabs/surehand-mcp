#!/usr/bin/env node
// Removes the AE MCP extension, server, config and client registrations.
// PlayerDebugMode is left enabled (other unsigned extensions may rely on it).
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AEMCP_DIR, EXTENSION_ID, SERVER_NAME, bold, cepExtensionsDir, claudeCodeConfig, claudeDesktopConfig, codexConfig, cursorConfig,
  findClaudeCli, ok, readJson, removeCodexBlock, run, warn, writeJsonWithBackup,
} from "./common.mjs";

console.log(bold("\nAfter Effects MCP uninstaller\n"));
const keepConfig = process.argv.includes("--keep-config");

const extDir = join(cepExtensionsDir(), EXTENSION_ID);
if (existsSync(extDir)) { rmSync(extDir, { recursive: true, force: true }); ok(`Removed extension ${extDir}`); }

if (keepConfig) rmSync(join(AEMCP_DIR, "server"), { recursive: true, force: true });
else rmSync(AEMCP_DIR, { recursive: true, force: true });
ok(keepConfig ? "Removed server (kept ~/.aemcp/config.json)" : `Removed ${AEMCP_DIR}`);

for (const [label, file] of [["Claude Desktop", claudeDesktopConfig()], ["Cursor", cursorConfig()], ["Claude Code", claudeCodeConfig()]]) {
  const data = readJson(file, null);
  if (data?.mcpServers?.[SERVER_NAME]) {
    delete data.mcpServers[SERVER_NAME];
    writeJsonWithBackup(file, data);
    ok(`Removed from ${label}`);
  }
}
const claude = findClaudeCli();
if (claude) {
  try { run(claude, ["mcp", "remove", SERVER_NAME, "--scope", "user"]); ok("Removed from Claude Code"); } catch {}
}
if (existsSync(codexConfig())) {
  const t = readFileSync(codexConfig(), "utf8");
  const n = removeCodexBlock(t);
  if (n !== t) { writeFileSync(codexConfig(), n.trimEnd() + "\n"); ok("Removed from Codex"); }
}
console.log("\nDone. Restart After Effects and your AI apps.");
warn("PlayerDebugMode was left enabled (harmless; other extensions may need it).");
