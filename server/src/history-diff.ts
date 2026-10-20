// Project history: the canonical project snapshot (built from the lines tools/history.ts's ExtendScript
// returns) and the diff of two snapshots as a readable, grouped change list (plus the same changes as
// structured rows for the in-chat view).
import { splitChange, splitField } from "./view-changes.js";
import type { ViewChange } from "./views/types.js";

export interface Key { t: number; v?: unknown; ip?: string; e?: string; f?: string; tan?: unknown; lb?: number }
/** A property that is not at its default, is animated or has an expression (keyed by match-name path). */
export interface Prop {
  path: string;
  v?: unknown;
  /** After Effects says the static value is at its default (only an expression is set) */
  vd?: boolean;
  x?: string;
  xoff?: boolean;
  /** the first 500 keyframes */
  k?: Key[];
  /** the number of keyframes, when there are more than 500 */
  n?: number;
  /** checksum of the times and values of the keyframes beyond 500 */
  ks?: number;
}
/** A child of an indexed group (effect, mask, shape group, text animator...). */
export interface Group {
  path: string;
  match: string;
  i: number;
  on?: boolean;
  /** masks: mode, inverted, feather falloff, motion blur, RotoBezier, locked, color */
  a?: Record<string, unknown>;
}
export interface Layer { key: string; index: number; name: string; type: string; attrs: Record<string, unknown>; props: Record<string, Prop>; groups: Record<string, Group> }
export interface Item {
  id: number;
  type: string;
  name: string;
  folder: string;
  fields: Record<string, unknown>;
  /** comps: only when the comp's layers were captured */
  layers?: Record<string, Layer>;
  markers?: Key[];
  /** the time budget ran out inside this comp */
  partial?: boolean;
}
export interface Stats {
  comps: number;
  layers: number;
  visited: number;
  stored: number;
  ms: number;
  pruning: string;
  revisionAfter?: number | null;
  /** render queue items beyond the first 50, not read */
  rqNotRead?: number;
}
export interface Snapshot {
  format: 1;
  id: string;
  label?: string;
  at: string;
  project: string | null;
  revision: number | null;
  ae?: string;
  checkpoint?: string;
  /** comp ids captured when the snapshot was limited to some comps */
  scope?: number[];
  /** comps not captured because the time budget ran out */
  skipped?: number[];
  stats: Stats;
  settings: Record<string, unknown>;
  items: Record<string, Item>;
  rq: Record<string, Record<string, unknown>>;
}

