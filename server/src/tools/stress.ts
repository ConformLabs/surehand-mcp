// ae_stress_test: pushes worst-case inputs through every variable a comp exposes (its Essential Graphics controllers,
// its data-driven text, or the layers the user names) and measures each result: box overflow and by how much, safe
// areas over time, the size text renders at, missing glyphs and substituted fonts, direction and composer, lines and
// breaks inside a word, overlap with named layers, how a number shows; plus the expressions that break in After
// Effects in another language. Measured on a scratch copy of the comp, removed in the same call; the user's comp is
// read back before and after and must be identical. Variants: src/stress/cases.ts; ExtendScript: src/stress/jsx.ts;
// checks: src/stress/measure.ts; the report: src/stress/report.ts.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { z } from "zod";
import { runJsx } from "../jsx.js";
import { approvalSummary, permissions } from "../permissions.js";
import { appFile } from "../paths.js";
import type { PArgs, PData } from "../preflight/project.js";
import { wildcard } from "../preflight/project.js";
import { loadTable, pickRows, type NumberFormat } from "../versions/data.js";
import { pickFrames, planVariants, type Cell, type Target, type Variant } from "../stress/cases.js";
import { languageRisks } from "../stress/expr-lang.js";
import { MAX_RUNS, pruneRuns, stressRoot } from "../stress/files.js";
import { DISCOVER_JSX, FINGERPRINT_JSX, PREP_JSX, REMOVE_JSX, RUN_JSX, SCRATCH, type Discovery, type DTarget, type JTarget, type RunResultJ } from "../stress/jsx.js";
import { cells, COLUMNS, findingKey, measureVariant, type Column, type SChecks } from "../stress/measure.js";
import { COLUMN_LABELS, orderVariants, runVerdict, stressText, withTime } from "../stress/report.js";
import { VIEW_META_KEY, STRESS_VIEW_URI, type StressColumn, type StressVariant, type StressView } from "../views/types.js";
import type { XData } from "./xray-analyze.js";
import { XRAY_JSX } from "./xray.js";
import { CONTACT_SHEET_JSX, RENDER_FRAME_JSX, runRender, waitForFiles } from "./core.js";
import { captureProof, compareProof } from "./prove.js";
import { saveCheckpoint } from "./workflow.js";
import { capText, compRef, errorResult, layerRef, propPath } from "./registry.js";
import { registerViewTool, viewError } from "./views.js";

const KINDS = ["text", "number", "checkbox", "dropdown", "color", "media"] as const;
const margin = z.union([z.number().min(0).max(0.5), z.object({ x: z.number().min(0).max(0.5), y: z.number().min(0).max(0.5) }).strict()]);
const numberFormat = z
  .object({
    decimals: z.number().int().min(0).max(10).optional(),
    decimalSeparator: z.string().max(3).optional(),
    thousandsSeparator: z.string().max(3).optional(),
    prefix: z.string().max(20).optional(),
    suffix: z.string().max(20).optional(),
    negative: z.enum(["minus-before-prefix", "minus-after-prefix", "parentheses"]).optional(),
    plusSign: z.boolean().optional(),
  })
  .strict();
const valueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.number()).min(3).max(4)]);

