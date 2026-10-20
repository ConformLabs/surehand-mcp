// A small baseline JPEG encoder (no dependencies), for the in-chat views' frame stills: a 480 px frame is
// about a tenth of its PNG size, and a view's tool result has to stay small. 4:4:4, the standard (Annex K)
// quantization and Huffman tables, a plain separable DCT. Plus downscaling a decoded PNG by area averaging.
import type { Image } from "./png.js";

const LUMA_Q = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const CHROMA_Q = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  ...new Array(32).fill(99),
];

/** ZIGZAG[k] = the natural (row-major) index of the k-th coefficient in zigzag order */
export const ZIGZAG: number[] = (() => {
  const out: number[] = [];
  for (let s = 0; s < 15; s++) {
    const cells: number[] = [];
    for (let y = 0; y < 8; y++) {
      const x = s - y;
      if (x >= 0 && x < 8) cells.push(y * 8 + x);
    }
    // even diagonals run up-right (from the bottom-left), odd ones down-left
    out.push(...(s % 2 === 0 ? cells.reverse() : cells));
  }
  return out;
})();

// Huffman tables: code counts per length (1-16) and the symbols in code order
const DC_LUMA = { bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const DC_CHROMA = { bits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const AC_LUMA = {
  bits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  vals: [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
    0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
    0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
    0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ],
};
const AC_CHROMA = {
  bits: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
  vals: [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
    0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
    0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
    0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
    0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
    0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
    0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ],
};
export const HUFFMAN_TABLES = { DC_LUMA, DC_CHROMA, AC_LUMA, AC_CHROMA };

/** symbol -> [code, length] for a table given as bits / vals (JPEG Annex C) */
function codes(t: { bits: number[]; vals: number[] }): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>();
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < t.bits[len - 1]; i++) out.set(t.vals[k++], [code++, len]);
    code <<= 1;
  }
  return out;
}

function scaledTable(base: number[], quality: number): number[] {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const scale = q < 50 ? 5000 / q : 200 - q * 2;
  return base.map((v) => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))));
}

// cos((2x + 1) u pi / 16), with the 1/sqrt(2) for u = 0 and the 1/2 of the 8-point DCT folded in
const COS = new Float64Array(64);
for (let u = 0; u < 8; u++) for (let x = 0; x < 8; x++) COS[u * 8 + x] = 0.5 * (u ? 1 : Math.SQRT1_2) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);

/** 2D DCT of an 8x8 block (row-major, level-shifted), in place via `tmp` */
function fdct(block: Float64Array, tmp: Float64Array, out: Float64Array) {
  for (let y = 0; y < 8; y++)
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let x = 0; x < 8; x++) s += COS[u * 8 + x] * block[y * 8 + x];
      tmp[y * 8 + u] = s;
    }
  for (let u = 0; u < 8; u++)
    for (let v = 0; v < 8; v++) {
      let s = 0;
      for (let y = 0; y < 8; y++) s += COS[v * 8 + y] * tmp[y * 8 + u];
      out[v * 8 + u] = s;
    }
}

class BitWriter {
  bytes: number[] = [];
  private acc = 0;
  private n = 0;
  write(code: number, len: number) {
    for (let i = len - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((code >> i) & 1);
      if (++this.n === 8) {
        this.bytes.push(this.acc);
        if (this.acc === 0xff) this.bytes.push(0); // byte stuffing
        this.acc = 0;
        this.n = 0;
      }
    }
  }
  /** pad the last byte with 1 bits */
  flush() {
    if (this.n) this.write((1 << (8 - this.n)) - 1, 8 - this.n);
  }
}

/** Bits needed for |v| (the JPEG "category"). */
const category = (v: number) => {
  let a = Math.abs(v), n = 0;
  while (a) {
    n++;
    a >>= 1;
  }
  return n;
};

/**
 * Encode RGB(A) 8-bit pixels as a baseline JPEG. `rgba`: 4 bytes per pixel (alpha ignored: composite it before).
 */
