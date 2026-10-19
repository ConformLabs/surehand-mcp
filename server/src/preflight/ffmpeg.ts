// Preflight: finding (and, only when the user agreed, downloading) ffmpeg / ffprobe.
//
// Search order: the config override (~/.aemcp/config.json "ffmpegPath" / "ffprobePath"), the private copy in
// ~/.aemcp/ffmpeg, then PATH (plus /opt/homebrew/bin and /usr/local/bin on a Mac, which apps started from the
// Dock don't have on their PATH).
//
// The one-time download (ensureFfmpeg({allowDownload: true})) fetches a PINNED build over HTTPS and refuses it
// unless its SHA-256 matches the hash written below, then checks that it starts and reports the expected
// version before it is moved into ~/.aemcp/ffmpeg. The same standard as the Node.js download in the installer
// and the server's own update.
//
// Builds (all FFmpeg 9.0.2; we only download them from their publishers, we don't redistribute them):
// - macOS arm64 / x64: Martin Riedl's static builds (https://ffmpeg.martin-riedl.de), release 9.0.2. GPL v3
//   build (it includes x264/x265); SHA-256 published next to each zip. Separate ffmpeg.zip / ffprobe.zip.
// - Windows x64 (and arm64, which runs x64 programs): BtbN/FFmpeg-Builds on GitHub, release
//   autobuild-2026-09-30-13-08 (month-end builds are kept), n9.0.2 win64 LGPL shared build. LGPL v2.1+;
//   SHA-256 in the release's checksums.sha256 and in GitHub's asset digest.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { loadConfig, VERSION } from "../config.js";

export interface FfmpegPaths {
  ffmpeg: string;
  ffprobe: string;
  /** where they were found */
  source: "config" | "private" | "path";
}

export interface FfmpegArchive {
  url: string;
  sha256: string;
  /** refuse anything bigger (bytes) */
  maxBytes: number;
  /** which programs this archive holds */
  programs: ("ffmpeg" | "ffprobe")[];
}

export interface FfmpegBuild {
  version: string;
  publisher: string;
  licence: string;
  archives: FfmpegArchive[];
}

const MB = 1024 * 1024;
const MARTIN_RIEDL = "https://ffmpeg.martin-riedl.de/download/macos";
const BTBN = "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08";
const WIN_X64: FfmpegBuild = {
  version: "9.0.2",
  publisher: "BtbN/FFmpeg-Builds (github.com/BtbN/FFmpeg-Builds), win64 LGPL shared build",
  licence: "LGPL v2.1 or later",
  archives: [
    {
      url: `${BTBN}/ffmpeg-n9.0.2-17-g2a571b6068-win64-lgpl-shared-9.0.zip`,
      sha256: "7157177b8a6cb2174c1650ba8c71b363f2c78cba5330f88c4c02cf5b2b880646",
      maxBytes: 120 * MB,
      programs: ["ffmpeg", "ffprobe"],
    },
  ],
};

/** Pinned builds per `${process.platform}-${process.arch}`. */
export const FFMPEG_BUILDS: Record<string, FfmpegBuild> = {
  "darwin-arm64": {
    version: "9.0.2",
    publisher: "Martin Riedl's static builds (ffmpeg.martin-riedl.de)",
    licence: "GPL v3 (static build including GPL components)",
    archives: [
      { url: `${MARTIN_RIEDL}/arm64/1789931890_9.0.2/ffmpeg.zip`, sha256: "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924", maxBytes: 60 * MB, programs: ["ffmpeg"] },
      { url: `${MARTIN_RIEDL}/arm64/1789931890_9.0.2/ffprobe.zip`, sha256: "fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6", maxBytes: 60 * MB, programs: ["ffprobe"] },
    ],
  },
  "darwin-x64": {
    version: "9.0.2",
    publisher: "Martin Riedl's static builds (ffmpeg.martin-riedl.de)",
    licence: "GPL v3 (static build including GPL components)",
    archives: [
      { url: `${MARTIN_RIEDL}/amd64/1789931006_9.0.2/ffmpeg.zip`, sha256: "7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4", maxBytes: 70 * MB, programs: ["ffmpeg"] },
      { url: `${MARTIN_RIEDL}/amd64/1789931006_9.0.2/ffprobe.zip`, sha256: "2322438ed2f6319a691291b247d09c69dcaa3a982460d1f269a7e1af335cfdfd", maxBytes: 70 * MB, programs: ["ffprobe"] },
    ],
  },
  "win32-x64": WIN_X64,
  "win32-arm64": WIN_X64,
};

