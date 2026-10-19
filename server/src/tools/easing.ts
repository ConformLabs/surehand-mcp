// Easing analysis in TypeScript, on the exact key data the keyframe-table collector returns (ae_get_keyframes,
// ae_audit_easing). No After Effects needed, so it is tested directly.
//
// After Effects' temporal model for a segment from key A to key B (duration D seconds):
//   the out-handle of A sits at time tA + D * outInfluence(A), value vA + outSpeed(A) * D * outInfluence(A)
//   the in-handle  of B sits at time tB - D * inInfluence(B),  value vB - inSpeed(B)  * D * inInfluence(B)
// (influence as a fraction 0..1, speed in the property's units per second). Normalised to a unit square
// (time 0..1, value 0..1 from vA to vB) this is a cubic Bezier like CSS cubic-bezier(x1, y1, x2, y2).
// For spatial properties (Position, Anchor Point, Point controls) the speed is along the motion path, so the
// value distance is the arc length of the spatial Bezier between the keys (with the spatial tangents).

export interface KeyEase {
  speed: number;
  influence: number;
}
export interface KeyRow {
  index: number;
  frame: number;
  time: number;
  offFrame?: number;
  value: unknown;
  inInterpolation?: string;
  outInterpolation?: string;
  easeIn?: KeyEase[];
  easeOut?: KeyEase[];
  inSpatialTangent?: number[];
  outSpatialTangent?: number[];
  temporalAutoBezier?: boolean;
}
export interface PropRows {
  layer: number;
  layerName: string;
  path: string;
  name: string;
  matchName: string;
  valueType?: string;
  spatial?: boolean;
  keys: KeyRow[];
  comp?: string;
}

