// Preflight: the delivery spec. The user writes it once (a JSON file, or inline in the call); every section
// is optional and a check only runs when its section is there. Nothing here is a canned look or a "preset":
// the numbers are the user's (or their client's / broadcaster's) delivery requirements.
//
// Units: pixels, seconds, frames per second; luma/chroma as 8-bit code values (0-255; video range is
// 16-235 luma, 16-240 chroma); loudness in LUFS / LU, true peak in dBTP (EBU R128 / ITU-R BS.1770).
import { readFileSync } from "node:fs";
import { z } from "zod";

const range = z.object({ min: z.number().optional(), max: z.number().optional() }).strict();
const num = z.number();
/** a fraction of the frame per side (0.05 = 5% in from each edge), or separate x / y fractions */
export const margin = z.union([num.min(0).max(0.5), z.object({ x: num.min(0).max(0.5), y: num.min(0).max(0.5) }).strict()]);

export const specSchema = z
  .object({
    name: z.string().optional().describe("A name for this spec (shown in the report)."),
    comp: z.union([z.string(), z.number().int()]).optional().describe("The comp that is delivered (project checks). Default: the active comp."),

    video: z
      .object({
        width: num.int().optional(),
        height: num.int().optional(),
        frameRate: num.optional().describe("e.g. 25, 29.97, 23.976"),
        pixelAspect: num.optional(),
        duration: z.union([num, range]).optional().describe("seconds: exact, or {min, max}"),
        durationToleranceFrames: num.int().min(0).optional().describe("allowed difference for an exact duration (default 0)"),
        // rendered file only
        codec: z.array(z.string()).optional().describe('allowed codec names as ffprobe reports them, e.g. ["prores", "h264"]'),
        container: z.array(z.string()).optional().describe('allowed containers / file extensions, e.g. ["mov", "mxf"]'),
        bitDepth: z.union([num.int(), z.array(num.int())]).optional().describe("bits per component in the file, e.g. 10"),
        chromaSubsampling: z.array(z.enum(["4:2:0", "4:2:2", "4:4:4"])).optional(),
        alpha: z.boolean().optional().describe("the file must (true) or must not (false) have an alpha channel"),
        fieldOrder: z.enum(["progressive", "tff", "bff"]).optional(),
        colorPrimaries: z.string().optional().describe('as ffprobe reports it, e.g. "bt709"'),
        colorTransfer: z.string().optional(),
        colorMatrix: z.string().optional(),
        colorRange: z.enum(["limited", "full"]).optional().describe('signalled range ("limited" = tv / video range)'),
      })
      .strict()
      .optional(),

    safeAreas: z
      .object({
        action: margin.optional().describe("action-safe margin per side"),
        title: margin.optional().describe("title-safe margin per side"),
        textMustBeIn: z
          .enum(["title", "action", "frame", "none"])
          .optional()
          .describe('every visible text layer must stay inside this area on every checked frame (default: title; "none": only the layers in layersMustBeIn)'),
        layersMustBeIn: z
          .array(z.object({ layer: z.string().describe("layer name (exact), or a pattern with * wildcards"), area: z.enum(["title", "action", "frame"]) }).strict())
          .optional()
          .describe("other layers (logos, bugs, supers) and the area they must stay in"),
        sampleEveryFrames: num.int().min(1).optional().describe("check every Nth frame (default 1: every frame)"),
      })
      .strict()
      .optional(),

    text: z
      .object({
        minCapHeightPx: num.optional().describe("smallest allowed rendered cap height in comp pixels"),
        maxCharsPerSecond: num.optional().describe("reading speed: characters on screen / seconds visible"),
        minOnScreenSeconds: num.optional().describe("each text must stay visible at least this long"),
        noOverflow: z.boolean().optional().describe("paragraph (box) text must not overflow its box"),
        glyphs: z.boolean().optional().describe("every character must exist in its font (no fallback glyphs)"),
      })
      .strict()
      .optional(),

    project: z
      .object({
        noMissingFootage: z.boolean().optional(),
        noMissingFonts: z.boolean().optional(),
        noMissingEffects: z.boolean().optional(),
        noExpressionErrors: z.boolean().optional(),
        noDisabledLayersWithEffects: z.boolean().optional(),
        bitsPerChannel: z.union([z.literal(8), z.literal(16), z.literal(32)]).optional(),
        workingSpace: z.string().optional().describe("project working color space name, as After Effects shows it"),
      })
      .strict()
      .optional(),

    legalRange: z
      .object({
        luma: range.optional().describe("allowed 8-bit luma code values, e.g. {min: 16, max: 235}"),
        chroma: range.optional().describe("allowed 8-bit chroma code values, e.g. {min: 16, max: 240}"),
        maxOutOfRangePercent: num.min(0).max(100).optional().describe("pixels per frame allowed outside the range (default 0)"),
      })
      .strict()
      .optional(),

    black: z
      .object({
        maxSeconds: num.min(0).describe("longest allowed run of black frames"),
        allowAtStart: num.min(0).optional().describe("black allowed at the start (seconds), e.g. a slate gap"),
        allowAtEnd: num.min(0).optional(),
        threshold: num.min(0).max(1).optional().describe("luma (0-1 of the range) at or below which a pixel counts as black (default 0.1)"),
      })
      .strict()
      .optional(),
    frozen: z
      .object({
        maxSeconds: num.min(0).describe("longest allowed run of identical (frozen) frames"),
        noise: num.min(0).optional().describe("difference treated as identical (default 0.001, ffmpeg freezedetect)"),
      })
      .strict()
      .optional(),

    audio: z
      .object({
        integratedLUFS: num.optional().describe("integrated loudness target, e.g. -23"),
        toleranceLU: num.min(0).optional().describe("allowed deviation from the target (default 1)"),
        maxTruePeakDBTP: num.optional().describe("e.g. -1"),
        maxShortTermLUFS: num.optional(),
        loudnessRangeLU: range.optional(),
        sampleRate: num.int().optional(),
        channels: num.int().optional(),
        required: z.boolean().optional().describe("the file must (true) or must not (false) have audio"),
      })
      .strict()
      .optional(),

    flash: z
      .object({
        check: z.literal(true),
        maxFlashesPerSecond: num.optional().describe("default 3"),
        minAreaFraction: num.min(0).max(1).optional().describe("smallest part of the screen that counts (default 0.25)"),
        minLuminanceChange: num.min(0).max(1).optional().describe("relative luminance change that counts as a flash transition (default 0.1)"),
        redFlash: z.boolean().optional().describe("also check saturated red transitions (default true)"),
      })
      .strict()
      .optional()
      .describe("photosensitive flash PRE-CHECK; not a certified PSE / Harding test"),
  })
  .strict();