export const inputSchema = {
  action: z.enum(["run", "expressions"]).optional().describe('"run" (default): the variants and the expression scan. "expressions": only the scan for expressions that break in other After Effects languages (reads only).'),
  comp: compRef.describe("The comp to test (a template). Default: the active comp."),
  targets: z
    .array(
      z
        .object({
          egp: z.string().optional().describe("An Essential Graphics controller, by its name."),
          layer: layerRef.optional().describe("A layer of the comp itself (a text layer, or with property / kind media)."),
          property: propPath.optional().describe("With layer: the property to vary (default: a text layer's Source Text)."),
          kind: z.enum(KINDS).optional().describe("What the value is (default: from the property)."),
          maxLines: z.number().int().min(1).optional().describe("The most lines this text may take (the user's rule)."),
          maxWidthPx: z.number().min(1).optional().describe("Point text: the most width it may take, comp px (the user's rule)."),
          numberFormat: numberFormat.optional().describe("A number control: the format the text that shows it must have (exact check)."),
        })
        .strict(),
    )
    .max(40)
    .optional()
    .describe("What to vary. Default: every Essential Graphics controller of the comp, and text layers whose Source Text reads data (footage(...).dataValue / sourceData)."),
  sets: z.array(z.string()).optional().describe('Only these cases (ids like "de-long", "ar-rtl", "n-huge") or groups ("length", "rtl", "cjk", "complex", "edge", "number", "state", "color", "media"). Default: all.'),
  exclude: z.array(z.string()).optional().describe("Leave out these case ids or groups."),
  values: z
    .array(z.object({ target: z.string().describe("The control or layer name."), values: z.array(valueSchema).min(1).max(200) }).strict())
    .max(40)
    .optional()
    .describe("The user's own values per control (real names, prices, translations), each a variant of its own."),
  data: z
    .union([z.string(), z.array(z.record(z.string(), z.any())).min(1).max(1000)])
    .optional()
    .describe("The user's own rows: a .csv / .tsv / .json file or inline rows; each row is one variant (needs columns)."),
  columns: z.record(z.string(), z.string()).optional().describe('data: column -> control or layer name, e.g. {"Name": "Title", "Price": "Price"}.'),
  rows: z.string().optional().describe('data: only these rows, e.g. "1-20".'),
  csvDelimiter: z.string().length(1).optional(),
  combinations: z
    .enum(["single", "together", "all"])
    .optional()
    .describe('"single" (default): one control at a time, the others as they are. "together": also each text case on every text at once. "all": also combinations across controls, sampled evenly up to maxVariants.'),
  maxVariants: z.number().int().min(1).max(500).optional().describe("Cap on variants (default 80); over it they are sampled evenly per control, and the report says what was kept."),
  frames: z.array(z.number().int().min(0)).max(60).optional().describe("Measure at these frames (from the comp's start, 0). Default: the key frames of the animation and where each text starts and stops being visible."),
  maxFrames: z.number().int().min(1).max(60).optional().describe("Most frames measured per variant (default 12)."),
  checks: z
    .object({
      overflow: z.boolean().optional().describe("Paragraph text must not overflow its box (default true; After Effects 24.6+)."),
      safeArea: z.enum(["frame", "title", "action", "none"]).optional().describe('Text must stay inside this area at every measured frame (default "frame"; title / action need the margin).'),
      title: margin.optional().describe("Title-safe margin per side, a fraction of the frame (from the user's spec)."),
      action: margin.optional().describe("Action-safe margin per side, a fraction of the frame (from the user's spec)."),
      minFontSizePx: z.number().min(0).optional().describe("The smallest size text may render at in the comp, px (the user's)."),
      minCapHeightPx: z.number().min(0).optional().describe("The smallest cap height, comp px (Preflight's estimate)."),
      glyphs: z.boolean().optional().describe("Every character must exist in its font, and the font must be installed (default true; glyphs need After Effects 25.1+)."),
      lines: z.boolean().optional().describe("Count lines and find breaks inside a word (default true; After Effects 24.3+)."),
      overlap: z.array(z.string()).max(20).optional().describe("Varied text must not overlap these layers (names, * wildcards)."),
      numbers: z.boolean().optional().describe("A number set on a control must show right in the text that shows it (default true)."),
      direction: z.boolean().optional().describe("Right-to-left and complex scripts must get the direction and composer they need (default true)."),
    })
    .strict()
    .optional(),
  contactSheets: z.boolean().optional().describe("A contact sheet PNG of each failing variant's failing frames (default true)."),
  maxSheets: z.number().int().min(0).max(50).optional().describe("Most contact sheets (default 12)."),
  outputFolder: z.string().optional().describe("Absolute folder for the contact sheets (default: the run's folder under ~/.surehand/ae/stress)."),
  overwrite: z.boolean().optional().describe("Replace contact sheets already in outputFolder (default false: skip them and say so)."),
  proveUnchanged: z.boolean().optional().describe("Also prove with pixels (ae_prove_identical's engine) that your comp renders the same after the run (default false: values are read back)."),
  checkpoint: z.boolean().optional().describe("Save a project checkpoint first (see ae_checkpoint)."),
  dryRun: z.boolean().optional().describe("Only discover the controls and list the variants and frames; sets nothing."),
  timeBudgetSeconds: z.number().min(10).max(3600).optional().describe("Stop starting new variants after this long and report what was measured (default 300)."),
};

export type StressArgs = {
  action?: "run" | "expressions";
  comp?: string | number;
  targets?: { egp?: string; layer?: string | number; property?: string | (string | number)[]; kind?: (typeof KINDS)[number]; maxLines?: number; maxWidthPx?: number; numberFormat?: NumberFormat }[];
  sets?: string[];
  exclude?: string[];
  values?: { target: string; values: (Cell | number[])[] }[];
  data?: string | Record<string, unknown>[];
  columns?: Record<string, string>;
  rows?: string;
  csvDelimiter?: string;
  combinations?: "single" | "together" | "all";
  maxVariants?: number;
  frames?: number[];
  maxFrames?: number;
  checks?: Partial<Omit<SChecks, "maxLines" | "maxWidthPx">>;
  contactSheets?: boolean;
  maxSheets?: number;
  outputFolder?: string;
  overwrite?: boolean;
  proveUnchanged?: boolean;
  checkpoint?: boolean;
  dryRun?: boolean;
  timeBudgetSeconds?: number;
};

const parse = <T>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : v) as T;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const now = () => Date.now();
// ---------- targets ----------

/** A discovered property as a target (kind from its type and its effect), or why it can't be one. */
export function toTarget(d: DTarget, kind?: Target["kind"]): Target {
  const base = { id: d.name, name: d.name, source: d.source === "egp" ? ("egp" as const) : d.ex === 2 ? ("data" as const) : ("layer" as const), layer: d.li, layerName: d.ln, path: d.path?.map(String), current: d.value as Cell, items: d.items, ...(d.box ? { box: true } : {}) };
  if (d.err) return { ...base, kind: kind ?? "text", problem: d.err };
  let k: Target["kind"] | null = kind ?? null;
  if (!k) {
    if (d.type === "TEXT_DOCUMENT") k = "text";
    else if (d.type === "COLOR") k = "color";
    else if (d.type === "LAYER") k = "media";
    else if (d.type === "OneD") k = d.fx === "ADBE Checkbox Control" ? "checkbox" : d.fx === "ADBE Dropdown Control" ? "dropdown" : "number";
  }
  if (!k) return { ...base, kind: "number", problem: `a ${d.type} controller: there are no worst cases for it (give your own values)` };
  if (d.keyed && k !== "text") return { ...base, kind: k, problem: "it has keyframes: one value can't replace its animation" };
  if (k === "dropdown" && !d.items) return { ...base, kind: k, problem: "its menu items could not be counted" };
  return { ...base, kind: k };
}

