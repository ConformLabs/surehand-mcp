// Precomp surgery planner: from the facts the ExtendScript read (tools/surgery.ts), decide exactly what an
// un-precompose or a deep duplicate does, every expression rewrite (by source position, see expr.ts), and every
// reason it can't be done exactly. Pure functions: no After Effects, so every rule is tested on its own.
import { analyzeExpression, applyEdits, literal, snippet, type CompRef, type Edit, type ExprFacts } from "./expr.js";

// ---------- facts (as read by the ExtendScript) ----------

export interface CompF {
  id: number;
  name: string;
  w: number;
  h: number;
  par: number;
  fps: number;
  dur: number;
  /** motion blur switch, shutter angle / phase, samples per frame, adaptive limit, frame blending switch */
  mb?: boolean;
  sa?: number;
  sp?: number;
  spf?: number;
  asl?: number;
  fb?: boolean;
  /** preserve frame rate / resolution when nested */
  pnfr?: boolean;
  pnr?: boolean;
  /** Essential Graphics controllers, and the template name */
  egp?: number;
  egpName?: string;
  usedIn?: number[];
  nl: number;
}

/** one expression anywhere in the project */
export interface ExprF {
  /** comp id, layer index, layer name */
  c: number;
  l: number;
  ln: string;
  /** property index path from the layer, its match names, and its display path */
  p: number[];
  mp: string[];
  pn: string;
  x: string;
  /** expression error text ("" when none) */
  err: string;
  on: boolean;
}

export interface TransformF {
  /** static values at the layer's start (only meaningful when nothing is keyed or driven by an expression) */
  a: number[];
  p: number[];
  s: number[];
  r: number;
  /** any transform property keyed / with an expression */
  keyed: boolean;
  expr: boolean;
}

export interface LFacts {
  i: number;
  n: string;
  /** precomp source id */
  src: number;
  enabled: boolean;
  locked: boolean;
  start: number;
  in: number;
  out: number;
  stretch: number;
  timeRemap: boolean;
  effects: number;
  masks: number;
  styles: boolean;
  /** BlendingMode name, e.g. "NORMAL" */
  blend: string;
  adj: boolean;
  d3: boolean;
  collapse: boolean;
  mb: boolean;
  /** FrameBlendingType name, "NO_FRAME_BLEND" when off */
  fbt: string;
  hasTM: boolean;
  isTM: boolean;
  guide: boolean;
  preserveT: boolean;
  opacity: { v: number; keyed: boolean; expr: boolean };
  tf: TransformF;
  /** parent layer index in P (0: none) */
  par: number;
  /** layers in P parented to L */
  children: number[];
  /** Essential Properties on the layer (master properties) */
  eps: number;
  /** AutoOrientType name */
  autoOrient: string;
  /** the layer's own markers */
  markers: number;
  /** expressions on L outside Transform > Anchor Point / Position / Scale / Rotation */
  otherExprs: string[];
  /** L has audio switched on and its levels aren't 0 dB static */
  audioChanged?: boolean;
}

export interface CLayerF {
  i: number;
  n: string;
  /** "av", "text", "shape", "null", "camera", "light", "adjustment", "audio" */
  type: string;
  enabled: boolean;
  locked: boolean;
  start: number;
  in: number;
  out: number;
  par: number;
  blend: string;
  preserveT: boolean;
  d3: boolean;
  guide: boolean;
  solo: boolean;
  mb: boolean;
  fbt: string;
  /** TrackMatteType name ("NO_TRACK_MATTE" when none) and the matte layer's index (new-style mattes) */
  tm: string;
  tml: number;
  isTM: boolean;
  opacity: { v: number; keyed: boolean; expr: boolean };
  /** effect parameters that point at a layer of the same comp (Layer Control, Displacement Map...) */
  li: { p: number[]; pn: string; v: number; keyed: boolean; expr: boolean }[];
}

export interface BoundsF {
  /** C layer index */
  ci: number;
  /** C time */
  t: number;
  /** how far outside C's frame (px) and whether it shows in P */
  by: number;
}

export interface UFacts {
  /** every item id in the project when it was read (what a cleanup must leave) */
  ids?: number[];
  project: string | null;
  P: CompF;
  C: CompF;
  L: LFacts;
  pLayers: { i: number; n: string; src?: number }[];
  cLayers: CLayerF[];
  /** every comp in the project: names decide what comp("X") means */
  comps: { id: number; name: string }[];
  /** comp ids in the render queue */
  rq: number[];
  exprs: ExprF[];
  bounds: BoundsF[];
  /** L's rotation / skew in P: the frame check is exact only without */
  rotated?: boolean;
}

export interface DFacts {
  ids?: number[];
  project: string | null;
  root: number;
  /** every comp in the tree (root first), with its layers' precomp sources */
  tree: (CompF & { layers: { i: number; n: string; src?: number; eps?: number }[]; folder?: string })[];
  comps: { id: number; name: string }[];
  /** every item name (folders, footage, comps): new names must be unique */
  itemNames: string[];
  exprs: ExprF[];
}

// ---------- results ----------

export interface Rewrite {
  c: number;
  l: number;
  ln: string;
  p: number[];
  pn: string;
  /** where, for reports: "Main > 3 \"Title\" > Transform/Position" */
  where: string;
  old: string;
  new: string;
  /** the text for the rehearsal on a scratch copy (rewrites that point at the real comp by name are left out), or null: leave it */
  rehearse: string | null;
  snippet: string;
  /** the expression is switched off (rewritten anyway, so it stays right when switched on) */
  off?: boolean;
}

