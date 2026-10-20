// Project X-ray as the in-chat view's data: the "What renders" tree (render queue items -> comps -> precomps ->
// footage) with each node's problems (missing, fragile links, heavy while hidden, unused), from the same facts
// the text report is made of (xray.ts JSX). The result carries the tree's first levels and the paths to every
// problem; the view loads the rest node by node (ae_view_xray_node) from this run's facts, kept in memory and
// in ~/.surehand/ae/xray/ (the last 10 runs, at most 7 days).
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { appFile } from "../paths.js";
import type { XrayNode, XrayNodeView, XrayProblem, XrayTag, XrayView } from "../views/types.js";
import { FRAGILE_LEGEND, xrayLinks, type XComp, type XData, type XFootage, type XLayer, type XLink } from "./xray-analyze.js";

/** the first levels of the tree that go into the result (the rest is loaded node by node) */
const INITIAL_DEPTH = 3;
const INITIAL_NODES = 400;
/** paths per problem kind in the result; children and problems per node from ae_view_xray_node */
const MAX_PATHS = 100;
const MAX_CHILDREN = 500;
export const MAX_NODE_PROBLEMS = 40;

const q = JSON.stringify;
const r2 = (n: number) => Math.round(n * 100) / 100;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const sentence = (s: string) => cap(s.trim()) + (/[.!?]$/.test(s.trim()) ? "" : ".");
const propPath = (p: string) => p.split("/").join(" › ");

/** What a layer is while hidden, and what that means for its effects (as the text report's hiddenCostNote). */
const HIDDEN: Record<string, string> = {
  disabled: "a disabled layer isn't rendered, so its effects cost time only if an effect or expression uses the layer",
  shy: "a shy layer renders normally; it's only hidden in the timeline",
  guide: "a guide layer renders in this comp's viewer, not in the final output or in parent comps",
};

/** The tree and the problems of one X-ray run. */
export class XrayModel {
  comps = new Map<number, XComp>();
  footage = new Map<number, XFootage>();
  /** comp id -> its children ("c12" / "f33") and how many layers use each */
  edges = new Map<number, Map<string, number>>();
  rqComps: number[];
  /** comps nothing in the render queue reaches (only when the queue has items) */
  unused = new Set<number>();
  links = new Map<number, XLink[]>();
  missingFx = new Map<number, { layer: XLayer; m: string; n: string }[]>();
  missingFonts = new Map<number, { layer: XLayer; font: string }[]>();
  hidden = new Map<number, { layer: XLayer; is: string[]; effects: string[] }[]>();
  private parents = new Map<number, number[]>();

  constructor(public d: XData) {
    for (const c of d.comps) this.comps.set(c.id, c);
    for (const f of d.footage) this.footage.set(f.id, f);
    const add = (p: number, k: string, n: number) => {
      const row = this.edges.get(p) ?? new Map<string, number>();
      row.set(k, (row.get(k) ?? 0) + n);
      this.edges.set(p, row);
    };
    const missingFont = new Set((d.fonts?.missing ?? []).map((f) => f.ps));
    for (const c of d.comps)
      for (const l of c.layers ?? []) {
        if (l.src !== undefined && this.comps.has(l.src)) add(c.id, `c${l.src}`, 1);
        else if (l.src !== undefined && this.footage.get(l.src)?.kind !== "solid" && this.footage.has(l.src)) add(c.id, `f${l.src}`, 1);
        const active = (l.fx ?? []).filter((f) => !f.off);
        for (const f of l.fx ?? []) if (f.x) this.push(this.missingFx, c.id, { layer: l, m: f.m, n: f.n });
        if (l.font && missingFont.has(l.font)) this.push(this.missingFonts, c.id, { layer: l, font: l.font });
        const is = [l.off && !l.matte && "disabled", l.shy && "shy", l.guide && "guide"].filter((x): x is string => !!x);
        if (is.length && active.length) this.push(this.hidden, c.id, { layer: l, is, effects: active.map((f) => f.n) });
      }
    // comps not read (or read in part): AE's usedIn still says what uses them
    for (const c of d.comps)
      for (const p of c.usedIn) {
        const pc = this.comps.get(p);
        if (pc && (pc.scanned === undefined || pc.scanned < pc.nl) && !this.edges.get(p)?.has(`c${c.id}`)) add(p, `c${c.id}`, 0);
      }
    for (const c of d.comps) this.parents.set(c.id, c.usedIn.filter((p) => this.comps.has(p)));
    this.rqComps = [...new Set(d.rq.map((r) => r.comp))].filter((id) => this.comps.has(id));
    if (d.rq.length) {
      const seen = new Set<number>();
      for (const stack = [...this.rqComps]; stack.length; ) {
        const id = stack.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        for (const k of this.edges.get(id)?.keys() ?? []) if (k[0] === "c") stack.push(Number(k.slice(1)));
      }
      for (const c of d.comps) if (!seen.has(c.id)) this.unused.add(c.id);
    }
    for (const l of xrayLinks(d)) this.push(this.links, l.comp.id, l);
  }