/** Sort object keys recursively: stored snapshots are canonical, and values compare as JSON text. */
export function canonical<T>(v: T): T {
  if (Array.isArray(v)) return v.map(canonical) as T;
  if (!v || typeof v !== "object") return v;
  const o: any = {};
  for (const k of Object.keys(v).sort()) o[k] = canonical((v as any)[k]);
  return o;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const union = (a: object = {}, b: object = {}) => [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();

/** Build a snapshot from the ExtendScript's output: one JSON array per line. */
export function parseSnapshotLines(text: string, meta: { id: string; label?: string; at: string }): Snapshot {
  const s: Snapshot = { format: 1, ...meta, project: null, revision: null, stats: {} as Stats, settings: {}, items: {}, rq: {} };
  const L = (r: any[]) => s.items[r[1]]?.layers?.[r[2]];
  for (const ln of text.split("\n")) {
    if (!ln) continue;
    const r = JSON.parse(ln), it = s.items[r[1]];
    if (r[0] === "M") Object.assign(s, { project: r[1].project, revision: r[1].revision, ae: r[1].ae, scope: r[1].scope ?? undefined, skipped: r[1].skipped?.length ? r[1].skipped : undefined, stats: r[1].stats });
    else if (r[0] === "X") s.settings = r[1];
    else if (r[0] === "I") s.items[r[1]] = { id: r[1], ...r[2] };
    else if (r[0] === "C" && it) Object.assign(it, { layers: it.layers ?? {}, markers: r[2].markers?.length ? r[2].markers : undefined, partial: r[2].partial || undefined });
    else if (r[0] === "L" && it) (it.layers ??= {})[r[2]] = { key: r[2], ...r[3], props: {}, groups: {} };
    else if (r[0] === "g" && L(r)) L(r)!.groups[r[3]] = { path: r[4], match: r[5], i: r[6], ...(r[7] === false ? { on: false } : {}), ...(r[8] ? { a: r[8] } : {}) };
    else if (r[0] === "p" && L(r)) L(r)!.props[r[3]] = { path: r[4], ...r[5] };
    else if (r[0] === "Q") s.rq[r[1]] = r[2];
  }
  return canonical(s);
}

// ---------- formatting ----------

const num = (n: number) => String(Number(n.toFixed(3)));
const isShape = (v: unknown): v is Record<string, any> => isObj(v) && "points" in v && "closed" in v;
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const q = (s: unknown) => JSON.stringify(String(s));
const at = (t: number) => `@${num(t)}s`;
const lastSeg = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const parentOf = (k: string) => k.slice(0, Math.max(0, k.lastIndexOf("/")));

export function fmt(v: unknown, max = 100): string {
  if (v === undefined) return "default";
  if (v === null) return "none";
  if (typeof v === "number") return num(v);
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v === "string") return q(v.length > max ? v.slice(0, max - 3) + "..." : v);
  if (Array.isArray(v)) return v.length > 4 ? `[${v.length} values]` : `[${v.map((x) => fmt(x, 20)).join(",")}]`;
  if (isShape(v)) return `path (${v.points} points${v.closed ? ", closed" : ""})`;
  if (isObj(v)) return "text" in v ? fmt(v.text, max) : Object.entries(v).map(([k, x]) => (k === "comment" ? fmt(x, 40) : `${k} ${fmt(x, 20)}`)).join(", ") || "{}";
  return String(v);
}

/** "old -> new", or for objects (text documents, settings) the fields that differ. */
export function fmtChange(a: unknown, b: unknown): string {
  if (isShape(a) && isShape(b)) return `path changed (${a.points === b.points ? b.points : `${a.points} -> ${b.points}`} points)`;
  if (isObj(a) && isObj(b)) return fieldDiff(a, b, 6).join("; ");
  const fa = fmt(a), fb = fmt(b);
  return fa === fb ? `${fa} (changed in detail)` : `${fa} -> ${fb}`;
}

/** "field old -> new" for every field that differs; `show` formats a side's value (e.g. layer references). */
function fieldDiff(a: Record<string, unknown>, b: Record<string, unknown>, max = 99, show?: (v: unknown, side: 0 | 1) => string): string[] {
  const d = union(a, b).filter((k) => !same(a[k], b[k]));
  const out = d.slice(0, max).map((k) => `${k} ${show ? `${show(a[k], 0)} -> ${show(b[k], 1)}` : fmtChange(a[k], b[k])}`);
  return d.length > max ? [...out, `${d.length - max} more`] : out;
}

/** A compact line diff (changed lines only), for expressions. */
export function lineDiff(a: string, b: string, max = 10): string[] {
  const x = a.split(/\r\n|\r|\n/), y = b.split(/\r\n|\r|\n/), m = x.length, n = y.length;
  if (m * n > 250_000) return [`(${m} -> ${n} lines)`];
  const L = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: string[] = [];
  for (let i = 0, j = 0; i < m || j < n; ) {
    if (i < m && j < n && x[i] === y[j]) (i++, j++);
    else if (i < m && (j >= n || L[i + 1][j] >= L[i][j + 1])) out.push("- " + x[i++]);
    else out.push("+ " + y[j++]);
  }
  return out.length > max ? [...out.slice(0, max), `(${out.length - max} more changed lines)`] : out;
}

/** Mask settings in the order AE shows them, with readable names; enum values as AE shows them ("SAME_AS_LAYER" -> "Same as layer"). */
const MASK_FIELDS: Record<string, string> = { maskMode: "mode", inverted: "inverted", maskFeatherFalloff: "feather falloff", maskMotionBlur: "motion blur", rotoBezier: "RotoBezier", locked: "locked", color: "color" };
const enumText = (v: unknown) => (typeof v === "string" && /^[A-Z][A-Z0-9_]*$/.test(v) ? v.replace(/^FFO_/, "").replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase()) : v);
const maskShow = (v: unknown) => (typeof v === "string" ? enumText(v) as string : fmt(v));

