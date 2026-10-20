// Project X-ray view (browser code): the problems counted in chips (a chip filters the tree), the "What
// renders" tree from the render queue down to the footage with its tags, and the selected node's problems:
// what's wrong, the expression with the fragile part marked, Show in AE and Ask the AI to …. Nodes beyond
// the result's first levels, and every node's problems, come from ae_view_xray_node (this run's kept analysis).
import { el, errorText, startView, tile, viewData, type ToolResult, type View } from "./shared.js";
import type { XrayNode, XrayNodeView, XrayProblem, XrayTag, XrayView } from "./types.js";

const CHIP: Record<XrayTag, { one: string; many: string; cls: string }> = {
  missing: { one: "MISSING", many: "MISSING", cls: "bad" },
  fragile: { one: "FRAGILE LINK", many: "FRAGILE LINKS", cls: "bad" },
  heavy: { one: "HEAVY HIDDEN", many: "HEAVY HIDDEN", cls: "warn" },
  unused: { one: "UNUSED COMP", many: "UNUSED COMPS", cls: "" },
};
/** the tags drawn in the tree (unused comps are all under "Not rendered") */
const TAG: Partial<Record<XrayTag, { text: string; cls: string }>> = { missing: { text: "MISSING", cls: "bad" }, fragile: { text: "FRAGILE", cls: "bad" }, heavy: { text: "HEAVY", cls: "warn" } };
const KIND: Record<XrayTag, string> = { missing: "missing", fragile: "fragile link", heavy: "heavy while hidden", unused: "unused" };
/** problems shown before "Show all" */
const COLLAPSED = 3;

const state: {
  data?: XrayView;
  nodes: Map<string, XrayNode>;
  /** row ids (the node keys from the root, joined by "/") that are open */
  open: Set<string>;
  selected?: string;
  filter?: XrayTag;
  problems: Map<string, XrayNodeView | { error: string }>;
  /** nodes being loaded, and since when */
  loading: Map<string, number>;
  all?: boolean;
  message?: string;
} = { nodes: new Map(), open: new Set(), problems: new Map(), loading: new Map() };

let view: View | undefined;
const root = document.getElementById("app")!;
const last = (row: string) => row.slice(row.lastIndexOf("/") + 1);
const keyOf = (row: string) => last(row);

function chips(d: XrayView): HTMLElement {
  if (!d.chips.length) return el("div", { class: "chips" }, el("span", { class: "chip" }, "NO PROBLEMS FOUND"));
  return el(
    "div",
    { class: "chips", role: "group", "aria-label": "Filter the tree" },
    d.chips.map((c) =>
      el(
        "button",
        { class: `chip ${CHIP[c.tag].cls}`, "aria-pressed": state.filter === c.tag ? "true" : "false", "data-k": `chip-${c.tag}`, onclick: () => setFilter(state.filter === c.tag ? undefined : c.tag) },
        `${c.count} ${c.count === 1 ? CHIP[c.tag].one : CHIP[c.tag].many}`,
      ),
    ),
  );
}

/** the rows to draw: open nodes' children, or with a filter, the paths to the nodes with that problem */
function rows(d: XrayView): { row: string; depth: number }[] {
  const out: { row: string; depth: number }[] = [];
  // with a filter: the rows on the paths, each under its parent row
  const kids = new Map<string, string[]>();
  if (state.filter)
    for (const p of d.paths[state.filter] ?? [])
      for (let i = 1; i < p.length; i++) {
        const parent = p.slice(0, i).join("/"), row = p.slice(0, i + 1).join("/"), list = kids.get(parent) ?? [];
        if (!list.includes(row)) kids.set(parent, [...list, row]);
      }
  const walk = (row: string, depth: number) => {
    out.push({ row, depth });
    if (state.filter) return void (kids.get(row) ?? []).forEach((r) => walk(r, depth + 1));
    const n = state.nodes.get(keyOf(row));
    if (n?.children && state.open.has(row)) for (const ch of n.children) walk(`${row}/${ch.key}`, depth + 1);
  };
  const roots = state.filter ? [...new Set((d.paths[state.filter] ?? []).map((p) => p[0]))] : d.roots;
  for (const r of roots) walk(r, 0);
  return out;
}

