// Checks GitHub (at most once a day) for a newer release. The result is cached in
// ~/.surehand/ae/update-check.json, which the After Effects panel also reads to show a banner.
// Disable with "updateCheck": false in ~/.surehand/ae/config.json or SUREHAND_AE_NO_UPDATE_CHECK=1 (or AEMCP_NO_UPDATE_CHECK=1).
// The update channel ("updateChannel" in config.json): "stable" (default) only sees GitHub's latest release;
// "beta" also sees pre-releases and takes the newest of all. Neither ever offers an older version, so
// going back to stable keeps a newer beta until a newer stable release is out.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath, loadConfig, VERSION } from "./config.js";
import { readJsonFile, writeFileAtomic } from "./fsutil.js";
import { appFile, env } from "./paths.js";

export const REPO = "ConformLabs/surehand-mcp";
export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const CACHE = () => appFile("update-check.json");
const DAY = 24 * 3600 * 1000;

export type UpdateChannel = "stable" | "beta";

export interface UpdateInfo {
  checkedAt: string;
  current: string;
  latest: string | null;
  url: string;
  updateAvailable: boolean;
  /** the channel it was checked on (older caches have none: stable) */
  channel?: UpdateChannel;
}

export interface Release {
  tag_name: string;
  html_url: string;
  body?: string | null;
  prerelease?: boolean;
  draft?: boolean;
  assets: { name: string; browser_download_url: string; digest?: string | null }[];
}

/** -1 / 0 / 1 comparison of "1.2.3"-style versions (a leading "v" is ignored). */
export function compareVersions(a: string, b: string): number {
  // x.y.z, optionally with a pre-release (1.4.0-beta.1), which comes before x.y.z itself
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, "").split(/-(.*)/s);
    return { n: core.split(".").map((x) => parseInt(x, 10) || 0), pre: pre ? pre.split(".") : null };
  };
  const pa = parse(a), pb = parse(b);
  for (let i = 0; i < 3; i++) if ((pa.n[i] ?? 0) !== (pb.n[i] ?? 0)) return (pa.n[i] ?? 0) > (pb.n[i] ?? 0) ? 1 : -1;
  if (!pa.pre || !pb.pre) return pa.pre ? -1 : pb.pre ? 1 : 0;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i], y = pb.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) > Number(y) ? 1 : -1;
    if (nx !== ny) return nx ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export function updateCheckEnabled(): boolean {
  return !env("NO_UPDATE_CHECK") && loadConfig().updateCheck !== false;
}

export function updateChannel(): UpdateChannel {
  return loadConfig().updateChannel === "beta" ? "beta" : "stable";
}

/** Saves the channel in config.json (stable: the key is removed). Refused while the file can't be read. */
export function setUpdateChannel(channel: UpdateChannel) {
  const file = configPath();
  const r = readJsonFile<Record<string, unknown>>(file);
  if (!r.ok && !r.missing) throw new Error(`${file} can't be read (${r.error}). It was left as it is.`);
  const cfg: Record<string, unknown> = r.ok && r.data && typeof r.data === "object" ? r.data : {};
  if (channel === "beta") cfg.updateChannel = "beta";
  else delete cfg.updateChannel;
  writeFileAtomic(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

/** GET from the GitHub API (or the local stand-in the tests use); throws on an HTTP error. */
export async function ghGet(url: string, timeoutMs = 60_000): Promise<Response> {
  const res = await fetch(url, { headers: { "user-agent": `surehand-ae/${VERSION}`, accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

/**
 * The newest release on the channel. Stable: GitHub's latest release (never a pre-release or a draft).
 * Beta: the newest of the recent releases, pre-releases included (1.4.0-beta.3 < 1.4.0 < 1.4.1-beta.1).
 */
export async function newestRelease(channel: UpdateChannel, timeoutMs = 60_000): Promise<Release> {
  // SUREHAND_AE_RELEASES_API / SUREHAND_AE_RELEASES_LIST_API (or AEMCP_*): for tests only (a local stand-in for GitHub)
  if (channel === "stable") return (await (await ghGet(env("RELEASES_API") || `https://api.github.com/repos/${REPO}/releases/latest`, timeoutMs)).json()) as Release;
  const list = (await (await ghGet(env("RELEASES_LIST_API") || `https://api.github.com/repos/${REPO}/releases?per_page=30`, timeoutMs)).json()) as Release[];
  const found = (Array.isArray(list) ? list : []).filter((r) => r && !r.draft && typeof r.tag_name === "string");
  if (!found.length) throw new Error("no releases found");
  return found.reduce((a, b) => (compareVersions(b.tag_name, a.tag_name) > 0 ? b : a));
}

/** The cached check, if it was made on this channel (switching channels makes it stale). */
function readCache(channel: UpdateChannel): UpdateInfo | null {
  try {
    const c = JSON.parse(readFileSync(CACHE(), "utf8")) as UpdateInfo;
    return (c.channel ?? "stable") === channel ? c : null;
  } catch {
    return null;
  }
}

let current: UpdateInfo | null = null;

/** The latest known result (from this run or the cache) on the current channel, re-evaluated against this version. */
export function knownUpdate(): UpdateInfo | null {
  const channel = updateChannel();
  const c = current && (current.channel ?? "stable") === channel ? current : readCache(channel);
  if (!c?.latest) return null;
  return { ...c, current: VERSION, updateAvailable: compareVersions(c.latest, VERSION) > 0 };
}

/** Saves a release just fetched as the cached check (the panel's banner reads it). */
export function recordCheck(rel: Release, channel: UpdateChannel): UpdateInfo {
  const latest = rel.tag_name.replace(/^v/, "");
  current = { checkedAt: new Date().toISOString(), current: VERSION, latest, url: rel.html_url || RELEASES_URL, updateAvailable: compareVersions(latest, VERSION) > 0, channel };
  try {
    mkdirSync(dirname(CACHE()), { recursive: true });
    writeFileSync(CACHE(), JSON.stringify(current, null, 2));
  } catch {}
  return current;
}

export async function checkForUpdate(force = false): Promise<UpdateInfo | null> {
  if (!updateCheckEnabled()) return null;
  const channel = updateChannel();
  const cached = readCache(channel);
  if (!force && cached && Date.now() - Date.parse(cached.checkedAt) < DAY) return (current = knownUpdate());
  try {
    const rel = await newestRelease(channel, 4000);
    if (!rel?.tag_name) return knownUpdate();
    return recordCheck(rel, channel);
  } catch {
    return knownUpdate(); // offline: never an error
  }
}

/** On stable with a newer beta installed: one line saying it stays (nothing is ever downgraded); else null. */
export function keptBetaNote(channel: UpdateChannel, latest: string | null, version = VERSION): string | null {
  if (channel !== "stable" || !version.includes("-") || !latest || compareVersions(latest, version) >= 0) return null;
  return `You have a beta (v${version}), newer than the latest stable release (v${latest}): it stays until a newer stable release is out.`;
}

export function updateMessage(u: UpdateInfo | null): string | null {
  return u?.updateAvailable ? `A newer version of Surehand MCP is available: v${u.latest} (you have v${u.current}). Download: ${u.url}` : null;
}
