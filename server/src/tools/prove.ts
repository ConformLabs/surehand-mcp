// Proven edits: render reference frames, make a structural change, render again and compare in Node,
// so "un-precompose / bake / reorder, nothing changed" comes back with evidence (or exactly what differs).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { runJsx } from "../jsx.js";
import { permissions, READ_ONLY_REFUSAL } from "../permissions.js";
import { decodePng, encodePng, type Image } from "../png.js";
import { errorResult } from "./registry.js";
import { runBatch } from "./workflow.js";

export const MAX_PROOFS = 30;
export const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const proofsRoot = () => join(homedir(), ".aemcp", "proofs");

/**
 * Renders frames of comps the way ae_render_frame does (a temporary comp, removed in `finally`, all in
 * one undo group): the comp at full size (capped by maxSize), transparent background. args.comps: {ref}
 * to capture (times from args.times or args.frames over the work area, snapped to frames), or {id, times,
 * width, height, pixelAspect} to render again (a deleted comp or a changed size is reported, not rendered).
 */
export const PROVE_RENDER_JSX = `
var out = [], seen = {}, max = args.maxSize || 1920;
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
  var tmp = app.project.items.addComp("__aemcp_proof", W, H, 1, c.duration, c.frameRate);
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
      tmp.saveFrameToPng(times[j], f);
      var waited = 0; while (!f.exists && waited < 10000) { $.sleep(50); waited += 50; }
      frames.push({ time: times[j], path: f.fsName });
    }
  } finally { try { tmp.remove(); } catch (e) {} }
  out.push({ id: c.id, name: c.name, width: c.width, height: c.height, pixelAspect: par, frameRate: c.frameRate, renderW: W, renderH: H, frames: frames });
}
return { project: app.project.file ? app.project.file.fsName : null, comps: out };`;

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

/** Wait until After Effects has finished writing each file (saveFrameToPng can finish asynchronously). */
async function waitForFiles(paths: string[]) {
  const deadline = Date.now() + 15_000 + paths.length * 2000;
  let last = "";
  for (;;) {
    const sizes = paths.map((p) => (existsSync(p) ? statSync(p).size : 0));
    const now = sizes.join(",");
    if (sizes.every((s) => s > 0) && now === last) return;
    if (Date.now() > deadline) break;
    last = now;
    await new Promise((r) => setTimeout(r, 100));
  }
  const missing = paths.find((p) => !existsSync(p));
  if (missing) throw new Error(`After Effects did not write the frame ${missing}.`);
}

async function render(comps: unknown[], extra: { times?: number[]; frames?: number; maxSize: number }, dir: string, prefix: string) {
  const r = await runJsx(PROVE_RENDER_JSX, { comps, ...extra, dir, prefix }, { undoGroup: "Surehand MCP proof", timeoutMs: 600_000, depth: 6 });
  if (!r.ok) throw new Error(r.error?.message || "After Effects could not render the frames.");
  const res = r.result as { project: string | null; comps: Rendered[] };
  await waitForFiles(res.comps.flatMap((c) => (c.frames ?? []).map((f) => f.path)));
  return res;
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

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\..+$/, "");

