// Files in and out: ae_find_files (in Node, no After Effects needed) and ae_export_frames (PNG stills of comps,
// layers and footage, several per call, at full resolution, leaving no undo step).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import { runJsx } from "../jsx.js";
import { colorNote, RENDER_KIT_JSX, renderCleanupNote, runRender, waitForFiles } from "./core.js";
import { errorResult, formatResult, itemRef, layerRef } from "./registry.js";

// ---------- paths and globs ----------

/** "~" and "~/..." (also "~\\..." on Windows) -> the home folder. Other paths unchanged. */
export function expandHome(p: string, home = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(home, p.slice(2));
  return p;
}

/** Unicode-normalised (NFC) and, unless caseSensitive, lower-cased: macOS can store names decomposed (NFD). */
export const normName = (s: string, caseSensitive = false) => (caseSensitive ? s.normalize("NFC") : s.normalize("NFC").toLowerCase());

/**
 * A glob as a regular expression over a "/"-separated relative path: `**` any number of folders (also none),
 * `*` anything but "/", `?` one character but "/", `[abc]` / `[a-z]` / `[!abc]` a character class, `{a,b}`
 * alternatives (nestable). Everything else is literal. The pattern is NFC-normalised like the names.
 */
export function globToRegExp(glob: string, caseSensitive = false): RegExp {
  const g = normName(glob.replace(/\\/g, "/"), caseSensitive);
  let re = "", depth = 0;
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === "*") {
      if (g[i + 1] === "*") {
        // "**/" = zero or more folders; a trailing "**" = anything
        const slash = g[i + 2] === "/";
        re += slash ? "(?:[^/]*/)*" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else if (ch === "[") {
      const end = g.indexOf("]", i + 2);
      if (end < 0) re += "\\[";
      else {
        let body = g.slice(i + 1, end);
        const neg = body[0] === "!" || body[0] === "^";
        if (neg) body = body.slice(1);
        re += `[${neg ? "^" : ""}${body.replace(/[\\\]]/g, "\\$&")}]`;
        i = end;
      }
    } else if (ch === "{") {
      depth++;
      re += "(?:";
    } else if (ch === "}" && depth > 0) {
      depth--;
      re += ")";
    } else if (ch === "," && depth > 0) re += "|";
    else re += ch.replace(/[.+^$()|\\]/g, "\\$&");
  }
  while (depth-- > 0) re += ")";
  return new RegExp(`^${re}$`, "u");
}

export interface FindOptions {
  pattern?: string;
  nameContains?: string;
  maxDepth?: number;
  maxResults?: number;
  includeHidden?: boolean;
  type?: "files" | "folders" | "both";
  caseSensitive?: boolean;
  followSymlinks?: boolean;
  /** stop after looking at this many entries in total */
  maxEntries?: number;
  /** stop after this many milliseconds */
  timeLimitMs?: number;
}
export interface Found {
  path: string;
  type: "file" | "folder";
  size?: number;
  modified?: string;
}

/**
 * Walks the roots depth-first with a depth limit, never entering a folder twice (by its real path, so symlink loops
 * end), and matches the pattern against the path relative to the root ("/"-separated). A pattern without "/"
 * matches the name at any depth. Unreadable folders are counted, not fatal.
 */