function nodeRow(row: string, depth: number, parentN?: number): HTMLElement {
  const n = state.nodes.get(keyOf(row))!;
  const canOpen = n.childCount > 0, open = state.filter ? !!n.children : state.open.has(row);
  const meta = [parentN && parentN > 1 ? `×${parentN}` : "", n.meta ?? ""].filter(Boolean).join(" · ");
  return el(
    "div",
    {
      class: `node${state.selected === row ? " sel" : ""}`,
      role: "treeitem",
      "aria-level": depth + 1,
      "aria-selected": state.selected === row ? "true" : "false",
      ...(canOpen && !state.filter ? { "aria-expanded": open ? "true" : "false" } : {}),
      tabindex: state.selected === row || (!state.selected && depth === 0) ? 0 : -1,
      "data-k": `n:${row}`,
      onclick: (e: Event) => ((e.target as HTMLElement).classList.contains("car") ? toggle(row) : choose(row)),
      onkeydown: (e: KeyboardEvent) => keys(e, row),
    },
    el("span", { class: "ind", style: { width: `${depth * 16}px` } }),
    el("span", { class: "car", "aria-hidden": "true" }, canOpen && !state.filter ? (open ? "▾" : "▸") : ""),
    el("span", { class: "nm" }, n.name),
    meta ? el("span", { class: "meta" }, meta) : null,
    n.tags.map((t) => (TAG[t] ? el("span", { class: `tag ${TAG[t]!.cls}` }, TAG[t]!.text) : null)),
  );
}

function tree(d: XrayView): HTMLElement {
  const list = rows(d);
  const parentN = (row: string) => {
    const p = row.slice(0, row.lastIndexOf("/"));
    return p ? state.nodes.get(keyOf(p))?.children?.find((c) => c.key === keyOf(row))?.n : undefined;
  };
  return el(
    "div",
    { class: "tree", role: "tree", "aria-label": "What renders" },
    el("div", { class: "eyebrow" }, state.filter ? `What renders · ${KIND[state.filter]}` : "What renders"),
    list.map(({ row, depth }) => nodeRow(row, depth, parentN(row))),
  );
}

/** the expression with the part to mark underlined (its first place after nothing else marks it) */
function code(p: XrayProblem): HTMLElement {
  const c = p.code ?? "", at = p.mark ? c.indexOf(p.mark) : -1;
  return el("div", { class: "code" }, at < 0 ? c : [c.slice(0, at), el("mark", {}, p.mark!), c.slice(at + p.mark!.length)]);
}

function problemBlock(n: XrayNode, p: XrayProblem, i: number): HTMLElement {
  return el(
    "div",
    { class: "pb" },
    el("div", { class: "eyebrow" }, `${n.name} · ${KIND[p.tag]}`),
    el("h4", {}, p.title),
    p.where ? el("div", { class: "mono mut where" }, p.where) : null,
    p.code ? code(p) : null,
    el("p", {}, p.text),
    el(
      "div",
      { class: "btns" },
      p.reveal ? el("button", { class: "btn sm", "data-k": `show${i}`, onclick: () => reveal(p.reveal!) }, "Show in AE") : null,
      p.ask ? el("button", { class: "btn sm", "data-k": `ask${i}`, onclick: () => ask(p.ask!.text) }, p.ask.label) : null,
    ),
  );
}

