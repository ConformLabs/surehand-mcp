// ae_localize: the localization round trip. "export" writes every text of a comp tree for translators (CSV for Excel,
// XLIFF 1.2 for CAT tools) with its context; "import" builds one version per language from the translated file (the
// comp tree duplicated, the texts set, right-to-left languages set up, every text fitted by the user's own rules) and
// checks each language with Preflight's code; "drift" lists the master texts that changed since the export. The files
// are src/localize/files.ts, the ExtendScript src/localize/jsx.ts; the checks reuse src/preflight/project.ts and
// src/versions/checks.ts. The import is one undo step (one ae_undo removes every language); export and drift only read.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { z } from "zod";
import { loadConfig, VERSION } from "../config.js";
import { writeFileAtomic } from "../fsutil.js";
import { formatChanges, rollbackProblem, runJsx } from "../jsx.js";
import { permissions, READ_ONLY_REFUSAL } from "../permissions.js";
import { areaBox, boundsThrough, checkFromXray, checkItems, PREFLIGHT_JSX, trackAt, verticalScale, type PArgs, type PData, type PItem } from "../preflight/project.js";
import { timecode, verdict, notRunLines, type TimeBase } from "../preflight/report.js";
import type { Finding, NotRun, Spec } from "../preflight/spec.js";
import { findingText, runVerdict, totalsLine } from "../versions/checks.js";
import { isRtl, LANG_RE, langPath, readTranslations, sameText, toFileText, writeCsv, writeXliff, type LFile, type LUnit } from "../localize/files.js";
import { BUILD_JSX, COLLECT_JSX, type BBuilt, type BLang, type BuildArgs, type JLang, type JStep, type JUnit, type LCollect, type LLayer } from "../localize/jsx.js";
import type { XData } from "./xray-analyze.js";
import { XRAY_JSX } from "./xray.js";
import { saveCheckpoint } from "./workflow.js";
import { capText, compRef, errorResult, formatResult, reportScope } from "./registry.js";

const margin = z.union([z.number().min(0).max(0.5), z.object({ x: z.number().min(0).max(0.5), y: z.number().min(0).max(0.5) }).strict()]);
const lang = z.string().regex(LANG_RE, "a language code like he, ar, fr-CA");
const ADJUST = ["tracking", "fontSize", "capHeight", "horizontalScale", "boxWidth", "boxHeight"] as const;
const stepSchema = z
  .object({
    adjust: z
      .enum(ADJUST)
      .describe(
        "tracking: down to min (After Effects tracking units). fontSize: down to min (px). capHeight: font size down until the cap height is min (comp px, " +
          "measured on the font). horizontalScale: down to min (%). boxWidth / boxHeight: paragraph box grows by up to maxGrow px, away from the edge the text is aligned to.",
      ),
    min: z.number().optional().describe("tracking, fontSize, capHeight, horizontalScale: the user's minimum."),
    maxGrow: z.number().min(0).optional().describe("boxWidth, boxHeight: the most the box may grow, px."),
  })
  .strict();
const fitSchema = z
  .object({
    steps: z.array(stepSchema).max(10).optional().describe("The adjustments the user allows, tried in this order until the text fits. None: nothing is adjusted."),
    maxWidth: z.number().min(1).optional().describe("Point text: the most width it may take, comp px (paragraph text must fit its box)."),
    maxWidthOfSource: z.number().min(0.1).max(10).optional().describe("Point text: the most width as a multiple of the master text's width (e.g. 1.1)."),
  })
  .strict();

export const inputSchema = {
  action: z.enum(["export", "import", "drift"]).describe("export: write the texts for translators. import: build a version per language from the translated file. drift: which master texts changed since the export."),
  comp: compRef.describe("The master (root) comp; its precomps are included. Default: the comp named in the file (import / drift), else the active comp."),
  file: z
    .union([z.string(), z.array(z.string()).min(1).max(50)])
    .describe(
      'export: the file to write, .csv (one column per language) or .xlf (XLIFF 1.2, one file per language: put {lang} in the name, e.g. "/loc/main_{lang}.xlf"). ' +
        "import / drift: the translated .csv, or the .xlf files.",
    ),
  languages: z.array(lang).min(1).max(50).optional().describe("export: the target languages (required). import: the languages to build (default: every language in the file)."),
  sourceLanguage: lang.optional().describe("export: the master's language (required for XLIFF)."),
  maxChars: z.union([z.number().int().min(1), z.literal("fromBox")]).optional().describe('export: a character limit for every string, or "fromBox": estimated per string from its box / the width it has. Default: none.'),
  notes: z.record(z.string(), z.string()).optional().describe("export: notes for translators, by string id or layer name."),
  includeHidden: z.boolean().optional().describe("export: also texts of layers that are off and guide layers (expressions often read them). Default true."),
  name: z.string().optional().describe('import: name pattern of each copied comp: {comp} = the master comp\'s name, {lang}. Default "{comp} [{lang}]".'),
  folder: z.string().optional().describe('import: project folder per language: {root}, {lang}. Default "{root} - {lang}".'),
  fit: fitSchema.optional().describe("import: how a text that doesn't fit may be adjusted: the user's rules, never more. Without it nothing is adjusted (a text that doesn't fit FAILs)."),
  fitLayers: z
    .array(fitSchema.extend({ layer: z.string().describe("Layer name."), comp: z.string().optional().describe("Only in this comp (name).") }).strict())
    .max(100)
    .optional()
    .describe("import: per-layer rules instead of fit."),
  fonts: z.record(lang, z.record(z.string(), z.string())).optional().describe('import: per language, font PostScript name -> the user\'s font for it ("*": every font), e.g. {"he": {"*": "ArialHebrew"}}.'),
  direction: z.record(lang, z.enum(["rtl", "ltr"])).optional().describe("import: the direction of a language when its code doesn't say (he, ar, fa, ur, yi... are right to left)."),
  rtl: z
    .object({
      justification: z.enum(["mirror", "keep"]).optional().describe('"mirror" (default): left-aligned becomes right-aligned when the direction flips; centred stays.'),
      pointText: z.enum(["keepExtent", "keepAnchor"]).optional().describe('Point text whose alignment flips: "keepExtent" (default) moves its anchor point so the text stays where the master\'s was; "keepAnchor" leaves it.'),
      composer: z.boolean().optional().describe("Set the Universal (formerly South Asian and Middle Eastern) composer, needed for Arabic shaping (default true)."),
      digits: z.enum(["DEFAULT_DIGITS", "ARABIC_DIGITS", "HINDI_DIGITS", "FARSI_DIGITS", "ARABIC_DIGITS_RTL"]).optional().describe("The digit set for right-to-left versions (default: unchanged)."),
    })
    .strict()
    .optional(),
  allowUntranslated: z.boolean().optional().describe("import: an empty translation keeps the master text with a warning instead of a FAIL."),
  checks: z
    .object({
      textMustBeIn: z.enum(["frame", "title", "action", "none"]).optional().describe('Translated texts must stay inside this area on every frame (default "frame"). export: the area the max width is measured to.'),
      title: margin.optional().describe("Title-safe margin per side, a fraction of the frame (from the user's spec)."),
      action: margin.optional().describe("Action-safe margin per side, a fraction of the frame (from the user's spec)."),
      overflow: z.boolean().optional().describe("Paragraph text must not overflow its box (default true; After Effects 24.6+)."),
      glyphs: z.boolean().optional().describe("Every character must exist in its font (default true; After Effects 25.1+)."),
      fonts: z.boolean().optional().describe("The fonts must be installed (default true)."),
      sampleEveryFrames: z.number().int().min(1).optional().describe("Layout checks on every Nth frame (default 1)."),
    })
    .strict()
    .optional(),
  csvDelimiter: z.enum([",", ";", "\t"]).optional().describe('CSV field separator (export default ","; import: from the header line).'),
  overwrite: z.boolean().optional().describe("export: replace existing files. import: replace comps already named like a version. Default false: refuse."),
  checkpoint: z.boolean().optional().describe("import: save a project checkpoint first (see ae_checkpoint)."),
  dryRun: z.boolean().optional().describe("Show what would be written / built and every problem; change nothing."),
  timeBudgetSeconds: z.number().min(5).max(600).optional().describe("Layout reading per comp stops after this long (default 60)."),
};