const KEY_FIELDS: Record<string, string> = { ip: "interpolation", e: "ease", f: "flags", lb: "label" };

function keyChange(a: Key, b: Key): string {
  const d = same(a.v, b.v) ? [] : [fmtChange(a.v, b.v)];
  if (!same(a.tan, b.tan)) d.push("spatial tangents changed");
  for (const k in KEY_FIELDS) if ((a as any)[k] !== (b as any)[k]) d.push(`${KEY_FIELDS[k]} ${(a as any)[k] ?? "-"} -> ${(b as any)[k] ?? "-"}`);
  return d.join(", ");
}

/** Keyframes matched by time; a key at a new time with the same value counts as moved. */
export function diffKeys(a: Key[] = [], b: Key[] = [], max = 4): string[] {
  const ta = new Map(a.map((k) => [k.t, k])), tb = new Map(b.map((k) => [k.t, k]));
  const removed = a.filter((k) => !tb.has(k.t)), added = b.filter((k) => !ta.has(k.t)), out: string[] = [];
  for (const r of [...removed]) {
    const i = added.findIndex((k) => same(k.v, r.v));
    if (i < 0) continue;
    const m = added.splice(i, 1)[0], rest = keyChange(r, m);
    removed.splice(removed.indexOf(r), 1);
    out.push(`moved ${at(r.t)} -> ${at(m.t)}${rest ? ` (${rest})` : ""}`);
  }
  for (const k of a) if (tb.has(k.t) && !same(k, tb.get(k.t))) out.push(`${at(k.t)} ${keyChange(k, tb.get(k.t)!)}`);
  out.push(...added.map((k) => `+ ${at(k.t)} ${fmt(k.v, 40)}`), ...removed.map((k) => `- ${at(k.t)} ${fmt(k.v, 40)}`));
  return out.length > max ? [...out.slice(0, max), `${out.length - max} more`] : out;
}

// ---------- diff ----------

export type Counts = Record<string, number>;
/** lines: the text; changes: the same changes as structured rows for the in-chat view (never in the text) */
interface Section { title: string; comp?: Item; lines: string[]; changes: ViewChange[] }
/** a change of the layer being diffed, for the view (diffComp adds the comp and layer) */
type Rec = (c: Omit<ViewChange, "comp" | "layer" | "layerIndex">) => void;
/** "ADBE Transform Group/..." display path's parent as the view shows it: "Transform › ..." */
const viewPath = (p: string) => (parentOf(p) ? { path: parentOf(p).split("/").join(" › ") } : {});
export interface DiffResult { counts: Counts; sections: Section[]; notes: string[] }

/** Indices (into seq) of a longest increasing subsequence: everything else "moved". */
function lis(seq: number[]): Set<number> {
  const tails: number[] = [], prev: number[] = [];
  seq.forEach((v, i) => {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < v) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo ? tails[lo - 1] : -1;
    tails[lo] = i;
  });
  const keep = new Set<number>();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) keep.add(i);
  return keep;
}

const kind = (k: string) => (/^ADBE Effect Parade\/[^/]+$/.test(k) ? "effect" : /^ADBE Mask Parade\/[^/]+$/.test(k) ? "mask" : "group");
type Inc = (k: string, n?: number) => void;

/** A property's static value; undefined = at its default (not stored, or AE says it is at its default). */
const staticValue = (p?: Prop) => (!p || p.vd ? undefined : p.v);

