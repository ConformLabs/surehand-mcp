// Project X-ray facts (what xray.ts's JSX returns) for the view tests and scripts/preview-views.mjs: the mockup's
// project, a big one (about 2,000 layers), one with an empty render queue, and one with no problems.
import type { XComp, XData, XFootage, XLayer } from "../../src/tools/xray-analyze.js";

let nextLayerId = 1000;
const L = (i: number, n: string, more: Partial<XLayer> = {}): XLayer => ({ i, id: nextLayerId++, n, t: more.src !== undefined ? "precomp" : "shape", ...more });
const comp = (id: number, name: string, layers: XLayer[], usedIn: number[] = [], more: Partial<XComp> = {}): XComp => ({
  id, name, w: 1920, h: 1080, fps: 25, dur: 30, nl: layers.length, usedIn, scanned: layers.length, layers, ...more,
});
const file = (id: number, name: string, usedIn: number[], more: Partial<XFootage> = {}): XFootage => ({ id, name, kind: "file", file: `/Jobs/Promo/Footage/${name}`, w: 3840, h: 2160, fps: 25, dur: 30, video: true, usedIn, ...more });
const data = (name: string, comps: XComp[], footage: XFootage[], rq: XData["rq"]): XData => ({
  v: 1, ae: "26.5", project: { name, file: `/Jobs/Promo/${name}`, items: comps.length + footage.length, bpc: 16 },
  sections: ["render", "expressions", "missing", "footage", "weight"], comps, footage, rq, fonts: { missing: [] },
  layersScanned: comps.reduce((n, c) => n + (c.layers?.length ?? 0), 0), ms: 1200,
});
const opacity = (layer: string): [string, string, string, number] => ["Transform/Opacity", `thisComp.layer("${layer}").transform.opacity`, "", 1];