type Fit = z.infer<typeof fitSchema>;
export type Args = {
  action: "export" | "import" | "drift";
  comp?: string | number;
  file: string | string[];
  languages?: string[];
  sourceLanguage?: string;
  maxChars?: number | "fromBox";
  notes?: Record<string, string>;
  includeHidden?: boolean;
  name?: string;
  folder?: string;
  fit?: Fit;
  fitLayers?: (Fit & { layer: string; comp?: string })[];
  fonts?: Record<string, Record<string, string>>;
  direction?: Record<string, "rtl" | "ltr">;
  rtl?: { justification?: "mirror" | "keep"; pointText?: "keepExtent" | "keepAnchor"; composer?: boolean; digits?: string };
  allowUntranslated?: boolean;
  checks?: { textMustBeIn?: "frame" | "title" | "action" | "none"; title?: number | { x: number; y: number }; action?: number | { x: number; y: number }; overflow?: boolean; glyphs?: boolean; fonts?: boolean; sampleEveryFrames?: number };
  csvDelimiter?: "," | ";" | "\t";
  overwrite?: boolean;
  checkpoint?: boolean;
  dryRun?: boolean;
  timeBudgetSeconds?: number;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const parse = <T>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : v) as T;
const q = (s: string, max = 50) => JSON.stringify(toFileText(s.length > max ? s.slice(0, max) + "…" : s));
const r1 = (n: number) => Math.round(n * 10) / 10;

// ---------- the master's strings ----------

/** A string of the master: a unit of the files, and where it is in the project. */
export interface MUnit extends LUnit {
  layer: string;
  L: LLayer;
  /** keyframe index (0: not keyframed) */
  k: number;
  /** the Preflight item of its first visible occurrence (bounds, time on screen) */
  item?: PItem;
  /** comp px per layer px at its first visible sample: horizontally, vertically */
  hs?: number;
  vs?: number;
}

const compPath = (occPath: string) =>
  occPath
    .split(" > ")
    .slice(0, -1)
    .map((s, k) => (k ? s.replace(/^\d+: /, "") : s))
    .join(" > ");
const JUST: Record<string, string> = { LEFT_JUSTIFY: "left", RIGHT_JUSTIFY: "right", CENTER_JUSTIFY: "centred", FULL_JUSTIFY_LASTLINE_LEFT: "justified", FULL_JUSTIFY_LASTLINE_RIGHT: "justified", FULL_JUSTIFY_LASTLINE_CENTER: "justified", FULL_JUSTIFY_LASTLINE_FULL: "justified" };

async function collect(comp: string | number | undefined): Promise<LCollect> {
  const r = await runJsx(COLLECT_JSX, { comp }, { undoGroup: false, timeoutMs: 120_000 });
  if (!r.ok) throw new Error(r.error?.message ?? "the comp could not be read");
  return parse<LCollect>(r.result);
}

/** Preflight's reading of the master: visible frames and bounds of every text layer in the tree. */
async function readLayout(rootId: number, a: Args, glyphs = false, bounds = true): Promise<{ data?: PData; error?: string }> {
  const budget = a.timeBudgetSeconds ?? 60;
  const pa: PArgs = { comp: rootId, step: a.checks?.sampleEveryFrames ?? 1, textAll: true, bounds, patterns: [], glyphs, timeBudgetSeconds: budget };
  try {
    const r = await runJsx(PREFLIGHT_JSX, pa, { undoGroup: false, timeoutMs: budget * 1000 + 60_000 });
    if (!r.ok) return { error: r.error?.message ?? "unknown error" };
    return { data: parse<PData>(r.result) };
  } catch (e: any) {
    return { error: e?.message ?? String(e) };
  }
}

const tbOf = (c: LCollect): TimeBase => ({ fps: c.root.fps, dropFrame: !!c.root.df, offset: c.root.dst ?? 0 });

/** "00:00:01:00–00:00:04:00 (3.00 s)": the runs where a text is seen, in the root comp's timecode. */
function onScreen(items: PItem[], d: PData, tb: TimeBase, text?: string): { label?: string; secs: number } {
  const dt = d.step * d.comp.fd, samples = new Set<number>();
  for (const it of items) {
    const tc = it.tc ?? [];
    it.i.forEach((i, k) => {
      let c = 0;
      while (c + 1 < tc.length && tc[c + 1][0] <= k) c++;
      if (text === undefined || (tc[c] && sameText(tc[c][1], text))) samples.add(i);
    });
  }
  const s = [...samples].sort((a, b) => a - b);
  if (!s.length) return { secs: 0 };
  const runs: [number, number][] = [];
  for (const i of s) {
    const last = runs[runs.length - 1];
    if (last && last[1] === i - 1) last[1] = i;
    else runs.push([i, i]);
  }
  const tcOf = (sec: number) => timecode(sec, tb.fps, tb.dropFrame, tb.offset ?? 0);
  const label = runs
    .slice(0, 3)
    .map(([a, b]) => `${tcOf(a * dt)}–${tcOf((b + 1) * dt)}`)
    .join(", ");
  const secs = s.length * dt;
  return { label: `${label}${runs.length > 3 ? ` +${runs.length - 3} more` : ""} (${(Math.round(secs * 100) / 100).toFixed(2)} s)`, secs };
}

