// Versions from data: what each row should show (from the data and the mapping, before anything is built), and the
// checks of every built row against it: the values read back from After Effects, and the layout measured with
// Preflight's own code (src/preflight/project.ts: text box overflow, text inside the frame / title- / action-safe,
// missing glyphs; bounds through the transform chain for bar sizes) and Project X-ray's font list. The report follows
// Preflight's verdict rules: a check that didn't run is never a pass.
import { existsSync } from "node:fs";
import { boundsThrough, checkFromXray, checkItems, trackAt, type PData, type PItem } from "../preflight/project.js";
import { formatAt, notRunLines, verdict, type TimeBase } from "../preflight/report.js";
import type { Finding, NotRun, Spec } from "../preflight/spec.js";
import type { XData } from "../tools/xray-analyze.js";
import { colorByRules, fillPattern, footagePath, formatNumber, hex, mapToPx, parseColor, parseNumber, type Cell, type ColorRule, type NumberFormat, type Table } from "./data.js";
import type { VBuilt, VTemplate } from "./jsx.js";

export const KINDS = ["text", "number", "color", "footage", "value", "size"] as const;
export type Kind = (typeof KINDS)[number];

/** One column -> target mapping, as the tool takes it. */
export interface VMap {
  column: string;
  layer?: string | number;
  egp?: string;
  kind: Kind;
  property?: string | (string | number)[];
  format?: NumberFormat;
  rules?: ColorRule[];
  otherwise?: string;
  axis?: "width" | "height";
  px?: [number, number][];
}

export type Margin = number | { x: number; y: number };
export interface VChecks {
  overflow?: boolean;
  textMustBeIn?: "frame" | "title" | "action" | "none";
  title?: Margin;
  action?: Margin;
  glyphs?: boolean;
  fonts?: boolean;
  sizeTolerancePx?: number;
  colorTolerance?: number;
  sampleEveryFrames?: number;
}
export type Mode = "duplicate" | "essentialGraphics";

/** What a target should show in a row. */
export type Expect =
  | { kind: "text"; text: string; num?: number }
  | { kind: "num"; value: number }
  | { kind: "color"; rgb: [number, number, number]; why: string }
  | { kind: "keep"; why: string }
  | { kind: "footage"; path: string }
  | { kind: "value"; raw: Cell }
  | { kind: "size"; px: number; value: number; outside: boolean };

/** One row, ready to build: its name, output path, the values to set (mapping index i) and what to expect. */
export interface Prep {
  n: number;
  name: string;
  out?: string;
  sets: { i: number; v: unknown; n?: number }[];
  expect: Map<number, Expect>;
  /** data problems (a value that can't be made from the cell): the row fails, the target keeps the template's value */
  problems: Finding[];
}

/** A short name for a mapping in messages: the layer (or controller) and, where it helps, what is set. */
export function label(m: VMap, t?: VTemplate["t"][number]): string {
  const target = m.egp !== undefined ? `"${m.egp}"` : t?.ln !== undefined ? `"${t.ln}"` : typeof m.layer === "number" ? `layer ${m.layer}` : `"${m.layer}"`;
  const what = m.kind === "color" ? " colour" : m.kind === "size" ? ` ${m.axis ?? "width"}` : m.kind === "footage" ? " footage" : m.property !== undefined && m.kind === "value" ? ` ${Array.isArray(m.property) ? m.property.join("/") : m.property}` : "";
  return target + what;
}