export interface Problem {
  text: string;
  /** what may be overridden: "expressions" (rewrite can't be done safely) or "bounds" (layers beyond the precomp's frame) */
  override?: "expressions" | "bounds";
}

export type Override = "expressions" | "bounds";

export interface MovedLayer {
  ci: number;
  from: string;
  to: string;
  /** final index in P */
  index: number;
  start: number;
  in: number;
  out: number;
  /** completely outside the precomp layer's time span: moved, switched off */
  off: boolean;
  /** what changed in its timing, for the report */
  timing?: string;
  /** parent after the move: a C layer index, "null" (the new null) or none */
  parent: number | "null" | null;
  /** track matte to set (new-style mattes): the matte's C index and type */
  matte?: { ci: number; type: string };
}

export interface UPlan {
  kind: "unprecompose";
  problems: Problem[];
  warnings: string[];
  notes: string[];
  /** the null that carries L's transform (null: baked away) */
  nullLayer: { name: string; index: number } | null;
  nullNote?: string;
  moved: MovedLayer[];
  /** how far P's layers below L move */
  shift: number;
  /** expressions on layers that stay where they are (P's other layers, other comps, C's own layers) */
  rewrites: Rewrite[];
  /** expressions on the moved layers (c = C, l = C index), and on L's transform (copied to the null: l = L's index) */
  movedRewrites: Rewrite[];
  nullRewrites: Rewrite[];
  /** effect parameters pointing at a layer: set to the moved layer's final index */
  layerParams: { ci: number; p: number[]; pn: string; toCi: number }[];
  /** single visible layer: L's blend mode and opacity carried over */
  carry?: { ci: number; blend?: string; opacity?: number };
  removeC: boolean;
  keepC: string;
  /** what could explain a DIFFERS verdict, most likely first */
  risks: string[];
}

export interface DPlan {
  kind: "deep_duplicate";
  problems: Problem[];
  warnings: string[];
  notes: string[];
  /** original comp id -> new name, in duplication order (root first) */
  copies: { id: number; from: string; to: string; swaps: { i: number; n: string; src: number }[] }[];
  rewrites: Rewrite[];
  folder?: string;
  risks: string[];
}

// ---------- helpers ----------

const q = (s: string) => `"${s}"`;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const props = (n: number) => `${n} Essential ${n === 1 ? "Property" : "Properties"}`;

/** A name not in `taken` (then added): "Name", else "Name 2", "Name 3"... */
export function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
  taken.add(name);
  return name;
}

const where = (comp: string, e: { l: number; ln: string; pn: string }) => `${comp} > ${e.l} ${q(e.ln)} > ${e.pn}`;

/** Comps by name, and which names more than one comp has (comp("X") can't be told apart). */
function compNames(comps: { id: number; name: string }[]) {
  const byName = new Map<string, number[]>();
  for (const c of comps) byName.set(c.name, [...(byName.get(c.name) ?? []), c.id]);
  return byName;
}

// ---------- un-precompose ----------

/** what an expression's comp references mean, from where it is */
interface ExprCtx {
  /** the comp the expression's layer is in after the surgery is P (moved layers, L's transform on the null) */
  movedFromC: boolean;
  /** the expression is on a layer of P (its thisComp is P before the surgery) */
  inP: boolean;
  /** the layer's index before and after (when it changes) */
  index?: { from: number; to: number };
  /** the layer gets the new null as parent (a top-level moved layer) */
  newParent?: boolean;
  /** the layer is trimmed (its inPoint / outPoint change) */
  trimmed?: boolean;
}

interface UCtx {
  f: UFacts;
  C: string;
  P: string;
  nameOf: Map<number, string>;
  /** comp ids by name */
  byName: Map<string, number[]>;
  removeC: boolean;
  /** final index of a P layer (old index), or null for L */
  pIndex: (i: number) => number | null;
  /** final name and index of a C layer */
  moved: Map<number, MovedLayer>;
  /** C's first layer with this name */
  cFirst: Map<string, number>;
  pFirst: Map<string, number>;
  shift: number;
  timeShift: number;
}

/**
 * The rewrites of one expression. `edits`: for the real run; `rehearse`: for the scratch copy (references to P by
 * name are left as they are there: they point at the real P, which the rehearsal doesn't change).
 */