/** Every string of the master tree, with its context; the layout (Preflight) gives time on screen and width. */
export function masterUnits(c: LCollect, d: PData | undefined, a: Pick<Args, "maxChars" | "notes" | "includeHidden" | "checks">): MUnit[] {
  const tb = tbOf(c), out: MUnit[] = [];
  const items = new Map((d?.items ?? []).map((it) => [it.w, it]));
  const area = a.checks?.textMustBeIn && a.checks.textMustBeIn !== "none" ? a.checks.textMustBeIn : "frame";
  const m = area === "frame" ? { x: 0, y: 0 } : a.checks?.[area] === undefined ? null : typeof a.checks[area] === "number" ? { x: a.checks[area] as number, y: a.checks[area] as number } : (a.checks[area] as { x: number; y: number });
  const ab = m ? areaBox(c.root.w, c.root.h, m) : null;
  for (const L of c.layers) {
    if (a.includeHidden === false && (L.off || L.guide)) continue;
    const occ = c.occ.filter((o) => o[1] === L.c && o[2] === L.li);
    const its = occ.map((o) => items.get(o[0])).filter((x): x is PItem => !!x && x.i.length > 0);
    const base = `c${L.c}:${L.lid !== undefined ? `L${L.lid}` : `i${L.li}`}`;
    const path = occ.length ? compPath(occ[0][0]) : L.cn;
    const keys = L.keys ?? [[L.tm, L.text] as [number, string]];
    keys.forEach(([t, text], kk) => {
      const k = L.keys ? kk + 1 : 0;
      const ctx: string[] = [L.box ? "paragraph text" : "point text"];
      if (L.j && JUST[L.j]) ctx.push(`aligned ${JUST[L.j]}`);
      if (L.dir === "DIRECTION_RIGHT_TO_LEFT") ctx.push("right-to-left in the master");
      if (L.keys) ctx.push(`keyframe ${k} of ${L.keys.length}, at ${timecode(t, c.root.fps, !!c.root.df, 0)} in ${L.cn}`);
      if (L.ex) ctx.push("an expression on Source Text may change what is shown");
      if (L.off) ctx.push("layer is off (an expression may read it)");
      if (L.guide) ctx.push("guide layer (not rendered)");
      if (occ.length > 1) ctx.push(`seen ${occ.length} times (one translation for all)`);
      const u: MUnit = { id: k ? `${base}:k${k}` : base, comp: path, layer: L.ln, source: text, L, k, context: ctx.join("; ") };
      if (L.box) u.box = `${L.box[0]} × ${L.box[1]}`;
      if (d) {
        const os = onScreen(its, d, tb, L.keys ? text : undefined);
        u.onScreen = os.label ?? (L.off || L.guide ? undefined : "never visible");
      }
      // the first visible occurrence: its scale on screen and, for point text, the width it has
      const it = its[0];
      if (it?.rect && it.lv && !it.d3) {
        const r = trackAt(it.rect, 0), b = boundsThrough(r, it.lv, 0);
        if (b && r[2] > 0) {
          u.item = it;
          u.hs = (b.x1 - b.x0) / r[2];
          u.vs = verticalScale(it.lv, 0);
          if (!L.box && ab && !L.keys) {
            const j = L.j ?? "LEFT_JUSTIFY", cx = (b.x0 + b.x1) / 2;
            const room = /RIGHT/.test(j) ? b.x1 - ab.x0 : /CENTER/.test(j) ? 2 * Math.min(cx - ab.x0, ab.x1 - cx) : ab.x1 - b.x0;
            u.maxWidth = Math.max(0, Math.floor(room));
          }
        }
      }
      // a character limit: the user's, or estimated from the master's average character width
      if (typeof a.maxChars === "number") u.maxChars = a.maxChars;
      else if (a.maxChars === "fromBox" && L.rect && L.rect[2] > 0) {
        const lines = text.split(/\r|\u0003/), longest = Math.max(1, ...lines.map((s) => Array.from(s).length)), adv = L.rect[2] / longest;
        if (L.box && L.fs) u.maxChars = Math.max(1, Math.floor(L.box[0] / adv) * Math.max(1, Math.floor(L.box[1] / (L.fs * 1.2))));
        else if (u.maxWidth !== undefined && u.hs) u.maxChars = Math.max(1, Math.floor(u.maxWidth / (adv * u.hs))) * lines.length;
        if (u.maxChars !== undefined) u.context += `; max chars estimated from the master's average character width${L.box ? " and the box" : ""}`;
      }
      const note = a.notes?.[u.id] ?? a.notes?.[L.ln];
      if (note) u.notes = note;
      out.push(u);
    });
  }
  return out;
}

/** Each unit of the file -> the master's string: by id, else by comp path and layer name when that is unique. */
export function matchUnits(file: LFile, master: MUnit[]) {
  const byId = new Map(master.map((u) => [u.id, u]));
  const byName = new Map<string, MUnit[]>();
  for (const u of master) {
    const key = `${u.comp} > ${u.layer}${u.k ? `:k${u.k}` : ""}`;
    byName.set(key, [...(byName.get(key) ?? []), u]);
  }
  const out = new Map<string, MUnit | undefined>(), how = new Map<string, "id" | "name">();
  for (const f of file.units) {
    let m = byId.get(f.id);
    // an id from another copy of the project can name another layer here: then the names decide, when they can
    if (m && f.layer !== undefined && f.layer !== m.layer && !sameText(f.source, m.source)) {
      const k = /:k(\d+)$/.exec(f.id)?.[1];
      const list = byName.get(`${f.comp} > ${f.layer}${k ? `:k${k}` : ""}`);
      if (list?.length === 1) m = undefined;
    }
    if (m) how.set(f.id, "id");
    else if (f.comp !== undefined && f.layer !== undefined) {
      const k = /:k(\d+)$/.exec(f.id)?.[1];
      const list = byName.get(`${f.comp} > ${f.layer}${k ? `:k${k}` : ""}`);
      if (list?.length === 1) {
        m = list[0];
        how.set(f.id, "name");
      }
    }
    out.set(f.id, m);
  }
  return { map: out, how };
}

// ---------- export ----------

