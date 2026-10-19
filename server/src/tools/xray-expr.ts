// Project X-ray: a tokenizer-level reader for After Effects expressions. It finds what an
// expression points at (comps, layers, effects, effect parameters, shape groups, masks, footage,
// parents) and HOW (by name, by index, by a value computed at run time), so the analysis can tell
// which links break on a rename, a reorder or in another AE language. It understands comments, all
// string forms (incl. templates), regex literals, chained and multi-line calls, and simple variables
// (`const ctrl = thisComp.layer("CTRL"); ctrl.effect(...)`). It never evaluates anything.

export interface Tok {
  t: "id" | "num" | "str" | "punc" | "re" | "tpl";
  v: string;
  /** source range */
  s: number;
  e: number;
  /** a line break comes before this token */
  nl: boolean;
}

const PUNC = /\.\.\.|>>>=?|===|!==|(?:\*\*|<<|>>|&&|\|\||\?\?|[-+*/%&|^=!<>])=|=>|&&|\|\||\?\?|\?\.(?!\d)|\+\+|--|<<|>>|\*\*|[^]/y;
const BEFORE_EXPR = /^(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;
const ID = /[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*/uy;
const NUM = /(?:0[xXoObB][\da-fA-F_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)n?/y;
const NL = /[\n\r\u2028\u2029]/;
const ESC: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0", "\n": "", "\r": "", "\u2028": "", "\u2029": "" };

/** The character(s) an escape at src[j] (a backslash) stands for, and where the escape ends. */
function unescape(src: string, j: number): [string, number] {
  const c = src[j + 1] ?? "";
  const hex = (len: number) => (/^[\da-fA-F]+$/.test(src.substr(j + 2, len)) && src.substr(j + 2, len).length === len ? parseInt(src.substr(j + 2, len), 16) : NaN);
  if (c === "x" && hex(2) >= 0) return [String.fromCharCode(hex(2)), j + 4];
  if (c === "u" && hex(4) >= 0) return [String.fromCharCode(hex(4)), j + 6];
  if (c === "u" && src[j + 2] === "{") {
    const close = src.indexOf("}", j + 3);
    const digits = close > j + 3 ? src.slice(j + 3, close) : "";
    const cp = /^[\da-fA-F]{1,8}$/.test(digits) ? parseInt(digits, 16) : NaN;
    if (cp >= 0 && cp <= 0x10ffff) return [String.fromCodePoint(cp), close + 1];
  }
  const end = c === "\r" && src[j + 2] === "\n" ? j + 3 : j + 2;
  return [c in ESC && !(c === "0" && /\d/.test(src[j + 2] ?? "")) ? ESC[c] : c, end];
}

/** Lexes JavaScript (ES3 to modern) leniently: never throws; unknown characters become punctuation. */
export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const braces: string[] = []; // "{" or "`" (inside a template substitution)
  const n = src.length;
  let i = 0, nl = false;
  const push = (t: Tok["t"], v: string, s: number, e: number) => {
    out.push({ t, v, s, e, nl });
    nl = false;
    i = e;
  };
  // template text from j (after ` or }) up to the closing ` or the next ${
  const template = (s: number, j: number) => {
    let text = "";
    while (j < n && src[j] !== "`" && !(src[j] === "$" && src[j + 1] === "{")) {
      if (src[j] === "\\") {
        const [v, next] = unescape(src, j);
        text += v;
        j = next;
      } else text += src[j++];
    }
    const open = src[j] === "$";
    if (open) braces.push("`");
    // a template without substitutions is a plain string
    push(!open && src[s] === "`" ? "str" : "tpl", text, s, Math.min(n, j + (open ? 2 : 1)));
  };
  const regexAllowed = () => {
    const p = out[out.length - 1];
    if (!p || p.t === "tpl") return !p || braces[braces.length - 1] === "`";
    if (p.t === "id") return BEFORE_EXPR.test(p.v);
    return p.t === "punc" && !/^(?:[)\]}]|\+\+|--)$/.test(p.v);
  };
  while (i < n) {
    const ch = src[i];
    if (NL.test(ch)) (nl = true), i++;
    else if (/\s/.test(ch)) i++;
    else if (src.startsWith("//", i)) while (i < n && !NL.test(src[i])) i++;
    else if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      if (NL.test(src.slice(i, stop))) nl = true;
      i = stop;
    } else if (ch === '"' || ch === "'") {
      let j = i + 1, v = "";
      while (j < n && src[j] !== ch && src[j] !== "\n") {
        if (src[j] === "\\") {
          const [c, next] = unescape(src, j);
          v += c;
          j = next;
        } else v += src[j++];
      }
      push("str", v, i, Math.min(j + 1, n));
    } else if (ch === "`") template(i, i + 1);
    else if (ch === "}" && braces[braces.length - 1] === "`") braces.pop(), template(i, i + 1);
    else if (/\d/.test(ch) || (ch === "." && /\d/.test(src[i + 1] ?? ""))) {
      NUM.lastIndex = i;
      push("num", NUM.exec(src)![0], i, NUM.lastIndex);
    } else if ((ID.lastIndex = i) >= 0 && ID.exec(src)) push("id", src.slice(i, ID.lastIndex), i, ID.lastIndex);
    else {
      if (ch === "/" && regexAllowed()) {
        let j = i + 1, cls = false;
        for (; j < n && src[j] !== "\n" && (cls || src[j] !== "/"); j++) {
          if (src[j] === "\\") j++;
          else if (src[j] === "[") cls = true;
          else if (src[j] === "]") cls = false;
        }
        if (src[j] === "/") {
          for (j++; /[a-z]/i.test(src[j] ?? ""); ) j++;
          push("re", src.slice(i, j), i, j);
          continue;
        }
      }
      if (ch === "{") braces.push("{");
      if (ch === "}") braces.pop();
      PUNC.lastIndex = i;
      const v = PUNC.exec(src)![0];
      push("punc", v, i, i + v.length);
    }
  }
  return out;
}

