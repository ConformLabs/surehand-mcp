// "What changed, and the proof" view (browser code), for ae_prove_identical and ae_project_history diff: the
// proof's verdict, before / after / difference ×50 at a compared frame (fetched on demand: ae_view_proof_frame),
// a slider through the compared frames, then what changed in the project. Show in AE only navigates
// (ae_view_reveal); there is no Undo here (undo stays in After Effects, or goes through the chat).
import { el, errorText, startView, tile, viewData, type ToolResult, type View } from "./shared.js";
import type { ChangesView, ProofFrame, ViewChange } from "./types.js";

/** rows listed before "Show all" */
const COLLAPSED = 6;

interface Frames {
  imgs?: string[];
  error?: string;
}

const state: {
  data?: ChangesView;
  /** the compared frame shown (index into proof.frames) */
  at: number;
  frames: Map<number, Frames>;
  /** frame requests: only the latest one is drawn */
  seq: number;
  all?: boolean;
  rowError: Map<number, string>;
} = { at: 0, frames: new Map(), seq: 0, rowError: new Map() };

let view: View | undefined;
const root = document.getElementById("app")!;
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

function header(d: ChangesView): HTMLElement {
  return el("div", { class: "vh" }, tile(), el("div", { class: "grow" }, el("div", { class: "t" }, d.title), el("div", { class: "s" }, d.subtitle)));
}

function verdictBar(p: NonNullable<ChangesView["proof"]>): HTMLElement {
  const cls = p.verdict === "IDENTICAL" ? "ok" : p.verdict === "DIFFERS" ? "bad" : "nr";
  const compared = p.frames.filter((f) => !f.missing).length, differ = p.frames.filter((f) => f.differs).length;
  const detail =
    p.verdict === "NOT PROVEN"
      ? p.verdictLine.replace(/^NOT PROVEN:\s*/, "")
      : [p.verdict === "DIFFERS" ? `${differ} of ${compared} frames differ` : "", `max difference ${p.maxDiff} / 255`, `tolerance ${p.tolerance}`].filter(Boolean).join(" · ");
  return el("div", { class: "verdict" }, el("span", { class: `g ${cls}` }), el("span", { class: `big ${cls === "nr" ? "mut" : cls}` }, p.verdict), el("span", { class: "mono mut" }, detail));
}

function frameLabel(p: NonNullable<ChangesView["proof"]>, f: ProofFrame): string {
  const comps = new Set(p.frames.map((x) => x.compId)).size;
  return comps > 1 ? `${f.comp} ${f.tc}` : f.tc;
}

function compare(p: NonNullable<ChangesView["proof"]>): HTMLElement[] {
  const f = p.frames[state.at], fr = state.frames.get(state.at);
  // the stills keep their own aspect; until they're here, a 16:9 box
  const fig = (i: number, caption: string, heat = false) =>
    el(
      "figure",
      {},
      el("div", { class: `still${heat ? " heat" : ""}`, style: fr?.imgs?.[i] ? {} : { aspectRatio: "16 / 9" } }, fr?.imgs?.[i] ? el("img", { src: fr.imgs[i], alt: caption }) : null),
      el("figcaption", {}, caption),
    );
  const out: HTMLElement[] = [el("div", { class: "cmp" }, fig(0, `Before · ${frameLabel(p, f)}`), fig(1, "After"), fig(2, "Difference ×50", true))];
  if (f.missing) out.push(el("div", { class: "mut note" }, "This frame wasn't compared."));
  else if (fr?.error) out.push(el("div", { class: "err note" }, fr.error));
  if (p.frames.length > 1) {
    const last = p.frames.length - 1, pct = (i: number) => `${(i / last) * 100}%`;
    const input = el("input", {
      type: "range",
      min: 0,
      max: last,
      step: 1,
      value: state.at,
      "aria-label": "Compared frame",
      "aria-valuetext": frameLabel(p, f),
      "data-k": "slider",
      style: { background: `linear-gradient(to right, var(--ink) ${pct(state.at)}, var(--rule) ${pct(state.at)})` },
      oninput: (e: Event) => go(Number((e.target as HTMLInputElement).value)),
    });
    const marks = p.frames.map((x, i) => (x.differs ? el("span", { class: "d", style: { left: pct(i) } }) : null));
    out.push(el("div", { class: "slider" }, el("span", {}, frameLabel(p, p.frames[0])), el("span", { class: "bar" }, marks, input), el("span", {}, frameLabel(p, p.frames[last]))));
  }
  return out;
}

/** "Changes · 1 comp · 6 layers · 9 properties" */
function changesHead(list: ViewChange[], total: number): string {
  const comps = new Set(list.filter((c) => c.comp).map((c) => c.comp)).size;
  const layers = new Set(list.filter((c) => c.layer).map((c) => `${c.comp}\u0000${c.layer}`)).size;
  const props = list.filter((c) => c.path).length;
  const parts = [comps && plural(comps, "comp"), layers && plural(layers, "layer"), props && plural(props, "property", "properties")].filter(Boolean);
  return `Changes · ${parts.length ? parts.join(" · ") : plural(total, "change")}`;
}