function diffLayer(la: Layer, lb: Layer, name: string, inc: Inc, out: string[], rec: Rec) {
  const ga = la.groups;
  // groups renamed in place (same match name and position under the same parent): compare their contents
  const renames: [string, string][] = [];
  const rekey = (k: string) => renames.reduce((k, [from, to]) => (k === from || k.startsWith(from + "/") ? to + k.slice(from.length) : k), k);
  for (const k of Object.keys(lb.groups).sort((x, y) => x.split("/").length - y.split("/").length)) {
    const kb = rekey(k), g = lb.groups[k], bKeys = new Set(Object.keys(lb.groups).map(rekey));
    const r = ga[kb] ? undefined : Object.keys(ga).find((ka) => !bKeys.has(ka) && parentOf(ka) === parentOf(kb) && ga[ka].match === g.match && ga[ka].i === g.i);
    if (!r) continue;
    renames.push([kb, r]);
    out.push(`~ ${name} > ${ga[r].path}: renamed ${q(lastSeg(ga[r].path))} -> ${q(lastSeg(g.path))}`);
    rec({ op: "~", ...viewPath(ga[r].path), what: "Renamed", from: lastSeg(ga[r].path), to: lastSeg(g.path) });
    inc("groups renamed");
  }
  const gb: Record<string, Group> = {}, pb: Record<string, Prop> = {};
  for (const k in lb.groups) gb[rekey(k)] = lb.groups[k];
  for (const k in lb.props) pb[rekey(k)] = lb.props[k];

  const added = Object.keys(gb).filter((k) => !ga[k]), removed = Object.keys(ga).filter((k) => !gb[k]), gone = [...added, ...removed];
  const outer = (list: string[]) => list.filter((k) => !list.some((o) => k.startsWith(o + "/")));
  for (const k of outer(added)) {
    const inside = Object.keys(pb).filter((p) => p.startsWith(k + "/")).slice(0, 4).map((p) => `${lastSeg(pb[p].path)} ${pb[p].k ? `${pb[p].k!.length} keyframes` : fmt(pb[p].v, 30)}`);
    out.push(`+ ${name} > ${gb[k].path} (${gb[k].match})${inside.length ? `: ${inside.join(", ")}` : ""}`);
    rec({ op: "+", ...viewPath(gb[k].path), what: `${lastSeg(gb[k].path)} added` });
    inc(`${kind(k)}s added`);
  }
  for (const k of outer(removed)) {
    out.push(`- ${name} > ${ga[k].path}`);
    rec({ op: "-", ...viewPath(ga[k].path), what: `${lastSeg(ga[k].path)} removed` });
    inc(`${kind(k)}s removed`);
  }
  const common = Object.keys(gb).filter((k) => ga[k]);
  for (const k of common) {
    if ((ga[k].on ?? true) === (gb[k].on ?? true)) continue;
    out.push(`~ ${name} > ${gb[k].path}: turned ${gb[k].on === false ? "off" : "on"}`);
    rec({ op: "~", ...viewPath(gb[k].path), what: `${lastSeg(gb[k].path)} turned ${gb[k].on === false ? "off" : "on"}` });
    inc("groups switched");
  }
  // mask settings (snapshots from before they were recorded have none: not compared)
  for (const k of common) {
    const a = ga[k].a, b = gb[k].a;
    if (!a || !b || same(a, b)) continue;
    const d = Object.keys(MASK_FIELDS).filter((f) => !same(a[f], b[f])).map((f) => `${MASK_FIELDS[f]} ${maskShow(a[f])} -> ${maskShow(b[f])}`);
    if (!d.length) continue;
    out.push(`~ ${name} > ${gb[k].path}: ${d.join("; ")}`);
    rec({ op: "~", ...viewPath(gb[k].path), what: `${lastSeg(gb[k].path)}: ${d.join("; ")}` });
    inc("masks changed");
  }
  // stacking order of the children that exist on both sides, per parent
  for (const p of new Set(common.map(parentOf))) {
    const kids = common.filter((k) => parentOf(k) === p).sort((x, y) => ga[x].i - ga[y].i);
    const moved = kids.length - lis(kids.map((k) => gb[k].i)).size;
    if (!moved) continue;
    const list = (s: Record<string, Group>) => [...kids].sort((x, y) => s[x].i - s[y].i).slice(0, 8).map((k) => lastSeg(s[k].path)).join(", ");
    out.push(`~ ${name} > ${parentOf(gb[kids[0]].path)}: reordered (${list(ga)} -> ${list(gb)})`);
    rec({ op: "~", ...viewPath(gb[kids[0]].path), what: "Reordered", from: list(ga), to: list(gb) });
    inc(p === "ADBE Effect Parade" ? "effects reordered" : "groups reordered", moved);
  }
  // property values, keyframes, expressions (not inside a group that was added or removed)
  for (const k of union(la.props, pb)) {
    const a = la.props[k], b = pb[k];
    if (same(a, b) || gone.some((g) => k.startsWith(g + "/"))) continue;
    const parts: string[] = [], extra: string[] = [];
    let staticNote = "";
    if (a?.k || b?.k) {
      const na = a?.n ?? a?.k?.length, nb = b?.n ?? b?.k?.length, kd = diffKeys(a?.k, b?.k);
      const beyond = a?.n || b?.n ? " (keys beyond 500 compared by checksum)" : "";
      if (!a?.k) parts.push(`now animated, ${nb} keyframes${a?.v !== undefined ? ` (was ${fmt(a.v)})` : ""}`);
      else if (!b?.k) parts.push(`keyframes removed (${na}), now ${fmt(b?.v)}`);
      else if (kd.length || na !== nb) parts.push(`keyframes${na !== nb ? ` ${na} -> ${nb}` : ""}${kd.length ? `: ${kd.join("; ")}` : ""}${beyond}`);
      else if (a.ks !== b.ks) parts.push(`keyframes changed after key 500${beyond}`);
      if (parts.length) inc("keyframe changes");
    } else if (!same(staticValue(a), staticValue(b))) {
      // a property present only because an expression was added or removed (the other side is at its
      // default): its static value is shown with the expression change, not as a value change of its own
      if (!a && b?.x) staticNote = ` (static value ${fmt(b.v)})`;
      else if (!b && a?.x) staticNote = ` (static value was ${fmt(a.v)}, now default)`;
      else {
        parts.push(fmtChange(staticValue(a), staticValue(b)));
        inc("values changed");
      }
    }
    const xa = a?.x ?? "", xb = b?.x ?? "", toggled = !a?.xoff !== !b?.xoff && xa && xb;
    if (xa !== xb) {
      if (!xa) parts.push(`expression added: ${xb.includes("\n") ? `(${xb.split("\n").length} lines)` : fmt(xb, 80)}${staticNote}`);
      else if (!xb) parts.push(`expression removed${staticNote}`);
      else parts.push("expression changed:"), extra.push(...lineDiff(xa, xb));
    }
    if (toggled) parts.push(`expression ${b?.xoff ? "disabled" : "enabled"}`);
    if (xa !== xb || toggled) inc("expressions changed");
    if (parts.length) out.push(`~ ${name} > ${(b ?? a).path}: ${parts.join("; ")}`, ...extra.map((l) => `      ${l}`));
    if (parts.length) {
      // a plain value change: its two sides, so the view can strike the old one through
      const path = (b ?? a).path, one = parts.length === 1 && !(a?.k || b?.k) && xa === xb && !toggled ? splitChange(parts[0]) : null;
      rec({ op: "~", ...viewPath(path), ...(one ? { what: lastSeg(path), ...one } : { what: `${lastSeg(path)}: ${parts.join("; ")}` }) });
    }
  }
}