function detail(d: XrayView): HTMLElement {
  const box = el("div", { class: "detail" });
  if (!state.selected) {
    box.append(el("div", { class: "mut" }, d.chips.length ? "Choose a comp or footage item to see what's wrong with it." : "Nothing missing, fragile, heavy while hidden or unused was found in what was read."));
    return box;
  }
  const key = keyOf(state.selected), n = state.nodes.get(key)!, v = state.problems.get(key);
  if (!v) {
    // however it was selected (a click, a chip, the start), the selected node's detail is loaded
    box.append(el("div", { class: "eyebrow" }, n.name), el("div", { class: "mut", style: { marginTop: "6px" } }, "Loading…"));
    queueMicrotask(() => void load(key));
  }
  else if ("error" in v) box.append(el("div", { class: "eyebrow" }, n.name), el("div", { class: "err" }, v.error));
  else if (!v.problems.length) {
    const target = n.kind === "footage" ? { item: n.item } : n.comp !== undefined ? { comp: n.comp } : undefined;
    box.append(el("div", { class: "eyebrow" }, n.name), el("p", { class: "mut" }, n.kind === "group" ? n.meta ?? "" : "Nothing missing, fragile or heavy while hidden here."));
    if (target) box.append(el("div", { class: "btns" }, el("button", { class: "btn sm", "data-k": "show-node", onclick: () => reveal(target) }, "Show in AE")));
  } else {
    const list = state.all ? v.problems : v.problems.slice(0, COLLAPSED);
    box.append(...list.map((p, i) => problemBlock(n, p, i)));
    const total = v.problems.length + v.moreProblems;
    if (v.problems.length > COLLAPSED)
      box.append(el("div", { class: "btns", style: { marginTop: "12px" } }, el("button", { class: "btn sm", "data-k": "all", onclick: () => ((state.all = !state.all), render()) }, state.all ? "Show less" : `Show all ${total}`)));
    if (state.all && v.moreProblems) box.append(el("div", { class: "mut", style: { marginTop: "8px" } }, `${v.moreProblems} more are in the text report.`));
  }
  if (state.message) box.append(el("div", { class: "err", style: { marginTop: "8px" } }, state.message));
  return box;
}

function legend(): HTMLElement {
  return el(
    "div",
    { class: "legend" },
    el("span", {}, el("span", { class: "tag bad" }, "MISSING"), " file not found"),
    el("span", {}, "FRAGILE breaks on rename"),
    el("span", {}, "HEAVY costs render time while hidden"),
  );
}

function render() {
  const d = state.data;
  if (!d) return;
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.k;
  const v = el("div", { class: "v" }, el("div", { class: "vh" }, tile(), el("div", { class: "grow" }, el("div", { class: "t" }, d.title), el("div", { class: "s" }, d.subtitle))), chips(d));
  if (d.partial) v.append(el("div", { class: "mut note" }, `Partly read: ${d.partial}. The lists are incomplete.`));
  v.append(el("div", { class: "split" }, tree(d), detail(d)), legend());
  root.replaceChildren(v);
  if (focused) (root.querySelector(`[data-k="${focused.replace(/["\\]/g, "\\$&")}"]`) as HTMLElement | null)?.focus();
}

/** Load a node's children and problems (once; a request that got no answer in 15 s can be made again). */
async function load(key: string) {
  const d = state.data, since = state.loading.get(key);
  if (!view || !d || state.problems.has(key) || (since !== undefined && Date.now() - since < 15_000)) return;
  const started = Date.now();
  state.loading.set(key, started);
  // no answer in 15 s: ask again (drawing the selected node asks for it)
  setTimeout(() => {
    if (state.loading.get(key) !== started) return;
    state.loading.delete(key);
    if (state.selected && keyOf(state.selected) === key) render();
  }, 15_000);
  const r = await view.call("ae_view_xray_node", { run: d.run, node: key });
  // another X-ray came in meanwhile: this answer is for the old one
  if (state.data !== d) return;
  state.loading.delete(key);
  const v = r.ok ? viewData<XrayNodeView>(r.result) : undefined;
  if (!v) state.problems.set(key, { error: r.ok ? "This node couldn't be loaded." : r.message });
  else {
    state.nodes.set(key, v.node);
    for (const c of v.children) if (!state.nodes.has(c.key)) state.nodes.set(c.key, c);
    state.problems.set(key, v);
  }
  render();
}