/** The targets of a run: the user's, or what the comp exposes. */
export function chooseTargets(disc: Discovery, a: Pick<StressArgs, "targets">): { targets: Target[]; problems: string[] } {
  const problems: string[] = [];
  const out: Target[] = [];
  if (a.targets?.length) {
    let named = 0;
    for (const [k, t] of a.targets.entries()) {
      if ((t.egp === undefined) === (t.layer === undefined)) {
        problems.push(`targets[${k}]: give either egp (a controller's name) or layer, not both or neither`);
        continue;
      }
      if (t.egp !== undefined) {
        const d = disc.egp.find((e) => e.name === t.egp);
        if (!d) {
          problems.push(`targets[${k}]: no Essential Graphics controller named "${t.egp}" in "${disc.comp.name}" (it has: ${disc.egp.map((e) => e.name).join(", ") || "none"})`);
          continue;
        }
        out.push({ ...toTarget(d, t.kind), maxLines: t.maxLines, maxWidthPx: t.maxWidthPx, numberFormat: t.numberFormat });
      } else {
        const d = disc.named[named++];
        if (!d || d.err) {
          problems.push(`targets[${k}] (layer ${JSON.stringify(t.layer)}): ${d?.err ?? "not found"}`);
          continue;
        }
        out.push({ ...toTarget(d, t.kind), maxLines: t.maxLines, maxWidthPx: t.maxWidthPx, numberFormat: t.numberFormat });
      }
    }
  } else {
    for (const d of disc.egp) out.push(toTarget(d));
    for (const d of disc.texts) if (d.ex === 2 && !out.some((t) => t.layer === d.li && t.kind === "text")) out.push(toTarget(d));
  }
  // ids: unique (a name used twice gets its layer index)
  const seen = new Map<string, number>();
  for (const t of out) seen.set(t.id, (seen.get(t.id) ?? 0) + 1);
  for (const t of out) if (seen.get(t.id)! > 1) t.id = `${t.name}#${t.layer ?? "?"}`;
  return { targets: out, problems };
}

/** Where `values` / `columns` name a control: by id or name. */
const findTarget = (ts: Target[], name: string) => ts.find((t) => t.id === name) ?? ts.find((t) => t.name === name);

// ---------- the run ----------

const SAMPLE_BUDGET_MS = 60_000;

/** The view's sub-line for a variant: "Title · 52 chars, compounds". */
function detailOf(v: Variant): string {
  if (v.detail) return v.detail;
  return v.sets.map((s) => `${s.target}${s.detail ? ` · ${s.detail}` : ""}`).join("; ");
}
const shown = (v: unknown): string => (Array.isArray(v) ? `[${v.join(", ")}]` : v === null || v === undefined ? "" : String(v));