/** Mapping problems that need no After Effects: columns, targets, kinds, mode. */
export function mappingProblems(map: VMap[], table: Table, mode: Mode): string[] {
  const out: string[] = [];
  map.forEach((m, k) => {
    const at = `map[${k}] (${m.column} -> ${m.kind})`;
    if (!table.columns.includes(m.column)) out.push(`${at}: there is no column "${m.column}" (columns: ${table.columns.join(", ")})`);
    if ((m.layer === undefined) === (m.egp === undefined)) out.push(`${at}: give either layer (a layer of the template comp) or egp (an Essential Graphics controller), not both or neither`);
    else if (mode === "duplicate" && m.egp !== undefined) out.push(`${at}: egp targets need mode "essentialGraphics"`);
    else if (mode === "essentialGraphics" && m.layer !== undefined) out.push(`${at}: layer targets need mode "duplicate" (in Essential Graphics mode the template's layers are shared by every version)`);
    if (mode === "essentialGraphics" && (m.kind === "footage" || m.kind === "size"))
      out.push(`${at}: kind "${m.kind}" works in mode "duplicate" only (it needs the version's own layer)`);
    if (m.format && m.kind !== "number") out.push(`${at}: format applies to kind "number" only`);
    if ((m.rules || m.otherwise !== undefined) && m.kind !== "color") out.push(`${at}: rules / otherwise apply to kind "color" only`);
    for (const c of [...(m.rules ?? []).map((r) => r.color), ...(m.otherwise !== undefined ? [m.otherwise] : [])])
      if (!parseColor(c)) out.push(`${at}: "${c}" is not a colour ("#rrggbb", "#rgb" or "r,g,b")`);
    if (m.kind === "size") {
      if (!m.px || m.px.length < 2) out.push(`${at}: kind "size" needs px: at least two [value, pixels] points, e.g. [[0, 0], [100, 800]]`);
      else if (new Set(m.px.map((p) => p[0])).size < 2) out.push(`${at}: px needs two different values`);
    } else if (m.px || m.axis) out.push(`${at}: px / axis apply to kind "size" only`);
  });
  return out;
}

/** The values, expectations and data problems of one row. */
export function prepareRow(
  n: number,
  row: Record<string, Cell>,
  map: VMap[],
  o: { name: string; out?: string; footageBase?: string; dataDecimal?: "." | ","; t?: VTemplate["t"]; numericTarget: (i: number) => boolean },
): Prep {
  const p: Prep = { n, name: o.name, out: o.out, sets: [], expect: new Map(), problems: [] };
  map.forEach((m, i) => {
    const cell = row[m.column] ?? null, where = label(m, o.t?.[i]);
    const bad = (message: string) => p.problems.push({ check: "data", severity: "fail", where, message: `${m.column} ${JSON.stringify(cell)}: ${message}` });
    switch (m.kind) {
      case "text": {
        // line breaks in the data are line breaks in After Effects text (\r)
        const text = cell === null ? "" : String(cell).replace(/\r\n|\n/g, "\r");
        p.sets.push({ i, v: text });
        p.expect.set(i, { kind: "text", text });
        return;
      }
      case "number": {
        const num = parseNumber(cell, o.dataDecimal);
        if (num === null) return bad("not a number");
        if (o.numericTarget(i)) {
          p.sets.push({ i, v: num, n: num });
          p.expect.set(i, { kind: "num", value: num });
        } else {
          // an Essential Graphics controller's type is known only once built: a number controller gets the number
          const text = formatNumber(num, m.format);
          p.sets.push({ i, v: text, n: num });
          p.expect.set(i, { kind: "text", text, num });
        }
        return;
      }
      case "color": {
        if (m.rules?.length || m.otherwise !== undefined) {
          const hit = colorByRules(cell, m.rules ?? [], m.otherwise, o.dataDecimal);
          if (!hit) return void p.expect.set(i, { kind: "keep", why: "no rule matched" });
          const rgb = parseColor(hit.color)!;
          p.sets.push({ i, v: rgb });
          p.expect.set(i, { kind: "color", rgb, why: `rule ${hit.rule}` });
          return;
        }
        const rgb = parseColor(cell);
        if (!rgb) return bad('not a colour ("#rrggbb", "#rgb" or "r,g,b")');
        p.sets.push({ i, v: rgb });
        p.expect.set(i, { kind: "color", rgb, why: "the cell" });
        return;
      }
      case "footage": {
        const path = footagePath(cell, o.footageBase);
        if (!path) return bad("no file path");
        // a file that isn't there is a data problem: the layer keeps the template's footage
        if (!existsSync(path)) return bad(`no file at ${path}`);
        p.expect.set(i, { kind: "footage", path });
        p.sets.push({ i, v: path });
        return;
      }
      case "value": {
        if (cell === null || String(cell).trim() === "") return bad("empty");
        p.sets.push({ i, v: cell });
        p.expect.set(i, { kind: "value", raw: cell });
        return;
      }
      case "size": {
        const num = parseNumber(cell, o.dataDecimal);
        if (num === null) return bad("not a number");
        const r = mapToPx(num, m.px!);
        p.sets.push({ i, v: r.px, n: num });
        p.expect.set(i, { kind: "size", px: r.px, value: num, outside: r.outside });
        if (r.outside) {
          const vals = m.px!.map((q) => q[0]);
          bad(`outside the mapped values (${Math.min(...vals)} to ${Math.max(...vals)}): set to ${Math.round(r.px * 10) / 10} px by extending the mapping`);
        }
        return;
      }
    }
  });
  return p;
}

