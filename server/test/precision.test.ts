// Precision tools (keyframe tables, easing, retiming, measured layout), run on the real helper library and tool code
// against a fake After Effects with a faithful keyframe model (test/fake-keys.ts).
import { describe, expect, it } from "vitest";
import { ALL_JSX_TOOLS } from "../src/tools/all.js";
import { arcLength, auditEasing, normalisedCurve, segments, type PropRows } from "../src/tools/easing.js";
import { fakeKeysAE, KeyframeEase, KIT } from "./fake-keys.js";

const tool = (n: string) => ALL_JSX_TOOLS.find((t) => t.name === n)!;
const jsx = (n: string) => tool(n).jsx;

/** a comp at 25 fps with "A" (Opacity keys at frames 0 and 25) and "B" (Position keys at frames 0 and 50) */
function animated(fps = 25) {
  const ae = fakeKeysAE({ fps, layers: [{ name: "A" }, { name: "B" }] });
  const fd = 1 / fps;
  const op = ae.prop("A", "ADBE Opacity");
  op.setValueAtTime(0, 0);
  op.setValueAtTime(25 * fd, 100);
  op.setInterpolationTypeAtKey(1, KIT.BEZIER, KIT.BEZIER);
  op.setInterpolationTypeAtKey(2, KIT.BEZIER, KIT.BEZIER);
  op.setTemporalEaseAtKey(1, [new KeyframeEase(0, 75)], [new KeyframeEase(0, 75)]);
  op.setTemporalEaseAtKey(2, [new KeyframeEase(0, 33.333333)], [new KeyframeEase(0, 33.333333)]);
  const pos = ae.prop("B", "ADBE Position");
  pos.setValueAtTime(0, [100, 540, 0]);
  pos.setValueAtTime(50 * fd, [1100, 540, 0]);
  return { ae, op, pos, fd };
}

describe("easing math", () => {
  it("normalises AE's speed/influence to cubic-bezier numbers", () => {
    // 1 s, 0 -> 100: 75% out influence at speed 0, 33.33% in influence at speed 0 (ease in and out)
    expect(normalisedCurve(1, 100, { speed: 0, influence: 75 }, { speed: 0, influence: 33.333333 })).toEqual([0.75, 0, 0.6667, 1]);
    // linear: AE stores speed = distance / duration with 16.67% influence: the handles lie on the straight line
    const c = normalisedCurve(2, 100, { speed: 50, influence: 16.666667 }, { speed: 50, influence: 16.666667 })!;
    expect(c[1]).toBeCloseTo(c[0], 4);
    expect(c[3]).toBeCloseTo(c[2], 4);
    expect(normalisedCurve(1, 0, { speed: 0, influence: 50 }, { speed: 0, influence: 50 })).toBeNull();
  });
  it("arc length of a spatial path follows the tangents", () => {
    expect(arcLength([0, 0], [300, 400])).toBeCloseTo(500, 6);
    expect(arcLength([0, 0], [100, 0], [0, 100], [0, 100])).toBeGreaterThan(150);
  });
  it("segments: hold, static and per-dimension curves", () => {
    const p: PropRows = {
      layer: 1, layerName: "L", path: "x", name: "Scale", matchName: "ADBE Scale", keys: [
        { index: 1, frame: 0, time: 0, value: [100, 100, 100], outInterpolation: "bezier", easeOut: [{ speed: 0, influence: 50 }, { speed: 0, influence: 50 }, { speed: 0, influence: 50 }] },
        { index: 2, frame: 25, time: 1, value: [200, 100, 100], inInterpolation: "bezier", outInterpolation: "hold", easeIn: [{ speed: 0, influence: 50 }, { speed: 0, influence: 50 }, { speed: 0, influence: 50 }], easeOut: [] },
        { index: 3, frame: 50, time: 2, value: [50, 50, 100], easeIn: [] },
      ],
    };
    const s = segments(p);
    expect(s[0].curves).toEqual([[0.5, 0, 0.5, 1]]); // only X moves
    expect(s[1].kind).toBe("hold");
  });
});