export async function runStress(a: StressArgs, perm: { mode: string } = permissions()): Promise<CallToolResult> {
  const t0 = now(), budget = (a.timeBudgetSeconds ?? 300) * 1000;
  const readOnly = perm.mode === "read-only";
  if (a.outputFolder && !isAbsolute(a.outputFolder)) return errorResult(`outputFolder must be an absolute path (got ${a.outputFolder}).`);
  if (a.data !== undefined && !a.columns) return errorResult('data needs columns: which column goes to which control, e.g. {"Name": "Title"}.');
  const checks: SChecks = {
    overflow: a.checks?.overflow ?? true,
    safeArea: a.checks?.safeArea ?? "frame",
    title: a.checks?.title,
    action: a.checks?.action,
    minFontSizePx: a.checks?.minFontSizePx,
    minCapHeightPx: a.checks?.minCapHeightPx,
    glyphs: a.checks?.glyphs ?? true,
    lines: a.checks?.lines ?? true,
    overlap: a.checks?.overlap,
    numbers: a.checks?.numbers ?? true,
    direction: a.checks?.direction ?? true,
  };
  if ((checks.safeArea === "title" || checks.safeArea === "action") && checks[checks.safeArea] === undefined)
    return errorResult(`checks.safeArea "${checks.safeArea}" needs checks.${checks.safeArea}: the margin per side from the user's spec (e.g. 0.1). Nothing was run.`);

  // 1. what the comp exposes (a probe comp and a scratch copy, both removed in the same call)
  const named = (a.targets ?? []).filter((t) => t.layer !== undefined).map((t) => ({ layer: t.layer, property: t.property, kind: t.kind }));
  const dr = await runJsx(DISCOVER_JSX, { comp: a.comp, named }, { undoGroup: "Surehand MCP stress test (read)", timeoutMs: 120_000 });
  if (!dr.ok) return errorResult(dr.error?.message ?? "the comp could not be read");
  const disc = parse<Discovery>(dr.result);
  const comp = disc.comp, nFrames = Math.max(1, Math.round(comp.dur / comp.fd));
  const compView: StressView["comp"] = { id: comp.id, name: comp.name, width: comp.w, height: comp.h, fps: comp.fps, duration: comp.dur, ...(comp.dst ? { dst: comp.dst } : {}), ...(comp.df ? { df: true } : {}) };

  // 2. the expressions (X-ray's collector, read-only)
  let languages: StressView["languages"] = [];
  const notes: string[] = [];
  try {
    const xr = await runJsx(XRAY_JSX, { sections: ["expressions"], comps: [comp.id], timeBudgetSeconds: 60 }, { undoGroup: false, timeoutMs: 180_000 });
    if (xr.ok) {
      const x = parse<XData>(xr.result);
      languages = languageRisks(x);
      if (x.partial) notes.push(`expressions: only part of the comp tree was read (${x.partial.reason})`);
    } else notes.push(`expressions could not be read: ${xr.error?.message}`);
  } catch (e: any) {
    notes.push(`expressions could not be read: ${e?.message ?? e}`);
  }
  if (a.action === "expressions") {
    const view = baseView(compView, [], [], [], languages, notes);
    const { verdict, line } = runVerdict({ variants: [], languages, restore: { verified: true, values: 0, differences: [] } });
    view.verdict = verdict === "INCOMPLETE" ? "PASS" : verdict;
    view.verdictLine = languages.length ? line : "PASS (no expression reaches anything by a translated name)";
    return { content: [{ type: "text", text: capText(expressionsText(view)) }], _meta: { [VIEW_META_KEY]: view } };
  }

  // 3. targets, the user's data, the variants, the frames
  const { targets, problems } = chooseTargets(disc, a);
  if (problems.length) return errorResult(`Nothing was run:\n- ${problems.join("\n- ")}`);
  if (!targets.length) {
    const texts = disc.texts.map((t) => `"${t.name}"`).join(", ");
    return errorResult(
      `"${comp.name}" exposes nothing variable: no Essential Graphics controllers and no text that reads data. ` +
        (texts ? `Name what to vary with targets, e.g. targets: [{layer: ${JSON.stringify(disc.texts[0].name)}}] (its text layers: ${texts}).` : "It has no text layers either; name a layer and property with targets."),
    );
  }
  const own: { target: string; values: (Cell | number[])[] }[] = [];
  for (const v of a.values ?? []) {
    const t = findTarget(targets, v.target);
    if (!t) return errorResult(`values: no control named "${v.target}" (controls: ${targets.map((x) => x.id).join(", ")}).`);
    own.push({ target: t.id, values: v.values });
  }
  let rows: { n: number; cells: { target: string; value: Cell }[] }[] | undefined;
  let rowsSource: string | undefined;
  if (a.data !== undefined && a.columns) {
    const table = loadTable(a.data, { delimiter: a.csvDelimiter });
    rowsSource = typeof a.data === "string" ? basename(a.data) : "your rows";
    for (const [col, name] of Object.entries(a.columns)) {
      if (!table.columns.includes(col)) return errorResult(`columns: there is no column "${col}" in ${table.source} (columns: ${table.columns.join(", ")}).`);
      if (!findTarget(targets, name)) return errorResult(`columns: no control named "${name}" (controls: ${targets.map((x) => x.id).join(", ")}).`);
    }
    rows = pickRows(a.rows, table.rows.length).map((n) => ({
      n,
      cells: Object.entries(a.columns!).map(([col, name]) => ({ target: findTarget(targets, name)!.id, value: table.rows[n - 1][col] ?? null })),
    }));
  }
  const plan = planVariants(targets, { sets: a.sets, exclude: a.exclude, combinations: a.combinations ?? "single", maxVariants: a.maxVariants ?? 80, own, rows, rowsSource });
  const frames = a.frames?.length
    ? [...new Set(a.frames.filter((f) => f < nFrames))].sort((x, y) => x - y)
    : pickFrames({ frames: nFrames, keys: disc.keys.map((t) => t / comp.fd), edges: disc.edges.map((t) => t / comp.fd), max: a.maxFrames ?? 12 });
  if (!frames.length) return errorResult(`frames: none is inside "${comp.name}" (it has ${nFrames} frames, 0 to ${nFrames - 1}).`);
  for (const t of targets) if (t.problem) notes.push(`${t.name}: not tested: ${t.problem}`);

  const run = `${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\..*$/, "")}-${randomBytes(2).toString("hex")}`;
  const variantsPlanned = plan.variants;

  if (a.dryRun || readOnly) {
    const view = baseView(compView, targets, frames, [], languages, notes);
    view.run = run;
    view.sampled = plan.sampled;
    view.variants = variantsPlanned.map((v) => planned(v, "notRun"));
    view.counts.variants = view.counts.notRun = view.variants.length;
    view.verdict = "INCOMPLETE";
    view.verdictLine = readOnly ? "INCOMPLETE (read-only mode: the variants were not applied)" : `Dry run: ${plural(variantsPlanned.length, "variant")} planned; nothing was set`;
    if (readOnly)
      view.notes.unshift(
        "Read-only mode: the variants were not applied. Testing one sets it on a scratch copy of the comp (removed in the same step, your comp is never edited), which read-only mode doesn't do. The plan and the expression scan above are complete. The user can switch to Full or Ask with the mode selector at the top of the Surehand panel (Window > Extensions > Surehand MCP).",
      );
    return { content: [{ type: "text", text: capText(planText(view, variantsPlanned, targets)) }], _meta: { [VIEW_META_KEY]: view } };
  }

  // 4. before: the comp read back (and its pixels, when asked); a checkpoint when asked
  let cp = "";
  if (a.checkpoint) {
    const c = await saveCheckpoint("before-stress-test");
    cp = `Checkpoint saved first: ${c.file}`;
  }
  const fp0 = await fingerprint(comp.id);
  if (!fp0.ok) return errorResult(`Your comp could not be read before the test (${fp0.error}); nothing was run.`);
  let proofId: string | undefined;
  if (a.proveUnchanged) {
    try {
      proofId = (await captureProof({ comps: [comp.id], frames: 4, maxSize: 960 })).id;
    } catch (e: any) {
      notes.push(`the pixel proof could not be captured: ${e?.message ?? e}`);
    }
  }

  // 5. the variants, on scratch copies (each call: copy, set, measure, set back, remove the copy)
  const tIndex = new Map(targets.map((t, k) => [t.id, k]));
  const jt: JTarget[] = targets.map((t) => ({ li: t.layer ?? 0, path: (t.path ?? []).map(Number), kind: t.kind, ...(t.source === "data" ? { exprOff: true } : {}) }));
  const overlapPats = (checks.overlap ?? []).map(wildcard);
  const mediaPats = new Map<number, number>();
  targets.forEach((t, k) => {
    if (t.kind === "media" && t.layerName) mediaPats.set(k, overlapPats.length + mediaPats.size);
  });
  const patterns = [...overlapPats, ...[...mediaPats.keys()].map((k) => wildcard(targets[k].layerName!))];
  const pf: PArgs = { step: 1, textAll: true, bounds: true, patterns, glyphs: checks.glyphs, timeBudgetSeconds: 30, frames };
  const baselineVariant: Variant = { id: "baseline", name: "As it is", set: "generated", sets: [] };
  const queue = [baselineVariant, ...variantsPlanned.filter((v) => v.sets.every((s) => !targets[tIndex.get(s.target)!]?.problem))];
  const skipped = variantsPlanned.filter((v) => !queue.includes(v));
  const results = new Map<string, RunResultJ["results"][number]>();
  let scratchName = `${comp.name} ${SCRATCH}`, left: string[] = [], firstCall = true, stopped = false;
  while (results.size < queue.length) {
    const rest = queue.filter((v) => !results.has(v.id));
    if (now() - t0 > budget && results.size > 0) {
      stopped = true;
      break;
    }
    const r = await runJsx(
      RUN_JSX,
      { comp: comp.id, targets: jt, frames, pf, budgetMs: Math.min(SAMPLE_BUDGET_MS, Math.max(5_000, budget - (now() - t0))), variants: rest.map((v) => ({ id: v.id, sets: v.sets.map((s) => ({ t: tIndex.get(s.target)!, v: s.value })) })) },
      {
        undoGroup: "Surehand MCP stress test",
        timeoutMs: SAMPLE_BUDGET_MS + 240_000,
        bridge:
          firstCall && perm.mode === "ask"
            ? { approval: { tool: "Stress test", summary: `Test ${plural(queue.length - 1, "variant")} of "${comp.name}" on a scratch copy (removed again; your comp is not edited): ${approvalSummary("ae_stress_test", { targets: targets.map((t) => t.id) })}` } }
            : undefined,
      },
    );
    firstCall = false;
    if (!r.ok) {
      if (results.size === 0) return errorResult(`The test could not run: ${r.error?.message ?? "unknown error"}. Nothing of your comp was changed (it ran on a scratch copy).`);
      notes.push(`stopped after ${results.size - 1} variants: ${r.error?.message}`);
      stopped = true;
      break;
    }
    const res = parse<RunResultJ>(r.result);
    scratchName = res.name || scratchName;
    if (res.left?.length) left.push(...res.left);
    for (const x of res.results) results.set(x.id, x);
    if (!res.done) {
      notes.push("a call measured no variant (After Effects too slow for the time budget)");
      stopped = true;
      break;
    }
  }

  // 6. the checks
  const pdata = (x?: RunResultJ["results"][number]) => {
    try {
      return x?.pf ? parse<PData>(x.pf) : undefined;
    } catch {
      return undefined;
    }
  };
  const fullChecks: SChecks = {
    ...checks,
    maxLines: Object.fromEntries(targets.filter((t) => t.maxLines && t.layerName).map((t) => [t.layerName!, t.maxLines!])),
    maxWidthPx: Object.fromEntries(targets.filter((t) => t.maxWidthPx && t.layerName).map((t) => [t.layerName!, t.maxWidthPx!])),
  };
  const base = results.get("baseline");
  const baseData = pdata(base);
  const common = { targets, targetIndex: tIndex, checks: fullChecks, scratch: scratchName, overlapPatterns: overlapPats.map((_, k) => k), mediaPatterns: mediaPats };
  const baseM = base ? measureVariant({ ...common, variant: null, res: base, data: baseData }) : { findings: [], layers: [], notRun: [], notes: [] };
  const baseKeys = new Set(baseM.findings.map(findingKey));
  const applies = columnsApplying(targets, checks);
  const variants: StressVariant[] = [];
  for (const v of variantsPlanned) {
    const res = results.get(v.id);
    if (!res) {
      variants.push(planned(v, "notRun", skipped.includes(v) ? "a control it sets can't be tested" : "the time budget ran out before it"));
      continue;
    }
    const m = measureVariant({ ...common, variant: v, res, data: pdata(res), baseline: { data: baseData, x: base?.x ?? [], ee: base?.ee } });
    m.findings = m.findings.filter((f) => !baseKeys.has(findingKey(f)) || f.check === "set" || f.check === "number.input");
    const cellsOf = cells(m, applies);
    const status: StressVariant["status"] = m.findings.some((f) => f.severity === "fail") ? "fail" : m.findings.length ? "warn" : !pdata(res) ? "incomplete" : "pass";
    variants.push({
      ...planned(v, status),
      cells: cellsOf,
      findings: m.findings.map((f) => withTime(f, compView)),
      layers: m.layers.filter((l) => v.sets.some((s) => targets[tIndex.get(s.target)!]?.layer === l.layerIndex) || (base?.x ?? []).some((b) => b.li === l.layerIndex && b.text !== l.text)),
      notRun: m.notRun.filter((n, k, all) => all.findIndex((o) => o.column === n.column) === k),
    });
    for (const n of m.notes) if (!notes.includes(n)) notes.push(n);
  }
  if (stopped) notes.push(`the time budget (${Math.round(budget / 1000)} s) ran out: ${variants.filter((v) => v.status === "notRun").length} variants were not measured (raise timeBudgetSeconds, or fewer sets)`);

  // 7. contact sheets and the first failing frame of each failing variant (a scratch copy each, removed after)
  const runDir = join(stressRoot(), run);
  pruneRuns(MAX_RUNS - 1);
  mkdirSync(runDir, { recursive: true });
  const sheetDir = a.outputFolder ?? runDir;
  const wantSheets = a.contactSheets !== false;
  const failing = orderVariants(variants).filter((v) => v.status === "fail" || v.status === "warn").slice(0, a.maxSheets ?? 12);
  if (wantSheets && failing.length) {
    mkdirSync(sheetDir, { recursive: true });
    for (const v of failing) {
      if (now() - t0 > budget + 120_000) {
        notes.push("contact sheets: the time budget ran out before all were rendered");
        break;
      }
      const vv = variantsPlanned.find((x) => x.id === v.id)!;
      const fs = [...new Set(v.findings.map((f) => f.frame).filter((f): f is number => f !== undefined))].sort((x, y) => x - y);
      const shots = (fs.length ? fs : frames).slice(0, 6);
      const safe = v.id.replace(/[^\w.@+-]+/g, "_").slice(0, 80);
      const sheet = join(sheetDir, `${safe}.png`);
      const framePng = join(runDir, `${safe}_frame.png`);
      let prep: { id: number; media: number[] } | undefined;
      try {
        const pr = await runJsx(PREP_JSX, { comp: comp.id, targets: jt, sets: vv.sets.map((s) => ({ t: tIndex.get(s.target)!, v: s.value })) }, { undoGroup: "Surehand MCP stress test", timeoutMs: 120_000 });
        if (!pr.ok) throw new Error(pr.error?.message);
        prep = parse<{ id: number; media: number[] }>(pr.result);
        const tmpDir = appFile("tmp");
        mkdirSync(tmpDir, { recursive: true });
        if (existsSync(sheet) && !a.overwrite) notes.push(`${sheet} already exists: not replaced (pass overwrite: true)`);
        else {
          const times = shots.map((f) => f * comp.fd);
          const { r, missing } = await runRender(CONTACT_SHEET_JSX, { comp: prep.id, times, outputPath: sheet, overwrite: !!a.overwrite, width: 1600, columns: Math.min(3, times.length), tmpDir }, { undoGroup: "Surehand MCP stress test", timeoutMs: 180_000 }, (x) => waitForFiles([x.path]));
          if (r.ok && !missing.length) v.sheet = sheet;
          else notes.push(`${v.id}: the contact sheet could not be rendered${r.ok ? "" : `: ${r.error?.message}`}`);
        }
        const first = v.findings.find((f) => f.frame !== undefined)?.frame ?? frames[0];
        const fr = await runRender(RENDER_FRAME_JSX, { comp: prep.id, time: first * comp.fd, outputPath: framePng, overwrite: true, maxSize: 1280, tmpDir }, { undoGroup: "Surehand MCP stress test", timeoutMs: 180_000 }, (x) => waitForFiles([x.path]));
        if (fr.r.ok && !fr.missing.length) {
          const info = fr.r.result as { width: number; height: number };
          const tc = withTime({ check: "", column: "fit", severity: "fail", message: "", frame: first }, compView);
          v.frame = { file: `${safe}_frame.png`, frame: first, time: tc.time!, tc: tc.tc!, width: info.width, height: info.height };
        }
      } catch (e: any) {
        notes.push(`${v.id}: could not render its frames: ${e?.message ?? e}`);
      } finally {
        if (prep) {
          const rm = await runJsx(REMOVE_JSX, { ids: [prep.id, ...prep.media] }, { undoGroup: "Surehand MCP stress test", timeoutMs: 60_000 }).catch(() => null);
          const l = (rm?.result as { left?: string[] } | undefined)?.left;
          if (!rm?.ok || l?.length) left.push(...(l ?? [`${comp.name} ${SCRATCH}`]));
        }
      }
    }
  }

  // 8. after: the comp read back, leftovers removed, the pixels compared (when asked)
  const fp1 = await fingerprint(comp.id);
  if (fp1.ok && fp1.scratch.length) {
    const rm = await runJsx(REMOVE_JSX, { ids: fp1.scratch.map((s) => s.id) }, { undoGroup: "Surehand MCP stress test", timeoutMs: 60_000 }).catch(() => null);
    if (rm?.ok) notes.push(`removed ${plural(fp1.scratch.length, "scratch item")} left by an earlier step`);
    else left.push(...fp1.scratch.map((s) => s.name));
  }
  const restore = compareFingerprints(fp0, fp1);
  if (left.length) restore.differences.push(`scratch items that could not be removed (delete them from the Project panel): ${[...new Set(left)].join(", ")}`);
  if (proofId) {
    const c = await compareProof({ id: proofId }).catch((e) => String(e?.message ?? e));
    if (typeof c === "string") notes.push(`pixel proof: ${c}`);
    else {
      restore.proof = `pixels: ${c.verdict} (proof ${proofId})`;
      if (c.verdict === "differs") {
        restore.verified = false;
        restore.differences.push(`the comp renders differently than before (proof ${proofId}): ${c.text.split("\n")[0]}`);
      }
    }
  }

  // 9. the report
  const view = baseView(compView, targets, frames, orderVariants(variants), languages, notes);
  view.run = run;
  view.sampled = plan.sampled;
  view.baseline = baseM.findings.map((f) => withTime(f, compView));
  view.restore = restore;
  view.columns = COLUMNS_ALL.map((id) => ({ id, label: COLUMN_LABELS[id], ran: applies[id] && !(variants.length && variants.every((v) => v.cells[id] === "na")), ...whyNot(id, applies, variants, checks) }));
  if (wantSheets && failing.length) view.folder = sheetDir;
  const counts = (s: StressVariant["status"]) => variants.filter((v) => v.status === s).length;
  view.counts = { ...view.counts, variants: variants.length, failed: counts("fail"), warnings: counts("warn"), passed: counts("pass"), incomplete: counts("incomplete"), notRun: counts("notRun") };
  const vd = runVerdict(view);
  view.verdict = vd.verdict;
  view.verdictLine = vd.line;
  view.args = runAgainArgs(a);
  const text = stressText(view) + (cp ? `\n${cp}` : "");
  return { content: [{ type: "text", text: capText(text) }], _meta: { [VIEW_META_KEY]: view } };
}