function changeRow(c: ViewChange, i: number): HTMLElement {
  const what = c.what.charAt(0).toUpperCase() + c.what.slice(1);
  const main = c.from !== undefined && c.to !== undefined ? el("div", { class: "val" }, `${what} `, el("s", {}, c.from), ` → ${c.to}`) : el("div", { class: "txt" }, what);
  const where = [c.comp, c.layer, c.path].filter(Boolean).join(" › ");
  const err = state.rowError.get(i);
  const show = c.comp
    ? el("button", { class: "btn sm", "data-k": `show${i}`, onclick: () => reveal(i) }, "Show in AE")
    : el("span");
  return el("div", { class: "ch" }, el("span", { class: "g warn" }), el("div", {}, main, where ? el("div", { class: "path" }, where) : null, err ? el("div", { class: "err" }, err) : null), show);
}

function render() {
  const d = state.data;
  if (!d) return;
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.k;
  const v = el("div", { class: "v" }, header(d));
  if (d.proof) v.append(verdictBar(d.proof), ...compare(d.proof));
  const total = d.changes.length;
  if (total || d.source === "history") {
    const rows = state.all ? d.changes : d.changes.slice(0, COLLAPSED);
    v.append(
      el(
        "div",
        { class: "grp" },
        el("div", { class: "gh" }, el("span", { class: "eyebrow" }, total ? changesHead(d.changes, total) : "Changes")),
        total ? rows.map((c, i) => changeRow(c, i)) : el("div", { class: "mut note" }, "No differences."),
      ),
    );
  }
  const more = d.moreChanges ? `${d.moreChanges} more in the text` : "";
  const sum = [d.footnote, more].filter(Boolean).join(" · ");
  if (sum || total > COLLAPSED)
    v.append(
      el(
        "div",
        { class: "foot" },
        el("span", { class: "sum grow" }, sum),
        total > COLLAPSED ? el("button", { class: "btn sm", "data-k": "all", "aria-expanded": state.all ? "true" : "false", onclick: () => ((state.all = !state.all), render()) }, state.all ? "Show less" : `Show all ${total}`) : null,
      ),
    );
  root.replaceChildren(v);
  if (focused) (root.querySelector(`[data-k="${focused}"]`) as HTMLElement | null)?.focus();
}

/** Show a compared frame: drawn at once, its stills fetched (once; again after a failure). */
function go(i: number) {
  state.at = i;
  render();
  void loadFrames(i);
}

async function loadFrames(i: number) {
  const d = state.data, p = d?.proof, f = p?.frames[i];
  const had = state.frames.get(i);
  if (!view || !p || !f || f.missing || (had && !had.error)) return;
  const seq = ++state.seq;
  state.frames.set(i, {});
  const r = await view.call("ae_view_proof_frame", { id: p.id, compared: p.compared, comp: f.compId, index: f.index });
  if (state.data !== d) return;
  if (!r.ok) state.frames.set(i, { error: r.message });
  else state.frames.set(i, { imgs: (r.result.content ?? []).filter((c) => c.type === "image" && c.data).map((c) => `data:${c.mimeType ?? "image/jpeg"};base64,${c.data}`) });
  // only the frame on screen is drawn again (a later move of the slider wins)
  if (seq === state.seq || state.at === i) render();
}

async function reveal(i: number) {
  const c = state.data!.changes[i];
  if (!view || !c.comp) return;
  state.rowError.delete(i);
  // a removed layer isn't there any more: its comp opens
  const layer = c.layer && !(c.op === "-" && !c.path) ? { layer: c.layerIndex ?? c.layer } : {};
  const r = await view.call("ae_view_reveal", { comp: c.comp, ...layer });
  if (!r.ok) state.rowError.set(i, r.message);
  render();
}

function show(d: ChangesView) {
  state.data = d;
  state.frames.clear();
  state.rowError.clear();
  // a proof that differs opens at the first frame that differs
  const first = d.proof ? d.proof.frames.findIndex((f) => f.differs) : -1;
  state.at = first >= 0 ? first : 0;
  render();
  if (d.proof?.frames.length) void loadFrames(state.at);
}

function onResult(r: ToolResult) {
  const d = viewData<ChangesView>(r);
  if (d) return show(d);
  // capture, snapshot and list have no view of their own, and an error has only its text: say it in one line
  const text = r.content?.find((c) => c.type === "text")?.text;
  const line = r.isError ? el("div", { class: "err note" }, errorText(r._meta?.["surehand/error"] as string | undefined, text)) : el("div", { class: "mut note" }, (text ?? "").split("\n")[0]);
  root.replaceChildren(el("div", { class: "v" }, el("div", { class: "vh" }, tile(), el("div", { class: "grow" }, el("div", { class: "t" }, "Surehand"))), line));
}

startView("Changes", { onResult })
  .then((v) => {
    view = v;
    // the result can arrive before the connection is done: fetch the first frames now
    if (state.data?.proof?.frames.length) void loadFrames(state.at);
  })
  .catch(() => undefined);
