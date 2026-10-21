// A stress test as the approved board shows it ("Stress test · Lower_Third"): 3 controls, 14 variants measured at 6
// frames, 3 failing and 1 warning, 2 expressions that break in other AE languages. Used by test/stress-view.test.ts
// and scripts/preview-views.mjs.
import type { StressCell, StressColumn, StressVariant, StressView } from "../../src/views/types.js";

const cells = (fit: StressCell, safe: StressCell, size: StressCell, glyphs: StressCell, lines: StressCell, other: StressCell = "ok"): Record<StressColumn, StressCell> => ({ fit, safe, size, glyphs, lines, other });
const passed = (id: string, name: string, detail: string, value: string): StressVariant => ({
  id, name, set: "generated", detail, inputs: [{ target: detail.split(" · ")[0], value }], status: "pass", cells: cells("ok", "ok", "ok", "ok", "ok"), findings: [], layers: [], notRun: [],
});

export function stressFixture(): StressView {
  const variants: StressVariant[] = [
    {
      id: "de-long@Name", name: "German · longest", set: "generated", caseId: "de-long", group: "length", detail: "Name · 41 chars",
      inputs: [{ target: "Name", value: "Maximilian Donaudampfschifffahrtsgesellschaft", detail: "41 chars, compounds" }],
      status: "fail", cells: cells("bad", "bad", "ok", "ok", "bad"),
      findings: [
        { check: "text.overflow", column: "fit", severity: "fail", layer: "Name", layerIndex: 2, message: "overflows its box by 184 px; 3 lines, the box shows 2 (text is cut off)", frame: 48, time: 1.92, tc: "00:00:01:23", box: [200, 830, 1060, 900], textBox: [200, 830, 1060, 900], amountPx: 184 },
        { check: "safeAreas.title", column: "safe", severity: "fail", layer: "Name", layerIndex: 2, message: "outside title-safe by up to 96 px on the right", frame: 48, time: 1.92, tc: "00:00:01:23", box: [200, 830, 1824, 900], area: { name: "title", rect: [192, 108, 1728, 972] }, amountPx: 96 },
        { check: "text.lines", column: "lines", severity: "fail", layer: "Name", layerIndex: 2, message: "the limit is 2 lines", frame: 48, time: 1.92, tc: "00:00:01:23" },
      ],
      layers: [{ layer: "Name", layerIndex: 2, text: "Maximilian Donaudampfschifffahrtsgesellschaft", font: "SpaceGrotesk-SemiBold", fontSize: 64, renderedPx: 64, lines: 2, linesNeeded: 3, overflowPx: 184, box: [200, 830, 1824, 900] }],
      notRun: [],
      sheet: "/Users/ron/.surehand/ae/stress/20261021-101500-ab12/de-long@Name.png",
      frame: { file: "de-long@Name_frame.png", frame: 48, time: 1.92, tc: "00:00:01:23", width: 1280, height: 720 },
    },
    {
      id: "ar-rtl@Name", name: "Arabic · with digits", set: "generated", caseId: "ar-rtl", group: "rtl", detail: "Name · right to left",
      inputs: [{ target: "Name", value: "عرض خاص: خصم 50% حتى 31.12.2026" }],
      status: "fail", cells: cells("ok", "ok", "ok", "bad", "ok"),
      findings: [{ check: "text.composer", column: "glyphs", severity: "fail", layer: "Name", layerIndex: 2, message: "Arabic with the Latin and East Asian composer: the letters don't join (it needs the Universal composer)", frame: 24, time: 0.96, tc: "00:00:00:24", box: [200, 830, 760, 900] }],
      layers: [], notRun: [],
      frame: { file: "ar-rtl@Name_frame.png", frame: 24, time: 0.96, tc: "00:00:00:24", width: 1280, height: 720 },
    },
    {
      id: "n-huge@Price", name: "Number · 1,234,567.89", set: "generated", caseId: "n-huge", group: "number", detail: "Price",
      inputs: [{ target: "Price", value: "1,234,567.89" }],
      status: "fail", cells: cells("bad", "ok", "ok", "ok", "ok"),
      findings: [{ check: "text.width", column: "fit", severity: "fail", layer: "Price", layerIndex: 4, message: "is 412 px wide; the most it may take is 320 px (over by 92 px)", frame: 0, time: 0, tc: "00:00:00:00", box: [1400, 840, 1812, 900], amountPx: 92 }],
      layers: [], notRun: [],
      frame: { file: "n-huge@Price_frame.png", frame: 0, time: 0, tc: "00:00:00:00", width: 1280, height: 720 },
    },
    {
      id: "no-spaces@Title", name: "No spaces", set: "generated", caseId: "no-spaces", group: "length", detail: "Title · 64 chars, a URL",
      inputs: [{ target: "Title", value: "https://www.example.com/campaign/2026/spring-collection-launch" }],
      status: "warn", cells: cells("ok", "ok", "ok", "ok", "warn"),
      findings: [{ check: "text.break", column: "lines", severity: "warn", layer: "Title", layerIndex: 3, message: 'breaks inside a word: "campaign|2026"', frame: 0, time: 0, tc: "00:00:00:00", box: [200, 910, 1010, 990] }],
      layers: [], notRun: [],
    },
    passed("ja@Name", "Japanese", "Name", "東京都千代田区で特別キャンペーン開催中"),
    { ...passed("row-7", "Your data · row 7", "names.csv", "Ana Lucía Ortega"), set: "data", inputs: [{ target: "Name", value: "Ana Lucía Ortega" }] },
    passed("en@Name", "English", "Name", "Jordan Smith"),
    passed("fr@Name", "French", "Name", "Élodie Lefèvre-Beauséjour"),
    passed("he-rtl@Name", "Hebrew", "Name", "מבצע מיוחד: 50% הנחה"),
    passed("emoji@Name", "emoji", "Name", "Sale 🔥🎉"),
    passed("one-char@Name", "1 character", "Name", "W"),
    passed("caps@Title", "All caps", "Title", "LEITERIN KOMMUNIKATION ÄÖÜ"),
    passed("n-zero@Price", "Number · 0", "Price", "0"),
    passed("vi-combining@Title", "Combining marks", "Title", "Chương trình"),
  ];
  return {
    view: "stress",
    run: "20261021-101500-ab12",
    verdict: "FAIL",
    verdictLine: "FAIL (3 of 14 variants break; 1 expression breaks in other AE languages)",
    comp: { id: 12, name: "Lower_Third", width: 1920, height: 1080, fps: 25, duration: 6 },
    counts: { variants: 14, failed: 3, warnings: 1, passed: 10, incomplete: 0, notRun: 0, languageRisks: 2, targets: 3, frames: 6 },
    targets: [
      { id: "Name", name: "Name", kind: "text", source: "egp", layer: 2, layerName: "Name", current: "Maximilian Weber" },
      { id: "Title", name: "Title", kind: "text", source: "egp", layer: 3, layerName: "Title", current: "Leiterin Kommunikation" },
      { id: "Price", name: "Price", kind: "number", source: "egp", layer: 4, layerName: "Controls", current: "1299" },
    ],
    frames: [0, 24, 48, 72, 120, 149],
    columns: (["fit", "safe", "size", "glyphs", "lines", "other"] as StressColumn[]).map((id) => ({ id, label: id, ran: true })),
    variants,
    baseline: [],
    languages: [
      { comp: "Lower_Third", compId: 12, layer: "Price", layerIndex: 4, property: "Transform/Opacity", ref: 'effect("Slider Control")("Slider")', code: "effectDefaultName", severity: "fail", message: "names an effect by its English default name", fix: 'rename the effect, or use its match name "ADBE Slider Control"' },
      { comp: "Lower_Third", compId: 12, layer: "Bar", layerIndex: 5, property: "Contents/Size", ref: 'content("Rectangle 1")', code: "shapeDefaultName", severity: "warn", message: "names a shape group by its default English name", fix: "rename the group, or use content(1)" },
    ],
    restore: { verified: true, values: 412, differences: [] },
    notes: [],
    folder: "/Users/ron/.surehand/ae/stress/20261021-101500-ab12",
    args: { comp: "Lower_Third" },
  };
}
