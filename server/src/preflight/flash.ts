// Preflight: photosensitive flash PRE-CHECK on a downscaled grid of the picture. Not a certified PSE / Harding
// test: it follows the definitions of a general flash and a red flash in ITU-R BT.1702 / WCAG 2.x so that
// likely problems show up before the certified test.
//
// Each frame arrives as a small rgb24 grid (e.g. 32x18; each cell is the average of its part of the picture).
// Per cell:
// - relative luminance L = 0.2126 R + 0.7152 G + 0.0722 B of the linearised (sRGB) values;
// - a transition is a monotonic change of L by at least `minLuminanceChange` from the last turning point,
//   where the darker of the two states is below 0.8;
// - a red transition is a change of max(0, (R - G - B) * 320) by more than 20 where the redder state is a
//   saturated red (R / (R + G + B) >= 0.8), linear R, G, B in 0-1.
// A frame has a (screen) transition in a direction when at least `minAreaFraction` of the cells make one in that
// direction on that frame. A flash is a pair of opposing transitions; more than `maxFlashesPerSecond` flashes
// (more than 2x that many transitions) within any one-second window fails.

export interface FlashOptions {
  /** grid size (cells) */
  width: number;
  height: number;
  fps: number;
  maxFlashesPerSecond?: number;
  minAreaFraction?: number;
  minLuminanceChange?: number;
  redFlash?: boolean;
}

export interface FlashRun {
  /** seconds */
  start: number;
  end: number;
  /** most flashes (pairs of opposing transitions) seen in one second inside this run */
  maxFlashesPerSecond: number;
}

export interface FlashResult {
  general: FlashRun[];
  red: FlashRun[];
  /** frame-level transition times (s), for diagnostics / tests */
  transitions: { general: number[]; red: number[] };
  frames: number;
}

const LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** ignore turning points smaller than this (codec noise), in the tracked quantity's units */
const NOISE_L = 0.004;
const NOISE_RED = 0.8;

/** Per-cell monotonic-segment tracker. */
class Tracker {
  private ext: Float64Array;
  private cur: Float64Array;
  private extFlag: Uint8Array;
  private curFlag: Uint8Array;
  private dir: Int8Array;
  private done: Uint8Array;
  started = false;
  constructor(n: number, private noise: number) {
    this.ext = new Float64Array(n);
    this.cur = new Float64Array(n);
    this.extFlag = new Uint8Array(n);
    this.curFlag = new Uint8Array(n);
    this.dir = new Int8Array(n);
    this.done = new Uint8Array(n);
  }
  /**
   * Feeds one value (and a flag, e.g. "saturated red") per cell; returns +1 / -1 when the cell completes a
   * qualifying transition on this frame, else 0. `qualifies(a, b, aFlag, bFlag)`: a = the turning point, b = now.
   */
  step(i: number, v: number, flag: number, minChange: number, qualifies: (a: number, b: number, aFlag: number, bFlag: number) => boolean): number {
    if (!this.started) {
      this.ext[i] = this.cur[i] = v;
      this.extFlag[i] = this.curFlag[i] = flag;
      return 0;
    }
    const d = v - this.cur[i];
    if (Math.abs(d) > this.noise) {
      const nd = d > 0 ? 1 : -1;
      if (this.dir[i] !== nd) {
        // turning point (or the first movement): the previous value is the extreme to measure from
        if (this.dir[i] !== 0) {
          this.ext[i] = this.cur[i];
          this.extFlag[i] = this.curFlag[i];
        }
        this.dir[i] = nd;
        this.done[i] = 0;
      }
    }
    this.cur[i] = v;
    this.curFlag[i] = flag;
    if (this.dir[i] !== 0 && !this.done[i] && Math.abs(v - this.ext[i]) >= minChange && qualifies(this.ext[i], v, this.extFlag[i], flag)) {
      this.done[i] = 1;
      return this.dir[i];
    }
    return 0;
  }
}

