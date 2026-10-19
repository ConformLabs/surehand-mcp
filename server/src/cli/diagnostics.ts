// `surehand-ae diagnostics`: a plain-text report to paste into a bug report. The token is never printed.
import { spawnSync } from "node:child_process";
import { arch, release } from "node:os";
import { join } from "node:path";
import { evalRaw, health } from "../bridge.js";
import { VERSION } from "../config.js";
import { HELPER_VERSION } from "../jsx.js";
import { resolveProfile } from "../tools/profile.js";
import { knownUpdate } from "../update.js";
import { installedExtensionHash, installedExtensionSignature } from "./setup.js";
import { appDir, appFile, configPath, installedServer, legacyDir, migrationPending, MOVED_NOTE } from "../paths.js";
import { migrationLog } from "../migrate.js";
import { CLIENT_IDS, clientInfo } from "./clients.js";
import { CSXS_VERSIONS, extensionDir, isMac, isWin, readJson } from "./util.js";
import { existsSync } from "node:fs";

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

function clientLine(id: (typeof CLIENT_IDS)[number]): string {
  const c = clientInfo(id);
  if (!c.configured) return `${c.name}: ${c.installed ? "not connected" : "not installed"}`;
  let entry = "";
  if (id !== "codex") {
    const servers = readJson<any>(c.configPath!, null)?.mcpServers ?? {};
    const e = servers["surehand-ae"] ?? servers["after-effects"];
    if (e) entry = ` · ${e.command} ${(e.args || []).join(" ")}${e.command && !existsSync(e.command) ? "  (COMMAND MISSING)" : ""}`;
  }
  return `${c.name}: connected${entry}${c.note ? ` (${c.note})` : ""}`;
}

export async function diagnostics(): Promise<string> {
  const L: string[] = ["### Surehand MCP diagnostics", `time: ${new Date().toISOString()}`];
  L.push(`server: v${VERSION} (helpers ${HELPER_VERSION}) · tools profile: ${resolveProfile().name}`);
  L.push(`os: ${process.platform} ${release()} ${arch()} · node ${process.version} at ${process.execPath}`);
  const cfg = readJson<any>(configPath(), null);
  if (cfg) L.push(`config: ${JSON.stringify({ ...cfg, token: cfg.token ? `<set, ${cfg.token.length} chars>` : "MISSING" })}`);
  else L.push(`config: MISSING (${configPath()})`);
  L.push(`folder: ${appDir()}${migrationPending() ? ` (the move from ${legacyDir()} hasn't happened: see ${migrationLog()})` : existsSync(join(legacyDir(), MOVED_NOTE)) ? ` (moved from ${legacyDir()})` : ""}`);
  L.push(`installed server: ${existsSync(installedServer()) ? installedServer() : "not installed (fine when using the .mcpb)"}`);
  L.push(`extension: ${extensionDir()} · ${existsSync(join(extensionDir(), "CSXS", "manifest.xml")) ? `hash ${installedExtensionHash()} (bundled ${__AEMCP_CEP_HASH__})` : "MISSING"}`);
  const sig = installedExtensionSignature();
  L.push(`extension signature: ${sig.ok ? "valid" : sig.problems.join("; ")}`);
  L.push(`PlayerDebugMode: ${debugMode()}`);
  for (const id of CLIENT_IDS) L.push(clientLine(id));
  L.push(`bridge status file: ${JSON.stringify(readJson(appFile("bridge-status.json"), null))}`);
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