async function runExport(a: Args): Promise<CallToolResult> {
  const pattern = Array.isArray(a.file) ? a.file[0] : a.file;
  if (Array.isArray(a.file) && a.file.length > 1) return errorResult('export writes one file (or one per language with {lang} in the name): give file as one path');
  const ext = extname(pattern).toLowerCase(), xliff = ext === ".xlf" || ext === ".xliff";
  if (!xliff && ext !== ".csv" && ext !== ".tsv") return errorResult(`file: give a .csv or an .xlf path (got ${basename(pattern)})`);
  const langs = a.languages ?? [];
  const problems: string[] = [];
  // writing a new file doesn't change the project; replacing one is an edit read-only mode doesn't make
  if (a.overwrite && !a.dryRun && permissions().mode === "read-only") return errorResult(READ_ONLY_REFUSAL);
  if (!langs.length) problems.push("languages: the target languages to translate into, e.g. [\"he\", \"ar\"]");
  if (xliff && !a.sourceLanguage) problems.push("sourceLanguage: the master's language (XLIFF needs it), e.g. \"en\"");
  if (xliff && langs.length > 1 && !pattern.includes("{lang}")) problems.push('XLIFF holds one target language per file: put {lang} in the file name, e.g. "main_{lang}.xlf"');
  const targets = xliff ? langs.map((l) => ({ lang: l, path: resolve(langPath(pattern, l)) })) : [{ lang: langs.join(", "), path: resolve(pattern) }];
  if (!a.overwrite) for (const t of targets) if (existsSync(t.path)) problems.push(`a file already exists at ${t.path}. To replace it, pass overwrite: true (or change file)`);
  if ((a.checks?.textMustBeIn === "title" || a.checks?.textMustBeIn === "action") && a.checks[a.checks.textMustBeIn] === undefined)
    problems.push(`checks.textMustBeIn "${a.checks.textMustBeIn}" needs checks.${a.checks.textMustBeIn}: the margin from the user's spec`);
  if (problems.length && !a.dryRun) return errorResult(`Nothing was written:\n- ${problems.join("\n- ")}`);

  const c = await collect(a.comp);
  const lay = await readLayout(c.root.id, a);
  const units = masterUnits(c, lay.data, a);
  const head: string[] = [];
  if (a.dryRun) head.push(problems.length ? `Dry run: ${plural(problems.length, "problem")}; nothing was written.` : "Dry run: nothing was written.");
  else {
    for (const t of targets) {
      const text = xliff ? writeXliff(units, { sourceLanguage: a.sourceLanguage!, targetLanguage: t.lang, root: c.root.name, toolVersion: VERSION }) : writeCsv(units, langs, a.csvDelimiter ?? (ext === ".tsv" ? "\t" : ","));
      if (a.overwrite) writeFileAtomic(t.path, text);
      else writeFileSync(t.path, text, { encoding: "utf8", flag: "wx" });
    }
    head.push(`Exported ${plural(units.length, "string")} of "${c.root.name}" (${plural(c.comps.length, "comp")}) for ${langs.join(", ")}`);
  }
  if (a.dryRun) head.push(`${plural(units.length, "string")} of "${c.root.name}" (${plural(c.comps.length, "comp")}) would be written for ${langs.join(", ") || "(no languages)"}`);
  for (const t of targets) head.push(`  ${t.path} (${xliff ? `XLIFF 1.2, ${t.lang}` : `CSV, UTF-8 with BOM, a column per language: ${langs.join(", ")}`})`);
  if (problems.length) head.push("", "problems", ...problems.map((p) => `  - ${p}`));
  const lines = units.slice(0, 40).map((u) => {
    const extra = [u.onScreen && `on screen ${u.onScreen}`, u.box && `box ${u.box} px`, u.maxWidth !== undefined && `max width ${u.maxWidth} px`, u.maxChars !== undefined && `max ${u.maxChars} chars`].filter(Boolean).join(" · ");
    return `  ${u.id}  ${u.comp} > ${u.layer}: ${q(u.source)}${extra ? `  ${extra}` : ""}`;
  });
  const notes: string[] = [];
  if (lay.error) notes.push(`time on screen and widths could not be read: ${lay.error}`);
  if (lay.data?.partial) notes.push(`time on screen read only partly: ${lay.data.partial.reason}`);
  if (units.some((u) => /^[=+\-@]/.test(u.source)) && !xliff) notes.push("some texts start with = + - or @: Excel may read them as formulas (import the CSV with Data > From Text and set the columns to Text, or use XLIFF)");
  if (units.some((u) => u.L.ex)) notes.push("texts with an expression on Source Text: what is shown may not be the text in the file");
  if (!units.length) notes.push(`no text layers in "${c.root.name}" or its precomps`);
  const out = [...head, "", `strings${units.length > 40 ? ` (first 40 of ${units.length})` : ""}`, ...lines];
  if (notes.length) out.push("", "notes", ...notes.map((n) => `  - ${n}`));
  if (!a.dryRun) out.push("", `After translation: ae_localize {action: "import", file: ...} builds a version per language; {action: "drift"} lists master texts changed since now.`);
  return { content: [{ type: "text", text: capText(out.join("\n")) }] };
}

// ---------- drift ----------

const files = (f: string | string[]) => (Array.isArray(f) ? f : [f]);

async function rootFor(a: Args, file: LFile): Promise<LCollect> {
  if (a.comp !== undefined) return collect(a.comp);
  if (file.root) {
    try {
      return await collect(file.root);
    } catch {}
  }
  return collect(undefined);
}

async function runDrift(a: Args): Promise<CallToolResult> {
  const file = readTranslations(files(a.file), a.csvDelimiter);
  const c = await rootFor(a, file);
  const master = masterUnits(c, undefined, { includeHidden: true });
  const { map } = matchUnits(file, master);
  const langs = a.languages ?? file.languages;
  const changed = file.units.filter((f) => map.get(f.id) && !sameText(map.get(f.id)!.source, f.source));
  const removed = file.units.filter((f) => !map.get(f.id));
  const known = new Set([...map.values()].filter(Boolean).map((m) => m!.id));
  const added = master.filter((m) => !known.has(m.id));
  const n = file.units.length;
  const out = [changed.length ? `DRIFT (${changed.length} of ${plural(n, "string")} changed since export)` : `NO DRIFT (${plural(n, "string")} unchanged since export)`];
  out.push(`"${c.root.name}" against ${file.path.split(", ").map((p) => basename(p)).join(", ")}${removed.length ? `; ${removed.length} no longer in the comp tree` : ""}${added.length ? `; ${added.length} new since export` : ""}`);
  for (const l of langs) {
    const hit = changed.filter((f) => f.targets[l] !== undefined);
    out.push("", `${l}: ${hit.length ? `${plural(hit.length, "translated string")} changed in the master since translation` : "no translated string changed"}`);
    for (const f of hit.slice(0, 40)) out.push(`  ${f.id}  ${map.get(f.id)!.comp} > ${map.get(f.id)!.layer}: was ${q(f.source)}, now ${q(map.get(f.id)!.source)}; translation ${q(f.targets[l])}`);
    if (hit.length > 40) out.push(`  ... ${hit.length - 40} more`);
  }
  const untranslated = changed.filter((f) => !langs.some((l) => f.targets[l] !== undefined));
  if (untranslated.length) out.push("", `changed, not translated yet in any of ${langs.join(", ") || "the languages"}: ${untranslated.map((f) => f.id).slice(0, 20).join(", ")}`);
  if (removed.length) out.push("", "in the file, not in the comp tree any more", ...removed.slice(0, 20).map((f) => `  ${f.id}${f.comp ? `  ${f.comp} > ${f.layer}` : ""}: ${q(f.source)}`));
  if (added.length) out.push("", "new in the comp tree since export (not in the file)", ...added.slice(0, 20).map((m) => `  ${m.id}  ${m.comp} > ${m.layer}: ${q(m.source)}`));
  if (file.notes.length) out.push("", "notes", ...file.notes.slice(0, 10).map((x) => `  - ${x}`));
  return { content: [{ type: "text", text: capText(out.join("\n")) }] };
}

