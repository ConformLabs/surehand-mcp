import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
}

export function configPath(): string {
  return process.env.AEMCP_CONFIG || join(homedir(), ".aemcp", "config.json");
}

/** Read on every call so a re-install / token change is picked up without restarting clients. */
export function loadConfig(): AemcpConfig {
  let file: Partial<AemcpConfig> = {};
  try {
    file = JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    // no config yet: defaults (the AE bridge writes one on first start)
  }
  return {
    bridgePort: Number(process.env.AEMCP_BRIDGE_PORT || file.bridgePort || 8765),
    token: process.env.AEMCP_TOKEN || file.token || "",
    httpPort: Number(process.env.AEMCP_HTTP_PORT || file.httpPort || 8766),
    toolProfile: file.toolProfile,
    updateCheck: file.updateCheck,
    changeReport: file.changeReport,
    permissions: file.permissions,
    instance: file.instance,
    scriptFolders: file.scriptFolders,
  };
}
