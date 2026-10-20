// ae_versions_from_data: a CSV / JSON file (or inline rows) becomes versions of a template comp, and then every row
// is checked: the values read back where they render, and the layout measured with Preflight's code. The data side
// is src/versions/data.ts, the ExtendScript src/versions/jsx.ts, the checks and the report src/versions/checks.ts.
// The build is one undo step (one ae_undo removes every version); the checks only read.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { formatChanges, rollbackProblem, runJsx } from "../jsx.js";
import { permissions, READ_ONLY_REFUSAL } from "../permissions.js";
import { PREFLIGHT_JSX, type PArgs, type PData } from "../preflight/project.js";
import { formatAt, type TimeBase } from "../preflight/report.js";
import { hex, loadTable, outputTaken, patternColumns, pickRows, type Table } from "../versions/data.js";
import { checkRow, KINDS, label, mappingProblems, prepareRow, rowLine, rowNames, runVerdict, totalsLine, type Mode, type Prep, type RowResult, type VChecks, type VMap } from "../versions/checks.js";
import { BUILD_JSX, VALIDATE_JSX, type JsxMap, type VBuilt, type VTemplate } from "../versions/jsx.js";
import type { XData } from "./xray-analyze.js";
import { XRAY_JSX } from "./xray.js";
import { RENDER_QUEUE_JSX } from "./render.js";
import { saveCheckpoint } from "./workflow.js";
import { capText, compRef, errorResult, formatResult, layerRef, propPath, reportScope } from "./registry.js";

const MAX_ROWS = 1000;
const margin = z.union([z.number().min(0).max(0.5), z.object({ x: z.number().min(0).max(0.5), y: z.number().min(0).max(0.5) }).strict()]);

const mapSchema = z
  .object({
    column: z.string().describe("The column (CSV header / JSON key) that holds the value."),
    layer: layerRef.optional().describe('Target layer of the template comp itself, name or 1-based index (mode "duplicate").'),
    egp: z.string().optional().describe('Target Essential Graphics controller of the template, by its name (mode "essentialGraphics").'),
    kind: z
      .enum(KINDS)
      .describe(
        'text: the cell as the text. number: the cell as a number, written in format (into text), or set as is (into a one-value property). ' +
          'color: the cell is the colour, or rules pick it. footage: the cell is a file path that replaces the layer\'s source. value: the cell ' +
          'as the value of property (numbers, "x,y", colours, text). size: the cell through px sets the layer\'s on-screen width / height.',
      ),
    property: propPath.optional().describe("The property to set (value, color on non-text layers, number into a Slider...). text / number default to Source Text; size to Scale."),
    format: z
      .object({
        decimals: z.number().int().min(0).max(10).optional().describe("Fixed decimals (rounded half away from zero). Default: as many as the number has."),
        decimalSeparator: z.string().max(3).optional().describe('Default ".".'),
        thousandsSeparator: z.string().max(3).optional().describe("Between groups of three digits. Default: none."),
        prefix: z.string().max(20).optional(),
        suffix: z.string().max(20).optional(),
        negative: z.enum(["minus-before-prefix", "minus-after-prefix", "parentheses"]).optional().describe('Default "minus-before-prefix" (-$5).'),
        plusSign: z.boolean().optional().describe('Write "+" before positive numbers.'),
      })
      .strict()
      .optional()
      .describe("kind number into text: the user's number format."),
    rules: z
      .array(z.object({ op: z.enum(["<", "<=", ">", ">=", "=", "!="]), value: z.union([z.number(), z.string()]), color: z.string() }).strict())
      .max(20)
      .optional()
      .describe('kind color: the first rule the cell matches gives the colour, e.g. [{op: "<", value: 0, color: "#C62828"}]. Numbers compare as numbers.'),
    otherwise: z.string().optional().describe("kind color with rules: the colour when no rule matches (default: keep the template's)."),
    axis: z.enum(["width", "height"]).optional().describe('kind size: which dimension (default "width").'),
    px: z
      .array(z.tuple([z.number(), z.number()]))
      .min(2)
      .max(50)
      .optional()
      .describe("kind size: the user's value-to-pixels mapping, [value, px] points, linear between them, e.g. [[0, 0], [100, 800]]."),
  })
  .strict();