function diffComp(a: Item, b: Item, inc: Inc, out: string[], changes: ViewChange[]) {
  const A = a.layers!, B = b.layers!;
  const line = (L: Layer, op: string) => `${op} layer #${L.index} ${q(L.name)} (${L.type})`;
  const at = (L: Layer) => ({ comp: b.name, layer: L.name, layerIndex: L.index });
  for (const L of Object.values(B).sort((x, y) => x.index - y.index))
    if (!A[L.key]) out.push(line(L, "+")), inc("layers added"), changes.push({ op: "+", ...at(L), what: `${L.name} added (${L.type})` });
  for (const L of Object.values(A).sort((x, y) => x.index - y.index))
    if (!B[L.key]) out.push(line(L, "-")), inc("layers removed"), changes.push({ op: "-", comp: b.name, layer: L.name, what: `${L.name} removed (layer ${L.index})` });
  const common = Object.keys(B).filter((k) => A[k]).sort((x, y) => A[x].index - A[y].index);
  const keep = lis(common.map((k) => B[k].index));
  common.forEach((k, i) => {
    const la = A[k], lb = B[k], d: string[] = [];
    if (la.name !== lb.name) d.push(`renamed from ${q(la.name)}`), inc("layers renamed");
    if (!keep.has(i)) d.push(`moved #${la.index} -> #${lb.index}`), inc("layers moved");
    // parent / track matte are layer keys: shown by name
    const attrs = fieldDiff(la.attrs, lb.attrs, 99, (v, s) => (typeof v === "string" && [A, B][s][v] ? q([A, B][s][v].name) : fmt(v)));
    if (attrs.length) inc("layers changed");
    if (d.length + attrs.length) {
      out.push(`~ layer #${lb.index} ${q(lb.name)}: ${[...d, ...attrs].join("; ")}`);
      const one =
        !d.length && attrs.length === 1 ? splitField(attrs[0]) : d.length === 1 && !attrs.length && la.name !== lb.name ? { what: "Renamed", from: la.name, to: lb.name } : null;
      changes.push({ op: "~", ...at(lb), ...(one ?? { what: [...d, ...attrs].join("; ") }) });
    }
    diffLayer(la, lb, lb.name, inc, out, (c) => changes.push({ ...c, ...at(lb) }));
  });
  const md = diffKeys(a.markers, b.markers, 8);
  if (md.length) out.push(`~ comp markers: ${md.join("; ")}`), inc("marker changes"), changes.push({ op: "~", comp: b.name, what: `Comp markers: ${md.join("; ")}` });
}