// ---------- import ----------

const NAMES_JSX = `
var P = app.project, want = {}, out = [];
for (var n = 0; n < args.names.length; n++) want["n:" + args.names[n]] = true;
for (var k = 1; k <= P.numItems; k++) { var it = P.item(k); if (want["n:" + it.name] && !(it instanceof FolderItem)) out.push([it.id, it.name, it instanceof CompItem ? 1 : 0]); }
return out;`;

const fill = (p: string, v: Record<string, string>) => p.replace(/\{(comp|lang|root)\}/g, (_, k) => v[k] ?? "");

/** The rule for one string: the per-layer one, else the general one. */
function ruleFor(a: Args, u: MUnit): Fit | undefined {
  const own = a.fitLayers?.find((r) => r.layer === u.layer && (r.comp === undefined || r.comp === u.L.cn));
  return own ?? a.fit;
}

function stepProblems(f: Fit | undefined, where: string): string[] {
  const out: string[] = [];
  (f?.steps ?? []).forEach((s, k) => {
    const at = `${where}.steps[${k}] (${s.adjust})`;
    if (s.adjust === "boxWidth" || s.adjust === "boxHeight") {
      if (s.maxGrow === undefined) out.push(`${at}: needs maxGrow, the most the box may grow (px)`);
      if (s.min !== undefined) out.push(`${at}: min applies to tracking, fontSize, capHeight and horizontalScale`);
    } else {
      if (s.min === undefined) out.push(`${at}: needs min, the user's minimum`);
      if (s.maxGrow !== undefined) out.push(`${at}: maxGrow applies to boxWidth and boxHeight`);
      if ((s.adjust === "fontSize" || s.adjust === "capHeight" || s.adjust === "horizontalScale") && s.min !== undefined && s.min <= 0) out.push(`${at}: min must be above 0`);
    }
  });
  if (f?.maxWidth !== undefined && f.maxWidthOfSource !== undefined) out.push(`${where}: give maxWidth or maxWidthOfSource, not both`);
  return out;
}

interface LangPlan {
  lang: string;
  rtl: boolean;
  jl: JLang;
  /** master unit per JUnit */
  mu: MUnit[];
  findings: Finding[];
  notes: string[];
  untranslated: number;
}

async function planImport(a: Args) {
  const problems: string[] = [];
  const file = readTranslations(files(a.file), a.csvDelimiter);
  const c = await rootFor(a, file);
  const lay = await readLayout(c.root.id, a);
  const master = masterUnits(c, lay.data, { includeHidden: true, checks: a.checks });
  const { map, how } = matchUnits(file, master);
  const langs = a.languages ?? file.languages.filter((l) => file.units.some((u) => u.targets[l] !== undefined));
  for (const l of a.languages ?? []) if (!file.languages.includes(l)) problems.push(`the file has no language "${l}" (it has: ${file.languages.join(", ") || "none"})`);
  if (!langs.length) problems.push(`no translations in ${file.path}: fill a language column (CSV) or the <target> elements (XLIFF)`);
  problems.push(...stepProblems(a.fit, "fit"));
  (a.fitLayers ?? []).forEach((f, k) => problems.push(...stepProblems(f, `fitLayers[${k}]`)));
  if ((a.checks?.textMustBeIn === "title" || a.checks?.textMustBeIn === "action") && a.checks[a.checks.textMustBeIn] === undefined)
    problems.push(`checks.textMustBeIn "${a.checks.textMustBeIn}" needs checks.${a.checks.textMustBeIn}: the margin from the user's spec`);
  for (const l of Object.keys(a.fonts ?? {})) if (!langs.includes(l)) problems.push(`fonts names "${l}", which is not a language being built (${langs.join(", ")})`);

  const fileOf = new Map<string, LFile["units"][number]>();
  for (const f of file.units) {
    const m = map.get(f.id);
    if (m) fileOf.set(m.id, f);
  }
  const removed = file.units.filter((f) => !map.get(f.id));
  const byName = [...how.values()].filter((h) => h === "name").length;

  // the comps to duplicate: every comp holding a translated text, and every comp on the way to it from the root
  const parents = new Map<number, Set<number>>();
  for (const [p, , ch] of c.edges) parents.set(ch, new Set([...(parents.get(ch) ?? []), p]));
  const plans: LangPlan[] = [];
  for (const l of langs) {
    const rtl = a.direction?.[l] ? a.direction[l] === "rtl" : isRtl(l);
    const findings: Finding[] = [], notes: string[] = [], units: JUnit[] = [], mu: MUnit[] = [];
    let untranslated = 0;
    const fontMap = a.fonts?.[l];
    for (const m of master) {
      const f = fileOf.get(m.id), where = `${m.comp} > ${m.layer}${m.k ? ` (keyframe ${m.k})` : ""}`;
      const t = f?.targets[l];
      if (t === undefined) {
        untranslated++;
        if (m.L.off || m.L.guide) continue;
        const why = f ? "not translated" : "new since the export: not in the file";
        findings.push({ check: "translation", severity: a.allowUntranslated ? "warn" : "fail", where, message: `${why}; shows the master text ${q(m.source)}`, fix: "translate it (or allowUntranslated: true)" });
        continue;
      }
      if (f && !sameText(f.source, m.source)) findings.push({ check: "drift", severity: "warn", where, message: `the master text changed since export: translated from ${q(f.source)}, the master now says ${q(m.source)}`, fix: "re-export and have it translated again" });
      const st = f?.state?.[l];
      if (st && /^needs-|^new$|initial/.test(st)) notes.push(`${where}: the translation's state is "${st}"`);
      const rule = ruleFor(a, m);
      const steps: JStep[] = (rule?.steps ?? []).map((s) => ({ adjust: s.adjust, v: (s.adjust === "boxWidth" || s.adjust === "boxHeight" ? s.maxGrow : s.min)! }));
      let lim: number | undefined;
      if (!m.L.box && rule?.maxWidth !== undefined) {
        if (m.hs) lim = rule.maxWidth / m.hs;
        else notes.push(`${where}: maxWidth not applied (the master layer is never visible, so its scale on screen is unknown)`);
      }
      if (!m.L.box && rule?.maxWidthOfSource !== undefined) {
        if (m.L.rect) lim = m.L.rect[2] * rule.maxWidthOfSource;
        else notes.push(`${where}: maxWidthOfSource not applied (keyframed text: the master's width is per keyframe)`);
      }
      const font = fontMap ? (fontMap[m.L.f ?? ""] ?? fontMap["*"]) : undefined;
      units.push({ c: m.L.c, li: m.L.li, k: m.k, text: t, font, rtl: rtl ? 1 : 0, steps, lim, cs: m.vs });
      mu.push(m);
    }
    // comps to duplicate: up from each comp holding a translated text to the root
    const need = new Set<number>([c.root.id]);
    const stack = units.map((u) => u.c);
    while (stack.length) {
      const id = stack.pop()!;
      if (need.has(id) && id !== c.root.id) continue;
      need.add(id);
      for (const p of parents.get(id) ?? []) stack.push(p);
    }
    const dup = [c.root.id, ...c.comps.map((x) => x.id).filter((id) => id !== c.root.id && need.has(id))];
    const names: Record<string, string> = {};
    for (const id of dup) names[String(id)] = fill(a.name ?? "{comp} [{lang}]", { comp: c.comps.find((x) => x.id === id)!.name, lang: l, root: c.root.name });
    const folder = fill(a.folder ?? "{root} - {lang}", { root: c.root.name, lang: l, comp: c.root.name });
    plans.push({ lang: l, rtl, jl: { lang: l, folder, names, dup, units }, mu, findings, notes, untranslated });
  }
  // names: unique, and not already in the project unless overwrite
  const all = plans.flatMap((p) => Object.values(p.jl.names));
  const dupName = all.find((n, k) => all.indexOf(n) !== k);
  if (dupName) problems.push(`two copies would be named "${dupName}": put {comp} and {lang} in name`);
  let remove: number[] = [];
  if (all.length) {
    const r = await runJsx(NAMES_JSX, { names: all }, { undoGroup: false, timeoutMs: 60_000 });
    if (r.ok) {
      const taken = parse<[number, string, number][]>(r.result);
      if (taken.length && !a.overwrite)
        problems.push(`already in the project: ${taken.slice(0, 5).map((t) => `"${t[1]}"`).join(", ")}${taken.length > 5 ? ` and ${taken.length - 5} more` : ""} (undo an earlier import with ae_undo, change name, or pass overwrite: true to replace them)`);
      const notComps = taken.filter((t) => !t[2]);
      if (a.overwrite && notComps.length) problems.push(`not comps, so not replaced: ${notComps.map((t) => `"${t[1]}"`).join(", ")} (change name)`);
      if (a.overwrite) remove = taken.filter((t) => t[2]).map((t) => t[0]);
    }
  }
  return { problems, file, c, lay, master, plans, removed, byName, remove };
}

