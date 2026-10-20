// Permission modes, set in the Surehand MCP panel or ~/.surehand/ae/config.json:
//   "permissions": { "mode": "full" | "ask" | "read-only", "allowShell": true }
// - full: everything runs (your AI app may still ask you per tool call)
// - ask: every edit and script waits for Allow/Deny in After Effects (the Surehand panel, or its approval pop-up)
// - read-only: tools that edit are refused; scripts run, but if one changes the project it is undone
//   (scripts that call executeCommand, begin/endUndoGroup or purge are refused before they run)
// allowShell: false refuses scripts that call system.callSystem (shell commands).
// These are safeguards against mistakes, not a sandbox: a script can still write files.
import { loadConfig } from "./config.js";

export type PermissionMode = "full" | "ask" | "read-only";

const READ_ONLY_TEXT =
  "Surehand MCP is in read-only mode, so tools that change the project are disabled. " +
  "The user can change this with the mode selector (Full / Ask / Read-only) at the top of the Surehand panel in After Effects (Window > Extensions > Surehand MCP).";

/**
 * The permissions in force. A config.json that is there but can't be read (and was never read
 * successfully by this process) fails closed: read-only, no shell, and the refusal says why.
 */
export function permissions(): { mode: PermissionMode; allowShell: boolean; unreadable?: string } {
  const cfg = loadConfig();
  if (cfg.unreadable) {
    READ_ONLY_REFUSAL = configUnreadableRefusal(cfg.unreadable);
    return { mode: "read-only", allowShell: false, unreadable: cfg.unreadable };
  }
  READ_ONLY_REFUSAL = READ_ONLY_TEXT;
  const p = cfg.permissions || {};
  const mode: PermissionMode = p.mode === "ask" || p.mode === "read-only" ? p.mode : "full";
  return { mode, allowShell: p.allowShell !== false };
}

export const configUnreadableRefusal = (why: string) =>
  `Surehand MCP's settings file can't be read (${why}), so changes to the project are refused until it is fixed. ` +
  "Nothing was run. Ask the user to check the file (or re-run the installer, which keeps a good file as it is).";

/** Shell access in script source (system.callSystem, including bracket access). */
export function usesShell(code: string): boolean {
  return /callSystem|\bsystem\s*\[/.test(code);
}

/**
 * The refusal for edits while they aren't allowed. A live binding: permissions() sets it to the
 * "settings file can't be read" text while that is the reason.
 */
export let READ_ONLY_REFUSAL = READ_ONLY_TEXT;

export const SHELL_REFUSAL =
  "Shell commands (system.callSystem) are disabled in the Surehand MCP permissions. The user can allow them in the " +
  "Surehand panel in After Effects: \u2630 menu \u203a Shell commands in scripts \u203a Allowed (or \"allowShell\": true in ~/.surehand/ae/config.json).";

/** Where After Effects' own setting is, on Mac and Windows. */
export const WRITE_ACCESS_WHERE =
  "After Effects > Settings > Scripting & Expressions (Windows: Edit > Preferences > Scripting & Expressions)";

/**
 * A call that has to write files from ExtendScript while "Allow Scripts to Write Files and Access Network"
 * is off, refused before it changes anything (aemcp.needWriteAccess). {what}: what it needed to do.
 */
export const WRITE_ACCESS_REFUSAL =
  "Nothing ran. After Effects doesn't allow scripts to write files, and this call needs to {what}. " +
  `Ask the user to turn on 'Allow Scripts to Write Files and Access Network' in ${WRITE_ACCESS_WHERE}, then try again.`;

/** Added to a failed call while the setting is off: a save, an export or a script's own File writes may fail because of it. */
export const WRITE_ACCESS_HINT =
  "Note: 'Allow Scripts to Write Files and Access Network' is off in After Effects. If this call failed because it writes files, " +
  `uses the network or runs a shell command, ask the user to turn it on in ${WRITE_ACCESS_WHERE}.`;

/**
 * What the approval prompt in After Effects shows for a tool call: the script, or the call's
 * arguments. Sent in full: the bridge checks all of it for risks, and shortens only what is shown
 * (saying how much is not shown).
 */
export function approvalSummary(tool: string, args: Record<string, unknown> | undefined): string {
  if (!args) return tool;
  if (typeof args.code === "string") return args.code;
  return JSON.stringify(args);
}

/** How much of a script file the approval prompt shows. */
export const APPROVAL_FILE_CHARS = 4000;

/** `text` cut to `max` characters, saying how many more there are. */
export function truncateNote(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… ${text.length - max} more characters not shown` : text;
}

/** The approval for ae_run_script_file: the file's path and contents (the start of them; all are checked for risks). */
export function scriptFileApproval(path: string, source: string): { tool: string; summary: string; full: string } {
  const body = source ? source : "(the file could not be read here: After Effects runs it as it is on disk)";
  return { tool: "Run script file", summary: `${path}\n\n${truncateNote(body, APPROVAL_FILE_CHARS)}`, full: `${path}\n\n${body}` };
}
