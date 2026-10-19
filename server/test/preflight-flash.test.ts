import { describe, expect, it } from "vitest";
import { FlashDetector, windows } from "../src/preflight/flash.js";

const W = 8, H = 4, N = W * H;

/** A frame where `fraction` of the cells (from the top-left) have `rgb`, the rest `rest`. */
function frame(rgb: [number, number, number], fraction = 1, rest: [number, number, number] = [0, 0, 0]): Uint8Array {
  const f = new Uint8Array(N * 3);
  const k = Math.round(fraction * N);
  for (let i = 0; i < N; i++) f.set(i < k ? rgb : rest, i * 3);
  return f;
}

function run(frames: Uint8Array[], fps: number, o: Partial<ConstructorParameters<typeof FlashDetector>[0]> = {}) {
  const d = new FlashDetector({ width: W, height: H, fps, ...o });
  for (const f of frames) d.push(f);
  return d.result();
}

const WHITE: [number, number, number] = [255, 255, 255];
const BLACK: [number, number, number] = [0, 0, 0];

describe("flash pre-check", () => {
  it("finds a 10 Hz full-screen black/white flicker", () => {
    const frames = Array.from({ length: 40 }, (_, i) => frame(i % 2 ? WHITE : BLACK)); // 20 fps, 2 s
    const r = run(frames, 20);
    expect(r.general).toHaveLength(1);
    expect(r.general[0].start).toBeCloseTo(0.05, 3);
    expect(r.general[0].maxFlashesPerSecond).toBeGreaterThanOrEqual(9.5);
    expect(r.red).toHaveLength(0);
  });

  it("passes a 2 Hz flicker (4 transitions a second)", () => {
    const frames = Array.from({ length: 60 }, (_, i) => frame(Math.floor(i / 5) % 2 ? WHITE : BLACK)); // 20 fps
    expect(run(frames, 20).general).toEqual([]);
  });

  it("3 flashes a second is allowed, 3.5 is not", () => {
    // transitions every 1/6 s -> 6 per second = 3 flashes: allowed
    const six = Array.from({ length: 60 }, (_, i) => frame(Math.floor(i / 5) % 2 ? WHITE : BLACK)); // 30 fps, toggle every 5 frames
    expect(run(six, 30).general).toEqual([]);
    // every 4 frames at 30 fps: 7.5 transitions per second
    const more = Array.from({ length: 60 }, (_, i) => frame(Math.floor(i / 4) % 2 ? WHITE : BLACK));
    expect(run(more, 30).general.length).toBe(1);
  });

  it("ignores flashing on less than the minimum area", () => {
    const small = Array.from({ length: 40 }, (_, i) => frame(i % 2 ? WHITE : BLACK, 0.2));
    expect(run(small, 20).general).toEqual([]);
    const large = Array.from({ length: 40 }, (_, i) => frame(i % 2 ? WHITE : BLACK, 0.3));
    expect(run(large, 20).general).toHaveLength(1);
    // the area is configurable
    expect(run(small, 20, { minAreaFraction: 0.1 }).general).toHaveLength(1);
  });

  it("ignores changes that are too small or between two bright states", () => {
    // 8-bit 30 <-> 40: luminance 0.013 -> 0.021, change < 0.1
    const dim = Array.from({ length: 40 }, (_, i) => frame(i % 2 ? [40, 40, 40] : [30, 30, 30]));
    expect(run(dim, 20).general).toEqual([]);
    // both states brighter than 0.8 (8-bit 235 = 0.83, 255 = 1): the darker state isn't below 0.8
    const bright = Array.from({ length: 40 }, (_, i) => frame(i % 2 ? WHITE : [235, 235, 235]));
    expect(run(bright, 20).general).toEqual([]);
  });

  it("counts a transition spread over two frames once", () => {
    // black -> grey -> white -> grey -> black ...: 4-frame period at 20 fps = 5 Hz = 10 transitions/s
    const seq = [BLACK, [128, 128, 128], WHITE, [128, 128, 128]] as [number, number, number][];
    const r = run(Array.from({ length: 40 }, (_, i) => frame(seq[i % 4])), 20);
    expect(r.general).toHaveLength(1);
    expect(r.general[0].maxFlashesPerSecond).toBeLessThanOrEqual(5);
  });

  it("finds saturated red flashes with no luminance change", () => {
    // pure red (linear L 0.2126) against a grey of the same luminance: no general flash, but a red flash
    const grey = Math.round(255 * (1.055 * Math.pow(0.2126, 1 / 2.4) - 0.055));
    const frames = Array.from({ length: 40 }, (_, i) => frame(i % 2 ? [255, 0, 0] : [grey, grey, grey]));
    const r = run(frames, 20);
    expect(r.general).toEqual([]);
    expect(r.red).toHaveLength(1);
    expect(run(frames, 20, { redFlash: false }).red).toEqual([]);
  });

  it("does not count a red that isn't saturated", () => {
    // R/(R+G+B) < 0.8 in both states
    const frames = Array.from({ length: 40 }, (_, i) => frame(i % 2 ? [255, 120, 120] : [120, 120, 120]));
    expect(run(frames, 20).red).toEqual([]);
  });

  it("is quiet on a static picture and on a slow fade", () => {
    expect(run(Array.from({ length: 50 }, () => frame(WHITE)), 25).general).toEqual([]);
    const fade = Array.from({ length: 50 }, (_, i) => {
      const v = Math.round((i / 49) * 255);
      return frame([v, v, v]);
    });
    const r = run(fade, 25);
    expect(r.general).toEqual([]);
    expect(r.transitions.general.length).toBe(1);
  });

  it("merges overlapping windows into one run", () => {
    const t = Array.from({ length: 30 }, (_, i) => i * 0.1); // 10 transitions a second for 3 s
    const runs = windows(t, 3);
    expect(runs).toHaveLength(1);
    expect(runs[0].start).toBe(0);
    expect(runs[0].end).toBeCloseTo(2.9);
    expect(runs[0].maxFlashesPerSecond).toBe(5);
    expect(windows([0, 0.1, 0.2, 5, 5.1], 1)).toHaveLength(1);
  });
});
