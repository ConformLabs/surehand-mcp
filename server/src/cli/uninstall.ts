import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AEMCP_DIR, SERVER_NAME, bold, claudeCodeConfig, claudeDesktopConfig, codexConfig, cursorConfig, extensionDir, findClaudeCli, ok,
  readJson, removeCodexBlock, run, warn, writeJsonWithBackup,
} from "./util.js";

export function uninstall(argv: string[]) {
  console.log(bold("\nAfter Effects MCP uninstaller\n"));
  const keepConfig = argv.includes("--keep-config");

  if (existsSync(extensionDir())) {
    rmSync(extensionDir(), { recursive: true, force: true });
    ok(`Removed the After Effects extension`);
  }
  // ~/.aemcp/node (a Node runtime the installer may have downloaded) may be running this very
  // process, so the uninstall wrapper deletes it after we exit.
  if (existsSync(AEMCP_DIR))
    for (const name of readdirSync(AEMCP_DIR))
      if (name !== "node" && !(keepConfig && name === "config.json")) rmSync(join(AEMCP_DIR, name), { recursive: true, force: true });
  ok(keepConfig ? "Removed the server (kept ~/.aemcp/config.json)" : `Removed ${AEMCP_DIR}`);

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
  warn("PlayerDebugMode was left enabled (harmless; other extensions may rely on it).");
}