/** The mockup's project: three render queue items, a fragile Endcard, a missing plate, a heavy hidden layer, unused comps. */
export function mockupProject(): XData {
  const endcard = comp(3, "Endcard", [
    L(1, "CTA_Text", { ex: [opacity("Logo")] }),
    L(2, "CTA_Sub", { ex: [opacity("Logo")] }),
    L(3, "CTA_Box", { ex: [opacity("Logo")] }),
    L(4, "Logo", { src: 4 }),
    L(5, "BG", { src: 20, t: "footage", ex: [["Transform/Scale", 'thisComp.layer("Logo").transform.scale', "", 1]] }),
  ], [1]);
  const lower = comp(5, "Lower_Thirds", [
    L(1, "Name", { t: "text" }),
    L(2, "Glow pass", { shy: 1, fx: [{ m: "ADBE Glo2", n: "Glow" }, { m: "ADBE Gaussian Blur 2", n: "Gaussian Blur" }] }),
    L(3, "Old glow", { off: 1, fx: [{ m: "ADBE Glo2", n: "Glow" }] }),
    L(4, "Edge", { guide: 1, fx: [{ m: "ADBE Fractal Noise", n: "Fractal Noise" }] }),
  ], [1, 6, 7]);
  const intro = comp(2, "Intro", [1, 2, 3, 4, 5, 6].map((i) => L(i, `Intro ${i}`)), [1]);
  const main = comp(1, "Main_16x9", [L(1, "Intro", { src: 2 }), L(2, "Endcard", { src: 3 }), L(3, "Lower_Thirds", { src: 5 }), ...[4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((i) => L(i, `Shot ${i}`))]);
  const logo = comp(4, "Logo_Lockup", [L(1, "Logo_Mark"), L(2, "Logo_Type"), L(3, "Logo_Tagline")], [3]);
  const vertical = comp(6, "Main_9x16", [L(1, "Lower_Thirds", { src: 5 }), L(2, "Shot")]);
  const square = comp(7, "Main_1x1", [L(1, "Lower_Thirds", { src: 5 }), L(2, "Shot")]);
  const unused = ["Endcard_old", "Endcard_v2", "Test_comp", "Logo_alt"].map((n, k) => comp(10 + k, n, [L(1, "Layer")]));
  return data(
    "Promo_Q4_v12.aep",
    [main, intro, endcard, logo, lower, vertical, square, ...unused],
    [file(20, "bg_plate.exr", [3], { missing: true, file: null, missingPath: "/Volumes/Plates/bg_plate.exr", fps: undefined, video: true }), file(21, "music.wav", [], { video: false, audio: true, w: undefined, h: undefined })],
    [
      { comp: 1, status: "QUEUED", render: true, file: "/Jobs/Promo/Render/Main_16x9.mov" },
      { comp: 6, status: "QUEUED", render: true, file: "/Jobs/Promo/Render/Main_9x16.mp4" },
      { comp: 7, status: "QUEUED", render: true, file: "/Jobs/Promo/Render/Main_1x1.mp4" },
    ],
  );
}

/** About 2,000 layers: 40 comps of 50, each using the next as a precomp, with expressions and a few problems. */
export function bigProject(): XData {
  const comps: XComp[] = [];
  for (let k = 0; k < 40; k++) {
    const layers = Array.from({ length: 50 }, (_, j) =>
      L(j + 1, `L${k}_${j}`, {
        ...(j === 0 && k < 39 ? { src: 101 + k } : j === 0 ? { src: 900, t: "footage" } : {}),
        ...(j % 5 === 1 ? { ex: [opacity(`L${k}_${j + 1}`)] } : {}),
        ...(j === 7 && k % 10 === 0 ? { shy: 1 as const, fx: [{ m: "ADBE Glo2", n: "Glow" }] } : {}),
      }),
    );
    comps.push(comp(100 + k, `Comp_${k}`, layers, k ? [99 + k] : []));
  }
  return data("Big_Show.aep", comps, [file(900, "plate_missing.mov", [139], { missing: true })], [{ comp: 100, status: "QUEUED", render: true, file: "/out/Big_Show.mov" }]);
}

/**
 * Wide rather than deep: one comp rendered, `scenes` precomps under it, each with `per` stills of its own (a
 * slideshow template), every third one missing. Long names, as real projects have.
 */
export function wideProject(scenes: number, per: number): XData {
  const comps: XComp[] = [], footage: XFootage[] = [];
  for (let s = 0; s < scenes; s++) {
    const ids = Array.from({ length: per }, (_, j) => 10_000 + s * per + j);
    comps.push(comp(100 + s, `Scene_${String(s).padStart(3, "0")}_Product_Highlight_Slide`, ids.map((id, j) => L(j + 1, `IMG_${id}.jpg`, { src: id, t: "footage" })), [1]));
    for (const [j, id] of ids.entries())
      footage.push(file(id, `IMG_${id}_from_the_shoot_final_retouched.jpg`, [100 + s], { still: true, video: false, fps: undefined, ...(j % 3 === 0 ? { missing: true } : {}) }));
  }
  comps.unshift(comp(1, "Main", Array.from({ length: scenes }, (_, s) => L(s + 1, `Scene ${s}`, { src: 100 + s }))));
  return data("Slideshow.aep", comps, footage, [{ comp: 1, status: "QUEUED", render: true, file: "/out/Slideshow.mov" }]);
}

/** Nothing in the render queue: the top-level comps are the roots. */
export function emptyQueueProject(): XData {
  const d = mockupProject();
  return { ...d, rq: [] };
}

/** No problems at all. */
export function cleanProject(): XData {
  return data("Clean.aep", [comp(1, "Main", [L(1, "Pre", { src: 2 }), L(2, "Title", { t: "text" })]), comp(2, "Pre", [L(1, "Shape")], [1])], [], [{ comp: 1, status: "QUEUED", render: true, file: "/out/Main.mov" }]);
}