const COLUMNS_ALL: StressColumn[] = [...COLUMNS, "other"];

/** Which columns apply to the run's targets and checks at all. */
function columnsApplying(targets: Target[], c: SChecks): Record<Column, boolean> {
  const text = targets.some((t) => t.kind === "text" && !t.problem) || targets.some((t) => !t.problem);
  return {
    fit: (c.overflow && text) || targets.some((t) => t.kind === "media" || t.maxWidthPx),
    safe: c.safeArea !== "none" || !!c.overlap?.length,
    size: text,
    glyphs: c.glyphs || c.direction,
    lines: c.lines,
    other: true,
  };
}
function whyNot(id: StressColumn, applies: Record<Column, boolean>, vs: StressVariant[], c: SChecks): { why?: string } {
  if (!applies[id]) return { why: id === "safe" ? "safeArea is none" : id === "lines" ? "lines is off" : id === "glyphs" ? "glyphs and direction are off" : "no control it applies to" };
  const reason = vs.flatMap((v) => v.notRun).find((n) => n.column === id)?.reason;
  if (reason && vs.every((v) => v.cells[id] === "na")) return { why: reason };
  void c;
  return {};
}

/** A variant before (or without) measuring. */
function planned(v: Variant, status: StressVariant["status"], why?: string): StressVariant {
  const na = Object.fromEntries(COLUMNS_ALL.map((c) => [c, "na"])) as StressVariant["cells"];
  return {
    id: v.id,
    name: v.name,
    set: v.set,
    ...(v.caseId ? { caseId: v.caseId } : {}),
    ...(v.group ? { group: v.group } : {}),
    detail: detailOf(v),
    inputs: v.sets.map((s) => ({ target: s.target, value: shown(s.value), ...(s.detail ? { detail: s.detail } : {}) })),
    status,
    cells: na,
    findings: [],
    layers: [],
    notRun: why ? [{ column: "other", reason: why }] : [],
  };
}

