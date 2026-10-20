// The Preflight report as data for the in-chat view (src/views/preflight.ts): the same verdict and findings
// as the text report, plus what the text leaves implicit: which requested checks passed, which the target
// couldn't run, the layer bounds behind a safe-area finding, and timecode for every time.
import { basename } from "node:path";
import type { PreflightFinding, PreflightView } from "../views/types.js";
import { areaMargins, type Finding, type NotRun, type Spec } from "./spec.js";
import { notRunCount, timecode, type TimeBase } from "./report.js";

/** At most this many findings go to the view (the result has to stay small; the text has its own limit). */
export const MAX_VIEW_FINDINGS = 200;

/** A check the spec asks for: its name in the view and the finding / not-run checks that mean it didn't pass. */
interface Requested {
  label: string;
  checks: string[];
  on: "project" | "file";
  /** checked on both (frame size, rate...): the project's and the file's are the same check of the spec */
  both?: true;
}

const AREA_LABEL = { title: "title safe", action: "action safe", frame: "inside the frame" } as const;
// a partial read, a 3D or auto-oriented layer, or bounds that may be off: those checks can't be called passed
const PROJECT_PARTIAL = ["project.partial"];
const FRAME_PARTIAL = ["preflight.partial", "safeAreas.3d", "safeAreas.autoOrient", "safeAreas.bounds"];
// the file couldn't be read, or only in part
const FILE_BROKEN = ["file", "file.decode"];

/** Every check the spec asks for, project and file, as the view names them. */
export function requestedChecks(spec: Spec): Requested[] {
  const out: Requested[] = [];
  const add = (on: Requested["on"], label: string, checks: string[], both?: true) => {
    if (!out.some((r) => r.label === label && r.on === on)) out.push({ on, label, checks: on === "file" ? [...checks, ...FILE_BROKEN] : checks, ...(both ? { both } : {}) });
  };
  const pair = (label: string, project: string, file: string[]) => (add("project", label, [project], true), add("file", `file ${label}`, file, true));
  const v = spec.video;
  if (v) {
    if (v.width !== undefined || v.height !== undefined) pair("frame size", "video.size", ["file.size", "file.video"]);
    if (v.frameRate !== undefined) pair("frame rate", "video.frameRate", ["file.frameRate", "file.video"]);
    if (v.pixelAspect !== undefined) pair("pixel aspect", "video.pixelAspect", ["file.pixelAspect", "file.video"]);
    if (v.duration !== undefined) pair("duration", "video.duration", ["file.duration"]);
    if (v.codec) add("file", "codec", ["file.codec", "file.video"]);
    if (v.container) add("file", "container", ["file.container"]);
    if (v.bitDepth !== undefined) add("file", "bit depth", ["file.bitDepth", "file.video"]);
    if (v.chromaSubsampling) add("file", "chroma subsampling", ["file.chroma", "file.video"]);
    if (v.alpha !== undefined) add("file", "alpha", ["file.video"]);
    if (v.fieldOrder) add("file", "field order", ["file.fieldOrder", "file.video"]);
    if (v.colorPrimaries || v.colorTransfer || v.colorMatrix || v.colorRange) add("file", "color tags", ["file.color", "file.video"]);
  }
  const sa = spec.safeAreas;
  if (sa) {
    const textArea = sa.textMustBeIn ?? "title";
    if (textArea !== "none" && (areaMargins(spec, textArea) || sa.textMustBeIn)) add("project", `text ${AREA_LABEL[textArea]}`, [`safeAreas.${textArea}`, "safeAreas.textMustBeIn", ...FRAME_PARTIAL]);
    for (const p of sa.layersMustBeIn ?? [])
      add("project", `${p.layer} ${AREA_LABEL[p.area]}`, [`safeAreas.${p.area}`, `safeAreas.layersMustBeIn "${p.layer}"`, "safeAreas.layersMustBeIn", ...FRAME_PARTIAL]);
  }
  const tx = spec.text;
  if (tx) {
    if (tx.minCapHeightPx !== undefined) add("project", "cap height", ["text.capHeight", ...FRAME_PARTIAL]);
    if (tx.maxCharsPerSecond !== undefined) add("project", "reading speed", ["text.readingSpeed", "preflight.partial"]);
    if (tx.minOnScreenSeconds !== undefined) add("project", "time on screen", ["text.onScreen", "preflight.partial"]);
    if (tx.noOverflow) add("project", "text overflow", ["text.overflow", "text.noOverflow", "preflight.partial"]);
    if (tx.glyphs) add("project", "glyphs", ["text.glyphs"]);
  }
  const p = spec.project;
  if (p) {
    if (p.noMissingFootage) add("project", "missing footage", ["project.missingFootage", ...PROJECT_PARTIAL]);
    if (p.noMissingFonts) add("project", "missing fonts", ["project.missingFonts", "project.noMissingFonts", ...PROJECT_PARTIAL]);
    if (p.noMissingEffects) add("project", "missing effects", ["project.missingEffects", ...PROJECT_PARTIAL]);
    if (p.noExpressionErrors) add("project", "expression errors", ["project.expressionErrors", ...PROJECT_PARTIAL]);
    if (p.noDisabledLayersWithEffects) add("project", "disabled layers with effects", ["project.disabledLayersWithEffects", ...PROJECT_PARTIAL]);
    if (p.bitsPerChannel !== undefined) add("project", "project bit depth", ["project.bitsPerChannel"]);
    if (p.workingSpace !== undefined) add("project", "working space", ["project.workingSpace"]);
  }
  if (spec.legalRange) add("file", "legal range", ["legalRange"]);
  if (spec.black) add("file", "black frames", ["black"]);
  if (spec.frozen) add("file", "frozen frames", ["frozen"]);
  if (spec.audio) add("file", "audio and loudness", ["loudness", "file.audio"]);
  if (spec.flash) add("file", "flash", ["flash"]);
  return out;
}

