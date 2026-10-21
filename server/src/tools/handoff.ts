// The handoff packager: collect the project and its footage into a folder (like File > Dependencies > Collect Files),
// write a manifest of what the recipient needs (fonts, plug-ins, color settings, footage specs), and optionally prove
// the package opens and renders the same as the user's project: aerender renders sample frames from both, each in its
// own process, and they are compared pixel by pixel with ae_prove_identical's comparison.
//
// The user's open project is never edited. After Effects has no "save a copy" for scripts, so the copy is made with
// Save As and the user's project is opened again from disk at the end; that is why a project with unsaved changes is
// refused, and why the result checks the file is byte-identical and the reopened project has no unsaved changes.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { constants, copyFile, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { VERSION } from "../config.js";
import { runJsx } from "../jsx.js";
import { permissions, READ_ONLY_REFUSAL } from "../permissions.js";
import { decodePng, type Image } from "../png.js";
import { appFile } from "../paths.js";
import { expandHome } from "./files.js";
import { HANDOFF_SCAN_JSX, HANDOFF_WRITE_JSX } from "./handoff-jsx.js";
import { DEFAULT_TOLERANCE, diffImages, diffPicture } from "./prove.js";
import { errorResult } from "./registry.js";
import { aerenderPath } from "./renderjobs.js";

// ---------- what the scan JSX returns ----------

export interface HFootage {
  id: number;
  name: string;
  kind: "file" | "solid" | "placeholder";
  folder: string[];
  used: number;
  w?: number;
  h?: number;
  par?: number;
  dur?: number;
  fps?: number;
  nativeFps?: number;
  conformFps?: number;
  video?: boolean;
  audio?: boolean;
  still?: boolean;
  missing?: boolean;
  file?: string;
  missingPath?: string;
  seq?: boolean;
  alpha?: boolean;
  alphaMode?: string;
  color?: Record<string, unknown>;
  proxy?: { file: string; inUse: boolean; missing: boolean; seq: boolean };
}
export interface HScan {
  ae?: string;
  build?: string;
  os?: string;
  app?: string;
  file: string | null;
  dirty: boolean;
  items: number;
  engine?: string;
  color: Record<string, unknown>;
  comps: { id: number; name: string; w: number; h: number; par: number; fps: number; dur: number; was: number; wad: number; nl: number }[];
  footage: HFootage[];
  rq: { comp: number; queued: boolean }[];
  active?: number;
  layers: number;
  partial?: string;
  /** m: match name, n: first instance name, dn/cat/v: installed display name, category, version; x: not installed; k: instances; at: "comp > layer" */
  effects: { m: string; n: string; dn?: string; cat?: string; v?: string; x?: 1; k: number; at: string[] }[];
  fonts: { missing: { ps: string; family?: string; style?: string; sub: boolean }[]; used?: { ps: string; family?: string; style?: string; v?: string; adobe?: boolean; loc?: string; here?: string; n: number; at: string[] }[] } | null;
  textFonts?: { ps: string; family?: string; style?: string; at: string }[];
}

// ---------- planning the package (pure, apart from listing sequence frames and file sizes) ----------

export const FOOTAGE_DIR = "(Footage)";
export const MANIFEST_JSON = "handoff.json";
export const MANIFEST_TXT = "HANDOFF.txt";

const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32";
const key = (p: string) => (CASE_INSENSITIVE ? resolve(p).normalize("NFC").toLowerCase() : resolve(p).normalize("NFC"));
export const samePath = (a: string, b: string) => key(a) === key(b);
export function isInside(root: string, p: string) {
  const r = relative(key(root), key(p));
  return !!r && !r.startsWith("..") && !isAbsolute(r);
}
/** A project panel name as a file or folder name (no path separators or characters Windows refuses). */
export const safeName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").trim() || "_";

/** The frames of the image sequence whose first file is `first`: same folder, same name around the frame number. */
export function sequenceFrames(first: string): string[] {
  const m = /^(.*?)(\d+)(\.[^.]+)$/.exec(basename(first));
  if (!m) return [first];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${esc(m[1])}\\d+${esc(m[3])}$`, CASE_INSENSITIVE ? "i" : "");
  try {
    const dir = dirname(first);
    const frames = readdirSync(dir).filter((n) => re.test(n)).sort().map((n) => join(dir, n));
    return frames.length ? frames : [first];
  } catch {
    return [first];
  }
}

export interface CopyJob { src: string; dst: string; bytes: number }
export interface PlannedItem {
  id: number;
  name: string;
  /** relative to the package folder: the file, or the folder of a sequence */
  rel: string;
  seq: boolean;
  frames: number;
  bytes: number;
  /** what the copy's footage item points at (a sequence: the frame After Effects had) */
  relink: string;
  proxy?: { rel: string; relink: string; seq: boolean };
}
export interface Plan {
  root: string;
  aep: string;
  jobs: CopyJob[];
  items: PlannedItem[];
  /** footage not collected: [item, why] */
  skipped: [HFootage, string][];
}

/**
 * Where every collected file goes, like Collect Files: (Footage)/<the item's project panel folders>/<file>, a
 * sequence in a folder of its own. Two different sources never share a name (" 2", " 3" are added); one source
 * used by several items is copied once.
 */
export function planPackage(scan: HScan, root: string, collect: "used" | "all"): Plan {
  const aep = join(root, safeName(basename(scan.file ?? "Untitled.aep")));
  const taken = new Map<string, string>(), jobs = new Map<string, CopyJob>(), items: PlannedItem[] = [], skipped: Plan["skipped"] = [];
  const claim = (dir: string, name: string, owner: string, isDir: boolean) => {
    const dot = isDir ? -1 : name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
    for (let i = 1; ; i++) {
      const rel = join(dir, i === 1 ? name : `${stem} ${i}${ext}`), k = key(join(root, rel)), had = taken.get(k);
      if (!had || had === owner) {
        taken.set(k, owner);
        return rel;
      }
    }
  };
  const size = (p: string) => {
    try {
      return statSync(p).size;
    } catch {
      return 0;
    }
  };
  const place = (file: string, seq: boolean, dir: string) => {
    const frames = seq ? sequenceFrames(file) : [file];
    const rel = seq ? claim(dir, safeName(basename(dirname(file))), `seq:${key(dirname(file))}|${basename(file).replace(/\d+(\.[^.]+)$/, "#$1")}`, true) : claim(dir, basename(file), key(file), false);
    let bytes = 0;
    for (const f of frames) {
      const dst = join(root, seq ? join(rel, basename(f)) : rel), b = size(f);
      bytes += b;
      if (!jobs.has(key(dst))) jobs.set(key(dst), { src: f, dst, bytes: b });
    }
    return { rel, frames: frames.length, bytes, relink: join(root, seq ? join(rel, basename(file)) : rel) };
  };
  for (const f of scan.footage) {
    if (f.kind !== "file") continue;
    if (collect === "used" && !f.used) {
      skipped.push([f, "unused"]);
      continue;
    }
    if (f.missing || !f.file) {
      skipped.push([f, "missing"]);
      continue;
    }
    if (!existsSync(f.file)) {
      skipped.push([f, "not found on disk"]);
      continue;
    }
    const dir = join(FOOTAGE_DIR, ...f.folder.map(safeName));
    const p = place(f.file, !!f.seq, dir);
    const item: PlannedItem = { id: f.id, name: f.name, rel: p.rel, seq: !!f.seq, frames: p.frames, bytes: p.bytes, relink: p.relink };
    if (f.proxy && !f.proxy.missing && existsSync(f.proxy.file)) {
      const q = place(f.proxy.file, f.proxy.seq, dir);
      item.proxy = { rel: q.rel, relink: q.relink, seq: f.proxy.seq };
    }
    items.push(item);
  }
  return { root, aep, jobs: [...jobs.values()], items, skipped };
}

/** Why the package can't be written there, whatever overwrite says (null when it can). */
export function unsafeTarget(plan: Plan, original: string): string | null {
  if (samePath(plan.aep, original)) return `The package's project would be written over your project (${original}). Nothing was written. Choose another folder.`;
  const src = new Set<string>([key(original)]);
  for (const j of plan.jobs) src.add(key(j.src));
  const hit = plan.jobs.find((j) => src.has(key(j.dst)));
  if (hit) return `The package would overwrite its own source footage (${hit.dst}). Nothing was written. Choose another folder.`;
  return null;
}