function rewriteExpr(u: UCtx, e: ExprF, ctx: ExprCtx, facts: ExprFacts): { edits: Edit[]; rehearse: Edit[]; problems: Problem[] } {
  const edits: Edit[] = [], rehearse: Edit[] = [], problems: Problem[] = [];
  const who = where(u.nameOf.get(e.c) ?? `comp ${e.c}`, e);
  const off = !e.on;
  // a switched-off expression is rewritten where that is exact, but never blocks the surgery
  const problem = (text: string, override: Problem["override"] = "expressions") => {
    if (!off) problems.push({ text: `${who}: ${text}`, override });
  };
  if (!facts.ok) {
    problem(`the expression can't be parsed (${facts.parseError}), so its references can't be checked`);
    return { edits, rehearse, problems };
  }
  if (facts.evalUsed) problem("uses eval(), so what it refers to can't be known");
  if (e.err && e.on && ctx.movedFromC) problem(`has an error before the surgery ("${e.err.split("\n")[0]}"); in "${u.P}" it could start working and change the picture. Fix or switch it off first`);
  const cIdx = (c: CompRef) => (c.self ? (ctx.inP ? u.f.P.id : ctx.movedFromC ? u.f.C.id : e.c) : c.name === null ? null : (u.byName.get(c.name) ?? []));
  for (const c of facts.comps) {
    // thisComp of a layer that stays where it is (not in P): its own comp, unaffected
    if (c.self && !ctx.movedFromC && !ctx.inP) continue;
    const ids = cIdx(c);
    const isP = c.self ? ids === u.f.P.id : Array.isArray(ids) && ids.includes(u.f.P.id);
    const isC = c.self ? ids === u.f.C.id : Array.isArray(ids) && ids.includes(u.f.C.id);
    const ambiguous = !c.self && Array.isArray(ids) && ids.length > 1 && (isP || isC);
    if (ambiguous) {
      problem(`${c.text}: ${ids.length} comps are named ${q(c.name!)}, so which one it means can't be told`);
      continue;
    }
    // a computed comp name could be P: only a problem where P's layers matter (by index, count, or L by name)
    if (!c.self && c.name === null) {
      const u2 = c.use;
      const risky = u2.kind === "escape" || (u2.kind === "layer" && (u2.by !== "name" || u2.name === u.f.L.n)) || (u2.kind === "member" && u2.name === "numLayers");
      if (risky && u.shift !== 0) problem(`${c.text}: the comp's name is computed, so it can't be told whether it means "${u.P}", whose layer indices change`);
      else if (ctx.movedFromC && u.timeShift !== 0) problem(`${c.text}: reads another comp at the current time, which moves by ${r4(u.timeShift)}s`);
      continue;
    }
    // expressions of the moved layers: thisComp was C, and is P after the surgery
    if (ctx.movedFromC && c.self) {
      const use = c.use;
      if (use.kind === "layer" && use.by === "name") {
        const ci = u.cFirst.get(use.name);
        if (ci !== undefined) {
          const to = u.moved.get(ci)!.to;
          if (to !== use.name) {
            edits.push({ range: use.argRange, text: literal(to, use.quote) });
            rehearse.push({ range: use.argRange, text: literal(to, use.quote) });
          }
        } else if (u.removeC) problem(`${c.text}.layer(${q(use.name)}): "${u.C}" has no layer of that name (the reference is broken now); with "${u.C}" removed it can't be kept as it is`);
        else {
          // broken now (no such layer in C): kept broken, exactly, by pointing it at C
          const text = `comp(${literal(u.C, '"')})`;
          edits.push({ range: c.range, text });
          rehearse.push({ range: c.range, text });
        }
      } else if (use.kind === "layer" && use.by === "index") {
        const m = u.moved.get(use.index);
        if (m) {
          if (m.index !== use.index) {
            edits.push({ range: use.argRange, text: String(m.index) });
            rehearse.push({ range: use.argRange, text: String(m.index) });
          }
        } else if (u.removeC) problem(`${c.text}.layer(${use.index}): "${u.C}" has no layer ${use.index}; with "${u.C}" removed it can't be kept as it is`);
        else {
          const text = `comp(${literal(u.C, '"')})`;
          edits.push({ range: c.range, text });
          rehearse.push({ range: c.range, text });
        }
      } else if (use.kind === "layer") problem(`${use.text}: picks a layer of "${u.C}" by a computed name or index, which can't be rewritten exactly once the layers are in "${u.P}"`);
      else if (use.kind === "member") {
        if (u.removeC) problem(`${c.text}.${use.name} means "${u.C}"'s ${use.name}; it would have to become comp(${q(u.C)}).${use.name}, but "${u.C}" is to be removed`);
        else {
          const text = `comp(${literal(u.C, '"')})`;
          edits.push({ range: c.range, text });
          rehearse.push({ range: c.range, text });
        }
        if (use.name === "marker" && u.timeShift !== 0) problem(`${c.text}.marker: "${u.C}"'s marker times are in "${u.C}"'s time, which is ${r4(u.timeShift)}s off "${u.P}"'s`);
      } else problem(`${use.text}: thisComp is used as a value, so what it is used for can't be followed and rewritten`);
      continue;
    }
    // references to C by name from the moved layers: still C (it stays), unless it is removed
    if (isC && !isP) {
      if (u.removeC) problem(`${c.text}: refers to "${u.C}", which is to be removed`);
      else if (ctx.movedFromC && u.timeShift !== 0) problem(`${c.text}: reads "${u.C}" at the current time, which moves by ${r4(u.timeShift)}s once the layer is in "${u.P}"`);
      continue;
    }
    if (!isP) {
      if (ctx.movedFromC && u.timeShift !== 0) problem(`${c.text}: reads another comp at the current time, which moves by ${r4(u.timeShift)}s once the layer is in "${u.P}"`);
      continue;
    }
    // references to P: its layers below L move down by `shift`, and L is gone
    const byNameRef = !c.self; // comp("P") by name: in the rehearsal it points at the real P (unchanged)
    const use = c.use;
    if (use.kind === "layer" && use.by === "name") {
      if (u.pFirst.get(use.name) === u.f.L.i) problem(`${use.name === u.f.L.n ? `${c.text}.layer(${q(use.name)})` : c.text}: refers to the precomp layer ${q(u.f.L.n)}, which the un-precompose removes`);
    } else if (use.kind === "layer" && use.by === "index") {
      if (use.index === u.f.L.i) problem(`${c.text}.layer(${use.index}): refers to the precomp layer ${q(u.f.L.n)} by index, which the un-precompose removes`);
      else if (use.index > u.f.pLayers.length) problem(`${c.text}.layer(${use.index}): "${u.P}" has no layer ${use.index} now, but would have after the surgery`);
      else {
        const to = u.pIndex(use.index)!;
        if (to !== use.index) {
          edits.push({ range: use.argRange, text: String(to) });
          if (!byNameRef) rehearse.push({ range: use.argRange, text: String(to) });
        }
      }
    } else if (use.kind === "layer") {
      if (u.shift !== 0 || use.text.includes(u.f.L.n)) problem(`${use.text}: picks a layer of "${u.P}" by a computed name or index; the layers below ${q(u.f.L.n)} move down by ${u.shift} and ${q(u.f.L.n)} is removed`);
    } else if (use.kind === "member") {
      if (use.name === "numLayers" && u.shift !== 0) problem(`${c.text}.numLayers: "${u.P}" has ${u.shift > 0 ? u.shift + " more" : -u.shift + " fewer"} layers after the surgery`);
    } else if (u.shift !== 0) problem(`${use.text}: the comp is used as a value, so what it is used for can't be followed`);
  }
  if (ctx.index && ctx.index.from !== ctx.index.to) {
    if (facts.index.length) problem(`uses its own layer index (index), which changes from ${ctx.index.from} to ${ctx.index.to}`);
    if (facts.random.length) problem(`uses ${[...new Set(facts.random)].join(", ")}: its random seed depends on the layer's index, which changes from ${ctx.index.from} to ${ctx.index.to}`);
  }
  if (ctx.movedFromC) {
    if (facts.time.length && u.timeShift !== 0) problem(`uses time, which is ${r4(u.timeShift)}s later in "${u.P}" than in "${u.C}" (the precomp layer starts at ${r4(u.timeShift)}s)`);
    if (facts.space.length) problem(`uses ${[...new Set(facts.space)].join(", ")}, whose comp space is "${u.P}" instead of "${u.C}" after the move`);
    if (facts.parent && ctx.newParent) problem(`reads its parent, and the layer gets the new null as its parent`);
    if (ctx.trimmed && /\b(?:inPoint|outPoint)\b/.test(e.x)) problem(`reads inPoint / outPoint, and the layer is trimmed to the precomp layer's time span`);
  }
  return { edits, rehearse, problems };
}