export const inputSchema = {
  data: z
    .union([z.string(), z.array(z.record(z.string(), z.any())).min(1).max(MAX_ROWS)])
    .describe("The data: a .csv / .tsv / .json file path (JSON: an array of objects, or {rows: [...]}), or the rows inline (column -> value)."),
  comp: compRef.describe("The template comp: the one every version is made from. Default: the active comp."),
  map: z.array(mapSchema).min(1).max(50).describe("Which column goes where."),
  mode: z
    .enum(["duplicate", "essentialGraphics"])
    .optional()
    .describe(
      '"duplicate" (layer targets): the comp is duplicated per row; every check can run. "essentialGraphics" (egp targets): per row a comp holds the ' +
        "template as a precomp with that row's Essential Graphics values; the row's layout can't be measured there. Default: from the targets.",
    ),
  name: z.string().optional().describe('Name pattern of the versions: {Column} = the row\'s cell, {#} = row number, {#3} = padded, {comp} = the template comp\'s name. Default "{comp} {#}".'),
  rows: z.string().optional().describe('Only these rows (1-based, in the data), e.g. "1-3,7". Default: all.'),
  folder: z.string().optional().describe('Project folder for the versions (made if missing). Default "<template> versions".'),
  checkAt: z.number().min(0).optional().describe("Time (seconds in the comp) where values are read back and sizes measured. Default: the last frame."),
  checks: z
    .object({
      overflow: z.boolean().optional().describe("Paragraph text must not overflow its box (default true; After Effects 24.6+)."),
      textMustBeIn: z.enum(["frame", "title", "action", "none"]).optional().describe('Mapped text must stay inside this area on every frame (default "frame"; title / action need the margin).'),
      title: margin.optional().describe("Title-safe margin per side, a fraction of the frame (from the user's spec)."),
      action: margin.optional().describe("Action-safe margin per side, a fraction of the frame (from the user's spec)."),
      glyphs: z.boolean().optional().describe("Every character of the row's text must exist in its font (default true; After Effects 25.1+)."),
      fonts: z.boolean().optional().describe("The mapped text layers' fonts must be installed (default true)."),
      sizeTolerancePx: z.number().min(0).optional().describe("kind size: allowed difference of the measured size, px (default 1)."),
      colorTolerance: z.number().min(0).max(255).optional().describe("kind color: allowed difference per channel in 8-bit steps (default 0.5)."),
      sampleEveryFrames: z.number().int().min(1).optional().describe("Layout checks on every Nth frame (default 1)."),
    })
    .strict()
    .optional()
    .describe("The checks of every row, beyond the values (which are always read back)."),
  footageFolder: z.string().optional().describe("Relative footage paths resolve against this folder (default: the data file's folder)."),
  dataDecimalSeparator: z.enum([".", ","]).optional().describe('The decimal separator of numbers written as text in the data (default ".").'),
  csvDelimiter: z.string().length(1).optional().describe("CSV field separator (default: comma, semicolon or tab, from the header line)."),
  queue: z
    .object({
      output: z.string().describe('Output path pattern, absolute, with {Column} / {#} like name, e.g. "/renders/{City}_{#3}.mov".'),
      outputModuleTemplate: z.string().optional().describe("The user's output module template."),
      renderSettingsTemplate: z.string().optional().describe("The user's render settings template."),
    })
    .strict()
    .optional()
    .describe("Add every version to the render queue."),
  render: z.boolean().optional().describe("Render the queued versions that PASS (blocks After Effects until done). Default false: only queued."),
  overwrite: z.boolean().optional().describe("Replace existing output files (default false: refuse)."),
  checkpoint: z.boolean().optional().describe("Save a project checkpoint first (see ae_checkpoint)."),
  dryRun: z.boolean().optional().describe("Only check the mapping against the template and the data, and show what each row would get. Changes nothing."),
  timeBudgetSeconds: z.number().min(5).max(600).optional().describe("Layout checks per row stop after this long (default 30)."),
  renderTimeoutSeconds: z.number().min(10).max(86400).optional().describe("With render: true (default 3600)."),
};