export type Curve = [number, number, number, number];
export interface Segment {
  fromKey: number;
  toKey: number;
  fromFrame: number;
  toFrame: number;
  frames: number;
  /** "bezier" (any eased or linear segment with movement), "hold", or "static" (no change in value) */
  kind: "curve" | "hold" | "static";
  /** linear in/out on both ends */
  linear?: boolean;
  /** normalised cubic-bezier(x1, y1, x2, y2), one per dimension (spatial and 1D properties: one) */
  curves?: Curve[];
  /** value distance covered (arc length for spatial properties), per dimension otherwise */
  distance?: number[];
  /** out-ease of the first key and in-ease of the second, exactly as stored */
  out?: KeyEase[];
  in?: KeyEase[];
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;
const num = (v: unknown): number[] | null =>
  typeof v === "number" ? [v] : Array.isArray(v) && v.every((x) => typeof x === "number") ? (v as number[]) : null;

function bez(p0: number[], p1: number[], p2: number[], p3: number[], t: number): number[] {
  const u = 1 - t;
  return p0.map((_, i) => u * u * u * p0[i] + 3 * u * u * t * p1[i] + 3 * u * t * t * p2[i] + t * t * t * p3[i]);
}

/** Arc length of the spatial Bezier from a to b with AE's tangents (relative to the keys), by sampling. */
export function arcLength(a: number[], b: number[], outTan: number[] = [], inTan: number[] = [], steps = 200): number {
  const n = Math.min(a.length, b.length);
  const p0 = a.slice(0, n), p3 = b.slice(0, n);
  const p1 = p0.map((v, i) => v + (outTan[i] ?? 0)), p2 = p3.map((v, i) => v + (inTan[i] ?? 0));
  let len = 0, prev = p0;
  for (let s = 1; s <= steps; s++) {
    const pt = bez(p0, p1, p2, p3, s / steps);
    len += Math.hypot(...pt.map((v, i) => v - prev[i]));
    prev = pt;
  }
  return len;
}

/** The normalised curve for one dimension: null when the value doesn't change. */
export function normalisedCurve(duration: number, distance: number, out: KeyEase, inn: KeyEase): Curve | null {
  if (!(duration > 0) || Math.abs(distance) < 1e-9) return null;
  const x1 = out.influence / 100, x2 = 1 - inn.influence / 100;
  const y1 = (out.speed * duration * x1) / distance;
  const y2 = 1 - (inn.speed * duration * (inn.influence / 100)) / distance;
  return [r4(x1), r4(y1), r4(x2), r4(y2)];
}

/** Every segment between consecutive keys of a property, with its curve numbers. */
export function segments(p: PropRows): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i + 1 < p.keys.length; i++) {
    const a = p.keys[i], b = p.keys[i + 1];
    const seg: Segment = { fromKey: a.index, toKey: b.index, fromFrame: a.frame, toFrame: b.frame, frames: b.frame - a.frame, kind: "curve" };
    if (a.easeOut) seg.out = a.easeOut;
    if (b.easeIn) seg.in = b.easeIn;
    if (a.outInterpolation === "hold") {
      seg.kind = "hold";
      out.push(seg);
      continue;
    }
    seg.linear = a.outInterpolation === "linear" && b.inInterpolation === "linear";
    const va = num(a.value), vb = num(b.value), D = b.time - a.time;
    if (!va || !vb || !a.easeOut || !b.easeIn) {
      seg.kind = va && vb && va.every((v, k) => v === vb[k]) ? "static" : "curve";
      out.push(seg);
      continue;
    }
    if (p.spatial) {
      const dist = arcLength(va, vb, a.outSpatialTangent, b.inSpatialTangent);
      const c = normalisedCurve(D, dist, a.easeOut[0], b.easeIn[0]);
      seg.distance = [r4(dist)];
      if (c) seg.curves = [c];
      else seg.kind = "static";
    } else {
      const dims = Math.min(a.easeOut.length, b.easeIn.length, va.length, vb.length);
      const curves: Curve[] = [], dist: number[] = [];
      for (let d = 0; d < dims; d++) {
        // one ease for a multi-value property that isn't 2D/3D (a color): the speed is along the value change
        const delta = a.easeOut.length === 1 && va.length > 1 ? Math.hypot(...va.map((v, k) => vb[k] - v)) : vb[d] - va[d];
        dist.push(r4(delta));
        const c = normalisedCurve(D, delta, a.easeOut[d], b.easeIn[d]);
        if (c) curves.push(c);
      }
      seg.distance = dist;
      if (curves.length) seg.curves = curves;
      else seg.kind = "static";
    }
    out.push(seg);
  }
  return out;
}

/** ae_get_keyframes with curves: every property gets its segments. */
export function withCurves(result: { properties?: PropRows[] }): unknown {
  if (!result || !Array.isArray(result.properties)) return result;
  return { ...result, properties: result.properties.map((p) => ({ ...p, segments: segments(p) })) };
}

// ---------- the motion consistency audit ----------

export interface AuditOptions {
  /** two curves are the same "norm" when every number differs by at most this (default 0.05) */
  tolerance?: number;
  /** a norm needs at least this share of the eased segments of its scope (default 0.1) and 2 segments */
  minShare?: number;
}
interface Entry { prop: PropRows; seg: Segment; curve: Curve }

const dist = (a: Curve, b: Curve) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
const fmt = (c: Curve) => `cubic-bezier(${c.map((v) => r4(v)).join(", ")})`;

/** The project's own norms: clusters of near-identical curves, largest first (greedy, deterministic). */
export function findNorms(curves: Curve[], tolerance: number, minShare: number): { curve: Curve; count: number; share: number }[] {
  const left = curves.map((c, i) => ({ c, i }));
  const norms: { curve: Curve; count: number; share: number }[] = [];
  while (left.length) {
    // the curve with the most neighbours is the centre of the next cluster
    let best = -1, bestN = 0;
    for (let i = 0; i < left.length; i++) {
      let n = 0;
      for (const o of left) if (dist(left[i].c, o.c) <= tolerance) n++;
      if (n > bestN) [best, bestN] = [i, n];
    }
    const centre = left[best].c;
    const members = left.filter((o) => dist(centre, o.c) <= tolerance);
    if (members.length < 2 || members.length / curves.length < minShare) break;
    // the cluster's mean as its curve
    const mean = [0, 1, 2, 3].map((k) => r4(members.reduce((s, m) => s + m.c[k], 0) / members.length)) as Curve;
    norms.push({ curve: mean, count: members.length, share: Math.round((members.length / curves.length) * 1000) / 1000 });
    for (const m of members) left.splice(left.indexOf(m), 1);
  }
  return norms;
}

