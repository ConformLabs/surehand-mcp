// Proven edits: render reference frames, make a structural change, render again and compare in Node,
// so "un-precompose / bake / reorder, nothing changed" comes back with evidence (or exactly what differs).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { runJsx, type Changes } from "../jsx.js";
import { permissions, READ_ONLY_REFUSAL } from "../permissions.js";
import { decodePng, encodePng, type Image } from "../png.js";
import { timecode } from "../preflight/report.js";
import { capChanges, changesFromReport } from "../view-changes.js";
import { VIEW_META_KEY, type ChangesView, type ProofFrame } from "../views/types.js";
import { errorResult } from "./registry.js";
import { CHANGES_VIEW_URI, registerViewTool, viewError } from "./views.js";
import { RENDER_KIT_JSX, renderCleanupNote, runRender, writtenSize } from "./core.js";
import { runBatch } from "./workflow.js";
import { appFile } from "../paths.js";

export const MAX_PROOFS = 30;
export const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const proofsRoot = () => appFile("proofs");

/**
 * Renders frames of comps the way ae_render_frame does (a temporary comp, removed by hand once the files are
 * written: runRender), but always with the project's own color settings, so a capture and its
 * comparison are rendered the same way: the comp at full size (capped by maxSize), transparent background. args.comps: {ref}
 * to capture (times from args.times or args.frames over the work area, snapped to frames), or {id, times,
 * width, height, pixelAspect} to render again (a deleted comp or a changed size is reported, not rendered).
 */
export const PROVE_RENDER_JSX = `${RENDER_KIT_JSX}
var out = [], seen = {}, max = args.maxSize || 1920, tmpLeft = false;
var byId = function (id) {
  for (var i = 1; i <= app.project.numItems; i++) { var it = app.project.item(i); if (it.id === id) return it; }
  return null;
};
for (var ci = 0; ci < args.comps.length; ci++) {
  var spec = args.comps[ci], c, times = [];
  if (spec.id !== undefined) {
    c = byId(spec.id);
    if (!c || !(c instanceof CompItem)) { out.push({ id: spec.id, missing: true }); continue; }
    if (c.width !== spec.width || c.height !== spec.height || c.pixelAspect !== spec.pixelAspect) {
      out.push({ id: c.id, name: c.name, width: c.width, height: c.height, pixelAspect: c.pixelAspect, sizeChanged: true });
      continue;
    }
    times = spec.times;
  } else {
    c = aemcp.findComp(spec.ref);
    if (seen[c.id]) continue;
    var fd = c.frameDuration, raw = [], have = {};
    if (args.times) { for (var k = 0; k < args.times.length; k++) raw.push(args.times[k]); }
    else {
      var n = args.frames || 5, t0 = c.workAreaStart, last = Math.max(t0, t0 + c.workAreaDuration - fd);
      for (var q = 0; q < n; q++) raw.push(n === 1 ? t0 : t0 + (last - t0) * q / (n - 1));
    }
    for (var r = 0; r < raw.length; r++) {
      var fr = Math.max(0, Math.min(Math.round(c.duration / fd) - 1, Math.round(raw[r] / fd)));
      if (!have[fr]) { have[fr] = true; times.push(fr * fd); }
    }
  }
  seen[c.id] = true;
  var par = c.pixelAspect, dispW = c.width * par, fit = Math.min(1, max / Math.max(dispW, c.height));
  var W = Math.max(4, Math.round(dispW * fit)), H = Math.max(4, Math.round(c.height * fit)), frames = [];
  var tmp = tempComp("__aemcp_proof", W, H, 1, c.duration, c.frameRate), done = false;
  try {
    try { tmp.motionBlur = c.motionBlur; tmp.shutterAngle = c.shutterAngle; tmp.shutterPhase = c.shutterPhase; tmp.motionBlurSamplesPerFrame = c.motionBlurSamplesPerFrame; tmp.motionBlurAdaptiveSampleLimit = c.motionBlurAdaptiveSampleLimit; tmp.frameBlending = c.frameBlending; } catch (e) {}
    var l = tmp.layers.add(c), tr = l.property("ADBE Transform Group");
    tr.property("ADBE Anchor Point").setValue([c.width / 2, c.height / 2]);
    tr.property("ADBE Position").setValue([W / 2, H / 2]);
    tr.property("ADBE Scale").setValue([fit * 100, fit * 100, 100]);
    try { l.motionBlur = c.motionBlur; } catch (e) {}
    for (var j = 0; j < times.length; j++) {
      var f = new File(args.dir + "/" + args.prefix + c.id + "_" + j + ".png");
      if (f.exists) f.remove();
      // written after this script returns: Node waits for the files, then the render is undone
      tmp.saveFrameToPng(times[j], f);
      frames.push({ time: times[j], path: f.fsName });
    }
    done = true;
  } finally { if (!done) cleanNow(__clean); }
  out.push({ id: c.id, name: c.name, width: c.width, height: c.height, pixelAspect: par, frameRate: c.frameRate, renderW: W, renderH: H, frames: frames });
}
return { project: app.project.file ? app.project.file.fsName : null, comps: out, tmpLeft: tmpLeft, cleanup: __clean };`;

