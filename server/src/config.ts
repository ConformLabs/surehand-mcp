import { readFileSync } from "node:fs";
import { join } from "node:path";
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
}

function readFile(file: string): Partial<AemcpConfig> {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/** Read on every call so a re-install / token change is picked up without restarting clients. */
export function loadConfig(): AemcpConfig {
  // no config yet: defaults (the AE bridge writes one on first start)
  const file = readFile(configPath());
  // Moving from 1.3: an After Effects that hasn't restarted still runs the 1.3 extension, which uses
  // ~/.aemcp/config.json. Its token is accepted while the new config has none.
  const legacyToken = !file.token && defaultConfigPath() ? readFile(join(legacyDir(), "config.json")).token : undefined;
  return {
    bridgePort: Number(env("BRIDGE_PORT") || file.bridgePort || 8765),
    token: env("TOKEN") || file.token || legacyToken || "",
    httpPort: Number(env("HTTP_PORT") || file.httpPort || 8766),
    toolProfile: file.toolProfile,
    updateCheck: file.updateCheck,
    changeReport: file.changeReport,
    permissions: file.permissions,
    instance: file.instance,
    scriptFolders: file.scriptFolders,
    blockedAfterSeconds: file.blockedAfterSeconds,
    startupWaitSeconds: file.startupWaitSeconds,
    ffmpegPath: file.ffmpegPath,
    ffprobePath: file.ffprobePath,
  };
}
