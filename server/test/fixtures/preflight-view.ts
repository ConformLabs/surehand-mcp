// A realistic Preflight run (comp and rendered file) as preflightView() gets it: used by the view tests and by
// scripts/preview-views.mjs (the PNG previews to compare with the approved mockup).
import { loadSpec } from "../../src/preflight/spec.js";
import type { ViewInput } from "../../src/preflight/view.js";

export const fixtureInput: ViewInput = {
  spec: loadSpec({
    name: "Broadcast",
    comp: "Main",
    video: { width: 1920, height: 1080, frameRate: 25, duration: 30 },
    safeAreas: { title: 0.1, action: 0.05, layersMustBeIn: [{ layer: "Logo*", area: "action" }] },
    text: { minCapHeightPx: 24, maxCharsPerSecond: 17, minOnScreenSeconds: 1 },
    project: { noMissingFootage: true, noMissingFonts: true, noMissingEffects: true, noExpressionErrors: true },
    legalRange: { luma: { min: 16, max: 235 } },
    black: { maxSeconds: 0.5 },
    frozen: { maxSeconds: 2 },
    audio: { integratedLUFS: -23, toleranceLU: 1 },
    flash: { check: true },
  }),
  specArg: "/Users/ron/Jobs/Promo/broadcast-spec.json",
  target: "both",
  verdictLine: "FAIL (3)",
  findings: [
    {
      check: "safeAreas.title",
      severity: "fail",
      where: "Main > 3: LT_Name",
      at: [12.4, 14.08],
      message: "outside title-safe by up to 18 px on the bottom",
      fix: "keep it inside title-safe (x 192–1728, y 108–972 px): move, scale or re-time it",
      box: [115, 845, 922, 990],
      area: { name: "title", rect: [192, 108, 1728, 972] },
    },
    { check: "text.capHeight", severity: "fail", where: "Main > 5: Legal_Text", at: [3.6, 6], message: "cap height about 21 px (minimum 24 px)", fix: "make the text bigger (font size or scale)", box: [210, 930, 1180, 952] },
    { check: "loudness", severity: "fail", message: "Integrated loudness is -19.4 LUFS; the spec wants -23 LUFS ±1 LU.", fix: "Lower the mix by about 3.6 dB, or normalise it to -23 LUFS." },
    {
      check: "safeAreas.3d",
      severity: "warn",
      where: "Main > 7: Logo_3D",
      at: [24, 29.96],
      message: "3D layer (or parented to / nested in a 3D layer, or its 3D switch can't be read): safe areas and cap height not checked",
      fix: "check it at key times with ae_get_layer_bounds (it projects through the camera) or ae_render_frame",
    },
    { check: "flash", severity: "info", message: "Flash pre-check on a 32x18 grid over 750 frames; not a certified PSE / Harding test." },
  ],
  notRun: [{ check: "legalRange", reason: "the file is RGB (rgb48le); legal range is measured on YUV (Y'CbCr) video" }],
  timeBase: { fps: 25 },
  comp: { id: 12, name: "Main", w: 1920, h: 1080, fps: 25, dur: 30 },
  file: "/Users/ron/Jobs/Promo/Render/Main_v12.mov",
  probe: { duration: 30, video: { size: "1920x1080", frameRate: 25 } },
};

/** The tool call's arguments (what Run again sends again). */
export const fixtureArgs = { spec: "/Users/ron/Jobs/Promo/broadcast-spec.json", target: "both", file: "/Users/ron/Jobs/Promo/Render/Main_v12.mov" };