interface Rendered {
  id: number;
  name?: string;
  width?: number;
  height?: number;
  pixelAspect?: number;
  frameRate?: number;
  renderW?: number;
  renderH?: number;
  missing?: boolean;
  sizeChanged?: boolean;
  frames?: { time: number; path: string }[];
}
export interface CompProof { id: number; name: string; width: number; height: number; pixelAspect: number; frameRate: number; renderW: number; renderH: number; frames: { time: number; file: string }[] }
export interface Manifest { id: string; createdAt: string; project: string | null; maxSize: number; comps: CompProof[] }

/** Wait until After Effects has finished writing each file (saveFrameToPng can finish asynchronously): complete PNGs (writtenSize) whose sizes hold still. */
async function waitForFiles(paths: string[]) {
  const deadline = Date.now() + 15_000 + paths.length * 2000;
  let last = "";
  for (;;) {
    const sizes = paths.map(writtenSize);
    const now = sizes.join(",");
    if (sizes.every((s) => s > 0) && now === last) return;
    if (Date.now() > deadline) break;
    last = now;
    await new Promise((r) => setTimeout(r, 100));
  }
  const missing = paths.find((p) => writtenSize(p) <= 0);
  if (missing) throw new Error(`After Effects did not write the frame ${missing}.`);
}

async function render(comps: unknown[], extra: { times?: number[]; frames?: number; maxSize: number }, dir: string, prefix: string) {
  let waitError: unknown;
  // all files together, with one deadline, before the cleanup (an error is thrown after it)
  const { r } = await runRender(PROVE_RENDER_JSX, { comps, ...extra, dir, prefix }, { undoGroup: "Surehand MCP proof", timeoutMs: 600_000 }, async (res) => {
    await waitForFiles((res.comps as Rendered[]).flatMap((c) => (c.frames ?? []).map((f) => f.path))).catch((e) => void (waitError = e));
    return [];
  });
  if (!r.ok) throw new Error(r.error?.message || "After Effects could not render the frames.");
  const res = r.result as { project: string | null; comps: Rendered[]; tmpLeft?: boolean };
  const note = renderCleanupNote(r, res.tmpLeft, "__aemcp_proof");
  if (waitError) throw waitError;
  return { ...res, note };
}

// ---------- storage ----------

/** Remove proofs older than 7 days, then the oldest beyond `keep`. Ids start with a timestamp, so they sort by age. */
export function pruneProofs(keep = MAX_PROOFS, now = Date.now()) {
  const root = proofsRoot();
  let ids: string[] = [];
  try {
    ids = readdirSync(root).sort();
  } catch {
    return;
  }
  const remove = (id: string) => rmSync(join(root, id), { recursive: true, force: true });
  const live = ids.filter((id) => {
    try {
      if (now - statSync(join(root, id)).mtimeMs <= MAX_AGE_MS) return true;
    } catch {}
    remove(id);
    return false;
  });
  for (const id of live.slice(0, Math.max(0, live.length - keep))) remove(id);
}

