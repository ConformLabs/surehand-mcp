import { describe, expect, it } from "vitest";
import { decodePng, encodePng, type Image } from "../src/png.js";
import { diffImages, diffPicture } from "../src/tools/prove.js";

/** deterministic pseudo-random samples */
function samples(n: number, max: number, seed = 1) {
  const out = max > 255 ? new Uint16Array(n) : new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = s % (max + 1);
  }
  return out;
}

/** samples with `channels` per pixel expanded to RGBA, as decodePng returns them */
function rgba(src: Uint8Array | Uint16Array, channels: number, max: number) {
  const n = src.length / channels, out = max > 255 ? new Uint16Array(n * 4) : new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const s = i * channels;
    if (channels <= 2) {
      out.fill(src[s], i * 4, i * 4 + 3);
      out[i * 4 + 3] = channels === 2 ? src[s + 1] : max;
    } else {
      out.set(src.subarray(s, s + 3), i * 4);
      out[i * 4 + 3] = channels === 4 ? src[s + 3] : max;
    }
  }
  return out;
}

const img = (width: number, height: number, data: number[] | Uint8Array, max = 255): Image => ({ width, height, max, data: max > 255 ? new Uint16Array(data) : new Uint8Array(data) });

describe("PNG decoder and encoder", () => {
  for (const channels of [1, 2, 3, 4])
    for (const max of [255, 65535])
      for (const filter of [0, 1, 2, 3, 4])
        it(`round-trips ${channels} channel(s), ${max > 255 ? 16 : 8}-bit, filter ${filter}`, () => {
          const w = 7, h = 5, src = samples(w * h * channels, max, channels * 31 + filter);
          const out = decodePng(encodePng(w, h, src, channels, filter));
          expect([out.width, out.height, out.max]).toEqual([w, h, max]);
          expect(Array.from(out.data)).toEqual(Array.from(rgba(src, channels, max)));
        });

  it("decodes a file whose image data is split over several IDAT chunks", () => {
    const src = samples(20 * 10 * 4, 255);
    const png = encodePng(20, 10, src, 4, 4);
    // split the one IDAT chunk into two (the decoder concatenates them; CRCs are not checked)
    const idatAt = png.indexOf("IDAT") - 4, len = png.readUInt32BE(idatAt), body = png.subarray(idatAt + 8, idatAt + 8 + len);
    const chunk = (b: Buffer) => {
      const c = Buffer.alloc(12 + b.length);
      c.writeUInt32BE(b.length, 0);
      c.write("IDAT", 4, "latin1");
      b.copy(c, 8);
      return c;
    };
    const half = Math.floor(len / 2);
    const split = Buffer.concat([png.subarray(0, idatAt), chunk(body.subarray(0, half)), chunk(body.subarray(half)), png.subarray(idatAt + 12 + len)]);
    expect(Array.from(decodePng(split).data)).toEqual(Array.from(src));
  });

  it("fails clearly on what it can't read", () => {
    const png = encodePng(2, 2, new Uint8Array(12), 3);
    const palette = Buffer.from(png);
    palette[25] = 3; // IHDR color type
    expect(() => decodePng(palette)).toThrow(/Unsupported PNG format \(color type 3/);
    const interlaced = Buffer.from(png);
    interlaced[28] = 1;
    expect(() => decodePng(interlaced)).toThrow(/interlaced/);
    expect(() => decodePng(Buffer.from("GIF89a..."))).toThrow(/Not a PNG/);
    expect(() => decodePng(png.subarray(0, 33))).toThrow(/Truncated/);
  });

  it("writes a valid CRC (checked against a known PNG header)", () => {
    const png = encodePng(1, 1, new Uint8Array([255, 0, 0]), 3);
    // the IHDR CRC of a 1x1 8-bit RGB image is 0x907753de
    expect(png.readUInt32BE(8 + 8 + 13)).toBe(0x907753de);
  });
});

describe("image differences", () => {
  const black = () => img(4, 2, new Array(32).fill(0).map((_, i) => (i % 4 === 3 ? 255 : 0)));

  it("identical images", () => {
    expect(diffImages(black(), black())).toEqual({ maxDiff: 0, changed: 0, over: 0, total: 8, maxDeltaE: 0, box: null });
  });

  it("one channel off by 1: differs at tolerance 0, within tolerance 1", () => {
    const b = black();
    b.data[(1 * 4 + 2) * 4 + 1] = 1; // pixel x 2, y 1, green
    const d = diffImages(black(), b);
    expect(d).toMatchObject({ maxDiff: 1, changed: 1, over: 1, box: [2, 1, 1, 1] });
    expect(d.maxDeltaE).toBeGreaterThan(0);
    expect(diffImages(black(), b, 1)).toMatchObject({ maxDiff: 1, changed: 1, over: 0, box: null });
  });

  it("black against white is a ΔE of 100", () => {
    const w = img(1, 1, [255, 255, 255, 255]), k = img(1, 1, [0, 0, 0, 255]);
    const d = diffImages(k, w);
    expect(d.maxDiff).toBe(255);
    expect(d.maxDeltaE).toBeCloseTo(100, 1);
  });

  it("alpha counts, but color under full transparency does not", () => {
    expect(diffImages(img(1, 1, [255, 0, 0, 0]), img(1, 1, [0, 0, 255, 0])).changed).toBe(0);
    expect(diffImages(img(1, 1, [0, 0, 0, 0]), img(1, 1, [0, 0, 0, 3])).maxDiff).toBe(3);
  });

  it("compares 16-bit with 8-bit on the same 0-255 scale", () => {
    const a = img(1, 1, [10, 20, 30, 255]), b = img(1, 1, [10 * 257, 20 * 257, 31 * 257, 65535], 65535);
    expect(diffImages(a, b)).toMatchObject({ maxDiff: 1, changed: 1 });
  });

  it("bounding box spans all pixels beyond the tolerance", () => {
    const opaque = () => new Uint8Array(400).map((_, i) => (i % 4 === 3 ? 255 : 0));
    const a = img(10, 10, opaque()), b = img(10, 10, opaque());
    b.data[(2 * 10 + 3) * 4] = 50;
    b.data[(7 * 10 + 8) * 4 + 3] = 246;
    b.data[(5 * 10 + 1) * 4] = 1; // within tolerance 1: not in the box
    expect(diffImages(a, b, 1)).toMatchObject({ over: 2, changed: 3, box: [3, 2, 6, 6], maxDiff: 50 });
  });

  it("refuses images of different sizes", () => {
    expect(() => diffImages(img(1, 1, [0, 0, 0, 0]), img(2, 1, [0, 0, 0, 0, 0, 0, 0, 0]))).toThrow(/different sizes/);
  });

  it("the difference picture keeps a single changed pixel visible when it is scaled down", () => {
    const w = 3000, h = 10, opaque = () => new Uint8Array(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : 0));
    const a = img(w, h, opaque()), b = img(w, h, opaque());
    b.data[(5 * w + 2999) * 4] = 1;
    b.data[(0 * w + 0) * 4] = 255;
    const pic = diffPicture(a, b, 0, 1280);
    expect([pic.width, pic.height]).toEqual([1000, 4]);
    const out = decodePng(pic.png);
    const at = (x: number, y: number) => Array.from(out.data.subarray((y * out.width + x) * 4, (y * out.width + x) * 4 + 3));
    expect(at(0, 0)).toEqual([255, 255, 255]); // the largest difference
    expect(at(999, 1)[0]).toBeGreaterThanOrEqual(64); // 1/255, still at least gray
    expect(at(500, 2)).toEqual([0, 0, 0]); // identical
    // within the tolerance: dark blue
    expect(Array.from(decodePng(diffPicture(a, b, 1).png).data.subarray((1 * 1000 + 999) * 4, (1 * 1000 + 999) * 4 + 3))).toEqual([0, 0, 96]);
  });
});