describe("ae_get_keyframes", () => {
  it("reads every key as whole frames and exact seconds, with ease exactly as stored", () => {
    const { ae } = animated();
    const r = ae.run(jsx("ae_get_keyframes"), {});
    expect(r.ok).toBe(true);
    const [a, b] = r.result.properties;
    expect(a).toMatchObject({ layer: 1, layerName: "A", path: "ADBE Transform Group/ADBE Opacity", matchName: "ADBE Opacity", easeDimensions: 1 });
    expect(a.keys.map((k: any) => k.frame)).toEqual([0, 25]);
    expect(a.keys[1].time).toBe(1);
    expect(a.keys[1].easeIn).toEqual([{ speed: 0, influence: 33.333333 }]); // not rounded
    expect(a.keys[0].inInterpolation).toBe("bezier");
    expect(b.spatial).toBe(true);
    expect(b.keys[0].inSpatialTangent).toEqual([0, 0, 0]);
    expect(r.result.offFrameKeys).toBeUndefined();
  });
  it("flags keys between frames instead of rounding them silently", () => {
    const { ae, op } = animated();
    op.setValueAtTime(0.5 + 0.01, 50); // frame 12.75
    const r = ae.run(jsx("ae_get_keyframes"), { layers: ["A"] });
    const k = r.result.properties[0].keys[1];
    expect(k.frame).toBe(13);
    expect(k.offFrame).toBeCloseTo(-0.25, 4);
    expect(r.result.offFrameKeys).toBe(1);
  });
  it("paths that come back resolve again; frame ranges; curves", () => {
    const { ae } = animated();
    const r = ae.run(jsx("ae_get_keyframes"), { paths: ["ADBE Transform Group/ADBE Opacity"], layers: ["A"], endFrame: 10 });
    expect(r.result.properties[0].keys.length).toBe(1);
    const full = ae.run(jsx("ae_get_keyframes"), { layers: ["A"] });
    const text = JSON.parse(tool("ae_get_keyframes").format!(full.result, { curves: true }));
    expect(text.properties[0].segments[0].curves).toEqual([[0.75, 0, 0.6667, 1]]);
  });
});