export function ffmpegDir(): string {
  return join(homedir(), ".aemcp", "ffmpeg");
}

const exe = (name: string, platform = process.platform) => (platform === "win32" ? `${name}.exe` : name);

function isFile(p: string | undefined): p is string {
  if (!p) return false;
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export interface FindOptions {
  /** the config override (default: ~/.aemcp/config.json) */
  config?: { ffmpegPath?: string; ffprobePath?: string };
  /** the private download folder (default ~/.aemcp/ffmpeg) */
  dir?: string;
  /** PATH to search (default process.env.PATH) */
  pathEnv?: string;
  platform?: NodeJS.Platform;
  /** don't use the private copy (it was found not to start) */
  skipPrivate?: boolean;
}

/** Where ffmpeg / ffprobe are, plus notes on what was looked at (for the "not found" message). */
export function locateFfmpeg(o: FindOptions = {}): { found: FfmpegPaths | null; notes: string[] } {
  const platform = o.platform ?? process.platform;
  const cfg = o.config ?? loadConfig();
  const notes: string[] = [];
  if (cfg.ffmpegPath || cfg.ffprobePath) {
    const ff = cfg.ffmpegPath;
    const fp = cfg.ffprobePath ?? (ff ? join(dirname(ff), exe("ffprobe", platform)) : undefined);
    if (isFile(ff) && isFile(fp)) return { found: { ffmpeg: ff, ffprobe: fp, source: "config" }, notes };
    notes.push(
      `~/.aemcp/config.json sets ${[cfg.ffmpegPath && `ffmpegPath "${cfg.ffmpegPath}"`, cfg.ffprobePath && `ffprobePath "${cfg.ffprobePath}"`].filter(Boolean).join(" and ")}, ` +
        `but ${!isFile(ff) ? "ffmpeg" : "ffprobe"} is not there${!ff ? " (set ffmpegPath too)" : ""}.`,
    );
  }
  const dir = o.dir ?? ffmpegDir();
  const pff = join(dir, exe("ffmpeg", platform)), pfp = join(dir, exe("ffprobe", platform));
  if (!o.skipPrivate && isFile(pff) && isFile(pfp)) return { found: { ffmpeg: pff, ffprobe: pfp, source: "private" }, notes };

  const dirs = (o.pathEnv ?? process.env.PATH ?? "").split(platform === "win32" ? ";" : delimiter).filter(Boolean);
  if (platform === "darwin") dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  for (const d of dirs) {
    const ff = join(d.replace(/^"(.*)"$/, "$1"), exe("ffmpeg", platform));
    const fp = join(dirname(ff), exe("ffprobe", platform));
    if (isFile(ff) && isFile(fp)) return { found: { ffmpeg: ff, ffprobe: fp, source: "path" }, notes };
  }
  return { found: null, notes };
}

export function findFfmpeg(o: FindOptions = {}): FfmpegPaths | null {
  return locateFfmpeg(o).found;
}

export function ffmpegNotFoundMessage(notes: string[] = locateFfmpeg().notes, key = `${process.platform}-${process.arch}`): string {
  const build = FFMPEG_BUILDS[key];
  return [
    "ffmpeg / ffprobe were not found, so the rendered file can't be checked.",
    ...notes,
    build
      ? `Surehand MCP can download FFmpeg ${build.version} once into ~/.aemcp/ffmpeg (${build.publisher}, ${build.licence}; checked against a pinned SHA-256) if you allow it, `
      : "",
    `or install FFmpeg yourself (Mac: \`brew install ffmpeg\`; Windows: \`winget install ffmpeg\`) or set "ffmpegPath" (and "ffprobePath") in ~/.aemcp/config.json.`,
  ]
    .filter(Boolean)
    .join(" ");
}

export class FfmpegMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FfmpegMissingError";
  }
}

let installing: Promise<FfmpegPaths> | null = null;
/** private copies that were seen to start (checked once per process) */
const startsOk = new Set<string>();

function abortError(message = "The file check was cancelled."): Error {
  const e = new Error(message);
  e.name = "AbortError";
  return e;
}

