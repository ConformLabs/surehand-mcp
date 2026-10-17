// After Effects side of the install: the CEP extension, PlayerDebugMode, and the shared config.
// Runs from the installer and (quietly) every time the server starts, so installing only the
// Claude Desktop extension (.mcpb) is enough.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AEMCP_DIR, CONFIG_FILE, CSXS_VERSIONS, extensionDir, isMac, isWin, readJson } from "./util.js";

const HASH_FILE = ".aemcp-hash";

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
  const cfg = readJson<Record<string, unknown>>(CONFIG_FILE, {});
  if (cfg.token && cfg.bridgePort && cfg.httpPort) return false;
  cfg.token ||= randomBytes(24).toString("hex");
  cfg.bridgePort ||= 8765;
  cfg.httpPort ||= 8766;
  mkdirSync(AEMCP_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  return true;
}

export function installedExtensionHash(): string | null {
  try {
    return readFileSync(join(extensionDir(), HASH_FILE), "utf8").trim();
  } catch {
    return null;
  }
}

export function ensureExtension(force = false): { installed: boolean; updated: boolean } {
  const dir = extensionDir();
  const current = installedExtensionHash();
  if (!force && current === __AEMCP_CEP_HASH__ && existsSync(join(dir, "CSXS", "manifest.xml"))) return { installed: false, updated: false };
  const updated = existsSync(dir);
  rmSync(dir, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(__AEMCP_CEP_FILES__)) {
    const p = join(dir, ...rel.split("/"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  writeFileSync(join(dir, HASH_FILE), __AEMCP_CEP_HASH__);
  return { installed: true, updated };
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
  try {
    res.debugModeChanged = ensureDebugMode();
  } catch (e: any) {
    res.errors.push(`PlayerDebugMode: ${e.message}`);
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