// ---------- references ----------

/** How a target is named: a literal name or index, or something computed when the expression runs. */
export type Sel =
  | { by: "name"; v: string }
  | { by: "index"; v: number }
  /** computed from a layer's index: thisComp.layer(index + 1), thisComp.layer(thisLayer, -1) */
  | { by: "relative"; text: string }
  | { by: "dynamic"; text: string };

export type CompSpec = { k: "this" } | { k: "sel"; sel: Sel } | { k: "sourceOf"; layer: LayerSpec };
/** a layer: `base` in `comp`, then `parents` steps up the parent chain */
export interface LayerSpec {
  comp: CompSpec;
  base: Sel | "this";
  parents: number;
}

export type ExprRef =
  | { kind: "comp"; comp: CompSpec; text: string }
  | { kind: "layer"; layer: LayerSpec; text: string }
  | { kind: "parent"; layer: LayerSpec; text: string }
  | { kind: "effect"; layer: LayerSpec; effect: Sel; text: string }
  | { kind: "param"; layer: LayerSpec; effect: Sel; param: Sel; text: string }
  | { kind: "content" | "mask" | "property"; layer: LayerSpec; path: Sel[]; text: string }
  | { kind: "footage"; item: Sel; text: string };

export interface ParsedExpression {
  refs: ExprRef[];
  /** uses try/catch: a missing target may be handled on purpose */
  guarded: boolean;
  /** checks hasParent before using parent */
  parentGuard: boolean;
}

type NoText<T> = T extends unknown ? Omit<T, "text"> : never;

type Ctx =
  | { k: "comp"; comp: CompSpec }
  | { k: "layer"; layer: LayerSpec }
  | { k: "effect"; layer: LayerSpec; effect: Sel }
  | { k: "group"; kind: "content" | "mask" | "property"; layer: LayerSpec; path: Sel[] };

const SELF: LayerSpec = { comp: { k: "this" }, base: "this", parents: 0 };
/** layer methods that reach a group by name or index */
const GROUPS = /^(?:effect|content|mask)$/;

