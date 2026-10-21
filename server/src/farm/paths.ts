// Paths for the farm: is a file on this machine only (home folder, Desktop, a local disk) or on a share other machines
// can see; where After Effects and aerender are installed on macOS and Windows; quoting for .command / .sh and .bat.
import { spawnSync } from "node:child_process";
import { existsSync, openSync, readdirSync, readFileSync, readSync, closeSync, fstatSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";

export type Platform = "mac" | "windows";
export const platformOf = (p: NodeJS.Platform | string = process.platform): Platform => (p === "win32" || p === "windows" ? "windows" : "mac");

const isWinPath = (p: string) => /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p) || /^\/\/[^/]/.test(p);
/** A path in a comparable form: forward slashes, no trailing slash; Windows and macOS paths compare without case. */
export function normPath(p: string): string {
  let s = p.replace(/\\/g, "/");
  if (s.length > 1) s = s.replace(/\/+$/, "");
  return s.normalize("NFC").toLowerCase();
}
export const under = (p: string, root: string) => {
  const a = normPath(p), r = normPath(root);
  return a === r || a.startsWith(r.endsWith("/") ? r : r + "/");
};

export interface Mount {
  /** where it is mounted (macOS) or its drive letter, e.g. "Z:" (Windows) */
  path: string;
  /** what is mounted: //server/share, \\server\share, /dev/disk3s1 */
  source: string;
  network: boolean;
  type?: string;
}

const NET_FS = /^(smbfs|afpfs|nfs|webdav|cifs|smb3?|ftp|9p|fuse\.sshfs|osxfuse|macfuse|davfs)$/i;