function baseView(comp: StressView["comp"], targets: Target[], frames: number[], variants: StressVariant[], languages: StressView["languages"], notes: string[]): StressView {
  return {
    view: "stress",
    run: "",
    verdict: "PASS",
    verdictLine: "",
    comp,
    counts: { variants: variants.length, failed: 0, warnings: 0, passed: 0, incomplete: 0, notRun: 0, languageRisks: languages.length, targets: targets.filter((t) => !t.problem).length, frames: frames.length },
    targets: targets.map((t) => ({ id: t.id, name: t.name, kind: t.kind, source: t.source, ...(t.layer ? { layer: t.layer } : {}), ...(t.layerName ? { layerName: t.layerName } : {}), ...(t.current !== undefined ? { current: shown(t.current) } : {}), ...(t.problem ? { problem: t.problem } : {}) })),
    frames,
    columns: COLUMNS_ALL.map((id) => ({ id, label: COLUMN_LABELS[id], ran: false })),
    variants,
    baseline: [],
    languages,
    restore: { verified: true, values: 0, differences: [] },
    notes,
  };
}

/** The arguments Run again sends (the same test; the view never adds anything). */
function runAgainArgs(a: StressArgs): Record<string, unknown> {
  const { dryRun, checkpoint, ...rest } = a;
  void dryRun;
  void checkpoint;
  return rest;
}