export function encodeJpeg(width: number, height: number, rgba: Uint8Array, quality = 80): Buffer {
  if (rgba.length !== width * height * 4) throw new Error("encodeJpeg: pixel count does not match the size");
  const qY = scaledTable(LUMA_Q, quality), qC = scaledTable(CHROMA_Q, quality);
  const dcY = codes(DC_LUMA), acY = codes(AC_LUMA), dcC = codes(DC_CHROMA), acC = codes(AC_CHROMA);
  const bw = new BitWriter();
  const blk = [new Float64Array(64), new Float64Array(64), new Float64Array(64)];
  const tmp = new Float64Array(64), coef = new Float64Array(64);
  const prevDc = [0, 0, 0];
  const put = (huff: Map<number, [number, number]>, sym: number) => {
    const c = huff.get(sym);
    if (!c) throw new Error(`encodeJpeg: no Huffman code for symbol ${sym}`);
    bw.write(c[0], c[1]);
  };
  const putValue = (v: number, n: number) => bw.write(v < 0 ? v + (1 << n) - 1 : v, n);
  for (let by = 0; by < height; by += 8)
    for (let bx = 0; bx < width; bx += 8) {
      // the block's pixels as Y, Cb, Cr (edge pixels repeated past the image), level-shifted by 128
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          const p = (Math.min(height - 1, by + y) * width + Math.min(width - 1, bx + x)) * 4;
          const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2], i = y * 8 + x;
          blk[0][i] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
          blk[1][i] = -0.168736 * r - 0.331264 * g + 0.5 * b;
          blk[2][i] = 0.5 * r - 0.418688 * g - 0.081312 * b;
        }
      for (let c = 0; c < 3; c++) {
        fdct(blk[c], tmp, coef);
        const q = c ? qC : qY, dc = c ? dcC : dcY, ac = c ? acC : acY;
        const z = ZIGZAG.map((n) => Math.round(coef[n] / q[n]));
        const diff = z[0] - prevDc[c];
        prevDc[c] = z[0];
        const dn = category(diff);
        put(dc, dn);
        if (dn) putValue(diff, dn);
        let run = 0;
        for (let k = 1; k < 64; k++) {
          if (!z[k]) {
            run++;
            continue;
          }
          while (run > 15) {
            put(ac, 0xf0); // 16 zeros
            run -= 16;
          }
          const n = category(z[k]);
          put(ac, (run << 4) | n);
          putValue(z[k], n);
          run = 0;
        }
        if (run) put(ac, 0x00); // end of block
      }
    }
  bw.flush();

  const seg = (marker: number, body: number[]) => [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body];
  const dht = (cls: number, id: number, t: { bits: number[]; vals: number[] }) => [(cls << 4) | id, ...t.bits, ...t.vals];
  const head = [
    0xff, 0xd8, // SOI
    ...seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]), // JFIF 1.01, no density
    ...seg(0xdb, [0, ...ZIGZAG.map((n) => qY[n]), 1, ...ZIGZAG.map((n) => qC[n])]),
    ...seg(0xc0, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]),
    ...seg(0xc4, [...dht(0, 0, DC_LUMA), ...dht(1, 0, AC_LUMA), ...dht(0, 1, DC_CHROMA), ...dht(1, 1, AC_CHROMA)]),
    ...seg(0xda, [3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]),
  ];
  return Buffer.concat([Buffer.from(head), Buffer.from(bw.bytes), Buffer.from([0xff, 0xd9])]);
}

/**
 * The difference of two frames amplified: |a - b| per channel times `gain` (a difference in alpha only shows as
 * gray), 8-bit and opaque; black where they're identical. Pixels transparent in both count as identical.
 */
export function amplifiedDiff(a: Image, b: Image, gain = 50): Image {
  if (a.width !== b.width || a.height !== b.height) throw new Error("The frames have different sizes.");
  const n = a.width * a.height, out = new Uint8Array(n * 4), sa = 255 / a.max, sb = 255 / b.max;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[o + 3] = 255;
    if (a.data[o + 3] === 0 && b.data[o + 3] === 0) continue;
    const da = Math.abs(a.data[o + 3] * sa - b.data[o + 3] * sb);
    for (let c = 0; c < 3; c++) out[o + c] = Math.min(255, Math.round(Math.max(da, Math.abs(a.data[o + c] * sa - b.data[o + c] * sb)) * gain));
  }
  return { width: a.width, height: a.height, max: 255, data: out };
}

/**
 * Downscale a decoded PNG to `width` x `height`, as 8-bit RGBA with the alpha composited over black (how a
 * transparent comp shows in the viewer). "average" for pictures; "max" keeps the largest value of each block
 * (a difference picture: one changed pixel stays visible).
 */
export function downscale(img: Image, width: number, height: number, mode: "average" | "max" = "average"): Uint8Array {
  if (mode === "max") return downscaleMax(img, width, height);
  const out = new Uint8Array(width * height * 4);
  const sx = img.width / width, sy = img.height / height, k = 255 / img.max;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.min(img.height, Math.floor((y + 1) * sy)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.min(img.width, Math.floor((x + 1) * sx)));
      let r = 0, g = 0, b = 0;
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const p = (yy * img.width + xx) * 4, a = img.data[p + 3] / img.max;
          r += img.data[p] * a;
          g += img.data[p + 1] * a;
          b += img.data[p + 2] * a;
        }
      const n = (y1 - y0) * (x1 - x0), o = (y * width + x) * 4;
      out[o] = Math.round((r / n) * k);
      out[o + 1] = Math.round((g / n) * k);
      out[o + 2] = Math.round((b / n) * k);
      out[o + 3] = 255;
    }
  }
  return out;
}

function downscaleMax(img: Image, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const sx = img.width / width, sy = img.height / height, k = 255 / img.max;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.min(img.height, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.min(img.width, Math.ceil((x + 1) * sx)));
      const o = (y * width + x) * 4;
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const p = (yy * img.width + xx) * 4;
          for (let c = 0; c < 3; c++) out[o + c] = Math.max(out[o + c], Math.round(img.data[p + c] * k));
        }
      out[o + 3] = 255;
    }
  }
  return out;
}