/** The package files that exist already (the project, the manifest and the footage). */
export function existingTargets(plan: Plan): string[] {
  return [plan.aep, join(plan.root, MANIFEST_JSON), join(plan.root, MANIFEST_TXT), ...plan.jobs.map((j) => j.dst)].filter((p) => existsSync(p));
}

/** Frame-exact sample times over each comp's work area (as ae_prove_identical picks them). */
export function sampleTimes(c: { fps: number; dur: number; was: number; wad: number }, n: number): number[] {
  const fd = 1 / c.fps, t0 = c.was, last = Math.max(t0, t0 + c.wad - fd), out: number[] = [], have = new Set<number>();
  for (let q = 0; q < n; q++) {
    const raw = n === 1 ? t0 : t0 + ((last - t0) * q) / (n - 1);
    const fr = Math.max(0, Math.min(Math.round(c.dur * c.fps) - 1, Math.round(raw * c.fps)));
    if (!have.has(fr)) have.add(fr), out.push(fr / c.fps);
  }
  return out;
}

// ---------- aerender ----------

export interface AerenderRun { code: number | null; lines: string[]; errors: string[]; timedOut?: boolean; failed?: string }

/** aerender on one project (it renders the project's queued items), in its own process; lines of its output kept. */
export function runAerender(bin: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<AerenderRun> {
  return new Promise((done) => {
    const lines: string[] = [];
    let buf = "", timedOut = false, failed: string | undefined, finished = false;
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const onData = (d: Buffer) => {
      buf += d.toString();
      const parts = buf.split(/\r?\n/);
      buf = parts.pop() ?? "";
      for (const l of parts) if (l.trim()) lines.push(l.trim()), lines.length > 4000 && lines.shift();
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    const timer = setTimeout(() => ((timedOut = true), proc.kill()), timeoutMs);
    const abort = () => ((failed = "cancelled"), proc.kill());
    signal?.addEventListener("abort", abort, { once: true });
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (buf.trim()) lines.push(buf.trim());
      const errors = lines.filter((l) => /aerender ERROR|^ERROR\b|After Effects error/i.test(l));
      done({ code, lines, errors, timedOut: timedOut || undefined, failed });
    };
    proc.on("error", (e) => ((failed = String(e.message || e)), finish(null)));
    proc.on("close", (code) => finish(code));
  });
}

const aerenderFailure = (r: AerenderRun) =>
  r.failed === "cancelled" ? "cancelled" : r.failed ? `could not start (${r.failed})` : r.timedOut ? "timed out" : r.code !== 0 ? `exit code ${r.code}${r.errors.length ? `: ${r.errors.slice(0, 3).join(" | ")}` : ""}` : r.errors.length ? r.errors.slice(0, 3).join(" | ") : null;

/** aerender lines that say something about missing items, fonts, plug-ins or expressions (not progress). */
const aerenderNotes = (r: AerenderRun) => r.lines.filter((l) => !/^PROGRESS/i.test(l) && /missing|expression|font|plug-?in|effect|substitut/i.test(l)).slice(0, 8);

// ---------- the verdict ----------

export interface FrameCompare { comp: string; compId: number; time: number; fps: number; result: "identical" | "within tolerance" | "differs" | "not compared"; maxDiff?: number; detail?: string }
export interface Verification {
  verdict: "IDENTICAL" | "DIFFERS" | "NOT VERIFIED";
  line: string;
  method?: string;
  frames: FrameCompare[];
  /** problems the proof found in the package itself (beyond the frames) */
  problems: string[];
  notes: string[];
  image?: { data: string; label: string };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const frameLabel = (t: number, fps: number) => `${r2(t)}s (f${Math.round(t * fps)})`;
const pngIn = (dir: string) => {
  try {
    const f = readdirSync(dir).filter((n) => /\.png$/i.test(n)).sort()[0];
    return f ? join(dir, f) : null;
  } catch {
    return null;
  }
};

/** Compare the frames aerender wrote from the user's project (refDirs) and from the package (colDirs). */
export function compareFrames(list: { comp: string; compId: number; time: number; fps: number; ref: string; col: string }[], tolerance: number): Pick<Verification, "frames" | "image"> & { differs: number; compared: number; top: number; unread: string[] } {
  const frames: FrameCompare[] = [], unread: string[] = [];
  let differs = 0, compared = 0, top = 0, worst: { score: [number, number]; a: Image; b: Image; label: string } | null = null;
  for (const f of list) {
    const label = `"${f.comp}" at ${frameLabel(f.time, f.fps)}`;
    const ra = pngIn(f.ref), rb = pngIn(f.col);
    if (!ra || !rb) {
      frames.push({ comp: f.comp, compId: f.compId, time: f.time, fps: f.fps, result: "not compared", detail: `no frame from ${!ra ? "your project" : "the package"}` });
      unread.push(label);
      continue;
    }
    let a: Image, b: Image;
    try {
      a = decodePng(readFileSync(ra));
      b = decodePng(readFileSync(rb));
    } catch (e: any) {
      frames.push({ comp: f.comp, compId: f.compId, time: f.time, fps: f.fps, result: "not compared", detail: String(e?.message ?? e) });
      unread.push(label);
      continue;
    }
    compared++;
    if (a.width !== b.width || a.height !== b.height) {
      differs++;
      frames.push({ comp: f.comp, compId: f.compId, time: f.time, fps: f.fps, result: "differs", detail: `${b.width}x${b.height} from the package, ${a.width}x${a.height} from your project` });
      continue;
    }
    const d = diffImages(a, b, tolerance);
    top = Math.max(top, d.maxDiff);
    if (d.over) {
      differs++;
      const [x, y, w, h] = d.box!;
      frames.push({ comp: f.comp, compId: f.compId, time: f.time, fps: f.fps, result: "differs", maxDiff: r2(d.maxDiff), detail: `${d.over.toLocaleString("en-US")} px beyond the tolerance, max channel difference ${r2(d.maxDiff)}/255, max ΔE ${r2(d.maxDeltaE)}, inside x ${x}-${x + w - 1}, y ${y}-${y + h - 1}` });
    } else frames.push({ comp: f.comp, compId: f.compId, time: f.time, fps: f.fps, result: d.changed ? "within tolerance" : "identical", maxDiff: r2(d.maxDiff) });
    const score: [number, number] = [d.over, d.maxDiff];
    if (d.changed && (!worst || score[0] > worst.score[0] || (score[0] === worst.score[0] && score[1] > worst.score[1]))) worst = { score, a, b, label };
  }
  let image: Verification["image"];
  if (worst) {
    const pic = diffPicture(worst.a, worst.b, tolerance);
    image = { data: pic.png.toString("base64"), label: `Difference image of ${worst.label} (${pic.width}x${pic.height}), your project against the package: black = identical, dark blue = within the tolerance, gray to white = beyond it.` };
  }
  return { frames, image, differs, compared, top, unread };
}

// ---------- the manifest ----------

export const ADOBE_FX = /^(ADBE |CC |APC |AE\.ADBE|ADBE_|CS )/;
const fmtBytes = (n: number) => (n < 1000 ? `${n} B` : n < 1e6 ? `${r2(n / 1e3)} KB` : n < 1e9 ? `${r2(n / 1e6)} MB` : `${r2(n / 1e9)} GB`);
const list = (a: string[], max = 6) => (a.length <= max ? a.join(", ") : `${a.slice(0, max).join(", ")} and ${a.length - max} more`);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export interface Manifest {
  surehandHandoff: 1;
  createdAt: string;
  createdBy: string;
  summary: string;
  source: { project: string; bytes: number; sha256: string; modified: string };
  package: { folder: string; project: string; footageFolder: string; files: number; totalBytes: number; collect: "used" | "all"; reduced: boolean };
  afterEffects: { version: string | null; build?: string; os?: string };
  project: { bitsPerChannel: unknown; expressionEngine: string | null; color: Record<string, unknown>; items: number; comps: number; layersRead: number; partial?: string };
  fonts: { postScriptName: string; family?: string; style?: string; version?: string; adobeFonts?: boolean; location?: string; here: "installed" | "missing" | "substituted" | "unknown"; uses: number; usedBy: string[] }[];
  fontsSource: string;
  effects: { matchName: string; displayName: string; category?: string; version: string | null; vendor: "Adobe" | "third party"; installedHere: boolean; instances: number; usedBy: string[] }[];
  footage: {
    id: number; name: string; kind: "file" | "sequence" | "solid" | "placeholder"; projectFolder: string; source: string | null; packaged: string | null; status: string;
    files?: number; bytes?: number; width?: number; height?: number; pixelAspect?: number; frameRate?: number; nativeFrameRate?: number; conformFrameRate?: number;
    duration?: number; still?: boolean; alpha?: boolean; alphaMode?: string; audio?: boolean; color?: Record<string, unknown>; usedIn: number; proxy?: { source: string; packaged: string | null; inUse: boolean };
  }[];
  missing: { footage: string[]; placeholders: string[]; fonts: string[]; effects: string[] };
  opensClean: boolean;
  problems: string[];
  needs: string[];
  verification: { verdict: Verification["verdict"]; line: string; method?: string; frames: FrameCompare[]; notes: string[]; notVerified: string[] };
  yourProject: string;
}

/** What the recipient needs on their machine: fonts, third-party plug-ins, an OCIO config file. */
export function recipientNeeds(scan: HScan, fonts: Manifest["fonts"], effects: Manifest["effects"]): string[] {
  const out: string[] = [];
  if (fonts.length) out.push(`${plural(fonts.length, "font")} (${list(fonts.map((f) => `${f.postScriptName}${f.adobeFonts ? " [Adobe Fonts]" : ""}`))})`);
  for (const e of effects.filter((x) => x.vendor === "third party")) out.push(`plug-in "${e.displayName}" (${e.matchName}, ${e.version ? `version ${e.version}` : "version not exposed by After Effects"})`);
  const ocio = scan.color.ocioConfigurationFile;
  if (Number(scan.color.colorManagementSystem) === 1 && typeof ocio === "string" && ocio) out.push(`the OCIO config ${ocio}`);
  return out;
}

export function manifestFonts(scan: HScan): { fonts: Manifest["fonts"]; source: string } {
  const missing = new Map((scan.fonts?.missing ?? []).map((m) => [m.ps, m.sub ? "substituted" : "missing"] as const));
  if (scan.fonts?.used)
    return {
      source: "project.usedFonts (every font in the project, style runs and Source Text keyframes included)",
      fonts: scan.fonts.used.map((u) => ({
        postScriptName: u.ps, family: u.family, style: u.style, version: u.v, adobeFonts: u.adobe, location: u.loc,
        here: (u.here ?? missing.get(u.ps) ?? "installed") as Manifest["fonts"][number]["here"], uses: u.n, usedBy: u.at,
      })),
    };
  const by = new Map<string, Manifest["fonts"][number]>();
  for (const t of scan.textFonts ?? []) {
    const f = by.get(t.ps) ?? { postScriptName: t.ps, family: t.family, style: t.style, here: missing.get(t.ps) ?? (scan.fonts ? "installed" : "unknown"), uses: 0, usedBy: [] };
    f.uses++;
    if (f.usedBy.length < 12) f.usedBy.push(t.at);
    by.set(t.ps, f);
  }
  return { source: "text layers at their comp's current time (this After Effects has no project.usedFonts: fonts in style runs or Source Text keyframes can be missed)", fonts: [...by.values()] };
}

export function manifestEffects(scan: HScan): Manifest["effects"] {
  return scan.effects
    .filter((e) => !e.m.startsWith("Pseudo/"))
    .map((e) => ({
      matchName: e.m, displayName: e.dn ?? e.n, category: e.cat, version: e.v ?? null, vendor: ADOBE_FX.test(e.m) ? "Adobe" : "third party",
      installedHere: !e.x, instances: e.k, usedBy: e.at,
    }));
}

// ---------- the tool ----------

export interface HandoffInput {
  folder: string;
  collect?: "used" | "all";
  reduce?: boolean;
  overwrite?: boolean;
  verify?: boolean;
  verifyComps?: (number | string)[];
  frames?: number;
  tolerance?: number;
}

async function sha256(p: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(p)) h.update(chunk as Buffer);
  return h.digest("hex");
}
const fileState = async (p: string) => {
  const st = statSync(p);
  return { bytes: st.size, mtimeMs: st.mtimeMs, sha256: await sha256(p) };
};

const AERENDER_TIMEOUT_MS = 30 * 60_000;
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\.\d+Z$/, "");