type Args = {
  data: string | Record<string, unknown>[];
  comp?: string | number;
  map: VMap[];
  mode?: Mode;
  name?: string;
  rows?: string;
  folder?: string;
  checkAt?: number;
  checks?: VChecks;
  footageFolder?: string;
  dataDecimalSeparator?: "." | ",";
  csvDelimiter?: string;
  queue?: { output: string; outputModuleTemplate?: string; renderSettingsTemplate?: string };
  render?: boolean;
  overwrite?: boolean;
  checkpoint?: boolean;
  dryRun?: boolean;
  timeBudgetSeconds?: number;
  renderTimeoutSeconds?: number;
};

const toJsxMap = (m: VMap): JsxMap => ({ layer: m.layer, egp: m.egp, kind: m.kind, property: m.property, axis: m.axis === "height" ? 1 : 0 });
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const parse = <T>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : v) as T;

/** What a row would get, for the dry run: "Score = "$1,200.00"; Bar width = 640 px". */
function planLine(p: Prep, map: VMap[], t: VTemplate["t"]): string {
  const parts = map.map((m, i) => {
    const e = p.expect.get(i), l = label(m, t[i]);
    if (!e) return null;
    switch (e.kind) {
      case "text":
        return `${l} = ${JSON.stringify(e.text).replace(/\\r/g, "↵")}`;
      case "num":
        return `${l} = ${e.value}`;
      case "color":
        return `${l} = ${hex(e.rgb)} (${e.why})`;
      case "keep":
        return `${l}: kept (${e.why})`;
      case "footage":
        return `${l} = ${e.path}`;
      case "value":
        return `${l} = ${JSON.stringify(e.raw)}`;
      case "size":
        return `${l} = ${Math.round(e.px * 10) / 10} px`;
    }
  });
  const probs = p.problems.map((f) => `PROBLEM ${f.where}: ${f.message}`);
  return `  ${String(p.n).padStart(3)}  ${p.name}${p.out ? ` -> ${p.out}` : ""}: ${[...parts.filter(Boolean), ...probs].join("; ")}`;
}

