// ae_preflight: check the delivered comp and / or its render against the user's own delivery spec
// (src/preflight/spec.ts). Read-only for the project: the ExtendScript only reads (no undo group, no
// temporary items); the render checks run in Node on the file (src/preflight/media.ts).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { extname } from "node:path";
import { z } from "zod";
import { callContext } from "../context.js";
import { runJsx } from "../jsx.js";
import { checkFile, type FileCheck } from "../preflight/media.js";
import { jsxArgs, needsXray, PREFLIGHT_JSX, projectChecks, type PData } from "../preflight/project.js";
import { formatReport, type TimeBase } from "../preflight/report.js";
import { loadSpec, specSchema, type Finding, type Spec } from "../preflight/spec.js";
import type { XData } from "./xray-analyze.js";
import { XRAY_JSX } from "./xray.js";
import { compRef, errorResult, formatResult } from "./registry.js";

const SECTIONS = ["video", "safeAreas", "text", "project", "legalRange", "black", "frozen", "audio", "flash"] as const;
const FILE_ONLY = ["legalRange", "black", "frozen", "audio", "flash"] as const;
const FILE_ONLY_VIDEO = ["codec", "container", "bitDepth", "chromaSubsampling", "alpha", "fieldOrder", "colorPrimaries", "colorTransfer", "colorMatrix", "colorRange"] as const;
const PROJECT_ONLY = ["safeAreas", "text", "project"] as const;
const MAX_THUMBNAILS = 4;

export const SCHEMA_GUIDANCE = `The delivery spec is the user's own: the numbers come from their delivery document (client, broadcaster,
platform). Ask for them; never fill in values the user didn't give. Every section is optional, and a check only runs when
its section is in the spec. Units: pixels, seconds, frames per second; margins are fractions of the frame per side
(<fraction> = 0.05 means 5% in from each edge); luma/chroma are 8-bit code values; loudness in LUFS / LU, true peak in dBTP.
Save it as a .json file next to the project (pass its path as "spec") or pass it inline.

Shape (placeholders, not values):
{
  "name": "<name shown in the report>",
  "comp": "<delivered comp name, or omit for the active comp>",
  "video": { "width": <px>, "height": <px>, "frameRate": <fps>, "duration": <seconds> | { "min": <s>, "max": <s> } },
  "safeAreas": { "title": <fraction> | { "x": <fraction>, "y": <fraction> }, "action": <fraction>,
                 "layersMustBeIn": [ { "layer": "<name or pattern*>", "area": "title" | "action" | "frame" } ] },
  "text": { "minCapHeightPx": <px>, "maxCharsPerSecond": <n>, "minOnScreenSeconds": <s>, "noOverflow": true, "glyphs": true },
  "project": { "noMissingFootage": true, "noMissingFonts": true, "noMissingEffects": true, "noExpressionErrors": true }
  ... and for a rendered file: video codec/container/bitDepth/color fields, legalRange, black, frozen, audio, flash (see the schema).
}
The flash section is a photosensitivity PRE-CHECK, not a certified PSE / Harding test.`;

const fmtSecs = (s: number) => `${Math.round(s * 100) / 100} s`;

/** Thumbnails for the report: the ones at failing findings first, then warnings, at most MAX_THUMBNAILS. */
export function pickThumbnails(fc: FileCheck): NonNullable<FileCheck["thumbnails"]> {
  const near = (t: number, f: Finding) => {
    if (f.at === undefined) return false;
    const [a, b] = Array.isArray(f.at) ? f.at : [f.at, f.at];
    return t >= a - 0.5 && t <= b + 0.5;
  };
  const rank = (t: number) => (fc.findings.some((f) => f.severity === "fail" && near(t, f)) ? 0 : fc.findings.some((f) => f.severity === "warn" && near(t, f)) ? 1 : 2);
  return [...(fc.thumbnails ?? [])].sort((a, b) => rank(a.at) - rank(b.at) || a.at - b.at).slice(0, MAX_THUMBNAILS);
}

