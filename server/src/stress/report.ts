// ae_stress_test: the report. One set of data (StressView, which the in-chat view draws) and the text the AI reads,
// built from it: the verdict first, then per failing variant what breaks, where, at which frame and by how much, a
// summary grid, the expressions that break in other After Effects languages, and the read-back of the user's comp.
import { timecode } from "../preflight/report.js";
import type { StressCell, StressColumn, StressFinding, StressVariant, StressView } from "../views/types.js";

export const COLUMN_LABELS: Record<StressColumn, string> = { fit: "Fits box", safe: "Safe area", size: "Text size", glyphs: "Glyphs", lines: "Lines", other: "Other" };
const ORDER: StressVariant["status"][] = ["fail", "warn", "incomplete", "pass", "notRun"];

/** Failing first (most findings first), then warnings, incomplete, passed, not run; stable within a group. */
export function orderVariants(vs: StressVariant[]): StressVariant[] {
  return vs
    .map((v, k) => ({ v, k }))
    .sort((a, b) => ORDER.indexOf(a.v.status) - ORDER.indexOf(b.v.status) || (a.v.status === "fail" ? b.v.findings.length - a.v.findings.length : 0) || a.k - b.k)
    .map((x) => x.v);
}

/** The run's verdict: FAIL when a variant breaks, else WARNINGS, INCOMPLETE (something not measured), PASS. */
export function runVerdict(v: Pick<StressView, "variants" | "languages" | "restore">): { verdict: StressView["verdict"]; line: string } {
  const n = v.variants.length;
  const count = (s: StressVariant["status"]) => v.variants.filter((x) => x.status === s).length;
  const langFail = v.languages.filter((l) => l.severity === "fail").length;
  if (count("fail")) return { verdict: "FAIL", line: `FAIL (${count("fail")} of ${n} variant${n === 1 ? "" : "s"} break${langFail ? `; ${langFail} expression${langFail === 1 ? "" : "s"} break in other AE languages` : ""})` };
  if (langFail) return { verdict: "FAIL", line: `FAIL (${langFail} expression${langFail === 1 ? "" : "s"} break in other AE languages; every variant fits)` };
  if (!v.restore.verified) return { verdict: "INCOMPLETE", line: "INCOMPLETE (your comp could not be confirmed unchanged)" };
  if (count("incomplete") || count("notRun")) return { verdict: "INCOMPLETE", line: `INCOMPLETE (${count("incomplete") + count("notRun")} of ${n} variants not fully measured)` };
  if (count("warn") || v.languages.length) return { verdict: "WARNINGS", line: `WARNINGS (${count("warn")} variant${count("warn") === 1 ? "" : "s"}${v.languages.length ? `, ${v.languages.length} language risk${v.languages.length === 1 ? "" : "s"}` : ""})` };
  return { verdict: "PASS", line: `PASS (${n} variant${n === 1 ? "" : "s"})` };
}

/** "f48" or "f12–f40", with the timecode. */
export function frameText(f: Pick<StressFinding, "frame" | "frameEnd" | "tc">): string {
  if (f.frame === undefined) return "";
  return f.frameEnd !== undefined && f.frameEnd !== f.frame ? ` at f${f.frame}–f${f.frameEnd}` : ` at f${f.frame}${f.tc ? ` (${f.tc})` : ""}`;
}

/** One finding as a sentence: "Title overflows its box by 184 px; 3 lines, the box shows 2 at f48". */
export function findingLine(f: StressFinding): string {
  return `${f.layer ? `${f.layer} ` : ""}${f.severity === "warn" ? "(warning) " : ""}${f.message}${frameText(f)}`;
}

/** Adds the time and timecode to a finding's frame. */
export function withTime(f: StressFinding, comp: StressView["comp"]): StressFinding {
  if (f.frame === undefined) return f;
  const t = f.frame / comp.fps;
  return { ...f, time: Math.round(t * 1e6) / 1e6, tc: timecode(t, comp.fps, !!comp.df, comp.dst ?? 0) };
}

const mark: Record<StressCell, string> = { ok: "ok", bad: "FAIL", warn: "warn", na: "–" };
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));