/** Everything that can be known before building: the table, the rows, the template and what each row gets. */
async function plan(a: Args) {
  const table: Table = loadTable(a.data, { delimiter: a.csvDelimiter });
  if (!table.rows.length) throw new Error(`${table.source} has no rows`);
  if (table.rows.length > MAX_ROWS) throw new Error(`${table.source} has ${table.rows.length} rows; at most ${MAX_ROWS} in one call (use rows: "1-${MAX_ROWS}", then the next ones)`);
  const picked = pickRows(a.rows, table.rows.length);
  const mode: Mode = a.mode ?? (a.map.every((m) => m.egp !== undefined) ? "essentialGraphics" : "duplicate");
  const checks = {
    overflow: a.checks?.overflow ?? mode === "duplicate",
    textMustBeIn: a.checks?.textMustBeIn ?? (mode === "duplicate" ? "frame" : "none"),
    glyphs: a.checks?.glyphs ?? mode === "duplicate",
    fonts: a.checks?.fonts ?? mode === "duplicate",
    ...a.checks,
  } as RowCheckChecks;
  const problems = mappingProblems(a.map, table, mode);
  const namePattern = a.name ?? "{comp} {#}";
  for (const c of [...patternColumns(namePattern), ...(a.queue ? patternColumns(a.queue.output) : [])])
    if (!table.columns.includes(c)) problems.push(`the pattern names {${c}}, which is not a column (columns: ${table.columns.join(", ")}), {#} or {comp}`);
  if ((checks.textMustBeIn === "title" || checks.textMustBeIn === "action") && checks[checks.textMustBeIn] === undefined)
    problems.push(`checks.textMustBeIn "${checks.textMustBeIn}" needs checks.${checks.textMustBeIn}: the margin from the user's spec`);
  if (a.render && !a.queue) problems.push("render: true needs queue (the output path pattern, and the user's templates)");
  if (problems.length) return { problems, table, picked, mode, checks } as const;

  // the template: every target resolved (read-only)
  const tr = await runJsx(VALIDATE_JSX, { template: a.comp, mode, map: a.map.map(toJsxMap), names: [], checkAt: a.checkAt }, { undoGroup: false, timeoutMs: 120_000 });
  if (!tr.ok) throw new Error(tr.error?.message ?? "the template comp could not be read");
  const template = parse<VTemplate>(tr.result);
  template.t.forEach((t, i) => t.err && problems.push(`map[${i}] (${a.map[i].column} -> ${label(a.map[i], t)}): ${t.err}`));
  const fd = template.comp.fd, checkAt = a.checkAt ?? Math.max(0, template.comp.dur - fd);
  if (checkAt > template.comp.dur) problems.push(`checkAt ${checkAt} s is past the end of "${template.comp.name}" (${Math.round(template.comp.dur * 1000) / 1000} s)`);

  const preps: Prep[] = [];
  for (const n of picked) {
    const row = table.rows[n - 1];
    const { name, out } = rowNames(n, row, namePattern, a.queue?.output, template.comp.name, table.columns);
    preps.push(
      prepareRow(n, row, a.map, {
        name,
        out,
        footageBase: a.footageFolder ?? table.dir,
        dataDecimal: a.dataDecimalSeparator,
        t: template.t,
        numericTarget: (i) => !!template.t[i]?.pt && template.t[i].pt !== "TEXT_DOCUMENT",
      }),
    );
  }
  // names and outputs: unique, and nothing already there is replaced
  const seen = new Map<string, number>();
  for (const p of preps) {
    if (!p.name.trim()) problems.push(`row ${p.n}: the name pattern gives an empty name`);
    if (seen.has(p.name)) problems.push(`rows ${seen.get(p.name)} and ${p.n} would both be named "${p.name}" (make the name pattern unique, e.g. add {#})`);
    seen.set(p.name, p.n);
  }
  if (a.queue) {
    const outs = new Map<string, number>();
    for (const p of preps) {
      const o = p.out!;
      if (!/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(o)) problems.push(`row ${p.n}: the output path ${o} is not absolute`);
      if (outs.has(o)) problems.push(`rows ${outs.get(o)} and ${p.n} would render to the same file ${o} (add {#} or a column to queue.output)`);
      outs.set(o, p.n);
      const taken = !a.overwrite && outputTaken(o);
      if (taken) problems.push(`row ${p.n}: a file already exists at ${taken}. To replace it, pass overwrite: true (or change queue.output)`);
    }
  }
  const cr = await runJsx(VALIDATE_JSX, { template: template.comp.id, mode, map: [], names: preps.map((p) => p.name) }, { undoGroup: false, timeoutMs: 120_000 });
  if (cr.ok) {
    const clash = parse<VTemplate>(cr.result).clash;
    if (clash.length)
      problems.push(
        `already in the project: ${clash.slice(0, 5).map((c) => `"${c}"`).join(", ")}${clash.length > 5 ? ` and ${clash.length - 5} more` : ""} ` +
          "(undo an earlier run with ae_undo, or change name)",
      );
  }
  return { problems, table, picked, mode, checks, template, preps, checkAt } as const;
}

type RowCheckChecks = Required<Pick<VChecks, "overflow" | "glyphs" | "fonts" | "textMustBeIn">> & VChecks;