function itemLine(it: Item): string {
  const f = it.fields;
  const b = it.type === "comp" ? `${f.width}x${f.height}, ${num(Number(f.duration))}s, ${num(Number(f.frameRate))} fps${it.layers ? `, ${Object.keys(it.layers).length} layers` : ""}` : f.file;
  return `${it.type} ${q(it.name)}${b ? ` (${b})` : ""}`;
}

/** A render queue item as flat fields, so changes read "output 1 file a -> b". */
function rqFields(r: Record<string, any>) {
  const { index, comp, compName, oms, ...o } = r;
  (oms ?? []).forEach((m: any, i: number) => {
    const { "Output File Info": _, ...settings } = m.settings ?? {};
    Object.assign(o, { [`output ${i + 1} file`]: m.file, [`output ${i + 1} template`]: m.template, [`output ${i + 1} settings`]: settings });
  });
  return o;
}

export function diffSnapshots(a: Snapshot, b: Snapshot): DiffResult {
  const counts: Counts = {}, sections: Section[] = [], notes: string[] = [];
  const inc: Inc = (k, n = 1) => void (counts[k] = (counts[k] ?? 0) + n);
  const section = (title: string, lines: string[], changes: ViewChange[], comp?: Item) => lines.length && sections.push({ title, lines, changes, comp });

  const pd = fieldDiff(a.settings, b.settings), ps = pd.map((l) => `~ ${l}`);
  if (ps.length) inc("project settings changed", ps.length);
  section("Project settings", ps, pd.map((l): ViewChange => ({ op: "~", ...(splitField(l) ?? { what: l }) })));

  const items: string[] = [], itemChanges: ViewChange[] = [], skipped: string[] = [], comps: [Item, Item][] = [];
  for (const id of union(a.items, b.items).sort((x, y) => +x - +y)) {
    const o = a.items[id], it = b.items[id];
    if (!o || !it) {
      const x = o ?? it;
      items.push(`${o ? "-" : "+"} ${itemLine(x)}`);
      // a removed comp can't be shown in After Effects
      itemChanges.push({ op: o ? "-" : "+", ...(x.type === "comp" && !o ? { comp: x.name } : {}), what: `${x.type} ${x.name} ${o ? "removed" : "added"}` });
      inc(`${x.type}s ${o ? "removed" : "added"}`);
      continue;
    }
    const d = o.name !== it.name ? [`renamed from ${q(o.name)}`] : [];
    if (o.folder !== it.folder) d.push(`moved to folder ${q(it.folder || "(root)")} (was ${q(o.folder || "(root)")})`);
    d.push(...fieldDiff(o.fields, it.fields));
    if (d.length) {
      items.push(`~ ${it.type} ${q(it.name)}: ${d.join("; ")}`), inc(`${it.type}s ${o.name !== it.name ? "renamed" : "changed"}`);
      const one = d.length === 1 ? splitField(d[0]) : null;
      itemChanges.push({ op: "~", ...(it.type === "comp" ? { comp: it.name } : {}), ...(one ?? { what: `${it.type} ${it.name}: ${d.join("; ")}` }) });
    }
    if (it.type !== "comp") continue;
    if (o.layers && it.layers && !o.partial && !it.partial) comps.push([o, it]);
    else skipped.push(q(it.name));
  }
  section("Project items", items, itemChanges);
  for (const [o, it] of comps) {
    const lines: string[] = [], changes: ViewChange[] = [];
    diffComp(o, it, inc, lines, changes);
    section(`Comp ${q(it.name)} (id ${it.id})`, lines, changes, it);
  }
  if (skipped.length)
    notes.push(`Layers not compared in ${skipped.length} comp${skipped.length > 1 ? "s" : ""} (not captured in both snapshots: limited with comps, or the time budget ran out): ${skipped.slice(0, 10).join(", ")}${skipped.length > 10 ? ", ..." : ""}`);

  const rq: string[] = [], rqChanges: ViewChange[] = [];
  for (const k of union(a.rq, b.rq)) {
    const o = a.rq[k], r = b.rq[k], name = `#${(r ?? o).index} ${q((r ?? o).compName)}`;
    const d = o && r ? fieldDiff(rqFields(o), rqFields(r)) : [];
    const what = `Render queue item ${(r ?? o).index} (${(r ?? o).compName})`;
    if (!o || !r) rq.push(`${o ? "-" : "+"} ${name}`), rqChanges.push({ op: o ? "-" : "+", what: `${what} ${o ? "removed" : "added"}` });
    else if (d.length) rq.push(`~ ${name}: ${d.join("; ")}`), rqChanges.push({ op: "~", what: `${what}: ${d.join("; ")}` });
  }
  if (rq.length) inc("render queue changes", rq.length);
  const notRead = Math.max(a.stats?.rqNotRead ?? 0, b.stats?.rqNotRead ?? 0);
  if (notRead) notes.push(`Only the first 50 render queue items were read; the other ${notRead} were not compared.`);
  section("Render queue", rq, rqChanges);
  return { counts, sections, notes };
}