export interface UOptions {
  removeSource?: boolean;
  bakeNull?: boolean;
  override?: Override[];
}

const isIdentity = (L: LFacts, P: CompF, C: CompF) =>
  !L.tf.keyed && !L.tf.expr && L.par === 0 && L.tf.r === 0 && L.tf.s[0] === 100 && L.tf.s[1] === 100 &&
  L.tf.p[0] - L.tf.a[0] === 0 && L.tf.p[1] - L.tf.a[1] === 0 && C.par === P.par && L.autoOrient === "NO_AUTO_ORIENT";

/** The un-precompose plan: what moves where, every rewrite and every reason it can't be done exactly. */
export function planUnprecompose(f: UFacts, o: UOptions = {}): UPlan {
  const { P, C, L } = f;
  const problems: Problem[] = [], warnings: string[] = [], notes: string[] = [], risks: string[] = [];
  const block = (text: string) => problems.push({ text });
  // ---- the precomp layer itself ----
  if (!L.enabled) block(`${q(L.n)} is switched off, so the precomp isn't visible: nothing to un-precompose exactly`);
  if (L.guide) block(`${q(L.n)} is a guide layer (not rendered when "${P.name}" is nested or rendered)`);
  if (L.timeRemap) block(`${q(L.n)} has time remapping: the remapped time can't be carried over to the layers`);
  if (L.stretch !== 100) block(`${q(L.n)} is time-stretched (${r4(L.stretch)}%): the layers' timing can't be stretched the same way exactly`);
  if (L.effects) block(`${q(L.n)} has ${plural(L.effects, "effect")}; they apply to the precomp's whole picture and would be lost`);
  if (L.masks) block(`${q(L.n)} has ${plural(L.masks, "mask")}; they cut the precomp's whole picture and would be lost`);
  if (L.styles) block(`${q(L.n)} has layer styles; they apply to the precomp's whole picture and would be lost`);
  if (L.adj) block(`${q(L.n)} is an adjustment layer`);
  if (L.d3) block(`${q(L.n)} is a 3D layer: flattening its layers into "${P.name}" changes how they are lit and sorted`);
  if (L.collapse) block(`${q(L.n)} collapses transformations: its layers already render in "${P.name}"'s space; un-precomposing changes how they are composited`);
  if (L.hasTM) block(`${q(L.n)} uses a track matte: the matte applies to the precomp's whole picture`);
  if (L.isTM) block(`${q(L.n)} is the track matte of another layer`);
  if (L.preserveT) block(`${q(L.n)} has Preserve Underlying Transparency on: it applies to the precomp's whole picture`);
  if (L.mb && P.mb) block(`${q(L.n)} has motion blur on in "${P.name}": its own motion blurs the whole precomp, which the layers can't reproduce`);
  if (L.fbt !== "NO_FRAME_BLEND" && P.fb) block(`${q(L.n)} has frame blending on`);
  if (L.eps) block(`${q(L.n)} has ${props(L.eps)} (master properties): its own values for "${C.name}" would be lost`);
  if (C.egp) block(`"${C.name}" has ${plural(C.egp, "Essential Graphics controller")}: each precomp layer can override them, which a layer moved into "${P.name}" can't`);
  if (L.otherExprs.length) block(`${q(L.n)} has expressions on ${L.otherExprs.join(", ")}, which only the precomp layer has`);
  if (L.audioChanged) block(`${q(L.n)}'s audio levels aren't 0 dB, which applies to the precomp's whole sound`);
  // ---- comp settings that change what the layers look like ----
  if (C.fps !== P.fps) block(`"${C.name}" is ${r4(C.fps)} fps and "${P.name}" is ${r4(P.fps)} fps: its layers would be sampled at other times`);
  if (C.pnfr) block(`"${C.name}" preserves its frame rate when nested`);
  if (C.pnr) block(`"${C.name}" preserves its resolution when nested`);
  if (C.par !== P.par) block(`"${C.name}" and "${P.name}" have different pixel aspect ratios (${C.par} and ${P.par})`);
  // ---- C's layers ----
  const cl = f.cLayers;
  const shown = cl.filter((x) => x.enabled && !x.guide && x.type !== "audio" && x.type !== "null" && x.type !== "camera" && x.type !== "light");
  for (const x of cl) {
    const name = `"${C.name}" > ${x.i} ${q(x.n)}`;
    if (x.type === "camera" || x.type === "light") block(`${name} is a ${x.type}: it lights or frames "${C.name}"'s 3D layers, and would act on "${P.name}"'s instead`);
    else if (x.d3) block(`${name} is a 3D layer: it is seen through "${C.name}"'s camera (or the default camera of a ${C.w}x${C.h} comp), not "${P.name}"'s`);
    if (x.type === "adjustment" && x.enabled) block(`${name} is an adjustment layer: in "${P.name}" it would also adjust the layers below ${q(L.n)}`);
    if (x.enabled && x.blend !== "NORMAL" && !x.guide && x.type !== "audio") block(`${name} uses the ${x.blend.toLowerCase().replace(/_/g, " ")} blend mode: in "${P.name}" it would blend with the layers below ${q(L.n)} instead of with transparency`);
    if (x.preserveT && x.enabled) block(`${name} has Preserve Underlying Transparency on: in "${P.name}" it would see the layers below ${q(L.n)}`);
    if (x.solo) block(`${name} is soloed`);
    if (x.mb && x.enabled && (C.mb !== P.mb || C.sa !== P.sa || C.sp !== P.sp || C.spf !== P.spf || C.asl !== P.asl))
      block(`${name} has motion blur on, and "${C.name}" and "${P.name}" have different motion blur settings (switch, shutter angle / phase or samples)`);
    if (x.fbt !== "NO_FRAME_BLEND" && x.enabled && C.fb !== P.fb) block(`${name} has frame blending on, and the comps' frame blending switches differ`);
    for (const p of x.li) if (p.keyed || p.expr) block(`${name} > ${p.pn} points at a layer and is ${p.keyed ? "keyframed" : "driven by an expression"}: it can't be pointed at the moved layers exactly`);
  }
  // ---- opacity and blend mode of L: they apply to the precomp's picture as a whole ----
  let carry: UPlan["carry"];
  const opacityPlain = !L.opacity.keyed && !L.opacity.expr && L.opacity.v === 100;
  if (L.blend !== "NORMAL" || !opacityPlain) {
    const one = shown.length === 1 ? shown[0] : null;
    if (!one) {
      if (L.blend !== "NORMAL") block(`${q(L.n)} uses the ${L.blend.toLowerCase().replace(/_/g, " ")} blend mode, and "${C.name}" has ${shown.length} visible layers: the mode applies to their combined picture, not to each`);
      if (!opacityPlain) block(`${q(L.n)}'s opacity is ${L.opacity.keyed || L.opacity.expr ? "animated" : `${r4(L.opacity.v)}%`}, and "${C.name}" has ${shown.length} visible layers: opacity applies to their combined picture and doesn't distribute`);
    } else {
      carry = { ci: one.i };
      if (L.blend !== "NORMAL") {
        if (one.blend !== "NORMAL" || one.tm !== "NO_TRACK_MATTE") block(`${q(L.n)} uses the ${L.blend.toLowerCase()} blend mode, and its one visible layer ${q(one.n)} ${one.tm !== "NO_TRACK_MATTE" ? "uses a track matte" : `has its own blend mode`}`);
        else carry.blend = L.blend;
      }
      if (!opacityPlain) {
        if (L.opacity.keyed || L.opacity.expr) block(`${q(L.n)}'s opacity is animated; it can't be carried over to ${q(one.n)} exactly`);
        else if (one.opacity.keyed || one.opacity.expr) block(`${q(L.n)}'s opacity is ${r4(L.opacity.v)}% and ${q(one.n)}'s opacity is animated: they can't be combined exactly`);
        else carry.opacity = r4((L.opacity.v * one.opacity.v) / 100);
      }
    }
  }
  // ---- the null that carries L's transform ----
  const identity = isIdentity(L, P, C);
  const keepNull = !(o.bakeNull && identity && L.children.length === 0);
  let nullNote: string | undefined;
  if (o.bakeNull && !keepNull) nullNote = `${q(L.n)}'s transform is the identity (not animated, no parent, scale 100%, no rotation, anchor point on its position), so no null is needed`;
  else if (o.bakeNull)
    nullNote = `A null is kept: baking it away is exact only when ${q(L.n)}'s transform is the identity${L.children.length ? ` and no layer is parented to it (${plural(L.children.length, "layer")} are)` : ""}; here it ${identity ? "has children" : "is not"}`;
  if (!identity && !L.tf.keyed && !L.tf.expr && (L.tf.r !== 0 || L.tf.s[0] !== 100 || L.tf.s[1] !== 100 || !Number.isInteger(L.tf.p[0] - L.tf.a[0]) || !Number.isInteger(L.tf.p[1] - L.tf.a[1])))
    risks.push(
      `${q(L.n)} is ${[L.tf.s[0] !== 100 || L.tf.s[1] !== 100 ? `scaled (${r4(L.tf.s[0])}%, ${r4(L.tf.s[1])}%)` : "", L.tf.r ? `rotated (${r4(L.tf.r)}°)` : "", !Number.isInteger(L.tf.p[0] - L.tf.a[0]) || !Number.isInteger(L.tf.p[1] - L.tf.a[1]) ? "at a sub-pixel position" : ""].filter(Boolean).join(", ")}: the precomp was rendered first and then resampled once as a whole; after un-precomposing each layer is transformed in one step, so edges and sharp detail can differ slightly (often a DIFFERS verdict even though the result is better)`,
    );
  if (L.tf.keyed || L.tf.expr) risks.push(`${q(L.n)}'s transform is animated: where it scales or rotates, resampling differs as above`);
  const nk = keepNull ? 1 : 0;
  const k = cl.length;
  const shift = k + nk - 1;
  const pIndex = (i: number) => (i === L.i ? null : i < L.i ? i : i + shift);
  // ---- names ----
  const taken = new Set(f.pLayers.map((x) => x.n));
  const nullName = keepNull ? uniqueName(`${L.n} (null)`, taken) : "";
  const moved = new Map<number, MovedLayer>();
  const Ls = L.start;
  for (const x of cl) {
    const to = uniqueName(x.n, taken);
    const start = x.start + Ls, inP = x.in + Ls, outP = x.out + Ls;
    const nin = Math.max(inP, L.in), nout = Math.min(outP, L.out);
    const off = !(nin < nout);
    const timing: string[] = [];
    if (Ls !== 0) timing.push(`moved ${Ls > 0 ? "later" : "earlier"} by ${r4(Math.abs(Ls))}s`);
    if (off) timing.push(`outside ${q(L.n)}'s time span (${r4(L.in)}s-${r4(L.out)}s), so switched off`);
    else if (nin !== inP || nout !== outP) timing.push(`trimmed to ${r4(nin)}s-${r4(nout)}s (${q(L.n)}'s time span)`);
    moved.set(x.i, {
      ci: x.i, from: x.n, to, index: L.i + nk + x.i - 1, start, in: off ? inP : nin, out: off ? outP : nout, off,
      ...(timing.length ? { timing: timing.join(", ") } : {}),
      parent: x.par ? x.par : keepNull ? "null" : null,
      ...(x.tm !== "NO_TRACK_MATTE" && x.tml ? { matte: { ci: x.tml, type: x.tm } } : {}),
    });
    if (off && !x.enabled) moved.get(x.i)!.timing = timing.filter((t) => !t.includes("switched off")).join(", ") || undefined;
  }
  // ---- C kept or removed ----
  const others = (C.usedIn ?? []).filter((id) => id !== P.id);
  const keepWhy: string[] = [];
  if (others.length) keepWhy.push(`used in ${others.map((id) => q(f.comps.find((c) => c.id === id)?.name ?? `comp ${id}`)).join(", ")}`);
  // usedIn lists comps, not layers: P may show C in more than one layer
  const alsoInP = f.pLayers.filter((x) => x.src === C.id && x.i !== L.i);
  if (alsoInP.length) keepWhy.push(`also shown by ${alsoInP.map((x) => `${x.i} ${q(x.n)}`).join(", ")} in "${P.name}"`);
  if (f.rq.includes(C.id)) keepWhy.push("in the render queue");
  // ---- expressions ----
  const nameOf = new Map(f.comps.map((c) => [c.id, c.name]));
  const byName = compNames(f.comps);
  const cFirst = new Map<string, number>(), pFirst = new Map<string, number>();
  for (const x of [...cl].reverse()) cFirst.set(x.n, x.i);
  for (const x of [...f.pLayers].reverse()) pFirst.set(x.n, x.i);
  let removeC = !!o.removeSource;
  const u: UCtx = { f, C: C.name, P: P.name, nameOf, byName, removeC, pIndex, moved, cFirst, pFirst, shift, timeShift: Ls };
  const rewrites: Rewrite[] = [], movedRewrites: Rewrite[] = [], nullRewrites: Rewrite[] = [];
  const refsC: string[] = [];
  const parsed = f.exprs.map((e) => ({ e, facts: analyzeExpression(e.x) }));
  // with removeSource: C must not be needed by any expression (references to it, and the rewrites that would need it)
  for (const { e, facts } of parsed) {
    const fromC = e.c === C.id;
    if (fromC) continue;
    if (facts.comps.some((c) => !c.self && c.name === C.name)) refsC.push(where(nameOf.get(e.c) ?? "", e));
  }
  if (refsC.length) keepWhy.push(`expressions refer to it by name (${refsC.slice(0, 3).join("; ")}${refsC.length > 3 ? `; and ${refsC.length - 3} more` : ""})`);
  if (removeC && keepWhy.length) {
    block(`"${C.name}" can't be removed: ${keepWhy.join("; ")}`);
    removeC = false;
    u.removeC = false;
  }
  const lTransform = (e: ExprF) => e.c === P.id && e.l === L.i;
  for (const { e, facts } of parsed) {
    let ctx: ExprCtx;
    let into: Rewrite[];
    if (e.c === C.id) {
      const m = moved.get(e.l)!;
      const x = cl.find((y) => y.i === e.l)!;
      ctx = { movedFromC: true, inP: false, index: { from: e.l, to: m.index }, newParent: m.parent === "null", trimmed: !m.off && (m.in !== x.in + Ls || m.out !== x.out + Ls) };
      into = movedRewrites;
    } else if (e.c === P.id) {
      if (lTransform(e)) {
        if (facts.source) problems.push({ text: `${where(P.name, e)}: reads the precomp layer's source, which the null doesn't have`, override: "expressions" });
        ctx = { movedFromC: false, inP: true, index: { from: L.i, to: L.i } };
        into = nullRewrites;
      } else {
        ctx = { movedFromC: false, inP: true, index: { from: e.l, to: pIndex(e.l)! } };
        into = rewrites;
      }
    } else {
      ctx = { movedFromC: false, inP: false };
      into = rewrites;
    }
    const r = rewriteExpr(u, e, ctx, facts);
    problems.push(...r.problems);
    // the moved layers are copies: their originals in C keep their expressions; C's own layers are also scanned
    // as "elsewhere" for references to P, below
    if (r.edits.length || r.rehearse.length) {
      const now = applyEdits(e.x, r.edits);
      into.push({ c: e.c, l: e.l, ln: e.ln, p: e.p, pn: e.pn, where: where(nameOf.get(e.c) ?? "", e), old: e.x, new: now, rehearse: r.rehearse.length === r.edits.length ? now : applyEdits(e.x, r.rehearse), snippet: snippet(e.x, r.edits), ...(e.on ? {} : { off: true }) });
    }
    if (e.c === C.id && !removeC) {
      // the originals stay in C: as "elsewhere", only their references to P matter
      const r2 = rewriteExpr(u, e, { movedFromC: false, inP: false }, facts);
      problems.push(...r2.problems.filter((p) => !problems.some((x) => x.text === p.text)));
      if (r2.edits.length) rewrites.push({ c: e.c, l: e.l, ln: e.ln, p: e.p, pn: e.pn, where: where(C.name, e), old: e.x, new: applyEdits(e.x, r2.edits), rehearse: r2.rehearse.length === r2.edits.length ? applyEdits(e.x, r2.edits) : applyEdits(e.x, r2.rehearse), snippet: snippet(e.x, r2.edits), ...(e.on ? {} : { off: true }) });
    }
    if (e.err && e.on && !(e.c === C.id)) notes.push(`${where(nameOf.get(e.c) ?? "", e)} has an error before the surgery ("${e.err.split("\n")[0]}"); reported, not fixed`);
    if (!e.on) notes.push(`${where(nameOf.get(e.c) ?? "", e)}: the expression is switched off${r.edits.length ? "; its references were rewritten so it stays right when switched on" : ""}`);
  }
  // a moved layer's expression that also points at P by name moved with it: that one is in movedRewrites already
  // ---- layer parameters of effects (Layer Control...) ----
  const layerParams: UPlan["layerParams"] = [];
  for (const x of cl)
    for (const p of x.li)
      if (!p.keyed && !p.expr && p.v > 0) {
        if (!moved.has(p.v)) block(`"${C.name}" > ${x.i} ${q(x.n)} > ${p.pn} points at layer ${p.v}, which "${C.name}" doesn't have`);
        else layerParams.push({ ci: x.i, p: p.p, pn: p.pn, toCi: p.v });
      }
  // ---- what C's frame cut off ----
  const beyond = new Map<number, BoundsF>();
  for (const b of f.bounds) if (!beyond.has(b.ci) || beyond.get(b.ci)!.by < b.by) beyond.set(b.ci, b);
  for (const b of beyond.values()) {
    const x = cl.find((y) => y.i === b.ci);
    problems.push({
      text: `"${C.name}" > ${b.ci} ${q(x?.n ?? "")} reaches up to ${Math.ceil(b.by)} px outside "${C.name}"'s ${C.w}x${C.h} frame (at ${r4(b.t)}s in "${C.name}"): the precomp cut that part off, and in "${P.name}" it would show`,
      override: "bounds",
    });
  }
  if (f.rotated && !f.bounds.length) notes.push(`${q(L.n)} is rotated in "${P.name}": the frame check was made in "${C.name}"'s own frame`);
  warnings.push(`Effects that draw outside a layer's bounds (glow, drop shadow...) are not part of the frame check: the pixel proof catches what the precomp's frame cut off at the sampled frames.`);
  if (cl.some((x) => x.type === "audio" || x.type === "av")) notes.push("Audio is not compared by the pixel proof.");
  if (L.markers) notes.push(`${q(L.n)}'s ${plural(L.markers, "layer marker")} go away with the layer.`);
  // ---- overrides ----
  const ov = new Set(o.override ?? []);
  const overridden = problems.filter((p) => p.override && ov.has(p.override));
  if (overridden.length) {
    warnings.push(`Overridden (${overridden.map((p) => p.override).filter((v, i, a) => a.indexOf(v) === i).join(", ")}): ${plural(overridden.length, "problem")} below are left as they are; the pixel proof decides.`);
    for (const p of overridden) risks.push(p.text);
  }
  return {
    kind: "unprecompose",
    problems,
    warnings,
    notes: [...new Set(notes)],
    nullLayer: keepNull ? { name: nullName, index: L.i } : null,
    ...(nullNote ? { nullNote } : {}),
    moved: [...moved.values()],
    shift,
    rewrites,
    movedRewrites,
    nullRewrites,
    layerParams,
    ...(carry && (carry.blend || carry.opacity !== undefined) ? { carry } : {}),
    removeC,
    keepC: keepWhy.length ? keepWhy.join("; ") : "",
    risks,
  };
}

