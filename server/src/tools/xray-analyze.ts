// Project X-ray, the analysis half: turns the raw facts collected in After Effects (xray.ts JSX)
// into an explanation of how the project works. Plain TypeScript (no AE): fast on big projects,
// unit-tested (test/xray.test.ts).
import { looksLikeMatchName, parseExpression, type CompSpec, type ExprRef, type LayerSpec } from "./xray-expr.js";

// ---------- what the JSX collects (short keys: big projects send thousands of layers) ----------

export interface XFx {
  /** match name, instance name */
  m: string;
  n: string;
  off?: 1;
  /** the plug-in is not installed */
  x?: 1;
  /** the instance still has the installed effect's default (translated) name */
  d?: 1;
}
export interface XLayer {
  i: number;
  id: number;
  n: string;
  t: string;
  off?: 1;
  shy?: 1;
  guide?: 1;
  /** used as a track matte */
  matte?: 1;
  /** parent index */
  par?: number;
  /** source item id */
  src?: number;
  adj?: 1;
  cl?: 1;
  tr?: 1;
  /** frame blending type, when not NO_FRAME_BLEND */
  fb?: string;
  mb?: 1;
  d3?: 1;
  inP?: number;
  outP?: number;
  fx?: XFx[];
  /** text layers: PostScript name of the font at the comp's current time */
  font?: string;
  /** footage layers: scale at the comp's current time */
  sc?: number[];
  /** expressions: [property path, source, error, enabled 1/0, source cut short 1] */
  ex?: [string, string, string, number, number?][];
}
export interface XComp {
  id: number;
  name: string;
  w: number;
  h: number;
  fps: number;
  dur: number;
  par?: number;
  nl: number;
  /** ids of the comps that use this one (AE's usedIn) */
  usedIn: number[];
  /** layers read; undefined: not read at all */
  scanned?: number;
  layers?: XLayer[];
  mb?: boolean;
  sa?: number;
  spf?: number;
  asl?: number;
  fb?: boolean;
  rend?: string;
}
export interface XFootage {
  id: number;
  name: string;
  kind: "file" | "solid" | "placeholder";
  file?: string | null;
  missing?: boolean;
  missingPath?: string;
  w?: number;
  h?: number;
  fps?: number;
  dur?: number;
  par?: number;
  still?: boolean;
  video?: boolean;
  audio?: boolean;
  alpha?: boolean;
  alphaMode?: string;
  nativeFps?: number;
  /** color-related interpretation attributes, as far as this AE version scripts them */
  color?: Record<string, unknown>;
  proxy?: { file?: string | null; inUse?: boolean; missing?: boolean };
  usedIn: number[];
}
export interface XData {
  v: number;
  ae?: string;
  engine?: string;
  project?: { name?: string; file?: string | null; items?: number; bpc?: number };
  sections: string[];
  comps: XComp[];
  footage: XFootage[];
  rq: { comp: number; status: string; render: boolean; file?: string | null }[];
  /** null: this AE has no font API (before 24.0) */
  fonts?: { missing: { ps: string; family?: string; style?: string; sub?: boolean }[]; used?: { ps: string; layers: number; ids?: number[] }[] } | null;
  /** the scan stopped early */
  partial?: { reason: string };
  layersScanned: number;
  ms: number;
  scope?: number[];
}

export const SECTIONS = ["render", "expressions", "missing", "footage", "weight"] as const;

const RENDERERS: Record<string, string> = { "ADBE Advanced 3d": "Classic 3D", "ADBE Ernst": "Cinema 4D", "ADBE Picasso": "Ray-traced 3D", "ADBE Calder": "Advanced 3D" };
/** effects known to be slow to render or to analyse: match name (or instance name) -> why */
const HEAVY: [RegExp, string][] = [
  [/^tc Particular$/i, "particle simulation (cost grows with particle count and motion blur)"],
  [/^tc Form$/i, "particle grid (cost grows with particle count)"],
  [/^CC Particle (World|Systems II)$/i, "particle simulation, evaluated from the layer's start"],
  [/^ADBE Turbulent Displace$/i, "per-pixel displacement, slow at high complexity"],
  [/Roto ?Brush/i, "segmentation propagated frame by frame"],
  [/^ADBE SubspaceStabilizer$|Warp ?Stabili[sz]er/i, "Warp Stabilizer: analysis plus a per-frame warp"],
  [/^ADBE (Camera )?Lens Blur$/i, "lens blur: cost grows with the radius"],
  [/3D ?(Camera ?)?Track/i, "3D camera tracking analysis"],
  [/^ADBE Timewarp$|Pixel ?Motion/i, "optical-flow frame interpolation"],
  [/^CC Force Motion Blur$/i, "renders several subframes per frame"],
  [/^VIDEOCOPILOT 3DArray$/i, "Element 3D: 3D model rendering"],
  [/Neat ?Video/i, "temporal noise reduction"],
  [/Detail.?Preserving Upscale/i, "detail-preserving upscale"],
];
export function heavyEffect(fx: XFx): string | null {
  return HEAVY.find(([re]) => re.test(fx.m) || re.test(fx.n))?.[1] ?? null;
}