export function findFiles(roots: string[], o: FindOptions = {}) {
  const cs = !!o.caseSensitive;
  const pat = o.pattern ? globToRegExp(o.pattern, cs) : null;
  const byName = !!o.pattern && !o.pattern.replace(/\\/g, "/").includes("/");
  const sub = o.nameContains ? normName(o.nameContains, cs) : null;
  const maxDepth = o.maxDepth ?? 8, max = o.maxResults ?? 200, maxEntries = o.maxEntries ?? 200_000;
  const type = o.type ?? "files", t0 = Date.now(), limit = o.timeLimitMs ?? 15_000;
  const results: Found[] = [], visited = new Set<string>(), missing: string[] = [];
  let entries = 0, unreadable = 0, loops = 0, stopped: string | undefined;

  const consider = (full: string, rel: string, name: string, isDir: boolean) => {
    if ((isDir && type === "files") || (!isDir && type === "folders")) return;
    const n = normName(name, cs);
    if (sub && !n.includes(sub)) return;
    if (pat && !pat.test(byName ? n : normName(rel.split(sep).join("/"), cs))) return;
    const f: Found = { path: full, type: isDir ? "folder" : "file" };
    try {
      const st = statSync(full);
      if (!isDir) f.size = st.size;
      f.modified = st.mtime.toISOString();
    } catch {}
    results.push(f);
    if (results.length >= max) stopped = `maxResults (${max})`;
  };

  const walk = (root: string, dir: string, depth: number) => {
    if (stopped) return;
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      unreadable++;
      return;
    }
    if (visited.has(real)) {
      loops++;
      return;
    }
    visited.add(real);
    let list: Dirent[];
    try {
      list = readdirSync(dir, { withFileTypes: true });
    } catch {
      unreadable++;
      return;
    }
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of list) {
      if (stopped) return;
      if (++entries > maxEntries) {
        stopped = `maxEntries (${maxEntries} entries looked at)`;
        return;
      }
      if (Date.now() - t0 > limit) {
        stopped = `time limit (${Math.round(limit / 1000)} s)`;
        return;
      }
      if (!o.includeHidden && d.name.startsWith(".")) continue;
      const full = join(dir, d.name);
      let isDir = d.isDirectory();
      if (d.isSymbolicLink()) {
        if (o.followSymlinks === false) continue;
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          continue; // a broken link
        }
      }
      consider(full, relative(root, full), d.name, isDir);
      if (isDir && depth < maxDepth) walk(root, full, depth + 1);
    }
  };

  for (const r of roots) {
    const root = expandHome(r);
    if (!existsSync(root)) {
      missing.push(r);
      continue;
    }
    try {
      if (!lstatSync(root).isDirectory() && !statSync(root).isDirectory()) {
        missing.push(`${r} (not a folder)`);
        continue;
      }
    } catch {
      missing.push(r);
      continue;
    }
    walk(root, root, 1);
  }
  return {
    count: results.length,
    results,
    entriesLooked: Math.min(entries, maxEntries),
    ...(stopped ? { stopped: `stopped early at ${stopped}: results may be incomplete` } : {}),
    ...(unreadable ? { unreadableFolders: unreadable } : {}),
    ...(loops ? { skippedRepeatFolders: loops } : {}),
    ...(missing.length ? { missingRoots: missing } : {}),
  };
}

// ---------- PNG export ----------

