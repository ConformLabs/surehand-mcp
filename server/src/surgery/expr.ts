// Precomp surgery: what an After Effects expression refers to, with exact source positions, so a reference can be
// rewritten in place (by position, never by search and replace). Parsed with Babel (the real JavaScript grammar:
// strings with escapes, template literals, comments, regex literals, scopes), so `comp("Logo")` inside a comment or a
// string is not a reference, and a local variable called `time` or `index` is not After Effects' one. Legacy
// ExtendScript expressions that Babel can't parse are scanned with X-ray's lenient tokenizer: when they mention
// nothing the surgery cares about they need no rewrite; otherwise they are reported as unparseable (never guessed).
import { Babel } from "../transpile.js";
import { tokenize } from "../tools/xray-expr.js";

export type Range = [number, number];

/** What is done with a comp object (`thisComp` or `comp("X")`). */
export type CompUse =
  /** .layer(arg): by name, by index, or computed (a variable, `index + 1`, two arguments...) */
  | { kind: "layer"; by: "name"; name: string; argRange: Range; quote: Quote }
  | { kind: "layer"; by: "index"; index: number; argRange: Range }
  | { kind: "layer"; by: "dynamic"; text: string }
  /** any other member: .width, .numLayers, .marker, .name... */
  | { kind: "member"; name: string }
  /** stored in a variable, passed to a function, compared...: what it is used for can't be followed */
  | { kind: "escape"; text: string };

export type Quote = '"' | "'" | "`";

export interface CompRef {
  /** thisComp (or legacy this_comp) */
  self: boolean;
  /** comp("X"): the literal name; null when the name is computed */
  name: string | null;
  /** the whole `thisComp` identifier or `comp(...)` call */
  range: Range;
  /** comp("X"): the name literal, quotes included */
  nameRange?: Range;
  quote?: Quote;
  use: CompUse;
  /** the source text of the reference, for reports */
  text: string;
}

export interface ExprFacts {
  /** false: the expression could not be parsed, and it mentions something a rewrite may depend on */
  ok: boolean;
  parseError?: string;
  /** parsed with the lenient tokenizer only (it mentions nothing a rewrite depends on) */
  lenient?: boolean;
  comps: CompRef[];
  /** the layer's own index: bare `index`, `thisLayer.index` (whole ranges) */
  index: Range[];
  /** bare `time` (After Effects' global, not a local of that name) */
  time: Range[];
  /** calls whose result depends on a random seed (wiggle, random, gaussRandom, seedRandom, temporalWiggle) */
  random: string[];
  /** layer-space conversions whose result depends on the comp the layer is in (toComp, fromComp, toWorld...) */
  space: string[];
  /** reads the layer's parent (parent, hasParent) */
  parent: boolean;
  /** reads the layer's source (the precomp a precomp layer shows) */
  source: boolean;
  /** uses eval: anything is possible */
  evalUsed: boolean;
}

const RANDOM = new Set(["wiggle", "random", "gaussRandom", "seedRandom", "temporalWiggle"]);
const SPACE = new Set(["toComp", "fromComp", "toWorld", "fromWorld", "toCompVec", "fromCompVec", "toWorldVec", "fromWorldVec", "fromCompToSurface"]);
/** identifiers whose presence means a lenient scan can't rule out a reference */
const RELEVANT = new Set(["thisComp", "this_comp", "comp", "index", "time", "thisLayer", "this_layer", "parent", "hasParent", "source", "eval", ...RANDOM, ...SPACE]);

const empty = (): ExprFacts => ({ ok: true, comps: [], index: [], time: [], random: [], space: [], parent: false, source: false, evalUsed: false });

/** A static string argument: "x", 'x' or `x` without substitutions. */
function staticString(node: any, src: string): { value: string; quote: Quote } | null {
  if (!node) return null;
  if (node.type === "StringLiteral") return { value: node.value, quote: src[node.start] === "'" ? "'" : '"' };
  if (node.type === "TemplateLiteral" && node.expressions.length === 0 && node.quasis.length === 1) {
    const cooked = node.quasis[0].value.cooked;
    return cooked == null ? null : { value: cooked, quote: "`" };
  }
  return null;
}

/** A non-negative integer literal (also `+3`), as After Effects reads a layer index. */
function indexLiteral(node: any): number | null {
  if (node?.type === "NumericLiteral" && Number.isInteger(node.value)) return node.value;
  return null;
}

/** The name of a member access: obj.name, obj["name"], obj?.name. null when computed. */
function memberName(m: any, src: string): string | null {
  if (!m.computed) return m.property.type === "Identifier" ? m.property.name : null;
  return staticString(m.property, src)?.value ?? null;
}

const isMember = (n: any) => n && (n.type === "MemberExpression" || n.type === "OptionalMemberExpression");
const isCall = (n: any) => n && (n.type === "CallExpression" || n.type === "OptionalCallExpression");

/** How a comp-valued node (`thisComp` or `comp(...)`) is used by its parents. */
function compUse(path: any, src: string): CompUse {
  const node = path.node;
  const parent = path.parent;
  const text = (n: any) => src.slice(n.start, n.end);
  // parentheses around it don't change anything: (thisComp).layer(...)
  if (isMember(parent) && parent.object === node) {
    const name = memberName(parent, src);
    if (name === null) return { kind: "escape", text: text(parent) };
    const grand = path.parentPath.parent;
    if (name === "layer") {
      if (!(isCall(grand) && grand.callee === parent)) return { kind: "escape", text: text(parent) };
      const args = grand.arguments;
      if (args.length === 1) {
        const s = staticString(args[0], src);
        if (s) return { kind: "layer", by: "name", name: s.value, argRange: [args[0].start, args[0].end], quote: s.quote };
        const i = indexLiteral(args[0]);
        if (i !== null) return { kind: "layer", by: "index", index: i, argRange: [args[0].start, args[0].end] };
      }
      return { kind: "layer", by: "dynamic", text: text(grand) };
    }
    return { kind: "member", name };
  }
  return { kind: "escape", text: text(parent ?? node) };
}