/** Name and output path of a row. */
export function rowNames(n: number, row: Record<string, Cell>, pattern: string, output: string | undefined, template: string, columns: string[]) {
  return { name: fillPattern(pattern, row, n, template, columns), out: output !== undefined ? fillPattern(output, row, n, template, columns, true) : undefined };
}

// ---------- checks after building ----------

const q = (s: string) => JSON.stringify(s.length > 60 ? s.slice(0, 60) + "…" : s).replace(/\\r/g, "↵");
const sameText = (a: string, b: string) => a.replace(/\r\n|\n/g, "\r") === b.replace(/\r\n|\n/g, "\r");
const near = (a: number, b: number) => Math.abs(a - b) <= 1e-4 * Math.max(1, Math.abs(a), Math.abs(b));
const normPath = (p: string) => (process.platform === "win32" ? p.replace(/\//g, "\\").toLowerCase() : p).normalize("NFC");

/** A cell (kind "value") compared with the value read back: numbers and lists of numbers by value, text exactly. */
export function valueMatches(raw: Cell, got: unknown): boolean {
  if (typeof got === "number") {
    const n = typeof raw === "number" ? raw : Number(String(raw).trim());
    return Number.isFinite(n) && near(n, got);
  }
  if (Array.isArray(got)) {
    const asColor = got.length === 4 && got.every((x) => typeof x === "number" && x >= 0 && x <= 1) ? parseColor(raw) : null;
    if (asColor) return asColor.every((c, k) => Math.abs(c - (got[k] as number)) <= 0.5 / 255 + 1e-6);
    const parts = String(raw).replace(/^\s*\[|\]\s*$/g, "").split(/[\s,;]+/).filter(Boolean).map(Number);
    return parts.length <= got.length && parts.every((x, k) => near(x, got[k] as number));
  }
  if (typeof got === "string") return sameText(got, String(raw));
  return false;
}

export interface RowCheckInput {
  prep: Prep;
  built: VBuilt["rows"][number];
  map: VMap[];
  template: VTemplate;
  mode: Mode;
  checks: Required<Pick<VChecks, "overflow" | "glyphs" | "fonts" | "textMustBeIn">> & VChecks;
  checkAt: number;
  /** Preflight's data for this version comp (duplicate mode), or why it couldn't be read */
  layout?: { data?: PData; error?: string; sizePatterns: Map<number, number> };
  /** X-ray's font data for the whole run, or why it couldn't be read */
  fonts?: { x?: XData; error?: string };
}

export interface RowResult {
  n: number;
  name: string;
  findings: Finding[];
  notRun: NotRun[];
  notes: string[];
  verdict: string;
}

/** Preflight's items for the mapped layers of the version comp itself (not its precomps, which every version shares). */
function topLevel(d: PData, compName: string, indexes: Set<number>): PItem[] {
  const head = `${compName} > `;
  return d.items.filter((it) => {
    if (!it.w.startsWith(head)) return false;
    const m = /^(\d+): /.exec(it.w.slice(head.length));
    return !!m && indexes.has(Number(m[1])) && !it.w.slice(head.length + m[0].length).includes(" > ");
  });
}

export function checkRow(o: RowCheckInput): RowResult {
  const { prep, built, map, template, checks } = o;
  const findings: Finding[] = [...prep.problems], notRun: NotRun[] = [], notes: string[] = [];
  const failedSet = new Set(built.err.map(([i]) => i));
  for (const [i, msg] of built.err) findings.push({ check: "set", severity: "fail", where: label(map[i], template.t[i]), message: `could not be set: ${msg}` });
  const tolColor = (checks.colorTolerance ?? 0.5) / 255 + 1e-6;

  // the values, read back where they render (at checkAt, expressions applied)
  map.forEach((m, i) => {
    const e = prep.expect.get(i);
    if (!e || failedSet.has(i)) return;
    const got = built.rb[String(i)], where = label(m, template.t[i]), ex = template.t[i]?.ex ? " (an expression on it changes the value)" : "";
    switch (e.kind) {
      case "text":
        if (typeof got === "number" && e.num !== undefined) {
          if (!near(got, e.num)) findings.push({ check: "value", severity: "fail", where, at: o.checkAt, message: `is ${got}; expected ${e.num}${ex}` });
        } else if (typeof got !== "string") findings.push({ check: "text.format", severity: "fail", where, message: "the text could not be read back" });
        else if (!sameText(got, e.text)) findings.push({ check: "text.format", severity: "fail", where, at: o.checkAt, message: `shows ${q(got)}; expected ${q(e.text)}${ex}` });
        return;
      case "num":
        if (typeof got !== "number" || !near(got, e.value)) findings.push({ check: "value", severity: "fail", where, at: o.checkAt, message: `is ${JSON.stringify(got)}; expected ${e.value}${ex}` });
        return;
      case "color": {
        const c = Array.isArray(got) ? (got as number[]) : null;
        if (!c) findings.push({ check: "color", severity: "fail", where, message: `no colour could be read back (expected ${hex(e.rgb)} from ${e.why})` });
        else if (e.rgb.some((v, k) => Math.abs(v - c[k]) > tolColor)) findings.push({ check: "color", severity: "fail", where, at: o.checkAt, message: `is ${hex(c)}; ${e.why} gives ${hex(e.rgb)}${ex}` });
        return;
      }
      case "keep":
        notes.push(`row ${prep.n}: ${where}: ${e.why} and there is no "otherwise", so it keeps the template's colour`);
        return;
      case "footage": {
        const f = got as { file?: string | null; exists?: boolean; missing?: boolean } | undefined;
        if (!f) findings.push({ check: "footage", severity: "fail", where, message: "the layer's source could not be read back" });
        else if (!f.file || normPath(f.file) !== normPath(e.path)) findings.push({ check: "footage", severity: "fail", where, message: `uses ${f.file ?? "no file"}; expected ${e.path}` });
        else if (f.missing || f.exists === false) findings.push({ check: "footage", severity: "fail", where, message: `footage file missing: ${e.path}` });
        return;
      }
      case "value":
        if (!valueMatches(e.raw, got)) findings.push({ check: "value", severity: "fail", where, at: o.checkAt, message: `is ${JSON.stringify(got)}; expected ${JSON.stringify(e.raw)}${ex}` });
        return;
      case "size":
        return; // measured below
    }
  });

  // text layout and sizes, measured with Preflight's code (duplicate mode: the version's own layers)
  const textIdx = new Set<number>();
  map.forEach((m, i) => {
    if ((m.kind === "text" || m.kind === "number") && template.t[i]?.pt === "TEXT_DOCUMENT" && template.t[i]?.li) textIdx.add(template.t[i].li!);
  });
  const layoutChecks = [checks.overflow && "text.overflow", checks.textMustBeIn !== "none" && `text inside ${checks.textMustBeIn === "frame" ? "the frame" : `${checks.textMustBeIn}-safe`}`, checks.glyphs && "text.glyphs"].filter(Boolean) as string[];
  // a value outside the mapping already fails the row (the data problem); its extended size isn't measured as well
  const sizes = map.map((m, i) => ({ m, i })).filter(({ m, i }) => m.kind === "size" && !failedSet.has(i) && prep.expect.has(i) && !(prep.expect.get(i) as { outside?: boolean }).outside);
  if (o.mode === "essentialGraphics") {
    for (const c of layoutChecks) notRun.push({ check: c, reason: "Essential Graphics mode: the values live on the precomp layer, and scripts read the template's own layers, so a row's layout can't be measured (use mode \"duplicate\")" });
  } else if ((textIdx.size && layoutChecks.length) || sizes.length) {
    const d = o.layout?.data;
    if (!d) {
      const why = `the layout could not be read: ${o.layout?.error ?? "unknown error"}`;
      if (textIdx.size) for (const c of layoutChecks) notRun.push({ check: c, reason: why });
      for (const { m, i } of sizes) notRun.push({ check: `size ${label(m, template.t[i])}`, reason: why });
    } else {
      if (textIdx.size && layoutChecks.length) {
        const spec: Spec = {
          safeAreas:
            checks.textMustBeIn !== "none"
              ? { textMustBeIn: checks.textMustBeIn, ...(checks.title !== undefined ? { title: checks.title } : {}), ...(checks.action !== undefined ? { action: checks.action } : {}) }
              : undefined,
          text: { noOverflow: checks.overflow, glyphs: checks.glyphs },
        };
        const r = checkItems(spec, { ...d, items: topLevel(d, built.name, textIdx).filter((it) => it.t) });
        findings.push(...r.findings);
        notRun.push(...r.notRun);
        notes.push(...r.notes);
      }
      const tol = checks.sizeTolerancePx ?? 1, fd = d.comp.fd, step = d.step;
      const sample = Math.min(d.n - 1, Math.round(o.checkAt / (step * fd)));
      for (const { m, i } of sizes) {
        const e = prep.expect.get(i) as Extract<Expect, { kind: "size" }>, where = label(m, template.t[i]), check = `size ${where}`;
        const it = topLevel(d, built.name, new Set([template.t[i].li!])).find((x) => x.m?.includes(o.layout!.sizePatterns.get(i)!));
        if (!it || !it.i.length) {
          notRun.push({ check, reason: `the layer is never visible (off, transparent or outside its in/out points), so its size can't be measured` });
          continue;
        }
        if (it.d3) {
          notRun.push({ check, reason: "3D layer (or parented to one): its on-screen size isn't measured here (check it with ae_get_layer_bounds)" });
          continue;
        }
        const k = it.i.indexOf(sample);
        if (k < 0 || !it.rect || !it.lv) {
          notRun.push({ check, reason: `the layer isn't visible at ${Math.round(o.checkAt * 1000) / 1000} s (checkAt), so its size can't be measured there` });
          continue;
        }
        if (it.ao || it.px?.length)
          findings.push({ check: "size", severity: "warn", where, message: `the measured size may be off: ${it.ao ? "auto-orient is on" : it.px!.slice(0, 2).join("; ")}`, fix: "check it with ae_render_frame" });
        const b = boundsThrough(trackAt(it.rect, k), it.lv, k);
        const got = b ? (m.axis === "height" ? b.y1 - b.y0 : b.x1 - b.x0) : 0;
        if (Math.abs(got - e.px) > tol + 1e-6)
          findings.push({ check: "size", severity: "fail", where, at: o.checkAt, message: `${round1(got)} px ${m.axis === "height" ? "high" : "wide"} on screen; ${m.column} ${e.value} maps to ${round1(e.px)} px (±${tol} px)` });
      }
    }
  }

  // missing fonts of the mapped text layers (Project X-ray's list)
  if (checks.fonts && textIdx.size) {
    if (o.mode === "essentialGraphics") notRun.push({ check: "fonts", reason: "Essential Graphics mode: the text layers are the template's, shared by every version" });
    else if (!o.fonts?.x) notRun.push({ check: "fonts", reason: `the fonts could not be read: ${o.fonts?.error ?? "unknown error"}` });
    else {
      const x = o.fonts.x;
      const comps = x.comps.filter((c) => c.id === built.id).map((c) => ({ ...c, layers: (c.layers ?? []).filter((l) => textIdx.has(l.i)) }));
      const r = checkFromXray({ project: { noMissingFonts: true } }, { ...x, comps, partial: undefined });
      findings.push(...r.findings);
      notRun.push(...r.notRun.map((n) => ({ ...n, check: "fonts" })));
    }
  }
  if (prep.out !== undefined && built.rq?.exists)
    findings.push({ check: "render", severity: "fail", where: built.name, message: `a file already exists at ${built.rq.file}: not queued (pass overwrite: true to replace it)` });
  if (prep.out !== undefined && built.rq?.error) findings.push({ check: "render", severity: "fail", where: built.name, message: built.rq.error });
  return { n: prep.n, name: built.name, findings, notRun, notes, verdict: verdict(findings, notRun) };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

// ---------- the report ----------

const word = (v: string) => v.split(" ")[0];

/** "FAIL (2 of 12 rows)": the worst row verdict, with how many rows have it. */
export function runVerdict(rows: Pick<RowResult, "verdict">[], noun = "row"): string {
  for (const w of ["FAIL", "INCOMPLETE", "WARNINGS"]) {
    const n = rows.filter((r) => word(r.verdict) === w).length;
    if (n) return `${w} (${n} of ${rows.length} ${noun}${rows.length === 1 ? "" : "s"})`;
  }
  return "PASS";
}

/** One line for a finding: where, what, when. */
export function findingText(f: Finding, tb?: TimeBase): string {
  const when = f.at !== undefined && f.check !== "text.format" && f.check !== "value" && f.check !== "color" ? ` at ${formatAt(f.at, tb)}` : "";
  return `${f.where && f.check !== "render" ? `${f.where.replace(/^.* > \d+: /, "")}: ` : ""}${f.severity === "warn" ? "warning: " : ""}${f.message}${when}`;
}

export function rowLine(r: RowResult, tb?: TimeBase, maxPerRow = 4): string {
  const v = r.verdict, head = `  ${String(r.n).padStart(3)}  ${v.padEnd(11)} ${r.name}`;
  if (v === "PASS") return head;
  const fails = r.findings.filter((f) => f.severity === "fail"), warns = r.findings.filter((f) => f.severity === "warn");
  const parts = [...fails, ...warns].map((f) => findingText(f, tb));
  if (r.notRun.length) parts.push(`not checked: ${notRunLines(r.notRun).join("; ")}`);
  const shown = parts.slice(0, maxPerRow);
  return `${head}: ${shown.join(" · ")}${parts.length > shown.length ? ` · +${parts.length - shown.length} more` : ""}`;
}

export function totalsLine(rows: Pick<RowResult, "verdict">[], noun = "row"): string {
  const count = (w: string) => rows.filter((r) => word(r.verdict) === w).length;
  const parts = [["PASS", count("PASS")], ["FAIL", count("FAIL")], ["INCOMPLETE", count("INCOMPLETE")], ["WARNINGS", count("WARNINGS")]].filter(([, n]) => n).map(([w, n]) => `${n} ${w}`);
  return `${rows.length} ${noun}${rows.length === 1 ? "" : "s"}: ${parts.join(", ")}`;
}
