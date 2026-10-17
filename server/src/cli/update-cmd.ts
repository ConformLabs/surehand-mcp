// `ae-mcp update`: installs the latest GitHub release over the standalone install
// (~/.aemcp/server/ae-mcp.mjs) and updates the After Effects extension. The AE MCP panel's
// Update button runs this too (with --json).
//
// Each release carries the single-file server (ae-mcp.mjs). It is checked against the
// SHA-256 digest GitHub publishes for the asset (or ae-mcp.mjs.sha256), and must report the
// expected version before it replaces the installed one; the previous file is kept as
// ae-mcp.mjs.previous.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../config.js";
import { checkForUpdate, compareVersions, REPO } from "../update.js";
import { bold, fail, INSTALLED_SERVER, ok, warn } from "./util.js";

export const SERVER_ASSET = "ae-mcp.mjs";

export interface UpdateResult {
  ok: boolean;
  from: string;
  to: string | null;
  updated: boolean;
  message: string;
  url?: string;
  restartAfterEffects?: boolean;
}

interface Release {
  tag_name: string;
  html_url: string;
  assets: { name: string; browser_download_url: string; digest?: string | null }[];
}

async function get(url: string): Promise<Response> {
  const res = await fetch(url, { headers: { "user-agent": `ae-mcp/${VERSION}`, accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

/** The expected SHA-256 (hex) of the server asset: GitHub's own digest, else the .sha256 file. */
async function expectedDigest(rel: Release): Promise<string> {
  const asset = rel.assets.find((a) => a.name === SERVER_ASSET)!;
  const m = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? "");
  if (m) return m[1].toLowerCase();
  const side = rel.assets.find((a) => a.name === `${SERVER_ASSET}.sha256`);
  if (!side) throw new Error("the release has no checksum for ae-mcp.mjs");
  const hex = /[0-9a-f]{64}/i.exec(await (await get(side.browser_download_url)).text())?.[0];
  if (!hex) throw new Error("unreadable ae-mcp.mjs.sha256");
  return hex.toLowerCase();
}

export async function runUpdate(): Promise<UpdateResult> {
  const base = { from: VERSION, to: null, updated: false };
  let rel: Release;
  try {
    // AEMCP_RELEASES_API: for tests only (a local stand-in for the GitHub API)
    const api = process.env.AEMCP_RELEASES_API || `https://api.github.com/repos/${REPO}/releases/latest`;
    rel = (await (await get(api)).json()) as Release;
  } catch (e: any) {
    return { ...base, ok: false, message: `Could not reach GitHub to check for updates (${e.message}).` };
  }
  const latest = rel.tag_name.replace(/^v/, "");
  void checkForUpdate(true); // refresh the cached banner state
  if (compareVersions(latest, VERSION) <= 0) return { ...base, ok: true, to: latest, message: `AE MCP is up to date (v${VERSION}).` };
  if (!rel.assets.some((a) => a.name === SERVER_ASSET))
    return { ...base, ok: false, to: latest, url: rel.html_url, message: `v${latest} can't be installed automatically. Download it from ${rel.html_url}` };

  const tmp = `${INSTALLED_SERVER}.download`;
  try {
    const asset = rel.assets.find((a) => a.name === SERVER_ASSET)!;
    const [body, want] = await Promise.all([get(asset.browser_download_url).then((r) => r.arrayBuffer()), expectedDigest(rel)]);
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

  // the new server installs its own After Effects extension
  const setup = spawnSync(process.execPath, [INSTALLED_SERVER, "setup"], { encoding: "utf8", timeout: 60_000, env: { ...process.env, AEMCP_NO_UPDATE_CHECK: "1" } });
  let extension = false;
  try {
    extension = !!JSON.parse(setup.stdout).extensionInstalled;
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
      `Updated AE MCP from v${VERSION} to v${latest}. ` +
      (extension ? "Restart After Effects and your AI apps to use it." : "Restart your AI apps to use it.") +
      (running ? " (If you use the Claude Desktop extension (.mcpb), install the new AE-MCP.mcpb from the release page as well.)" : ""),
  };
}

export async function updateCommand(args: string[]) {
  const r = await runUpdate();
  if (args.includes("--json")) console.log(JSON.stringify(r));
  else {
    console.log(bold(`\nAE MCP update`));
    (r.ok ? ok : fail)(r.message);
    if (!r.ok && r.url) warn(`Release page: ${r.url}`);
  }
  process.exitCode = r.ok ? 0 : 1;
}