describe("ae_set_keyframe_table", () => {
  it("writes keys at frames with exact per-side ease and returns the table", () => {
    const { ae, fd } = animated();
    const r = ae.run(jsx("ae_set_keyframe_table"), {
      properties: [
        { layer: "A", path: "Transform/Rotation", keys: [{ frame: 0, value: 0, interpolation: "bezier", easeOut: { speed: 12.5, influence: 80 } }, { frame: 12, value: 90, easeIn: [{ speed: 0, influence: 100 }], label: 3 }] },
        { layer: "B", path: "ADBE Transform Group/ADBE Position", keys: [{ frame: 50, outSpatialTangent: [10, 0] }] },
      ],
    });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    const rot = ae.prop("A", "ADBE Rotate Z");
    expect(rot.keyTime(2)).toBeCloseTo(12 * fd, 12);
    expect(rot.keyOutTemporalEase(1)[0]).toEqual(new KeyframeEase(12.5, 80));
    expect(rot.keyInTemporalEase(2)[0].influence).toBe(100);
    expect(rot.keyLabel(2)).toBe(3);
    expect(ae.prop("B", "ADBE Position").keyOutSpatialTangent(2)).toEqual([10, 0, 0]); // padded to Position's 3 values
    expect(r.result.properties[0].keys.map((k: any) => k.frame)).toEqual([0, 12]);
  });
  it("round-trips a table read with ae_get_keyframes", () => {
    const { ae } = animated();
    const before = ae.run(jsx("ae_get_keyframes"), {}).result.properties;
    const w = ae.run(jsx("ae_set_keyframe_table"), { properties: before.map((p: any) => ({ layer: p.layer, path: p.path, replace: true, keys: p.keys })) });
    expect(w.ok, JSON.stringify(w.error)).toBe(true);
    expect(ae.run(jsx("ae_get_keyframes"), {}).result.properties).toEqual(before);
  });
  it("refuses an ease with the wrong dimension count, spatial settings on a non-spatial property, roving on the last key", () => {
    const { ae } = animated();
    const bad = ae.run(jsx("ae_set_keyframe_table"), { properties: [{ layer: "B", path: "Transform/Position", keys: [{ frame: 0, easeOut: [{ speed: 0, influence: 50 }, { speed: 0, influence: 50 }] }] }] });
    expect(bad.ok).toBe(false);
    expect(bad.error.message).toMatch(/takes 1 ease value per key side \(a spatial property/);
    const sp = ae.run(jsx("ae_set_keyframe_table"), { properties: [{ layer: "A", path: "Transform/Opacity", keys: [{ frame: 0, roving: true }] }] });
    expect(sp.error.message).toMatch(/not a spatial property/);
    const rv = ae.run(jsx("ae_set_keyframe_table"), { properties: [{ layer: "B", path: "Transform/Position", keys: [{ frame: 50, roving: true }] }] });
    expect(rv.error.message).toMatch(/first and last keys can't rove/);
    const none = ae.run(jsx("ae_set_keyframe_table"), { properties: [{ layer: "A", path: "Transform/Opacity", keys: [{ frame: 7, easeIn: { speed: 0, influence: 50 } }] }] });
    expect(none.error.message).toMatch(/no keyframe at frame 7/);
    const dup = ae.run(jsx("ae_set_keyframe_table"), { properties: [{ layer: "A", path: "Transform/Opacity", keys: [{ frame: 3, value: 1 }, { time: 0.12, value: 2 }] }] });
    expect(dup.error.message).toMatch(/two keys at the same time/);
    expect(ae.prop("A", "ADBE Opacity").numKeys).toBe(2); // the failed calls changed nothing there
  });
});

describe("ae_copy_ease", () => {
  it("copies per dimension, replicates a 1-ease reference, and needs sourceDimension the other way", () => {
    const { ae } = animated();
    const scale = ae.prop("B", "ADBE Scale");
    scale.setValueAtTime(0, [100, 100, 100]);
    scale.setValueAtTime(1, [200, 200, 100]);
    const r = ae.run(jsx("ae_copy_ease"), { from: { layer: "A", path: "Transform/Opacity", frame: 0 }, to: [{ layer: "B", path: "Transform/Scale" }], speed: "zero" });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(scale.keyOutTemporalEase(1).map((e: any) => e.influence)).toEqual([75, 75, 75]);
    expect(r.result.targets[0].keys[0].before.easeOut[0].influence).toBeCloseTo(16.666667, 5);
    scale.setTemporalEaseAtKey(2, [new KeyframeEase(1, 10), new KeyframeEase(2, 20), new KeyframeEase(3, 30)]);
    const back = ae.run(jsx("ae_copy_ease"), { from: { layer: "B", path: "Transform/Scale", key: 2 }, to: [{ layer: "A", path: "Transform/Opacity", keys: [2] }] });
    expect(back.error.message).toMatch(/pass sourceDimension/);
    const ok = ae.run(jsx("ae_copy_ease"), { from: { layer: "B", path: "Transform/Scale", key: 2 }, to: [{ layer: "A", path: "Transform/Opacity", keys: [2] }], sourceDimension: 1, which: "in" });
    expect(ok.ok).toBe(true);
    const op = ae.prop("A", "ADBE Opacity");
    expect(op.keyInTemporalEase(2)[0]).toEqual(new KeyframeEase(2, 20));
    expect(op.keyOutTemporalEase(2)[0].influence).toBe(33.333333); // "in" only
  });
  it("speed keep copies only the influence; spatial needs spatial properties", () => {
    const { ae, op } = animated();
    op.setTemporalEaseAtKey(2, [new KeyframeEase(-40, 33.333333)], [new KeyframeEase(-40, 33.333333)]);
    const r = ae.run(jsx("ae_copy_ease"), { from: { layer: "A", path: "Transform/Opacity", key: 1 }, to: [{ layer: "A", path: "Transform/Opacity", keys: [2] }], speed: "keep" });
    expect(r.ok).toBe(true);
    expect(op.keyInTemporalEase(2)[0]).toEqual(new KeyframeEase(-40, 75));
    const s = ae.run(jsx("ae_copy_ease"), { from: { layer: "B", path: "Transform/Position", key: 1 }, to: [{ layer: "A", path: "Transform/Opacity" }], spatial: true });
    expect(s.error.message).toMatch(/not a spatial property/);
  });
});

describe("ae_audit_easing", () => {
  it("finds the comp's own norms and the segments that match none", () => {
    const layers = ["L1", "L2", "L3", "L4", "Odd"].map((name) => ({ name }));
    const ae = fakeKeysAE({ layers });
    for (const name of ["L1", "L2", "L3", "L4", "Odd"]) {
      const p = ae.prop(name, "ADBE Opacity");
      p.setValueAtTime(0, 0);
      p.setValueAtTime(1, 100);
      const inf = name === "Odd" ? 10 : 80;
      p.setTemporalEaseAtKey(1, [new KeyframeEase(0, inf)], [new KeyframeEase(0, inf)]);
      p.setTemporalEaseAtKey(2, [new KeyframeEase(0, inf)], [new KeyframeEase(0, inf)]);
    }
    const r = ae.run(jsx("ae_audit_easing"), {});
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    const a = JSON.parse(tool("ae_audit_easing").format!(r.result, {}));
    expect(a.norms[0]).toMatchObject({ curve: "cubic-bezier(0.8, 0, 0.2, 1)", count: 4 });
    expect(a.outliers).toHaveLength(1);
    expect(a.outliers[0]).toMatchObject({ layerName: "Odd", frames: "0-25", nearestNorm: "cubic-bezier(0.8, 0, 0.2, 1)", out: [{ speed: 0, influence: 10 }] });
  });
  it("auditEasing counts holds and linear segments", () => {
    const k = (i: number, t: number, v: number, o: string, sp = 100) => ({ index: i, frame: t * 25, time: t, value: v, inInterpolation: "linear", outInterpolation: o, easeIn: [{ speed: sp, influence: 16.67 }], easeOut: [{ speed: sp, influence: 16.67 }] });
    const p: PropRows = { layer: 1, layerName: "x", path: "p", name: "Opacity", matchName: "ADBE Opacity", keys: [k(1, 0, 0, "linear"), k(2, 1, 100, "hold"), k(3, 2, 0, "linear")] };
    const a = auditEasing([p]);
    expect(a).toMatchObject({ holdSegments: 1, linearSegments: 1, eased: 1 });
  });
});

describe("ae_retime_keyframes", () => {
  it("scale x2 around the first key keeps each curve's shape (speeds halved) and lands on whole frames", () => {
    const { ae, op, fd } = animated();
    op.setTemporalEaseAtKey(1, [new KeyframeEase(10, 75)], [new KeyframeEase(10, 75)]);
    const r = ae.run(jsx("ae_retime_keyframes"), { mode: "scale", factor: 2, layers: ["A"] });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(op.keyTime(2)).toBeCloseTo(50 * fd, 12);
    expect(op.keyOutTemporalEase(1)[0].speed).toBeCloseTo(5, 12);
    expect(op.keyOutTemporalEase(1)[0].influence).toBe(75);
    expect(op.keyValue(2)).toBe(100);
    expect(r.result).toMatchObject({ factor: 2, anchorFrame: 0 });
  });
  it("durationFrames around the last key, rounding reported", () => {
    const { ae, op } = animated();
    const r = ae.run(jsx("ae_retime_keyframes"), { mode: "scale", durationFrames: 10, anchor: "last", layers: ["A"] });
    expect(r.ok).toBe(true);
    expect(op.keyTime(1) * 25).toBeCloseTo(15, 9);
    const odd = ae.run(jsx("ae_retime_keyframes"), { mode: "scale", factor: 1.05, layers: ["A"] });
    expect(odd.result.rounded.keys).toBe(1);
  });
  it("refuses keys landing on the same frame, before changing anything", () => {
    const { ae, op } = animated();
    op.setValueAtTime(1 / 25, 5);
    const r = ae.run(jsx("ae_retime_keyframes"), { mode: "scale", factor: 0.1, layers: ["A"] });
    expect(r.ok).toBe(false);
    expect(r.error.message).toMatch(/same frame.*Nothing was changed/);
    expect(op.numKeys).toBe(3);
    expect(op.keyTime(3)).toBe(1);
  });
  it("stagger: layer i moves i x N frames in the given order; offset; layers mode", () => {
    const { ae, op, pos, fd } = animated();
    const r = ae.run(jsx("ae_retime_keyframes"), { mode: "stagger", frames: 3, layers: ["B", "A"] });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(pos.keyTime(1)).toBe(0);
    expect(op.keyTime(1)).toBeCloseTo(3 * fd, 12);
    ae.run(jsx("ae_retime_keyframes"), { mode: "offset", frames: -3, layers: ["A"] });
    expect(op.keyTime(1)).toBeCloseTo(0, 12);
    const m = ae.run(jsx("ae_retime_keyframes"), { mode: "stagger", frames: 2, move: "layers", order: "reverse" });
    expect(m.result.layers).toEqual([{ layer: 1, name: "A", shiftFrames: 2, startFrame: 2 }]);
  });
  it("conform 25 -> 30 fps: keys and layer timing on whole frames of the new rate", () => {
    const { ae, op } = animated();
    op.setValueAtTime(0.2, 50); // frame 5 at 25 fps = frame 6 at 30 fps
    const lay = ae.comp.layer("A");
    lay.startTime = 0.04; // frame 1 at 25 fps -> 1.2 frames at 30 fps
    const r = ae.run(jsx("ae_retime_keyframes"), { mode: "conform", frameRate: 30 });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(ae.comp.frameRate).toBe(30);
    expect(op.keyTime(2) * 30).toBeCloseTo(6, 9);
    expect(lay.startTime * 30).toBeCloseTo(1, 9);
    expect(r.result.layersSnapped).toContain("A");
  });
});

describe("ae_align_layers (measured bounds)", () => {
  it("aligns left edges of the measured boxes, through scale and parenting", () => {
    const ae = fakeKeysAE({
      layers: [
        { name: "Title", type: "text", rect: [0, -50, 400, 60], position: [300, 200] },
        { name: "Null", type: "null", position: [1000, 500], scale: [50, 50] },
        { name: "Child", rect: [0, 0, 200, 100], anchor: [100, 50], position: [400, 0], parent: "Null" },
      ],
    });
    const r = ae.run(jsx("ae_align_layers"), { layers: ["Title", "Child"], align: "left" });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(r.result.maxResidualPx).toBe(0);
    const after = r.result.after;
    // only the child had to move (the title's box already starts at 300)
    expect(after.map((a: any) => [a.name, a.left])).toEqual([["Child", 300]]);
    expect(r.result.moves.map((m: any) => m.name)).toEqual(["Child"]);
    // the child's box was at 1000 + (400-100)*0.5 = 1150; moving it 850 px left on screen is 1700 in the parent's (50%) space
    expect(ae.prop("Child", "ADBE Position").value[0]).toBeCloseTo(400 - 1700, 9);
    // text layers aren't AVLayers, and they still align
    expect(ae.prop("Title", "ADBE Position").value[0]).toBe(300);
  });
  it("centres in the comp, distributes with equal gaps, moves every key of keyframed Position", () => {
    const ae = fakeKeysAE({
      layers: [
        { name: "a", rect: [0, 0, 100, 100], position: [0, 0] },
        { name: "b", rect: [0, 0, 300, 100], position: [150, 0] },
        { name: "c", rect: [0, 0, 100, 100], position: [900, 0] },
      ],
    });
    const pb = ae.prop("b", "ADBE Position");
    pb.setValueAtTime(0, [150, 0, 0]);
    pb.setValueAtTime(1, [150, 300, 0]);
    const d = ae.run(jsx("ae_align_layers"), { layers: ["a", "b", "c"], distribute: "horizontal" });
    expect(d.ok, JSON.stringify(d.error)).toBe(true);
    // span 0..1000, boxes 500 wide in total: two gaps of 250 -> b starts at 350
    expect(pb.keyValue(1)).toEqual([350, 0, 0]);
    expect(pb.keyValue(2)).toEqual([350, 300, 0]);
    const c = ae.run(jsx("ae_align_layers"), { layers: ["c"], align: "center" });
    expect(c.result.to).toBe("comp");
    expect(ae.prop("c", "ADBE Position").value).toEqual([910, 490, 0]);
  });
  it("leaves 3D, locked and expression-driven layers alone and says why; dry run moves nothing", () => {
    const ae = fakeKeysAE({
      layers: [
        { name: "flat", position: [0, 0] },
        { name: "deep", position: [500, 0], threeD: true },
        { name: "locked", position: [700, 0], locked: true },
        { name: "expr", position: [900, 0], positionExpression: "wiggle(1,1)" },
        { name: "sep", position: [1100, 0], separated: true },
      ],
    });
    const r = ae.run(jsx("ae_align_layers"), { layers: ["flat", "deep", "locked", "expr", "sep"], align: "top", to: { y: 100 } });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(r.result.notMoved.map((n: any) => [n.name, n.why])).toEqual([
      ["deep", expect.stringMatching(/3D/)],
      ["locked", "locked"],
      ["expr", "Position has an expression"],
    ]);
    expect(ae.prop("flat", "ADBE Position").value).toEqual([0, 100, 0]);
    expect(ae.prop("sep", "ADBE Position_1").value).toBe(100);
    const dry = ae.run(jsx("ae_align_layers"), { layers: ["flat"], align: "left", to: { x: 50 }, dryRun: true });
    expect(dry.result.moves[0].moveX).toBe(50);
    expect(ae.prop("flat", "ADBE Position").value).toEqual([0, 100, 0]);
    const clash = ae.run(jsx("ae_align_layers"), { layers: ["flat", "sep"], align: "left", distribute: "horizontal" });
    expect(clash.error.message).toMatch(/same axis/);
  });
});

describe("existing tools: shared bounds, frames", () => {
  it("ae_get_layer_bounds still measures through the shared code, at a frame", () => {
    const ae = fakeKeysAE({ layers: [{ name: "a", rect: [0, 0, 100, 50], position: [10, 20], rotation: 90 }, { name: "cam", type: "camera" }] });
    const r = ae.run(jsx("ae_get_layer_bounds"), { frame: 5 });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(r.result.frame).toBe(5);
    expect(r.result.layers[0].bounds).toMatchObject({ left: -40, top: 20, width: 50, height: 100 });
    expect(r.result.layers[1]).toMatchObject({ bounds: null, note: "cameras and lights have no bounds" });
  });
  it("ae_set_keyframes takes frames and per-dimension ease; ae_edit/remove_keyframes take frames", () => {
    const ae = fakeKeysAE({ layers: [{ name: "a" }] });
    const r = ae.run(jsx("ae_set_keyframes"), { layer: "a", path: "Transform/Scale", keyframes: [{ frame: 0, value: [100, 100, 100] }, { frame: 10, value: [50, 50, 100], easeIn: [{ speed: 0, influence: 90 }, { speed: 1, influence: 50 }, { speed: 0, influence: 33 }] }] });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    const s = ae.prop("a", "ADBE Scale");
    expect(s.keyTime(2)).toBeCloseTo(0.4, 12);
    expect(s.keyInTemporalEase(2).map((e: any) => e.influence)).toEqual([90, 50, 33]);
    const bad = ae.run(jsx("ae_set_keyframes"), { layer: "a", path: "Transform/Opacity", keyframes: [{ value: 3 }] });
    expect(bad.error.message).toMatch(/needs time \(seconds\) or frame/);
    const e = ae.run(jsx("ae_edit_keyframes"), { layer: "a", path: "Transform/Scale", keys: [{ frame: 10, moveToFrame: 20 }] });
    expect(e.ok, JSON.stringify(e.error)).toBe(true);
    expect(s.keyTime(2)).toBeCloseTo(0.8, 12);
    const rm = ae.run(jsx("ae_remove_keyframes"), { layer: "a", path: "Transform/Scale", frames: [20] });
    expect(rm.result).toEqual({ removed: 1, remaining: 1 });
  });
});

describe("eases After Effects reports with influence 0 (seen live in AE 26.5)", () => {
  // a key switched to Bezier without an explicit ease reads back speed 0, influence 0, which `new KeyframeEase`
  // refuses ("Value 0 out of range 0.1 to 100"): copying, retiming and conforming such keys must still work
  function unsetBezier() {
    const ae = fakeKeysAE({ fps: 25, layers: [{ name: "A" }, { name: "B" }] });
    const op = ae.prop("A", "ADBE Opacity");
    op.setValueAtTime(0, 0);
    op.setValueAtTime(1, 100);
    op.setInterpolationTypeAtKey(1, KIT.BEZIER, KIT.BEZIER);
    op.setInterpolationTypeAtKey(2, KIT.BEZIER, KIT.BEZIER);
    const sc = ae.prop("B", "ADBE Scale");
    sc.setValueAtTime(0, [100, 100, 100]);
    sc.setValueAtTime(1, [200, 200, 100]);
    return { ae, op, sc };
  }
  it("the fake reports them like After Effects", () => {
    const { op } = unsetBezier();
    expect(op.keyInTemporalEase(1)[0]).toMatchObject({ speed: 0, influence: 0 });
    expect(() => new KeyframeEase(0, 0)).toThrow(/out of range 0.1 to 100/);
  });
  it("ae_copy_ease from such a key writes influence 0.1", () => {
    const { ae, sc } = unsetBezier();
    const r = ae.run(jsx("ae_copy_ease"), { from: { layer: "A", path: "Transform/Opacity", frame: 0 }, to: [{ layer: "B", path: "Transform/Scale" }], speed: "zero" });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(sc.keyInTemporalEase(1).map((e: any) => e.influence)).toEqual([0.1, 0.1, 0.1]);
  });
  it("ae_retime_keyframes scale and conform work on them", () => {
    const { ae, op } = unsetBezier();
    const s = ae.run(jsx("ae_retime_keyframes"), { mode: "scale", factor: 2, layers: ["A"] });
    expect(s.ok, JSON.stringify(s.error)).toBe(true);
    expect(Math.round(op.keyTime(2) * 25)).toBe(50);
    const c = ae.run(jsx("ae_retime_keyframes"), { mode: "conform", frameRate: 30 });
    expect(c.ok, JSON.stringify(c.error)).toBe(true);
  });
  it("a table read back from After Effects (influence 0) can be written again", () => {
    const { ae } = unsetBezier();
    const read = ae.run(jsx("ae_get_keyframes"), { layers: ["A"] });
    expect(read.ok, JSON.stringify(read.error)).toBe(true);
    const keys = read.result.properties[0].keys.map((k: any) => ({ frame: k.frame, value: k.value, easeIn: k.easeIn, easeOut: k.easeOut }));
    const w = ae.run(jsx("ae_set_keyframe_table"), { properties: [{ layer: "A", path: read.result.properties[0].path, keys }] });
    expect(w.ok, JSON.stringify(w.error)).toBe(true);
  });
});
