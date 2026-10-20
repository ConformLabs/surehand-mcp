// The views' frame stills: the baseline JPEG encoder (decoded back by ffmpeg when it's installed) and downscaling.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { downscale, encodeJpeg, HUFFMAN_TABLES, ZIGZAG } from "../src/jpeg.js";
import { findFfmpeg } from "../src/preflight/ffmpeg.js";

/** an odd-sized test picture: two gradients and a checkerboard */
function picture(w: number, h: number) {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      px[p] = Math.round((x * 255) / w);
      px[p + 1] = Math.round((y * 255) / h);
      px[p + 2] = ((x >> 4) + (y >> 4)) % 2 ? 220 : 30;
      px[p + 3] = 255;
    }
  return px;
}

describe("JPEG encoder", () => {
  it("has a complete zigzag order and Huffman tables", () => {
    expect(new Set(ZIGZAG).size).toBe(64);
    expect(ZIGZAG.slice(0, 6)).toEqual([0, 1, 8, 16, 9, 2]);
    for (const t of Object.values(HUFFMAN_TABLES)) expect(t.bits.reduce((a, b) => a + b, 0)).toBe(t.vals.length);
    // every AC symbol: end of block, 16 zeros, and run/size 0-15 / 1-10
    const ac = [0x00, 0xf0, ...Array.from({ length: 160 }, (_, i) => ((i / 10) | 0) * 16 + (i % 10) + 1)].sort();
    expect([...HUFFMAN_TABLES.AC_LUMA.vals].sort()).toEqual(ac);
    expect([...HUFFMAN_TABLES.AC_CHROMA.vals].sort()).toEqual(ac);
  });

  it("writes a small baseline JFIF file", () => {
    const j = encodeJpeg(483, 271, picture(483, 271), 80);
    expect([...j.subarray(0, 4)]).toEqual([0xff, 0xd8, 0xff, 0xe0]);
    expect([...j.subarray(-2)]).toEqual([0xff, 0xd9]);
    expect(j.length).toBeLessThan(40_000);
  });

  const ff = findFfmpeg();
  it.skipIf(!ff)("decodes (ffmpeg) to the picture it was made from", () => {
    const dir = mkdtempSync(join(tmpdir(), "surehand-jpeg-"));
    try {
      const w = 483, h = 271, src = picture(w, h);
      writeFileSync(join(dir, "a.jpg"), encodeJpeg(w, h, src, 90));
      const r = spawnSync(ff!.ffmpeg, ["-v", "error", "-i", join(dir, "a.jpg"), "-f", "rawvideo", "-pix_fmt", "rgb24", join(dir, "a.rgb")]);
      expect(r.status).toBe(0);
      const back = readFileSync(join(dir, "a.rgb"));
      expect(back.length).toBe(w * h * 3);
      let err = 0;
      for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) err += Math.abs(back[i * 3 + c] - src[i * 4 + c]);
      expect(err / (w * h * 3)).toBeLessThan(4); // mean error per sample, out of 255
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("downscale", () => {
  it("averages areas, composites alpha over black, and reads 16-bit", () => {
    const img = { width: 4, height: 2, max: 255, data: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255, 0, 255, 0, 255, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 255, 0, 255, 0, 255, 0, 255, 0, 0]) };
    expect([...downscale(img, 2, 1)]).toEqual([128, 0, 128, 255, 0, 128, 0, 255]);
    const deep = { width: 1, height: 1, max: 65535, data: new Uint16Array([65535, 32768, 0, 65535]) };
    expect([...downscale(deep, 1, 1)]).toEqual([255, 128, 0, 255]);
  });
});