function loadManifest(id?: string): Manifest | string {
  const root = proofsRoot();
  if (id !== undefined && !/^[\w-]+$/.test(id)) return `"${id}" is not a proof id.`;
  let pick = id;
  if (pick === undefined) {
    try {
      pick = readdirSync(root).filter((d) => existsSync(join(root, d, "manifest.json"))).sort().pop();
    } catch {}
    if (!pick) return 'No proof has been captured yet. Use action "capture" first (or "run").';
  }
  try {
    return JSON.parse(readFileSync(join(root, pick, "manifest.json"), "utf8"));
  } catch {
    return `Proof ${pick} not found (proofs are kept for 7 days, at most ${MAX_PROOFS}). Capture again with action "capture".`;
  }
}

// to the millisecond, so "the latest proof" (ids sorted) is right even for proofs made in the same second
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\.(\d{3})Z$/, "$1");

/** Render reference frames and store them with a manifest under ~/.surehand/ae/proofs/<id>/. */
export async function captureProof(input: { comps?: (number | string)[]; times?: number[]; frames?: number; maxSize?: number }): Promise<Manifest & { note?: string }> {
  pruneProofs(MAX_PROOFS - 1);
  const id = `${stamp()}-${randomBytes(2).toString("hex")}`;
  const dir = join(proofsRoot(), id);
  mkdirSync(dir, { recursive: true });
  const maxSize = input.maxSize ?? 1920;
  try {
    const refs = input.comps?.length ? input.comps : ["active"];
    const res = await render(refs.map((ref) => ({ ref })), { times: input.times, frames: input.frames, maxSize }, dir, "");
    const m: Manifest = {
      id,
      createdAt: new Date().toISOString(),
      project: res.project,
      maxSize,
      comps: res.comps.map((c) => ({
        id: c.id, name: c.name!, width: c.width!, height: c.height!, pixelAspect: c.pixelAspect!, frameRate: c.frameRate!, renderW: c.renderW!, renderH: c.renderH!,
        frames: (c.frames ?? []).map((f) => ({ time: f.time, file: basename(f.path) })),
      })),
    };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(m, null, 1));
    return res.note ? { ...m, note: res.note } : m;
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

// ---------- comparing ----------

export interface Diff {
  /** largest difference of any channel (R, G, B, alpha), 0-255 */
  maxDiff: number;
  /** pixels that differ at all / beyond the tolerance */
  changed: number;
  over: number;
  total: number;
  /** largest CIE76 color difference (sRGB composited over black, to Lab) */
  maxDeltaE: number;
  /** [x, y, width, height] around the pixels beyond the tolerance */
  box: [number, number, number, number] | null;
}

/** Difference of pixel i (0-255; pixels transparent in both images are equal whatever their color). */
function pixelDiff(a: Image, b: Image, i: number, sa: number, sb: number) {
  const o = i * 4, A = a.data, B = b.data;
  if (A[o + 3] === 0 && B[o + 3] === 0) return 0;
  return Math.max(Math.abs(A[o] * sa - B[o] * sb), Math.abs(A[o + 1] * sa - B[o + 1] * sb), Math.abs(A[o + 2] * sa - B[o + 2] * sb), Math.abs(A[o + 3] * sa - B[o + 3] * sb));
}

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fLab = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
function lab(img: Image, i: number): [number, number, number] {
  const o = i * 4, m = img.max, al = img.data[o + 3] / m;
  const r = lin((img.data[o] / m) * al), g = lin((img.data[o + 1] / m) * al), bl = lin((img.data[o + 2] / m) * al);
  const x = fLab((0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047), y = fLab(0.2126 * r + 0.7152 * g + 0.0722 * bl), z = fLab((0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

export function diffImages(a: Image, b: Image, tolerance = 0): Diff {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`The images have different sizes (${a.width}x${a.height} and ${b.width}x${b.height}).`);
  const sa = 255 / a.max, sb = 255 / b.max, w = a.width, total = w * a.height;
  let maxDiff = 0, changed = 0, over = 0, maxDeltaE = 0, x0 = w, y0 = a.height, x1 = -1, y1 = -1;
  for (let i = 0; i < total; i++) {
    const d = pixelDiff(a, b, i, sa, sb);
    if (d === 0) continue;
    changed++;
    if (d > maxDiff) maxDiff = d;
    const p = lab(a, i), q = lab(b, i);
    maxDeltaE = Math.max(maxDeltaE, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
    if (d <= tolerance) continue;
    over++;
    const x = i % w, y = (i - x) / w;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { maxDiff, changed, over, total, maxDeltaE, box: over ? [x0, y0, x1 - x0 + 1, y1 - y0 + 1] : null };
}

/**
 * The difference as a PNG: black = identical, dark blue = differs within the tolerance, gray to white =
 * differs beyond it (every such pixel at least gray, brighter = larger). At most `maxSide` pixels on the
 * longest side: blocks keep their largest difference, so a single changed pixel stays visible.
 */
export function diffPicture(a: Image, b: Image, tolerance = 0, maxSide = 1280): { png: Buffer; width: number; height: number } {
  const sa = 255 / a.max, sb = 255 / b.max, w = a.width, h = a.height;
  const k = Math.max(1, Math.ceil(Math.max(w, h) / maxSide)), W = Math.ceil(w / k), H = Math.ceil(h / k);
  const pooled = new Float32Array(W * H);
  let top = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = pixelDiff(a, b, y * w + x, sa, sb), j = Math.floor(y / k) * W + Math.floor(x / k);
      if (d > pooled[j]) pooled[j] = d;
      if (d > top) top = d;
    }
  const rgb = new Uint8Array(W * H * 3);
  for (let j = 0; j < W * H; j++) {
    const d = pooled[j];
    if (d === 0) continue;
    if (d <= tolerance) rgb[j * 3 + 2] = 96;
    else rgb[j * 3] = rgb[j * 3 + 1] = rgb[j * 3 + 2] = Math.round(64 + (191 * d) / top);
  }
  return { png: encodePng(W, H, rgb, 3), width: W, height: H };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (n: number, total: number) => (n / total < 0.0001 && n > 0 ? "<0.01" : String(r2((100 * n) / total)));
const frameLabel = (t: number, fps: number) => `${r2(t)}s (f${Math.round(t * fps)})`;

export const DEFAULT_TOLERANCE = 0.5;

/**
 * Why the open project can't be compared with the proof's reference (null when it can). Comp ids are only
 * unique within one project: a reference captured in a saved project is compared only in that same file. A
 * reference captured in an unsaved project (no path to check) is compared only if every comp still has the
 * same id, name and size, and the result says the project could not be confirmed.
 */
export function otherProject(m: Pick<Manifest, "project" | "comps">, res: { project: string | null; comps: Rendered[] }): string | null {
  const ids = "comp ids may refer to different comps";
  if (m.project && res.project !== m.project)
    return `the reference was captured in ${m.project}, but the open project is ${res.project ?? "an unsaved project"} (${ids})`;
  if (!m.project) {
    const renamed = m.comps.filter((c) => {
      const now = res.comps.find((r) => r.id === c.id);
      return now && !now.missing && now.name !== c.name;
    });
    if (renamed.length)
      return `the reference was captured in an unsaved project and ${renamed.map((c) => `comp id ${c.id} ("${c.name}")`).join(", ")} now has another name, so it can't be confirmed that this is the same project (${ids})`;
  }
  return null;
}

export interface Comparison {
  verdict: "identical" | "identical within tolerance" | "differs" | "incomplete";
  text: string;
  image?: { data: string; label: string };
  /** for the in-chat view: every reference frame and how it compared, and this comparison's stamp */
  view?: { id: string; createdAt: string; compared: string; head: string; tolerance: number; maxDiff: number; comps: string[]; frames: ProofFrame[] };
}

/**
 * The frames of a proof's latest comparison, kept beside its reference frames (proofs/<id>/after/, replaced by
 * the next comparison, removed with the proof after 7 days or beyond 30 proofs): the in-chat view shows them on
 * demand (ae_view_proof_frame). compared.json names the comparison they belong to.
 */
export const afterDir = (id: string) => join(proofsRoot(), id, "after");
export const proofDir = (id: string) => join(proofsRoot(), id);
export { loadManifest };

/** Move a comparison's rendered frames into the proof (afterDir), replacing the last comparison's; updates their paths. */
function keepAfterFrames(id: string, compared: string, comps: Rendered[]) {
  const dir = afterDir(id);
  try {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const c of comps)
      for (const [i, f] of (c.frames ?? []).entries()) {
        const to = join(dir, `${c.id}_${i}.png`);
        try {
          renameSync(f.path, to);
          f.path = to;
        } catch {
          // left in the temp folder (removed after the comparison): the view can't show this frame
        }
      }
    writeFileSync(join(dir, "compared.json"), JSON.stringify({ compared }));
  } catch {
    // the comparison itself doesn't depend on it
  }
}

/** Render the proof's comps and times again and compare them with the stored reference frames. */
export async function compareProof(input: { id?: string; tolerance?: number }): Promise<Comparison | string> {
  const m = loadManifest(input.id);
  if (typeof m === "string") return m;
  // default: under half an 8-bit step, so 16/32 bpc rounding (e.g. 0.02/255 after a precompose) doesn't count,
  // while any change that shows in 8-bit output does; tolerance 0 asks for bit-identical
  const tol = input.tolerance ?? DEFAULT_TOLERANCE;
  const tmp = appFile("tmp");
  mkdirSync(tmp, { recursive: true });
  const specs = m.comps.map((c) => ({ id: c.id, times: c.frames.map((f) => f.time), width: c.width, height: c.height, pixelAspect: c.pixelAspect }));
  const prefix = `aemcp_proof_${Date.now()}_${randomBytes(2).toString("hex")}_`;
  const lines: string[] = [];
  const problems: string[] = [];
  const differing: string[] = [];
  const notes: string[] = [];
  let frames = 0, top = 0;
  let worst: { score: [number, number]; a: Image; b: Image; label: string } | null = null;
  const viewFrames: ProofFrame[] = [], compared = `${stamp()}-${randomBytes(2).toString("hex")}`;
  const vf = (c: CompProof, i: number, more: Partial<ProofFrame>) =>
    viewFrames.push({ comp: c.name, compId: c.id, index: i, time: c.frames[i].time, tc: timecode(c.frames[i].time, c.frameRate), differs: false, ...more });
  try {
    const res = await render(specs, { maxSize: m.maxSize }, tmp, prefix);
    if (res.note) notes.push(res.note);
    keepAfterFrames(m.id, compared, res.comps);
    const other = otherProject(m, res);
    if (other) problems.push(other), m.comps.forEach((c) => c.frames.forEach((_, i) => vf(c, i, { missing: true })));
    else if (!m.project) notes.push("Note: the reference was captured in an unsaved project, so it can't be confirmed that this is the same project; the comps were matched by id, and their names are unchanged.");
    for (const c of other ? [] : m.comps) {
      const now = res.comps.find((r) => r.id === c.id);
      const title = `"${c.name}" (id ${c.id})`;
      if (!now || now.missing) {
        c.frames.forEach((_, i) => vf(c, i, { missing: true }));
        problems.push(`${title} was deleted since the capture`);
        lines.push(`${title}: deleted since the capture (no comp with this id), not compared.`);
        continue;
      }
      const renamed = now.name !== c.name ? ` (renamed to "${now.name}")` : "";
      if (now.sizeChanged) {
        c.frames.forEach((_, i) => vf(c, i, { missing: true }));
        problems.push(`${title} changed size`);
        lines.push(`${title}${renamed}: size changed from ${c.width}x${c.height} (pixel aspect ${c.pixelAspect}) to ${now.width}x${now.height} (pixel aspect ${now.pixelAspect}), so its frames can't be compared pixel for pixel.`);
        continue;
      }
      const scale = c.renderW === Math.round(c.width * c.pixelAspect) && c.renderH === c.height ? "" : `, rendered at ${c.renderW}x${c.renderH} (maxSize ${m.maxSize}): differences smaller than a rendered pixel can be missed`;
      lines.push(`${title}${renamed}, ${c.width}x${c.height}${scale}:`);
      for (const [i, ref] of c.frames.entries()) {
        const label = frameLabel(ref.time, c.frameRate);
        const path = now.frames?.[i]?.path;
        let a: Image, b: Image;
        try {
          a = decodePng(readFileSync(join(proofsRoot(), m.id, ref.file)));
          b = decodePng(readFileSync(path!));
        } catch (e: any) {
          vf(c, i, { missing: true });
          problems.push(`${title} at ${label} could not be read`);
          lines.push(`  ${label}: could not compare: ${e?.message ?? e}`);
          continue;
        }
        frames++;
        if (a.width !== b.width || a.height !== b.height) {
          vf(c, i, { differs: true });
          differing.push(`"${c.name}" at ${label}`);
          lines.push(`  ${label}: DIFFERS: rendered ${b.width}x${b.height}, the reference is ${a.width}x${a.height}.`);
          continue;
        }
        const d = diffImages(a, b, tol);
        top = Math.max(top, d.maxDiff);
        vf(c, i, { differs: d.over > 0, maxDiff: r2(d.maxDiff) });
        if (!d.changed) lines.push(`  ${label}: identical`);
        else if (!d.over) lines.push(`  ${label}: identical within tolerance (max channel difference ${r2(d.maxDiff)}/255 on ${d.changed} px, max ΔE ${r2(d.maxDeltaE)})`);
        else {
          differing.push(`"${c.name}" at ${label}`);
          const [x, y, w, h] = d.box!;
          lines.push(
            `  ${label}: DIFFERS: ${d.over.toLocaleString("en-US")} px (${pct(d.over, d.total)}%) beyond the tolerance, max channel difference ${r2(d.maxDiff)}/255, ` +
              `max ΔE ${r2(d.maxDeltaE)}, inside x ${x}-${x + w - 1}, y ${y}-${y + h - 1} (${w}x${h} rendered px)`,
          );
        }
        const score: [number, number] = [d.over, d.maxDiff];
        if (d.changed && (!worst || score[0] > worst.score[0] || (score[0] === worst.score[0] && score[1] > worst.score[1]))) worst = { score, a, b, label: `"${c.name}" at ${label}` };
      }
    }
  } finally {
    // also when the render failed half way: every frame this comparison wrote starts with its prefix
    try {
      for (const f of readdirSync(tmp)) if (f.startsWith(prefix)) rmSync(join(tmp, f), { force: true });
    } catch {}
  }
  const tolText = !tol ? "tolerance 0: bit-identical" : input.tolerance === undefined ? `default tolerance ${tol}/255: less than one 8-bit step` : `tolerance ${tol}/255 per channel`;
  let verdict: Comparison["verdict"];
  let head: string;
  if (differing.length) {
    verdict = "differs";
    head = `Verdict: DIFFERS in ${differing.length} of ${frames} frames (${tolText}): ${differing.join(", ")}.`;
    if (problems.length) head += ` Also not compared: ${problems.join("; ")}.`;
  } else if (problems.length || !frames) {
    verdict = "incomplete";
    head = `Verdict: NOT PROVEN: ${problems.join("; ") || "no frames to compare"}.${frames ? ` The ${frames} frames that could be compared match (${tolText}).` : ""}`;
  } else if (top === 0) {
    verdict = "identical";
    head = `Verdict: IDENTICAL: all ${frames} frames are bit-identical to the reference.`;
  } else {
    verdict = "identical within tolerance";
    head = `Verdict: IDENTICAL WITHIN TOLERANCE: all ${frames} frames match within ${tol}/255 per channel (largest difference ${r2(top)}/255${top < 1 ? ": high-bit-depth rounding, invisible in 8-bit output; pass tolerance 0 to require bit-identical" : ""}).`;
  }
  const text = [head, `Proof ${m.id} (reference captured ${m.createdAt}).`, ...lines, ...notes].join("\n");
  const view = { id: m.id, createdAt: m.createdAt, compared, head, tolerance: tol, maxDiff: r2(top), comps: m.comps.map((c) => c.name), frames: viewFrames };
  if (!worst) return { verdict, text, view };
  const pic = diffPicture(worst.a, worst.b, tol);
  return {
    verdict,
    text,
    view,
    image: {
      data: pic.png.toString("base64"),
      label: `Difference image of ${worst.label} (${pic.width}x${pic.height}): black = identical, dark blue = within the tolerance, gray to white = beyond it (brighter = larger).`,
    },
  };
}

const VERDICT_WORD = { identical: "IDENTICAL", "identical within tolerance": "IDENTICAL", differs: "DIFFERS", incomplete: "NOT PROVEN" } as const;
const hhmm = (iso: string) => {
  const d = new Date(iso), now = new Date(), p2 = (n: number) => String(n).padStart(2, "0");
  const time = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return d.toDateString() === now.toDateString() ? time : `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${time}`;
};

/** The in-chat view's data for a comparison, with the edit's changes when it was a run. */
export function proofView(c: Comparison, edit?: { changes?: Changes; name?: string }): ChangesView | undefined {
  const v = c.view;
  if (!v) return undefined;
  const compared = v.frames.filter((f) => !f.missing).length;
  return {
    view: "changes",
    source: "proof",
    title: `${edit ? "Proven edit" : "Proof"} · ${v.comps.join(", ")}`,
    subtitle: `reference ${hhmm(v.createdAt)} → now · ${compared} frame${compared === 1 ? "" : "s"} compared`,
    proof: { id: v.id, compared: v.compared, verdict: VERDICT_WORD[c.verdict], verdictLine: v.head.replace(/^Verdict: /, ""), tolerance: v.tolerance, maxDiff: v.maxDiff, frames: v.frames },
    ...capChanges(edit ? changesFromReport(edit.changes) : []),
    footnote: edit ? "One undo step in After Effects" : "",
  };
}

function comparisonResult(c: Comparison, extra?: string, edit?: { changes?: Changes }): CallToolResult {
  const content: CallToolResult["content"] = [{ type: "text", text: c.text }];
  if (c.image) content.push({ type: "image", data: c.image.data, mimeType: "image/png" }, { type: "text", text: c.image.label });
  if (extra) content.push({ type: "text", text: extra });
  // the in-chat view's data: in _meta, so the text and images stay exactly as they are
  const view = proofView(c, edit);
  return view ? { content, _meta: { [VIEW_META_KEY]: view } } : { content };
}

const describeCapture = (m: Manifest) =>
  `Captured proof ${m.id}: ${m.comps.map((c) => `"${c.name}" (id ${c.id}) at ${c.frames.map((f) => frameLabel(f.time, c.frameRate)).join(", ")}`).join("; ")}. ` +
  `Make the change, then call ae_prove_identical {action: "compare", id: "${m.id}"}.`;

export interface ProveInput {
  action: "capture" | "compare" | "run";
  comps?: (number | string)[];
  times?: number[];
  frames?: number;
  maxSize?: number;
  id?: string;
  tolerance?: number;
  steps?: { tool: string; args?: Record<string, unknown> }[];
  atomic?: boolean;
  name?: string;
  checkpoint?: boolean;
  verbose?: boolean;
}

export async function prove(input: ProveInput, perm: { mode: string; allowShell: boolean }): Promise<CallToolResult> {
  if (input.action === "capture") {
    const m = await captureProof(input);
    return { content: [{ type: "text", text: describeCapture(m) + (m.note ? `\n${m.note}` : "") }] };
  }
  if (input.action === "compare") {
    const c = await compareProof(input);
    return typeof c === "string" ? errorResult(c) : comparisonResult(c);
  }
  if (!input.steps?.length) return errorResult('action "run" needs steps (the same as ae_batch steps).');
  // the point of "run" is an edit, which read-only mode refuses (ae_batch would refuse it after the capture)
  if (perm.mode === "read-only") return errorResult(READ_ONLY_REFUSAL);
  const m = await captureProof(input);
  // ae_batch exactly: shell check, approval in "ask" mode, one undo step, atomic rollback
  const edit: { changes?: Changes } = {};
  const b = await runBatch({ steps: input.steps, atomic: input.atomic, name: input.name, checkpoint: input.checkpoint, verbose: input.verbose }, perm, edit);
  const batchText = b.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  if (b.isError)
    return { isError: true, content: [{ type: "text", text: `${batchText}\n\nNothing was compared: the batch did not complete. The reference frames are kept as proof ${m.id}.` }] };
  try {
    const c = await compareProof({ id: m.id, tolerance: input.tolerance });
    if (typeof c === "string") throw new Error(c);
    return comparisonResult(c, `Edits (one undo step):\n${batchText}${m.note ? `\n${m.note}` : ""}`, edit);
  } catch (e: any) {
    // whatever fails after the batch, never let it look as if the edits were not made
    return {
      isError: true,
      content: [{ type: "text", text: `The batch WAS applied (one undo step), but the comparison failed: ${e?.message ?? e}\nThe reference frames are kept as proof ${m.id}: compare again with ae_prove_identical {action: "compare", id: "${m.id}"}.\n\n${batchText}` }],
    };
  }
}

export function registerProveTools(server: McpServer) {
  // compare and run are shown as the "What changed, and the proof" view where the AI app has in-chat views
  registerViewTool(
    server,
    "ae_prove_identical",
    {
      _meta: { ui: { resourceUri: CHANGES_VIEW_URI } },
      title: "Prove the render is unchanged",
      description:
        "Prove a structural change (un-precompose, bake expressions, reorder effects, simplify a rig) left the render unchanged, or show which " +
        "frames and areas differ. capture: render reference frames (default: active comp, 5 frames over the work area), returns a proof id. " +
        "compare: render them again and compare pixel by pixel (verdict, per-frame max difference, changed pixels, ΔE, area, difference image). " +
        "run: capture, ae_batch steps, compare, in one call. For un-precompose, prove the parent comp. " +
        "Only the sampled video frames are compared (alpha included; not audio, the comp background color or times between samples; 32 bpc values above 1.0 are clamped).",
      inputSchema: {
        action: z.enum(["capture", "compare", "run"]),
        comps: z.array(z.union([z.number().int(), z.string()])).min(1).max(4).optional().describe("capture/run: comps to prove (item id or exact name; default the active comp)."),
        times: z.array(z.number()).min(1).max(24).optional().describe("capture/run: exact times in seconds (snapped to frames) instead of evenly spaced frames."),
        frames: z.number().int().min(1).max(24).optional().describe("capture/run: number of frames spread over each comp's work area (default 5)."),
        maxSize: z.number().int().min(64).max(4096).optional().describe("capture/run: longest rendered side in pixels (default 1920; larger comps are scaled down)."),
        id: z.string().optional().describe("compare: the proof id from capture (default the latest proof)."),
        tolerance: z.number().min(0).max(255).optional().describe("compare/run: allowed difference per channel, 0-255 (default 0.5: less than one 8-bit step, so only 16/32 bpc rounding is allowed; 0 = bit-identical)."),
        steps: z.array(z.object({ tool: z.string(), args: z.record(z.string(), z.any()).optional() })).min(1).max(200).optional().describe("run: the edits, as ae_batch steps."),
        atomic: z.boolean().optional().describe("run: as ae_batch (default true: a failed step undoes everything, and nothing is compared)."),
        name: z.string().optional().describe("run: undo step name."),
        checkpoint: z.boolean().optional().describe("run: save a project checkpoint before the edits."),
        verbose: z.boolean().optional().describe("run: full result of each step."),
      },
      // run executes ae_batch steps, which can be ae_run_script
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input: ProveInput) => {
      try {
        return await prove(input, permissions());
      } catch (e) {
        return viewError(e);
      }
    },
  );
}
