// Reformat: a comp at another size (16:9 -> 9:16, 1:1, 4:5 or any size), laid out by the user's own rules and then
// checked frame by frame. No presets and no guessed layouts: every move comes from a rule the user set, a layer no
// rule names keeps its offset from the frame centre (as After Effects' own Composition Settings resize does with the
// centre anchor), and a rule that can't be met is reported with the reason, never silently broken.
//
// Pure TypeScript, unit-tested in test/reformat.test.ts. tools/reformat.ts reads the project (the layer tree, and
// each layer's bounds over time with Preflight's reader, src/preflight/project.ts), applies the plan in one undo
// step and reads the result back.
//
// The geometry: every plan is a similarity in comp space, p -> k p + t (uniform scale k, then a move). Applied to a
// layer as Position' = k Position + u and Scale' = k Scale (keys too, with spatial tangents and ease speeds scaled
// by k), it maps every frame of the layer's animation by the same similarity, so the motion keeps its shape.
import { z } from "zod";
import { CAP_RATIO, layerMatrix, overshoot, runsOf, sidesText, trackAt, verticalScale, wildcard, boundsThrough, type Affine, type Box, type PData, type PItem, type PLevel } from "../preflight/project.js";
import { margin, type Finding } from "../preflight/spec.js";

// ---------- the rules ----------

export const PIN_TO = ["top-left", "top", "top-right", "left", "right", "bottom-left", "bottom", "bottom-right"] as const;
const pattern = z.string().min(1).describe('Layer name, or a pattern with * wildcards ("Logo*").');
const px = z.number().min(0);

/** The user's constraints (all optional; flat, so they are easy to pass in one call). */
export const ruleShape = {
  background: z
    .array(z.object({ layer: pattern, mode: z.enum(["cover", "fit"]) }).strict())
    .optional()
    .describe('Background / full-frame layers: scaled uniformly about the frame centre to "cover" the new frame (no gaps) or "fit" inside it (nothing cut off), on every frame where they are visible.'),
  safeAreas: z
    .object({ title: margin.optional(), action: margin.optional() })
    .strict()
    .optional()
    .describe("The new format's title-safe / action-safe margin per side, as a fraction (0.1 = 10% in from each edge) or {x, y}: from the user's delivery spec."),
  safe: z
    .array(z.object({ layer: pattern, area: z.enum(["title", "action", "frame"]) }).strict())
    .optional()
    .describe("Layers that must stay inside title-safe, action-safe or the frame on every checked frame: moved as little as needed, scaled down only when a scale rule allows it."),
  pin: z
    .array(z.object({ layer: pattern, to: z.enum(PIN_TO), margin: z.union([px, z.object({ x: px, y: px }).strict()]).describe("px from the edge(s), on the layer's box") }).strict())
    .optional()
    .describe("Layers anchored to an edge or corner of the new frame with a margin in px."),
  scale: z
    .array(z.object({ layer: pattern, min: z.number().positive().optional(), max: z.number().positive().optional() }).strict())
    .optional()
    .describe("Layers allowed to scale, with limits in % of their size in the source (100 = unchanged; default max 100 for safe rules, none for background rules). Other layers are only moved."),
  minCapHeightPx: z.number().positive().optional().describe("Smallest text cap height in comp px (estimated as 0.7 x font size x scale): scaling never goes below it, and every text layer is checked."),
  hide: z.array(pattern).optional().describe("Layers to switch off in the new format."),
};
export const rulesSchema = z.object(ruleShape).strict();
export type Rules = z.infer<typeof rulesSchema>;
export type Area = "title" | "action" | "frame";
const AREA: Record<Area, string> = { title: "title-safe", action: "action-safe", frame: "the frame" };

/** What is wrong with the rules before anything is read (an area without its margin, min above max). */
export function rulesProblems(r: Rules): string[] {
  const out: string[] = [];
  for (const s of r.safe ?? [])
    if (s.area !== "frame" && r.safeAreas?.[s.area] === undefined) out.push(`safe rule "${s.layer}" uses ${AREA[s.area]}: give safeAreas.${s.area} (the margin per side, from the user's delivery spec)`);
  for (const s of r.scale ?? []) if (s.min !== undefined && s.max !== undefined && s.min > s.max) out.push(`scale rule "${s.layer}": min ${s.min} is above max ${s.max}`);
  return [...new Set(out)];
}

/** The rules that move or switch off a layer (scale and minCapHeightPx only limit them). */
const actingPatterns = (r: Rules) => [...(r.safe ?? []).map((s) => s.layer), ...(r.pin ?? []).map((p) => p.layer), ...(r.background ?? []).map((b) => b.layer), ...(r.hide ?? [])];
const re = (p: string) => new RegExp(wildcard(p));

// ---------- what the ExtendScript reads: the layer tree ----------

export interface PropInfo {
  /** keys */
  k: number;
  /** an enabled expression */
  ex?: 1;
}
export interface TLayer {
  i: number;
  n: string;
  /** aemcp.layerType: text, shape, solid, footage, precomp, null, adjustment, camera, light */
  ty: string;
  par?: number;
  d3?: 1;
  lock?: 1;
  off?: 1;
  /** is a track matte; mt: the index of its own track matte */
  isM?: 1;
  mt?: number;
  pos: PropInfo | { sep: 1; x: PropInfo; y: PropInfo };
  sc: PropInfo;
  an: PropInfo;
  /** the comp it shows (precomp layers) */
  src?: number;
}
export interface TComp {
  id: number;
  name: string;
  w: number;
  h: number;
  fps: number;
  layers: TLayer[];
}
export interface Tree {
  root: number;
  comps: TComp[];
  /** a project item already has the new comp's name */
  nameTaken?: boolean;
}

const posInfo = (L: TLayer) => ("sep" in L.pos ? L.pos : null);
const posExpr = (L: TLayer) => (posInfo(L) ? !!(posInfo(L)!.x.ex || posInfo(L)!.y.ex) : !!(L.pos as PropInfo).ex);
const posKeys = (L: TLayer) => (posInfo(L) ? posInfo(L)!.x.k + posInfo(L)!.y.k : (L.pos as PropInfo).k);

// ---------- which comps the reformat duplicates ----------