  private push<T>(m: Map<number, T[]>, k: number, v: T) {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  }

  /** the roots: the render queue items, then the comps nothing renders; with an empty queue, the top-level comps */
  roots(): string[] {
    if (!this.d.rq.length) return ["g:top"];
    return [...this.d.rq.map((_, i) => `q${i + 1}`), ...(this.unused.size ? ["g:unused"] : [])];
  }

  children(key: string): { key: string; n?: number }[] {
    if (key[0] === "q") {
      const r = this.d.rq[Number(key.slice(1)) - 1];
      return r && this.comps.has(r.comp) ? [{ key: `c${r.comp}` }] : [];
    }
    if (key === "g:unused") return [...this.unused].filter((id) => !this.parents.get(id)!.some((p) => this.unused.has(p))).map((id) => ({ key: `c${id}` }));
    if (key === "g:top") return this.d.comps.filter((c) => !this.parents.get(c.id)!.length).map((c) => ({ key: `c${c.id}` }));
    if (key[0] !== "c") return [];
    // precomps first, then footage
    const row = [...(this.edges.get(Number(key.slice(1))) ?? [])].sort(([a], [b]) => (a[0] === b[0] ? 0 : a[0] === "c" ? -1 : 1));
    return row.map(([k, n]) => (n > 1 ? { key: k, n } : { key: k }));
  }

  tags(key: string): XrayTag[] {
    const id = Number(key.slice(1)), out: XrayTag[] = [];
    if (key[0] === "f") {
      const f = this.footage.get(id);
      if (f?.kind === "file" && f.missing) out.push("missing");
      if (f?.kind === "placeholder") out.push("placeholder");
    } else if (key[0] === "c") {
      if (this.missingFx.has(id) || this.missingFonts.has(id)) out.push("missing");
      if (this.links.has(id)) out.push("fragile");
      if (this.hidden.has(id)) out.push("heavy");
      if (this.unused.has(id)) out.push("unused");
    }
    return out;
  }