export async function handoff(input: HandoffInput, perm: { mode: string }, signal?: AbortSignal): Promise<CallToolResult> {
  if (perm.mode === "read-only") return errorResult(READ_ONLY_REFUSAL);
  const root = resolve(expandHome(input.folder));
  if (!isAbsolute(expandHome(input.folder))) return errorResult(`folder must be an absolute path (got "${input.folder}").`);
  const collect = input.collect ?? "used", frames = input.frames ?? 5, tol = input.tolerance ?? DEFAULT_TOLERANCE;

  // 1. read the project (in "ask" mode the user approves the whole handoff here, before anything is written)
  const approval = perm.mode === "ask"
    ? { approval: { tool: "Handoff package", summary: `Collect the project and its footage into ${root}${input.verify ? ", render sample frames with aerender to prove it" : ""}. Your project is saved as a copy there and then opened again from disk (its undo history starts fresh).` } }
    : undefined;
  const s = await runJsx(HANDOFF_SCAN_JSX, {}, { undoGroup: false, timeoutMs: 300_000, bridge: approval });
  if (!s.ok) return errorResult(s.error?.message ?? "After Effects could not read the project.");
  const scan: HScan = typeof s.result === "string" ? JSON.parse(s.result) : (s.result as HScan);
  if (!scan.file) return errorResult("The project has never been saved. Save it first (ae_save_project with a path): the package is made from the project file.");
  if (scan.dirty)
    return errorResult(
      "The project has unsaved changes. Nothing was written. The package is made from the project file, and After Effects opens your project again from disk afterwards, " +
        "which would lose them. Save first (ae_save_project), then make the package.",
    );
  if (!existsSync(scan.file)) return errorResult(`The project file ${scan.file} can't be read from here.`);

  // 2. plan, refuse what isn't safe before writing anything
  const plan = planPackage(scan, root, collect);
  const unsafe = unsafeTarget(plan, scan.file);
  if (unsafe) return errorResult(unsafe);
  const existing = existingTargets(plan);
  if (existing.length && !input.overwrite)
    return errorResult(
      `${root} already has ${plural(existing.length, "file")} the package would write (${list(existing.map((p) => relative(root, p)), 4)}). Nothing was written. ` +
        "Pass overwrite: true to replace them, or choose another folder.",
    );

  // which comps and frames the proof renders, and why it can't run
  let verifyComps: HScan["comps"] = [], notVerifiedWhy: string | null = null, bin: string | null = null;
  const verifyNotes: string[] = [];
  if (input.verify) {
    const pick = (ref: number | string) => (ref === "active" ? scan.comps.find((c) => c.id === scan.active) : typeof ref === "number" ? scan.comps.find((c) => c.id === ref) : scan.comps.filter((c) => c.name === ref));
    if (input.verifyComps?.length) {
      for (const ref of input.verifyComps) {
        const c = pick(ref);
        if (Array.isArray(c) && c.length > 1) return errorResult(`Several comps are named "${ref}": pass its id instead. Nothing was written.`);
        const one = Array.isArray(c) ? c[0] : c;
        if (!one) return errorResult(`No comp ${typeof ref === "number" ? `with id ${ref}` : `"${ref}"`} in the project. Nothing was written.`);
        if (!verifyComps.includes(one)) verifyComps.push(one);
      }
    } else {
      // the render queue's comps in any status (queued, unqueued, "needs output": what is meant to be delivered), queued
      // ones first; the active comp only when the queue is empty
      const ids = [...new Set([...scan.rq.filter((r) => r.queued), ...scan.rq.filter((r) => !r.queued)].map((r) => r.comp))];
      const inQueue = ids.map((id) => scan.comps.find((c) => c.id === id)!).filter(Boolean);
      verifyComps = inQueue.length ? inQueue.slice(0, 4) : scan.comps.filter((c) => c.id === scan.active);
      if (inQueue.length > 4) verifyNotes.push(`The render queue has ${inQueue.length} comps; the first 4 were rendered (pass verifyComps to choose).`);
      if (!verifyComps.length) return errorResult("verify: the render queue is empty and no comp is active. Pass verifyComps (ids or names). Nothing was written.");
    }
    bin = scan.app ? aerenderPath(scan.app) : null;
    if (!bin) notVerifiedWhy = `aerender was not found next to ${scan.app ?? "the After Effects application"}`;
  }

  // 3. copy the footage (nothing of the user's is touched; files this call created are removed again if it fails)
  const before = await fileState(scan.file);
  const created: string[] = [];
  const cleanUp = async () => {
    for (const p of created.reverse()) await unlink(p).catch(() => {});
  };
  try {
    mkdirSync(root, { recursive: true });
    for (const j of plan.jobs) {
      mkdirSync(dirname(j.dst), { recursive: true });
      const had = existsSync(j.dst);
      await copyFile(j.src, j.dst, input.overwrite ? 0 : constants.COPYFILE_EXCL);
      if (!had) created.push(j.dst);
    }
  } catch (e: any) {
    await cleanUp();
    return errorResult(`Copying the footage failed: ${e?.message ?? e}. The files this call had copied were removed again; your project was not touched.`);
  }

  // 4. the copies, in After Effects
  const tmp = appFile("tmp", `handoff-${stamp()}-${randomBytes(2).toString("hex")}`);
  const runProof = !!input.verify && !notVerifiedWhy;
  const proofSpec = (side: "reference" | "package") => ({
    path: join(tmp, `${side}.aep`),
    comps: verifyComps.map((c) => {
      const times = sampleTimes(c, frames);
      return { id: c.id, times, dirs: times.map((_, j) => join(tmp, side, `${c.id}_${j}`)) };
    }),
  });
  const ref = runProof ? proofSpec("reference") : undefined, col = runProof ? proofSpec("package") : undefined;
  for (const sp of [ref, col]) for (const c of sp?.comps ?? []) for (const d of c.dirs) mkdirSync(d, { recursive: true });
  const hadAep = existsSync(plan.aep);
  let w: any;
  try {
    const r = await runJsx(
      HANDOFF_WRITE_JSX,
      { original: scan.file, dest: plan.aep, reduce: !!input.reduce, ref, col, relink: plan.items.map((i) => ({ id: i.id, path: i.relink, seq: i.seq, ...(i.proxy ? { proxy: { path: i.proxy.relink, seq: i.proxy.seq } } : {}) })) },
      { undoGroup: false, timeoutMs: 3_600_000 },
    );
    if (!r.ok) throw new Error(r.error?.message ?? "After Effects could not write the package.");
    w = typeof r.result === "string" ? JSON.parse(r.result) : r.result;
  } catch (e: any) {
    rmSync(tmp, { recursive: true, force: true });
    if (!hadAep && !existsSync(plan.aep)) await cleanUp();
    return errorResult(
      `Writing the package failed: ${e?.message ?? e}. ${existsSync(plan.aep) ? `The package in ${root} is incomplete: don't send it. ` : ""}Check which project After Effects has open: it should be ${scan.file} (ae_get_project_info); ` +
        "if it isn't, open it again (it was not changed on disk).",
    );
  }
  const after = await fileState(scan.file).catch(() => null);
  const untouched = !!after && after.sha256 === before.sha256 && after.bytes === before.bytes && after.mtimeMs === before.mtimeMs;
  const reopened = !!w.open && samePath(w.open, scan.file);
  const yourProject = !reopened
    ? `WARNING: After Effects did not open your project again${w.reopenError ? ` (${w.reopenError})` : ""}: it has ${w.open ?? "no saved project"} open. Your project is ${untouched ? "unchanged on disk" : "NOT confirmed unchanged on disk"} at ${scan.file}: open it with ae_open_project.`
    : `${untouched ? "Your project: unchanged on disk (same size, date and SHA-256)" : "WARNING: your project's file changed on disk during the handoff (size, date or SHA-256 differ)"}, open again in After Effects ${w.dirty ? "and marked as having unsaved changes (it had none before)" : "with no unsaved changes"}; its undo history starts fresh.`;
  if (w.error && !w.steps.includes("package saved")) {
    rmSync(tmp, { recursive: true, force: true });
    if (!hadAep && !w.steps.includes("package copy")) await cleanUp();
    return errorResult(`The package was not completed: ${w.error}.\n${yourProject}${w.steps.includes("package copy") ? `\nThe copy at ${plan.aep} is incomplete: don't send it.` : ""}`);
  }

  // 5. what the package's copy refers to, what's missing, what the recipient needs
  const problems: string[] = [], notes: string[] = [...verifyNotes];
  const copyFootage: { id: number; name: string; placeholder: boolean; missing: boolean; used: number; file?: string; proxy?: string }[] = w.copy?.footage ?? [];
  const missingFootage = copyFootage.filter((f) => !f.placeholder && (f.missing || !f.file || !existsSync(f.file)));
  const outside = copyFootage.filter((f) => !f.placeholder && !missingFootage.includes(f) && f.file && !isInside(root, f.file));
  const placeholders = copyFootage.filter((f) => f.placeholder);
  if (missingFootage.length) problems.push(`${plural(missingFootage.length, "footage item")} missing (${list(missingFootage.map((f) => `"${f.name}"`))})`);
  const outsideUsed = outside.filter((f) => f.used), outsideUnused = outside.filter((f) => !f.used);
  if (outsideUsed.length) problems.push(`${plural(outsideUsed.length, "footage item")} still pointing outside the package (${list(outsideUsed.map((f) => `"${f.name}"`))})`);
  if (outsideUnused.length) problems.push(`${plural(outsideUnused.length, "unused footage item")} not collected, which will show as missing (${list(outsideUnused.map((f) => `"${f.name}"`))}): pass reduce: true to leave them out, or collect: "all"`);
  if (placeholders.some((f) => f.used)) problems.push(`${plural(placeholders.filter((f) => f.used).length, "placeholder")} instead of footage (${list(placeholders.filter((f) => f.used).map((f) => `"${f.name}"`))})`);
  for (const [, name, why] of w.relinkFailed ?? []) problems.push(`"${name}" could not be relinked to its copy (${why})`);
  if (w.reduceError) notes.push(`Reduce Project failed in the copy (${w.reduceError}); unused items were kept.`);
  const { fonts, source: fontsSource } = manifestFonts(scan);
  const effects = manifestEffects(scan);
  const fontsMissing = fonts.filter((f) => f.here === "missing" || f.here === "substituted");
  if (fonts.some((f) => f.here === "unknown")) notes.push("This After Effects can't list missing fonts (needs 24.0+): fonts were not checked.");
  if (fontsMissing.length) problems.push(`${plural(fontsMissing.length, "font")} missing or substituted here (${list(fontsMissing.map((f) => f.postScriptName))})`);
  const fxMissing = effects.filter((e) => !e.installedHere);
  if (fxMissing.length) problems.push(`${plural(fxMissing.length, "plug-in")} not installed here (${list(fxMissing.map((e) => e.matchName))})`);
  if (scan.partial) notes.push(`Effects and fonts were read from part of the project only (${scan.partial}).`);
  // expression errors: every expression evaluated in the package's copy; with verify also in a copy of your project, so
  // new ones (the package's doing) are told apart from ones your project has already
  const k = (e: string[]) => e.slice(0, 3).join(" > ");
  const colErr: string[][] = w.colExpr?.errors ?? [];
  if (w.refExpr) {
    const refErr = new Set<string>((w.refExpr.errors ?? []).map(k));
    const fresh = colErr.filter((e) => !refErr.has(k(e))), old = colErr.filter((e) => refErr.has(k(e)));
    if (fresh.length) problems.push(`${plural(fresh.length, "expression error")} that your project doesn't have (${list(fresh.map((e) => `${k(e)}: ${e[3]}`), 3)})`);
    if (old.length) problems.push(`${plural(old.length, "expression error")} (already in your project: ${list(old.map((e) => `${k(e)}: ${e[3]}`), 3)})`);
  } else if (colErr.length) problems.push(`${plural(colErr.length, "expression error")} (${list(colErr.map((e) => `${k(e)}: ${e[3]}`), 3)})`);
  if (w.colExpr?.stopped) notes.push(`Expressions: ${w.colExpr.stopped}.`);
  if (w.error) notes.push(`After Effects reported, after the package was saved: ${w.error}.`);
  const needs = recipientNeeds(scan, fonts, effects);

  // 6. the proof: aerender renders the reference copy (your project) and the package's copy, each in its own process
  const notVerified = [
    "fonts and plug-ins on another machine: only this machine was checked; the recipient needs the ones listed",
    "the package moved to another folder or machine: the copy's paths point into the package; After Effects finds them relative to the project when the folder moves, as with Collect Files",
  ];
  let v: Verification;
  if (!input.verify) {
    v = { verdict: "NOT VERIFIED", line: "NOT VERIFIED: not requested (verify: true renders sample frames from the package and from your project with aerender and compares them).", frames: [], problems: [], notes: [] };
    notVerified.unshift("rendering: verify was off");
  } else if (!runProof) {
    v = { verdict: "NOT VERIFIED", line: `NOT VERIFIED: ${notVerifiedWhy}.`, frames: [], problems: [], notes: [] };
    notVerified.unshift(`rendering: ${notVerifiedWhy}`);
  } else v = await verifyPackage(w, ref!, col!, bin!, verifyComps, tol, missingFootage.length > 0 || scan.footage.some((f) => f.missing && f.used), signal);
  problems.push(...v.problems);
  notVerified.push(`expressions at other times than each comp's work area start${runProof ? ", frames between the samples, and audio" : ""}`);
  rmSync(tmp, { recursive: true, force: true });

  // 7. the manifest
  const opensClean = !problems.length;
  const summary = opensClean
    ? `Opens clean${needs.length ? `. Needs: ${needs.join(", ")}` : ""}`
    : `Does not open clean: ${problems.join("; ")}${needs.length ? `. Also needs: ${needs.join(", ")}` : ""}`;
  const itemsById = new Map(plan.items.map((i) => [i.id, i]));
  const skippedById = new Map(plan.skipped.map(([f, why]) => [f.id, why]));
  const footage: Manifest["footage"] = scan.footage.map((f) => {
    const p = itemsById.get(f.id), why = skippedById.get(f.id);
    const reduced = !!input.reduce && !copyFootage.some((c) => c.id === f.id) && f.kind !== "solid";
    const status = f.kind !== "file" ? f.kind : p ? "collected" : reduced ? "removed (unused, reduce)" : why === "unused" ? "not collected (unused)" : why ?? "not collected";
    return {
      id: f.id, name: f.name, kind: f.kind === "file" ? (f.seq ? "sequence" : "file") : f.kind, projectFolder: f.folder.join("/"), source: f.file ?? f.missingPath ?? null,
      packaged: p ? p.rel.split("\\").join("/") : null, status, ...(p ? { files: p.frames, bytes: p.bytes } : {}),
      width: f.w, height: f.h, pixelAspect: f.par, frameRate: f.fps, nativeFrameRate: f.nativeFps, conformFrameRate: f.conformFps, duration: f.dur, still: f.still,
      alpha: f.alpha, alphaMode: f.alphaMode, audio: f.audio, color: f.color, usedIn: f.used,
      ...(f.proxy ? { proxy: { source: f.proxy.file, packaged: p?.proxy ? p.proxy.rel.split("\\").join("/") : null, inUse: f.proxy.inUse } } : {}),
    };
  });
  const footageBytes = plan.jobs.reduce((n, j) => n + j.bytes, 0);
  const aepBytes = (() => {
    try {
      return statSync(plan.aep).size;
    } catch {
      return 0;
    }
  })();
  const m: Manifest = {
    surehandHandoff: 1,
    createdAt: new Date().toISOString(),
    createdBy: `Surehand MCP ${VERSION}`,
    summary,
    source: { project: scan.file, bytes: before.bytes, sha256: before.sha256, modified: new Date(before.mtimeMs).toISOString() },
    package: { folder: root, project: basename(plan.aep), footageFolder: FOOTAGE_DIR, files: plan.jobs.length + 3, totalBytes: 0, collect, reduced: !!input.reduce },
    afterEffects: { version: scan.ae ?? null, build: scan.build, os: scan.os },
    project: { bitsPerChannel: scan.color.bitsPerChannel ?? null, expressionEngine: scan.engine ?? null, color: scan.color, items: scan.items, comps: scan.comps.length, layersRead: scan.layers, partial: scan.partial },
    fonts,
    fontsSource,
    effects,
    footage,
    missing: {
      footage: missingFootage.map((f) => f.name),
      placeholders: placeholders.map((f) => f.name),
      fonts: fontsMissing.map((f) => f.postScriptName),
      effects: fxMissing.map((e) => e.matchName),
    },
    opensClean,
    problems,
    needs,
    verification: { verdict: v.verdict, line: v.line, method: v.method, frames: v.frames, notes: [...v.notes, ...notes], notVerified },
    yourProject,
  };
  const text = (total: number) => formatHandoff(m, plan, { total, footageBytes });
  // the size counts the manifest files themselves: rewritten until the total they state is their own (once or twice more)
  m.package.totalBytes = footageBytes + aepBytes;
  for (let i = 0; i < 4; i++) {
    writeFileSync(join(root, MANIFEST_JSON), JSON.stringify(m, null, 1));
    writeFileSync(join(root, MANIFEST_TXT), text(m.package.totalBytes));
    const total = footageBytes + aepBytes + statSync(join(root, MANIFEST_JSON)).size + statSync(join(root, MANIFEST_TXT)).size;
    if (total === m.package.totalBytes) break;
    m.package.totalBytes = total;
  }

  const content: CallToolResult["content"] = [{ type: "text", text: text(m.package.totalBytes) }];
  if (v.image) content.push({ type: "image", data: v.image.data, mimeType: "image/png" }, { type: "text", text: v.image.label });
  return { content };
}

/** Render the proof frames from both copies with aerender and compare them; also compares the expression errors. */
async function verifyPackage(w: any, ref: { comps: { id: number; times: number[]; dirs: string[] }[]; path: string }, col: typeof ref, bin: string, comps: HScan["comps"], tol: number, missing: boolean, signal?: AbortSignal): Promise<Verification> {
  const problems: string[] = [], notes: string[] = [];
  const method = "aerender (After Effects' command-line renderer, a separate process) rendered the sample frames from a copy of your project and from the package's copy; the PNGs were compared pixel by pixel";
  const nv = (why: string): Verification => ({ verdict: "NOT VERIFIED", line: `NOT VERIFIED: ${why}.`, method, frames: [], problems, notes });
  if (w.refQueue?.noPng || w.colQueue?.noPng) return nv("After Effects could not set a PNG output module for the sample frames (scripting)");
  if (!w.steps?.includes("verification copy") || !w.steps?.includes("reference copy")) return nv(`the copies for aerender were not made${w.error ? ` (${w.error})` : ""}`);
  // with footage missing in your project too, aerender would stop: both render it as color bars instead
  const args = (p: string) => ["-project", p, "-v", "ERRORS_AND_PROGRESS", ...(missing ? ["-continueOnMissingFootage"] : [])];
  if (missing) notes.push("Missing footage renders as color bars in both renders (-continueOnMissingFootage).");
  const a = await runAerender(bin, args(ref.path), AERENDER_TIMEOUT_MS, signal);
  const af = aerenderFailure(a);
  if (af) return nv(`aerender could not render your project's frames (${af})`);
  const b = await runAerender(bin, args(col.path), AERENDER_TIMEOUT_MS, signal);
  const bf = aerenderFailure(b);
  if (bf) {
    problems.push(`aerender could not render the package (${bf})`);
    return nv(`the package did not render in aerender (${bf}); your project's frames did`);
  }
  for (const l of aerenderNotes(b)) notes.push(`aerender (package): ${l}`);
  const byId = new Map(comps.map((c) => [c.id, c]));
  const listed = ref.comps.flatMap((c, ci) => c.times.map((t, j) => ({ comp: byId.get(c.id)!.name, compId: c.id, time: t, fps: byId.get(c.id)!.fps, ref: c.dirs[j], col: col.comps[ci].dirs[j] })));
  const cmp = compareFrames(listed, tol);
  const tolText = !tol ? "tolerance 0: bit-identical" : `tolerance ${tol}/255 per channel`;
  let line: string, verdict: Verification["verdict"];
  if (cmp.differs) {
    verdict = "DIFFERS";
    const which = cmp.frames.filter((f) => f.result === "differs").map((f) => `"${f.comp}" at ${frameLabel(f.time, f.fps)}`);
    line = `DIFFERS in ${cmp.differs} of ${cmp.compared} frames (${tolText}): ${list(which)}.`;
    problems.push(`the package renders differently from your project (${list(which, 3)})`);
  } else if (cmp.unread.length || !cmp.compared) {
    verdict = "NOT VERIFIED";
    line = `NOT VERIFIED: ${cmp.unread.length ? `no frame to compare for ${list(cmp.unread, 3)}` : "no frames to compare"}.${cmp.compared ? ` The ${cmp.compared} frames that could be compared match (${tolText}).` : ""}`;
  } else {
    verdict = "IDENTICAL";
    const n = comps.length;
    line = cmp.top === 0
      ? `IDENTICAL: all ${cmp.compared} sample frames (${plural(n, "comp")}) are bit-identical from the package and from your project.`
      : `IDENTICAL: all ${cmp.compared} sample frames (${plural(n, "comp")}) match within ${tol}/255 per channel (largest difference ${r2(cmp.top)}/255).`;
  }
  return { verdict, line, method, frames: cmp.frames, problems, notes, image: cmp.image };
}

/** The readable report: the tool's answer and HANDOFF.txt. */
export function formatHandoff(m: Manifest, plan: Plan, size: { total: number; footageBytes: number }): string {
  const seqs = plan.items.filter((i) => i.seq);
  const out: string[] = [
    m.summary + ".",
    `Verification: ${m.verification.line}`,
    m.yourProject,
    "",
    `Package: ${m.package.folder}`,
    `  ${m.package.project} + ${plural(plan.items.length, "footage item")} in ${FOOTAGE_DIR}${seqs.length ? ` (${plural(seqs.length, "sequence")}, ${seqs.reduce((n, i) => n + i.frames, 0)} frames)` : ""}, ${MANIFEST_JSON}, ${MANIFEST_TXT}: ${fmtBytes(size.total)} in total (footage ${fmtBytes(size.footageBytes)}).`,
    `  Options: collect ${m.package.collect === "used" ? "used footage only" : "all footage"}${m.package.reduced ? ", reduced (unused items removed from the copy)" : ""}.`,
    `After Effects ${m.afterEffects.version ?? "(version unknown)"}${m.afterEffects.os ? ` on ${m.afterEffects.os}` : ""}. Project: ${m.project.bitsPerChannel ?? "?"} bpc, expressions engine ${m.project.expressionEngine ?? "(not exposed)"}.`,
    `Color: ${Object.entries(m.project.color).filter(([k2]) => k2 !== "bitsPerChannel").map(([k2, val]) => `${k2} ${k2 === "colorManagementSystem" ? (Number(val) === 1 ? "OCIO" : "Adobe") : JSON.stringify(val)}`).join(", ") || "(not exposed by this After Effects)"}.`,
  ];
  out.push("", `Fonts (${m.fonts.length}; from ${m.fontsSource.split(" (")[0]}):`);
  for (const f of m.fonts) out.push(`  ${f.postScriptName}${f.family ? ` (${f.family}${f.style ? ` ${f.style}` : ""})` : ""}${f.version ? `, version ${f.version}` : ""}${f.adobeFonts ? ", Adobe Fonts" : ""}${f.here !== "installed" ? `, ${f.here.toUpperCase()} HERE` : ""}: ${f.usedBy.length ? list(f.usedBy, 4) : `${plural(f.uses, "use")}`}`);
  if (!m.fonts.length) out.push("  none");
  out.push("", `Effects (${m.effects.length}, by match name; plug-in versions are what After Effects reports, where it does):`);
  for (const e of m.effects) out.push(`  ${e.displayName} [${e.matchName}], ${e.vendor}, ${e.version ? `version ${e.version}` : "version not exposed"}${e.installedHere ? "" : ", NOT INSTALLED HERE"}: ${plural(e.instances, "instance")} (${list(e.usedBy, 3)})`);
  if (!m.effects.length) out.push("  none");
  out.push("", `Footage (${m.footage.length}):`);
  for (const f of m.footage) {
    const spec = f.kind === "solid" ? "" : [f.width && f.height ? `${f.width}x${f.height}` : "", f.still ? "still" : f.frameRate ? `${f.frameRate} fps` : "", f.duration && !f.still ? `${f.duration}s` : "", f.alpha ? `alpha ${f.alphaMode ?? ""}`.trim() : "", f.audio ? "audio" : ""].filter(Boolean).join(", ");
    out.push(`  "${f.name}" (${f.kind}${spec ? `, ${spec}` : ""}): ${f.status}${f.packaged ? ` -> ${f.packaged}` : ""}`);
  }
  if (m.problems.length) out.push("", "Problems:", ...m.problems.map((p) => `  - ${p}`));
  if (m.needs.length) out.push("", "The recipient needs:", ...m.needs.map((n) => `  - ${n}`));
  if (m.verification.frames.length) {
    out.push("", "Sample frames:");
    for (const f of m.verification.frames) out.push(`  "${f.comp}" at ${frameLabel(f.time, f.fps)}: ${f.result}${f.detail ? ` (${f.detail})` : ""}`);
  }
  if (m.verification.method) out.push("", `Method: ${m.verification.method}.`);
  out.push("", "Not verified:", ...m.verification.notVerified.map((n) => `  - ${n}`));
  if (m.verification.notes.length) out.push("", "Notes:", ...m.verification.notes.map((n) => `  - ${n}`));
  return out.join("\n") + "\n";
}

export function registerHandoffTools(server: McpServer) {
  server.registerTool(
    "ae_handoff_package",
    {
      title: "Handoff package",
      description:
        "Package the saved project for a client, another studio or a render farm, and prove it opens: copies the project and its used footage into a folder " +
        "(the layout of Collect Files, relinked, in a copy), writes handoff.json + HANDOFF.txt (fonts and the layers using them, effects/plug-ins by match name " +
        "with versions where AE reports them, AE version, bit depth, color settings, expressions engine, footage specs, missing items, size) and says " +
        "\"Opens clean\" or what it needs. verify: aerender renders sample frames from the package and from the project and compares them (IDENTICAL / DIFFERS / " +
        "NOT VERIFIED with the reason). The open project is never edited: it must be saved; After Effects opens it again from disk afterwards (undo history starts fresh).",
      inputSchema: {
        folder: z.string().describe("Absolute path of the package folder (created if needed; ~ allowed). Never the project's own file or footage."),
        collect: z.enum(["used", "all"]).optional().describe('Footage to copy: "used" by a comp (default) or every footage item.'),
        reduce: z.boolean().optional().describe("Remove unused items from the package's copy (Reduce Project, keeping every comp). Default false."),
        overwrite: z.boolean().optional().describe("Replace package files that exist already (default false: refuse and list them)."),
        verify: z.boolean().optional().describe("Prove it: render sample frames from the package and from the project with aerender and compare (takes minutes: aerender starts its own After Effects twice)."),
        verifyComps: z.array(z.union([z.number().int(), z.string()])).min(1).max(4).optional().describe('verify: comps to render (id, exact name or "active"; default the comps in the render queue, in any status, else the active comp).'),
        frames: z.number().int().min(1).max(24).optional().describe("verify: frames per comp, spread over its work area (default 5)."),
        tolerance: z.number().min(0).max(255).optional().describe("verify: allowed difference per channel, 0-255 (default 0.5: less than one 8-bit step)."),
      },
      // writes files (overwrite replaces them) and closes and reopens the project, which clears the undo history
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (input: HandoffInput, extra: any) => {
      try {
        return await handoff(input, permissions(), extra?.signal);
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