/** What the spec asks for that this target can't check. */
export function targetSkips(spec: Spec, target: "project" | "file" | "both"): string[] {
  const out: string[] = [];
  const absent = SECTIONS.filter((s) => spec[s] === undefined);
  if (absent.length) out.push(`not in the spec: ${absent.join(", ")}`);
  if (target === "project") {
    const fileOnly: string[] = FILE_ONLY.filter((s) => spec[s] !== undefined);
    for (const k of FILE_ONLY_VIDEO) if (spec.video?.[k] !== undefined) fileOnly.push(`video.${k}`);
    if (fileOnly.length) out.push(`${fileOnly.join(", ")}: checked on a rendered file (target "file" or "both" with file)`);
  }
  if (target === "file") {
    const projOnly = PROJECT_ONLY.filter((s) => spec[s] !== undefined);
    if (projOnly.length) out.push(`${projOnly.join(", ")}: checked in the project (target "project" or "both")`);
  }
  return out;
}

async function runPreflight(args: Record<string, any>): Promise<CallToolResult> {
  if (args.spec === undefined) return errorResult('Pass the delivery spec: a path to its JSON file or the spec object. action: "schema" describes its fields.');
  const spec = loadSpec(args.spec);
  const target: "project" | "file" | "both" = args.target ?? "project";
  if (target !== "project" && !args.file) return errorResult(`target "${target}" needs file: the path of the rendered file to check.`);
  if (args.file && !existsSync(args.file)) return errorResult(`No file at ${args.file}`);
  const findings: Finding[] = [], skipped: string[] = targetSkips(spec, target), notes: string[] = [];
  const titleParts: string[] = [];
  let timeBase: TimeBase | undefined;

  if (target !== "file") {
    const budget = typeof args.timeBudgetSeconds === "number" ? args.timeBudgetSeconds : 120;
    const pa = jsxArgs(spec, { comp: args.comp, timeBudgetSeconds: budget });
    const r = await runJsx(PREFLIGHT_JSX, pa, { undoGroup: false, timeoutMs: budget * 1000 + 120_000 });
    if (!r.ok) return formatResult(r);
    const d = (typeof r.result === "string" ? JSON.parse(r.result) : r.result) as PData;
    let x: XData | undefined;
    if (needsXray(spec)) {
      const xr = await runJsx(XRAY_JSX, { sections: ["missing", "expressions"], comps: [d.comp.id], timeBudgetSeconds: Math.min(budget, 90) }, { undoGroup: false, timeoutMs: 300_000 });
      if (xr.ok) x = (typeof xr.result === "string" ? JSON.parse(xr.result) : xr.result) as XData;
      else skipped.push(`project (missing items, expression errors): could not be read: ${xr.error?.message ?? "unknown error"}`);
    }
    const pr = projectChecks(spec, d, x);
    findings.push(...pr.findings);
    skipped.push(...pr.skipped);
    notes.push(...pr.notes);
    timeBase = { fps: d.comp.fps, dropFrame: !!d.comp.df, offset: d.comp.dst ?? 0 };
    titleParts.push(`comp "${d.comp.name}" (${d.comp.w}x${d.comp.h}, ${Math.round(d.comp.fps * 1000) / 1000} fps, ${fmtSecs(d.comp.dur)})`);
  }

  let fc: FileCheck | undefined;
  if (target !== "project") {
    try {
      // the one-time ffmpeg download only with the user's consent (the AI asks first, then passes allowFfmpegDownload)
      fc = await checkFile(args.file, spec, { thumbnails: true, signal: callContext.getStore()?.signal, allowDownload: args.allowFfmpegDownload === true });
    } catch (e: any) {
      const why = e?.message ?? String(e);
      if (target === "file") return errorResult(`The file checks could not run: ${why}`);
      findings.push({ check: "file", severity: "warn", message: `the file checks could not run: ${why}` });
    }
    if (fc) {
      findings.push(...fc.findings);
      skipped.push(...(fc.skipped ?? []));
      // nothing in the file was measured without ffmpeg: never let that read as a PASS
      if (!fc.tool && !fc.findings.length)
        findings.push({ check: "file", severity: "warn", message: "the rendered file was NOT checked: ffmpeg isn't available (see \"not checked\" below)" });
      if (!fc.tool && args.allowFfmpegDownload !== true)
        notes.push("ffmpeg isn't installed, so the file checks didn't run. Ask the user whether to download it once (a pinned, checksum-verified build into ~/.aemcp/ffmpeg), then call again with allowFfmpegDownload: true; or they can install it themselves (brew install ffmpeg / winget install ffmpeg).");
      if (!timeBase) {
        // the file's own frame rate (probe.video.frameRate); the spec's only when the file has no video
        const v = (fc.probe.video ?? {}) as { frameRate?: number };
        const fps = Number(v.frameRate ?? fc.probe.frameRate ?? spec.video?.frameRate);
        if (fps > 0) timeBase = { fps };
      }
    }
    titleParts.push(`file ${args.file}`);
  }

  // one line for checks skipped for the same reason (e.g. "ffmpeg not found" for every file check)
  const byReason = new Map<string, string[]>();
  for (const line of skipped) {
    const m = /^([^:]{1,40}): (.+)$/s.exec(line);
    const key = m ? m[2] : line;
    byReason.set(key, [...(byReason.get(key) ?? []), m ? m[1] : ""]);
  }
  skipped.splice(0, skipped.length, ...[...byReason].map(([why, names]) => (names.every(Boolean) ? `${names.join(", ")}: ${why}` : why)));

  const title = `Preflight against ${spec.name ? `"${spec.name}"` : "the delivery spec"}: ${titleParts.join("; ")}`;
  const text = formatReport({ title, findings, timeBase, skipped, notes, probe: fc?.probe, maxFindings: args.maxFindings });
  const content: CallToolResult["content"] = [{ type: "text", text }];
  if (fc) {
    const picked = pickThumbnails(fc);
    for (const t of picked) {
      try {
        const ext = extname(t.path).toLowerCase();
        const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
        content.push({ type: "image", data: readFileSync(t.path).toString("base64"), mimeType }, { type: "text", text: `${t.label} (${fmtSecs(t.at)})` });
      } catch {
        // a thumbnail that can't be read is left out
      }
    }
    // the thumbnails are temporary files in ~/.aemcp/tmp: remove all of them, shown or not
    for (const t of fc.thumbnails ?? [])
      try {
        unlinkSync(t.path);
      } catch {}
  }
  return { content };
}

