// Image sequences on disk: the frames of a footage sequence (its range and gaps), and an output module's file name with
// [####] (its padding, and the files a render wrote).
import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32";

export interface SeqPattern {
  dir: string;
  prefix: string;
  suffix: string;
  /** digits in the name ([####] = 4; 0 when the template has no [#]) */
  pad: number;
}

/** An output module's file with [#####] (After Effects' frame number placeholder). null: no placeholder. */
export function parseTemplate(path: string): SeqPattern | null {
  const name = basename(path.replace(/\\/g, "/"));
  const m = /^(.*?)\[(#+)\](.*)$/.exec(name);
  if (!m) return null;
  const dir = path.slice(0, path.length - name.length).replace(/[\\/]+$/, "") || ".";
  return { dir, prefix: m[1], suffix: m[3], pad: m[2].length };
}

/** A sequence's first frame (shot_0001.png) as a pattern. */
export function patternOfFrame(path: string): SeqPattern | null {
  const name = basename(path);
  const m = /^(.*?)(\d+)(\.[^.]+)$/.exec(name);
  if (!m) return null;
  return { dir: dirname(path), prefix: m[1], suffix: m[3], pad: m[2].length };
}

export const frameName = (p: SeqPattern, n: number) => `${p.prefix}${String(n).padStart(p.pad, "0")}${p.suffix}`;
export const templateName = (p: SeqPattern) => `${p.prefix}[${"#".repeat(Math.max(1, p.pad))}]${p.suffix}`;

export interface SeqFile { name: string; num: number; digits: number; bytes: number }

/** The files in the pattern's folder that are frames of it (any number of digits), sorted by number. */
export function listFrames(p: SeqPattern): SeqFile[] {
  const re = new RegExp(`^${esc(p.prefix)}(\\d+)${esc(p.suffix)}$`, CASE_INSENSITIVE ? "i" : "");
  let names: string[] = [];
  try {
    names = readdirSync(p.dir);
  } catch {
    return [];
  }
  const out: SeqFile[] = [];
  for (const n of names) {
    const m = re.exec(n);
    if (!m) continue;
    let bytes = -1;
    try {
      const st = statSync(join(p.dir, n));
      if (!st.isFile()) continue;
      bytes = st.size;
    } catch {
      continue;
    }
    out.push({ name: n, num: Number(m[1]), digits: m[1].length, bytes });
  }
  return out.sort((a, b) => a.num - b.num || a.name.localeCompare(b.name));
}

/** Numbers missing between the first and the last, as [from, to] runs. */
export function gapsIn(nums: number[]): [number, number][] {
  const s = [...new Set(nums)].sort((a, b) => a - b), out: [number, number][] = [];
  for (let i = 1; i < s.length; i++) if (s[i] > s[i - 1] + 1) out.push([s[i - 1] + 1, s[i] - 1]);
  return out;
}

/** [from, to] runs of consecutive numbers (for "frames 12-19, 40"). */
export function runsOf(nums: number[]): [number, number][] {
  const s = [...new Set(nums)].sort((a, b) => a - b), out: [number, number][] = [];
  for (const n of s) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}
export const runsText = (runs: [number, number][], max = 12) => {
  const t = runs.slice(0, max).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`));
  return runs.length > max ? `${t.join(", ")} and ${runs.length - max} more ranges` : t.join(", ");
};

export interface FootageSequence {
  pattern: string;
  first: number;
  last: number;
  count: number;
  gaps: [number, number][];
  bytes: number;
}

/** The sequence on disk whose frame is `file`: its frame range, gaps and size. */
export function footageSequence(file: string): FootageSequence | null {
  const p = patternOfFrame(file);
  if (!p) return null;
  const frames = listFrames(p);
  if (!frames.length) return null;
  const nums = frames.map((f) => f.num);
  return { pattern: join(p.dir, templateName(p)), first: nums[0], last: nums[nums.length - 1], count: frames.length, gaps: gapsIn(nums), bytes: frames.reduce((n, f) => n + Math.max(0, f.bytes), 0) };
}