const ORDER = ["comps", "layers", "values", "keyframe", "expressions", "effects", "masks", "groups", "marker", "footage", "solids", "folders", "render", "project"];
const VERBS = ["added", "removed", "renamed", "moved", "reordered"];

export function summary(counts: Counts): string {
  const rank = (k: string) => (ORDER.findIndex((o) => k.startsWith(o)) >>> 0) * 9 + (VERBS.findIndex((v) => k.endsWith(v)) >>> 0) / 1e10;
  const keys = Object.keys(counts).sort((x, y) => rank(x) - rank(y) || x.localeCompare(y));
  if (!keys.length) return "No differences.";
  return keys.map((k) => `${counts[k]} ${counts[k] === 1 ? k.replace(/^(\w+)s\b/, "$1").replace(/ changes$/, " change") : k}`).join(", ");
}

/** The diff as text: summary first, then sections, capped at `limit` change lines; `detail` = one comp (id or name). */
export function formatDiff(d: DiffResult, opts: { limit?: number; detail?: string | number } = {}): string {
  let sections = d.sections;
  if (opts.detail !== undefined) {
    const want = String(opts.detail), comps = sections.filter((s) => s.comp);
    sections = comps.filter((s) => String(s.comp!.id) === want || s.comp!.name === want);
    if (!sections.length) return `No layer changes in comp ${q(want)}${comps.length ? ` (comps with changes: ${comps.map((s) => q(s.comp!.name)).join(", ")})` : ""}.`;
  }
  const out = [`Summary: ${summary(d.counts)}`, ...d.notes.map((n) => `Note: ${n}`)], more: string[] = [];
  let room = opts.limit ?? (opts.detail !== undefined ? 2000 : 150), hidden = 0;
  for (const s of sections) {
    if (room > 0) out.push("", `${s.title}:`, ...s.lines.slice(0, room).map((l) => `  ${l}`));
    const rest = s.lines.length - Math.max(0, room);
    room -= s.lines.length;
    if (rest > 0) (hidden += rest), s.comp && more.push(`${q(s.comp.name)} (${rest} more)`);
  }
  if (hidden)
    out.push("", `... ${hidden} more change line${hidden > 1 ? "s" : ""} not shown.${more.length ? ` Show one comp in full with detail: ${more.slice(0, 5).join(", ")}.` : " Raise limit to see more."}`);
  return out.join("\n");
}
