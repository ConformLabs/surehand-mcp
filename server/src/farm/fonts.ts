// Fonts installed on a machine, by PostScript name, read from the font files themselves (no After Effects needed): the
// "name" table of TrueType / OpenType fonts and collections (nameID 6), and the /FontName of Type 1 fonts.
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Platform } from "./paths.js";

/** The font folders After Effects reads on this platform (system, user, Adobe's own and Creative Cloud's Adobe Fonts). */
export function fontFolders(platform: Platform, home: string, env: Record<string, string | undefined> = process.env): string[] {
  if (platform === "windows") {
    const win = env.WINDIR ?? env.SystemRoot ?? "C:\\Windows";
    const local = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const roaming = env.APPDATA ?? join(home, "AppData", "Roaming");
    const common = env.CommonProgramFiles ?? "C:\\Program Files\\Common Files";
    return [join(win, "Fonts"), join(local, "Microsoft", "Windows", "Fonts"), join(common, "Adobe", "Fonts"), join(roaming, "Adobe", "CoreSync", "plugins", "livetype")];
  }
  return [
    "/System/Library/Fonts",
    "/Library/Fonts",
    join(home, "Library", "Fonts"),
    "/Network/Library/Fonts",
    "/Library/Application Support/Adobe/Fonts",
    join(home, "Library", "Application Support", "Adobe", "CoreSync", "plugins", "livetype"),
  ];
}

const FONT_FILE = /\.(otf|ttf|ttc|otc|dfont|pfb|pfa)$/i;

function readAt(fd: number, pos: number, len: number): Buffer {
  const b = Buffer.alloc(len);
  const n = readSync(fd, b, 0, len, pos);
  return b.subarray(0, n);
}

function decodeName(raw: Buffer, platformId: number): string {
  if (platformId === 0 || platformId === 3) {
    let s = "";
    for (let i = 0; i + 1 < raw.length; i += 2) s += String.fromCharCode(raw.readUInt16BE(i));
    return s;
  }
  return raw.toString("latin1");
}

/** PostScript names (nameID 6) of the sfnt font at `off` in an open file. */
function sfntNames(fd: number, off: number, size: number): string[] {
  const head = readAt(fd, off, 12);
  if (head.length < 12) return [];
  const numTables = head.readUInt16BE(4);
  if (numTables > 512) return [];
  const dir = readAt(fd, off + 12, numTables * 16);
  for (let i = 0; i + 16 <= dir.length; i += 16) {
    if (dir.toString("latin1", i, i + 4) !== "name") continue;
    const tOff = dir.readUInt32BE(i + 8), tLen = Math.min(dir.readUInt32BE(i + 12), 1 << 20);
    if (tOff >= size) return [];
    const t = readAt(fd, tOff, tLen);
    if (t.length < 6) return [];
    const count = t.readUInt16BE(2), strings = t.readUInt16BE(4), names = new Set<string>();
    for (let r = 0; r < count && 6 + r * 12 + 12 <= t.length; r++) {
      const p = 6 + r * 12;
      const platformId = t.readUInt16BE(p), nameId = t.readUInt16BE(p + 6), len = t.readUInt16BE(p + 8), o = t.readUInt16BE(p + 10);
      if (nameId !== 6) continue;
      const s = decodeName(t.subarray(strings + o, strings + o + len), platformId).replace(/\u0000/g, "").trim();
      if (s) names.add(s);
    }
    return [...names];
  }
  return [];
}

/** The PostScript names in one font file ([] when it isn't a font this can read, e.g. a .dfont suitcase). */
export function postScriptNames(path: string): string[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = statSync(path).size;
    const head = readAt(fd, 0, 12);
    if (head.length < 4) return [];
    const tag = head.toString("latin1", 0, 4);
    if (tag === "ttcf") {
      const n = Math.min(head.readUInt32BE(8), 256);
      const offs = readAt(fd, 12, n * 4);
      const out = new Set<string>();
      for (let i = 0; i + 4 <= offs.length; i += 4) for (const s of sfntNames(fd, offs.readUInt32BE(i), size)) out.add(s);
      return [...out];
    }
    if (tag === "OTTO" || tag === "true" || head.readUInt32BE(0) === 0x00010000) return sfntNames(fd, 0, size);
    // Type 1 (.pfb has a 6-byte segment header; .pfa is text): "/FontName /Name def" near the start
    const text = readAt(fd, 0, 8192).toString("latin1");
    const m = /\/FontName\s*\/([^\s/]+)/.exec(text);
    return m ? [m[1]] : [];
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export interface FontIndex {
  /** PostScript name -> the file it is in */
  byName: Map<string, string>;
  files: number;
  unreadable: number;
  folders: string[];
}

/** Every font in these folders (and their subfolders, Adobe Fonts' hidden ones included), by PostScript name. */
export function indexFonts(folders: string[], o: { maxFiles?: number } = {}): FontIndex {
  const byName = new Map<string, string>();
  let files = 0, unreadable = 0;
  const max = o.maxFiles ?? 50_000;
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || files >= max) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(dir, n);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p, depth + 1);
      // Adobe Fonts are stored without an extension
      else if (st.isFile() && (FONT_FILE.test(n) || (/livetype/i.test(dir) && !n.includes(".")))) {
        files++;
        const ps = postScriptNames(p);
        if (!ps.length) unreadable++;
        for (const s of ps) if (!byName.has(s)) byName.set(s, p);
      }
    }
  };
  for (const f of folders) walk(f, 0);
  return { byName, files, unreadable, folders };
}
