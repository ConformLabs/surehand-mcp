// Careful file writes for files other programs (or other processes of ours) read at any moment:
// settings of AI apps, our config.json. A write goes to a temporary file next to the target and is
// renamed over it, so a reader sees the old file or the new one, never half of one.
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Writes `data` to `file` atomically: temp file in the same folder, then rename. Keeps the existing
 * file's permissions (or uses `mode` for a new file). A symbolic link is followed (its target is
 * replaced, the link stays).
 */
export function writeFileAtomic(file: string, data: string | Buffer, opts: { mode?: number } = {}) {
  let target = file;
  try {
    target = realpathSync(file);
  } catch {}
  mkdirSync(dirname(target), { recursive: true });
  let mode = opts.mode;
  try {
    mode = statSync(target).mode & 0o777;
  } catch {}
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.tmp`);
  const fd = openSync(tmp, "w", mode ?? 0o644);
  try {
    writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    try {
      fsyncSync(fd);
    } catch {}
  } finally {
    closeSync(fd);
  }
  try {
    if (mode !== undefined && process.platform !== "win32") chmodSync(tmp, mode);
  } catch {}
  let lastErr: any;
  // Windows: a reader holding the file open can make the rename fail for a moment
  for (let i = 0; i < 5; i++) {
    try {
      renameSync(tmp, target);
      return;
    } catch (e: any) {
      lastErr = e;
      if (process.platform !== "win32" || !/EPERM|EBUSY|EACCES/.test(e.code || "")) break;
      sleepSync(50);
    }
  }
  try {
    unlinkSync(tmp);
  } catch {}
  throw lastErr;
}

/** Sleeps without returning to the event loop (for short waits in synchronous code). */
export function sleepSync(ms: number) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {}
  }
}

/** A BOM at the start (Windows editors write one) is not part of the JSON. */
export const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/**
 * JSON with comments and trailing commas (JSONC, as VS Code-style editors such as Cursor accept) to
 * plain JSON. Strings are left alone (a "//" inside a URL stays).
 */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  // trailing commas before } or ] (outside strings: strings were copied verbatim, so re-scan carefully)
  let res = "";
  for (let k = 0; k < out.length; k++) {
    const c = out[k];
    if (c === '"') {
      let j = k + 1;
      while (j < out.length && out[j] !== '"') j += out[j] === "\\" ? 2 : 1;
      res += out.slice(k, j + 1);
      k = j;
      continue;
    }
    if (c === ",") {
      let j = k + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (out[j] === "}" || out[j] === "]") continue;
    }
    res += c;
  }
  return res;
}

export type JsonRead<T> = { ok: true; data: T; text: string } | { ok: false; missing: true } | { ok: false; missing?: false; error: string };

/**
 * Reads a JSON settings file, telling "missing" apart from "there but unreadable" (half-written,
 * hand-edited with a mistake...). `jsonc`: also accept comments and trailing commas.
 */
export function readJsonFile<T = any>(file: string, opts: { jsonc?: boolean } = {}): JsonRead<T> {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e: any) {
    if (e.code === "ENOENT") return { ok: false, missing: true };
    return { ok: false, error: `can't read it (${e.code || e.message})` };
  }
  const text = stripBom(raw);
  if (!text.trim()) return { ok: false, error: "it is empty (perhaps being written right now)" };
  try {
    return { ok: true, data: JSON.parse(text), text: raw };
  } catch (e: any) {
    if (opts.jsonc) {
      try {
        return { ok: true, data: JSON.parse(stripJsonc(text)), text: raw };
      } catch {}
    }
    return { ok: false, error: `it isn't valid JSON (${String(e.message).split("\n")[0]})` };
  }
}

export const BACKUPS_KEPT = 3;

/** Our timestamped backups of a file named `name`: <name>.surehand-20261020-101500-123.bak (-2, -3... in the same ms). */
const ownBackup = (name: string) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.surehand-\\d{8}-\\d{6}-\\d{3}(-\\d+)?\\.bak$`);

/**
 * A copy of `file` before we change it: <file>.surehand-<time>.bak, keeping the newest three (only
 * these are ever removed: any other .bak stays). The very first original also stays as
 * <file>.surehand.bak (1.3 wrote <file>.aemcp.bak; then that one is the original). Returns the
 * backup's path (null if the file doesn't exist).
 */
export function backupFile(file: string, now = new Date()): string | null {
  if (!existsSync(file)) return null;
  if (!existsSync(file + ".aemcp.bak") && !existsSync(file + ".surehand.bak")) copyFileSync(file, file + ".surehand.bak");
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\..*$/, "") + "-" + String(now.getMilliseconds()).padStart(3, "0");
  let to = `${file}.surehand-${stamp}.bak`;
  for (let i = 2; existsSync(to); i++) to = `${file}.surehand-${stamp}-${i}.bak`;
  copyFileSync(file, to);
  const dir = dirname(file), ours = ownBackup(basename(file));
  try {
    const all = readdirSync(dir)
      .filter((n) => ours.test(n))
      .sort();
    for (const n of all.slice(0, Math.max(0, all.length - BACKUPS_KEPT))) unlinkSync(join(dir, n));
  } catch {}
  return to;
}

/** Refused: the file is there but can't be parsed, so writing would lose what is in it. */
export class UnreadableFileError extends Error {
  constructor(readonly file: string, readonly reason: string) {
    super(`${file} could not be read: ${reason}. It was left unchanged; fix or remove it, then try again.`);
  }
}

/**
 * Read-modify-write of a JSON settings file that another app also writes:
 * - an unreadable file is never replaced (UnreadableFileError);
 * - `change` edits the parsed data in place and returns false when nothing needs changing;
 * - the file is read again right before writing; if it changed meanwhile, the change is redone on
 *   the newer content;
 * - a timestamped backup is made before every write, and the write is atomic.
 * `missing`: the data to start from when the file doesn't exist (undefined: nothing to do).
 */
export function updateJsonFile<T = any>(file: string, change: (data: T) => boolean, opts: { jsonc?: boolean; missing?: () => T } = {}): boolean {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = readJsonFile<T>(file, opts);
    let data: T;
    let before: string | null;
    if (r.ok) {
      data = r.data;
      before = r.text;
    } else if (r.missing) {
      if (!opts.missing) return false;
      data = opts.missing();
      before = null;
    } else throw new UnreadableFileError(file, r.error);
    if (!change(data)) return false;
    // has another program written it since we read it?
    let now: string | null = null;
    try {
      now = readFileSync(file, "utf8");
    } catch {}
    if (now !== before) continue;
    backupFile(file);
    writeFileAtomic(file, JSON.stringify(data, null, 2) + "\n");
    return true;
  }
  throw new Error(`${file} kept changing while it was being updated; try again`);
}