/** Plans every file first (frame tokens, existing files, duplicates); renders only when the whole plan is valid. */
export const EXPORT_FRAMES_JSX = `${RENDER_KIT_JSX}
function pad(n, w) { var s = String(Math.abs(n)); while (s.length < w) s = "0" + s; return (n < 0 ? "-" : "") + s; }
function fileFor(tpl, frame, many) {
  var m = /\\[(#+)\\]/.exec(tpl);
  if (m) return tpl.split(m[0]).join(pad(frame, m[1].length));
  if (tpl.indexOf("{frame}") >= 0) return tpl.split("{frame}").join(pad(frame, 5));
  if (many) aemcp.fail("outputPath '" + tpl + "' needs a frame token ({frame} or [#####]) to export several frames");
  return tpl;
}
var jobs = [], seen = {}, exists = [], total = 0;
for (var i = 0; i < args.exports.length; i++) {
  var e = args.exports[i], src = null, footage = null;
  if (e.item !== undefined) {
    var it = aemcp.findItem(e.item);
    if (it instanceof CompItem) src = it;
    else if (it instanceof FootageItem) footage = it;
    else aemcp.fail("'" + it.name + "' is neither a comp nor footage");
  } else src = aemcp.findComp(e.comp);
  if (footage && e.layers) aemcp.fail("layers only apply to comps ('" + footage.name + "' is footage)");
  var fr = footage ? (footage.frameRate > 0 ? footage.frameRate : 25) : src.frameRate, fd = 1 / fr, dur = footage ? (footage.duration > 0 ? footage.duration : fd) : src.duration;
  var frames = [];
  if (e.frames) frames = e.frames.slice(0);
  else if (e.frameRange) { var st = e.frameRange.step || 1; for (var f = e.frameRange.start; f <= e.frameRange.end; f += st) frames.push(f); }
  else if (e.times) { for (var tt = 0; tt < e.times.length; tt++) frames.push(e.times[tt] / fd); }
  else frames.push(Math.round((src ? src.time : 0) / fd));
  if (!frames.length) aemcp.fail("Export " + (i + 1) + ": no frames");
  // saveFrameToPng writes after the script ends, with the project as it is then: exports of one comp with other
  // layers shown go in a later pass (a call of their own); args.pass is the one this call writes
  var sig = e.layers ? e.layers.join("|") + "#" : "", pass = 0;
  if (src) for (;; pass++) {
    var clash = false;
    for (var i3 = 0; i3 < jobs.length; i3++) if (jobs[i3].pass === pass && jobs[i3].src && jobs[i3].src.id === src.id && jobs[i3].sig !== sig) { clash = true; break; }
    if (!clash) break;
  }
  var name = footage ? footage.name : src.name, list = [];
  for (var k = 0; k < frames.length; k++) {
    var t = frames[k] * fd, fn = Math.round(frames[k]);
    if (t < -1e-9 || t > dur - fd / 2 + 1e-9) aemcp.fail("Frame " + fn + " is outside '" + name + "' (frames 0-" + (Math.round(dur / fd) - 1) + ")");
    var path = fileFor(e.outputPath, fn, frames.length > 1);
    if (!/\\.png$/i.test(path)) aemcp.fail("outputPath must end in .png: " + path);
    var file = new File(path), key = "f:" + file.fsName.toLowerCase();
    if (seen[key]) aemcp.fail("Two exports would write the same file: " + file.fsName);
    seen[key] = true;
    // (the files of earlier passes are this export's own)
    if (file.exists && !args.overwrite && pass >= (args.pass || 0)) exists.push(file.fsName);
    list.push({ t: t, frame: fn, file: file });
  }
  total += list.length;
  jobs.push({ src: src, footage: footage, layers: e.layers, list: list, name: name, sig: sig, pass: pass });
}
var passes = 0;
for (var i4 = 0; i4 < jobs.length; i4++) passes = Math.max(passes, jobs[i4].pass + 1);
if (total > 500) aemcp.fail(total + " frames requested; at most 500 per call");
if (exists.length) aemcp.fail("A file already exists at " + exists.slice(0, 5).join(", ") + (exists.length > 5 ? " and " + (exists.length - 5) + " more" : "") + ". Nothing was exported. To replace them, pass overwrite: true (or choose another outputPath).");
// every frame is written after this script returns: the temporary comps, hidden layers and settings stay until
// Node has the files, then they are removed and set back by hand (runRender)
var out = [], done = false;
try {
  displayColor();
  for (var j = 0; j < jobs.length; j++) {
    var J = jobs[j], comp = J.src;
    if (J.pass !== (args.pass || 0)) continue;
    if (J.footage) {
      var F = J.footage;
      comp = tempComp("__aemcp_export", F.width, F.height, F.pixelAspect, Math.max(F.duration, 1 / (F.frameRate > 0 ? F.frameRate : 25)), F.frameRate > 0 ? F.frameRate : 25);
      comp.layers.add(F);
    }
    // full resolution for the export
    try { fullRes(comp); } catch (er) {}
    if (J.layers && J.layers.length) {
      var keep = {};
      for (var a = 0; a < J.layers.length; a++) keep[aemcp.findLayer(comp, J.layers[a]).index] = true;
      for (var b = 1; b <= comp.numLayers; b++) {
        var L = comp.layer(b);
        if (keep[b] || !L.enabled) continue;
        hideLayer(comp, L);
      }
    }
    for (var q = 0; q < J.list.length; q++) {
      var job = J.list[q], parent = job.file.parent;
      if (parent && !parent.exists) parent.create();
      if (job.file.exists) job.file.remove();
      comp.saveFrameToPng(job.t, job.file);
      out.push({ path: job.file.fsName, source: J.name, frame: job.frame, time: job.t, width: comp.width, height: comp.height, layers: J.layers || undefined });
    }
  }
  done = true;
} finally { if (!done) cleanNow(__clean); }
return { files: out, cleanup: __clean, passes: passes };`;

const exportSpec = z.object({
  comp: z.union([z.number().int(), z.string()]).optional().describe("Composition id or name (default: the active comp)."),
  item: itemRef.optional().describe("A footage item or comp from the Project panel instead of comp (footage is exported at its own size)."),
  layers: z.array(layerRef).optional().describe("Export only these layers of the comp (the others are hidden for the export and restored)."),
  frames: z.array(z.number().int().min(0)).max(500).optional().describe("Whole frames from the start (frame 0 = time 0)."),
  frameRange: z
    .object({ start: z.number().int().min(0), end: z.number().int().min(0), step: z.number().int().min(1).optional() })
    .optional()
    .describe("Every frame from start to end (inclusive), or every step-th."),
  times: z.array(z.number().min(0)).max(500).optional().describe("Seconds, instead of frames."),
  outputPath: z
    .string()
    .describe('Absolute .png path ("~" = home). For several frames include {frame} (5 digits) or [####] (as many digits as #), e.g. "~/out/title_[####].png".'),
});