/**
 * Checks every eased segment against the project's own norms (no external standard): the curves most segments
 * use, overall and per property kind (match name). A segment that matches no norm of its kind and no overall
 * norm is an outlier. Linear-vs-eased and hold keys are counted.
 */
export function auditEasing(props: PropRows[], opts: AuditOptions = {}) {
  const tol = opts.tolerance ?? 0.05, minShare = opts.minShare ?? 0.1;
  const entries: Entry[] = [];
  let holds = 0, statics = 0, linear = 0, segs = 0;
  for (const p of props)
    for (const s of segments(p)) {
      segs++;
      if (s.kind === "hold") holds++;
      else if (s.kind === "static") statics++;
      else if (s.curves) {
        if (s.linear) linear++;
        // multi-dimension (Scale...): every dimension that moves is its own curve
        for (const c of s.curves) entries.push({ prop: p, seg: s, curve: c });
      }
    }
  const overall = findNorms(entries.map((e) => e.curve), tol, minShare);
  const kinds = new Map<string, Entry[]>();
  for (const e of entries) kinds.set(e.prop.matchName, [...(kinds.get(e.prop.matchName) ?? []), e]);
  const perKind: Record<string, { segments: number; norms: { curve: string; numbers: Curve; count: number; share: number }[] }> = {};
  const kindNorms = new Map<string, Curve[]>();
  for (const [k, list] of kinds) {
    const n = findNorms(list.map((e) => e.curve), tol, minShare);
    kindNorms.set(k, n.map((x) => x.curve));
    perKind[k] = { segments: list.length, norms: n.map((x) => ({ curve: fmt(x.curve), numbers: x.curve, count: x.count, share: x.share })) };
  }
  const outliers = [];
  const seen = new Set<Segment>();
  for (const e of entries) {
    const near = [...(kindNorms.get(e.prop.matchName) ?? []), ...overall.map((o) => o.curve)];
    if (near.some((n) => dist(n, e.curve) <= tol) || seen.has(e.seg)) continue;
    seen.add(e.seg);
    const nearest = near.length ? near.reduce((a, b) => (dist(a, e.curve) <= dist(b, e.curve) ? a : b)) : null;
    outliers.push({
      ...(e.prop.comp ? { comp: e.prop.comp } : {}),
      layer: e.prop.layer,
      layerName: e.prop.layerName,
      property: e.prop.name,
      path: e.prop.path,
      frames: `${e.seg.fromFrame}-${e.seg.toFrame}`,
      keys: [e.seg.fromKey, e.seg.toKey],
      curve: fmt(e.curve),
      ...(e.seg.linear ? { linear: true } : {}),
      out: e.seg.out,
      in: e.seg.in,
      ...(nearest ? { nearestNorm: fmt(nearest), off: r4(dist(nearest, e.curve)) } : {}),
    });
  }
  return {
    segments: segs,
    eased: entries.length,
    linearSegments: linear,
    holdSegments: holds,
    staticSegments: statics,
    tolerance: tol,
    norms: overall.map((o) => ({ curve: fmt(o.curve), numbers: o.curve, count: o.count, share: o.share })),
    byProperty: perKind,
    outliers,
    note:
      entries.length < 4
        ? "Too few eased segments to establish norms."
        : "Norms are this project's own most-used curves (normalised cubic-bezier: x = time, y = value, 0..1 from key to key).",
  };
}