export class FlashDetector {
  private n: number;
  private frame = 0;
  private lum: Tracker;
  private red: Tracker;
  private events = { general: [] as { t: number; dir: number }[], red: [] as { t: number; dir: number }[] };
  private o: Required<FlashOptions>;

  constructor(o: FlashOptions) {
    this.o = {
      ...o,
      maxFlashesPerSecond: o.maxFlashesPerSecond ?? 3,
      minAreaFraction: o.minAreaFraction ?? 0.25,
      minLuminanceChange: o.minLuminanceChange ?? 0.1,
      redFlash: o.redFlash ?? true,
    };
    this.n = o.width * o.height;
    this.lum = new Tracker(this.n, NOISE_L);
    this.red = new Tracker(this.n, NOISE_RED);
  }

  get frameBytes() {
    return this.n * 3;
  }

  /** One frame: width*height*3 bytes of rgb24. */
  push(rgb: Uint8Array) {
    const { minLuminanceChange: minL, redFlash } = this.o;
    let up = 0, down = 0, rUp = 0, rDown = 0;
    const darkerBelow = (a: number, b: number) => Math.min(a, b) < 0.8;
    const redderSaturated = (a: number, b: number, af: number, bf: number) => (a > b ? af : bf) === 1;
    for (let i = 0; i < this.n; i++) {
      const R = LINEAR[rgb[i * 3]], G = LINEAR[rgb[i * 3 + 1]], B = LINEAR[rgb[i * 3 + 2]];
      const L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      const t = this.lum.step(i, L, 0, minL, darkerBelow);
      if (t > 0) up++;
      else if (t < 0) down++;
      if (redFlash) {
        const sum = R + G + B;
        const sat = sum > 0 && R / sum >= 0.8 ? 1 : 0;
        const q = Math.max(0, (R - G - B) * 320);
        // "more than 20": a tiny epsilon above 20
        const rt = this.red.step(i, q, sat, 20 + 1e-9, redderSaturated);
        if (rt > 0) rUp++;
        else if (rt < 0) rDown++;
      }
    }
    this.lum.started = this.red.started = true;
    const t = this.frame / this.o.fps;
    const need = this.o.minAreaFraction * this.n;
    const add = (list: { t: number; dir: number }[], u: number, d: number) => {
      // both directions on one frame (e.g. half the screen goes up, half down) count as one of each
      if (u >= need && u > 0) list.push({ t, dir: 1 });
      if (d >= need && d > 0) list.push({ t, dir: -1 });
    };
    add(this.events.general, up, down);
    if (redFlash) add(this.events.red, rUp, rDown);
    this.frame++;
  }

  result(): FlashResult {
    const general = alternating(this.events.general);
    const red = alternating(this.events.red);
    return { general: windows(general, this.o.maxFlashesPerSecond), red: windows(red, this.o.maxFlashesPerSecond), transitions: { general, red }, frames: this.frame };
  }
}

/** Opposing transitions only: a repeat of the same direction extends the previous one. */
function alternating(ev: { t: number; dir: number }[]): number[] {
  const out: number[] = [];
  let last = 0;
  for (const e of ev) {
    if (e.dir === last) continue;
    out.push(e.t);
    last = e.dir;
  }
  return out;
}

/** Runs where some one-second window holds more than 2*max transitions (more than `max` flashes). */
export function windows(times: number[], maxFlashesPerSecond: number): FlashRun[] {
  const runs: FlashRun[] = [];
  const limit = 2 * maxFlashesPerSecond;
  let j = 0;
  for (let i = 0; i < times.length; i++) {
    if (j < i) j = i;
    while (j + 1 < times.length && times[j + 1] < times[i] + 1 - 1e-9) j++;
    const count = j - i + 1;
    if (count > limit) {
      const start = times[i], end = times[j];
      const prev = runs[runs.length - 1];
      if (prev && start <= prev.end + 1e-9) {
        prev.end = Math.max(prev.end, end);
        prev.maxFlashesPerSecond = Math.max(prev.maxFlashesPerSecond, count / 2);
      } else runs.push({ start, end, maxFlashesPerSecond: count / 2 });
    }
  }
  return runs;
}
