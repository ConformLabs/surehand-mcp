// Names and folders of Surehand MCP for After Effects.
//
// Surehand is a family of servers (After Effects now; Photoshop, Premiere later), so everything lives
// under one shared root, with one folder per app:
//   ~/.surehand              (Windows: %USERPROFILE%\.surehand)  shared: node/ (private Node.js), ffmpeg/
//   ~/.surehand/ae           this app: config.json, instances/, server/surehand-ae.mjs, checkpoints/, ...
// Versions up to 1.3 kept everything in ~/.aemcp; src/migrate.ts moves it (once, automatically).
//
// Every path is computed when asked (never at import time): tests point the home folder elsewhere,
// and the app folder depends on whether that move has happened (see appDir).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The app's short name in the family (`surehand-<app>`, ~/.surehand/<app>). */
export const APP = "ae";
/** The command, the MCP server name and the key in AI apps' settings. */
export const SERVER_NAME = "surehand-ae";
/** The name 1.3 and earlier registered in AI apps. Only removed where it points at our own server. */
export const LEGACY_SERVER_NAME = "after-effects";
/** The installed single-file server, and the name 1.3 used. Releases carry both. */
export const SERVER_FILE = "surehand-ae.mjs";
export const LEGACY_SERVER_FILE = "ae-mcp.mjs";
/** Written into the legacy folder once its contents have moved. */
export const MOVED_NOTE = "MOVED.txt";

/** The shared root, ~/.surehand. */
export const surehandRoot = () => join(homedir(), ".surehand");
/** This app's own folder, ~/.surehand/ae (where it is once any 1.3 data has moved). */
export const newAppDir = () => join(surehandRoot(), APP);
/** Where 1.3 and earlier kept everything. */
export const legacyDir = () => join(homedir(), ".aemcp");

/**
 * Written before the move from ~/.aemcp renames anything, removed after its last step: while it is
 * there, a move has started and not finished (perhaps the process was killed), and the next run
 * finishes it. It holds the plan (JSON).
 */
export const migrationMarker = () => join(surehandRoot(), ".migrate-ae.inprogress");
export const migrationInProgress = () => existsSync(migrationMarker());

/** Written into ~/.aemcp by a still-running 1.3 extension or server: status, not the user's data. */
export const LEGACY_VOLATILE = new Set(["bridge-status.json", "update-check.json", "extension-hash", "tmp"]);
/** In the forwarding file the move leaves at ~/.aemcp/server/ae-mcp.mjs (migrate.ts forwarder). */
export const FORWARDER_MARK = "AI app settings from version 1.3 still start this file";

/** True when ~/.aemcp/server/ae-mcp.mjs is only the forwarder the move left (not a 1.3 server). */
export function isForwarder(file: string): boolean {
  try {
    return readFileSync(file, "utf8").includes(FORWARDER_MARK);
  } catch {
    return false;
  }
}

/**
 * Entries of ~/.aemcp that are not a 1.3 installation's data: the private Node.js and ffmpeg (runtimes, or
 * links the move left), status files, the bridges' registrations, and a server/ that holds nothing but the
 * forwarder. What an uninstall can leave behind (a Node.js in use) is one of these, so it never makes a
 * later install work from ~/.aemcp again. A 1.3 installation always has more (its config.json, its server).
 */
function legacyLeftover(l: string, name: string): boolean {
  if (name === "node" || name === "ffmpeg" || name === "instances" || LEGACY_VOLATILE.has(name)) return true;
  if (name !== "server") return false;
  try {
    return readdirSync(join(l, name)).every((f) => f === LEGACY_SERVER_FILE && isForwarder(join(l, name, f)));
  } catch {
    return false;
  }
}

/**
 * True while the move from ~/.aemcp isn't complete: a move started and not finished (the marker), or
 * ~/.aemcp holds 1.3 data and no MOVED.txt (before the move ran, or after it failed: it then leaves
 * ~/.aemcp as it was, and everything keeps working from there). Leftovers that aren't data (legacyLeftover)
 * don't count.
 */
export function migrationPending(): boolean {
  if (migrationInProgress()) return true;
  const l = legacyDir();
  if (!existsSync(l) || existsSync(join(l, MOVED_NOTE))) return false;
  try {
    return readdirSync(l).some((n) => !legacyLeftover(l, n));
  } catch {
    return false;
  }
}

/**
 * The folder this app reads and writes: ~/.surehand/ae, or ~/.aemcp while its data hasn't started
 * moving. Once a move has started (even if it was interrupted), new data goes to ~/.surehand/ae.
 */
export const appDir = () => (migrationPending() && !migrationInProgress() ? legacyDir() : newAppDir());

/** The installed standalone server (what AI apps run). */
export const installedServer = () => {
  if (appDir() === legacyDir()) return join(legacyDir(), "server", LEGACY_SERVER_FILE);
  // an interrupted move moves the server last: until then it is still in ~/.aemcp
  const moved = join(newAppDir(), "server", SERVER_FILE), old = join(legacyDir(), "server", LEGACY_SERVER_FILE);
  return migrationInProgress() && !existsSync(moved) && existsSync(old) ? old : moved;
};

/** Shared between the Surehand apps: the private Node.js and Preflight's ffmpeg. */
export const privateNodeDir = () => (migrationPending() && existsSync(join(legacyDir(), "node")) ? join(legacyDir(), "node") : join(surehandRoot(), "node"));
export const privateFfmpegDir = () =>
  migrationPending() && existsSync(join(legacyDir(), "ffmpeg")) ? join(legacyDir(), "ffmpeg") : join(surehandRoot(), "ffmpeg");

/** Shared between the Surehand apps: programs downloaded for them (cloudflared), ~/.surehand/bin. */
export const sharedBinDir = () => join(surehandRoot(), "bin");

export const appFile = (...parts: string[]) => join(appDir(), ...parts);

/**
 * An environment setting: SUREHAND_AE_<name>, else the older AEMCP_<name> (both keep working).
 * Empty values count as unset.
 */
export function env(name: string): string | undefined {
  return process.env[`SUREHAND_AE_${name}`] || process.env[`AEMCP_${name}`] || undefined;
}

/**
 * The config file: SUREHAND_AE_CONFIG / AEMCP_CONFIG, else ~/.surehand/ae/config.json, or
 * ~/.aemcp/config.json while only that one exists: the same rule as the extension's paths.js, so
 * the server and After Effects always use the same file (also during an interrupted move), and a new
 * config is never created in ~/.aemcp.
 */
export const configPath = () => {
  const override = env("CONFIG");
  if (override) return override;
  const fresh = join(newAppDir(), "config.json"), old = join(legacyDir(), "config.json");
  return !existsSync(fresh) && existsSync(old) ? old : fresh;
};
/** True when the config path is the default one (not moved with SUREHAND_AE_CONFIG / AEMCP_CONFIG). */
export const defaultConfigPath = () => !env("CONFIG");
