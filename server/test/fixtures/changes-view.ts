// A proven edit (un-precompose Logo_Lockup in Endcard: 24 frames, its change report) and a history diff, as the
// "What changed, and the proof" view gets them: used by the view tests and scripts/preview-views.mjs.
import { canonical, type Item, type Layer, type Snapshot } from "../../src/history-diff.js";
import type { Changes } from "../../src/jsx.js";
import type { Comparison } from "../../src/tools/prove.js";
import type { ProofFrame } from "../../src/views/types.js";

const fps = 25;
const tc = (t: number) => {
  const f = Math.round(t * fps), p2 = (n: number) => String(n).padStart(2, "0");
  return `00:00:${p2(Math.floor(f / fps))}:${p2(f % fps)}`;
};
/** 24 frames from 24 s to the end of a 30 s comp; `differ`: the indexes that differ */
function frames(differ: number[] = [], maxDiff = 0.4): ProofFrame[] {
  return Array.from({ length: 24 }, (_, i) => {
    const time = Math.round((24 + (i * 5.96) / 23) * fps) / fps;
    return { comp: "Endcard", compId: 7, index: i, time, tc: tc(time), differs: differ.includes(i), maxDiff: differ.includes(i) ? 38 : maxDiff };
  });
}

const base = { id: "20261020-140210123-ab12", createdAt: "2026-10-20T14:02:10.123Z", comps: ["Endcard"], compared: "20261020-141502456-cd34" };

export const identical: Comparison = {
  verdict: "identical within tolerance",
  text: "Verdict: IDENTICAL WITHIN TOLERANCE: all 24 frames match within 1/255 per channel (largest difference 0.4/255: high-bit-depth rounding, invisible in 8-bit output; pass tolerance 0 to require bit-identical).",
  view: { ...base, head: "Verdict: IDENTICAL WITHIN TOLERANCE: all 24 frames match within 1/255 per channel (largest difference 0.4/255).", tolerance: 1, maxDiff: 0.4, frames: frames() },
};

export const differs: Comparison = {
  verdict: "differs",
  text: 'Verdict: DIFFERS in 3 of 24 frames (default tolerance 0.5/255: less than one 8-bit step): "Endcard" at 26.48s (f662), "Endcard" at 26.76s (f669), "Endcard" at 27s (f675).',
  view: { ...base, head: "Verdict: DIFFERS in 3 of 24 frames.", tolerance: 0.5, maxDiff: 38, frames: frames([10, 11, 12]) },
};

/** the batch's change report, as aemcp.jsxinc returns it */
export const editChanges: Changes = {
  items: [],
  layers: [
    ["-", "Endcard", "Logo_Lockup"],
    ["+", "Endcard", "Logo_Mark"],
    ["+", "Endcard", "Logo_Type"],
    ["+", "Endcard", "Logo_Tagline"],
    ["+", "Endcard", "Logo_Null"],
    ["+", "Endcard", "Logo_Glow"],
    ["~", "Endcard", "Logo_Type", "parent none -> Logo_Null"],
    ["~", "Endcard", "Logo_Tagline", "parent none -> Logo_Null"],
  ],
  props: [
    ["~", "Logo_Mark", "Transform/Scale", "[100,100] -> [64,64]", "Endcard"],
    ["~", "Logo_Mark", "Transform/Position", "[960,540] -> [1210,388]", "Endcard"],
    ["~", "Logo_Type", "Transform/Opacity", "keyframes 2 -> 3, expression added", "Endcard"],
  ],
  scope: ["Endcard"],
};

// ---------- a history diff: checkpoint "before un-precompose" -> now ----------

const L = (key: string, index: number, name: string, props: Layer["props"] = {}, attrs: Record<string, unknown> = {}): Layer => ({
  key, index, name, type: "shape", attrs: { inPoint: 0, outPoint: 30, parent: null, ...attrs }, props, groups: {},
});
const comp = (layers: Layer[]): Item => ({ id: 7, type: "comp", name: "Endcard", folder: "", fields: { width: 1920, height: 1080, duration: 30, frameRate: 25 }, layers: Object.fromEntries(layers.map((l) => [l.key, l])) });
const snap = (id: string, items: Item[], extra: Partial<Snapshot> = {}): Snapshot =>
  canonical({
    format: 1, id, at: "2026-10-20T14:02:00.000Z", project: "/Jobs/Promo_Q4_v12.aep", revision: 1,
    stats: { comps: 1, layers: 1, visited: 1, stored: 1, ms: 1, pruning: "on" }, settings: { bitsPerChannel: 16 },
    items: Object.fromEntries(items.map((i) => [String(i.id), i])), rq: {}, ...extra,
  }) as Snapshot;
const SCALE = "ADBE Transform Group/ADBE Scale", POS = "ADBE Transform Group/ADBE Position";
export const historyFrom = snap("s1", [comp([L("L1", 1, "BG"), L("L4", 4, "Logo_Lockup", { [SCALE]: { path: "Transform/Scale", v: [100, 100, 100] } })])], { label: "before un-precompose", checkpoint: "cp1" });
export const historyTo = snap("current", [
  comp([
    L("L1", 1, "BG"),
    L("L4", 4, "Logo_Mark", { [SCALE]: { path: "Transform/Scale", v: [64, 64, 100] }, [POS]: { path: "Transform/Position", v: [1210, 388, 0] } }),
    L("L6", 5, "Logo_Type", {}, { parent: "L8" }),
    L("L7", 6, "Logo_Tagline", {}, { parent: "L8" }),
    L("L8", 7, "Logo_Null"),
  ]),
]);