  node(key: string): XrayNode {
    const base = { key, tags: this.tags(key), childCount: this.children(key).length };
    if (key[0] === "q") {
      const i = Number(key.slice(1)), r = this.d.rq[i - 1], c = this.comps.get(r.comp);
      return { ...base, kind: "rq", name: `RQ ${i} · ${c?.name ?? `#${r.comp}`}`, meta: r.file ? `→ ${basename(r.file.replace(/\\/g, "/"))}` : r.status.toLowerCase().replace(/_/g, " "), ...(c ? { comp: c.id } : {}) };
    }
    if (key === "g:unused") return { ...base, kind: "group", name: "Not rendered", meta: `${plural(this.unused.size, "comp")} nothing in the render queue uses` };
    if (key === "g:top") return { ...base, kind: "group", name: "Top-level comps", meta: "the render queue is empty: comps no other comp uses" };
    const id = Number(key.slice(1));
    if (key[0] === "c") {
      const c = this.comps.get(id)!;
      const partly = c.scanned === undefined || c.scanned < c.nl;
      return { ...base, kind: "comp", name: c.name, meta: `${r2(c.dur)} s · ${plural(c.nl, "layer")}${partly && c.nl ? " · partly read" : ""}`, comp: id };
    }
    const f = this.footage.get(id)!;
    const meta = f.kind === "placeholder" ? "placeholder" : f.missing ? undefined : f.still ? `still${f.w ? ` · ${f.w}×${f.h}` : ""}` : f.w ? `${f.w}×${f.h}` : f.audio ? "audio" : undefined;
    return { ...base, kind: "footage", name: f.name, ...(meta ? { meta } : {}), item: id };
  }

  /** Every problem of a node, grouped (links by kind and name, effects by plug-in), most serious first. */
  problems(key: string): XrayProblem[] {
    const id = Number(key.slice(1)), out: XrayProblem[] = [];
    if (key[0] === "f") {
      const f = this.footage.get(id);
      if (!f) return out;
      const path = f.missingPath ?? f.file ?? undefined;
      const used = f.usedIn.map((u) => this.comps.get(u)?.name).filter(Boolean).join(", ");
      if (f.kind === "placeholder")
        out.push({ tag: "placeholder", title: "A placeholder instead of footage", ...(used ? { where: `used in ${used}` } : {}), text: "Placeholders render as color bars.", reveal: { item: id }, ask: { label: "Ask the AI to replace it", text: `Replace the placeholder "${f.name}" with the real footage.` } });
      else if (f.missing)
        out.push({
          tag: "missing",
          title: "File not found",
          ...(used ? { where: `used in ${used}` } : {}),
          text: path ? `It was at ${path}. Until it's relinked, it renders as color bars.` : "Until it's relinked, it renders as color bars.",
          reveal: { item: id },
          ask: { label: "Ask the AI to relink it", text: `Relink the missing footage "${f.name}"${path ? ` (it was at ${path})` : ""}.` },
        });
      return out;
    }
    if (key[0] !== "c") return out;
    const c = this.comps.get(id)!;
    const where = (l: XLayer, prop?: string) => `${c.name} › ${l.n}${prop ? ` › ${propPath(prop)}` : ""}`;
    const at = (l: XLayer) => ({ comp: id, layer: l.i });

    const fx = new Map<string, { layer: XLayer; m: string; n: string }[]>();
    for (const x of this.missingFx.get(id) ?? []) fx.set(x.m, [...(fx.get(x.m) ?? []), x]);
    for (const [m, list] of fx) {
      const x = list[0], more = list.length - 1;
      out.push({
        tag: "missing",
        title: "Effect not installed",
        where: where(x.layer),
        text: `${x.n} (${m}) isn't installed on this machine, so it renders nothing.${more ? ` ${plural(more, "more layer")} in this comp use${more === 1 ? "s" : ""} it.` : ""}`,
        reveal: at(x.layer),
        ask: { label: "Ask the AI to replace it", text: `The effect "${x.n}" (${m}) isn't installed; it's on ${where(x.layer)}${more ? ` and ${plural(more, "more layer")} in ${c.name}` : ""}. What can replace it?` },
      });
    }
    const fonts = new Map<string, XLayer[]>();
    for (const x of this.missingFonts.get(id) ?? []) fonts.set(x.font, [...(fonts.get(x.font) ?? []), x.layer]);
    for (const [font, ls] of fonts)
      out.push({
        tag: "missing",
        title: "Font missing",
        where: where(ls[0]),
        text: `${font} is missing or substituted, so this text renders in another font.${ls.length > 1 ? ` ${plural(ls.length - 1, "more text layer")} in this comp use${ls.length === 2 ? "s" : ""} it.` : ""}`,
        reveal: at(ls[0]),
        ask: { label: "Ask the AI to fix it", text: `The font ${font} is missing in ${c.name} (${ls.map((l) => l.n).slice(0, 5).join(", ")}). Which installed font matches it best?` },
      });

    // expression links: broken and erroring first, then fragile codes, then names; one entry per kind and name
    const rank = { error: 0, broken: 1, fragile: 2, name: 3 } as const;
    const groups = new Map<string, XLink[]>();
    for (const l of [...(this.links.get(id) ?? [])].sort((a, b) => rank[a.kind] - rank[b.kind])) {
      const k = `${l.kind}\u0000${l.why ?? ""}\u0000${l.kind === "name" ? (l.target ?? "") : l.kind === "fragile" ? "" : `${l.layer.id}${l.prop}${l.ref}`}`;
      groups.set(k, [...(groups.get(k) ?? []), l]);
    }
    for (const list of groups.values()) out.push(linkProblem(list[0], list.length - 1, where(list[0].layer, list[0].prop), at(list[0].layer)));

    for (const h of this.hidden.get(id) ?? [])
      out.push({
        tag: "heavy",
        title: "Effects on a hidden layer",
        where: where(h.layer),
        text: `${sentence(h.is.map((x) => HIDDEN[x]).join("; "))} Its effects: ${h.effects.slice(0, 5).join(", ")}${h.effects.length > 5 ? ", …" : ""}.`,
        reveal: at(h.layer),
        ask: { label: "Ask the AI to clean it up", text: `${where(h.layer)} is ${h.is.join(" and ")} but has effects (${h.effects.slice(0, 5).join(", ")}). Check whether they cost render time, and remove them if they aren't needed.` },
      });
    if (this.unused.has(id))
      out.push({ tag: "unused", title: "Nothing renders this comp", text: "It isn't in the render queue, and no comp that renders uses it.", reveal: { comp: id } });
    return out;
  }

  /** One path (root first) to each node with this problem, at most `max`. */
  pathsTo(tag: XrayTag, max = MAX_PATHS): string[][] {
    const out: string[][] = [], seen = new Set<string>();
    const queue: string[][] = this.roots().map((r) => [r]);
    for (let i = 0; i < queue.length && out.length < max; i++) {
      const path = queue[i], key = path[path.length - 1];
      if (seen.has(key)) continue;
      seen.add(key);
      if (this.tags(key).includes(tag)) out.push(path);
      for (const ch of this.children(key)) if (!seen.has(ch.key)) queue.push([...path, ch.key]);
    }
    return out;
  }

  counts(): Record<XrayTag, number> {
    const missingFootage = this.d.footage.filter((f) => f.kind === "file" && f.missing).length;
    const placeholders = this.d.footage.filter((f) => f.kind === "placeholder").length;
    const fx = new Set([...this.missingFx.values()].flat().map((x) => x.m)), fonts = new Set([...this.missingFonts.values()].flat().map((x) => x.font));
    return {
      missing: missingFootage + fx.size + fonts.size,
      placeholder: placeholders,
      fragile: [...this.links.values()].reduce((n, l) => n + l.length, 0),
      heavy: [...this.hidden.values()].reduce((n, l) => n + l.length, 0),
      unused: this.unused.size,
    };
  }
}

/** The quoted name in a reference (`thisComp.layer("Logo")` -> `"Logo"`), to mark in the expression. */
function quoted(ref?: string, name?: string): string | undefined {
  if (!ref) return undefined;
  const lits = ref.match(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g) ?? [];
  return lits.find((s) => name !== undefined && s.slice(1, -1) === name) ?? lits[0];
}

function linkProblem(l: XLink, more: number, where: string, reveal: XrayProblem["reveal"]): XrayProblem {
  const code = l.src.length > 1200 ? l.src.slice(0, 1200) + "…" : l.src;
  const also = more ? ` ${plural(more, "more expression")} in this comp ${more === 1 ? "does" : "do"} the same.` : "";
  if (l.kind === "error")
    return { tag: "fragile", title: "An expression error", where, code, text: sentence(l.target ?? "error") + also, reveal, ask: { label: "Ask the AI to fix it", text: `Fix the expression error on ${where}: ${(l.target ?? "").split("\n")[0]}` } };
  if (l.kind === "broken")
    return { tag: "fragile", title: "A broken expression link", where, code, mark: l.ref, text: `${sentence(l.target ?? "broken")} It fails with an expression error at render.${also}`, reveal, ask: { label: "Ask the AI to fix it", text: `Fix the broken link ${l.ref} in the expression on ${where}: ${l.target}.` } };
  if (l.kind === "fragile")
    return { tag: "fragile", title: "An expression link that can break", where, code, mark: l.ref, text: sentence(FRAGILE_LEGEND[l.why ?? ""] ?? l.why ?? "fragile") + also, reveal, ask: { label: "Ask the AI to make it robust", text: `Make the expression on ${where} robust: ${l.ref} uses ${FRAGILE_LEGEND[l.why ?? ""] ?? l.why}.` } };
  const what = (l.target ?? "").split(" ")[0] || "layer";
  const article = what === "effect" ? "an" : "a";
  return {
    tag: "fragile",
    title: `An expression finds ${article} ${what} by its name`,
    where,
    code,
    mark: quoted(l.ref, l.name),
    text: `Renaming ${l.name ?? "it"} breaks this with an expression error at render.${also}`,
    reveal,
    ask: { label: "Ask the AI to make it rename-safe", text: `Make the expression on ${where} rename-safe: ${l.ref} finds the ${what} ${q(l.name ?? "")} by its name.` },
  };
}

// ---------- the result's data, and the runs kept for ae_view_xray_node ----------

const runs = new Map<string, XrayModel>();
const runsDir = () => appFile("xray");
const KEEP_RUNS = 10, MAX_AGE_MS = 7 * 24 * 3600 * 1000;

function keep(run: string, d: XData) {
  runs.set(run, new XrayModel(d));
  while (runs.size > 3) runs.delete(runs.keys().next().value!);
  try {
    mkdirSync(runsDir(), { recursive: true });
    writeFileSync(join(runsDir(), `${run}.json.gz`), gzipSync(JSON.stringify(d)));
    const files = readdirSync(runsDir()).filter((f) => f.endsWith(".json.gz")).sort();
    const now = Date.now();
    for (const [i, f] of files.entries())
      if (i < files.length - KEEP_RUNS || now - statSync(join(runsDir(), f)).mtimeMs > MAX_AGE_MS) rmSync(join(runsDir(), f), { force: true });
  } catch {
    // the view then loads nodes only while this server runs
  }
}

/** A kept run's model, or why it isn't there. */
export function xrayRun(run: string): XrayModel | string {
  if (!/^[\w-]+$/.test(run)) return `"${run}" is not an X-ray run.`;
  const m = runs.get(run);
  if (m) return m;
  try {
    const d = JSON.parse(gunzipSync(readFileSync(join(runsDir(), `${run}.json.gz`))).toString("utf8")) as XData;
    const model = new XrayModel(d);
    runs.set(run, model);
    return model;
  } catch {
    return "This X-ray isn't kept any more (the last 10 runs are). Run the X-ray again.";
  }
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\.(\d{3})Z$/, "$1");

/** ae_project_xray's view data from the JSX result: the summary, the tree's first levels, the paths to every problem. */
export function xrayView(raw: unknown): XrayView {
  const d = (typeof raw === "string" ? JSON.parse(raw) : raw) as XData;
  const run = `${stamp()}-${randomBytes(2).toString("hex")}`;
  keep(run, d);
  const m = runs.get(run)!;
  const nodes: Record<string, XrayNode> = {};
  // breadth first: every node to INITIAL_DEPTH, with its children listed
  const queue: [string, number][] = m.roots().map((r) => [r, 0]);
  for (let i = 0; i < queue.length && Object.keys(nodes).length < INITIAL_NODES; i++) {
    const [key, depth] = queue[i];
    if (nodes[key]) continue;
    const n = m.node(key);
    if (depth < INITIAL_DEPTH) {
      n.children = m.children(key).slice(0, MAX_CHILDREN);
      for (const ch of n.children) queue.push([ch.key, depth + 1]);
    }
    nodes[key] = n;
  }
  const counts = m.counts();
  const tags: XrayTag[] = ["missing", "placeholder", "fragile", "heavy", "unused"];
  const paths: XrayView["paths"] = {};
  for (const t of tags) {
    if (!counts[t]) continue;
    paths[t] = m.pathsTo(t);
    // the nodes on them, so a chip can show them at once
    for (const p of paths[t]!) for (const k of p) nodes[k] ??= m.node(k);
  }
  const p = d.project ?? {};
  const layers = d.comps.reduce((n, c) => n + c.nl, 0), files = d.footage.filter((f) => f.kind !== "solid").length;
  const subtitle = [plural(d.comps.length, "comp"), plural(layers, "layer"), plural(files, "footage item"), d.rq.length ? `${d.rq.length} in the render queue` : "render queue empty"];
  return {
    view: "xray",
    run,
    title: `X-ray · ${p.name ?? "project"}`,
    subtitle: subtitle.join(" · ") + (d.partial ? " · partly read" : ""),
    chips: tags.filter((t) => counts[t]).map((t) => ({ tag: t, count: counts[t] })),
    roots: m.roots(),
    nodes,
    paths,
    ...(d.partial ? { partial: d.partial.reason } : {}),
  };
}

/** ae_view_xray_node: a node of a kept run with its children and problems. */
export function xrayNodeView(run: string, key: string): XrayNodeView | string {
  const m = xrayRun(run);
  if (typeof m === "string") return m;
  const n = Number(key.slice(1));
  if (!/^(q\d+|c\d+|f\d+|g:unused|g:top)$/.test(key) || (key[0] === "c" && !m.comps.has(n)) || (key[0] === "f" && !m.footage.has(n)) || (key[0] === "q" && !m.d.rq[n - 1]))
    return `No node "${key}" in this X-ray.`;
  const node = m.node(key), children = m.children(key);
  node.children = children.slice(0, MAX_CHILDREN);
  const problems = m.problems(key);
  return { view: "xrayNode", node, children: node.children.map((c) => m.node(c.key)), problems: problems.slice(0, MAX_NODE_PROBLEMS), moreProblems: Math.max(0, problems.length - MAX_NODE_PROBLEMS) };
}

/** for tests: the runs kept in memory */
export const _internal = { runs };