export type Spec = z.infer<typeof specSchema>;

/** A spec from a file path or an inline object; a readable error naming the field when it's invalid. */
export function loadSpec(input: string | unknown): Spec {
  let raw: unknown = input;
  if (typeof input === "string") {
    let text: string;
    try {
      text = readFileSync(input, "utf8");
    } catch (e: any) {
      throw new Error(`Could not read the spec file ${input}: ${e?.message ?? e}`);
    }
    try {
      raw = JSON.parse(text);
    } catch (e: any) {
      throw new Error(`The spec file ${input} is not valid JSON: ${e?.message ?? e}`);
    }
  }
  const r = specSchema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(spec)"}: ${i.message}`);
    throw new Error(`The delivery spec is not valid:\n- ${issues.join("\n- ")}`);
  }
  return r.data;
}

/** Margins of an area as fractions per side; "frame" is 0. */
export function areaMargins(spec: Spec, area: "title" | "action" | "frame"): { x: number; y: number } | null {
  if (area === "frame") return { x: 0, y: 0 };
  const m = spec.safeAreas?.[area];
  if (m === undefined) return null;
  return typeof m === "number" ? { x: m, y: m } : m;
}

/** One finding in a Preflight report. `at` is seconds (or a range) in the delivered comp / file. */
export interface Finding {
  check: string;
  severity: "fail" | "warn" | "info";
  message: string;
  at?: number | [number, number];
  /** where in the project: comp > layer, when known */
  where?: string;
  /** a short suggestion of how to fix it */
  fix?: string;
  // for the in-chat view only (never in the text report): comp pixels [x0, y0, x1, y1]
  /** the layer's measured bounds at the finding's first frame */
  box?: [number, number, number, number];
  /** the safe area it must stay in */
  area?: { name: "title" | "action" | "frame"; rect: [number, number, number, number] };
}

/**
 * A check the spec asks for that did not run (or ran on incomplete data), and why. Distinct from a section that
 * isn't in the spec and from a check this target can't do (project-only checks on a file): those are "not checked".
 * Any of these keeps the verdict from being PASS.
 */
export interface NotRun {
  check: string;
  reason: string;
}