export function looksLikeMatchName(s: string): boolean {
  return /^ADBE[ A-Z]|-\d{4}$|^Pseudo\//.test(s);
}

export function parseExpression(src: string): ParsedExpression {
  const toks = tokenize(src);
  const T = (k: number): Tok | undefined => toks[k];
  const is = (k: number, re: RegExp) => T(k)?.t === "punc" && re.test(toks[k].v);
  const isDot = (k: number) => is(k, /^\??\.$/);
  const isEnd = (k: number) => k >= toks.length || toks[k].nl || is(k, /^[;,)}\]:]$/);
  const refs: ExprRef[] = [];
  const objs = new Map<string, Ctx>();
  const consts = new Map<string, Sel>();
  // names assigned more than once (loop counters...) are not constants
  const assigned = new Map<string, number>();
  toks.forEach((t, k) => {
    if (t.t !== "id" || isDot(k - 1)) return;
    const w = is(k + 1, /^(?:\+\+|--)$/) ? 2 : is(k + 1, /^(?:[^=!<>]{0,3})=$/) || is(k - 1, /^(?:\+\+|--)$/) ? 1 : 0;
    if (w) assigned.set(t.v, (assigned.get(t.v) ?? 0) + w);
  });
  const text = (from: number, to: number) => {
    // ranges can run past the last token when a call is never closed: clamp, never read undefined
    const last = toks.length - 1;
    if (last < 0 || from > last) return "";
    const s = src.slice(toks[from].s, toks[Math.min(last, Math.max(from, to - 1))].e).replace(/\s+/g, " ");
    return s.length > 100 ? s.slice(0, 97) + "..." : s;
  };

  /** "(" at k: the top-level arguments as token ranges, and the index after ")" */
  const callArgs = (k: number) => {
    const args: [number, number][] = [];
    let depth = 0, start = k + 1, j = k;
    for (; j < toks.length; j++) {
      if (is(j, /^[([{]$/)) depth++;
      else if (is(j, /^[)\]}]$/) && --depth === 0) break;
      else if (depth === 1 && is(j, /^,$/)) args.push([start, j]), (start = j + 1);
    }
    if (j > start) args.push([start, Math.min(j, toks.length)]);
    // an unclosed call ends at the last token
    return { args, end: Math.min(j + 1, toks.length) };
  };

  const sel = (args: [number, number][], all = false): Sel => {
    if (!args.length) return { by: "dynamic", text: "" };
    const [s, e] = args[0];
    const t0 = toks[s];
    if (all && args.length > 1) return { by: "relative", text: text(s, args[args.length - 1][1]) };
    if (e - s === 1 && t0.t === "str") return { by: "name", v: t0.v };
    if (e - s === 1 && t0.t === "num") return { by: "index", v: Number(t0.v.replace(/_/g, "")) };
    if (e - s === 1 && t0.t === "id" && consts.has(t0.v)) return consts.get(t0.v)!;
    // computed from a layer index (this layer's or another one's): moves with the layer order
    const rel = toks.slice(s, e).some((t) => t.t === "id" && t.v === "index");
    return { by: rel ? "relative" : "dynamic", text: text(s, e) };
  };

  /** The chain of member accesses and calls that starts at the identifier at i. */
  const chain = (i: number): { end: number; ctx: Ctx | null; refs: ExprRef[] } | null => {
    const name = toks[i].v;
    const found: ExprRef[] = [];
    let ctx = null as Ctx | null; // (assigned in the closures below)
    let j = i + 1;
    const call = () => (is(j, /^\($/) ? callArgs(j) : null);
    const emit = (r: NoText<ExprRef>) => found.push({ ...r, text: text(i, j) } as ExprRef);
    const endGroup = () => ctx?.k === "group" && emit({ kind: ctx.kind, layer: ctx.layer, path: ctx.path });
    // effect("x"), content("x"), mask("x") on a layer
    const groupOf = (layer: LayerSpec, m: string) => {
      const c = call();
      if (!c) return false;
      const s = sel(c.args);
      j = c.end;
      if (m === "effect") emit({ kind: "effect", layer, effect: s }), (ctx = { k: "effect", layer, effect: s });
      else ctx = { k: "group", kind: m as "content" | "mask", layer, path: [s] };
      return true;
    };
    const layerOf = (comp: CompSpec) => {
      const c = call();
      if (!c) return false;
      j = c.end;
      const layer: LayerSpec = { comp, base: sel(c.args, true), parents: 0 };
      emit({ kind: "layer", layer });
      ctx = { k: "layer", layer };
      return true;
    };
    const parentOf = (l: LayerSpec) => {
      const layer = { ...l, parents: l.parents + 1 };
      emit({ kind: "parent", layer });
      ctx = { k: "layer", layer };
    };

    if (objs.has(name)) ctx = structuredClone(objs.get(name)!);
    else if (name === "thisComp") ctx = { k: "comp", comp: { k: "this" } };
    else if (name === "thisLayer") ctx = { k: "layer", layer: SELF };
    else if (name === "comp" || name === "footage") {
      const c = call();
      if (!c) return null;
      j = c.end;
      const s = sel(c.args);
      if (name === "footage") return { end: j, ctx: null, refs: [{ kind: "footage", item: s, text: text(i, j) }] };
      ctx = { k: "comp", comp: { k: "sel", sel: s } };
      emit({ kind: "comp", comp: ctx.comp });
    } else if (name === "parent") parentOf(SELF);
    else if (!(name === "layer" ? layerOf({ k: "this" }) : GROUPS.test(name) && groupOf(SELF, name))) return null;

    while (ctx) {
      const c: Ctx = ctx;
      if (isDot(j) && T(j + 1)?.t === "id") {
        const m = toks[j + 1].v;
        j += 2;
        if (c.k === "comp") {
          if (!(m === "layer" && layerOf(c.comp))) ctx = null;
        } else if (c.k === "layer") {
          if (GROUPS.test(m) && groupOf(c.layer, m)) continue;
          if (m === "parent") parentOf(c.layer);
          else ctx = m === "source" ? { k: "comp", comp: { k: "sourceOf", layer: c.layer } } : null;
        } else if (c.k === "effect") {
          const a = m === "param" ? call() : null;
          if (a) (j = a.end), emit({ kind: "param", layer: c.layer, effect: c.effect, param: sel(a.args) });
          ctx = null;
        } else {
          const a = c.kind === "content" && m === "content" ? call() : null;
          if (a) (j = a.end), c.path.push(sel(a.args));
          else endGroup(), (ctx = null);
        }
        continue;
      }
      const a = call();
      if (!a) break;
      // calling an object directly reads a property (group) by name or index
      const s = sel(a.args);
      j = a.end;
      if (c.k === "effect") emit({ kind: "param", layer: c.layer, effect: c.effect, param: s }), (ctx = null);
      else if (c.k === "layer") ctx = { k: "group", kind: "property", layer: c.layer, path: [s] };
      else if (c.k === "group") c.path.push(s);
      else ctx = null;
    }
    endGroup();
    return { end: j, ctx, refs: found };
  };

  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.t !== "id" || isDot(i - 1) || T(i - 1)?.v === "function") continue;
    // bindings: var/let/const x = ..., x = ...
    if (is(i + 1, /^=$/)) {
      const r = T(i + 2);
      consts.delete(tk.v);
      objs.delete(tk.v);
      if (r && (r.t === "str" || r.t === "num") && isEnd(i + 3) && (assigned.get(tk.v) ?? 0) <= 1) consts.set(tk.v, r.t === "str" ? { by: "name", v: r.v } : { by: "index", v: Number(r.v) });
      const c = r?.t === "id" ? chain(i + 2) : null;
      if (c) {
        refs.push(...c.refs);
        if (c.ctx && isEnd(c.end)) objs.set(tk.v, c.ctx);
        i += 2; // the chain's own arguments are still read (nested references)
      }
      continue;
    }
    refs.push(...(chain(i)?.refs ?? []));
  }
  const has = (v: string) => toks.some((t) => t.t === "id" && t.v === v);
  return { refs, guarded: has("try"), parentGuard: has("hasParent") };
}