/**
 * A finding or not-run check belongs to a requested check: the same name, or one of its parts ("loudness.integrated").
 * "file" (the file couldn't be read) is only itself: "file.codec" is a check of its own.
 */
const covers = (r: Requested, check: string) => r.checks.some((c) => check === c || (c !== "file" && check.startsWith(c + ".")));

const GROUPS: [RegExp, string][] = [
  [/^video\./, "Video"],
  [/^file\b/, "File"],
  [/^safeAreas\./, "Safe areas"],
  [/^text\.capHeight/, "Text size"],
  [/^text\.readingSpeed/, "Reading speed"],
  [/^text\.onScreen/, "Time on screen"],
  [/^text\.(no)?[oO]verflow/, "Text overflow"],
  [/^text\.glyphs/, "Glyphs"],
  [/^project\.missingFootage/, "Missing footage"],
  [/^project\.(no)?[mM]issingFonts/, "Missing fonts"],
  [/^project\.missingEffects/, "Missing effects"],
  [/^project\.expressionErrors/, "Expression errors"],
  [/^project\.disabledLayersWithEffects/, "Disabled layers"],
  [/^project\.(bitsPerChannel|workingSpace)/, "Project settings"],
  [/^(project|preflight)\.partial/, "Partial check"],
  [/^legalRange/, "Legal range"],
  [/^black/, "Black frames"],
  [/^frozen/, "Frozen frames"],
  [/^loudness/, "Loudness"],
  [/^flash/, "Flash"],
];
/** The heading a finding is grouped under in the view. */
export function groupOf(check: string): string {
  const g = GROUPS.find(([re]) => re.test(check));
  if (g) return g[1];
  const first = check.split(".")[0];
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** "Main > 2: Lower third > 1: Name" -> "Main › Lower third › Name" */
export const readableWhere = (where: string) =>
  where
    .split(" > ")
    .map((s, i) => (i ? s.replace(/^\d+: /, "") : s))
    .join(" › ");

/** The delivered comp's layer a finding is on (or inside: a precomp layer), from its `where`. */
export function layerIndex(where: string | undefined, compName: string): number | undefined {
  if (!where || !where.startsWith(compName + " > ")) return undefined;
  const m = /^(\d+): /.exec(where.slice(compName.length + 3));
  return m ? Number(m[1]) : undefined;
}

const SEV = { fail: 0, warn: 1, info: 2 } as const;
// findings at a time first (they're on the timeline), then those about the whole comp / file
const startOf = (f: Finding) => (f.at === undefined ? Infinity : Array.isArray(f.at) ? f.at[0] : f.at);

export interface ViewInput {
  spec: Spec;
  /** the spec argument as given: a file path, or the spec object */
  specArg: unknown;
  target: "project" | "file" | "both";
  verdictLine: string;
  findings: Finding[];
  notRun: NotRun[];
  timeBase?: TimeBase;
  comp?: { id: number; name: string; w: number; h: number; fps: number; dur: number };
  file?: string;
  probe?: Record<string, unknown>;
}

export function preflightView(r: ViewInput): PreflightView {
  const shown = r.findings.filter((f) => f.severity !== "info");
  const failed = shown.filter((f) => f.severity === "fail").length, warnings = shown.length - failed;
  const tc = (s: number) => (r.timeBase ? timecode(s, r.timeBase.fps, r.timeBase.dropFrame, r.timeBase.offset ?? 0) : undefined);

  // checks this target can't run (the text report lists them under "not checked")
  const req = requestedChecks(r.spec);
  const skipped = r.target === "both" ? [] : req.filter((q) => q.on !== r.target && !q.both);
  const ran = req.filter((q) => r.target === "both" || q.on === r.target);
  const notRun: PreflightView["notRun"] = [];
  for (const n of r.notRun) {
    const q = ran.find((x) => covers(x, n.check));
    notRun.push({ check: n.check, label: q?.label ?? n.check, reason: n.reason });
  }
  for (const q of skipped)
    notRun.push({
      check: q.label,
      label: q.label,
      reason: q.on === "file" ? "Needs a render of the file. Ask to check the rendered file too." : "Needs the project in After Effects. Ask to check the project too.",
    });
  const passed = ran.filter((q) => !shown.some((f) => covers(q, f.check)) && !r.notRun.some((n) => covers(q, n.check))).map((q) => q.label);

  // groups in the order of their worst finding, then as the text report orders them; fails first, by time, inside each
  const byTime = (a: Finding, b: Finding) => (startOf(a) === startOf(b) ? 0 : startOf(a) - startOf(b));
  const ordered = [...shown].sort((a, b) => SEV[a.severity] - SEV[b.severity] || byTime(a, b));
  const groupOrder = [...new Set(ordered.map((f) => groupOf(f.check)))];
  ordered.sort((a, b) => groupOrder.indexOf(groupOf(a.check)) - groupOrder.indexOf(groupOf(b.check)));
  const findings: PreflightFinding[] = ordered.slice(0, MAX_VIEW_FINDINGS).map((f) => {
    const [a, b] = f.at === undefined ? [undefined, undefined] : Array.isArray(f.at) ? f.at : [f.at, f.at];
    return {
      check: f.check,
      group: groupOf(f.check),
      severity: f.severity,
      message: f.message,
      ...(f.at !== undefined ? { at: f.at, tc: tc(a!), ...(b !== a ? { tcEnd: tc(b!) } : {}) } : {}),
      ...(f.where ? { where: readableWhere(f.where) } : {}),
      ...(r.comp && layerIndex(f.where, r.comp.name) ? { layer: layerIndex(f.where, r.comp.name) } : {}),
      ...(f.fix ? { fix: f.fix } : {}),
      ...(f.box ? { box: f.box } : {}),
      ...(f.area ? { area: f.area } : {}),
    };
  });

  const verdict = (/^(PASS|FAIL|WARNINGS|INCOMPLETE)/.exec(r.verdictLine)?.[1] ?? "INCOMPLETE") as PreflightView["verdict"];
  const out: PreflightView = {
    view: "preflight",
    verdict,
    verdictLine: r.verdictLine,
    counts: { failed, warnings, notRun: notRunCount(r.notRun) + skipped.length, passed: passed.length },
    spec: typeof r.specArg === "string" ? basename(r.specArg) : (r.spec.name ?? "inline spec"),
    target: r.target,
    findings,
    more: Math.max(0, ordered.length - MAX_VIEW_FINDINGS),
    notRun,
    passed,
  };
  if (r.comp) {
    const c = r.comp;
    out.comp = { id: c.id, name: c.name, width: c.w, height: c.h, fps: Math.round(c.fps * 1000) / 1000, duration: c.dur, durationTc: tc(c.dur) ?? `${c.dur} s` };
  }
  if (r.file) {
    const v = (r.probe?.video ?? {}) as { size?: string; frameRate?: number };
    const [w, h] = (v.size ?? "").split("x").map(Number);
    const dur = typeof r.probe?.duration === "number" ? r.probe.duration : undefined;
    out.file = {
      name: basename(r.file),
      ...(w && h ? { width: w, height: h } : {}),
      ...(v.frameRate ? { fps: v.frameRate } : {}),
      ...(dur !== undefined ? { duration: dur, durationTc: tc(dur) } : {}),
    };
  }
  return out;
}