export function registerFileTools(server: McpServer) {
  server.registerTool(
    "ae_find_files",
    {
      title: "Find files",
      description:
        "Find files or folders on disk (runs in the MCP server; After Effects not needed), e.g. to locate footage to import or relink. " +
        'Roots may start with "~". pattern is a glob over the path below the root: "**/*.{mov,mp4}", "shots/*/plate_v[0-9][0-9].exr", or a name-only ' +
        'pattern like "logo*.png" (matched at any depth). Names match regardless of Unicode normalisation (macOS stores some accented names decomposed) and, ' +
        "by default, of case. Limited by depth, number of results and entries looked at; symlinked folders are followed once (no loops). " +
        "Returns absolute paths with size and modification time.",
      inputSchema: {
        roots: z.array(z.string()).min(1).max(20).describe('Folders to search, e.g. ["~/Projects/Spot", "/Volumes/Media"].'),
        pattern: z.string().optional().describe("Glob: ** (any folders), * , ?, [abc], [!abc], {a,b}."),
        nameContains: z.string().optional().describe("Only names containing this text."),
        type: z.enum(["files", "folders", "both"]).optional().describe("Default files."),
        maxDepth: z.number().int().min(1).max(32).optional().describe("Folder levels below each root (default 8)."),
        maxResults: z.number().int().min(1).max(5000).optional().describe("Default 200."),
        includeHidden: z.boolean().optional().describe("Include names starting with a dot (default false)."),
        caseSensitive: z.boolean().optional().describe("Default false."),
        followSymlinks: z.boolean().optional().describe("Follow symlinked folders and files (default true; each folder is entered once)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        if (!args.pattern && !args.nameContains) return errorResult("Give a pattern (glob) or nameContains.");
        const r = findFiles(args.roots, args);
        return { content: [{ type: "text", text: JSON.stringify({ roots: args.roots.map((x) => expandHome(x)), pattern: args.pattern, ...r }) }] };
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "ae_export_frames",
    {
      title: "Export frames as PNG",
      description:
        "Save PNG stills at full resolution: frames of comps, of chosen layers only, or of footage items; single frames, lists or frame ranges, " +
        "several exports in one call (up to 500 frames). Frames are whole numbers from the comp's start (frame 0 = time 0). Every path is checked first: " +
        "an existing file is never replaced unless overwrite is true, and nothing is written if any check fails. Leaves no undo step behind. " +
        "Returns the written files (use ae_render_frame to look at a frame instead).",
      inputSchema: {
        exports: z.array(exportSpec).min(1).max(50),
        overwrite: z.boolean().optional().describe("Replace existing files (default false: refuse)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const exports = args.exports.map((e) => ({ ...e, outputPath: expandHome(e.outputPath) }));
        // each pass: frames saved, Node waits for them, then what the pass changed is set back by hand (as
        // ae_render_frame, never Edit > Undo); a later pass only for exports of one comp with other layers shown
        type Info = { files: { path: string; source: string; frame: number; width: number; height: number }[]; tmpLeft?: boolean; passes?: number; cleanup?: unknown };
        const files: Info["files"] = [], missing: string[] = [], notes = new Set<string>();
        let passes = 1;
        for (let pass = 0; pass < passes; pass++) {
          const { r, missing: miss } = await runRender(EXPORT_FRAMES_JSX, { ...args, exports, pass }, { undoGroup: "Surehand MCP export", timeoutMs: 600_000 }, (x: Info) => waitForFiles(x.files.map((f) => f.path)));
          if (!r.ok) {
            if (!files.length) return formatResult(r);
            const fail = formatResult(r).content[0] as { text: string };
            return { isError: true, content: [{ type: "text", text: `Exported ${files.length} PNG files, then the rest failed: ${fail.text}\n${files.map((f) => f.path).join("\n")}` }] };
          }
          const info = r.result as Info;
          passes = info.passes ?? 1;
          files.push(...info.files);
          missing.push(...miss);
          for (const n of [colorNote(info), renderCleanupNote(r, info.tmpLeft, "__aemcp_export")]) if (n) notes.add(n);
        }
        const note = [...notes].join("\n");
        const lines = files.map((f) => `${f.path} (${f.source}, frame ${f.frame}, ${f.width}x${f.height})`);
        let text = `Exported ${files.length - missing.length} PNG file${files.length === 1 ? "" : "s"}:\n${lines.join("\n")}`;
        if (missing.length) text += `\nAfter Effects did not write: ${missing.join(", ")}`;
        if (note) text += `\n${note}`;
        return { ...(missing.length ? { isError: true } : {}), content: [{ type: "text", text }] };
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