/** Preflight's layout data of one version comp: its mapped text layers, and a pattern per size target. */
async function layoutOf(compId: number, a: Args, map: VMap[], t: VTemplate["t"], checks: RowCheckChecks) {
  const sizePatterns = new Map<number, number>(), patterns: string[] = [];
  map.forEach((m, i) => {
    if (m.kind === "size" && t[i]?.ln !== undefined) {
      sizePatterns.set(i, patterns.length);
      patterns.push(`^${escapeRe(t[i].ln!)}$`);
    }
  });
  const anyText = map.some((m, i) => (m.kind === "text" || m.kind === "number") && t[i]?.pt === "TEXT_DOCUMENT");
  const textAll = anyText && (checks.overflow || checks.textMustBeIn !== "none" || checks.glyphs);
  if (!textAll && !patterns.length) return { sizePatterns };
  const budget = a.timeBudgetSeconds ?? 30;
  const pa: PArgs = { comp: compId, step: checks.sampleEveryFrames ?? 1, textAll, bounds: textAll && checks.textMustBeIn !== "none", patterns, glyphs: textAll && checks.glyphs, timeBudgetSeconds: budget };
  try {
    const r = await runJsx(PREFLIGHT_JSX, pa, { undoGroup: false, timeoutMs: budget * 1000 + 60_000 });
    if (!r.ok) return { sizePatterns, error: r.error?.message ?? "unknown error" };
    return { sizePatterns, data: parse<PData>(r.result) };
  } catch (e: any) {
    return { sizePatterns, error: e?.message ?? String(e) };
  }
}

/** What runs on every row, in words (the report's second line). */
function checkedLine(map: VMap[], t: VTemplate["t"], mode: Mode, c: RowCheckChecks): string {
  const values = map.filter((m) => m.kind !== "size").length, sizes = map.filter((m) => m.kind === "size").length;
  const parts = [values && `${plural(values, "value")} read back`, sizes && `${plural(sizes, "size")} measured`];
  const anyText = map.some((m, i) => (m.kind === "text" || m.kind === "number") && (t[i]?.pt === "TEXT_DOCUMENT" || mode === "essentialGraphics"));
  if (anyText) {
    if (c.overflow) parts.push("box overflow");
    if (c.textMustBeIn !== "none") parts.push(`text inside ${c.textMustBeIn === "frame" ? "the frame" : `${c.textMustBeIn}-safe`} on every ${c.sampleEveryFrames && c.sampleEveryFrames > 1 ? `${c.sampleEveryFrames}th ` : ""}frame`);
    if (c.glyphs) parts.push("glyphs");
    if (c.fonts) parts.push("fonts");
  }
  return `checked per row: ${parts.filter(Boolean).join(", ")}`;
}

