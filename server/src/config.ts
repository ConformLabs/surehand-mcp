import { join } from "node:path";
import { readJsonFile, sleepSync } from "./fsutil.js";
import { configPath, defaultConfigPath, env, legacyDir } from "./paths.js";

export { configPath };

export const VERSION = __AEMCP_VERSION__;

export interface AemcpConfig {
  bridgePort: number;
  token: string;
  httpPort: number;
  /** "core" (default) | "full" | "core,extra_tool,..." */
  toolProfile?: string;
  /** set to false to disable the GitHub update check */
  updateCheck?: boolean;
  /** "stable" (default) | "beta": beta updates also offer GitHub pre-releases */
  updateChannel?: string;
  /** set to false to turn off the change report after edits */
  changeReport?: boolean;
  /** "full" | "ask" | "read-only", and whether scripts may run shell commands */
  permissions?: { mode?: string; allowShell?: boolean };
  /** preferred After Effects instance when several run: "2026", "26.5" or a bridge port */
  instance?: string;
  /** extra folders with the user's own scripts, listed by ae_list_scripts */
  scriptFolders?: string[];
  /** report "After Effects is blocked" when it hasn't accepted a script for this long (default 3, 0 = off) */
  blockedAfterSeconds?: number;
  /** how long ae_status waits for an After Effects that is still starting (default 15) */
  startupWaitSeconds?: number;
  /** Preflight: ffmpeg / ffprobe to use instead of searching (absolute paths) */
  ffmpegPath?: string;
  ffprobePath?: string;
  /** set when config.json is there but can't be read and no earlier good copy is known: edits are refused */
  unreadable?: string;
}

// The last config.json that parsed, per file: a torn read (another process writing it right now, a
// half-saved edit) falls back to it instead of to defaults (which would mean "full" permissions).
const lastGood = new Map<string, Partial<AemcpConfig>>();

/** The file's settings; {} when it doesn't exist; {unreadable} when it exists but can't be read (and no good copy is known). */
function readFile(file: string): Partial<AemcpConfig> | { unreadable: string } {
  let reason = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = readJsonFile<Partial<AemcpConfig>>(file);
    if (r.ok) {
      const cfg = r.data && typeof r.data === "object" ? r.data : {};
      lastGood.set(file, cfg);
      return cfg;
    }
    if (r.missing) return {};
    reason = r.error;
    sleepSync(15); // a moment for a writer to finish
  }
  return lastGood.get(file) ?? { unreadable: `${file}: ${reason}` };
}

/** Tests: forget the remembered good configs. */
export function resetConfigCache() {
  lastGood.clear();
}

/** Read on every call so a re-install / token change is picked up without restarting clients. */
export function loadConfig(): AemcpConfig {
  // no config yet: defaults (the AE bridge writes one on first start)
  const read = readFile(configPath());
  const unreadable = "unreadable" in read && typeof read.unreadable === "string" && !("token" in read) ? read.unreadable : undefined;
  const file: Partial<AemcpConfig> = unreadable ? {} : (read as Partial<AemcpConfig>);
  // Moving from 1.3: an After Effects that hasn't restarted still runs the 1.3 extension, which uses
  // ~/.aemcp/config.json. Its token is accepted while the new config has none.
  const legacy: Partial<AemcpConfig> = !file.token && !unreadable && defaultConfigPath() ? (readFile(join(legacyDir(), "config.json")) as Partial<AemcpConfig>) : {};
  return {
    bridgePort: Number(env("BRIDGE_PORT") || file.bridgePort || 8765),
    token: env("TOKEN") || file.token || legacy.token || "",
    httpPort: Number(env("HTTP_PORT") || file.httpPort || 8766),
    toolProfile: file.toolProfile,
    updateCheck: file.updateCheck,
    updateChannel: file.updateChannel,
    changeReport: file.changeReport,
    permissions: file.permissions,
    instance: file.instance,
    scriptFolders: file.scriptFolders,
    blockedAfterSeconds: file.blockedAfterSeconds,
    startupWaitSeconds: file.startupWaitSeconds,
    ffmpegPath: file.ffmpegPath,
    ffprobePath: file.ffprobePath,
    ...(unreadable ? { unreadable } : {}),
  };
}
