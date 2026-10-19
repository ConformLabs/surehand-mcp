// Preflight report: a verdict line, then the findings grouped by check and sorted by time, with timecode in
// the delivered comp's frame rate (HH:MM:SS:FF, drop-frame HH;MM;SS;FF where the comp uses it) and seconds.
import type { Finding } from "./spec.js";

/** SMPTE timecode of a time in seconds. Drop-frame only for 29.97 / 59.94 when asked. */
export function timecode(seconds: number, fps: number, dropFrame = false, offset = 0): string {
  const nominal = Math.max(1, Math.round(fps));
  let frame = Math.floor((seconds + offset) * fps + 1e-6);
  const neg = frame < 0;
  if (neg) frame = -frame;
  const drop = dropFrame && Math.abs(fps * 1001 / 1000 - nominal) < 0.01 && nominal % 30 === 0 ? (nominal / 30) * 2 : 0;
  if (drop) {
    const per10 = Math.round(fps * 600), perMin = nominal * 60 - drop;
    const d = Math.floor(frame / per10), m = frame % per10;
    frame += drop * 9 * d + (m > drop ? drop * Math.floor((m - drop) / perMin) : 0);
  }
  const ff = frame % nominal, totalS = Math.floor(frame / nominal);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const sep = drop ? ";" : ":";
  return `${neg ? "-" : ""}${p2(Math.floor(totalS / 3600))}${sep}${p2(Math.floor(totalS / 60) % 60)}${sep}${p2(totalS % 60)}${sep}${p2(ff)}`;
}

const secs = (s: number) => `${(Math.round(s * 100) / 100).toFixed(2)}s`;

export interface TimeBase {
  fps: number;
  dropFrame?: boolean;
  /** the comp's display start time (timecode starts there) */
  offset?: number;
}

/** "00:00:02:03–00:00:03:10 (2.12s–3.40s)", or seconds alone without a frame rate. */
export function formatAt(at: Finding["at"], tb?: TimeBase): string {
  if (at === undefined) return "";
  const [a, b] = Array.isArray(at) ? at : [at, at];
  const tc = (s: number) => (tb ? timecode(s, tb.fps, tb.dropFrame, tb.offset ?? 0) : "");
  if (a === b) return tb ? `${tc(a)} (${secs(a)})` : secs(a);
  return tb ? `${tc(a)}–${tc(b)} (${secs(a)}–${secs(b)})` : `${secs(a)}–${secs(b)}`;
}

export function verdict(findings: Finding[]): string {
  const fails = findings.filter((f) => f.severity === "fail").length, warns = findings.filter((f) => f.severity === "warn").length;
  return fails ? `FAIL (${fails})` : warns ? `WARNINGS (${warns})` : "PASS";
}

const ORDER = ["video", "project", "safeAreas", "text"];
const SEV = { fail: 0, warn: 1, info: 2 } as const;
const startOf = (f: Finding) => (f.at === undefined ? -1 : Array.isArray(f.at) ? f.at[0] : f.at);

export interface ReportInput {
  /** the line under the verdict: what was checked against which spec */
  title: string;
  findings: Finding[];
  timeBase?: TimeBase;
  skipped?: string[];
  notes?: string[];
  /** the rendered file's probe, shown compactly */
  probe?: Record<string, unknown>;
  maxFindings?: number;
}

/** The whole report as text. */
export function formatReport(r: ReportInput): string {
  const out = [verdict(r.findings), r.title];
  const groups = new Map<string, Finding[]>();
  for (const f of r.findings) {
    const g = f.check.split(".")[0];
    groups.set(g, [...(groups.get(g) ?? []), f]);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const max = r.maxFindings ?? 60, perGroup = Math.max(3, Math.floor(max / Math.max(1, keys.length)));
  let shown = 0;
  for (const g of keys) {
    const list = groups.get(g)!.sort((a, b) => startOf(a) - startOf(b) || SEV[a.severity] - SEV[b.severity]);
    const n = Math.min(list.length, perGroup, Math.max(0, max - shown));
    out.push("", `${g} (${list.length}${n < list.length ? `, showing ${n}` : ""})`);
    for (const f of list.slice(0, n)) {
      const when = formatAt(f.at, r.timeBase);
      const head = [f.severity.toUpperCase().padEnd(4), when, f.where ? `${f.where}:` : ""].filter(Boolean).join("  ");
      out.push(`  ${head} ${f.message}`);
      if (f.fix) out.push(`        fix: ${f.fix}`);
    }
    if (n < list.length) out.push(`  ... ${list.length - n} more (raise maxFindings to see them)`);
    shown += n;
  }
  if (r.probe && Object.keys(r.probe).length) {
    out.push("", "file");
    out.push("  " + Object.entries(r.probe).map(([k, v]) => `${k}: ${typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}`).join("; "));
  }
  if (r.skipped?.length) out.push("", "not checked", ...r.skipped.map((s) => `  - ${s}`));
  if (r.notes?.length) out.push("", "notes", ...r.notes.map((s) => `  - ${s}`));
  return out.join("\n");
}
