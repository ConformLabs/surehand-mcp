// The farm manifest: exactly what a render needs on the machine that renders it, from the farm scan (src/farm/jsx.ts)
// and this machine's disk: After Effects version, bit depth, colour settings, expression engine, plug-ins by match name,
// fonts, every file the render pulls in (sequences with their range and gaps; whether other machines can see each path),
// and the output modules. JSON for tools (and `surehand-ae farm check`), plus a readable summary.
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { hostname, release, type as osType } from "node:os";
import { basename, dirname, isAbsolute, relative } from "node:path";
import { VERSION } from "../config.js";
import { ADOBE_FX } from "../tools/handoff.js";
import { classifyPath, majorOf, type ClassifyContext, type PathClass } from "./paths.js";
import { footageSequence, parseTemplate, runsText, type FootageSequence } from "./seq.js";

// ---------- what the scan returns ----------

export interface ScanItem {
  index: number;
  status: string;
  comp: { id: number; name: string; w: number; h: number; par: number; fps: number; fd: number; dur: number; dst: number; was: number; wad: number; df?: boolean };
  start: number;
  dur: number;
  rs?: Record<string, string>;
  rsError?: string;
  oms: { index: number; name: string; file?: string; settings?: Record<string, string>; settingsError?: string }[];
}
export interface ScanFootage {
  id: number; name: string; kind: "file" | "solid" | "placeholder"; on: number; uses: number; at: string[]; cs: number[];
  missing?: boolean; file?: string; missingPath?: string; still?: boolean; seq?: boolean; w?: number; h?: number; fps?: number; dur?: number;
  proxy?: { file: string; inUse: boolean; missing: boolean; seq: boolean };
}
export interface ScanEffect { m: string; n: string; dn?: string; cat?: string; v?: string; x?: 1; k: number; on: number; at: string[]; cs: number[] }
export interface ScanFont { ps: string; family?: string; style?: string; v?: string; adobe?: boolean; loc?: string; here?: string; n: number; on: number; at: string[]; cs: number[] }
export interface FarmScan {
  ae?: string; build?: string; os?: string; app?: string; file: string | null; dirty: boolean; engine?: string; gpu?: string;
  color: Record<string, unknown>; mfr: { on: boolean; key: string } | null; rqCount: number;
  items: ScanItem[]; comps: { id: number; name: string; layers: number; sub: number[] }[]; footage: ScanFootage[]; effects: ScanEffect[];
  layers: number; partial?: string;
  fonts: { used: ScanFont[] | null; missing: { ps: string; family?: string; style?: string; sub: boolean }[] } | null;
  textFonts?: { ps: string; family?: string; style?: string; at: string; on: boolean; c: number }[];
}

// ---------- reading the render queue item's own settings ----------

const truthy = (v: string | undefined) => (v === undefined ? undefined : /^(true|on|yes|1)$/i.test(v.trim()));
const findKey = (o: Record<string, string> | undefined, re: RegExp) => {
  if (!o) return undefined;
  const k = Object.keys(o).find((x) => re.test(x));
  return k === undefined ? undefined : o[k];
};

export interface OutputInfo {
  index: number;
  /** the output module's format as After Effects names it ("QuickTime", "PNG Sequence", "H.264"...) */
  format: string | null;
  /** the codec, where scripting exposes it (often it doesn't: then the rendered file says, with ffprobe) */
  codec: string | null;
  sequence: boolean;
  path: string | null;
  /** [####] digits of a sequence's file name */
  pad?: number;
  /** "Use Comp Frame Number" (sequences: files numbered by comp frame), and "Starting #" when it is off */
  useCompFrameNumber?: boolean;
  startingNumber?: number;
  audio: string | null;
  audioSampleRate?: number;
  resize?: { w: number; h: number };
}

const SEQ_FORMAT = /sequence|^(png|tiff?|jpe?g|openexr|exr|dpx|cineon|targa|tga|photoshop|iff|sgi|bmp|radiance)\b/i;