export async function runVersions(a: Args): Promise<CallToolResult> {
  const perm = permissions();
  if (!a.dryRun && perm.mode === "read-only") return errorResult(READ_ONLY_REFUSAL);
  const p = await plan(a);
  if (a.dryRun) {
    const head = p.problems.length ? `Dry run: ${plural(p.problems.length, "problem")}; nothing was changed.` : `Dry run: the mapping fits the template and the data; nothing was changed.`;
    const out = [head];
    if ("template" in p && p.template) {
      out.push(`${plural(p.preps!.length, "row")} of ${p.table.source} -> ${plural(p.preps!.length, "version")} of "${p.template.comp.name}" (mode ${p.mode}), values read back at ${formatAt(p.checkAt!, tbOf(p.template))}`);
      out.push(checkedLine(a.map, p.template.t, p.mode, p.checks));
    }
    if (p.problems.length) out.push("", "problems", ...p.problems.map((s) => `  - ${s}`));
    if ("preps" in p && p.preps) {
      const bad = p.preps.filter((r) => r.problems.length).length;
      out.push("", `rows${bad ? ` (${bad} with data problems: they would FAIL)` : ""}`, ...p.preps.map((r) => planLine(r, a.map, p.template!.t)));
    }
    return { content: [{ type: "text", text: capText(out.join("\n")) }] };
  }
  if (p.problems.length || !("preps" in p) || !p.preps) return errorResult(`Nothing was built:\n- ${p.problems.join("\n- ")}\n(dryRun: true shows what each row would get.)`);
  const { template, preps, mode, checks, checkAt, table } = p;

  let cp = "";
  if (a.checkpoint) {
    const c = await saveCheckpoint("before-versions");
    cp = `Checkpoint saved first: ${c.file}\n${c.note ? `${c.note}\n` : ""}`;
  }
  const folder = a.folder ?? `${template.comp.name} versions`;
  const showReport = loadConfig().changeReport !== false;
  const b = await runJsx(
    BUILD_JSX,
    {
      template: template.comp.id,
      mode,
      folder,
      checkAt,
      map: a.map.map(toJsxMap),
      rows: preps.map((r) => ({ n: r.n, name: r.name, sets: r.sets, out: r.out })),
      queue: a.queue ? { outputModuleTemplate: a.queue.outputModuleTemplate, renderSettingsTemplate: a.queue.renderSettingsTemplate } : undefined,
      overwrite: !!a.overwrite,
    },
    {
      undoGroup: "Versions from data",
      timeoutMs: 120_000 + preps.length * 10_000,
      // compared before and after: the Changes list, and what makes the rollback of a failed build safe
      report: reportScope({ comp: template.comp.id }) ?? [template.comp.id],
      rollback: "requested",
      bridge:
        perm.mode === "ask"
          ? {
              approval: {
                tool: "Versions from data",
                summary:
                  `Build ${plural(preps.length, "version")} of "${template.comp.name}" from ${table.source} (${mode}) in folder "${folder}"` +
                  `${a.queue ? `, queue them${a.render ? " and render the ones that pass" : ""}` : ""}:\n` +
                  preps.slice(0, 20).map((r) => `${r.n}. ${r.name}`).join("\n") +
                  (preps.length > 20 ? `\n... ${preps.length - 20} more` : ""),
              },
            }
          : undefined,
    },
  );
  if (!b.ok) return formatResult(b);
  const built = parse<VBuilt>(b.result);
  const changes = showReport ? formatChanges(b.changes) : null;
  if (built.fatal) {
    const rb = b.rollback ?? { undone: false, verified: false, problem: "no result" };
    const undo = !rb.verified ? rollbackProblem(rb, "the build") : rb.undone ? "It was rolled back: nothing was built." : "It hadn't changed anything yet.";
    return { isError: true, content: [{ type: "text", text: `${cp}The build stopped: ${built.fatal}\n${undo}${!rb.verified && changes && changes !== "Changes: none" ? `\n\n${changes}` : ""}` }] };
  }

  // the checks: per version comp, Preflight's layout data; X-ray's font list once
  const wantFonts = mode === "duplicate" && checks.fonts && a.map.some((m, i) => (m.kind === "text" || m.kind === "number") && template.t[i]?.pt === "TEXT_DOCUMENT");
  let fonts: { x?: XData; error?: string } | undefined;
  if (wantFonts) {
    try {
      const xr = await runJsx(XRAY_JSX, { sections: ["missing"], comps: built.rows.map((r) => r.id), timeBudgetSeconds: 90 }, { undoGroup: false, timeoutMs: 300_000 });
      fonts = xr.ok ? { x: parse<XData>(xr.result) } : { error: xr.error?.message };
    } catch (e: any) {
      fonts = { error: e?.message ?? String(e) };
    }
  }
  const results: RowResult[] = [];
  for (const [k, row] of built.rows.entries()) {
    const prep = preps.find((r) => r.n === row.n) ?? preps[k];
    const layout = mode === "duplicate" ? await layoutOf(row.id, a, a.map, template.t, checks) : undefined;
    results.push(checkRow({ prep, built: row, map: a.map, template, mode, checks, checkAt, layout, fonts }));
  }

  // render: only the rows that pass, only when asked
  const tb = tbOf(template);
  const renderLines: string[] = [];
  if (a.queue) {
    const queued = built.rows.filter((r) => r.rq?.i !== undefined);
    renderLines.push(`render queue: ${plural(queued.length, "version")} queued${a.queue.outputModuleTemplate ? ` with "${a.queue.outputModuleTemplate}"` : ""}${queued[0]?.rq?.file ? `, e.g. ${queued[0].rq.file}` : ""}`);
    if (a.render) {
      const pass = new Set(results.filter((r) => r.verdict === "PASS").map((r) => r.n));
      const only = queued.filter((r) => pass.has(r.n)).map((r) => r.rq!.i!);
      const held = queued.filter((r) => !pass.has(r.n)).map((r) => r.n);
      if (!only.length) renderLines.push("not rendered: no row passed");
      else {
        const rr = await runJsx(RENDER_QUEUE_JSX, { only }, {
          undoGroup: false,
          timeoutMs: (a.renderTimeoutSeconds ?? 3600) * 1000,
          bridge: perm.mode === "ask" ? { approval: { tool: "Render versions", summary: `Render ${plural(only.length, "version")} that passed (render queue items ${only.join(", ")})` } } : undefined,
        });
        if (!rr.ok) renderLines.push(`render failed: ${rr.error?.message ?? "unknown error"}`);
        else {
          const st = parse<{ index: number; comp: string; status: string; file: string | null }[]>(rr.result);
          const done = st.filter((s) => s.status === "DONE");
          renderLines.push(`rendered: ${done.length} of ${only.length}${done.length < only.length ? ` (not done: ${st.filter((s) => s.status !== "DONE").map((s) => `${s.comp} ${s.status}`).join(", ")})` : ""}`);
        }
      }
      if (held.length) renderLines.push(`not rendered (did not pass; still queued): rows ${held.join(", ")}`);
    } else renderLines.push("not rendered (render: true renders the versions that pass)");
  }

  const notes = [...new Set(results.flatMap((r) => r.notes))];
  const out = [
    runVerdict(results),
    `${plural(results.length, "version")} of "${template.comp.name}" from ${table.source} (mode ${mode}) in folder "${built.folder}", values read back at ${formatAt(checkAt, tb)}`,
    checkedLine(a.map, template.t, mode, checks),
    totalsLine(results),
    "",
    "rows",
    ...results.map((r) => rowLine(r, tb)),
  ];
  if (renderLines.length) out.push("", ...renderLines);
  if (notes.length) out.push("", "notes", ...notes.slice(0, 12).map((n) => `  - ${n}`), ...(notes.length > 12 ? [`  - ... ${notes.length - 12} more`] : []));
  out.push("", "One ae_undo removes every version (and their render queue items).");
  // the verdict stays the first line (the activity log and the panel read it there)
  if (cp) out.push(cp.trimEnd());
  return { content: [{ type: "text", text: capText(out.join("\n")) + (changes ? `\n\n${capText(changes)}` : "") }] };
}

