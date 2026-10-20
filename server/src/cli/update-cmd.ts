// `surehand-ae update`: installs the latest GitHub release over the standalone install
// (~/.surehand/ae/server/surehand-ae.mjs) and updates the After Effects extension. The Surehand MCP
// panel's Update button runs this too (with --json); `update --check --json` only reports.
// "Latest" is on the update channel (config.json updateChannel, or `--channel beta|stable`): beta also
// takes pre-releases. An older release is never installed, so a beta stays after going back to stable.
//
// Each release carries the single-file server as surehand-ae.mjs, and the same file as ae-mcp.mjs
// (the name 1.3's updater downloads). This updater takes surehand-ae.mjs, else ae-mcp.mjs (older
// releases). It is checked against the SHA-256 digest GitHub publishes for the asset (or the
// <asset>.sha256 file), and must report the expected version before it replaces the installed one;
// the previous file is kept as surehand-ae.mjs.previous.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../config.js";
import { installedServer, LEGACY_SERVER_FILE, SERVER_FILE } from "../paths.js";
import { compareVersions, ghGet as get, keptBetaNote, newestRelease, recordCheck, RELEASES_URL, setUpdateChannel, updateChannel, updateCheckEnabled, type Release, type UpdateChannel } from "../update.js";
import { moveFromLegacy, repointLegacyClients } from "./clients.js";
import { bold, fail, ok, warn } from "./util.js";

/** The release asset names, preferred first: 1.4+ releases carry both, older ones only ae-mcp.mjs. */
export const SERVER_ASSETS = [SERVER_FILE, LEGACY_SERVER_FILE];

export interface UpdateResult {
  ok: boolean;
  from: string;
  to: string | null;
  updated: boolean;
  message: string;
  url?: string;
  restartAfterEffects?: boolean;
}

/** The server file to download from a release: surehand-ae.mjs, else ae-mcp.mjs; null if neither. */
export function chooseAsset(rel: Pick<Release, "assets">): Release["assets"][number] | null {
  for (const name of SERVER_ASSETS) {
    const a = rel.assets.find((x) => x.name === name);
    if (a) return a;
  }
  return null;
}

/** The newest release on the channel; the cached check (the panel's banner) is refreshed with it. */
async function latestRelease(channel: UpdateChannel): Promise<Release> {
  const rel = await newestRelease(channel);
  if (typeof rel?.tag_name !== "string") throw new Error("GitHub's answer has no release");
  if (updateCheckEnabled()) recordCheck(rel, channel);
  return rel;
}

/** `update --check --json`: {latest, current, updateAvailable, url, checkedAt, channel, notes?, keptBeta?} (error when GitHub can't be reached). */
export interface UpdateCheck {
  latest: string | null;
  current: string;
  updateAvailable: boolean;
  url: string;
  checkedAt: string;
  channel: UpdateChannel;
  /** on stable with a newer beta installed: says it stays */
  keptBeta?: string;
  /** the release notes, one line each (markdown bullets and heading marks removed) */
  notes?: string[];
  error?: string;
}

/**
 * Release notes as lines for the panel: bullet marks removed, a heading kept as "### title" (the panel
 * shows it as a bold line). Inline **bold** and `code` stay; the panel renders them as text, never HTML.
 */