/** what each fragile-link code means (only the codes found go into the result); most fragile first */
const LEGEND: Record<string, string> = {
  index: "layer by index: breaks when layers are added, removed or reordered",
  relative: "layer index computed from a layer's position: breaks when layers are reordered",
  effectIndex: "effect by index: breaks when effects are reordered",
  groupIndex: "shape group or mask by index: breaks when they are reordered",
  effectDefaultName: "effect by its default name, which is translated in other After Effects languages: rename the effect or use its match name",
  paramName: "effect parameter by display name: translated in other After Effects languages (use its index or match name)",
  propertyName: "property by display name: translated in other After Effects languages (use attributes like .transform.position, or match names)",
  dynamic: "name or index computed when the expression runs: can't be checked",
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const q = JSON.stringify;
const many = <T>(m: Map<string, T[]>, k: string, v: T) => m.set(k, [...(m.get(k) ?? []), v]);

class Model {
  comps = new Map<number, XComp>();
  compsByName = new Map<string, XComp[]>();
  footage = new Map<number, XFootage>();
  footageByName = new Map<string, XFootage[]>();
  cut: Record<string, number> = {};
  private names = new Map<number, Map<string, XLayer>>();
  constructor(public d: XData, public limit: number) {
    for (const c of d.comps) this.comps.set(c.id, c), many(this.compsByName, c.name, c);
    for (const f of d.footage) this.footage.set(f.id, f), many(this.footageByName, f.name, f);
  }
  /** at most `limit` items; the rest is counted in `cut` */
  cap<T>(name: string, list: T[]): T[] {
    if (list.length > this.limit) this.cut[name] = list.length - this.limit;
    return list.slice(0, this.limit);
  }
  /** "Main > 3: Title > Transform/Opacity" */
  at(c: XComp, l?: XLayer, prop?: string): string {
    return c.name + (l ? ` > ${l.i}: ${l.n}` : "") + (prop ? ` > ${prop}` : "");
  }
  /** the layer AE finds by this name (the top-most one) */
  layerByName(c: XComp, name: string): XLayer | undefined {
    let idx = this.names.get(c.id);
    if (!idx) {
      this.names.set(c.id, (idx = new Map()));
      for (const l of c.layers ?? []) if (!idx.has(l.n)) idx.set(l.n, l);
    }
    return idx.get(name);
  }
  layer(c: XComp, index: number): XLayer | undefined {
    return c.layers?.[index - 1]?.i === index ? c.layers[index - 1] : c.layers?.find((l) => l.i === index);
  }
  partly(c: XComp): boolean {
    return c.scanned === undefined || c.scanned < c.nl;
  }
}

// ---------- 1. render reachability ----------

function renderSection(m: Model, exprComps: Set<number>) {
  const d = m.d;
  // parent -> child -> layers using it (enabled ones); AE's usedIn fills in comps not fully read
  const edges = new Map<number, Map<number, { layers: number; enabled: number }>>();
  const add = (p: number, ch: number, layers: number, enabled: number) => {
    const row = edges.get(p) ?? new Map();
    const e = row.get(ch) ?? { layers: 0, enabled: 0 };
    row.set(ch, { layers: e.layers + layers, enabled: e.enabled + enabled });
    edges.set(p, row);
  };
  for (const c of d.comps) for (const l of c.layers ?? []) if (l.src !== undefined && m.comps.has(l.src)) add(c.id, l.src, 1, l.off && !l.matte ? 0 : 1);
  for (const c of d.comps) for (const p of c.usedIn) if (m.comps.has(p) && m.partly(m.comps.get(p)!) && !edges.get(p)?.has(c.id)) add(p, c.id, 0, 0);
  const kids = (id: number) => [...(edges.get(id)?.keys() ?? [])];
  const parents = (c: XComp) => c.usedIn.filter((p) => m.comps.has(p));
  const rqIds = [...new Set(d.rq.map((r) => r.comp))];
  const reach = (from: number[]) => {
    const seen = new Set<number>();
    for (const stack = [...from]; stack.length; ) {
      const id = stack.pop()!;
      if (!seen.has(id)) seen.add(id), stack.push(...kids(id));
    }
    return seen;
  };
  const fromRq = reach(rqIds);

  // precomp depth under each comp (AE forbids cycles; guarded anyway)
  const depth = new Map<number, number>();
  const depthOf = (id: number, path = new Set<number>()): number => {
    if (depth.has(id) || path.has(id)) return depth.get(id) ?? 0;
    path.add(id);
    const v = Math.max(0, ...kids(id).map((k) => 1 + depthOf(k, path)));
    path.delete(id);
    depth.set(id, v);
    return v;
  };
  let deep = d.comps[0]?.id;
  for (const c of d.comps) if (depthOf(c.id) > depthOf(deep)) deep = c.id;
  const chain: string[] = [];
  for (let id: number | undefined = deep; id !== undefined; id = kids(id).find((k) => depthOf(k) === depthOf(id!) - 1)) chain.push(m.comps.get(id)!.name);

  // the trees under the render queue (or under the top-level comps when it is empty)
  const roots = rqIds.length ? rqIds : d.comps.filter((c) => !parents(c).length).map((c) => c.id);
  const tree: string[] = [];
  const expanded = new Set<number>();
  const maxLines = Math.max(40, m.limit * 4);
  let lineCut = 0;
  const walk = (id: number, indent: string, note: string) => {
    if (tree.length >= maxLines) return void lineCut++;
    const c = m.comps.get(id)!;
    const again = expanded.has(id) && kids(id).length > 0;
    tree.push(indent + c.name + note + (m.partly(c) && c.nl ? " (partly read)" : "") + (again ? " (expanded above)" : ""));
    if (again) return;
    expanded.add(id);
    for (const [k, e] of edges.get(id) ?? []) walk(k, indent + "  ", (e.layers > 1 ? ` x${e.layers}` : "") + (e.layers && !e.enabled ? " [only on disabled layers]" : ""));
  };
  for (const r of roots) {
    const st = d.rq.filter((x) => x.comp === r).map((x) => x.status.toLowerCase() + (x.render ? "" : ", not queued"));
    walk(r, "", rqIds.length ? ` [render queue: ${st.join("; ")}]` : " [top level]");
  }
  if (lineCut) m.cut["render.tree"] = lineCut;

  const label = (c: XComp) => c.name + (exprComps.has(c.id) ? " (read by expressions)" : "");
  const unrendered = d.comps.filter((c) => !fromRq.has(c.id));
  const uses = new Map<number, { layers: number; comps: number }>();
  for (const row of edges.values()) for (const [k, e] of row) {
    const u = uses.get(k) ?? { layers: 0, comps: 0 };
    uses.set(k, { layers: u.layers + e.layers, comps: u.comps + 1 });
  }
  return {
    queue: m.cap("render.queue", d.rq.map((r) => ({ comp: m.comps.get(r.comp)?.name ?? `#${r.comp}`, status: r.status, render: r.render, output: r.file ?? undefined }))),
    note: rqIds.length ? undefined : "The render queue is empty: the trees start at the top-level comps (comps no other comp uses).",
    tree,
    reachable: { fromRenderQueue: fromRq.size, fromQueuedItems: reach(d.rq.filter((r) => r.render).map((r) => r.comp)).size, of: d.comps.length },
    maxPrecompDepth: depthOf(deep),
    deepestChain: chain,
    precompOnly: d.comps.filter((c) => parents(c).length && !rqIds.includes(c.id)).length,
    // nothing renders these: top-level comps outside the queue, and everything only they use
    topLevelNotInRenderQueue: rqIds.length ? m.cap("render.topLevelNotInRenderQueue", unrendered.filter((c) => !parents(c).length).map(label)) : undefined,
    deadBranches: rqIds.length ? m.cap("render.deadBranches", unrendered.filter((c) => parents(c).length).map(label)) : undefined,
    usedInManyPlaces: m.cap(
      "render.usedInManyPlaces",
      [...uses].filter(([, u]) => u.layers >= 3 || u.comps >= 2).sort(([, a], [, b]) => b.layers - a.layers || b.comps - a.comps).map(([id, u]) => ({ comp: m.comps.get(id)!.name, layers: u.layers, inComps: u.comps })),
    ),
  };
}

// ---------- 2. expressions ----------

/** ok: found; broken: missing (why); neither: can't tell (computed name, comp not read...) */
type Found<T> = { ok?: T; broken?: string };
type Target = { comp: XComp; layer: XLayer };

function findComp(m: Model, spec: CompSpec, own: Target): Found<XComp> {
  if (spec.k === "this") return { ok: own.comp };
  if (spec.k === "sourceOf") {
    const l = findLayer(m, spec.layer, own);
    const src = l.ok?.layer.src;
    return src !== undefined && m.comps.has(src) ? { ok: m.comps.get(src) } : { broken: l.broken };
  }
  if (spec.sel.by !== "name") return {};
  const c = m.compsByName.get(spec.sel.v);
  return c ? { ok: c[0] } : { broken: `no comp named ${q(spec.sel.v)}` };
}

function findLayer(m: Model, spec: LayerSpec, own: Target, parentGuard = false): Found<Target> {
  const fc = findComp(m, spec.comp, own);
  const comp = fc.ok;
  if (!comp) return { broken: fc.broken };
  let layer: XLayer | undefined = own.layer;
  const s = spec.base;
  if (s !== "this") {
    if (s.by === "index" && (s.v < 1 || s.v > comp.nl)) return { broken: `layer index ${s.v} is out of range (comp ${q(comp.name)} has ${comp.nl} layers)` };
    layer = s.by === "index" ? m.layer(comp, s.v) : s.by === "name" ? m.layerByName(comp, s.v) : undefined;
    if (!layer) return s.by === "name" && !m.partly(comp) ? { broken: `no layer named ${q(s.v)} in comp ${q(comp.name)}` } : {};
  }
  for (let k = 0; k < spec.parents; k++) {
    if (layer.par === undefined) return parentGuard ? {} : { broken: `layer ${q(layer.n)} has no parent` };
    layer = m.layer(comp, layer.par);
    if (!layer) return {};
  }
  return { ok: { comp, layer } };
}

/**
 * One expression link the in-chat view lists (never in the text): a fragile link (code from LEGEND), a link by name
 * (breaks on rename), a broken link, or an expression error, where it is and the expression's source.
 */
export interface XLink {
  comp: XComp;
  layer: XLayer;
  prop: string;
  src: string;
  kind: "fragile" | "name" | "broken" | "error";
  /** the reference as written (`thisComp.layer("Logo")`), the LEGEND code, the name used, what it points at / why it's broken */
  ref?: string;
  why?: string;
  name?: string;
  target?: string;
}

function expressionSection(m: Model, sink?: (l: XLink) => void) {
  let total = 0, disabled = 0, cutShort = 0, unparsed = 0, unparsedAt: string | undefined;
  const errors: { at: string; error: string }[] = [];
  const broken: { at: string; ref: string; problem: string }[] = [];
  const fragile: { at: string; ref: string; why: string; now?: string }[] = [];
  const counts: Record<string, number> = {};
  /** names expressions use: rename the target and they break */
  const named = new Map<string, { target: string; refs: number; from: Set<string> }>();
  const edges = new Map<string, { from: string; to: string; refs: number; via: Set<string> }>();
  const cross = new Map<string, { from: string; to: string; refs: number }>();
  const compRefs = new Set<number>();

  for (const c of m.d.comps) for (const l of c.layers ?? []) for (const [prop, src, err, enabled, cut] of l.ex ?? []) {
    total++;
    if (!enabled) disabled++;
    if (cut) cutShort++;
    const at = m.at(c, l, prop), from = m.at(c, l), own = { comp: c, layer: l };
    if (err && enabled) errors.push({ at, error: err.length > 200 ? err.slice(0, 197) + "..." : err }), sink?.({ comp: c, layer: l, prop, src, kind: "error", target: err });
    let parsed: ReturnType<typeof parseExpression>;
    try {
      parsed = parseExpression(src);
    } catch {
      // the reader is lenient by design; if it ever fails, say so instead of losing the report
      unparsed++;
      unparsedAt ??= at;
      continue;
    }
    const seen = new Set<string>();
    const once = (key: string) => !seen.has(key) && !!seen.add(key);
    const flag = (ref: ExprRef, why: string, now?: string) => {
      if (once(why + ref.text)) (counts[why] = (counts[why] ?? 0) + 1), fragile.push({ at, ref: ref.text, why, now }), sink?.({ comp: c, layer: l, prop, src, kind: "fragile", ref: ref.text, why, target: now });
    };
    const bad = (ref: ExprRef, problem?: string) => {
      if (problem && once(problem + ref.text)) broken.push({ at, ref: ref.text, problem }), sink?.({ comp: c, layer: l, prop, src, kind: "broken", ref: ref.text, target: problem });
    };
    // `ref` and `name` only for the in-chat view (sink)
    const byName = (key: string, target: string, ref?: ExprRef, name?: string) => {
      const e = named.get(key) ?? { target, refs: 0, from: new Set<string>() };
      named.set(key, { ...e, refs: e.refs + 1, from: e.from.add(from) });
      if (ref && once("name" + ref.text)) sink?.({ comp: c, layer: l, prop, src, kind: "name", ref: ref.text, name, target });
    };
    const link = (t: Target, via: string) => {
      if (t.comp === c && t.layer === l) return;
      const to = m.at(t.comp, t.layer);
      const e = edges.get(from + "\n" + to) ?? { from, to, refs: 0, via: new Set<string>() };
      edges.set(from + "\n" + to, { ...e, refs: e.refs + 1, via: e.via.add(via) });
      if (t.comp !== c) {
        const x = cross.get(c.name + "\n" + t.comp.name) ?? { from: c.name, to: t.comp.name, refs: 0 };
        cross.set(c.name + "\n" + t.comp.name, { ...x, refs: x.refs + 1 });
      }
    };
    for (const ref of parsed.refs) {
      if (ref.kind === "footage") {
        const f = ref.item.by === "name" ? m.footageByName.get(ref.item.v) : undefined;
        if (ref.item.by !== "name") flag(ref, "dynamic");
        else if (!f) bad(ref, `no footage item named ${q(ref.item.v)}`);
        else byName(`f${f[0].id}`, `footage ${q(f[0].name)}`, ref, f[0].name);
      } else if (ref.kind === "comp") {
        const r = findComp(m, ref.comp, own);
        bad(ref, r.broken);
        if (ref.comp.k === "sel" && ref.comp.sel.by !== "name") flag(ref, "dynamic");
        if (!r.ok) continue;
        compRefs.add(r.ok.id);
        if (r.ok !== c) byName(`c${r.ok.id}`, `comp ${q(r.ok.name)}`, ref, r.ok.name);
        const dup = m.compsByName.get(r.ok.name)!.length;
        if (dup > 1) bad(ref, `${dup} comps are named ${q(r.ok.name)}: the expression uses the first one`);
      } else if (ref.kind === "layer" || ref.kind === "parent") {
        const res = findLayer(m, ref.layer, own, parsed.parentGuard), t = res.ok, s = ref.layer.base;
        bad(ref, res.broken);
        if (ref.kind === "layer" && s !== "this") {
          if (s.by === "index") flag(ref, "index", t?.layer.n);
          else if (s.by !== "name") flag(ref, s.by);
          else if (t) byName(`l${t.comp.id}:${t.layer.id}`, `layer ${q(t.layer.n)} in ${q(t.comp.name)}`, ref, t.layer.n);
        }
        if (t) link(t, ref.kind);
      } else if (ref.kind === "effect" || ref.kind === "param") {
        // the layer's own problems were reported by its own (layer) reference
        const t = findLayer(m, ref.layer, own, true).ok, s = ref.effect;
        const fx = !t ? undefined : s.by === "name" ? t.layer.fx?.find((f) => f.n === s.v || f.m === s.v) : s.by === "index" ? t.layer.fx?.[s.v - 1] : undefined;
        if (ref.kind === "param") {
          if (ref.param.by === "name" && !looksLikeMatchName(ref.param.v) && !/^Pseudo\//.test(fx?.m ?? "")) flag(ref, "paramName");
        } else if (s.by === "name") {
          if (t) link(t, `effect ${q(s.v)}`);
          if (t && !fx && !looksLikeMatchName(s.v)) bad(ref, `no effect named ${q(s.v)} on layer ${q(t.layer.n)}`);
          if (t && fx && fx.m !== s.v) {
            byName(`e${t.comp.id}:${t.layer.id}:${fx.n}`, `effect ${q(fx.n)} on ${q(t.layer.n)} in ${q(t.comp.name)}`, ref, fx.n);
            if (fx.d) flag(ref, "effectDefaultName", fx.m);
          }
        } else {
          if (t) link(t, "effect");
          flag(ref, s.by === "index" ? "effectIndex" : "dynamic", fx?.n);
        }
      } else {
        const t = findLayer(m, ref.layer, own, true).ok;
        if (t) link(t, ref.kind);
        if (ref.kind === "property" && ref.path.some((s) => s.by === "name" && !looksLikeMatchName(s.v))) flag(ref, "propertyName");
        else if (ref.kind !== "property" && ref.path.some((s) => s.by === "index")) flag(ref, "groupIndex");
      }
    }
  }
  const hubs = new Map<string, number>();
  for (const e of edges.values()) hubs.set(e.to, (hubs.get(e.to) ?? 0) + 1);
  const byRefs = <T extends { refs: number }>(a: T, b: T) => b.refs - a.refs;
  const order = Object.keys(LEGEND);
  return {
    compRefs,
    out: {
      total,
      disabled,
      withErrors: errors.length,
      sourcesCutShort: cutShort || undefined,
      unparsed: unparsed ? { count: unparsed, example: unparsedAt, note: "these expressions could not be read, so their links are not in the lists below" } : undefined,
      engine: m.d.engine,
      errors: m.cap("expressions.errors", errors),
      broken: m.cap("expressions.broken", broken),
      fragileCounts: counts,
      fragile: m.cap("expressions.fragile", fragile.sort((a, b) => order.indexOf(a.why) - order.indexOf(b.why))),
      renameSensitive: m.cap(
        "expressions.renameSensitive",
        [...named.values()].sort((a, b) => b.from.size - a.from.size || b.refs - a.refs).map((n) => ({ target: n.target, expressions: n.refs, fromLayers: n.from.size, examples: [...n.from].slice(0, 3) })),
      ),
      dependencies: {
        layersWithLinks: new Set([...edges.values()].map((e) => e.from)).size,
        hubs: m.cap("expressions.hubs", [...hubs].filter(([, n]) => n > 1).sort(([, a], [, b]) => b - a).map(([layer, readBy]) => ({ layer, readBy }))),
        crossComp: m.cap("expressions.crossComp", [...cross.values()].sort(byRefs)),
        edges: m.cap("expressions.edges", [...edges.values()].sort(byRefs).map((e) => ({ from: e.from, to: e.to, refs: e.refs, via: [...e.via].slice(0, 4) }))),
      },
    },
  };
}

// ---------- 3. missing ----------

function missingSection(m: Model) {
  const effects = new Map<string, string[]>(), fx: Record<string, string> = {}, fontLayers = new Map<string, string[]>();
  for (const c of m.d.comps) for (const l of c.layers ?? []) {
    for (const f of l.fx ?? []) if (f.x) many(effects, f.m, m.at(c, l)), (fx[f.m] = f.n);
    if (l.font) many(fontLayers, l.font, m.at(c, l));
  }
  const usedIn = (f: XFootage) => f.usedIn.map((id) => m.comps.get(id)?.name ?? `#${id}`);
  const fonts = m.d.fonts;
  const textLayerFonts = m.cap("missing.textLayerFonts", [...fontLayers].map(([font, ls]) => ({ font, textLayers: ls.length })).sort((a, b) => b.textLayers - a.textLayers));
  return {
    effects: m.cap("missing.effects", [...effects].map(([matchName, ls]) => ({ matchName, name: fx[matchName], layers: ls.length, examples: ls.slice(0, 3) }))),
    footage: m.cap("missing.footage", m.d.footage.filter((f) => f.kind === "file" && f.missing).map((f) => ({ name: f.name, path: f.missingPath ?? f.file ?? null, usedIn: usedIn(f) }))),
    fonts: !fonts
      ? { note: "This After Effects version can't list missing fonts (needs 24.0+).", textLayerFonts }
      : {
          missingOrSubstituted: m.cap(
            "missing.fonts",
            fonts.missing.map((f) => {
              const ls = fontLayers.get(f.ps) ?? [];
              return { font: f.ps, family: f.family, style: f.style, substituted: !!f.sub, textLayers: ls.length, examples: ls.slice(0, 3) };
            }),
          ),
          usedInProject: fonts.used?.length,
          textLayerFonts,
        },
    proxies: m.cap("missing.proxies", m.d.footage.filter((f) => f.proxy).map((f) => ({ item: f.name, proxy: f.proxy!.file ?? null, inUse: !!f.proxy!.inUse, missing: f.proxy!.missing }))),
    placeholders: m.cap("missing.placeholders", m.d.footage.filter((f) => f.kind === "placeholder").map((f) => ({ name: f.name, usedIn: usedIn(f) }))),
  };
}

// ---------- 4. footage ----------

function footageSection(m: Model) {
  const files = m.d.footage.filter((f) => f.kind === "file");
  const mixed: { footage: string; fps: number; comps: string[] }[] = [];
  const large: string[] = [];
  const rows = files.map((f) => {
    const flags: string[] = [];
    if (f.missing) flags.push("missing");
    if (!f.usedIn.length) flags.push("unused");
    if (f.video && !f.still && f.fps) {
      const off = f.usedIn.map((id) => m.comps.get(id)!).filter((c) => c && Math.abs(c.fps - f.fps!) > 0.01);
      if (off.length) flags.push("frame rate differs from comps"), mixed.push({ footage: f.name, fps: r2(f.fps), comps: off.map((c) => `${c.name} (${r2(c.fps)})`) });
      if (f.nativeFps && Math.abs(f.nativeFps - f.fps) > 0.01) flags.push(`conformed from ${r2(f.nativeFps)} fps`);
    }
    if ((f.w ?? 0) > 4096 || (f.h ?? 0) > 4096) flags.push("very large"), large.push(`${f.name} (${f.w}x${f.h})`);
    if (f.par && Math.abs(f.par - 1) > 0.001) flags.push(`non-square pixels (${r2(f.par)})`);
    return {
      id: f.id,
      name: f.name,
      path: f.missingPath ?? f.file ?? null,
      size: f.w ? `${f.w}x${f.h}` : undefined,
      fps: f.still ? "still" : f.fps && r2(f.fps),
      duration: f.still || f.dur === undefined ? undefined : r2(f.dur),
      alpha: f.alpha ? (f.alphaMode ?? true) : false,
      audioOnly: f.audio && !f.video ? true : undefined,
      color: f.color,
      usedIn: f.usedIn.length,
      flags: flags.length ? flags : undefined,
    };
  });
  rows.sort((a, b) => (b.flags ? 1 : 0) - (a.flags ? 1 : 0) || b.usedIn - a.usedIn); // flagged first, then the most used
  return {
    total: files.length,
    missing: files.filter((f) => f.missing).length,
    unused: files.filter((f) => !f.usedIn.length).length,
    solids: m.d.footage.filter((f) => f.kind === "solid").length,
    items: m.cap("footage.items", rows),
    mixedFrameRates: m.cap("footage.mixedFrameRates", mixed),
    veryLarge: m.cap("footage.veryLarge", large),
  };
}

// ---------- 5. weight ----------

function weightSection(m: Model) {
  const heavy = new Map<string, { effect: string; matchName: string; why: string; count: number; examples: string[] }>();
  const hidden: { at: string; is: string[]; effects: string[] }[] = [];
  const comps: { comp: string; score: number }[] = [];
  const oversized: string[] = [];
  for (const c of m.d.comps) {
    let mb = 0, tr = 0, cl = 0, d3 = 0;
    const fb: string[] = [], fullAdj: string[] = [];
    for (const l of c.layers ?? []) {
      const at = m.at(c, l);
      const active = (l.fx ?? []).filter((f) => !f.off);
      for (const fx of active) {
        const why = heavyEffect(fx);
        if (!why || fx.x) continue; // a missing plug-in renders nothing
        const h = heavy.get(fx.m) ?? { effect: fx.n, matchName: fx.m, why, count: 0, examples: [] };
        if (h.examples.length < 3) h.examples.push(at);
        heavy.set(fx.m, { ...h, count: h.count + 1 });
      }
      const is = [l.off && !l.matte && "disabled", l.shy && "shy", l.guide && "guide"].filter((x): x is string => !!x);
      if (is.length && active.length) hidden.push({ at, is, effects: active.map((f) => f.n).slice(0, 5) });
      mb += l.mb ?? 0;
      tr += l.tr ?? 0;
      cl += l.cl ?? 0;
      d3 += l.d3 ?? 0;
      if (l.fb) fb.push(`${l.i}: ${l.n} (${l.fb.replace(/_/g, " ").toLowerCase()})`);
      if (l.adj && active.length && (l.inP ?? 1) <= 0.001 && (l.outP ?? 0) >= c.dur - 1 / (c.fps || 25) + 0.001) fullAdj.push(`${l.i}: ${l.n} (${active.length} effect${active.length > 1 ? "s" : ""})`);
      const f = l.src === undefined ? undefined : m.footage.get(l.src);
      if (f?.kind === "file" && f.w && f.h && l.sc && !l.off) {
        const sx = Math.abs(l.sc[0]) / 100, sy = Math.abs(l.sc[1] ?? l.sc[0]) / 100;
        if (sx <= 0.5 && sy <= 0.5 && (f.w > c.w || f.h > c.h)) oversized.push(`${at}: ${f.w}x${f.h} shown at ${Math.round(sx * 100)}% (about ${Math.round(f.w * sx)}x${Math.round(f.h * sy)}) in a ${c.w}x${c.h} comp`);
      }
    }
    const row = {
      motionBlur: c.mb && mb ? { layers: mb, shutterAngle: c.sa, samplesPerFrame: c.spf, adaptiveLimit: c.asl } : undefined,
      highSamples: c.mb && mb && ((c.spf ?? 16) > 16 || (c.asl ?? 128) > 128) ? true : undefined,
      renderer: c.rend && (d3 || c.rend !== "ADBE Advanced 3d") ? (RENDERERS[c.rend] ?? c.rend) : undefined,
      layers3D: d3 || undefined,
      frameBlending: c.fb && fb.length ? fb.slice(0, 5) : undefined,
      timeRemapped: tr || undefined,
      collapsed: cl || undefined,
      fullLengthAdjustment: fullAdj.length ? fullAdj.slice(0, 5) : undefined,
    };
    // the comps that cost the most first
    const score = (row.highSamples ? 4 : 0) + (row.motionBlur ? 2 : 0) + (row.frameBlending ? 2 : 0) + (row.fullLengthAdjustment ? 1 : 0) + (row.renderer && row.renderer !== "Classic 3D" ? 2 : 0);
    if (Object.values(row).some((v) => v !== undefined)) comps.push({ comp: c.name, ...row, score });
  }
  return {
    heavyEffects: m.cap("weight.heavyEffects", [...heavy.values()].sort((a, b) => b.count - a.count)),
    hiddenCost: m.cap("weight.hiddenCost", hidden),
    hiddenCostNote: hidden.length
      ? "disabled: not rendered, so its effects cost nothing unless an effect or expression uses the layer; shy: renders normally, only hidden in the timeline; guide: renders in this comp's viewer only, not in the final output or in parent comps"
      : undefined,
    comps: m.cap("weight.comps", comps.sort((a, b) => b.score - a.score).map(({ score, ...c }) => (void score, c))),
    oversizedFootage: m.cap("weight.oversizedFootage", oversized),
  };
}

/** Every expression link and error the in-chat view lists, with what LEGEND says about each fragile code. */
export function xrayLinks(d: XData): XLink[] {
  const out: XLink[] = [];
  expressionSection(new Model(d, Infinity), (l) => out.push(l));
  return out;
}
export const FRAGILE_LEGEND = LEGEND;

// ---------- report ----------

export function analyzeXray(d: XData, opts: { limit?: number } = {}) {
  const m = new Model(d, opts.limit ?? 25);
  const want = new Set(d.sections);
  const expr = want.has("expressions") ? expressionSection(m) : undefined;
  const codes = Object.keys(expr?.out.fragileCounts ?? {});
  return {
    project: {
      ...d.project,
      afterEffects: d.ae,
      comps: d.comps.length,
      footageItems: d.footage.filter((f) => f.kind === "file").length,
      layersScanned: d.layersScanned,
      scope: d.scope?.map((id) => m.comps.get(id)?.name ?? `#${id}`),
      collectMs: d.ms,
    },
    partial: d.partial && { ...d.partial, note: "Not every layer was read, so the lists are incomplete. Narrow it down with comps / sections, or raise timeBudgetSeconds / maxLayers." },
    render: want.has("render") ? renderSection(m, expr?.compRefs ?? new Set()) : undefined,
    expressions: expr?.out,
    missing: want.has("missing") ? missingSection(m) : undefined,
    footage: want.has("footage") ? footageSection(m) : undefined,
    weight: want.has("weight") ? weightSection(m) : undefined,
    legend: codes.length ? Object.fromEntries(codes.map((k) => [k, LEGEND[k]])) : undefined,
    cut: Object.keys(m.cut).length ? m.cut : undefined,
  };
}

/** The line before the JSON: counts are complete even where the lists were cut. */
export function xraySummary(r: ReturnType<typeof analyzeXray>): string {
  const n = (key: string, list?: unknown[]) => (list?.length ?? 0) + (r.cut?.[key] ?? 0);
  const p = r.project, out = [`Project X-ray: ${p.comps} comps, ${p.footageItems} footage items, ${p.layersScanned} layers read`];
  const rd = r.render, e = r.expressions, mi = r.missing;
  if (rd) out.push(`${rd.queue.length ? `render queue ${n("render.queue", rd.queue)} item(s) reaching ${rd.reachable.fromRenderQueue} of ${rd.reachable.of} comps` : "render queue empty"}, precomp depth ${rd.maxPrecompDepth}`);
  if (e) {
    const fc = e.fragileCounts, k = (c: string) => fc[c] ?? 0;
    out.push(`${e.total} expressions (${e.withErrors} with errors, ${n("expressions.broken", e.broken)} broken links, ${k("index") + k("relative")} index-based, ${k("effectDefaultName") + k("paramName") + k("propertyName")} language-dependent${e.unparsed ? `, ${e.unparsed.count} could not be read` : ""})`);
  }
  if (mi) {
    const fonts = "missingOrSubstituted" in mi.fonts ? `${n("missing.fonts", mi.fonts.missingOrSubstituted)} fonts` : "fonts not checked";
    // placeholders (stand-ins for footage: they render as color bars) are counted apart from missing footage
    const ph = n("missing.placeholders", mi.placeholders);
    out.push(`missing: ${n("missing.effects", mi.effects)} effects, ${n("missing.footage", mi.footage)} footage, ${fonts}${ph ? `; ${ph} placeholder${ph === 1 ? "" : "s"} instead of footage` : ""}`);
  }
  if (r.weight) out.push(`${n("weight.heavyEffects", r.weight.heavyEffects)} heavy effect types`);
  return out.join("; ") + (r.partial ? `. PARTIAL: ${r.partial.reason}.` : ".");
}

/** Summary line + compact JSON, shortening the lists until it fits in one tool result. */
export function formatXray(d: XData, opts: { limit?: number } = {}, maxChars = 55_000): string {
  const want = opts.limit ?? 25;
  for (let limit = want; ; limit = Math.max(2, limit >> 1)) {
    const report = analyzeXray(d, { limit });
    const json = JSON.stringify(report);
    if (json.length <= maxChars || limit <= 2)
      return xraySummary(report) + (limit < want ? `\n(Lists shortened to ${limit} entries to fit; "cut" counts what was left out. Ask for fewer sections or comps to see more.)` : "") + "\n" + json;
  }
}