const tbOf = (t: VTemplate): TimeBase => ({ fps: t.comp.fps, dropFrame: !!t.comp.df, offset: t.comp.dst ?? 0 });

export function registerVersionsTools(server: McpServer) {
  server.registerTool(
    "ae_versions_from_data",
    {
      title: "Versions from data",
      description:
        "Turn a CSV / JSON file (or inline rows) into versions of a template comp, then check every row. Columns map to layers (or Essential " +
        "Graphics controllers): text, numbers in the user's format, colours from the cell or the user's rules, footage files, any property value, " +
        "a bar's on-screen size through the user's value-to-pixels mapping. One undo step; returns the Changes list. Every row is then checked: " +
        "each value read back where it renders, text box overflow and text inside the frame / title-safe (Preflight's measuring), missing glyphs " +
        "and fonts, bar sizes measured on screen, footage files present. One line per row: PASS, FAIL (n) with what and where, or INCOMPLETE " +
        "(a check that didn't run is never a pass). Optional: queue the versions with the user's output module and path pattern, and render " +
        "the ones that pass. dryRun: true checks the mapping against the template and the data and changes nothing.",
      inputSchema,
      // writes many comps (one undo step); with render and overwrite: true it replaces files on disk
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args: Args) => {
      try {
        return await runVersions(args);
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