export type PrecompMode = "auto" | "reuse" | "duplicate";
export interface CompJob {
  src: number;
  /** the new comp's name */
  name: string;
  /** resized to the target and laid out by the rules (else a plain copy, so the new tree is independent) */
  reformat: boolean;
}
export interface Issue {
  /** the new comp's name, the layer */
  comp: string;
  i?: number;
  n?: string;
  where: string;
  /** the Preflight / reformat check this explains (its finding gets the reason), or its own finding */
  check: string;
  severity: Finding["severity"];
  message: string;
  fix?: string;
}
export interface Decision {
  /** children first: a comp's precomps exist before it */
  jobs: CompJob[];
  /** one line per precomp: what happens to it and why */
  precomps: string[];
  issues: Issue[];
}

/**
 * Which comps are duplicated. The top comp always; a precomp only when it has the frame's size ("full-frame")
 * and either precomps is "duplicate" or (default "auto") a rule names a layer inside it, at any depth through
 * full-frame precomps. "duplicate" also copies the other precomps (unchanged) so the new tree is independent.
 * A rule naming a layer in a precomp that isn't reformatted can't move it there: that is reported.
 */
export function decideJobs(tree: Tree, rules: Rules, mode: PrecompMode, newName: string): Decision {
  const byId = new Map(tree.comps.map((c) => [c.id, c]));
  const root = byId.get(tree.root)!;
  const acting = actingPatterns(rules).map((p) => ({ p, r: re(p) }));
  const full = (child: TComp, parent: TComp) => child.w === parent.w && child.h === parent.h;
  const precompLayers = (c: TComp) => c.layers.filter((l) => l.src !== undefined && byId.has(l.src));
  const hits = (c: TComp) => c.layers.filter((l) => acting.some((a) => a.r.test(l.n)));
  const needMemo = new Map<number, string | null>();
  // why a full-frame precomp needs reformatting in "auto" ("" = no)
  const need = (c: TComp, seen = new Set<number>()): string => {
    if (needMemo.has(c.id)) return needMemo.get(c.id) ?? "";
    if (seen.has(c.id)) return "";
    seen.add(c.id);
    const h = hits(c);
    let why = h.length ? `a rule names ${h.slice(0, 3).map((l) => `"${l.n}"`).join(", ")}${h.length > 3 ? ` (+${h.length - 3})` : ""} inside it` : "";
    if (!why)
      for (const l of precompLayers(c)) {
        const ch = byId.get(l.src!)!;
        if (full(ch, c) && need(ch, seen)) {
          why = `it holds "${ch.name}", which a rule needs changed`;
          break;
        }
      }
    needMemo.set(c.id, why || null);
    return why;
  };
  const reformat = new Map<number, string>([[root.id, ""]]);
  const walk = (c: TComp) => {
    for (const l of precompLayers(c)) {
      const ch = byId.get(l.src!)!;
      if (reformat.has(ch.id) || !full(ch, c)) continue;
      const why = mode === "duplicate" ? 'precomps "duplicate"' : mode === "auto" ? need(ch) : "";
      if (!why) continue;
      reformat.set(ch.id, why);
      walk(ch);
    }
  };
  walk(root);
  // every comp the new tree shows
  const reach = new Set<number>();
  const visit = (c: TComp) => {
    if (reach.has(c.id)) return;
    reach.add(c.id);
    for (const l of precompLayers(c)) visit(byId.get(l.src!)!);
  };
  visit(root);
  const copy = new Set(mode === "duplicate" ? [...reach].filter((id) => !reformat.has(id)) : []);
  const jobs: CompJob[] = [];
  const done = new Set<number>();
  const post = (c: TComp) => {
    if (done.has(c.id)) return;
    done.add(c.id);
    for (const l of precompLayers(c)) post(byId.get(l.src!)!);
    if (reformat.has(c.id) || copy.has(c.id)) jobs.push({ src: c.id, name: c.id === root.id ? newName : `${c.name} (${newName})`, reformat: reformat.has(c.id) });
  };
  post(root);

  const precomps: string[] = [];
  const issues: Issue[] = [];
  for (const id of reach) {
    if (id === root.id) continue;
    const c = byId.get(id)!;
    const parentOf = tree.comps.find((p) => reach.has(p.id) && p.layers.some((l) => l.src === id));
    const isFull = !!parentOf && full(c, parentOf);
    const size = `${c.w}x${c.h}`;
    if (reformat.has(id)) precomps.push(`"${c.name}": reformatted as "${c.name} (${newName})": ${reformat.get(id)}`);
    else if (copy.has(id)) precomps.push(`"${c.name}": copied unchanged as "${c.name} (${newName})" (${size}${isFull ? "" : ", not the frame size"})`);
    else precomps.push(`"${c.name}": reused (${isFull ? (mode === "reuse" ? 'precomps "reuse"' : "no rule names a layer inside it") : `${size}, not the frame size`})`);
    if (reformat.has(id)) continue;
    // a rule naming a layer in here can't be applied
    for (const l of hits(c)) {
      const where = `${c.name} > ${l.i}: ${l.n}`;
      const why = isFull && mode === "reuse" ? 'precomps "reuse" keeps it as it is' : isFull ? "it is shown through a precomp that isn't reformatted" : `the precomp is ${size}, not the frame size, so it isn't reformatted`;
      const safeOnly = (rules.safe ?? []).some((s) => re(s.layer).test(l.n)) && ![...(rules.pin ?? []), ...(rules.background ?? [])].some((s) => re(s.layer).test(l.n)) && !(rules.hide ?? []).some((h) => re(h).test(l.n));
      if (safeOnly) issues.push({ comp: c.name, i: l.i, n: l.n, where, check: "reformat.precomp", severity: "info", message: `not moved: it is inside precomp "${c.name}" and ${why}; Preflight checks it where the new comp shows it` });
      else
        issues.push({
          comp: c.name, i: l.i, n: l.n, where, check: "reformat.precomp", severity: "fail",
          message: `a rule names this layer, but it is inside precomp "${c.name}" and ${why}: the rule was not applied`,
          fix: isFull ? 'Decide: precomps "auto" or "duplicate" (reformats that precomp), or name the precomp layer in the rule' : `Decide: name the layer that shows "${c.name}" in the rule instead, or change the precomp yourself`,
        });
    }
  }
  return { jobs, precomps, issues };
}

// ---------- similarities in comp space ----------

