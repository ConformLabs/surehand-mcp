// ae_stress_test: the checks of one variant, from what the scratch copy measured. Layout comes from Preflight's own
// checks (src/preflight/project.ts: box overflow, safe areas over time, cap height, glyphs) on Preflight's collected
// data; the rest is measured here: how far a paragraph overflows (the tall-box measurement), lines and breaks inside a
// word, the size the text renders at, a substituted font, direction and composer for right-to-left and complex
// scripts, overlap with the layers the user names, a number set on a control and the text that shows it, media that no
// longer covers its area, expression errors. What already fails without any variant (the baseline) is reported once,
// not as the variant's fault. Unit-tested in test/stress.test.ts.
import { boundsThrough, checkItems, trackAt, verticalScale, CAP_RATIO, type Box, type PData, type PItem } from "../preflight/project.js";
import type { Finding, Spec } from "../preflight/spec.js";
import { formatNumber, parseNumber } from "../versions/data.js";
import type { Target, Variant } from "./cases.js";
import type { RunResultJ, TextExtra } from "./jsx.js";

export type Rect = [number, number, number, number];
/** The checks: the view's columns (fit, safe, size, glyphs, lines) and "other" (numbers, values, expressions). */
export const COLUMNS = ["fit", "safe", "size", "glyphs", "lines"] as const;
export type Column = (typeof COLUMNS)[number] | "other";
export type Cell = "ok" | "bad" | "warn" | "na";

export interface SFinding {
  check: string;
  column: Column;
  severity: "fail" | "warn";
  message: string;
  /** the layer of the comp (or "Comp > Precomp > Layer" when nested) */
  layer?: string;
  layerIndex?: number;
  /** the first frame it shows at, and the last of its run */
  frame?: number;
  frameEnd?: number;
  /** comp pixels: the layer's bounds there, the paragraph box, the area it must stay in */
  box?: Rect;
  textBox?: Rect;
  area?: { name: "title" | "action" | "frame"; rect: Rect };
  /** measured amount in comp px (overflow, overshoot, overlap) */
  amountPx?: number;
}

export interface MeasuredLayer {
  layer: string;
  layerIndex: number;
  text: string;
  font?: string;
  /** the font size, and the size it renders at in the comp (through scale) */
  fontSize?: number;
  renderedPx?: number;
  lines?: number;
  linesNeeded?: number;
  overflowPx?: number;
  /** bounds at the first sampled frame it is visible, comp px */
  box?: Rect;
  textBox?: Rect;
  direction?: string;
  composer?: string;
  substituted?: boolean;
}

export interface SChecks {
  overflow: boolean;
  safeArea: "frame" | "title" | "action" | "none";
  title?: number | { x: number; y: number };
  action?: number | { x: number; y: number };
  minCapHeightPx?: number;
  minFontSizePx?: number;
  glyphs: boolean;
  lines: boolean;
  maxLines?: Record<string, number>;
  /** point text: the most width it may take, comp px, by layer name (the user's) */
  maxWidthPx?: Record<string, number>;
  overlap?: string[];
  numbers: boolean;
  direction: boolean;
}