export function registerPreflightTools(server: McpServer) {
  server.registerTool(
    "ae_preflight",
    {
      title: "Preflight",
      description:
        "Check the delivered comp and/or its rendered file against the user's own delivery spec (a JSON file or inline object; " +
        'action "schema" returns its JSON schema). Project checks: comp size, frame rate, pixel aspect, duration; bit depth, working ' +
        "space; missing footage, fonts, effects; expression errors; disabled layers with effects; text and named layers inside " +
        "title/action-safe on every frame (through parents and precomps); text cap height, reading speed, time on screen, box " +
        "overflow, missing glyphs. File checks (target \"file\"/\"both\", needs ffmpeg): codec, container, color, legal range, black " +
        "and frozen frames, loudness, a flash pre-check. Returns a verdict (PASS / FAIL (n) / WARNINGS (n)) and timecoded findings " +
        "with fixes. Changes nothing in the project.",
      inputSchema: {
        action: z.enum(["check", "schema"]).optional().describe('"check" (default) runs the checks; "schema" returns the spec\'s JSON schema and how to write one.'),
        spec: z.union([z.string(), z.record(z.string(), z.any())]).optional().describe("The delivery spec: path to a JSON file, or the spec object."),
        target: z.enum(["project", "file", "both"]).optional().describe('What to check: "project" (default), "file" (a rendered file), or "both".'),
        file: z.string().optional().describe('Path of the rendered file (target "file" or "both").'),
        comp: compRef.describe("The delivered comp (overrides spec.comp). Default: spec.comp, else the active comp."),
        maxFindings: z.number().int().min(1).max(500).optional().describe("Most findings listed (default 60); counts stay complete."),
        allowFfmpegDownload: z
          .boolean()
          .optional()
          .describe("Only after the user agreed: if ffmpeg isn't installed, download it once (a pinned, checksum-verified build, about 60-80 MB) into ~/.aemcp/ffmpeg for the file checks."),
        timeBudgetSeconds: z.number().min(5).max(1800).optional().describe("Stop the frame-by-frame project checks after this long and report what was checked (default 120)."),
      },
      // never changes the project; can download ffmpeg (with the user's consent) and writes temporary thumbnails
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: Record<string, any>) => {
      try {
        if (args.action === "schema")
          return { content: [{ type: "text", text: `${SCHEMA_GUIDANCE}\n\nJSON schema:\n${JSON.stringify(z.toJSONSchema(specSchema))}` }] };
        return await runPreflight(args);
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