/** Render reference frames and store them with a manifest under ~/.aemcp/proofs/<id>/. */
export async function captureProof(input: { comps?: (number | string)[]; times?: number[]; frames?: number; maxSize?: number }): Promise<Manifest> {
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
    return m;
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

export interface Comparison { verdict: "identical" | "identical within tolerance" | "differs" | "incomplete"; text: string; image?: { data: string; label: string } }

/** Render the proof's comps and times again and compare them with the stored reference frames. */
export async function compareProof(input: { id?: string; tolerance?: number }): Promise<Comparison | string> {
  const m = loadManifest(input.id);
  if (typeof m === "string") return m;
  const tol = input.tolerance ?? 0;
  const tmp = join(homedir(), ".aemcp", "tmp");
  mkdirSync(tmp, { recursive: true });
  const specs = m.comps.map((c) => ({ id: c.id, times: c.frames.map((f) => f.time), width: c.width, height: c.height, pixelAspect: c.pixelAspect }));
  const res = await render(specs, { maxSize: m.maxSize }, tmp, `aemcp_proof_${Date.now()}_`);
  const lines: string[] = [];
  const problems: string[] = [];
  const differing: string[] = [];
  let frames = 0, top = 0;
  let worst: { score: [number, number]; a: Image; b: Image; label: string } | null = null;
  try {
    for (const c of m.comps) {
      const now = res.comps.find((r) => r.id === c.id);
      const title = `"${c.name}" (id ${c.id})`;
      if (!now || now.missing) {
        problems.push(`${title} was deleted since the capture`);
        lines.push(`${title}: deleted since the capture (no comp with this id), not compared.`);
        continue;
      }
      const renamed = now.name !== c.name ? ` (renamed to "${now.name}")` : "";
      if (now.sizeChanged) {
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
          problems.push(`${title} at ${label} could not be read`);
          lines.push(`  ${label}: could not compare: ${e?.message ?? e}`);
          continue;
        }
        frames++;
        if (a.width !== b.width || a.height !== b.height) {
          differing.push(`"${c.name}" at ${label}`);
          lines.push(`  ${label}: DIFFERS: rendered ${b.width}x${b.height}, the reference is ${a.width}x${a.height}.`);
          continue;
        }
        const d = diffImages(a, b, tol);
        top = Math.max(top, d.maxDiff);
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
    for (const r of res.comps)
      for (const f of r.frames ?? [])
        try {
          unlinkSync(f.path);
        } catch {}
  }
  const tolText = tol ? `tolerance ${tol}/255 per channel` : "tolerance 0: bit-identical";
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
    head = `Verdict: IDENTICAL WITHIN TOLERANCE: all ${frames} frames match within ${tol}/255 per channel (largest difference ${r2(top)}/255).`;
  }
  const notes: string[] = [];
  if (m.project !== res.project) notes.push(`Note: the reference was captured in ${m.project ?? "an unsaved project"}; the open project is ${res.project ?? "unsaved"}.`);
  const text = [head, `Proof ${m.id} (reference captured ${m.createdAt}).`, ...lines, ...notes].join("\n");
  if (!worst) return { verdict, text };
  const pic = diffPicture(worst.a, worst.b, tol);
  return {
    verdict,
    text,
    image: {
      data: pic.png.toString("base64"),
      label: `Difference image of ${worst.label} (${pic.width}x${pic.height}): black = identical, dark blue = within the tolerance, gray to white = beyond it (brighter = larger).`,
    },
  };
}

function comparisonResult(c: Comparison, extra?: string): CallToolResult {
  const content: CallToolResult["content"] = [{ type: "text", text: c.text }];
  if (c.image) content.push({ type: "image", data: c.image.data, mimeType: "image/png" }, { type: "text", text: c.image.label });
  if (extra) content.push({ type: "text", text: extra });
  return { content };
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
  if (input.action === "capture") return { content: [{ type: "text", text: describeCapture(await captureProof(input)) }] };
  if (input.action === "compare") {
    const c = await compareProof(input);
    return typeof c === "string" ? errorResult(c) : comparisonResult(c);
  }
  if (!input.steps?.length) return errorResult('action "run" needs steps (the same as ae_batch steps).');
  // the point of "run" is an edit, which read-only mode refuses (ae_batch would refuse it after the capture)
  if (perm.mode === "read-only") return errorResult(READ_ONLY_REFUSAL);
  const m = await captureProof(input);
  // ae_batch exactly: shell check, approval in "ask" mode, one undo step, atomic rollback
  const b = await runBatch({ steps: input.steps, atomic: input.atomic, name: input.name, checkpoint: input.checkpoint, verbose: input.verbose }, perm);
  const batchText = b.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  if (b.isError)
    return { isError: true, content: [{ type: "text", text: `${batchText}\n\nNothing was compared: the batch did not complete. The reference frames are kept as proof ${m.id}.` }] };
  let c: Comparison | string;
  try {
    c = await compareProof({ id: m.id, tolerance: input.tolerance });
  } catch (e: any) {
    c = `The comparison failed: ${e?.message ?? e}`;
  }
  if (typeof c === "string")
    return { isError: true, content: [{ type: "text", text: `The batch WAS applied, but: ${c}\nCompare again with ae_prove_identical {action: "compare", id: "${m.id}"}.\n\n${batchText}` }] };
  return comparisonResult(c, `Edits (one undo step):\n${batchText}`);
}

export function registerProveTools(server: McpServer) {
  server.registerTool(
    "ae_prove_identical",
    {
      title: "Prove the render is unchanged",
      description:
        "Prove a structural change (un-precompose, bake expressions, reorder effects, simplify a rig) left the render unchanged, or show which " +
        "frames and areas differ. capture: render reference frames (default: active comp, 5 frames over the work area), returns a proof id. " +
        "compare: render them again and compare pixel by pixel (verdict, per-frame max difference, changed pixels, ΔE, area, difference image). " +
        "run: capture, ae_batch steps, compare, in one call. For un-precompose, prove the parent comp.",
      inputSchema: {
        action: z.enum(["capture", "compare", "run"]),
        comps: z.array(z.union([z.number().int(), z.string()])).min(1).max(4).optional().describe("capture/run: comps to prove (item id or exact name; default the active comp)."),
        times: z.array(z.number()).min(1).max(24).optional().describe("capture/run: exact times in seconds (snapped to frames) instead of evenly spaced frames."),
        frames: z.number().int().min(1).max(24).optional().describe("capture/run: number of frames spread over each comp's work area (default 5)."),
        maxSize: z.number().int().min(64).max(4096).optional().describe("capture/run: longest rendered side in pixels (default 1920; larger comps are scaled down)."),
        id: z.string().optional().describe("compare: the proof id from capture (default the latest proof)."),
        tolerance: z.number().min(0).max(255).optional().describe("compare/run: allowed difference per channel, 0-255 (default 0 = bit-identical; 1 allows rounding)."),
        steps: z.array(z.object({ tool: z.string(), args: z.record(z.string(), z.any()).optional() })).min(1).max(200).optional().describe("run: the edits, as ae_batch steps."),
        atomic: z.boolean().optional().describe("run: as ae_batch (default true: a failed step undoes everything, and nothing is compared)."),
        name: z.string().optional().describe("run: undo step name."),
        checkpoint: z.boolean().optional().describe("run: save a project checkpoint before the edits."),
        verbose: z.boolean().optional().describe("run: full result of each step."),
      },
      // run executes ae_batch steps, which can be ae_run_script
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        return await prove(input, permissions());
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