/** A signal that aborts when any of `signals` does (AbortSignal.any where Node has it; Node 18 doesn't). */
export function anySignal(signals: (AbortSignal | undefined)[]): AbortSignal {
  const list = signals.filter((s): s is AbortSignal => !!s);
  if (list.length === 1) return list[0];
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof any === "function") return any.call(AbortSignal, list);
  const ac = new AbortController();
  for (const s of list) {
    if (s.aborted) {
      ac.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => ac.abort(s.reason), { once: true });
  }
  return ac.signal;
}

/** Waits for `p`, or rejects with an AbortError when `signal` aborts first (`p` itself goes on). */
function waitFor<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** Does the program start (`-version` exits 0)? A Windows build with missing DLLs doesn't. */
async function starts(bin: string): Promise<boolean> {
  try {
    const r = await runTool(bin, ["-version"], { timeoutMs: 30_000 });
    return r.code === 0;
  } catch {
    return false;
  }
}

export interface EnsureOptions {
  allowDownload?: boolean;
  /** cancels this caller's wait (a download already started for another caller goes on) */
  signal?: AbortSignal;
  /** asked right before a download starts (e.g. the approval in After Effects in "ask" mode); throw to refuse */
  confirmDownload?: (build: FfmpegBuild) => Promise<void>;
  /** where to look (tests); its `dir` is also where the download goes */
  find?: FindOptions;
}

/** ffmpeg / ffprobe paths; downloads the pinned build first when they're missing and `allowDownload` is true. */
export async function ensureFfmpeg(o: EnsureOptions = {}): Promise<FfmpegPaths> {
  let { found, notes } = locateFfmpeg(o.find);
  if (found?.source === "private" && !startsOk.has(found.ffmpeg)) {
    // a private copy that doesn't start (damaged, or a Windows build missing its DLLs) counts as not installed
    if ((await starts(found.ffmpeg)) && (await starts(found.ffprobe))) startsOk.add(found.ffmpeg);
    else {
      const again = locateFfmpeg({ ...o.find, skipPrivate: true });
      found = again.found;
      notes = [...again.notes, "The copy in ~/.aemcp/ffmpeg doesn't start (damaged, or files missing next to it), so it was ignored; downloading it again replaces it."];
    }
  }
  if (found) return found;
  const key = `${process.platform}-${process.arch}`;
  const build = FFMPEG_BUILDS[key];
  if (!o.allowDownload || !build) {
    throw new FfmpegMissingError(
      build ? ffmpegNotFoundMessage(notes, key) : `${ffmpegNotFoundMessage(notes, key)} (No download is available for ${key}.)`,
    );
  }
  // one confirmation and one download for every caller; not tied to this caller's signal (another call may be
  // waiting for the same download, which has its own timeout)
  installing ??= (async () => {
    await o.confirmDownload?.(build);
    return installFfmpeg(build, o.find?.dir ?? ffmpegDir());
  })().finally(() => (installing = null));
  const paths = await waitFor(installing, o.signal);
  startsOk.add(paths.ffmpeg);
  return paths;
}

const isLocalHttp = (u: string) => /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u);
const allowedUrl = (u: string, local: boolean) => /^https:\/\//.test(u) || (local && isLocalHttp(u));

/** Fetches `url`, following redirects by hand so that none of them leaves HTTPS (plain HTTP only between local test URLs). */
async function fetchHttps(url: string, signal: AbortSignal): Promise<Response> {
  const local = isLocalHttp(url);
  let u = url;
  for (let hop = 0; hop < 8; hop++) {
    if (!allowedUrl(u, local)) throw new Error(`refusing a non-HTTPS download: ${u}`);
    const res = await fetch(u, { headers: { "user-agent": `ae-mcp/${VERSION}` }, redirect: "manual", signal });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.body?.cancel().catch(() => {});
      u = new URL(loc, u).toString();
      continue;
    }
    // the URL the response really came from (a runtime that followed a redirect anyway)
    if (res.url && !allowedUrl(res.url, local)) throw new Error(`refusing a download that ended on a non-HTTPS address: ${res.url}`);
    return res;
  }
  throw new Error(`too many redirects for ${url}`);
}