export interface Measured {
  findings: SFinding[];
  layers: MeasuredLayer[];
  /** checks that couldn't run for this variant (cell "na" with a reason) */
  notRun: { column: Column; reason: string }[];
  notes: string[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const rect = (b: Box | null): Rect | undefined => (b ? [Math.round(b.x0), Math.round(b.y0), Math.round(b.x1), Math.round(b.y1)] : undefined);
const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const INDIC = /[ऀ-෿]/;
const THAI = /[฀-๿]/;
const LETTER = /[\p{L}\p{M}]/u;
const SPACED = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]/u;

/** "Main [stress test] > 2: Title" -> "Title"; nested: "Lower third > 1: Name" (the scratch comp's name left out) */
export function layerOf(w: string, scratch: string): { name: string; index?: number } {
  const head = `${scratch} > `;
  const rest = w.startsWith(head) ? w.slice(head.length) : w;
  const parts = rest.split(" > ");
  const strip = (p: string) => p.replace(/^\d+: /, "");
  if (parts.length === 1) {
    const m = /^(\d+): ([\s\S]*)$/.exec(parts[0]);
    return m ? { name: m[2], index: Number(m[1]) } : { name: parts[0] };
  }
  const top = /^(\d+): /.exec(parts[0]);
  return { name: parts.map(strip).join(" › "), index: top ? Number(top[1]) : undefined };
}

/** Comp px bounds of an item at visible sample k (null: 3D, not visible, no bounds read). */
function boxAt(it: PItem, k: number): Box | null {
  if (!it.rect || !it.lv || it.d3 || k < 0) return null;
  return boundsThrough(trackAt(it.rect, k), it.lv, k);
}

/** A number as a text shows it, read back: "1,234,567.89", "1.234.567,89", "(5)", "-€4.50" -> number. */
export function readShownNumber(s: string): number | null {
  const neg = /^[^\d]*[-−(]/.test(s.trim());
  let t = s.replace(/[^\d.,'’\s]/g, "").trim().replace(/['’\s]/g, "");
  if (!/\d/.test(t)) return null;
  const lastDot = t.lastIndexOf("."), lastComma = t.lastIndexOf(",");
  const dec = lastDot > lastComma ? "." : lastComma > lastDot ? "," : null;
  if (dec) {
    const other = dec === "." ? "," : ".";
    const after = t.length - t.lastIndexOf(dec) - 1;
    // one separator, three digits after it and no other kind: a thousands separator ("1,234")
    const count = t.split(dec).length - 1;
    if (count > 1 || (!t.includes(other) && after === 3 && count === 1 && dec === ",")) t = t.split(dec).join("");
    else t = t.split(other).join("").replace(dec, ".");
  }
  const n = Number(t);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}
const decimalsOf = (s: string) => {
  const m = /[.,](\d+)\D*$/.exec(s.trim());
  return m && !/^\d{3}$/.test(m[1]) ? m[1].length : 0;
};

export interface MeasureInput {
  variant: Variant | null;
  targets: Target[];
  /** what the variant's targets are, by index into targets */
  targetIndex: Map<string, number>;
  res: RunResultJ["results"][number];
  data?: PData;
  baseline?: { data?: PData; x: TextExtra[]; ee?: RunResultJ["results"][number]["ee"] };
  checks: SChecks;
  /** the scratch comp's name (stripped from layer paths) */
  scratch: string;
  /** overlap patterns' indexes in PArgs.patterns (the overlap layers), and media layers' */
  overlapPatterns: number[];
  mediaPatterns: Map<number, number>;
}

/** Everything one variant (or the baseline, variant null) measured, as findings and per-layer numbers. */
export function measureVariant(o: MeasureInput): Measured {
  const findings: SFinding[] = [], notRun: Measured["notRun"] = [], notes: string[] = [], layers: MeasuredLayer[] = [];
  const { res, data: d, checks } = o;
  const fd = d?.comp.fd ?? 1 / 25;
  const frameOf = (t: number) => Math.round(t / fd);
  const frameAt = (at: Finding["at"]) => (at === undefined ? {} : Array.isArray(at) ? { frame: frameOf(at[0]), frameEnd: frameOf(at[1]) } : { frame: frameOf(at) });
  const sampleOf = (i: number) => (d?.fr ? d.fr[i] : i * (d?.step ?? 1));
  const targetLayers = new Set<number>();
  for (const s of o.variant?.sets ?? []) {
    const t = o.targets[o.targetIndex.get(s.target)!];
    if (t?.layer) targetLayers.add(t.layer);
  }

  // values that could not be set, or that After Effects kept differently
  for (const [ti, msg] of res.err) {
    const t = o.targets[ti];
    findings.push({ check: "set", column: "other", severity: "fail", layer: t?.layerName, layerIndex: t?.layer, message: `${t?.name ?? "the control"} could not be set: ${msg}` });
  }
  for (const [ti, got] of res.rb) {
    const t = o.targets[ti], want = o.variant?.sets.find((s) => o.targetIndex.get(s.target) === ti)?.value;
    if (!t || want === undefined) continue;
    if ((t.kind === "number" || t.kind === "dropdown" || t.kind === "checkbox") && typeof want === "number" && typeof got === "number") {
      if (Math.abs(got - want) > 1e-6 * Math.max(1, Math.abs(want)))
        findings.push({ check: "number.input", column: "other", severity: "fail", layer: t.layerName, layerIndex: t.layer, message: `${t.name} set to ${want}; After Effects keeps ${got} (the control's range): this input can't be entered` });
    }
  }

  if (!d) {
    notRun.push(...COLUMNS.map((c) => ({ column: c, reason: `the layout could not be read: ${res.pfErr ?? "no data"}` })));
    return { findings, layers, notRun, notes };
  }

  // Preflight's own checks on the copy: overflow, safe areas over time, cap height, glyphs
  const spec: Spec = {
    safeAreas: checks.safeArea !== "none" ? { textMustBeIn: checks.safeArea, ...(checks.title !== undefined ? { title: checks.title } : {}), ...(checks.action !== undefined ? { action: checks.action } : {}) } : { textMustBeIn: "none" },
    text: { noOverflow: checks.overflow, glyphs: checks.glyphs, ...(checks.minCapHeightPx !== undefined ? { minCapHeightPx: checks.minCapHeightPx } : {}) },
  } as Spec;
  const textItems = d.items.filter((it) => it.t);
  const pr = checkItems(spec, { ...d, items: textItems });
  const column = (check: string): Column => (check === "text.overflow" ? "fit" : check.startsWith("safeAreas") ? "safe" : check === "text.capHeight" ? "size" : check === "text.glyphs" ? "glyphs" : "other");
  const xOf = (li?: number) => res.x.find((x) => x.li === li);
  for (const f of pr.findings) {
    if (f.check === "preflight.partial") {
      notes.push(f.message);
      continue;
    }
    if (f.severity === "info") continue;
    const L = f.where ? layerOf(f.where, o.scratch) : { name: undefined as string | undefined, index: undefined as number | undefined };
    const nested = !!f.where && f.where.split(" > ").length > 2;
    const sf: SFinding = { check: f.check, column: column(f.check), severity: f.severity, message: f.message, layer: L.name, layerIndex: L.index, ...frameAt(f.at), ...(f.box ? { box: f.box } : {}), ...(f.area ? { area: f.area } : {}) };
    if (f.check.startsWith("safeAreas.") && f.check !== "safeAreas.3d" && f.check !== "safeAreas.autoOrient" && f.check !== "safeAreas.bounds") {
      const m = /by up to (\d+) px/.exec(f.message);
      if (m) sf.amountPx = Number(m[1]);
    }
    // overflow: by how much, and how many lines it needs (the tall-box measurement)
    if (f.check === "text.overflow" && !nested) {
      const it = textItems.find((x) => x.w === f.where);
      const x = xOf(L.index);
      const t0 = Array.isArray(f.at) ? f.at[0] : (f.at ?? 0);
      const gi = d.fr ? d.fr.indexOf(frameOf(t0)) : Math.round(t0 / (fd * d.step));
      const k = Math.max(0, it ? it.i.indexOf(gi) : 0);
      if (it && x?.box) {
        const tb = boxAt(it, k) && it.lv ? boundsThrough([x.bpos?.[0] ?? trackAt(it.rect!, k)[0], x.bpos?.[1] ?? trackAt(it.rect!, k)[1], x.box[0], x.box[1]], it.lv, k) : null;
        if (tb) sf.textBox = rect(tb);
        sf.box = rect(boxAt(it, k)) ?? sf.box;
      }
      if (x?.need && x.box) {
        const top = x.bpos?.[1] ?? x.need[0];
        const over = x.need[0] + x.need[1] - (top + x.box[1]);
        const scale = it?.lv ? verticalScale(it.lv, k) : 1;
        if (over > 0) {
          sf.amountPx = Math.round(over * scale);
          const lines = x.linesNeed !== undefined && x.lines !== undefined ? `; ${x.linesNeed} lines, the box shows ${x.lines}` : "";
          sf.message = `overflows its box by ${sf.amountPx} px${lines} (text is cut off)`;
        }
      }
    }
    findings.push(sf);
  }
  if (checks.overflow && d.feat.box && !d.feat.overflow) notRun.push({ column: "fit", reason: "box overflow needs After Effects 24.6 or later" });
  if (checks.glyphs && textItems.length && !d.feat.glyphs) notRun.push({ column: "glyphs", reason: "glyph coverage needs After Effects 25.1 or later" });

  // per layer: what it shows, its size on screen, lines
  const scratchHead = `${o.scratch} > `;
  for (const x of res.x) {
    const it = textItems.find((i) => i.w === `${scratchHead}${x.li}: ${x.ln}`);
    const k = it && it.i.length ? 0 : -1;
    const scale = it?.lv && k >= 0 ? verticalScale(it.lv, k) : undefined;
    const ml: MeasuredLayer = { layer: x.ln, layerIndex: x.li, text: x.text, font: x.font, fontSize: x.fs, ...(scale !== undefined && x.fs !== undefined ? { renderedPx: r1(x.fs * scale) } : {}) };
    if (x.lines !== undefined) ml.lines = x.lines;
    if (x.linesNeed !== undefined) ml.linesNeeded = x.linesNeed;
    if (x.dir) ml.direction = x.dir;
    if (x.ce) ml.composer = x.ce;
    if (x.sub) ml.substituted = true;
    if (it && k >= 0) ml.box = rect(boxAt(it, k));
    const over = findings.find((f) => f.check === "text.overflow" && f.layerIndex === x.li)?.amountPx;
    if (over !== undefined) ml.overflowPx = over;
    layers.push(ml);
  }
  const base = new Map((o.baseline?.x ?? []).map((x) => [x.li, x]));
  const changed = (x: TextExtra) => base.has(x.li) && base.get(x.li)!.text !== x.text;
  const relevant = (x: TextExtra) => targetLayers.has(x.li) || changed(x) || !o.variant;

  // font substituted, direction, composer
  for (const x of res.x) {
    if (!relevant(x)) continue;
    if (x.sub && checks.glyphs) findings.push({ check: "text.font", column: "glyphs", severity: "fail", layer: x.ln, layerIndex: x.li, message: `font ${x.font} is not installed: After Effects shows a substitute` });
    if (!checks.direction || !o.variant || !targetLayers.has(x.li)) continue;
    if (RTL.test(x.text) && x.dir && x.dir !== "RIGHT_TO_LEFT")
      findings.push({ check: "text.direction", column: "glyphs", severity: "warn", layer: x.ln, layerIndex: x.li, message: "right-to-left text in a left-to-right paragraph: numbers and punctuation land on the wrong side", frame: frameOf(x.t) });
    if (x.ce && x.ce !== "UNIVERSAL_TYPE_ENGINE") {
      const script = ARABIC.test(x.text) ? "Arabic" : INDIC.test(x.text) ? "Devanagari" : THAI.test(x.text) ? "Thai" : null;
      if (script)
        findings.push({ check: "text.composer", column: "glyphs", severity: script === "Thai" ? "warn" : "fail", layer: x.ln, layerIndex: x.li, frame: frameOf(x.t), message: `${script} with the ${x.ce === "LATIN_CJK_ENGINE" ? "Latin and East Asian" : x.ce} composer: ${script === "Arabic" ? "the letters don't join" : "vowel signs and conjuncts aren't shaped"} (it needs the Universal composer)` });
    }
  }

  // lines: breaks inside a word, the user's line limit
  if (checks.lines) {
    let any = false;
    for (const x of res.x) {
      if (!relevant(x) || !o.variant) continue;
      if (x.lines === undefined) continue;
      any = true;
      const max = checks.maxLines?.[x.ln];
      if (max !== undefined && x.lines > max)
        findings.push({ check: "text.lines", column: "lines", severity: "fail", layer: x.ln, layerIndex: x.li, frame: frameOf(x.t), message: `${x.lines} lines; the limit is ${max}` });
      const chars = Array.from(x.text);
      for (const e of x.ends ?? []) {
        const a = x.text[e - 1] ?? "", b = x.text[e] ?? "";
        if (e > 0 && e < x.text.length && LETTER.test(a) && LETTER.test(b) && SPACED.test(a) && SPACED.test(b)) {
          const at = x.text.slice(0, e).search(/\S+$/), word = (x.text.slice(at, e) + "|" + x.text.slice(e).split(/\s/)[0]).slice(0, 40);
          findings.push({ check: "text.break", column: "lines", severity: "warn", layer: x.ln, layerIndex: x.li, frame: frameOf(x.t), message: `breaks inside a word: "${word}"` });
          break;
        }
      }
      void chars;
    }
    if (o.variant && !any && [...targetLayers].some((li) => res.x.some((x) => x.li === li))) notRun.push({ column: "lines", reason: "line count needs After Effects 24.3 or later (composedLineCount)" });
  }

  // the size it renders at: the user's minimum, or smaller than the comp's own text
  if (o.variant) {
    for (const ml of layers) {
      if (!targetLayers.has(ml.layerIndex) && !changed(res.x.find((x) => x.li === ml.layerIndex)!)) continue;
      if (ml.renderedPx === undefined) continue;
      if (checks.minFontSizePx !== undefined && ml.renderedPx < checks.minFontSizePx - 0.05)
        findings.push({ check: "text.size", column: "size", severity: "fail", layer: ml.layer, layerIndex: ml.layerIndex, message: `renders at ${ml.renderedPx} px (minimum ${checks.minFontSizePx} px)`, box: ml.box });
      else {
        const b = o.baseline?.data && o.baseline.x.find((x) => x.li === ml.layerIndex);
        const bit = b && o.baseline!.data!.items.find((i) => i.w === `${scratchHead}${b.li}: ${b.ln}`);
        const bpx = b && bit?.lv && bit.i.length && b.fs !== undefined ? r1(b.fs * verticalScale(bit.lv, 0)) : undefined;
        if (bpx !== undefined && ml.renderedPx < bpx - 0.5)
          findings.push({ check: "text.shrink", column: "size", severity: "warn", layer: ml.layer, layerIndex: ml.layerIndex, message: `renders at ${ml.renderedPx} px (${bpx} px with the comp's own text): something scales it down to fit`, box: ml.box });
      }
    }
    if (checks.minCapHeightPx !== undefined) notes.push(`cap height is estimated as ${CAP_RATIO} x font size x scale`);
  }

  // overlap with the layers the user named
  if (checks.overlap?.length && o.variant) {
    const others = d.items.filter((it) => it.m?.some((m) => o.overlapPatterns.includes(m)));
    for (const it of textItems) {
      const L = layerOf(it.w, o.scratch);
      if (L.index === undefined || !targetLayers.has(L.index) || it.w.split(" > ").length > 2) continue;
      let hit: { f: number; w: number; h: number; other: string; box: Box } | null = null;
      it.i.forEach((gi, k) => {
        if (hit) return;
        const a = boxAt(it, k);
        if (!a) return;
        for (const ot of others) {
          if (ot === it) continue;
          const k2 = ot.i.indexOf(gi), b = boxAt(ot, k2);
          if (!b) continue;
          const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
          if (w > 0.5 && h > 0.5) hit = { f: sampleOf(gi), w, h, other: ot.n, box: a };
        }
      });
      const h = hit as { f: number; w: number; h: number; other: string; box: Box } | null;
      if (h) findings.push({ check: "overlap", column: "safe", severity: "fail", layer: L.name, layerIndex: L.index, frame: h.f, box: rect(h.box), amountPx: Math.round(Math.min(h.w, h.h)), message: `overlaps ${h.other} by ${Math.round(h.w)} x ${Math.round(h.h)} px` });
    }
  }

  // point text wider than the user allows
  if (checks.maxWidthPx && o.variant) {
    for (const it of textItems) {
      const L = layerOf(it.w, o.scratch), max = L.index !== undefined ? checks.maxWidthPx[it.n] : undefined;
      if (max === undefined || it.w.split(" > ").length > 2 || !targetLayers.has(L.index!)) continue;
      let worst: { w: number; f: number; b: Box } | null = null;
      it.i.forEach((gi, k) => {
        const b = boxAt(it, k);
        if (b && b.x1 - b.x0 > max + 0.5 && (!worst || b.x1 - b.x0 > worst.w)) worst = { w: b.x1 - b.x0, f: sampleOf(gi), b };
      });
      const w = worst as { w: number; f: number; b: Box } | null;
      if (w) findings.push({ check: "text.width", column: "fit", severity: "fail", layer: L.name, layerIndex: L.index, frame: w.f, box: rect(w.b), amountPx: Math.round(w.w - max), message: `is ${Math.round(w.w)} px wide; the most it may take is ${max} px (over by ${Math.round(w.w - max)} px)` });
    }
  }

  // media that no longer covers the area the comp's own media covered
  if (o.variant && o.baseline?.data) {
    for (const s of o.variant.sets) {
      const ti = o.targetIndex.get(s.target)!, t = o.targets[ti];
      if (t?.kind !== "media" || !t.layer) continue;
      const pat = o.mediaPatterns.get(ti);
      const now = d.items.find((it) => it.m?.includes(pat!) && it.w.split(" > ").length === 2);
      const was = o.baseline.data.items.find((it) => it.m?.includes(pat!) && it.w.split(" > ").length === 2);
      if (!now || !was || !now.i.length || !was.i.length) continue;
      const a = boxAt(now, 0), b = boxAt(was, 0);
      if (!a || !b) continue;
      const gaps = { left: Math.max(0, a.x0 - b.x0), right: Math.max(0, b.x1 - a.x1), top: Math.max(0, a.y0 - b.y0), bottom: Math.max(0, b.y1 - a.y1) };
      const worst = Math.max(gaps.left, gaps.right, gaps.top, gaps.bottom);
      if (worst > 0.5) {
        const sides = (Object.keys(gaps) as (keyof typeof gaps)[]).filter((k) => gaps[k] > 0.5).join(" and ");
        findings.push({ check: "media.cover", column: "fit", severity: "fail", layer: t.layerName, layerIndex: t.layer, frame: sampleOf(now.i[0]), box: rect(a), textBox: rect(b), amountPx: Math.round(worst), message: `leaves up to ${Math.round(worst)} px of its area uncovered (${sides})` });
      }
    }
  }

  // numbers: the input on the control, and the text that shows it
  if (checks.numbers && o.variant) {
    for (const s of o.variant.sets) {
      const t = o.targets[o.targetIndex.get(s.target)!];
      if (t?.kind !== "number" || typeof s.value !== "number") continue;
      // a value the control didn't keep is reported above; the text is checked against what the control holds
      const got = res.rb.find(([ti]) => ti === o.targetIndex.get(s.target))?.[1];
      const input = typeof got === "number" ? got : s.value;
      const shows = res.x.filter((x) => changed(x));
      for (const x of shows) {
        const msg = numberProblem(x.text, input, t.numberFormat);
        if (msg) findings.push({ check: "number.format", column: "other", severity: "fail", layer: x.ln, layerIndex: x.li, frame: frameOf(x.t), message: msg });
      }
    }
  }

  // expressions in error
  const baseErr = new Set((o.baseline?.ee ?? []).map((e) => `${e[0]}|${e[2]}`));
  for (const [li, ln, prop, err] of res.ee)
    if (!baseErr.has(`${li}|${prop}`)) findings.push({ check: "expression.error", column: "other", severity: "fail", layer: ln, layerIndex: li, message: `expression error on ${prop}: ${err}` });
  return { findings, layers, notRun, notes };
}

/** What is wrong with how a text shows the number `input` (null: fine). The user's format, when given, exactly. */
export function numberProblem(shown: string, input: number, format?: import("../versions/data.js").NumberFormat): string | null {
  const q = JSON.stringify(shown.length > 40 ? shown.slice(0, 40) + "…" : shown);
  if (/NaN|undefined|Infinity|null|\[object/i.test(shown)) return `shows ${q} for ${input}`;
  if (/\d[eE][+-]?\d/.test(shown)) return `shows ${q} for ${input}: scientific notation`;
  if (format) {
    const want = formatNumber(input, format);
    return shown.trim() === want ? null : `shows ${q} for ${input}; your format gives "${want}"`;
  }
  const got = readShownNumber(shown);
  if (got === null) return null;
  if (input < 0 && got >= 0 && !/[-−(]/.test(shown)) return `shows ${q} for ${input}: the minus sign is lost`;
  const dec = decimalsOf(shown);
  const tol = 0.5 * 10 ** -dec + 1e-9 * Math.max(1, Math.abs(input));
  if (Math.abs(Math.abs(got) - Math.abs(input)) > tol) return `shows ${q} for ${input} (reads as ${got})`;
  return null;
}

/** A finding's identity for the baseline comparison: the same check on the same layer. */
export const findingKey = (f: SFinding) => `${f.check}|${f.layerIndex ?? f.layer ?? ""}`;

/** The view's cell per column: bad over warn over ok; "na" when the check didn't run or doesn't apply. */
export function cells(m: Measured, applies: Record<Column, boolean>): Record<Column, Cell> {
  const out = {} as Record<Column, Cell>;
  for (const c of [...COLUMNS, "other"] as Column[]) {
    const fs = m.findings.filter((f) => f.column === c);
    out[c] = fs.some((f) => f.severity === "fail") ? "bad" : fs.some((f) => f.severity === "warn") ? "warn" : m.notRun.some((n) => n.column === c) || !applies[c] ? "na" : "ok";
  }
  return out;
}

export { parseNumber };