/** What a language will get, for the dry run. */
function planLines(p: LangPlan, c: LCollect): string[] {
  const out = [`${p.lang}${p.rtl ? " (right to left)" : ""}: ${plural(p.jl.units.length, "string")} translated${p.untranslated ? `, ${p.untranslated} not` : ""}; copies: ${p.jl.dup.map((id) => `"${p.jl.names[String(id)]}"`).join(", ")} in folder "${p.jl.folder}"`];
  for (const [k, u] of p.jl.units.slice(0, 12).entries()) {
    const m = p.mu[k];
    const extra = [u.font && `font ${m.L.f} -> ${u.font}`, u.steps.length && `fit: ${u.steps.map((s) => `${s.adjust} ${s.adjust.startsWith("box") ? `+${s.v} px` : `>= ${s.v}`}`).join(", ")}`, u.lim !== undefined && `max ${Math.round(u.lim * (m.hs ?? 1))} px wide`].filter(Boolean).join("; ");
    out.push(`    ${m.comp} > ${m.layer}: ${q(m.source, 30)} -> ${q(u.text, 40)}${extra ? `  (${extra})` : ""}`);
  }
  if (p.jl.units.length > 12) out.push(`    ... ${p.jl.units.length - 12} more`);
  for (const f of p.findings.slice(0, 10)) out.push(`    ${f.severity === "fail" ? "FAIL" : "warning"}: ${f.where}: ${f.message}`);
  if (p.findings.length > 10) out.push(`    ... ${p.findings.length - 10} more`);
  void c;
  return out;
}

const ARROW = (a: number, b: number) => `${r1(a)} -> ${r1(b)}`;

