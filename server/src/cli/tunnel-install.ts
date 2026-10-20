// `surehand-ae chatgpt --install-tunnel [--json]`: downloads Cloudflare's cloudflared (the tunnel ChatGPT on the web
// needs) into the shared ~/.surehand/bin. No administrator rights, no Homebrew or winget.
//
// The build is PINNED: Cloudflare's own release on GitHub (github.com/cloudflare/cloudflared), refused unless its
// SHA-256 matches the hash written below (GitHub's asset digest), the same standard as the installers' Node.js and
// Preflight's ffmpeg. It is unpacked and checked (`cloudflared --version` names the pinned version) in a staging
// folder, then renamed into place, so a failure leaves nothing half installed. A marker next to it
// (cloudflared.surehand.json) records that Surehand put it there: uninstall removes cloudflared only then.
// Running it again when the pinned version is already there does nothing.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sharedBinDir } from "../paths.js";
import { download, runTool, unzip } from "../preflight/ffmpeg.js";

export const CLOUDFLARED_VERSION = "2026.9.3";
const BASE = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`;
const MB = 1024 * 1024;

export interface CloudflaredAsset {
  url: string;
  sha256: string;
  maxBytes: number;
  /** the program itself (Windows) or a .tgz holding it (macOS) */
  kind: "exe" | "tgz";
}

const WIN: CloudflaredAsset = {
  url: `${BASE}/cloudflared-windows-amd64.exe`,
  sha256: "f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2",
  maxBytes: 90 * MB,
  kind: "exe",
};

/** Pinned downloads per `${process.platform}-${process.arch}` (Windows on Arm runs the x64 build). */
export const CLOUDFLARED_ASSETS: Record<string, CloudflaredAsset> = {
  "win32-x64": WIN,
  "win32-arm64": WIN,
  "darwin-arm64": {
    url: `${BASE}/cloudflared-darwin-arm64.tgz`,
    sha256: "587c2cfb1c230fe36c7fa7727da78be459dae028cabe8c001291999350f07095",
    maxBytes: 50 * MB,
    kind: "tgz",
  },
  "darwin-x64": {
    url: `${BASE}/cloudflared-darwin-amd64.tgz`,
    sha256: "d1155d0837487f261183b15c1eab6c4ebcad9dc49b94675f1524c3564cea3977",
    maxBytes: 50 * MB,
    kind: "tgz",
  },
};

export const cloudflaredName = (platform = process.platform) => (platform === "win32" ? "cloudflared.exe" : "cloudflared");
export const cloudflaredPath = (dir = sharedBinDir(), platform = process.platform) => join(dir, cloudflaredName(platform));
/** Written next to cloudflared when Surehand installed it: {version, sha256, source}. */
export const cloudflaredMarker = (dir = sharedBinDir()) => join(dir, "cloudflared.surehand.json");

export interface TunnelInstallResult {
  ok: boolean;
  path?: string;
  version?: string;
  /** the pinned version was already there */
  already?: boolean;
  error?: string;
}

export interface TunnelInstallOptions {
  dir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** the download (tests: a local server) */
  asset?: CloudflaredAsset;
  /** run `cloudflared --version` before it goes into place (default true) */
  checkStarts?: boolean;
  /** the version that check expects (default CLOUDFLARED_VERSION) */
  version?: string;
  signal?: AbortSignal;
}

const sha256File = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");

function readMarker(dir: string): { version?: string; sha256?: string } | null {
  try {
    return JSON.parse(readFileSync(cloudflaredMarker(dir), "utf8"));
  } catch {
    return null;
  }
}

/** True when ~/.surehand/bin/cloudflared is there and Surehand put it there (its marker matches the file). */
export function ownsCloudflared(dir = sharedBinDir(), platform = process.platform): boolean {
  const file = cloudflaredPath(dir, platform), m = readMarker(dir);
  if (!m?.sha256 || !existsSync(file)) return false;
  try {
    return sha256File(file) === m.sha256;
  } catch {
    return false;
  }
}

function findFile(root: string, name: string): string | null {
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) {
      const f = findFile(p, name);
      if (f) return f;
    }
  }
  return null;
}

export async function installCloudflared(o: TunnelInstallOptions = {}): Promise<TunnelInstallResult> {
  const platform = o.platform ?? process.platform, arch = o.arch ?? process.arch;
  const dir = o.dir ?? sharedBinDir(), version = o.version ?? CLOUDFLARED_VERSION;
  const asset = o.asset ?? CLOUDFLARED_ASSETS[`${platform}-${arch}`];
  if (!asset) return { ok: false, error: `there is no cloudflared download for ${platform}-${arch}` };
  const file = cloudflaredPath(dir, platform);
  // already there (this version, and the file is the one we put there)
  const m = readMarker(dir);
  if (m?.version === version && ownsCloudflared(dir, platform)) return { ok: true, path: file, version, already: true };

  mkdirSync(dir, { recursive: true });
  // staging folders an interrupted run left (older than an hour: not one in progress)
  for (const n of readdirSync(dir))
    if (n.startsWith(".cloudflared-staging-"))
      try {
        if (Date.now() - statSync(join(dir, n)).mtimeMs > 60 * 60_000) rmSync(join(dir, n), { recursive: true, force: true });
      } catch {}
  const stage = join(dir, `.cloudflared-staging-${randomBytes(6).toString("hex")}`);
  mkdirSync(stage);
  try {
    const got = join(stage, asset.kind === "tgz" ? "cloudflared.tgz" : cloudflaredName(platform));
    await download(asset, got, o.signal);
    let program = got;
    if (asset.kind === "tgz") {
      const out = join(stage, "x");
      mkdirSync(out);
      await unzip(got, out);
      const f = findFile(out, cloudflaredName(platform));
      if (!f) throw new Error(`${cloudflaredName(platform)} is missing from the download`);
      program = f;
    }
    if (platform !== "win32") chmodSync(program, 0o755);
    if (o.checkStarts !== false) {
      let text = "";
      const r = await runTool(program, ["--version"], { timeoutMs: 60_000, onStdout: (b) => (text += b.toString("utf8")) }).catch((e: any) => ({ code: -1, stderrTail: e?.message ?? String(e) }));
      if (r.code !== 0 || !text.includes(version)) throw new Error(`cloudflared did not start correctly (${(text || r.stderrTail || "").trim().slice(0, 160)})`);
    }
    const marker = join(stage, "marker.json");
    writeFileSync(marker, JSON.stringify({ version, sha256: sha256File(program), source: asset.url }, null, 2));
    try {
      renameSync(program, file);
    } catch (e: any) {
      throw new Error(e?.code === "EPERM" || e?.code === "EBUSY" ? `${file} is in use: stop ChatGPT on the web first` : `could not put cloudflared in ${dir}: ${e?.message ?? e}`);
    }
    renameSync(marker, cloudflaredMarker(dir));
    return { ok: true, path: file, version };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** Uninstall: removes ~/.surehand/bin/cloudflared only when Surehand put it there, and the folder when it is empty. */
export function removeOwnCloudflared(dir = sharedBinDir(), platform = process.platform): boolean {
  let removed = false;
  if (ownsCloudflared(dir, platform)) {
    rmSync(cloudflaredPath(dir, platform), { force: true });
    removed = true;
  }
  if (removed || !existsSync(cloudflaredPath(dir, platform))) rmSync(cloudflaredMarker(dir), { force: true });
  try {
    if (!readdirSync(dir).length) rmSync(dir, { recursive: true, force: true });
  } catch {}
  return removed;
}
