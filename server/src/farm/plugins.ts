// Third-party plug-ins on a machine, without After Effects: an effect's match name is stored in its plug-in's PiPL
// resource as plain text (in the .plugin bundle on macOS, in the .aex on Windows), so the Plug-ins folders are searched
// for those bytes. Adobe's own effects are part of After Effects and are not searched.
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Platform } from "./paths.js";

/** The folders After Effects loads plug-ins from: its own Plug-ins folder and Adobe's shared MediaCore folder. */
export function pluginFolders(platform: Platform, aeFolder: string | null, env: Record<string, string | undefined> = process.env): string[] {
  const out: string[] = [];
  if (aeFolder) out.push(join(aeFolder, "Plug-ins"));
  if (platform === "windows") out.push(join(env.CommonProgramFiles ?? "C:\\Program Files\\Common Files", "Adobe", "Plug-ins", "7.0", "MediaCore"), join(env.ProgramFiles ?? "C:\\Program Files", "Adobe", "Common", "Plug-ins", "7.0", "MediaCore"));
  else out.push("/Library/Application Support/Adobe/Common/Plug-ins/7.0/MediaCore");
  return out;
}

export interface PluginSearch {
  /** match name -> the file it was found in (null: not found) */
  found: Map<string, string | null>;
  files: number;
  bytes: number;
  /** files left out (too big) or the search stopped (time) */
  skipped: string[];
  folders: string[];
  stopped?: string;
}

const SKIP_EXT = /\.(png|jpe?g|gif|tiff?|pdf|html?|txt|md|rtf|plist|strings|nib|car|icns|xml|json|lproj|mov|mp4|wav|aiff?|ttf|otf|lic|log|zip|ffx|aep|aet|mogrt)$/i;

/** Search every file under the folders for each match name's bytes (ASCII). */
export function findMatchNames(folders: string[], names: string[], o: { maxFileBytes?: number; budgetMs?: number } = {}): PluginSearch {
  const found = new Map<string, string | null>(names.map((n) => [n, null]));
  const res: PluginSearch = { found, files: 0, bytes: 0, skipped: [], folders };
  if (!names.length) return res;
  const maxFile = o.maxFileBytes ?? 512 * 1024 * 1024, deadline = Date.now() + (o.budgetMs ?? 120_000);
  const needles = names.map((n) => ({ n, b: Buffer.from(n, "latin1") }));
  const overlap = Math.max(...needles.map((x) => x.b.length));
  const chunk = Buffer.alloc(8 * 1024 * 1024);
  const scan = (p: string, size: number) => {
    let fd: number | undefined;
    try {
      fd = openSync(p, "r");
      let carry = Buffer.alloc(0);
      for (let pos = 0; pos < size; ) {
        const n = readSync(fd, chunk, 0, chunk.length, pos);
        if (n <= 0) break;
        pos += n;
        const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
        for (const x of needles) if (found.get(x.n) === null && buf.indexOf(x.b) >= 0) found.set(x.n, p);
        if ([...found.values()].every((v) => v !== null)) return;
        carry = Buffer.from(buf.subarray(Math.max(0, buf.length - overlap + 1)));
      }
    } catch {
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  const walk = (dir: string, depth: number) => {
    if (depth > 12 || res.stopped) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const e of entries) {
      if (res.stopped || [...found.values()].every((v) => v !== null)) return;
      if (Date.now() > deadline) {
        res.stopped = `the search stopped after ${Math.round((o.budgetMs ?? 120_000) / 1000)} s`;
        return;
      }
      const p = join(dir, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (st.isFile() && !SKIP_EXT.test(e)) {
        if (st.size > maxFile) {
          res.skipped.push(p);
          continue;
        }
        res.files++;
        res.bytes += st.size;
        scan(p, st.size);
      }
    }
  };
  for (const f of folders) walk(f, 0);
  return res;
}