/** Parse an expression and list what it refers to. Never throws. */
export function analyzeExpression(src: string): ExprFacts {
  const out = empty();
  const add = (r: CompRef) => out.comps.push(r);
  const global = (path: any, name: string) => !path.scope.hasBinding(name, true);
  const visitor = {
    ReferencedIdentifier(path: any) {
      const n = path.node;
      if (n.type !== "Identifier") return;
      const name: string = n.name;
      if (!global(path, name)) return;
      const parent = path.parent;
      if (name === "thisComp" || name === "this_comp") {
        add({ self: true, name: null, range: [n.start, n.end], use: compUse(path, src), text: name });
        return;
      }
      if (name === "comp" && isCall(parent) && parent.callee === n) {
        const callPath = path.parentPath;
        const s = parent.arguments.length === 1 ? staticString(parent.arguments[0], src) : null;
        const arg = parent.arguments[0];
        add({
          self: false,
          name: s ? s.value : null,
          range: [parent.start, parent.end],
          ...(s ? { nameRange: [arg.start, arg.end] as Range, quote: s.quote } : {}),
          use: compUse(callPath, src),
          text: src.slice(parent.start, parent.end),
        });
        return;
      }
      if (name === "index") out.index.push([n.start, n.end]);
      else if (name === "time") out.time.push([n.start, n.end]);
      else if (name === "parent" || name === "hasParent") out.parent = true;
      else if (name === "source") out.source = true;
      else if (name === "eval") out.evalUsed = true;
      else if ((name === "thisLayer" || name === "this_layer") && isMember(parent) && parent.object === n) {
        const m = memberName(parent, src);
        if (m === "index") out.index.push([parent.start, parent.end]);
        else if (m === "parent" || m === "hasParent") out.parent = true;
        else if (m === "source") out.source = true;
        else if (m && SPACE.has(m)) out.space.push(m);
        else if (m && RANDOM.has(m)) out.random.push(m);
      } else if (RANDOM.has(name)) out.random.push(name);
      else if (SPACE.has(name)) out.space.push(name);
    },
    // property.wiggle(...), thisProperty.temporalWiggle(...), layer.toComp(...)
    "MemberExpression|OptionalMemberExpression"(path: any) {
      const m = memberName(path.node, src);
      if (!m || !isCall(path.parent) || path.parent.callee !== path.node) return;
      const obj = path.node.object;
      // thisLayer.x(...) is counted by the identifier visitor
      if (obj.type === "Identifier" && (obj.name === "thisLayer" || obj.name === "this_layer") && global(path, obj.name)) return;
      if (RANDOM.has(m)) out.random.push(m);
      else if (SPACE.has(m)) out.space.push(m);
    },
  };
  try {
    Babel().transform(src, {
      ast: false,
      code: false,
      sourceType: "script",
      babelrc: false,
      configFile: false,
      parserOpts: { allowReturnOutsideFunction: true },
      plugins: [() => ({ visitor })],
    } as any);
    out.comps.sort((a, b) => a.range[0] - b.range[0]);
    return out;
  } catch (e: any) {
    // legacy ExtendScript syntax (e.g. `if (a) b else c`): fine when it mentions nothing a rewrite depends on
    const mentions = tokenize(src).filter((t) => t.t === "id" && RELEVANT.has(t.v));
    const msg = String(e?.message ?? e).replace(/^unknown( file)?:\s*/, "").split("\n")[0];
    if (!mentions.length) return { ...empty(), lenient: true };
    return { ...empty(), ok: false, parseError: msg };
  }
}

// ---------- rewriting ----------

/** A string literal for `value` written with the same quote as the original. */
export function literal(value: string, quote: Quote): string {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  if (quote === "`") return "`" + esc(value).replace(/`/g, "\\`").replace(/\$\{/g, "\\${") + "`";
  const q = quote;
  return q + esc(value).split(q).join("\\" + q) + q;
}

export interface Edit {
  range: Range;
  text: string;
}

/** Apply edits by position (they must not overlap). */
export function applyEdits(src: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.range[0] - a.range[0]);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].range[1] > sorted[i - 1].range[0]) throw new Error("overlapping expression edits");
  let out = src;
  for (const e of sorted) out = out.slice(0, e.range[0]) + e.text + out.slice(e.range[1]);
  return out;
}

/** "...before... → ...after..." around the edits, one line, for reports. */
export function snippet(src: string, edits: Edit[], pad = 24): string {
  if (!edits.length) return "";
  const sorted = [...edits].sort((a, b) => a.range[0] - b.range[0]);
  let from = Math.max(0, sorted[0].range[0] - pad), to = Math.min(src.length, sorted[sorted.length - 1].range[1] + pad);
  // whole words at both ends
  while (from > 0 && /[\w$.]/.test(src[from - 1])) from--;
  while (to < src.length && /[\w$]/.test(src[to])) to++;
  const before = src.slice(from, to);
  const shifted = sorted.map((e) => ({ range: [e.range[0] - from, e.range[1] - from] as Range, text: e.text }));
  const after = applyEdits(before, shifted);
  const one = (s: string) => (from > 0 ? "…" : "") + s.replace(/\s*\n\s*/g, " ⏎ ") + (to < src.length ? "…" : "");
  return `${one(before)} → ${one(after)}`;
}
