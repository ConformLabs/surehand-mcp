// Checks GitHub (at most once a day) for a newer release. The result is cached in
// ~/.aemcp/update-check.json, which the After Effects panel also reads to show a banner.
// Disable with "updateCheck": false in ~/.aemcp/config.json or AEMCP_NO_UPDATE_CHECK=1.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, VERSION } from "./config.js";

export const REPO = "ronyitzhaki/after-effects-mcp";
export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const CACHE = join(homedir(), ".aemcp", "update-check.json");
const DAY = 24 * 3600 * 1000;

export interface UpdateInfo {
  checkedAt: string;
  current: string;
  latest: string | null;
  url: string;
  updateAvailable: boolean;
}

/** -1 / 0 / 1 comparison of "1.2.3"-style versions (a leading "v" is ignored). */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1;
  return 0;
}

export function updateCheckEnabled(): boolean {
  return !process.env.AEMCP_NO_UPDATE_CHECK && loadConfig().updateCheck !== false;
}

function readCache(): UpdateInfo | null {
  try {
    return JSON.parse(readFileSync(CACHE, "utf8"));
  } catch {
    return null;
  }
}

let current: UpdateInfo | null = null;

/** The latest known result (from this run or the cache), re-evaluated against this version. */
export function knownUpdate(): UpdateInfo | null {
  const c = current ?? readCache();
  if (!c?.latest) return null;
  return { ...c, current: VERSION, updateAvailable: compareVersions(c.latest, VERSION) > 0 };
}

export async function checkForUpdate(force = false): Promise<UpdateInfo | null> {
  if (!updateCheckEnabled()) return null;
  const cached = readCache();
  if (!force && cached && Date.now() - Date.parse(cached.checkedAt) < DAY) return (current = knownUpdate());
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { "user-agent": `ae-mcp/${VERSION}`, accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return knownUpdate();
    const rel = (await res.json()) as { tag_name?: string; html_url?: string };
    if (!rel.tag_name) return knownUpdate();
    const latest = rel.tag_name.replace(/^v/, "");
    current = { checkedAt: new Date().toISOString(), current: VERSION, latest, url: rel.html_url || RELEASES_URL, updateAvailable: compareVersions(latest, VERSION) > 0 };
    mkdirSync(dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, JSON.stringify(current, null, 2));
    return current;
  } catch {
    return knownUpdate(); // offline: never an error
  }
}

export function updateMessage(u: UpdateInfo | null): string | null {
  return u?.updateAvailable ? `A newer version of AE MCP is available: v${u.latest} (you have v${u.current}). Download: ${u.url}` : null;
}
