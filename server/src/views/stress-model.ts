// The stress test view's model (no DOM: unit-tested in test/stress-view.test.ts): which variants the grid shows and
// in what order, which columns, the verdict bar's counts, the footer, and the open row's frame marks.
import type { Rect, StressColumn, StressFinding, StressVariant, StressView } from "./types.js";

/** The grid's rows before "Show all": every variant with a problem, then passed ones up to this many rows in all. */
export const GRID_CAP = 6;
export const GRID_COLUMNS: StressColumn[] = ["fit", "safe", "size", "glyphs", "lines"];
export const COLUMN_TITLES: Record<StressColumn, string> = { fit: "Fits box", safe: "Safe area", size: "Text size", glyphs: "Glyphs", lines: "Lines", other: "Other" };

const RANK: Record<StressVariant["status"], number> = { fail: 0, warn: 1, incomplete: 2, pass: 3, notRun: 4 };
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

export interface GridModel {
  columns: StressColumn[];
  rows: StressVariant[];
  /** passed (or not run) variants left out of the grid until Show all */
  hidden: StressVariant[];
}

/** Failing first, then warnings, incomplete, passed, not run (stable); the cap applies to passed ones only. */
export function gridModel(d: StressView, showAll = false): GridModel {
  const ordered = d.variants.map((v, k) => ({ v, k })).sort((a, b) => RANK[a.v.status] - RANK[b.v.status] || a.k - b.k).map((x) => x.v);
  const problems = ordered.filter((v) => RANK[v.status] < RANK.pass);
  const rest = ordered.filter((v) => RANK[v.status] >= RANK.pass);
  const room = showAll ? rest.length : Math.max(0, GRID_CAP - problems.length);
  // "Other" (numbers, values a control can't take, expression errors) only when a variant has something there
  const other = d.variants.some((v) => v.cells.other === "bad" || v.cells.other === "warn");
  return { columns: other ? [...GRID_COLUMNS, "other"] : GRID_COLUMNS, rows: [...problems, ...rest.slice(0, room)], hidden: rest.slice(room) };
}

/** "3 of 14 variants break · 1 warning · 2 language risks" */
export function verdictText(d: StressView): string {
  const c = d.counts, parts: string[] = [];
  if (c.failed) parts.push(`${c.failed} of ${plural(c.variants, "variant")} break${c.failed === 1 ? "s" : ""}`);
  else parts.push(c.variants ? `${plural(c.variants, "variant")}, none break${c.variants === 1 ? "s" : ""}` : "no variants run");
  if (c.warnings) parts.push(plural(c.warnings, "warning"));
  if (c.incomplete + c.notRun) parts.push(`${c.incomplete + c.notRun} not measured`);
  if (c.languageRisks) parts.push(plural(c.languageRisks, "language risk"));
  if (!d.restore.verified) parts.push("comp not confirmed unchanged");
  return parts.join(" · ");
}

/** "3 controls · 14 variants · 6 frames each · 1920×1080" */
export function metaText(d: StressView): string {
  return [plural(d.counts.targets, "control"), plural(d.counts.variants, "variant"), `${plural(d.frames.length, "frame")} each`, `${d.comp.width}×${d.comp.height}`].join(" · ");
}

/** "8 more variants passed · English, French, Hebrew …" */
export function footerText(g: GridModel, showAll: boolean, total: number): string {
  const passed = g.hidden.filter((v) => v.status === "pass"), notRun = g.hidden.length - passed.length;
  if (!g.hidden.length) return showAll ? `${plural(total, "variant")} shown` : `${plural(total, "variant")}, all shown`;
  const names = passed.slice(0, 5).map((v) => v.name).join(", ") + (passed.length > 5 ? " …" : "");
  return [passed.length ? `${passed.length} more variant${passed.length === 1 ? "" : "s"} passed` : "", notRun ? `${notRun} not measured` : "", names].filter(Boolean).join(" · ");
}

/** The open row's lead finding (the worst, earliest) and the sentence the right-hand side shows. */
export function leadFinding(v: StressVariant): StressFinding | undefined {
  return [...v.findings].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "fail" ? -1 : 1) || (a.frame ?? 1e9) - (b.frame ?? 1e9))[0];
}
export function openMessage(v: StressVariant): string {
  const fs = [...v.findings].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "fail" ? -1 : 1));
  const parts = fs.slice(0, 3).map((f, k) => `${k === 0 || f.layer !== fs[0].layer ? (f.layer ? `${f.layer} ` : "") : ""}${f.message}`);
  if (fs.length > 3) parts.push(`and ${fs.length - 3} more`);
  if (!parts.length) return v.notRun.length ? v.notRun.map((n) => n.reason).join("; ") : "Nothing breaks.";
  const s = parts.join("; ");
  return s.charAt(0).toUpperCase() + s.slice(1) + (/[.!?…)]$/.test(s) ? "" : ".");
}

/** What the frame marks: the safe area and the text's box dashed, the problem outlined. */
export function frameMarks(f: StressFinding | undefined): { dashed: Rect[]; hit?: { rect: Rect; warn: boolean } } {
  if (!f) return { dashed: [] };
  const dashed: Rect[] = [];
  if (f.area && f.area.name !== "frame") dashed.push(f.area.rect);
  if (f.textBox) dashed.push(f.textBox);
  let hit: Rect | undefined = f.box;
  // a paragraph that overflows: the part below its box that is cut off
  if (f.check === "text.overflow" && f.textBox && f.amountPx) hit = [f.textBox[0], f.textBox[3], f.textBox[2], f.textBox[3] + f.amountPx];
  return { dashed, ...(hit ? { hit: { rect: hit, warn: f.severity === "warn" } } : {}) };
}

/** What "Ask the AI to fix this" writes into the chat. */
export function fixRequest(d: StressView, v: StressVariant): string {
  const f = leadFinding(v);
  const input = v.inputs.map((i) => `${i.target} = ${JSON.stringify(i.value)}`).join(", ");
  return `Fix the stress test failure "${v.name}" [${v.id}] in "${d.comp.name}"${f?.tc ? ` at ${f.tc}` : ""} (${input}): ${openMessage(v).replace(/\.$/, "")}. Keep the template's look; then run the stress test again.`;
}