function planText(v: StressView, vs: Variant[], targets: Target[]): string {
  const out = [v.verdictLine];
  out.push(`"${v.comp.name}" (${v.comp.width}x${v.comp.height}): ${plural(targets.filter((t) => !t.problem).length, "control")}, measured at frames f${v.frames.join(", f")}`);
  out.push("", "controls");
  for (const t of targets) out.push(`  ${t.id} [${t.kind}, ${t.source === "egp" ? "Essential Graphics" : t.source === "data" ? "text from data" : "layer"}${t.layerName ? `, layer ${t.layer}: ${t.layerName}` : ""}]${t.problem ? ` NOT TESTED: ${t.problem}` : ""}`);
  if (v.sampled) out.push("", `sampled: ${v.sampled.kept} of ${v.sampled.total} (${v.sampled.how})`);
  out.push("", "variants");
  for (const x of vs.slice(0, 120)) out.push(`  ${x.id}: ${x.sets.map((s) => `${s.target} = ${JSON.stringify(shown(s.value)).replace(/\\r/g, "↵").slice(0, 70)}`).join("; ")}`);
  if (vs.length > 120) out.push(`  ... ${vs.length - 120} more`);
  out.push("", expressionsText(v).split("\n").slice(1).join("\n"));
  if (v.notes.length) out.push("", "notes", ...v.notes.map((n) => `  - ${n}`));
  return out.join("\n");
}