async function runImport(a: Args): Promise<CallToolResult> {
  const perm = permissions();
  if (!a.dryRun && perm.mode === "read-only") return errorResult(READ_ONLY_REFUSAL);
  const p = await planImport(a);
  const { c, plans, file } = p;
  const tb = tbOf(c);
  const src = file.path.split(", ").map((x) => basename(x)).join(", ");
  const headNotes: string[] = [...file.notes];
  if (p.byName) headNotes.push(`${plural(p.byName, "string")} matched by comp and layer name (their ids are not in this project)`);
  if (p.removed.length) headNotes.push(`${plural(p.removed.length, "string")} of the file are not in "${c.root.name}" any more: ${p.removed.slice(0, 5).map((f) => f.id).join(", ")}${p.removed.length > 5 ? " ..." : ""}`);
  if (p.lay.error) headNotes.push(`the master's layout could not be read (${p.lay.error}): maxWidth and capHeight rules can't be converted`);

  if (a.dryRun) {
    const out = [p.problems.length ? `Dry run: ${plural(p.problems.length, "problem")}; nothing was changed.` : "Dry run: the file fits the comp tree; nothing was changed."];
    out.push(`${plural(plans.length, "language")} of "${c.root.name}" from ${src}: ${plans.map((x) => x.lang).join(", ")}`);
    if (p.problems.length) out.push("", "problems", ...p.problems.map((s) => `  - ${s}`));
    out.push("", "languages", ...plans.flatMap((x) => planLines(x, c).map((l) => `  ${l}`)));
    out.push("", "Fitting is tried only when built (it measures the text in After Effects).");
    if (headNotes.length) out.push("", "notes", ...headNotes.map((n) => `  - ${n}`));
    return { content: [{ type: "text", text: capText(out.join("\n")) }] };
  }
  if (p.problems.length) return errorResult(`Nothing was built:\n- ${p.problems.join("\n- ")}\n(dryRun: true shows what each language would get.)`);

  let cp = "";
  if (a.checkpoint) {
    const k = await saveCheckpoint("before-localize");
    cp = `Checkpoint saved first: ${k.file}\n${k.note ? `${k.note}\n` : ""}`;
  }
  const showReport = loadConfig().changeReport !== false;
  const args: BuildArgs = {
    root: c.root.id,
    langs: plans.map((x) => x.jl),
    rtl: { justification: a.rtl?.justification ?? "mirror", pointText: a.rtl?.pointText ?? "keepExtent", composer: a.rtl?.composer !== false, digits: a.rtl?.digits },
    remove: p.remove,
  };
  const units = plans.reduce((n, x) => n + x.jl.units.length, 0);
  const b = await runJsx(BUILD_JSX, args, {
    undoGroup: "Localize: import",
    timeoutMs: 120_000 + units * 5_000,
    report: reportScope({ comp: c.root.id }) ?? [c.root.id],
    rollback: "requested",
    bridge:
      perm.mode === "ask"
        ? {
            approval: {
              tool: "Localize",
              summary:
                `Build ${plural(plans.length, "language version")} of "${c.root.name}" from ${src}${p.remove.length ? `, replacing ${plural(p.remove.length, "comp")} with the same names` : ""}:\n` +
                plans.map((x) => `${x.lang}: ${Object.values(x.jl.names).join(", ")} (${plural(x.jl.units.length, "text")})`).join("\n"),
            },
          }
        : undefined,
  });
  if (!b.ok) return formatResult(b);
  const built = parse<BBuilt>(b.result);
  const changes = showReport ? formatChanges(b.changes) : null;
  if (built.fatal) {
    const rb = b.rollback ?? { undone: false, verified: false, problem: "no result" };
    const undo = !rb.verified ? rollbackProblem(rb, "the import") : rb.undone ? "It was rolled back: nothing was built." : "It hadn't changed anything yet.";
    return { isError: true, content: [{ type: "text", text: `${cp}The import stopped: ${built.fatal}\n${undo}${!rb.verified && changes && changes !== "Changes: none" ? `\n\n${changes}` : ""}` }] };
  }

  // the checks of every language: what was set, the fit, the direction, then Preflight's layout and X-ray's fonts
  const ch = {
    overflow: a.checks?.overflow !== false,
    textMustBeIn: a.checks?.textMustBeIn ?? "frame",
    glyphs: a.checks?.glyphs !== false,
    fonts: a.checks?.fonts !== false,
  };
  let fonts: { x?: XData; error?: string } | undefined;
  if (ch.fonts) {
    try {
      const xr = await runJsx(XRAY_JSX, { sections: ["missing"], comps: built.langs.flatMap((l) => l.comps.map((x) => x[1])), timeBudgetSeconds: 90 }, { undoGroup: false, timeoutMs: 300_000 });
      fonts = xr.ok ? { x: parse<XData>(xr.result) } : { error: xr.error?.message };
    } catch (e: any) {
      fonts = { error: e?.message ?? String(e) };
    }
  }
  const results: { lang: string; name: string; rtl: boolean; findings: Finding[]; notRun: NotRun[]; notes: string[]; fitted: string[]; verdict: string }[] = [];
  for (const bl of built.langs) {
    const plan = plans.find((x) => x.lang === bl.lang)!;
    const r = await checkLanguage(bl, plan, a, ch, fonts);
    results.push({ lang: bl.lang, name: bl.rootName, rtl: plan.rtl, ...r, verdict: verdict(r.findings, r.notRun) });
  }

  const checked = ["texts read back", "fit by your rules", plans.some((x) => x.rtl) && "right-to-left direction", ch.overflow && "box overflow", ch.textMustBeIn !== "none" && `text inside ${ch.textMustBeIn === "frame" ? "the frame" : `${ch.textMustBeIn}-safe`} on every frame`, ch.glyphs && "glyphs", ch.fonts && "fonts"].filter(Boolean);
  const out = [
    runVerdict(results, "language"),
    `${plural(results.length, "language")} of "${c.root.name}" from ${src}: ${results.map((r) => `${r.lang} -> "${r.name}"`).join(", ")}`,
    `checked per language: ${checked.join(", ")}`,
    totalsLine(results, "language"),
    "",
    "languages",
  ];
  for (const r of results) {
    const head = `  ${r.lang.padEnd(6)} ${r.verdict.padEnd(11)} ${r.name}${r.rtl ? " (RTL)" : ""}`;
    if (r.verdict === "PASS") {
      out.push(head);
      continue;
    }
    const list = [...r.findings.filter((f) => f.severity === "fail"), ...r.findings.filter((f) => f.severity === "warn")].map((f) => findingText(f, tb));
    if (r.notRun.length) list.push(`not checked: ${notRunLines(r.notRun).join("; ")}`);
    out.push(`${head}:`, ...list.slice(0, 12).map((s) => `      - ${s}`), ...(list.length > 12 ? [`      - ... ${list.length - 12} more`] : []));
  }
  const fitted = results.flatMap((r) => r.fitted.map((f) => `  ${r.lang.padEnd(6)} ${f}`));
  if (fitted.length) out.push("", "adjusted within your rules", ...fitted.slice(0, 40), ...(fitted.length > 40 ? [`  ... ${fitted.length - 40} more`] : []));
  const notes = [...new Set([...headNotes, ...results.flatMap((r) => r.notes)])];
  if (notes.length) out.push("", "notes", ...notes.slice(0, 15).map((n) => `  - ${n}`), ...(notes.length > 15 ? [`  - ... ${notes.length - 15} more`] : []));
  out.push("", "One ae_undo removes every language version.");
  if (cp) out.push(cp.trimEnd());
  return { content: [{ type: "text", text: capText(out.join("\n")) + (changes ? `\n\n${capText(changes)}` : "") }] };
}