/** Downloads `url` to `dest` while hashing it; refuses a wrong hash or an oversized file. */
async function download(a: FfmpegArchive, dest: string, signal?: AbortSignal): Promise<void> {
  if (!allowedUrl(a.url, isLocalHttp(a.url))) throw new Error(`refusing a non-HTTPS download: ${a.url}`);
  // the caller's signal and a timeout, both
  const res = await fetchHttps(a.url, anySignal([signal, AbortSignal.timeout(15 * 60_000)]));
  if (!res.ok || !res.body) throw new Error(`${a.url}: HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > a.maxBytes) throw new Error(`${basename(a.url)} is larger than expected (${declared} bytes)`);
  const hash = createHash("sha256");
  const out = createWriteStream(dest);
  let writeError: Error | null = null;
  out.on("error", (e) => (writeError = e));
  let total = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > a.maxBytes) throw new Error(`${basename(a.url)} is larger than expected`);
      if (writeError) throw writeError;
      hash.update(chunk);
      if (!out.write(chunk))
        await new Promise<void>((r, j) => {
          out.once("drain", () => r());
          out.once("error", j);
        });
    }
  } finally {
    await new Promise<void>((r) => (out.writableFinished || out.destroyed ? r() : out.end(() => r())));
  }
  if (writeError) throw writeError;
  const got = hash.digest("hex");
  if (got !== a.sha256.toLowerCase()) throw new Error(`checksum mismatch for ${basename(a.url)} (expected ${a.sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…)`);
}

/** Unzips with the system tar (bsdtar: macOS, Windows 10+), else PowerShell's Expand-Archive. Async: the server keeps answering. */
async function unzip(zip: string, into: string): Promise<void> {
  const tar = process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "/usr/bin/tar";
  let why = "";
  try {
    const r = await runTool(existsSync(tar) ? tar : "tar", ["-xf", zip, "-C", into], { timeoutMs: 5 * 60_000 });
    if (r.code === 0) return;
    why = r.stderrTail;
  } catch (e: any) {
    why = e?.message ?? String(e);
  }
  if (process.platform === "win32") {
    const ps = await runTool("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force", zip, into], { timeoutMs: 5 * 60_000 }).catch(() => null);
    if (ps?.code === 0) return;
  }
  throw new Error(`could not unpack ${basename(zip)}: ${why.trim().slice(0, 200)}`);
}

function findFile(root: string, name: string): string | null {
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return p;
    if (e.isDirectory()) {
      const f = findFile(p, name);
      if (f) return f;
    }
  }
  return null;
}

/** Removes staging folders left by an install that was interrupted (older than an hour: not one in progress). */
function sweepStaging(dir: string) {
  try {
    for (const n of readdirSync(dir))
      if (n.startsWith(".staging-"))
        try {
          if (Date.now() - statSync(join(dir, n)).mtimeMs > 60 * 60_000) rmSync(join(dir, n), { recursive: true, force: true });
        } catch {}
  } catch {}
}

/**
 * Downloads and verifies `build` into `dir`. Everything happens in a staging folder; `dir` only gets the files
 * once every archive matched its hash and ffmpeg / ffprobe start and report the pinned version. Then everything
 * (programs, Windows DLLs, licence, SOURCE.json) moves in together, programs last; if a move fails, what was moved
 * is removed again, so a failure leaves nothing installed.
 */
export async function installFfmpeg(build: FfmpegBuild, dir: string, o: { signal?: AbortSignal; platform?: NodeJS.Platform } = {}): Promise<FfmpegPaths> {
  const platform = o.platform ?? process.platform;
  mkdirSync(dir, { recursive: true });
  sweepStaging(dir);
  const stage = join(dir, `.staging-${randomBytes(6).toString("hex")}`);
  mkdirSync(stage, { recursive: true });
  const moved: string[] = [];
  try {
    const staged: Partial<Record<"ffmpeg" | "ffprobe", string>> = {};
    const extra: string[] = [];
    for (const [i, a] of build.archives.entries()) {
      const zip = join(stage, `archive-${i}.zip`);
      await download(a, zip, o.signal);
      const out = join(stage, `x${i}`);
      mkdirSync(out);
      await unzip(zip, out);
      for (const p of a.programs) {
        const f = findFile(out, exe(p, platform));
        if (!f) throw new Error(`${exe(p, platform)} is missing from ${basename(a.url)}`);
        staged[p] = f;
        // Windows shared builds: the DLLs next to the programs are needed too
        if (platform === "win32") for (const n of readdirSync(dirname(f))) if (/\.dll$/i.test(n) && !extra.includes(join(dirname(f), n))) extra.push(join(dirname(f), n));
      }
      const lic = findFile(out, "LICENSE.txt");
      if (lic) extra.push(lic);
    }
    if (!staged.ffmpeg || !staged.ffprobe) throw new Error("the archives don't contain both ffmpeg and ffprobe");
    for (const p of [staged.ffmpeg, staged.ffprobe]) {
      if (platform !== "win32") chmodSync(p, 0o755);
      let first = "", code: number | null = null, err = "";
      try {
        let outText = "";
        const v = await runTool(p, ["-version"], { timeoutMs: 60_000, onStdout: (b) => (outText += b.toString("utf8")) });
        code = v.code;
        first = outText.split("\n")[0];
        err = v.stderrTail;
      } catch (e: any) {
        err = e?.message ?? String(e);
      }
      if (code !== 0 || !first.includes(build.version)) throw new Error(`${basename(p)} did not start correctly (${(first || err).trim().slice(0, 160)})`);
    }
    // everything that goes into `dir`, together in one folder (same volume: the moves are renames)
    const final = join(stage, "final");
    mkdirSync(final);
    const others: string[] = [];
    for (const f of extra) {
      const to = join(final, basename(f));
      if (!existsSync(to)) {
        copyFileSync(f, to);
        others.push(to);
      }
    }
    const sourceJson = join(final, "SOURCE.json");
    writeFileSync(
      sourceJson,
      JSON.stringify({ version: build.version, publisher: build.publisher, licence: build.licence, archives: build.archives.map((a) => ({ url: a.url, sha256: a.sha256 })), installedAt: new Date().toISOString() }, null, 2),
    );
    others.push(sourceJson);
    const programs = [staged.ffprobe, staged.ffmpeg].map((f) => {
      const to = join(final, basename(f));
      renameSync(f, to);
      return to;
    });
    const paths: FfmpegPaths = { ffmpeg: join(dir, exe("ffmpeg", platform)), ffprobe: join(dir, exe("ffprobe", platform)), source: "private" };
    // programs last, so a half-finished install is never picked up
    for (const f of [...others, ...programs]) {
      const to = join(dir, basename(f));
      renameSync(f, to);
      moved.push(to);
    }
    return paths;
  } catch (e: any) {
    for (const f of moved)
      try {
        unlinkSync(f);
      } catch {}
    throw new Error(`Downloading FFmpeg ${build.version} failed: ${e?.message ?? e}. Nothing was installed.`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export interface RunResult {
  code: number | null;
  stderrTail: string;
  aborted: boolean;
  /** killed after `timeoutMs` */
  timedOut?: boolean;
}

/**
 * Runs a program, handing stderr to `onStderrLine` line by line and stdout chunks to `onStdout` (so long files
 * never sit in memory). The process is killed when `signal` aborts, or after `timeoutMs`.
 */
export function runTool(
  bin: string,
  args: string[],
  o: { signal?: AbortSignal; onStderrLine?: (line: string) => void; onStdout?: (chunk: Buffer) => void; cwd?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) return resolve({ code: null, stderrTail: "", aborted: true });
    const child = spawn(bin, args, { cwd: o.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let aborted = false, timedOut = false;
    const onAbort = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = o.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, o.timeoutMs)
      : null;
    const done = () => {
      if (timer) clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
    };
    let tail = "";
    let partial = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (s: string) => {
      tail = (tail + s).slice(-4000);
      if (!o.onStderrLine) return;
      partial += s;
      const lines = partial.split(/\r?\n|\r/);
      partial = lines.pop() ?? "";
      for (const l of lines) o.onStderrLine(l);
    });
    child.stdout.on("data", (b: Buffer) => o.onStdout?.(b));
    child.on("error", (e) => {
      done();
      reject(e);
    });
    child.on("close", (code) => {
      done();
      if (partial && o.onStderrLine) o.onStderrLine(partial);
      resolve({ code, stderrTail: tail, aborted, ...(timedOut ? { timedOut } : {}) });
    });
  });
}
