// `ae-mcp diagnostics`: a plain-text report to paste into a bug report. The token is never printed.
import { spawnSync } from "node:child_process";
import { arch, release } from "node:os";
import { join } from "node:path";
import { evalRaw, health } from "../bridge.js";
import { VERSION } from "../config.js";
import { HELPER_VERSION } from "../jsx.js";
import { resolveProfile } from "../tools/profile.js";
import { knownUpdate } from "../update.js";
import { installedExtensionHash, installedExtensionSignature } from "./setup.js";
import {
  AEMCP_DIR, CONFIG_FILE, CSXS_VERSIONS, INSTALLED_SERVER, SERVER_NAME, claudeCodeConfig, claudeDesktopConfig, codexConfig, cursorConfig, extensionDir,
  isMac, isWin, readJson,
} from "./util.js";
import { existsSync, readFileSync } from "node:fs";

function debugMode(): string {
  return CSXS_VERSIONS.map((v) => {
    const r = isWin
      ? spawnSync("reg", ["query", `HKCU\\Software\\Adobe\\CSXS.${v}`, "/v", "PlayerDebugMode"], { encoding: "utf8" })
      : isMac
        ? spawnSync("defaults", ["read", `com.adobe.CSXS.${v}`, "PlayerDebugMode"], { encoding: "utf8" })
        : null;
    return `${v}:${r && r.status === 0 && /(^|\s)1\s*$/m.test(r.stdout) ? "on" : "off"}`;
  }).join(" ");
}

function clientEntry(file: string): string {
  const data = readJson<any>(file, null);
  const e = data?.mcpServers?.[SERVER_NAME];
  if (!e) return data ? "no entry" : "not found";
  return `${e.command} ${(e.args || []).join(" ")}${e.command && !existsSync(e.command) ? "  (COMMAND MISSING)" : ""}`;
}

export async function diagnostics(): Promise<string> {
  const L: string[] = ["### Surehand MCP diagnostics", `time: ${new Date().toISOString()}`];
  L.push(`server: v${VERSION} (helpers ${HELPER_VERSION}) · tools profile: ${resolveProfile().name}`);
  L.push(`os: ${process.platform} ${release()} ${arch()} · node ${process.version} at ${process.execPath}`);
  const cfg = readJson<any>(CONFIG_FILE, null);
  if (cfg) L.push(`config: ${JSON.stringify({ ...cfg, token: cfg.token ? `<set, ${cfg.token.length} chars>` : "MISSING" })}`);
  else L.push(`config: MISSING (${CONFIG_FILE})`);
  L.push(`installed server: ${existsSync(INSTALLED_SERVER) ? INSTALLED_SERVER : "not installed (fine when using the .mcpb)"}`);
  L.push(`extension: ${extensionDir()} · ${existsSync(join(extensionDir(), "CSXS", "manifest.xml")) ? `hash ${installedExtensionHash()} (bundled ${__AEMCP_CEP_HASH__})` : "MISSING"}`);
  const sig = installedExtensionSignature();
  L.push(`extension signature: ${sig.ok ? "valid" : sig.problems.join("; ")}`);
  L.push(`PlayerDebugMode: ${debugMode()}`);
  L.push(`Claude Desktop: ${clientEntry(claudeDesktopConfig())}`);
  L.push(`Claude Code: ${clientEntry(claudeCodeConfig())}`);
  L.push(`Cursor: ${clientEntry(cursorConfig())}`);
  let codex = "not found";
  try {
    codex = readFileSync(codexConfig(), "utf8").includes(`[mcp_servers.${SERVER_NAME}]`) ? "entry present" : "no entry";
  } catch {}
  L.push(`ChatGPT desktop / Codex (${codexConfig()}): ${codex}`);
  L.push(`bridge status file: ${JSON.stringify(readJson(join(AEMCP_DIR, "bridge-status.json"), null))}`);
  const u = knownUpdate();
  L.push(`update: ${u ? `latest v${u.latest}${u.updateAvailable ? " (UPDATE AVAILABLE)" : ""}` : "unknown"}`);
  try {
    const h = await health();
    L.push(`bridge: reachable · ${h.host?.appName} ${h.host?.appVersion} · bridge v${h.version} · authorized ${(h as any).authorized}`);
    const r = await evalRaw(
      "(function(){var w=null;try{w=app.preferences.getPrefAsLong('Main Pref Section','Pref_SCRIPTING_FILE_NETWORK_SECURITY')===1;}catch(e){}" +
        "return 'ae: '+app.version+' · '+$.os+' · items '+app.project.numItems+' · scriptsCanWriteFiles '+w+' · helpers '+(typeof aemcp==='undefined'?'not loaded':aemcp.version);})()",
      10000,
    );
    L.push(r);
  } catch (e: any) {
    L.push(`bridge: NOT reachable (${e.message.split(".")[0]})`);
  }
  return L.join("\n");
}