function toggle(row: string) {
  const n = state.nodes.get(keyOf(row));
  if (!n?.childCount || state.filter) return;
  if (state.open.has(row)) state.open.delete(row);
  else {
    state.open.add(row);
    if (!n.children) void load(keyOf(row));
  }
  render();
}

function select(row: string) {
  state.selected = row;
  state.all = false;
  state.message = undefined;
  render();
  void load(keyOf(row));
}

/** A click on a row's name, or Enter: select it; a node with children and nothing wrong (a group, a render queue item) also opens or closes, as in any tree. */
function choose(row: string) {
  const n = state.nodes.get(keyOf(row));
  const already = state.selected === row;
  if (n && n.childCount && !n.tags.length && !state.filter) {
    if (!already) select(row);
    toggle(row);
  } else select(row);
}

function setFilter(tag?: XrayTag) {
  state.filter = tag;
  // the first node with that problem is selected
  const first = tag ? state.data?.paths[tag]?.[0] : undefined;
  if (first) select(first.join("/"));
  else render();
}

function keys(e: KeyboardEvent, row: string) {
  const all = [...root.querySelectorAll<HTMLElement>(".node")], i = all.findIndex((x) => x.dataset.k === `n:${row}`);
  const move = (j: number) => all[Math.max(0, Math.min(all.length - 1, j))]?.focus();
  if (e.key === "Enter" || e.key === " ") choose(row);
  else if (e.key === "ArrowDown") move(i + 1);
  else if (e.key === "ArrowUp") move(i - 1);
  else if (e.key === "ArrowRight" && !state.open.has(row)) toggle(row);
  else if (e.key === "ArrowLeft" && state.open.has(row)) toggle(row);
  else return;
  e.preventDefault();
}

async function reveal(target: { comp?: number; layer?: number; item?: number }) {
  if (!view) return;
  state.message = undefined;
  const r = await view.call("ae_view_reveal", target.item !== undefined ? { item: target.item } : { comp: target.comp, ...(target.layer ? { layer: target.layer } : {}) });
  if (!r.ok) state.message = r.message;
  render();
}

async function ask(text: string) {
  state.message = undefined;
  if (!view || !(await view.ask(text))) state.message = "The request couldn't be written into the chat.";
  render();
}

function show(d: XrayView) {
  state.data = d;
  state.nodes = new Map(Object.entries(d.nodes));
  state.problems.clear();
  state.filter = undefined;
  // the first root and its first child open (as the mockup); the first problem (fragile links first, as they need
  // explaining) selected, with its path open
  state.open = new Set();
  const r0 = d.roots[0], c0 = state.nodes.get(r0)?.children?.[0];
  if (r0) state.open.add(r0);
  if (c0) state.open.add(`${r0}/${c0.key}`);
  const first = (["fragile", "missing", "heavy"] as XrayTag[]).map((t) => d.paths[t]?.[0]).find(Boolean);
  if (first) {
    first.forEach((_, i) => state.open.add(first.slice(0, i + 1).join("/")));
    state.selected = first.join("/");
  } else state.selected = undefined;
  render();
  if (state.selected) void load(keyOf(state.selected));
}

function onResult(r: ToolResult) {
  const d = viewData<XrayView>(r);
  if (d) return show(d);
  const text = r.content?.find((c) => c.type === "text")?.text;
  root.replaceChildren(
    el("div", { class: "v" }, el("div", { class: "vh" }, tile(), el("div", { class: "grow" }, el("div", { class: "t" }, "X-ray"))), el("div", { class: "err note" }, errorText(r._meta?.["surehand/error"] as string | undefined, text))),
  );
}

startView("X-ray", { onResult })
  .then((v) => {
    view = v;
    // the result can arrive before the connection is done
    if (state.selected) void load(keyOf(state.selected));
  })
  .catch(() => undefined);