/** The problems that stop the surgery (overridden ones don't). */
export function blocking(plan: { problems: Problem[] }, override: Override[] = []): Problem[] {
  return plan.problems.filter((p) => !p.override || !override.includes(p.override));
}

// ---------- deep duplicate ----------

export interface DOptions {
  suffix?: string;
  folder?: string;
  override?: Override[];
}

export function planDeepDuplicate(f: DFacts, o: DOptions = {}): DPlan {
  const problems: Problem[] = [], warnings: string[] = [], notes: string[] = [], risks: string[] = [];
  const suffix = o.suffix ?? " copy";
  const inTree = new Map(f.tree.map((c) => [c.id, c]));
  const taken = new Set(f.itemNames);
  const byName = compNames(f.comps);
  const copies = f.tree.map((c) => ({
    id: c.id,
    from: c.name,
    to: uniqueName(`${c.name}${suffix}`, taken),
    swaps: c.layers.filter((l) => l.src !== undefined && inTree.has(l.src)).map((l) => ({ i: l.i, n: l.n, src: l.src! })),
  }));
  const newName = new Map(copies.map((c) => [c.id, c.to]));
  const nameOf = new Map(f.comps.map((c) => [c.id, c.name]));
  const rewrites: Rewrite[] = [];
  const shared = f.tree.filter((c) => f.tree.reduce((n, p) => n + p.layers.filter((l) => l.src === c.id).length, 0) > 1);
  if (shared.length) notes.push(`Shared inside the tree, copied once: ${shared.map((c) => q(c.name)).join(", ")} (every copy uses the one copy).`);
  for (const c of f.tree) {
    if (c.egp) warnings.push(`"${c.name}" has ${plural(c.egp, "Essential Graphics controller")}${c.egpName ? ` (template "${c.egpName}")` : ""}: the copy has its own controllers; ${c.egpName ? "two comps now carry the same template name when exported as a Motion Graphics template, and " : ""}overrides set on precomp layers that show it are checked by the proof only at the sampled frames`);
    for (const l of c.layers) if (l.eps && l.src !== undefined && inTree.has(l.src)) risks.push(`"${c.name}" > ${l.i} ${q(l.n)} has ${props(l.eps)} (overrides of "${inTree.get(l.src)!.name}"): After Effects may not keep them when the layer is pointed at the copy`);
  }
  for (const e of f.exprs) {
    const facts = analyzeExpression(e.x);
    const w = where(nameOf.get(e.c) ?? "", e);
    const off = !e.on;
    const problem = (text: string) => !off && problems.push({ text: `${w}: ${text}`, override: "expressions" });
    if (!facts.ok) {
      problem(`the expression can't be parsed (${facts.parseError}), so its references can't be checked`);
      continue;
    }
    if (facts.evalUsed) problem("uses eval(), so what it refers to can't be known");
    const edits: Edit[] = [];
    for (const c of facts.comps) {
      if (c.self) {
        if (c.use.kind === "member" && c.use.name === "name") risks.push(`${w}: reads the comp's name, which is "${newName.get(e.c)}" in the copy`);
        continue;
      }
      if (c.name === null) {
        problem(`${c.text}: the comp's name is computed, so it can't be told whether it points into the copied tree`);
        continue;
      }
      const ids = byName.get(c.name) ?? [];
      const hit = ids.filter((id) => inTree.has(id));
      if (!hit.length) continue; // a comp outside the tree: the copy keeps using it
      if (ids.length > 1) {
        problem(`${c.text}: ${ids.length} comps are named ${q(c.name)}, so which one it means can't be told`);
        continue;
      }
      edits.push({ range: c.nameRange!, text: literal(newName.get(hit[0])!, c.quote!) });
      if (c.use.kind === "member" && c.use.name === "name") risks.push(`${w}: reads ${c.text}.name, which is "${newName.get(hit[0])}" for the copy`);
    }
    if (e.err && e.on) notes.push(`${w} has an error before the duplicate ("${e.err.split("\n")[0]}"); the copy keeps it (reported, not fixed)`);
    if (off) notes.push(`${w}: the expression is switched off${edits.length ? "; its references were rewritten so it stays right when switched on" : ""}`);
    if (edits.length) {
      const now = applyEdits(e.x, edits);
      rewrites.push({ c: e.c, l: e.l, ln: e.ln, p: e.p, pn: e.pn, where: w, old: e.x, new: now, rehearse: now, snippet: snippet(e.x, edits), ...(off ? { off: true } : {}) });
    }
  }
  const ov = new Set(o.override ?? []);
  const overridden = problems.filter((p) => p.override && ov.has(p.override));
  if (overridden.length) {
    warnings.push(`Overridden (expressions): ${plural(overridden.length, "problem")} below are left as they are; the pixel proof decides.`);
    for (const p of overridden) risks.push(p.text);
  }
  notes.push("Footage and solids are not duplicated: the copies use the same items.");
  return { kind: "deep_duplicate", problems, warnings, notes: [...new Set(notes)], copies, rewrites, ...(o.folder ? { folder: o.folder } : {}), risks };
}