export function noteLines(body: string | null | undefined): string[] {
  return (body ?? "")
    .split(/\r?\n/)
    .map((l) => (/^\s*#{1,6}\s+/.test(l) ? l.replace(/^\s*#{1,6}\s+/, "### ") : l.replace(/^\s*[-*+]\s+/, "")).trim())
    .filter((l) => l && l !== "###")
    .filter(Boolean)
    .slice(0, 60);
}

/** `update --check`: what the latest release is, without installing anything. */
export async function checkUpdate(): Promise<UpdateCheck> {
  const checkedAt = new Date().toISOString();
  const channel = updateChannel();
  try {
    const rel = await latestRelease(channel);
    const latest = rel.tag_name.replace(/^v/, "");
    const notes = noteLines(rel.body);
    const keptBeta = keptBetaNote(channel, latest);
    return {
      latest, current: VERSION, updateAvailable: compareVersions(latest, VERSION) > 0, url: rel.html_url || RELEASES_URL, checkedAt, channel,
      ...(notes.length ? { notes } : {}), ...(keptBeta ? { keptBeta } : {}),
    };
  } catch (e: any) {
    return { latest: null, current: VERSION, updateAvailable: false, url: RELEASES_URL, checkedAt, channel, error: `Could not reach GitHub to check for updates (${e.message}).` };
  }
}

/** The expected SHA-256 (hex) of the server asset: GitHub's own digest, else the .sha256 file. */
async function expectedDigest(rel: Release, asset: Release["assets"][number]): Promise<string> {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? "");
  if (m) return m[1].toLowerCase();
  const side = rel.assets.find((a) => a.name === `${asset.name}.sha256`);
  if (!side) throw new Error(`the release has no checksum for ${asset.name}`);
  const hex = /[0-9a-f]{64}/i.exec(await (await get(side.browser_download_url)).text())?.[0];
  if (!hex) throw new Error(`unreadable ${asset.name}.sha256`);
  return hex.toLowerCase();
}

export async function runUpdate(): Promise<UpdateResult> {
  const base = { from: VERSION, to: null, updated: false };
  const channel = updateChannel();
  let rel: Release;
  try {
    rel = await latestRelease(channel);
  } catch (e: any) {
    return { ...base, ok: false, message: `Could not reach GitHub to check for updates (${e.message}).` };
  }
  const latest = rel.tag_name.replace(/^v/, "");
  // never older: on stable, a newer beta stays until a newer stable release is out
  if (compareVersions(latest, VERSION) <= 0) {
    const kept = keptBetaNote(channel, latest);
    return { ...base, ok: true, to: latest, message: `Surehand MCP is up to date (v${VERSION}).${kept ? ` ${kept}` : ""}` };
  }
  const asset = chooseAsset(rel);
  if (!asset) return { ...base, ok: false, to: latest, url: rel.html_url, message: `v${latest} can't be installed automatically. Download it from ${rel.html_url}` };

  // a 1.3 installation moves to ~/.surehand/ae first, so the new server lands in its new place
  moveFromLegacy({ force: true });
  const INSTALLED_SERVER = installedServer();
  // keeps the .mjs ending: Node only runs ES modules with a known file extension
  const tmp = INSTALLED_SERVER.replace(/\.mjs$/, ".download.mjs");
  try {
    const [body, want] = await Promise.all([get(asset.browser_download_url).then((r) => r.arrayBuffer()), expectedDigest(rel, asset)]);
    const bytes = Buffer.from(body);
    const got = createHash("sha256").update(bytes).digest("hex");
    if (got !== want) throw new Error(`checksum mismatch (expected ${want.slice(0, 12)}…, got ${got.slice(0, 12)}…)`);
    mkdirSync(dirname(INSTALLED_SERVER), { recursive: true });
    writeFileSync(tmp, bytes);
    // it must start and report the release's version before it replaces anything
    const v = spawnSync(process.execPath, [tmp, "--version"], { encoding: "utf8", timeout: 30_000 });
    if (v.status !== 0 || v.stdout.trim() !== latest) throw new Error(`the downloaded server did not start correctly (${(v.stderr || v.stdout).trim().slice(0, 200)})`);
    if (existsSync(INSTALLED_SERVER)) copyFileSync(INSTALLED_SERVER, `${INSTALLED_SERVER}.previous`);
    renameSync(tmp, INSTALLED_SERVER);
  } catch (e: any) {
    rmSync(tmp, { force: true });
    return { ...base, ok: false, to: latest, url: rel.html_url, message: `Update to v${latest} failed: ${e.message}. Nothing was changed.` };
  }

  // the new server installs its own After Effects extension (and, being new, finishes any move from 1.3)
  const setup = spawnSync(process.execPath, [INSTALLED_SERVER, "setup"], { encoding: "utf8", timeout: 60_000, env: { ...process.env, AEMCP_NO_UPDATE_CHECK: "1" } });
  let extension = false;
  try {
    extension = !!JSON.parse(setup.stdout).extensionInstalled;
  } catch {}
  // AI app settings that still name the 1.3 paths point at the new place (as `install` does)
  try {
    repointLegacyClients();
  } catch {}
  const running = fileURLToPath(import.meta.url) !== INSTALLED_SERVER;
  return {
    ok: true,
    from: VERSION,
    to: latest,
    updated: true,
    url: rel.html_url,
    restartAfterEffects: extension,
    message:
      `Updated Surehand MCP from v${VERSION} to v${latest}. ` +
      (extension ? "Restart After Effects and your AI apps to finish." : "Restart your AI apps to finish.") +
      (running ? " (If you use the Claude Desktop extension (.mcpb), install the new Surehand-MCP.mcpb from the release page as well.)" : ""),
  };
}

/** `--channel beta|stable` (or `--channel=beta`): the value, "" when the flag has none, undefined when absent. */
export function channelArg(args: string[]): string | undefined {
  const i = args.findIndex((a) => a === "--channel" || a.startsWith("--channel="));
  if (i < 0) return undefined;
  return args[i].includes("=") ? args[i].slice("--channel=".length) : args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : "";
}

export async function updateCommand(args: string[]) {
  const json = args.includes("--json");
  // `--channel beta|stable` saves the channel first, then checks or updates on it
  const ch = channelArg(args);
  if (ch !== undefined) {
    if (ch !== "beta" && ch !== "stable") {
      const message = "usage: surehand-ae update [--check] [--channel beta|stable] [--json]";
      if (json) console.log(JSON.stringify({ ok: false, message }));
      else fail(message);
      process.exitCode = 2;
      return;
    }
    try {
      setUpdateChannel(ch);
    } catch (e: any) {
      if (json) console.log(JSON.stringify({ ok: false, message: `Could not save the update channel: ${e.message}` }));
      else fail(`Could not save the update channel: ${e.message}`);
      process.exitCode = 1;
      return;
    }
    if (!json) ok(ch === "beta" ? "Update channel: beta (pre-releases included)." : "Update channel: stable.");
  }
  if (args.includes("--check")) {
    const c = await checkUpdate();
    if (json) console.log(JSON.stringify(c));
    else if (c.error) fail(c.error);
    else if (c.updateAvailable) warn(`v${c.latest} is available on the ${c.channel} channel (you have v${c.current}): ${c.url}. Install it with: surehand-ae update`);
    else ok(`Surehand MCP is up to date (v${c.current}, ${c.channel} channel).${c.keptBeta ? ` ${c.keptBeta}` : ""}`);
    process.exitCode = c.error ? 1 : 0;
    return;
  }
  const r = await runUpdate();
  if (args.includes("--json")) console.log(JSON.stringify(r));
  else {
    console.log(bold(`\nSurehand MCP update`));
    (r.ok ? ok : fail)(r.message);
    if (!r.ok && r.url) warn(`Release page: ${r.url}`);
  }
  process.exitCode = r.ok ? 0 : 1;
}