/** The text report the AI reads (the same data the view draws). */
export function stressText(v: StressView, opts: { maxVariants?: number } = {}): string {
  const out: string[] = [v.verdictLine];
  const c = v.comp, cols = v.columns.filter((x) => x.ran || x.id !== "other");
  out.push(
    `Stress test of "${c.name}" (${c.width}x${c.height}, ${Math.round(c.fps * 100) / 100} fps): ${v.targets.filter((t) => !t.problem).length} control${v.targets.length === 1 ? "" : "s"} (${v.targets.filter((t) => !t.problem).map((t) => `${t.name} [${t.kind}]`).join(", ") || "none"}), ` +
      `${v.counts.variants} variants, measured at ${v.frames.length} frame${v.frames.length === 1 ? "" : "s"} each (f${v.frames.join(", f")})`,
  );
  const ran = v.columns.filter((x) => x.ran).map((x) => x.label.toLowerCase());
  const off = v.columns.filter((x) => !x.ran && x.why).map((x) => `${x.label.toLowerCase()} (${x.why})`);
  out.push(`checked: ${ran.join(", ")}${off.length ? `; not checked: ${off.join("; ")}` : ""}`);
  const parts = [["FAIL", v.counts.failed], ["WARNINGS", v.counts.warnings], ["INCOMPLETE", v.counts.incomplete], ["PASS", v.counts.passed], ["not run", v.counts.notRun]].filter(([, n]) => n);
  out.push(`${v.counts.variants} variants: ${parts.map(([w, n]) => `${n} ${w}`).join(", ")}`);
  if (v.sampled) out.push(`sampled: ${v.sampled.kept} of ${v.sampled.total} (${v.sampled.how})`);

  const bad = v.variants.filter((x) => x.status === "fail" || x.status === "warn" || x.status === "incomplete");
  if (bad.length) {
    out.push("", "what breaks");
    const max = opts.maxVariants ?? 40;
    for (const x of bad.slice(0, max)) {
      const lines = x.findings.map((f) => findingLine(f));
      for (const n of x.notRun) lines.push(`not measured (${COLUMN_LABELS[n.column].toLowerCase()}): ${n.reason}`);
      out.push(`  ${x.status === "fail" ? "FAIL" : x.status === "warn" ? "WARN" : "INCOMPLETE"}  ${x.name} [${x.id}]: ${x.inputs.map((i) => `${i.target} = ${JSON.stringify(i.value.length > 50 ? i.value.slice(0, 50) + "…" : i.value).replace(/\\r/g, "↵")}`).join("; ")}`);
      for (const l of lines.slice(0, 6)) out.push(`        - ${l}`);
      if (lines.length > 6) out.push(`        - ... ${lines.length - 6} more`);
      if (x.sheet) out.push(`        contact sheet: ${x.sheet}`);
    }
    if (bad.length > max) out.push(`  ... ${bad.length - max} more variants with problems (in the view's data)`);
  }

  // the grid: one row per variant, a column per check
  out.push("", "summary", `  ${pad("variant", 30)} ${cols.map((x) => pad(x.label, 9)).join(" ")}`);
  for (const x of v.variants.slice(0, opts.maxVariants ?? 80)) out.push(`  ${pad(`${x.name} [${x.id}]`, 30)} ${cols.map((k) => pad(mark[x.cells[k.id]], 9)).join(" ")}`);
  if (v.variants.length > (opts.maxVariants ?? 80)) out.push(`  ... ${v.variants.length - (opts.maxVariants ?? 80)} more`);

  if (v.baseline.length) {
    out.push("", "already failing in the comp as it is (before any variant; not counted against the variants)");
    for (const f of v.baseline.slice(0, 10)) out.push(`  - ${findingLine(f)}`);
  }
  if (v.languages.length) {
    out.push("", "breaks in other After Effects languages");
    for (const l of v.languages.slice(0, 30))
      out.push(`  ${l.severity === "fail" ? "FAIL" : "WARN"}  ${l.comp} > ${l.layerIndex}: ${l.layer} > ${l.property}: ${l.ref}`, `        ${l.message}; fix: ${l.fix}${l.suggestion ? ` (e.g. ${l.suggestion})` : ""}`);
    if (v.languages.length > 30) out.push(`  ... ${v.languages.length - 30} more`);
  } else out.push("", "expressions: none reach an effect, parameter or property by a translated name");

  out.push("");
  const r = v.restore;
  if (r.verified) out.push(`Your comp is unchanged: ${r.values} values read back identical after the run${r.partial ? " (a very large comp: the first ones)" : ""}${r.proof ? `; ${r.proof}` : ""}. Every variant was set on a scratch copy, which was removed.`);
  else out.push(`Your comp could NOT be confirmed unchanged:${r.differences.slice(0, 8).map((d) => `\n  - ${d}`).join("")}\nCheck it before going on (Edit > Undo lists the stress test's steps).`);
  if (v.folder) out.push(`Contact sheets: ${v.folder}`);
  if (v.notes.length) out.push("", "notes", ...v.notes.slice(0, 10).map((n) => `  - ${n}`));
  return out.join("\n");
}