/** `mount` on macOS / Linux: "//user@server/share on /Volumes/Projects (smbfs, nodev, ...)" */
export function parseMountOutput(out: string): Mount[] {
  const res: Mount[] = [];
  for (const line of out.split(/\r?\n/)) {
    // Linux: "src on /mnt/x type nfs (rw)"; macOS: "src on /Volumes/x (smbfs, ...)"
    const m = /^(.+?) on (.+?) type (\S+)/.exec(line.trim()) ?? /^(.+?) on (.+?) \(([^,)]+)/.exec(line.trim());
    if (!m) continue;
    const type = m[3].trim();
    res.push({ source: m[1], path: m[2], type, network: NET_FS.test(type) || /^\/\/|^[\w.-]+:\//.test(m[1]) });
  }
  return res;
}

/** `net use` on Windows: "OK           Z:        \\server\share       Microsoft Windows Network" */
export function parseNetUse(out: string): Mount[] {
  const res: Mount[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /\s([A-Za-z]:)\s+(\\\\\S+)/.exec(` ${line}`);
    if (m) res.push({ path: m[1].toUpperCase(), source: m[2], network: true, type: "smb" });
  }
  return res;
}

let mountCache: { at: number; mounts: Mount[] } | null = null;
/** The network shares mounted on this machine (read with `mount` or `net use`; cached for a minute). */
export function readMounts(platform: Platform = platformOf()): Mount[] {
  if (mountCache && Date.now() - mountCache.at < 60_000) return mountCache.mounts;
  let mounts: Mount[] = [];
  try {
    if (platform === "windows") {
      const r = spawnSync("net", ["use"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
      mounts = parseNetUse(r.stdout ?? "");
    } else {
      const r = spawnSync(existsSync("/sbin/mount") ? "/sbin/mount" : "mount", [], { encoding: "utf8", timeout: 10_000 });
      mounts = parseMountOutput(r.stdout ?? "");
    }
  } catch {}
  mountCache = { at: Date.now(), mounts };
  return mounts;
}

export type Where = "shared" | "local" | "external" | "unknown";
export interface PathClass {
  where: Where;
  /** in plain words: why */
  why: string;
}
export interface ClassifyContext {
  platform: Platform;
  home: string;
  /** folders the user says other machines see at the same path */
  shared?: string[];
  mounts?: Mount[];
  /** Windows: the system drive, usually C: */
  systemDrive?: string;
}

/**
 * Whether a footage or output path can be seen from other machines. Shared: a path the user named, a network mount
 * (mount / net use), a UNC path. Local: the home folder (Desktop, Documents...), the system disk, a drive letter that
 * isn't a mapped share. External: another disk attached to this machine (/Volumes/<disk>), which other machines can't
 * see either. Unknown: anything else (said, never guessed).
 */
export function classifyPath(p: string, ctx: ClassifyContext): PathClass {
  for (const s of ctx.shared ?? []) if (under(p, s)) return { where: "shared", why: `inside ${s}, which you said is shared` };
  if (/^\\\\|^\/\/[^/]/.test(p)) return { where: "shared", why: "a network (UNC) path" };
  const mounts = ctx.mounts ?? [];
  const winPath = isWinPath(p);
  if (winPath || ctx.platform === "windows") {
    const drive = /^([a-zA-Z]:)/.exec(p)?.[1]?.toUpperCase();
    if (drive) {
      const m = mounts.find((x) => x.path.toUpperCase() === drive);
      if (m?.network) return { where: "shared", why: `drive ${drive} is the network share ${m.source}` };
      const home = ctx.home && isWinPath(ctx.home) ? ctx.home : "";
      if (home && under(p, home)) return { where: "local", why: `in your user folder (${home})${/[\\/]desktop[\\/]/i.test(p) ? ", on the Desktop" : ""}` };
      const sys = (ctx.systemDrive ?? "C:").toUpperCase();
      if (drive === sys) return { where: "local", why: `on this computer's system drive ${drive}` };
      if (ctx.platform === "windows") return { where: "local", why: `drive ${drive} is a disk of this computer (not a mapped network share)` };
      return { where: "unknown", why: `drive ${drive}: local disk or mapped share can only be told on that Windows machine` };
    }
  }
  // macOS (and other POSIX paths)
  const net = mounts.filter((m) => m.network && m.path !== "/" && under(p, m.path)).sort((a, b) => b.path.length - a.path.length)[0];
  if (net) return { where: "shared", why: `on the network share ${net.source} (mounted at ${net.path})` };
  if (ctx.home && !winPath && under(p, ctx.home)) return { where: "local", why: `in your home folder (${ctx.home})${/\/Desktop\//.test(p) ? ", on the Desktop" : ""}` };
  if (/^\/Users\/[^/]+\//.test(p)) return { where: "local", why: "in a user's home folder" };
  const vol = /^\/Volumes\/([^/]+)/.exec(p);
  if (vol) {
    const m = mounts.find((x) => under(`/Volumes/${vol[1]}`, x.path) && x.path !== "/");
    if (m && !m.network) return { where: "external", why: `on the disk "${vol[1]}" attached to this Mac (${m.type ?? "local file system"})` };
    return { where: "unknown", why: `on the volume "${vol[1]}" (not mounted here now: a disk or a share)` };
  }
  if (/^\/(private|tmp|var|Applications|Library|System|opt|usr|home)\//.test(p)) return { where: "local", why: "on this computer's system disk" };
  return { where: "unknown", why: "not a known local or shared location" };
}

export interface PathMapping { from: string; to: string }
/** A path as another machine sees it: the longest matching prefix replaced (separators follow the target). */
export function mapPath(p: string, map: PathMapping[] = []): string {
  const hit = [...map].sort((a, b) => b.from.length - a.from.length).find((m) => under(p, m.from));
  if (!hit) return p;
  const rest = p.replace(/\\/g, "/").slice(hit.from.replace(/\\/g, "/").replace(/\/+$/, "").length).replace(/^\/+/, "");
  const win = isWinPath(hit.to);
  const sep = win ? "\\" : "/";
  const base = hit.to.replace(/[\\/]+$/, "");
  return rest ? `${base}${sep}${rest.split("/").join(sep)}` : base;
}

// ---------- quoting ----------

/** A word for bash / zsh (.command, .sh): single quotes, ' as '\''. */
export const shQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
/**
 * A word for cmd.exe in a .bat file: double quotes (spaces, & | < > ^ are literal inside them), % doubled (a .bat
 * expands %VAR% even in quotes). A path can't contain " on Windows, so it is refused rather than mangled.
 */
export function batQuote(s: string): string {
  if (s.includes('"')) throw new Error(`A path with a double quote can't be written in a .bat file: ${s}`);
  const t = s.replace(/%/g, "%%");
  return /^[\w@+=:,./\\-]+$/.test(t) ? t : `"${t}"`;
}

// ---------- After Effects and aerender ----------

/** The year in the install folder's name for a major version: 22 -> 2022; 17 -> 2020, 18 -> 2021. */
export function aeYear(major: number): number | null {
  if (major >= 22) return 2000 + major;
  if (major === 18) return 2021;
  if (major === 17) return 2020;
  return null;
}
export const majorOf = (v: string | null | undefined) => (v ? Number(/^(\d+)/.exec(v)?.[1] ?? NaN) : NaN);

/** Where aerender is in a default install of After Effects <major> (the machines' own may differ: they can say). */
export function defaultAerender(platform: Platform, major: number): string | null {
  const y = aeYear(major);
  if (!y) return null;
  return platform === "windows"
    ? win32.join("C:\\Program Files\\Adobe", `Adobe After Effects ${y}`, "Support Files", "aerender.exe")
    : posix.join("/Applications", `Adobe After Effects ${y}`, "aerender");
}

export interface AeInstall {
  /** the folder of the install (macOS: /Applications/Adobe After Effects 2025; Windows: ...\Support Files) */
  folder: string;
  version: string | null;
  aerender: string | null;
  /** where the version was read */
  versionFrom?: string;
}

/** The version in an app's Info.plist (CFBundleShortVersionString, with CFBundleVersion when it is longer). */
export function plistVersion(text: string): string | null {
  const get = (k: string) => new RegExp(`<key>${k}</key>\\s*<string>([^<]+)</string>`).exec(text)?.[1]?.trim() ?? null;
  const short = get("CFBundleShortVersionString"), long = get("CFBundleVersion");
  if (long && short && long.startsWith(short.split(" ")[0])) return long;
  return short ?? long;
}

/** The ProductVersion (or FileVersion) string in a Windows executable's version resource (UTF-16). */
export function exeVersion(path: string, maxBytes = 96 * 1024 * 1024): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = Math.min(fstatSync(fd).size, maxBytes);
    const keys = ["ProductVersion", "FileVersion"].map((k) => Buffer.from(`${k}\u0000`, "utf16le"));
    const chunk = Buffer.alloc(4 * 1024 * 1024);
    let carry = Buffer.alloc(0);
    for (let pos = 0; pos < size; pos += chunk.length) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, size - pos), pos);
      const buf = Buffer.concat([carry, chunk.subarray(0, n)]);
      for (const key of keys) {
        let at = buf.indexOf(key);
        while (at >= 0) {
          // the value follows, padded to 32 bits, as UTF-16 up to a NUL
          let v = at + key.length;
          while (v < buf.length - 1 && buf.readUInt16LE(v) === 0) v += 2;
          let s = "";
          for (; v < buf.length - 1; v += 2) {
            const c = buf.readUInt16LE(v);
            if (!c) break;
            s += String.fromCharCode(c);
          }
          if (/^\d+[.,]\d+/.test(s.trim())) return s.trim().replace(/,\s*/g, ".");
          at = buf.indexOf(key, at + 2);
        }
      }
      carry = buf.subarray(Math.max(0, buf.length - 256));
    }
  } catch {
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return null;
}

/**
 * aerender next to an After Effects application (Folder.appPackage): next to the .app on macOS, in Support Files on
 * Windows.
 */
export function aerenderNextTo(appPackage: string, platform: Platform = platformOf()): string | null {
  const candidates =
    platform === "windows"
      ? [win32.join(appPackage, "aerender.exe"), win32.join(appPackage, "..", "aerender.exe"), win32.join(appPackage, "Support Files", "aerender.exe")]
      : [posix.join(appPackage, "..", "aerender"), posix.join(appPackage, "aerender")];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** The After Effects installs on this machine, read from disk (no After Effects needed). */
export function findAeInstalls(platform: Platform = platformOf(), roots?: string[]): AeInstall[] {
  const out: AeInstall[] = [];
  const base = roots ?? (platform === "windows" ? [join(process.env.ProgramFiles ?? "C:\\Program Files", "Adobe")] : ["/Applications"]);
  for (const root of base) {
    let names: string[] = [];
    try {
      names = readdirSync(root).filter((n) => /^Adobe After Effects/i.test(n));
    } catch {
      continue;
    }
    for (const n of names) out.push(readAeInstall(join(root, n), platform));
  }
  return out.filter((x) => x.version || x.aerender).sort((a, b) => cmpVersion(b.version, a.version));
}

/** One install, from its folder (macOS: the folder with the .app; Windows: the folder with Support Files, or Support Files). */
export function readAeInstall(folder: string, platform: Platform = platformOf()): AeInstall {
  if (platform === "windows") {
    const support = /support files$/i.test(folder) ? folder : join(folder, "Support Files");
    const exe = join(support, "AfterFX.exe");
    const aer = join(support, "aerender.exe");
    const version = existsSync(exe) ? exeVersion(exe) : null;
    return { folder: support, version, aerender: existsSync(aer) ? aer : null, versionFrom: version ? exe : undefined };
  }
  let dir = folder, app: string | undefined;
  if (/\.app$/i.test(folder)) {
    app = folder;
    dir = join(folder, "..");
  } else {
    try {
      app = readdirSync(folder).filter((n) => /^Adobe After Effects.*\.app$/i.test(n)).map((n) => join(folder, n))[0];
    } catch {}
  }
  let version: string | null = null, from: string | undefined;
  if (app) {
    const plist = join(app, "Contents", "Info.plist");
    try {
      version = plistVersion(readFileSync(plist, "utf8"));
      if (version) from = plist;
    } catch {}
  }
  const aer = join(dir, "aerender");
  return { folder: dir, version, aerender: existsSync(aer) ? aer : null, versionFrom: from };
}

/**
 * An After Effects version in the forms it comes in: app.version "26.5x89" (x = build), Info.plist "26.5" or
 * "25.2.0.110", AfterFX.exe "26.5.0.89". Major, minor and patch (missing parts are 0), and the build where it says.
 */
export function aeVersionParts(v: string | null | undefined): { main: [number, number, number]; build: number | null } | null {
  const m = /^\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:x(\d+))?/i.exec(v ?? "");
  if (!m) return null;
  const build = m[5] ?? m[4];
  return { main: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)], build: build !== undefined ? Number(build) : null };
}
/** "same" (also when only one side says its build), "build" (same version, other build), "version" (another version). */
export function compareAeVersions(a: string | null | undefined, b: string | null | undefined): "same" | "build" | "version" {
  const x = aeVersionParts(a), y = aeVersionParts(b);
  if (!x || !y) return cmpVersion(a, b) === 0 ? "same" : "version";
  if (x.main.some((n, i) => n !== y.main[i])) return "version";
  return x.build !== null && y.build !== null && x.build !== y.build ? "build" : "same";
}

export function cmpVersion(a: string | null | undefined, b: string | null | undefined): number {
  const pa = (a ?? "").split(/[^\d]+/).filter(Boolean).map(Number), pb = (b ?? "").split(/[^\d]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? -1) - (pb[i] ?? -1);
    if (d) return d;
  }
  return 0;
}

export const defaultHome = () => homedir();