function expressionsText(v: StressView): string {
  const out = [v.verdictLine || "PASS"];
  if (!v.languages.length) out.push("expressions: none reach an effect, parameter or property by a translated name");
  else {
    out.push("breaks in other After Effects languages");
    for (const l of v.languages)
      out.push(`  ${l.severity === "fail" ? "FAIL" : "WARN"}  ${l.comp} > ${l.layerIndex}: ${l.layer} > ${l.property}: ${l.ref}`, `        ${l.message}; fix: ${l.fix}${l.suggestion ? ` (e.g. ${l.suggestion})` : ""}`);
  }
  return out.join("\n");
}

// ---------- the read-back ----------

interface Fp {
  ok: boolean;
  error?: string;
  parts: string[];
  values: number;
  partial?: boolean;
  scratch: { id: number; name: string }[];
}
async function fingerprint(comp: number): Promise<Fp> {
  try {
    const r = await runJsx(FINGERPRINT_JSX, { comp, budget: 40_000 }, { undoGroup: false, timeoutMs: 300_000 });
    if (!r.ok) return { ok: false, error: r.error?.message, parts: [], values: 0, scratch: [] };
    const x = parse<{ parts: string[]; values: number; partial: boolean; scratch: { id: number; name: string }[] }>(r.result);
    return { ok: true, ...x };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e), parts: [], values: 0, scratch: [] };
  }
}

/** Before and after, line by line (the project's item list without the scratch items, which are removed separately). */
export function compareFingerprints(a: Fp, b: Fp): StressView["restore"] {
  if (!b.ok) return { verified: false, values: a.values, differences: [`your comp could not be read after the test: ${b.error}`] };
  const strip = (p: string[], scratch: { id: number }[]) => p.map((s) => (s.startsWith("items|") ? "items|" + s.slice(6).split(",").filter((id) => !scratch.some((x) => String(x.id) === id)).join(",") : s));
  const before = strip(a.parts, []), after = strip(b.parts, b.scratch);
  const differences: string[] = [];
  const max = Math.max(before.length, after.length);
  for (let k = 0; k < max && differences.length < 20; k++) {
    if (before[k] === after[k]) continue;
    const show = (s?: string) => (s === undefined ? "(none)" : s.length > 140 ? s.slice(0, 137) + "..." : s);
    differences.push(before[k]?.startsWith("items|") ? "the project's items changed" : `${show(before[k])} -> ${show(after[k])}`);
  }
  return { verified: differences.length === 0, values: a.values, ...(a.partial ? { partial: true } : {}), differences };
}

/** A hash of a fingerprint (tests). */
export const fpHash = (parts: string[]) => createHash("sha1").update(parts.join("\n")).digest("hex");

// ---------- registration ----------

export function registerStressTools(server: McpServer) {
  registerViewTool(
    server,
    "ae_stress_test",
    {
      _meta: { ui: { resourceUri: STRESS_VIEW_URI } },
      title: "Stress test",
      description:
        "Push worst-case inputs through every variable a template comp exposes (its Essential Graphics controllers, text that reads data, or the " +
        "layers you name) and measure each result at the animation's key frames: text overflowing its box (by how many px, how many lines), " +
        "leaving the frame / title- / action-safe, rendering smaller, glyphs the font lacks or a substituted font, Arabic / Hebrew / Devanagari " +
        "without the direction or composer they need, breaks inside a word, overlap with named layers, a number that shows wrong. Inputs: generated " +
        "worst cases (long German and Finnish, right to left, CJK, Thai, Hindi, combining marks, emoji, caps, empty, one character, no spaces; " +
        "zero, negative, huge, many decimals, separators, percent; every checkbox and menu state) and the user's own values or CSV / JSON rows. " +
        "Also lists expressions that break in After Effects in another language, with the language-safe form. Everything runs on a scratch copy " +
        "removed in the same step; your comp is read back afterwards and must be identical. Returns PASS / FAIL with what breaks at which frame " +
        "and by how much, a grid, and a contact sheet per failing variant. dryRun: true lists the controls, variants and frames only.",
      inputSchema,
      // sets values only on scratch copies (removed again); writes contact sheet PNGs (never replaces one without overwrite)
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args: StressArgs) => {
      try {
        return await runStress(args, permissions());
      } catch (e) {
        return viewError(e);
      }
    },
  );
}