export function outputInfo(om: ScanItem["oms"][number]): OutputInfo {
  const s = om.settings;
  const format = findKey(s, /^Format$/i) ?? null;
  const path = om.file ?? findKey(s, /Full Flat Path$/i) ?? null;
  const tpl = path ? parseTemplate(path) : null;
  const sequence = !!tpl || (!!format && SEQ_FORMAT.test(format));
  const codec = findKey(s, /codec|compression type/i) ?? null;
  const ucfn = truthy(findKey(s, /Use Comp Frame Number/i));
  const start = Number(findKey(s, /^Starting #$/i));
  const audio = findKey(s, /^Output Audio$/i) ?? null;
  const rate = Number(findKey(s, /^Audio Sample Rate$/i));
  const resized = truthy(findKey(s, /^Resize$/i));
  const rw = Number(findKey(s, /^Resize to\/x$/i)), rh = Number(findKey(s, /^Resize to\/y$/i));
  return {
    index: om.index, format, codec: codec && codec.trim() ? codec : null, sequence, path,
    ...(tpl ? { pad: tpl.pad } : {}),
    ...(ucfn !== undefined ? { useCompFrameNumber: ucfn } : {}),
    ...(Number.isFinite(start) ? { startingNumber: start } : {}),
    audio, ...(rate > 0 ? { audioSampleRate: rate } : {}),
    ...(resized && rw > 0 && rh > 0 ? { resize: { w: rw, h: rh } } : {}),
  };
}

export interface RenderInfo {
  /** the render settings' own frame rate, when it overrides the comp's */
  fpsOverride: number | null;
  proxyUse: string | null;
  resolution: string | null;
  timeSpan: string | null;
  skipExisting?: boolean;
  quality: string | null;
}
export function renderInfo(rs: Record<string, string> | undefined): RenderInfo {
  const fr = findKey(rs, /^Frame Rate$/i), val = Number(findKey(rs, /^Use this frame rate$/i));
  return {
    fpsOverride: fr && /this/i.test(fr) && val > 0 ? val : null,
    proxyUse: findKey(rs, /^Proxy Use$/i) ?? null,
    resolution: findKey(rs, /^Resolution$/i) ?? null,
    timeSpan: findKey(rs, /^Time Span$/i) ?? null,
    skipExisting: truthy(findKey(rs, /^Skip Existing Files$/i)),
    quality: findKey(rs, /^Quality$/i) ?? null,
  };
}

/** The frames a render queue item renders, counted from the comp's start at 0 (aerender's -s / -e take them plus the comp's displayed start frame: displayStart). */
export function itemFrames(it: Pick<ScanItem, "start" | "dur" | "comp">): { first: number; last: number; count: number; fps: number } {
  const fd = it.comp.fd || 1 / it.comp.fps;
  const first = Math.round(it.start / fd + 1e-6);
  const count = Math.max(1, Math.round(it.dur / fd - 1e-6));
  return { first, last: first + count - 1, count, fps: it.comp.fps };
}
/** The comp's displayed start frame (Start Timecode / Start Frame in Composition Settings). */
export const displayStart = (it: Pick<ScanItem, "comp">) => Math.round((it.comp.dst || 0) / (it.comp.fd || 1 / it.comp.fps) + 1e-6);

// ---------- the manifest ----------

export interface ManifestPath { path: string; where: PathClass["where"]; why: string }
export interface Manifest {
  surehandFarmManifest: 1;
  createdAt: string;
  createdBy: string;
  machine: { os: string; platform: "mac" | "windows"; host: string };
  summary: string;
  project: { file: string | null; bytes: number | null; modified: string | null; unsavedChanges: boolean; location: ManifestPath | null; bitsPerChannel: unknown; expressionEngine: string | null; gpu: string | null };
  afterEffects: { version: string | null; major: number | null; build: string | null; os: string | null; app: string | null };
  color: {
    management: "Adobe" | "OCIO" | null;
    workingSpace: unknown; linearBlending: unknown; linearize: unknown;
    ocioConfig: { path: string; exists: boolean; insideProjectFolder: boolean; location: ManifestPath } | null;
    raw: Record<string, unknown>;
  };
  multiFrameRendering: { on: boolean | null; note: string };
  items: {
    rqIndex: number; status: string;
    comp: { id: number; name: string; width: number; height: number; fps: number; duration: number; displayStartFrame: number };
    /** first / last count from the comp's start at 0; shownFirst / shownLast are the numbers After Effects shows (and aerender's -s / -e take) */
    frames: { first: number; last: number; count: number; shownFirst: number; shownLast: number };
    render: RenderInfo;
    outputs: (OutputInfo & { folder: string | null; folderExists: boolean; folderWritable: boolean; location: ManifestPath | null })[];
    comps: string[];
  }[];
  plugins: { matchName: string; displayName: string; category?: string; version: string | null; vendor: "Adobe" | "third party"; installedHere: boolean; instances: number; rendered: boolean; comps: string[]; usedBy: string[]; rqItems: number[] }[];
  fonts: { postScriptName: string; family?: string; style?: string; version?: string; adobeFonts?: boolean; location?: string; here: "installed" | "missing" | "substituted" | "unknown"; rendered: boolean; usedBy: string[]; rqItems: number[] }[];
  fontsSource: string;
  footage: {
    id: number; name: string; kind: "file" | "sequence" | "still" | "solid" | "placeholder"; path: string | null; exists: boolean; bytes: number | null;
    sequence?: FootageSequence; location: ManifestPath | null; rendered: boolean; usedBy: string[]; rqItems: number[];
    proxy?: { path: string; exists: boolean; needed: boolean; sequence?: FootageSequence; location: ManifestPath };
  }[];
  sharedPaths: string[];
  /** what would fail on this machine already */
  problems: string[];
  /** what another machine can't reach (paths local to this one) */
  notShared: string[];
  warnings: string[];
  notes: string[];
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const list = (a: string[], max = 6) => (a.length <= max ? a.join(", ") : `${a.slice(0, max).join(", ")} and ${a.length - max} more`);

/** The comps each render queue item reaches (its comp and every precomp below it). */
export function reachOf(scan: FarmScan): Map<number, Set<number>> {
  const sub = new Map(scan.comps.map((c) => [c.id, c.sub]));
  const out = new Map<number, Set<number>>();
  for (const it of scan.items) {
    const seen = new Set<number>(), stack = [it.comp.id];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const s of sub.get(id) ?? []) stack.push(s);
    }
    out.set(it.index, seen);
  }
  return out;
}

const writable = (dir: string) => {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};
function isInsideDir(root: string, p: string) {
  const r = relative(root.toLowerCase(), p.toLowerCase());
  return !!r && !r.startsWith("..") && !isAbsolute(r);
}

export interface ManifestOptions { classify: ClassifyContext; now?: Date; platform: "mac" | "windows" }

export function buildManifest(scan: FarmScan, o: ManifestOptions): Manifest {
  const reach = reachOf(scan);
  const itemsFor = (cs: number[]) => scan.items.filter((it) => cs.some((c) => reach.get(it.index)?.has(c))).map((it) => it.index);
  const where = (p: string): ManifestPath => ({ path: p, ...classifyPath(p, o.classify) });
  const compName = new Map(scan.comps.map((c) => [c.id, c.name]));
  const problems: string[] = [], notShared: string[] = [], warnings: string[] = [], notes: string[] = [];

  // the project
  let bytes: number | null = null, modified: string | null = null;
  if (scan.file) {
    try {
      const st = statSync(scan.file);
      bytes = st.size;
      modified = st.mtime.toISOString();
    } catch {}
  }
  const projLoc = scan.file ? where(scan.file) : null;
  if (!scan.file) problems.push("the project has never been saved: aerender renders a project file");
  if (scan.dirty) warnings.push("the project has unsaved changes: aerender renders the file on disk, so save before rendering");
  if (projLoc && projLoc.where !== "shared") notShared.push(`the project ${scan.file} (${projLoc.why})`);

  // colour
  const cms = scan.color.colorManagementSystem;
  const ocioPath = typeof scan.color.ocioConfigurationFile === "string" && scan.color.ocioConfigurationFile ? (scan.color.ocioConfigurationFile as string) : null;
  const management = cms === undefined ? null : Number(cms) === 1 ? "OCIO" : "Adobe";
  let ocio: Manifest["color"]["ocioConfig"] = null;
  if (management === "OCIO" && ocioPath) {
    ocio = { path: ocioPath, exists: existsSync(ocioPath), insideProjectFolder: !!scan.file && isInsideDir(dirname(scan.file), ocioPath), location: where(ocioPath) };
    if (!ocio.exists) problems.push(`the OCIO config ${ocioPath} is not on this machine`);
    if (ocio.location.where !== "shared" && !ocio.insideProjectFolder) notShared.push(`the OCIO config ${ocioPath} (${ocio.location.why})`);
  }

  // render queue items
  const items: Manifest["items"] = scan.items.map((it) => {
    const fr = itemFrames(it);
    const outputs = it.oms.map((om) => {
      const info = outputInfo(om);
      const folder = info.path ? dirname(info.path) : null;
      const folderExists = !!folder && existsSync(folder);
      const loc = info.path ? where(info.path) : null;
      if (info.path && loc && loc.where !== "shared") notShared.push(`the output of render queue item ${it.index} ${info.path} (${loc.why})`);
      if (!info.path) problems.push(`render queue item ${it.index}, output module ${om.index} has no output file`);
      else if (!folderExists) warnings.push(`the output folder ${folder} of render queue item ${it.index} doesn't exist on this machine`);
      else if (!writable(folder!)) problems.push(`the output folder ${folder} of render queue item ${it.index} can't be written from here`);
      return { ...info, folder, folderExists, folderWritable: folderExists && writable(folder!), location: loc };
    });
    if (it.rsError) notes.push(`render queue item ${it.index}: its render settings could not be read (${it.rsError})`);
    return {
      rqIndex: it.index, status: it.status,
      comp: { id: it.comp.id, name: it.comp.name, width: it.comp.w, height: it.comp.h, fps: it.comp.fps, duration: it.comp.dur, displayStartFrame: displayStart(it) },
      frames: { first: fr.first, last: fr.last, count: fr.count, shownFirst: fr.first + displayStart(it), shownLast: fr.last + displayStart(it) },
      render: renderInfo(it.rs),
      outputs,
      comps: [...(reach.get(it.index) ?? [])].map((id) => compName.get(id) ?? String(id)),
    };
  });
  if (!items.length) problems.push(scan.rqCount ? "no render queue item is queued (pass rqIndex to choose items in any status)" : "the render queue is empty");

  // plug-ins
  const plugins: Manifest["plugins"] = scan.effects.map((e) => ({
    matchName: e.m, displayName: e.dn ?? e.n, category: e.cat, version: e.v ?? null, vendor: ADOBE_FX.test(e.m) ? "Adobe" : "third party",
    installedHere: !e.x, instances: e.k, rendered: e.on > 0, comps: e.cs.map((c) => compName.get(c) ?? String(c)), usedBy: e.at, rqItems: itemsFor(e.cs),
  }));
  for (const p of plugins.filter((x) => !x.installedHere)) (p.rendered ? problems : warnings).push(`plug-in ${p.matchName} is not installed here${p.rendered ? "" : " (only on layers or effects that are off)"}`);

  // fonts
  let fonts: Manifest["fonts"] = [], fontsSource: string;
  const missing = new Map((scan.fonts?.missing ?? []).map((m) => [m.ps, m.sub ? "substituted" : "missing"] as const));
  if (scan.fonts?.used) {
    fontsSource = "project.usedFonts (style runs and Source Text keyframes included), limited to the layers the render reaches";
    fonts = scan.fonts.used.map((u) => ({
      postScriptName: u.ps, family: u.family, style: u.style, version: u.v, adobeFonts: u.adobe, location: u.loc,
      here: (u.here ?? missing.get(u.ps) ?? "installed") as Manifest["fonts"][number]["here"], rendered: u.on > 0, usedBy: u.at, rqItems: itemsFor(u.cs),
    }));
  } else {
    fontsSource = "the text layers the render reaches, at their comp's current time (this After Effects has no project.usedFonts with layer ids: fonts in style runs or Source Text keyframes can be missed)";
    const by = new Map<string, Manifest["fonts"][number]>();
    for (const t of scan.textFonts ?? []) {
      const f = by.get(t.ps) ?? { postScriptName: t.ps, family: t.family, style: t.style, here: (missing.get(t.ps) ?? (scan.fonts ? "installed" : "unknown")) as Manifest["fonts"][number]["here"], rendered: false, usedBy: [], rqItems: [] };
      if (t.on) f.rendered = true;
      if (f.usedBy.length < 12) f.usedBy.push(t.at);
      for (const q of itemsFor([t.c])) if (!f.rqItems.includes(q)) f.rqItems.push(q);
      by.set(t.ps, f);
    }
    fonts = [...by.values()];
  }
  if (!scan.fonts) notes.push("this After Effects can't list missing fonts (needs 24.0+): fonts were not checked here");
  for (const f of fonts.filter((x) => x.here === "missing" || x.here === "substituted")) problems.push(`font ${f.postScriptName} is ${f.here} here`);

  // footage (and proxies)
  const proxyUse = (q: number[]) => q.map((i) => items.find((x) => x.rqIndex === i)?.render.proxyUse ?? null);
  const footage: Manifest["footage"] = scan.footage.map((f) => {
    const kind = f.kind !== "file" ? f.kind : f.seq ? "sequence" : f.still ? "still" : "file";
    const path = f.file ?? f.missingPath ?? null;
    const exists = !!path && f.kind === "file" && !f.missing && existsSync(path);
    let size: number | null = null, sequence: FootageSequence | undefined;
    if (exists && f.seq) {
      sequence = footageSequence(path!) ?? undefined;
      size = sequence?.bytes ?? null;
    } else if (exists) {
      try {
        size = statSync(path!).size;
      } catch {}
    }
    const q = itemsFor(f.cs);
    const rendered = f.on > 0;
    const out: Manifest["footage"][number] = { id: f.id, name: f.name, kind, path, exists, bytes: size, ...(sequence ? { sequence } : {}), location: path && f.kind === "file" ? where(path) : null, rendered, usedBy: f.at, rqItems: q };
    if (f.kind === "placeholder") (rendered ? problems : warnings).push(`"${f.name}" is a placeholder, not footage`);
    if (f.kind === "file" && !exists) (rendered ? problems : warnings).push(`footage "${f.name}" is missing here${path ? ` (${path})` : ""}${rendered ? "" : " (only on layers that are off)"}`);
    if (sequence?.gaps.length) warnings.push(`the sequence "${f.name}" has gaps (not on disk: frame ${runsText(sequence.gaps)})`);
    if (out.location && out.location.where !== "shared") notShared.push(`footage "${f.name}" ${path} (${out.location.why})`);
    if (f.proxy) {
      const uses = proxyUse(q);
      const needed = uses.some((u) => (u && /all proxies/i.test(u)) || (f.proxy!.inUse && (!u || /current/i.test(u))));
      const pex = existsSync(f.proxy.file);
      out.proxy = { path: f.proxy.file, exists: pex, needed, ...(f.proxy.seq && pex ? { sequence: footageSequence(f.proxy.file) ?? undefined } : {}), location: where(f.proxy.file) };
      if (needed && !pex) problems.push(`the proxy of "${f.name}" (${f.proxy.file}) is missing, and the render uses it`);
      if (needed && out.proxy.location.where !== "shared") notShared.push(`the proxy of "${f.name}" ${f.proxy.file} (${out.proxy.location.why})`);
    }
    return out;
  });
  if (scan.partial) notes.push(`the scan stopped early (${scan.partial}): the lists can be incomplete`);
  notes.push("comps that expressions only read from (comp(\"...\")) are not followed: their footage and effects are listed only when a layer also uses them");

  const mfr = scan.mfr
    ? { on: scan.mfr.on, note: `the preference on this machine (${scan.mfr.on ? "on" : "off"}); each render node uses its own, or aerender's -mfr` }
    : { on: null, note: "a preference of each machine, not readable by scripting in this After Effects; aerender's -mfr sets it per render (22.0+)" };

  const ready = !problems.length;
  const summary = `${ready ? "Renders on this machine" : `Does not render here as it is: ${list(problems, 3)}`}. ${notShared.length ? `${plural(notShared.length, "path")} other machines can't see` : "Every path is on a share"}${warnings.length ? `; ${plural(warnings.length, "warning")}` : ""}.`;
  return {
    surehandFarmManifest: 1,
    createdAt: (o.now ?? new Date()).toISOString(),
    createdBy: `Surehand MCP ${VERSION}`,
    machine: { os: `${osType()} ${release()}`, platform: o.platform, host: hostname() },
    summary,
    project: { file: scan.file, bytes, modified, unsavedChanges: scan.dirty, location: projLoc, bitsPerChannel: scan.color.bitsPerChannel ?? null, expressionEngine: scan.engine ?? null, gpu: scan.gpu ?? null },
    afterEffects: { version: scan.ae ?? null, major: Number.isFinite(majorOf(scan.ae)) ? majorOf(scan.ae) : null, build: scan.build ?? null, os: scan.os ?? null, app: scan.app ?? null },
    color: { management, workingSpace: scan.color.workingSpace ?? scan.color.workingColorSpace ?? null, linearBlending: scan.color.linearBlending ?? null, linearize: scan.color.linearizeWorkingSpace ?? null, ocioConfig: ocio, raw: scan.color },
    multiFrameRendering: mfr,
    items,
    plugins,
    fonts,
    fontsSource,
    footage,
    sharedPaths: o.classify.shared ?? [],
    problems,
    notShared,
    warnings,
    notes,
  };
}

const fmtBytes = (n: number | null) => (n === null ? "?" : n < 1e3 ? `${n} B` : n < 1e6 ? `${(n / 1e3).toFixed(1)} KB` : n < 1e9 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e9).toFixed(2)} GB`);
const whereTag = (l: ManifestPath | null) => (!l ? "" : l.where === "shared" ? " [shared]" : l.where === "unknown" ? " [local or shared: unknown]" : ` [LOCAL: ${l.why}]`);

/** The readable summary (the tool's answer and the .txt next to the JSON). */
export function formatManifest(m: Manifest, savedAt?: string): string {
  const out: string[] = [m.summary];
  if (savedAt) out.push(`Saved: ${savedAt} (+ .txt)`);
  out.push(
    "",
    `Project: ${m.project.file ?? "(never saved)"}${whereTag(m.project.location)}${m.project.unsavedChanges ? " (UNSAVED CHANGES)" : ""}`,
    `After Effects ${m.afterEffects.version ?? "?"}${m.afterEffects.build ? ` (build ${m.afterEffects.build})` : ""}; ${m.project.bitsPerChannel ?? "?"} bpc; expressions engine ${m.project.expressionEngine ?? "(not exposed)"}${m.project.gpu ? `; renderer ${m.project.gpu}` : ""}.`,
    `Colour: ${m.color.management ?? "(not exposed)"}${m.color.workingSpace ? `, working space ${m.color.workingSpace}` : ""}${m.color.linearBlending !== null ? `, linear blending ${m.color.linearBlending ? "on" : "off"}` : ""}${m.color.linearize !== null ? `, linearize ${m.color.linearize ? "on" : "off"}` : ""}${m.color.ocioConfig ? `; OCIO config ${m.color.ocioConfig.path}${m.color.ocioConfig.insideProjectFolder ? " (inside the project folder)" : ""}${m.color.ocioConfig.exists ? "" : " (MISSING HERE)"}${whereTag(m.color.ocioConfig.location)}` : ""}.`,
    `Multi-Frame Rendering: ${m.multiFrameRendering.on === null ? "unknown" : m.multiFrameRendering.on ? "on" : "off"} (${m.multiFrameRendering.note}).`,
  );
  for (const it of m.items) {
    out.push("", `Render queue item ${it.rqIndex} (${it.status}): "${it.comp.name}" ${it.comp.width}x${it.comp.height} @ ${it.comp.fps} fps, frames ${it.frames.shownFirst}-${it.frames.shownLast} (${it.frames.count}${it.comp.displayStartFrame ? `; the comp starts at frame ${it.comp.displayStartFrame}` : ""}).`);
    const r = it.render;
    const rs = [r.resolution && `resolution ${r.resolution}`, r.quality && `quality ${r.quality}`, r.proxyUse && `proxies: ${r.proxyUse}`, r.fpsOverride && `frame rate ${r.fpsOverride} (render settings)`, r.timeSpan && `time span ${r.timeSpan}`].filter(Boolean);
    if (rs.length) out.push(`  Render settings: ${rs.join(", ")}.`);
    for (const o of it.outputs)
      out.push(`  Output ${o.index}: ${o.format ?? "?"}${o.codec ? ` / ${o.codec}` : ""}${o.sequence && !/sequence/i.test(o.format ?? "") ? " sequence" : ""} -> ${o.path ?? "(none)"}${whereTag(o.location)}${o.folder && !o.folderExists ? " (folder doesn't exist here)" : o.folder && !o.folderWritable ? " (folder NOT WRITABLE here)" : ""}${o.audio ? `; audio ${o.audio}` : ""}`);
    out.push(`  Comps rendered: ${list(it.comps, 8)}.`);
  }
  out.push("", `Plug-ins (${m.plugins.length}, by match name; versions as After Effects reports them):`);
  for (const p of m.plugins) out.push(`  ${p.displayName} [${p.matchName}], ${p.vendor}${p.version ? `, version ${p.version}` : ""}${p.installedHere ? "" : ", NOT INSTALLED HERE"}${p.rendered ? "" : ", only where it is off"}: ${list(p.comps, 4)}`);
  if (!m.plugins.length) out.push("  none");
  out.push("", `Fonts (${m.fonts.length}; from ${m.fontsSource.split(" (")[0]}):`);
  for (const f of m.fonts) out.push(`  ${f.postScriptName}${f.family ? ` (${f.family}${f.style ? ` ${f.style}` : ""})` : ""}${f.adobeFonts ? ", Adobe Fonts" : ""}${f.here === "installed" ? ", installed here" : `, ${f.here.toUpperCase()} HERE`}: ${list(f.usedBy, 3)}`);
  if (!m.fonts.length) out.push("  none");
  // solids are made inside the project: nothing for a node to have
  const files = m.footage.filter((f) => f.kind !== "solid");
  out.push("", `Footage the render pulls in (${files.length}):`);
  if (!files.length) out.push(m.footage.length ? "  none (only solids, which are part of the project)" : "  none");
  for (const f of files) {
    const seq = f.sequence ? `, frames ${f.sequence.first}-${f.sequence.last} (${f.sequence.count}${f.sequence.gaps.length ? `, GAPS ${runsText(f.sequence.gaps, 4)}` : ""})` : "";
    out.push(`  "${f.name}" (${f.kind}${seq}, ${fmtBytes(f.bytes)}): ${f.path ?? "(no file)"}${f.exists ? "" : " MISSING HERE"}${whereTag(f.location)}${f.rendered ? "" : " (only on layers that are off)"}`);
    if (f.proxy) out.push(`    proxy${f.proxy.needed ? " (used by the render)" : " (not used by the render)"}: ${f.proxy.path}${f.proxy.exists ? "" : " MISSING HERE"}${whereTag(f.proxy.location)}`);
  }
  if (m.problems.length) out.push("", "Fails on this machine already:", ...m.problems.map((p) => `  - ${p}`));
  if (m.notShared.length) out.push("", `Other machines can't see (local to ${m.machine.host}; copy it to a share, or say which folders are shared with sharedPaths):`, ...m.notShared.map((p) => `  - ${p}`));
  if (m.warnings.length) out.push("", "Warnings:", ...m.warnings.map((p) => `  - ${p}`));
  if (m.notes.length) out.push("", "Notes:", ...m.notes.map((p) => `  - ${p}`));
  return out.join("\n") + "\n";
}

/** The file name the manifest is saved under next to the project. */
export const manifestName = (project: string) => `${basename(project).replace(/\.aepx?$/i, "")}.farm-manifest.json`;