async function checkLanguage(bl: BLang, plan: LangPlan, a: Args, ch: { overflow: boolean; textMustBeIn: string; glyphs: boolean; fonts: boolean }, fonts?: { x?: XData; error?: string }) {
  const findings: Finding[] = [...plan.findings], notRun: NotRun[] = [], notes: string[] = [...plan.notes], fitted: string[] = [];
  for (const b of bl.units) {
    const u = plan.jl.units[b.i], m = plan.mu[b.i], where = `${m.comp} > ${m.layer}${m.k ? ` (keyframe ${m.k})` : ""}`;
    if (b.err) {
      findings.push({ check: "set", severity: "fail", where, message: `could not be set: ${b.err}` });
      continue;
    }
    if (b.rb !== undefined && !sameText(b.rb, u.text))
      findings.push({ check: "text.format", severity: "fail", where, message: `shows ${q(b.rb)}; the translation is ${q(u.text)}${m.L.ex ? " (an expression on Source Text changes it)" : ""}` });
    if (u.font && b.f !== undefined && b.f !== u.font) findings.push({ check: "font", severity: "fail", where, message: `font is ${b.f}; the font map gives ${u.font} (is it installed?)` });
    if (plan.rtl) {
      if (b.noDir) findings.push({ check: "rtl", severity: "fail", where, message: "the paragraph direction can't be set from scripts in this After Effects (needs 24.0+)", fix: "Paragraph panel: Right-to-Left Text Direction" });
      else if (b.dir && b.dir !== "DIRECTION_RIGHT_TO_LEFT") findings.push({ check: "rtl", severity: "fail", where, message: `paragraph direction is ${b.dir} after setting it to right to left` });
      if (b.noCe) findings.push({ check: "rtl", severity: "warn", where, message: "the composer can't be read or set from scripts in this After Effects (needs 24.0+)", fix: "Preferences > Type: South Asian and Middle Eastern text engine" });
      else if (b.ceErr) findings.push({ check: "rtl", severity: "fail", where, message: `the Universal composer could not be set: ${b.ceErr}` });
    }
    if (b.anc !== undefined) notes.push(`${where}: alignment flipped, anchor point moved ${b.anc} px so the text stays where the master's was`);
    if (b.ancNote) findings.push({ check: "rtl", severity: "warn", where, message: b.ancNote, fix: "check its position with ae_render_frame" });
    const changes: string[] = [];
    if (b.fs[0] !== b.fs[1]) changes.push(`font size ${ARROW(b.fs[0], b.fs[1])}`);
    if (b.tr[0] !== b.tr[1]) changes.push(`tracking ${ARROW(b.tr[0], b.tr[1])}`);
    if (b.hs[0] !== b.hs[1]) {
      const f = b.hs[0] > 10 ? 1 : 100;
      changes.push(`horizontal scale ${ARROW(b.hs[0] * f, b.hs[1] * f)}%`);
    }
    if (b.box && (b.box[0][0] !== b.box[1][0] || b.box[0][1] !== b.box[1][1])) changes.push(`box ${b.box[0].join(" × ")} -> ${b.box[1].join(" × ")} px`);
    if (b.fit.need && b.fit.ok) fitted.push(`${where}: ${changes.join(", ") || b.fit.done.join(", ")}`);
    if (b.fit.need && !b.fit.ok) {
      const what = m.L.box ? "overflows its box" : `is ${b.fit.w !== undefined ? r1(b.fit.w) : "?"} px wide in the layer; the limit is ${r1(u.lim ?? 0)}`;
      findings.push({
        check: "fit",
        severity: "fail",
        where,
        message: `${what}: ${b.fit.why}${b.fit.done.length ? ` (tried: ${b.fit.done.join(", ")})` : ""}`,
        fix: u.steps.length ? "allow more (a lower minimum, more box growth), shorten the translation, or change the design" : "give fit rules (fit.steps), shorten the translation, or change the design",
      });
    }
    if (b.fit.approx) notes.push("box overflow judged from the text's bounds (this After Effects has no boxOverflow: 24.6+)");
  }

  // Preflight's layout checks on the version's translated texts
  const want = new Set(bl.occ.map((o) => o[0]));
  const layoutChecks = [ch.overflow, ch.textMustBeIn !== "none", ch.glyphs].some(Boolean);
  if (layoutChecks && want.size) {
    const lay = await readLayout(bl.root, a, ch.glyphs, ch.textMustBeIn !== "none");
    if (!lay.data) {
      const why = `the layout could not be read: ${lay.error ?? "unknown error"}`;
      for (const c of [ch.overflow && "text.overflow", ch.textMustBeIn !== "none" && "text inside the area", ch.glyphs && "text.glyphs"].filter(Boolean) as string[]) notRun.push({ check: c, reason: why });
    } else {
      const spec: Spec = {
        safeAreas: ch.textMustBeIn !== "none" ? { textMustBeIn: ch.textMustBeIn as "frame" | "title" | "action", ...(a.checks?.title !== undefined ? { title: a.checks.title } : {}), ...(a.checks?.action !== undefined ? { action: a.checks.action } : {}) } : undefined,
        text: { noOverflow: ch.overflow, glyphs: ch.glyphs },
      };
      const r = checkItems(spec, { ...lay.data, items: lay.data.items.filter((it) => it.t && want.has(it.w)) });
      // a text that couldn't fit by the rules already FAILs with the reason; its overflow isn't counted twice
      const unfit = new Set(bl.units.filter((b) => b.fit.need && !b.fit.ok && plan.mu[b.i].L.box).map((b) => `${plan.mu[b.i].L.c}:${plan.mu[b.i].L.li}`));
      const masterOf = new Map(bl.comps.map(([mc, vc]) => [vc, mc]));
      const occKey = new Map(bl.occ.map((o) => [o[0], `${masterOf.get(o[1])}:${o[2]}`]));
      findings.push(...r.findings.filter((f) => !(f.check === "text.overflow" && unfit.has(occKey.get(f.where ?? "") ?? ""))).map((f) => ({ ...f, where: f.where ? pretty(f.where) : f.where })));
      notRun.push(...r.notRun);
      notes.push(...r.notes);
    }
  }
  // missing fonts of the translated layers (Project X-ray's list)
  if (ch.fonts && bl.units.length) {
    if (!fonts?.x) notRun.push({ check: "fonts", reason: `the fonts could not be read: ${fonts?.error ?? "unknown error"}` });
    else {
      const keep = new Set(bl.occ.map((o) => `${o[1]}:${o[2]}`));
      const comps = fonts.x.comps.filter((c) => bl.comps.some((x) => x[1] === c.id)).map((c) => ({ ...c, layers: (c.layers ?? []).filter((l) => keep.has(`${c.id}:${l.i}`)) }));
      const r = checkFromXray({ project: { noMissingFonts: true } }, { ...fonts.x, comps, partial: undefined });
      findings.push(...r.findings);
      notRun.push(...r.notRun.map((n) => ({ ...n, check: "fonts" })));
    }
  }
  return { findings, notRun, notes, fitted };
}

/** "Main [he] > 3: Lower third [he] > 1: Name" -> "Main [he] > Lower third [he] > Name" */
const pretty = (w: string) => w.split(" > ").map((s, k) => (k ? s.replace(/^\d+: /, "") : s)).join(" > ");

export async function runLocalize(a: Args): Promise<CallToolResult> {
  if (a.action === "export") return runExport(a);
  if (a.action === "drift") return runDrift(a);
  return runImport(a);
}

export function registerLocalizeTools(server: McpServer) {
  server.registerTool(
    "ae_localize",
    {
      title: "Localize",
      description:
        "The localization round trip. export: every text of a comp tree (precomps too) to a CSV for Excel (UTF-8, a column per language) or " +
        "XLIFF 1.2 for CAT tools, with context: comp, layer, time on screen, box or the width it has, a character limit, notes. import: the " +
        "translated file becomes one version per language (the comp tree duplicated, texts set; Hebrew, Arabic and other right-to-left " +
        "languages get right-to-left direction, the Universal composer and mirrored alignment), each text fitted by the user's own rules in " +
        "their order (tracking, font size or cap height, horizontal scale, box growth, each within its limit; never past it: a text that " +
        "can't fit is left at the best attempt and FAILs with the reason), then each language checked like Preflight (overflow, frame or " +
        "safe area, missing glyphs and fonts). One undo step with the Changes list. drift: which master texts changed since the export, " +
        "per language. dryRun: true changes nothing; files and comps are never replaced without overwrite: true.",
      inputSchema,
      // import builds comps (one undo step); export writes files (overwrite: true replaces them)
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args: Args) => {
      try {
        return await runLocalize(args);
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
