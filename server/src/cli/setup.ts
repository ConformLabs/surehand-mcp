// After Effects side of the install: the CEP extension and the shared config. The extension is
// signed, so After Effects loads it without PlayerDebugMode; that is only enabled for an unsigned
// (development) build.
// Runs from the installer and (quietly) every time the server starts, so installing only the
// Claude Desktop extension (.mcpb) is enough.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { checkSignature, SIGNATURE_FILE, type SignatureCheck } from "./signature.js";
import { VERSION } from "../config.js";
import { compareVersions } from "../update.js";
import { fileURLToPath } from "node:url";
import { appDir, appFile, configPath, installedServer } from "../paths.js";
import { CSXS_VERSIONS, extensionDir, isMac, isWin, readJson, stableNodePath } from "./util.js";

// Kept outside the extension folder: an extra file inside it would break the signature.
const HASH_FILE = () => appFile("extension-hash");

/** True when this build ships a signed extension (always, for release builds). */
export const bundledExtensionSigned = SIGNATURE_FILE in __AEMCP_CEP_FILES__;

export interface SetupResult {
  extensionInstalled: boolean; // files were written (new install or update)
  extensionUpdated: boolean; // an older version was replaced
  debugModeChanged: boolean;
  configCreated: boolean;
  errors: string[];
}

/** Outcome of the automatic setup at server start, reported by ae_status / connection errors. */
export let lastSetup: SetupResult | null = null;

export function ensureConfig(): boolean {
  const file = configPath();
  const cfg = readJson<Record<string, unknown>>(file, {});
  if (cfg.token && cfg.bridgePort && cfg.httpPort) return false;
  cfg.token ||= randomBytes(24).toString("hex");
  cfg.bridgePort ||= 8765;
  cfg.httpPort ||= 8766;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  return true;
}

// "<hash> <version>" of the installed extension. Older releases wrote only the hash.
function readMarker(): string[] {
  try {
    return readFileSync(HASH_FILE(), "utf8").trim().split(/\s+/);
  } catch {
    return [];
  }
}

export function installedExtensionHash(): string | null {
  return readMarker()[0] || null;
}

export function installedExtensionVersion(): string | null {
  return readMarker()[1] || null;
}

export function ensureExtension(force = false): { installed: boolean; updated: boolean } {
  const dir = extensionDir();
  const current = installedExtensionHash();
  const present = existsSync(join(dir, "CSXS", "manifest.xml"));
  if (!force && current === __AEMCP_CEP_HASH__ && present) return { installed: false, updated: false };
  // someone may run two copies (e.g. the Claude Desktop extension and the standalone install):
  // never let the older one replace a newer extension
  const installedVersion = installedExtensionVersion();
  if (!force && present && installedVersion && compareVersions(installedVersion, VERSION) > 0) return { installed: false, updated: false };
  const updated = existsSync(dir);
  rmSync(dir, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(__AEMCP_CEP_FILES__)) {
    const p = join(dir, ...rel.split("/"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  mkdirSync(appDir(), { recursive: true });
  writeFileSync(HASH_FILE(), `${__AEMCP_CEP_HASH__} ${VERSION}`);
  return { installed: true, updated };
}

/** Checks the installed extension's files against its signature. */
export function installedExtensionSignature(): SignatureCheck {
  const root = extensionDir();
  const files: Record<string, Buffer> = {};
  try {
    (function walk(dir: string) {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else files[relative(root, p).split(sep).join("/")] = readFileSync(p);
      }
    })(root);
  } catch {
    return { signed: false, ok: false, problems: [`extension not found at ${root}`] };
  }
  return checkSignature(files);
}

function debugModeOn(v: number): boolean {
  if (isMac) {
    const r = spawnSync("defaults", ["read", `com.adobe.CSXS.${v}`, "PlayerDebugMode"], { encoding: "utf8" });
    return r.status === 0 && r.stdout.trim() === "1";
  }
  if (isWin) {
    const r = spawnSync("reg", ["query", `HKCU\\Software\\Adobe\\CSXS.${v}`, "/v", "PlayerDebugMode"], { encoding: "utf8" });
    return r.status === 0 && /PlayerDebugMode\s+REG_SZ\s+1/.test(r.stdout);
  }
  return true;
}

export function debugModeEnabled(): boolean {
  return CSXS_VERSIONS.every(debugModeOn);
}

/** Unsigned CEP extensions only load with PlayerDebugMode=1. Returns true if anything changed. */
export function ensureDebugMode(): boolean {
  let changed = false;
  for (const v of CSXS_VERSIONS) {
    if (debugModeOn(v)) continue;
    const r = isWin
      ? spawnSync("reg", ["add", `HKCU\\Software\\Adobe\\CSXS.${v}`, "/v", "PlayerDebugMode", "/t", "REG_SZ", "/d", "1", "/f"])
      : spawnSync("defaults", ["write", `com.adobe.CSXS.${v}`, "PlayerDebugMode", "1"]);
    if (r.status !== 0) throw new Error(`could not enable PlayerDebugMode for CSXS.${v}`);
    changed = true;
  }
  return changed;
}

export function ensureAeSetup(opts: { forceExtension?: boolean } = {}): SetupResult {
  const res: SetupResult = { extensionInstalled: false, extensionUpdated: false, debugModeChanged: false, configCreated: false, errors: [] };
  try {
    res.configCreated = ensureConfig();
  } catch (e: any) {
    res.errors.push(`config: ${e.message}`);
  }
  try {
    const r = ensureExtension(opts.forceExtension);
    res.extensionInstalled = r.installed;
    res.extensionUpdated = r.updated;
  } catch (e: any) {
    res.errors.push(`extension: ${e.message}`);
  }
  if (!bundledExtensionSigned) {
    try {
      res.debugModeChanged = ensureDebugMode();
    } catch (e: any) {
      res.errors.push(`PlayerDebugMode: ${e.message}`);
    }
  }
  lastSetup = res;
  return res;
}

/** Human hint used when After Effects can't be reached. */
export function setupHint(): string {
  if (lastSetup && (lastSetup.extensionInstalled || lastSetup.debugModeChanged))
    return " The After Effects extension was just installed/updated: please restart After Effects once to load it.";
  return "";
}

/** Where the standalone install runs from, for the Surehand MCP panel (Update button, Connect and
 *  Checkpoints screens: it runs `node <server> <command>`). Only the standalone server
 *  (~/.surehand/ae/server) records itself: the Claude Desktop extension is updated by installing a new .mcpb. */
export const runtimeFile = () => appFile("runtime.json");
export function recordRuntime() {
  try {
    const server = installedServer();
    if (fileURLToPath(import.meta.url) !== server) return;
    const info = { node: stableNodePath(), server, version: VERSION };
    if (JSON.stringify(readJson(runtimeFile(), null)) === JSON.stringify(info)) return;
    writeFileSync(runtimeFile(), JSON.stringify(info, null, 2));
  } catch {}
}
