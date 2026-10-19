// A small PNG decoder and encoder (no dependencies), for comparing frames that After Effects rendered.
// Decodes non-interlaced 8- and 16-bit grayscale, gray+alpha, RGB and RGBA (what saveFrameToPng writes)
// to RGBA; anything else (palette, interlaced, other bit depths) fails with a clear message.
import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

export interface Image {
  width: number;
  height: number;
  /** 255 (8-bit) or 65535 (16-bit) */
  max: number;
  /** RGBA, 4 samples per pixel (alpha = max when the file has none) */
  data: Uint8Array | Uint16Array;
}

function paeth(a: number, b: number, c: number) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(buf: Uint8Array): Image {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < 8 || !b.subarray(0, 8).equals(SIGNATURE)) throw new Error("Not a PNG file.");
  let width = 0, height = 0, depth = 0, type = -1, interlace = 0;
  const idat: Buffer[] = [];
  for (let p = 8; p + 8 <= b.length; ) {
    const len = b.readUInt32BE(p), kind = b.toString("latin1", p + 4, p + 8), body = b.subarray(p + 8, p + 8 + len);
    if (kind === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      type = body[9];
      interlace = body[12];
    } else if (kind === "IDAT") idat.push(body);
    else if (kind === "IEND") break;
    p += 12 + len;
  }
  const channels = CHANNELS[type];
  if (!channels || (depth !== 8 && depth !== 16) || interlace !== 0)
    throw new Error(`Unsupported PNG format (color type ${type}, ${depth}-bit${interlace ? ", interlaced" : ""}): only non-interlaced 8/16-bit gray, RGB or RGBA can be compared.`);
  if (!width || !height || !idat.length) throw new Error("Truncated PNG file (no image data).");
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = channels * (depth / 8), stride = width * bpp;
  if (raw.length < height * (stride + 1)) throw new Error("Truncated PNG file (image data is too short).");
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, up = row - stride;
    if (f > 4) throw new Error(`Corrupt PNG file (unknown filter type ${f} on row ${y}).`);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[row + x - bpp] : 0, u = y ? px[up + x] : 0, c = x >= bpp && y ? px[up + x - bpp] : 0;
      const v = raw[src + x];
      px[row + x] = f === 0 ? v : f === 1 ? v + a : f === 2 ? v + u : f === 3 ? v + ((a + u) >> 1) : v + paeth(a, u, c);
    }
  }
  const max = depth === 16 ? 65535 : 255, n = width * height;
  const data = depth === 16 ? new Uint16Array(n * 4) : new Uint8Array(n * 4);
  const sample = depth === 16 ? (i: number) => (px[i * 2] << 8) | px[i * 2 + 1] : (i: number) => px[i];
  for (let i = 0; i < n; i++) {
    const s = i * channels, o = i * 4;
    if (channels <= 2) {
      data[o] = data[o + 1] = data[o + 2] = sample(s);
      data[o + 3] = channels === 2 ? sample(s + 1) : max;
    } else {
      data[o] = sample(s);
      data[o + 1] = sample(s + 1);
      data[o + 2] = sample(s + 2);
      data[o + 3] = channels === 4 ? sample(s + 3) : max;
    }
  }
  return { width, height, max, data };
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf: Uint8Array) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(kind: string, body: Uint8Array) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(kind, 4, "latin1");
  out.set(body, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

/**
 * Encode samples (channels 1 = gray, 2 = gray+alpha, 3 = RGB, 4 = RGBA; a Uint16Array writes 16-bit) as a
 * PNG. `filter` (0-4) is applied to every row (0, none, is what the diff image uses; the others exist for tests).
 */
export function encodePng(width: number, height: number, samples: Uint8Array | Uint16Array, channels = 3, filter = 0): Buffer {
  const depth = samples instanceof Uint16Array ? 16 : 8, bps = depth / 8, bpp = channels * bps, stride = width * bpp;
  if (samples.length !== width * height * channels) throw new Error("encodePng: sample count does not match the size");
  const px = new Uint8Array(height * stride);
  for (let i = 0; i < samples.length; i++) {
    if (bps === 2) {
      px[i * 2] = samples[i] >> 8;
      px[i * 2 + 1] = samples[i] & 0xff;
    } else px[i] = samples[i];
  }
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const row = y * stride, up = row - stride, dst = y * (stride + 1);
    raw[dst] = filter;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[row + x - bpp] : 0, u = y ? px[up + x] : 0, c = x >= bpp && y ? px[up + x - bpp] : 0;
      const pred = filter === 1 ? a : filter === 2 ? u : filter === 3 ? (a + u) >> 1 : filter === 4 ? paeth(a, u, c) : 0;
      raw[dst + 1 + x] = (px[row + x] - pred) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = [0, 0, 4, 2, 6][channels];
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))]);
}
