// Permission modes, set in the Surehand MCP panel or ~/.aemcp/config.json:
//   "permissions": { "mode": "full" | "ask" | "read-only", "allowShell": true }
// - full: everything runs (your AI app may still ask you per tool call)
// - ask: every edit and script waits for Allow/Deny in After Effects (Window > Extensions > Surehand MCP)
// - read-only: tools that edit are refused; scripts run, but if one changes the project it is undone
//   (scripts that call executeCommand, begin/endUndoGroup or purge are refused before they run)
// allowShell: false refuses scripts that call system.callSystem (shell commands).
// These are safeguards against mistakes, not a sandbox: a script can still write files.
import { loadConfig } from "./config.js";

export type PermissionMode = "full" | "ask" | "read-only";

export function permissions(): { mode: PermissionMode; allowShell: boolean } {
  const p = loadConfig().permissions || {};
  const mode: PermissionMode = p.mode === "ask" || p.mode === "read-only" ? p.mode : "full";
  return { mode, allowShell: p.allowShell !== false };
}

/** Shell access in script source (system.callSystem, including bracket access). */
export function usesShell(code: string): boolean {
  return /callSystem|\bsystem\s*\[/.test(code);
}

export const READ_ONLY_REFUSAL =
  "Surehand MCP is in read-only mode, so tools that change the project are disabled. " +
  "The user can change this in After Effects: Window > Extensions > Surehand MCP > Permissions.";

export const SHELL_REFUSAL =
  "Shell commands (system.callSystem) are disabled in the Surehand MCP permissions. The user can allow them in " +
  "Window > Extensions > Surehand MCP > Permissions (or \"allowShell\": true in ~/.aemcp/config.json).";

/** Short description of a tool call for the approval prompt in After Effects. */
export function approvalSummary(tool: string, args: Record<string, unknown> | undefined): string {
  if (!args) return tool;
  if (typeof args.code === "string") return args.code;
  const json = JSON.stringify(args);
  return json.length > 1500 ? json.slice(0, 1500) + "…" : json;
}