/** p -> k p + t */
export interface Sim {
  k: number;
  t: [number, number];
}
export const IDENTITY: Sim = { k: 1, t: [0, 0] };
/** a after b */
export const compose = (a: Sim, b: Sim): Sim => ({ k: a.k * b.k, t: [a.k * b.t[0] + a.t[0], a.k * b.t[1] + a.t[1]] });
export const invert = (a: Sim): Sim => ({ k: 1 / a.k, t: [-a.t[0] / a.k, -a.t[1] / a.k] });
export const translate = (dx: number, dy: number): Sim => ({ k: 1, t: [dx, dy] });
export const scaleAbout = (k: number, c: number[]): Sim => ({ k, t: [c[0] * (1 - k), c[1] * (1 - k)] });
export const mapBox = (s: Sim, b: Box): Box => ({ x0: s.k * b.x0 + s.t[0], y0: s.k * b.y0 + s.t[1], x1: s.k * b.x1 + s.t[0], y1: s.k * b.y1 + s.t[1] });
const sameSim = (a: Sim, b: Sim) => Math.abs(a.k - b.k) < 1e-9 && Math.abs(a.t[0] - b.t[0]) < 1e-6 && Math.abs(a.t[1] - b.t[1]) < 1e-6;
const union = (bs: Box[]): Box => ({ x0: Math.min(...bs.map((b) => b.x0)), y0: Math.min(...bs.map((b) => b.y0)), x1: Math.max(...bs.map((b) => b.x1)), y1: Math.max(...bs.map((b) => b.y1)) });
const centre = (b: Box) => [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
const inside = (b: Box, a: Box, tol = 0.5) => b.x0 >= a.x0 - tol && b.y0 >= a.y0 - tol && b.x1 <= a.x1 + tol && b.y1 <= a.y1 + tol;
const onScreen = (b: Box, w: number, h: number) => b.x1 > 0 && b.y1 > 0 && b.x0 < w && b.y0 < h;

/**
 * The uniform scale about the frame centre c (moved to the new centre c2) that makes box b cover (or fit inside)
 * the new frame: for cover, each side of b must reach past the new frame's edge; null when b doesn't reach the
 * centre on some side (no scale about the centre can then cover).
 */
export function coverScale(b: Box, c: number[], c2: number[]): number | null {
  const reach = [c[0] - b.x0, b.x1 - c[0], c[1] - b.y0, b.y1 - c[1]], half = [c2[0], c2[0], c2[1], c2[1]];
  if (reach.some((r) => r <= 1e-9)) return null;
  return Math.max(...reach.map((r, j) => half[j] / r));
}
export function fitScale(b: Box, c: number[], c2: number[]): number {
  const reach = [c[0] - b.x0, b.x1 - c[0], c[1] - b.y0, b.y1 - c[1]], half = [c2[0], c2[0], c2[1], c2[1]];
  return Math.min(Infinity, ...reach.map((r, j) => (r > 1e-9 ? half[j] / r : Infinity)));
}

/** Affine of a chain of levels (innermost first) at sample k: maps the innermost level's layer space to the comp. */
function chainAffine(levels: PLevel[], k: number): Affine {
  let m: Affine = [1, 0, 0, 1, 0, 0];
  for (const lv of levels) {
    const n = layerMatrix(trackAt(lv.a, k), trackAt(lv.p, k), trackAt(lv.s, k), trackAt(lv.r, k));
    // n after m
    m = [n[0] * m[0] + n[2] * m[1], n[1] * m[0] + n[3] * m[1], n[0] * m[2] + n[2] * m[3], n[1] * m[2] + n[3] * m[3], n[0] * m[4] + n[2] * m[5] + n[4], n[1] * m[4] + n[3] * m[5] + n[5]];
  }
  return m;
}
const animatedLevel = (lv: PLevel) => [lv.a, lv.p, lv.s, lv.r].some((t) => typeof t === "object" && t !== null && !Array.isArray(t));

// ---------- planning one comp ----------

/** One layer's edit (After Effects applies it to the duplicate, reading the values from the source). */
export interface Op {
  i: number;
  /** Position' = k Position + u (in the parent's space); Scale' = k Scale */
  k?: number;
  u?: [number, number];
  /** Anchor Point += an (a precomp that is reformatted: its content moved by the change of its centre) */
  an?: [number, number];
  /** 3D layers: Position x / y += d3 (cameras and lights: Point of Interest too) */
  d3?: [number, number];
  poi?: 1;
  hide?: 1;
}
export interface LayerPlan {
  i: number;
  n: string;
  /** the rules that name it */
  rules: string[];
  /** where the layer's pixels go: source comp space -> new comp space */
  sim: Sim;
  op?: Op;
  /** what was done, for the report */
  did: string;
  /** the keys mapped with it */
  keys?: string;
  /** settled sample times (s) the rules were planned on (pins are checked on the same frames) */
  ref?: number[];
  bg?: "cover" | "fit";
  pin?: { to: (typeof PIN_TO)[number]; m: { x: number; y: number } };
}
export interface CompPlan {
  src: TComp;
  name: string;
  w: number;
  h: number;
  layers: LayerPlan[];
  issues: Issue[];
  notes: string[];
  /** reformatted precomp layers: index -> the change of the precomp's centre */
  precompShift: Map<number, [number, number]>;
}

export interface PlanInput {
  comp: TComp;
  /** Preflight's reader on the source comp: every top-level layer (pattern "*"), text everywhere */
  data: PData;
  target: { w: number; h: number };
  rules: Rules;
  name: string;
  /** precomps being reformatted (their layers here get the anchor change) */
  reformatted: Set<number>;
}

const pct = (k: number) => `${Math.round(k * 1000) / 10}%`;
const r0 = (n: number) => Math.round(n);
const r1 = (n: number) => Math.round(n * 10) / 10;

/** The text cap height (px) of item `it` at sample k, through its chain. */
function capAt(it: PItem, k: number): number | null {
  const tc = it.tc ?? [];
  let c = 0;
  while (c + 1 < tc.length && tc[c + 1][0] <= k) c++;
  const e = tc[c];
  if (!e || !e[1].trim() || !it.lv) return null;
  return e[2] * CAP_RATIO * verticalScale(it.lv, k);
}

/** The visible samples of a measured item: global index, position k, comp-space box. */
export function samplesOf(it: PItem): { i: number; k: number; box: Box }[] {
  if (!it.rect || !it.lv) return [];
  const out: { i: number; k: number; box: Box }[] = [];
  it.i.forEach((i, k) => {
    const box = boundsThrough(trackAt(it.rect!, k), it.lv!, k);
    if (box) out.push({ i, k, box });
  });
  return out;
}

const decideFix = (text: boolean) =>
  text
    ? "Decide: a shorter text, a line break, a smaller minimum cap height, a lower scale limit, or other safe margins"
    : "Decide: let it scale (a scale rule, or a lower min), another area, or other safe margins";

/** Plans every top-level layer of one comp. */
export function planComp(inp: PlanInput): CompPlan {
  const { comp, data: d, rules } = inp;
  const W = comp.w, H = comp.h, W2 = inp.target.w, H2 = inp.target.h;
  const C = [W / 2, H / 2], C2 = [W2 / 2, H2 / 2];
  const CENTER = translate(C2[0] - C[0], C2[1] - C[1]);
  const F2: Box = { x0: 0, y0: 0, x1: W2, y1: H2 };
  const tOf = (i: number) => Math.round(i * d.step * d.comp.fd * 1e6) / 1e6;
  const issues: Issue[] = [], notes: string[] = [];
  const byIdx = new Map<number, PItem>();
  for (const it of d.items) if (!it.nst && it.ti !== undefined && it.m?.length) byIdx.set(it.ti, it);
  const layers = new Map(comp.layers.map((l) => [l.i, l]));
  const where = (L: TLayer) => `${inp.name} > ${L.i}: ${L.n}`;
  const issue = (L: TLayer, check: string, severity: Finding["severity"], message: string, fix?: string) =>
    issues.push({ comp: inp.name, i: L.i, n: L.n, where: where(L), check, severity, message, ...(fix ? { fix } : {}) });
  const first = <T extends { layer: string }>(list: T[] | undefined, n: string) => (list ?? []).find((r) => re(r.layer).test(n));
  const hidden = (n: string) => (rules.hide ?? []).some((h) => re(h).test(n));

  // parents first; a track matte that no rule names follows the layer it is the matte of
  const matteOf = new Map<number, number>();
  for (const l of comp.layers) if (l.mt !== undefined && layers.get(l.mt)?.isM && !matteOf.has(l.mt)) matteOf.set(l.mt, l.i);
  const acts = (L: TLayer) => !!(first(rules.background, L.n) || first(rules.pin, L.n) || (rules.safe ?? []).some((s) => re(s.layer).test(L.n)));
  const order: TLayer[] = [];
  const placed = new Set<number>(), visiting = new Set<number>();
  const place = (L: TLayer) => {
    if (placed.has(L.i) || visiting.has(L.i)) return;
    visiting.add(L.i);
    if (L.par !== undefined && layers.has(L.par)) place(layers.get(L.par)!);
    const m = matteOf.get(L.i);
    if (L.isM && m !== undefined && !acts(L)) place(layers.get(m)!);
    visiting.delete(L.i);
    placed.add(L.i);
    order.push(L);
  };
  for (const l of comp.layers) place(l);

  const plans = new Map<number, LayerPlan>();
  const precompShift = new Map<number, [number, number]>();
  for (const L of order) {
    const it = byIdx.get(L.i);
    const parent = L.par !== undefined ? plans.get(L.par) : undefined;
    const base = parent ? parent.sim : CENTER;
    const bg = first(rules.background, L.n), pin = first(rules.pin, L.n), sc = first(rules.scale, L.n);
    const safes = (rules.safe ?? []).filter((s) => re(s.layer).test(L.n));
    const hide = hidden(L.n);
    const named = [bg && `background ${bg.mode}`, ...safes.map((s) => `safe ${s.area}`), pin && `pin ${pin.to}`, sc && "scale", hide && "hide"].filter(Boolean) as string[];
    const plan: LayerPlan = { i: L.i, n: L.n, rules: named, sim: base, did: "" };
    plans.set(L.i, plan);
    const did: string[] = [];
    const op: Op = { i: L.i };
    if (hide) {
      op.hide = 1;
      did.push("switched off");
    }
    // a layer switched off isn't laid out
    const acting = !hide && !!(bg || pin || safes.length);

    // 3D: moved with the frame centre; the rules need depth and the camera, so they aren't applied
    if (L.d3 || L.ty === "camera" || L.ty === "light") {
      if (L.par === undefined) {
        op.d3 = CENTER.t;
        if (L.ty === "camera" || L.ty === "light") op.poi = 1;
        did.push(`3D: moved with the frame centre (${r1(CENTER.t[0])}, ${r1(CENTER.t[1])} px in x / y)`);
      }
      if (acting) issue(L, "reformat.3d", "fail", "3D layer: the rules aren't applied to 3D layers (where they land on screen depends on depth and the camera)", "Decide its position yourself; check it with ae_get_layer_bounds at the key frames");
      plan.sim = base;
      plan.op = op.d3 || op.hide ? op : undefined;
      plan.did = did.join("; ");
      continue;
    }

    let own = base;
    const all = it ? samplesOf(it) : [];
    const vis = all.filter((s) => onScreen(s.box, W, H));
    const settled = vis.filter((s) => inside(s.box, { x0: 0, y0: 0, x1: W, y1: H }));
    const ref = settled.length ? settled : vis;
    const isText = L.ty === "text";
    // the smallest cap height in the source, for the scale floor
    const caps = isText && it ? ref.map((s) => capAt(it, s.k)).filter((c): c is number => c !== null && c > 0) : [];
    const capMin = caps.length ? Math.min(...caps) : undefined;

    if (L.isM && !acting && matteOf.has(L.i)) {
      const m = plans.get(matteOf.get(L.i)!);
      if (m && !sameSim(m.sim, base)) {
        own = m.sim;
        did.push(`track matte of "${m.n}": moved with it`);
      }
    } else if (acting && !ref.length) {
      issue(L, "reformat.rule", "fail", `the rules can't be applied: it has no measurable bounds on screen in the source (${L.ty === "null" ? "a null layer" : it ? "never on screen" : "never visible, or no content"})`, L.ty === "null" ? "Decide: name the layers it controls in the rules" : undefined);
    } else if (acting) {
      plan.ref = ref.map((s) => tOf(s.i));
      if (!settled.length) notes.push(`${where(L)}: never fully inside the source frame; its rules were planned on the frames where it is on screen`);
      const kMin = Math.max(sc?.min !== undefined ? sc.min / 100 : 0, rules.minCapHeightPx !== undefined && capMin ? rules.minCapHeightPx / capMin : 0);
      const kMax = sc?.max !== undefined ? sc.max / 100 : bg ? Infinity : 1;
      const limitWhy = (k: number) =>
        rules.minCapHeightPx !== undefined && capMin && Math.abs(k - rules.minCapHeightPx / capMin) < 1e-9
          ? `the minimum cap height (${rules.minCapHeightPx} px) keeps it at ${pct(k)} or more (its cap height is about ${r1(capMin)} px in the source)`
          : `the scale rule keeps it at ${pct(k)} or more`;
      // 1. background: one scale about the frame centre for every visible frame
      if (bg) {
        const need =
          bg.mode === "cover"
            ? vis.reduce<number | null>((acc, s) => {
                const k = coverScale(s.box, C, C2);
                return acc === null || k === null ? null : Math.max(acc, k);
              }, 0)
            : Math.min(...vis.map((s) => fitScale(s.box, C, C2)));
        if (need === null || !isFinite(need) || need <= 0)
          issue(L, `reformat.${bg.mode}`, "fail", `can't ${bg.mode} the new frame by scaling about the frame centre: it doesn't reach the centre on every side`, "Decide: a pin or safe rule for it instead, or move it over the frame centre in the source");
        else {
          const k = Math.min(Math.max(need, kMin), kMax);
          if (Math.abs(k - need) > 1e-9)
            issue(L, `reformat.${bg.mode}`, "fail", `${bg.mode} needs ${pct(need)} of its size, but ${k > need ? limitWhy(kMin) : `the scale rule allows at most ${pct(kMax)}`}`, bg.mode === "cover" ? "Decide: allow more scaling (scale rule max), or fit instead of cover" : "Decide: allow less scaling (scale rule min), or cover instead of fit");
          own = compose(CENTER, scaleAbout(k, C));
          did.push(`${bg.mode}: scaled to ${pct(k)} about the frame centre`);
        }
      }
      let U = union(ref.map((s) => mapBox(own, s.box)));
      // 2. the safe area (the tightest of the areas named)
      let A: Box | null = null;
      const areas = safes.map((s) => s.area);
      for (const area of areas) {
        const m = area === "frame" ? { x: 0, y: 0 } : typeof rules.safeAreas![area] === "number" ? { x: rules.safeAreas![area] as number, y: rules.safeAreas![area] as number } : (rules.safeAreas![area] as { x: number; y: number });
        const b = { x0: W2 * m.x, y0: H2 * m.y, x1: W2 - W2 * m.x, y1: H2 - H2 * m.y };
        A = A ? { x0: Math.max(A.x0, b.x0), y0: Math.max(A.y0, b.y0), x1: Math.min(A.x1, b.x1), y1: Math.min(A.y1, b.y1) } : b;
      }
      const tight = areas.length ? areas.reduce((a, b) => (b === "title" || (b === "action" && a === "frame") ? b : a)) : undefined;
      const areaName = tight ? AREA[tight] : "";
      const check = tight ? `safeAreas.${tight}` : "";
      let fits = true;
      if (A) {
        const uw = U.x1 - U.x0, uh = U.y1 - U.y0, aw = A.x1 - A.x0, ah = A.y1 - A.y0;
        if (uw > aw + 0.01 || uh > ah + 0.01) {
          const need = Math.min(aw / uw, ah / uh), size = uw > aw + 0.01 ? `${r0(uw)} px wide; ${areaName} is ${r0(aw)} px` : `${r0(uh)} px tall; ${areaName} is ${r0(ah)} px`;
          if (sc || bg) {
            const f = Math.min(1, kMax / own.k, Math.max(need, kMin / own.k));
            const s = scaleAbout(f, centre(U));
            own = compose(s, own);
            U = mapBox(s, U);
            if (f > need + 1e-9) {
              fits = false;
              issue(L, check, "fail", `can't fit ${areaName}: it needs ${pct(need * (own.k / f))} of its size (${size}), but ${limitWhy(kMin)}; it is at ${pct(own.k)}, centred`, decideFix(isText));
              did.push(`scaled to ${pct(own.k)} (its limit) and centred in ${areaName}: it doesn't fit`);
            } else did.push(`scaled to ${pct(own.k)} to fit ${areaName}`);
          } else {
            fits = false;
            issue(L, check, "fail", `can't fit ${areaName} (${size}) and no scale rule lets it scale; it is centred in ${areaName}`, decideFix(isText));
            did.push(`centred in ${areaName}: it doesn't fit`);
          }
        }
      }
      // 3. pin to an edge / corner
      const pinned = { x: false, y: false };
      if (pin) {
        const m = typeof pin.margin === "number" ? { x: pin.margin, y: pin.margin } : pin.margin;
        let dx = 0, dy = 0;
        if (pin.to.endsWith("left")) dx = m.x - U.x0;
        if (pin.to.endsWith("right")) dx = W2 - m.x - U.x1;
        if (pin.to.startsWith("top")) dy = m.y - U.y0;
        if (pin.to.startsWith("bottom")) dy = H2 - m.y - U.y1;
        pinned.x = /left|right/.test(pin.to);
        pinned.y = /top|bottom/.test(pin.to);
        own = compose(translate(dx, dy), own);
        U = mapBox(translate(dx, dy), U);
        plan.pin = { to: pin.to, m };
        did.push(`pinned ${pin.to}, ${typeof pin.margin === "number" ? pin.margin : `${m.x} / ${m.y}`} px`);
      }
      // 4. into the safe area: the smallest move on each axis that isn't pinned; centred where it doesn't fit
      if (A) {
        const shift = (lo: number, hi: number, a0: number, a1: number) => (hi - lo > a1 - a0 + 0.01 ? (a0 + a1) / 2 - (lo + hi) / 2 : lo < a0 ? a0 - lo : hi > a1 ? a1 - hi : 0);
        const dx = pinned.x ? 0 : shift(U.x0, U.x1, A.x0, A.x1), dy = pinned.y ? 0 : shift(U.y0, U.y1, A.y0, A.y1);
        own = compose(translate(dx, dy), own);
        U = mapBox(translate(dx, dy), U);
        const out = overshoot(U, A);
        const conflict = (pinned.x && (out.left > 0.5 || out.right > 0.5)) || (pinned.y && (out.top > 0.5 || out.bottom > 0.5));
        if (conflict) issue(L, check, "fail", `the pin (${pin!.to}) puts it ${r0(Math.max(out.left, out.right, out.top, out.bottom))} px outside ${areaName} ${sidesText(out)}: the pin and the safe rule conflict`, `Decide which rule applies: a pin margin inside ${areaName}, or another area for this layer`);
        if (fits && (dx || dy)) did.push(`moved into ${areaName}`);
      }
      if (!bg && !pin && !did.length) did.push(`already inside ${areaName} with its offset from the frame centre`);
      plan.bg = bg?.mode;
    }

    // what can be written: Position / Scale with an expression are left as they are
    const delta = parent ? compose(invert(base), own) : own;
    if (!sameSim(delta, IDENTITY)) {
      if (posExpr(L)) {
        issue(L, "reformat.notMoved", acting ? "fail" : "warn", "Position has an expression: not moved (it keeps its source position)", "Change it yourself, or adjust the expression for the new size");
        own = parent ? base : IDENTITY;
      } else if (Math.abs(delta.k - 1) > 1e-9 && L.sc.ex) {
        // keep only the move: the centre of its box goes where the plan puts it
        const c0 = ref.length ? centre(union(ref.map((s) => s.box))) : C;
        const want = [own.k * c0[0] + own.t[0], own.k * c0[1] + own.t[1]], now = [base.k * c0[0] + base.t[0], base.k * c0[1] + base.t[1]];
        own = compose(translate(want[0] - now[0], want[1] - now[1]), base);
        issue(L, "reformat.notScaled", acting ? "fail" : "warn", "Scale has an expression: not scaled; moved so that its centre is where the plan puts it", "Change its size yourself, or adjust the expression");
      }
    }
    plan.sim = own;
    const d2 = parent ? compose(invert(base), own) : own;
    if (!sameSim(d2, IDENTITY)) {
      if (!parent) {
        op.k = d2.k;
        op.u = d2.t;
      } else {
        // the change in the parent's space: Psi = M^-1 Delta M for the parent chain M (exact while the parent's
        // transform doesn't change over time; computed at the first planned frame otherwise)
        const lv = (it?.lv ?? []).slice(1).filter((l): l is PLevel => !("clip" in l));
        const k0 = ref.length ? ref[0].k : 0;
        const M = chainAffine(lv, k0), det = M[0] * M[3] - M[1] * M[2];
        if (!lv.length || Math.abs(det) < 1e-12) issue(L, "reformat.parent", "fail", "it is parented, and its parent's transform can't be read here: not changed", "Decide: unparent it, or name its parent in the rule");
        else {
          const v = [(d2.k - 1) * M[4] + d2.t[0], (d2.k - 1) * M[5] + d2.t[1]];
          op.k = d2.k;
          op.u = [(M[3] * v[0] - M[2] * v[1]) / det, (-M[1] * v[0] + M[0] * v[1]) / det];
          if (lv.some(animatedLevel)) notes.push(`${where(L)}: its parent is animated, so its change was computed at ${tOf(ref[0]?.i ?? 0)} s; the check below measures every frame`);
        }
      }
    }
    // the precomp this layer shows is reformatted: its content moves by the change of the precomp's centre
    const pp = parent && precompShift.get(L.par!);
    if (pp) {
      op.u = [(op.u?.[0] ?? 0) + pp[0], (op.u?.[1] ?? 0) + pp[1]];
      op.k = op.k ?? 1;
    }
    if (L.src !== undefined && inp.reformatted.has(L.src)) {
      const shift: [number, number] = [C2[0] - C[0], C2[1] - C[1]];
      if (L.an.ex) issue(L, "reformat.notMoved", "fail", "the precomp it shows is reformatted, but its Anchor Point has an expression: its content is off by the change of the precomp's centre", "Adjust the expression, or the Anchor Point, yourself");
      else {
        op.an = shift;
        precompShift.set(L.i, shift);
        did.push("shows a reformatted precomp (Anchor Point moved by the change of the precomp's centre)");
      }
    }
    if (op.k !== undefined && Math.abs(op.k - 1) > 1e-9 && !did.some((s) => s.startsWith("scaled") || s.startsWith("cover") || s.startsWith("fit"))) did.push(`scaled to ${pct(own.k)}`);
    if (!acting && !hide && !L.isM && L.par === undefined && !did.length) did.push("no rule: kept its offset from the frame centre");
    // keys that move with it
    if (op.u) {
      const keys = [posKeys(L) && `${posKeys(L)} Position key${posKeys(L) === 1 ? "" : "s"}`, op.k !== undefined && Math.abs(op.k - 1) > 1e-9 && L.sc.k && `${L.sc.k} Scale key${L.sc.k === 1 ? "" : "s"}`].filter(Boolean);
      if (keys.length) plan.keys = `${keys.join(" and ")} mapped the same way`;
    }
    if (L.par !== undefined && !op.u && !acting && !did.length) did.push("follows its parent");
    if (L.lock && (op.u || op.an || op.hide)) did.push("locked (unlocked to change it, then locked again)");
    plan.op = op.u || op.an || op.hide || op.d3 ? op : undefined;
    plan.did = did.join("; ");

    // insight for layers no rule names (info: the verdict is about the user's rules)
    if (!acting && !hide && L.par === undefined && vis.length && !L.isM) {
      const F: Box = { x0: 0, y0: 0, x1: W, y1: H };
      const covered = vis.every((s) => inside(F, s.box, 0.5));
      const now = vis.map((s) => mapBox(own, s.box));
      if (covered) {
        const gaps = now.map((b) => ({ left: Math.max(0, b.x0), right: Math.max(0, W2 - b.x1), top: Math.max(0, b.y0), bottom: Math.max(0, H2 - b.y1) }));
        const worst = gaps.reduce((a, b) => ({ left: Math.max(a.left, b.left), right: Math.max(a.right, b.right), top: Math.max(a.top, b.top), bottom: Math.max(a.bottom, b.bottom) }));
        const most = Math.max(worst.left, worst.right, worst.top, worst.bottom);
        if (most > 0.5) issue(L, "reformat.unruled", "info", `covered the whole frame in the source; now leaves up to ${r0(most)} px uncovered ${sidesText(worst)}`, "Decide: a background rule (cover or fit) for it, if it should fill the new frame");
      } else if (settled.length === vis.length) {
        const o = now.map((b) => overshoot(b, F2)).reduce((a, b) => ({ left: Math.max(a.left, b.left), right: Math.max(a.right, b.right), top: Math.max(a.top, b.top), bottom: Math.max(a.bottom, b.bottom) }));
        const most = Math.max(o.left, o.right, o.top, o.bottom);
        if (most > 0.5) issue(L, "reformat.unruled", "info", `was inside the frame in the source; now up to ${r0(most)} px outside it ${sidesText(o)}`, "Decide: a safe, pin or background rule for it");
      }
    }
    // footage enlarged past its own pixels
    if (L.ty === "footage" && own.k > 1 + 1e-9 && it?.lv && ref.length) {
      const was = verticalScale(it.lv, ref[0].k), now = was * own.k;
      if (now > 1.0001) issue(L, "reformat.upscaled", "info", `footage now shown at ${pct(now)} of its own pixels (${pct(was)} in the source): it may look soft`);
    }
  }
  return { src: comp, name: inp.name, w: W2, h: H2, layers: comp.layers.map((l) => plans.get(l.i)!), issues, notes, precompShift };
}

// ---------- the result: predicted (dry run) and checked (after the edit) ----------

const simLevel = (s: Sim): PLevel => ({ n: "reformat", a: [0, 0], p: [s.t[0], s.t[1]], s: [s.k * 100, s.k * 100], r: 0 });

/**
 * The source comp's measurements as they will be in the new comp: each top-level layer's chain followed by its
 * plan. Hidden layers drop out; text inside a precomp that is itself reformatted is checked after the edit only.
 */
export function predict(plan: CompPlan, d: PData): { data: PData; notes: string[] } {
  const notes: string[] = [];
  const byI = new Map(plan.layers.map((l) => [l.i, l]));
  const rename = (w: string) => (w.startsWith(plan.src.name) ? plan.name + w.slice(plan.src.name.length) : w);
  const items: PItem[] = [];
  let skipped = 0;
  for (const it of d.items) {
    const lp = it.ti !== undefined ? byI.get(it.ti) : undefined;
    if (!lp) continue;
    if (lp.op?.hide) continue;
    if (it.nst && plan.precompShift.has(lp.i)) {
      skipped++;
      continue;
    }
    const out: PItem = { ...it, w: rename(it.w) };
    if (it.lv && it.rect) {
      out.lv = [...it.lv, simLevel(lp.sim)];
      const sh = !it.nst && plan.precompShift.get(lp.i);
      if (sh) out.rect = [-sh[0], -sh[1], plan.w, plan.h];
    }
    items.push(out);
  }
  if (skipped) notes.push(`${skipped} text layer${skipped === 1 ? "" : "s"} inside reformatted precomps: checked after the reformat, not predicted here`);
  return { data: { ...d, comp: { ...d.comp, name: plan.name, w: plan.w, h: plan.h }, items }, notes };
}

/**
 * Predicted data as Preflight's checks expect it: each item matched to the safe rules by name (the planning read
 * matched every layer with one pattern), and which rules match any layer in the tree (`names`), as the real read
 * reports them.
 */
export function forChecks(d: PData, rules: Rules, names: string[]): PData {
  const pats = (rules.safe ?? []).map((s) => re(s.layer));
  const items = d.items.map((it) => {
    const m = pats.flatMap((r, i) => (r.test(it.n) ? [i] : []));
    const { m: _old, ...rest } = it;
    return m.length ? { ...rest, m } : rest;
  });
  return { ...d, items, pm: pats.flatMap((r, i) => (names.some((n) => r.test(n)) ? [i] : [])) };
}

/** Cover / fit on every visible frame and pins on their planned frames, measured on (predicted or real) data of the new comp. */
export function checkRules(plan: CompPlan, d: PData): Finding[] {
  const out: Finding[] = [];
  const W = d.comp.w, H = d.comp.h, F: Box = { x0: 0, y0: 0, x1: W, y1: H };
  const tOf = (i: number) => Math.round(i * d.step * d.comp.fd * 1e6) / 1e6;
  const at = (i0: number, i1: number): number | [number, number] => (i0 === i1 ? tOf(i0) : [tOf(i0), tOf(i1)]);
  const byIdx = new Map<number, PItem>();
  for (const it of d.items) if (!it.nst && it.ti !== undefined && it.rect) byIdx.set(it.ti, it);
  const worse = (a: any, b: any) => ({ left: Math.max(a.left, b.left), right: Math.max(a.right, b.right), top: Math.max(a.top, b.top), bottom: Math.max(a.bottom, b.bottom) });
  for (const lp of plan.layers) {
    if (!lp.bg && !lp.pin) continue;
    const it = byIdx.get(lp.i);
    if (!it) continue;
    const ss = samplesOf(it);
    const where = it.w;
    if (lp.bg === "cover") {
      const samples = ss.map(({ i, box }) => {
        const g = { left: Math.max(0, box.x0), right: Math.max(0, W - box.x1), top: Math.max(0, box.y0), bottom: Math.max(0, H - box.y1) };
        return { i, value: Math.max(g.left, g.right, g.top, g.bottom) > 0.5 ? g : null };
      });
      for (const r of runsOf(samples, worse)) {
        const most = Math.max(r.worst.left, r.worst.right, r.worst.top, r.worst.bottom);
        out.push({ check: "reformat.cover", severity: "fail", where, at: at(r.i0, r.i1), message: `doesn't cover the frame: up to ${r0(most)} px uncovered ${sidesText(r.worst)}`, fix: "scale it up or move it" });
      }
    } else if (lp.bg === "fit") {
      const samples = ss.map(({ i, box }) => {
        if (!onScreen(box, W, H)) return { i, value: null };
        const o = overshoot(box, F);
        return { i, value: Math.max(o.left, o.right, o.top, o.bottom) > 0.5 ? o : null };
      });
      for (const r of runsOf(samples, worse)) {
        const most = Math.max(r.worst.left, r.worst.right, r.worst.top, r.worst.bottom);
        out.push({ check: "reformat.fit", severity: "fail", where, at: at(r.i0, r.i1), message: `cut off by the frame: up to ${r0(most)} px ${sidesText(r.worst)}`, fix: "scale it down or move it" });
      }
    }
    if (lp.pin && lp.ref?.length) {
      const fd = d.step * d.comp.fd;
      const boxes = ss.filter((s) => lp.ref!.some((t) => Math.abs(t - tOf(s.i)) < fd / 2)).map((s) => s.box);
      if (!boxes.length) {
        out.push({ check: "reformat.pin", severity: "warn", where, message: "the pin couldn't be measured: the layer isn't visible on the frames it was planned on", fix: "check it with ae_get_layer_bounds" });
        continue;
      }
      const U = union(boxes), m = lp.pin.m, to = lp.pin.to, off: string[] = [];
      if (to.endsWith("left") && Math.abs(U.x0 - m.x) > 0.5) off.push(`${r1(U.x0)} px from the left edge`);
      if (to.endsWith("right") && Math.abs(W - U.x1 - m.x) > 0.5) off.push(`${r1(W - U.x1)} px from the right edge`);
      if (to.startsWith("top") && Math.abs(U.y0 - m.y) > 0.5) off.push(`${r1(U.y0)} px from the top edge`);
      if (to.startsWith("bottom") && Math.abs(H - U.y1 - m.y) > 0.5) off.push(`${r1(H - U.y1)} px from the bottom edge`);
      if (off.length) out.push({ check: "reformat.pin", severity: "fail", where, message: `${off.join(", ")}; the pin (${to}) asks for ${m.x === m.y ? m.x : `${m.x} / ${m.y}`} px`, fix: "move it to the margin" });
    }
  }
  return out;
}

/**
 * The plan against the real result: each top-level layer's box predicted from the source and measured in the new
 * comp, at the times both have. A difference means After Effects did something the plan didn't model (an
 * expression, a parent animated differently): reported, with where it is largest.
 */
export function residuals(pred: PData, actual: PData): Finding[] {
  const out: Finding[] = [];
  const tOf = (d: PData, i: number) => Math.round(i * d.step * d.comp.fd * 1e6) / 1e6;
  const top = (d: PData) => new Map(d.items.filter((it) => !it.nst && it.ti !== undefined && it.rect).map((it) => [it.ti!, it]));
  const A = top(actual);
  for (const [ti, p] of top(pred)) {
    const a = A.get(ti);
    if (!a) continue;
    const pt = new Map(samplesOf(p).map((s) => [tOf(pred, s.i), s.box]));
    let worst = 0, when = 0;
    for (const s of samplesOf(a)) {
      const t = tOf(actual, s.i), b = pt.get(t);
      if (!b) continue;
      const e = Math.max(Math.abs(b.x0 - s.box.x0), Math.abs(b.y0 - s.box.y0), Math.abs(b.x1 - s.box.x1), Math.abs(b.y1 - s.box.y1));
      if (e > worst) {
        worst = e;
        when = t;
      }
    }
    if (worst > 0.5)
      out.push({ check: "reformat.result", severity: "fail", where: a.w, at: when, message: `the result is up to ${r1(worst)} px away from the plan`, fix: "check it (an expression, or a parent animated differently, can move it): ae_get_layer_bounds and ae_render_frame show where it is" });
  }
  return out;
}

/**
 * The planner's reasons go on the measured finding they explain (same check and layer: "fix: <reason>. Decide:
 * ..."), so one problem is counted once; reasons nothing measured become findings of their own.
 */
export function mergeIssues(findings: Finding[], issues: Issue[]): Finding[] {
  const out = findings.map((f) => ({ ...f }));
  for (const is of issues) {
    const tail = is.i !== undefined ? ` > ${is.i}: ${is.n}` : null;
    const f = tail ? out.find((x) => x.check === is.check && !!x.where && x.where.endsWith(tail) && (x.where.startsWith(is.comp + " > ") || x.where.includes(` > ${is.comp}`) || x.where.includes(`: ${is.comp} >`))) : undefined;
    if (f && !(f as any).explained) {
      f.fix = `${is.message}. ${is.fix ?? f.fix ?? ""}`.trim();
      (f as any).explained = true;
      continue;
    }
    if (f) continue;
    out.push({ check: is.check, severity: is.severity, where: is.where, message: is.message, ...(is.fix ? { fix: is.fix } : {}) });
  }
  for (const f of out) delete (f as any).explained;
  return out;
}

/** Preflight's spec for the result: the safe rules as layersMustBeIn (text in general isn't asked about) and the cap height. */
export function checkSpec(rules: Rules, step: number, comp?: number | string) {
  const safe = rules.safe ?? [];
  return {
    name: "your reformat rules",
    ...(comp !== undefined ? { comp } : {}),
    ...(safe.length || rules.safeAreas
      ? { safeAreas: { ...(rules.safeAreas ?? {}), textMustBeIn: "none" as const, ...(safe.length ? { layersMustBeIn: safe.map((s) => ({ layer: s.layer, area: s.area })) } : {}), ...(step > 1 ? { sampleEveryFrames: step } : {}) } }
      : step > 1 ? { safeAreas: { textMustBeIn: "none" as const, sampleEveryFrames: step } } : {}),
    ...(rules.minCapHeightPx !== undefined ? { text: { minCapHeightPx: rules.minCapHeightPx } } : {}),
  };
}

/** The plan as report lines: every layer a rule names, then the others in one line per kind of change. */
export function planLines(plan: CompPlan): string[] {
  const lines: string[] = [];
  const others = new Map<string, string[]>();
  for (const lp of plan.layers) {
    if (lp.rules.length || /track matte|locked|3D|precomp|switched/.test(lp.did))
      lines.push(`  ${lp.i}: ${lp.n}${lp.rules.length ? ` [${lp.rules.join(", ")}]` : ""}: ${[lp.did || "unchanged", lp.keys].filter(Boolean).join("; ")}`);
    else others.set(lp.did || "unchanged", [...(others.get(lp.did || "unchanged") ?? []), `${lp.i}: ${lp.n}`]);
  }
  const C = [plan.src.w / 2, plan.src.h / 2], C2 = [plan.w / 2, plan.h / 2];
  for (const [did, names] of others) {
    const what = did === "no rule: kept its offset from the frame centre" ? `no rule: kept their offset from the frame centre (moved ${r1(C2[0] - C[0])}, ${r1(C2[1] - C[1])} px)` : did;
    lines.push(`  ${names.length > 6 ? `${names.slice(0, 6).join(", ")} (+${names.length - 6} more)` : names.join(", ")}: ${what}`);
  }
  return lines;
}
