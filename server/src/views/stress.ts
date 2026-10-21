// The stress test view (browser code): the verdict, a grid of variants and checks (failing first), the open variant's
// failing frame with its box, the safe area and the problem marked, the expressions that break in other After Effects
// languages. The frame is the one the run kept (ae_view_stress_frame); Show in AE moves After Effects there
// (ae_view_reveal); Ask the AI to fix this writes the request into the chat; Run again re-runs ae_stress_test with the
// same arguments. Nothing here edits the project.
import { el, errorText, sentence, startView, textResult, tile, viewData, type ToolResult, type View } from "./shared.js";
import { COLUMN_TITLES, fixRequest, footerText, frameMarks, gridModel, leadFinding, metaText, openMessage, verdictText } from "./stress-model.js";
import type { FrameView, Rect, StressCell, StressVariant, StressView } from "./types.js";

interface Frame {
  src?: string;
  frame?: FrameView;
  error?: string;
}

const state: {
  data?: StressView;
  args?: Record<string, unknown>;
  /** the open variant (its id) */
  open?: string;
  frames: Map<string, Frame>;
  /** per-row messages (Show in AE / Ask the AI failed), and one for the whole view (Run again) */
  rowError: Map<string, string>;
  error?: string;
  running?: boolean;
  all?: boolean;
} = { frames: new Map(), rowError: new Map() };

let view: View | undefined;
const root = document.getElementById("app")!;

const VERDICT_CLASS: Record<StressView["verdict"], string> = { FAIL: "bad", WARNINGS: "warn", INCOMPLETE: "nr", PASS: "ok" };
const pct = (n: number) => `${Math.max(-50, Math.min(150, n * 100))}%`;

function header(d: StressView): HTMLElement {
  const run = el("button", { class: "btn", "data-k": "run", disabled: state.running || undefined, onclick: runAgain }, state.running ? "Running…" : "Run again");
  return el("div", { class: "vh" }, tile(), el("div", { class: "grow" }, el("div", { class: "t" }, `Stress test · ${d.comp.name}`), el("div", { class: "s" }, metaText(d))), run);
}

function verdictBar(d: StressView): HTMLElement {
  const cls = VERDICT_CLASS[d.verdict];
  return el("div", { class: "verdict" }, el("span", { class: `g ${cls}` }), el("span", { class: `big ${cls === "nr" ? "mut" : cls}` }, d.verdict), el("span", { class: "mono mut" }, verdictText(d)));
}

const square = (c: StressCell) => (c === "na" ? el("span", { class: "dash", title: "not checked" }, "–") : el("span", { class: `g ${c}`, title: c === "ok" ? "passed" : c === "bad" ? "fails" : "warning" }));

function frameFor(d: StressView, v: StressVariant): HTMLElement {
  const f = leadFinding(v), fr = state.frames.get(v.id), W = d.comp.width, H = d.comp.height;
  const err = state.rowError.get(v.id);
  const side = el(
    "div",
    {},
    el("div", { class: "mono", style: { fontSize: "12px" } }, [v.name, f?.tc ?? (v.frame ? v.frame.tc : "")].filter(Boolean).join(" · ")),
    el("div", { style: { margin: "4px 0 6px" } }, openMessage(v)),
    v.inputs.map((i) => el("div", { class: "input", title: i.target }, v.inputs.length > 1 ? `${i.target}: ` : "", i.value === "" ? "(empty)" : i.value)),
    el(
      "div",
      { style: { display: "flex", gap: "6px", marginTop: "8px", flexWrap: "wrap" } },
      el("button", { class: "btn sm", "data-k": `show-${v.id}`, onclick: () => reveal(v) }, "Show in AE"),
      el("button", { class: "btn sm", "data-k": `ask-${v.id}`, onclick: () => askFix(v) }, "Ask the AI to fix this"),
    ),
    err ? el("div", { class: "err" }, err) : null,
  );
  if (!v.frame) return el("div", { class: "frame noimg" }, side);
  const box = (r: Rect) => ({ left: pct(r[0] / W), top: pct(r[1] / H), width: pct((r[2] - r[0]) / W), height: pct((r[3] - r[1]) / H) });
  const marks = frameMarks(f);
  const still = el(
    "div",
    { class: "still", style: { aspectRatio: `${v.frame.width} / ${v.frame.height}` } },
    fr?.src ? el("img", { src: fr.src, alt: `${v.name}, frame ${v.frame.tc}` }) : null,
    marks.dashed.map((r) => el("span", { class: "safe", style: box(r) })),
    marks.hit ? el("span", { class: `hit${marks.hit.warn ? " warn" : ""}`, style: box(marks.hit.rect) }) : null,
    fr?.error ? el("div", { class: "err" }, fr.error) : null,
  );
  return el("div", { class: "frame" }, still, side);
}

function grid(d: StressView): HTMLElement {
  const g = gridModel(d, state.all);
  const head = el("tr", {}, el("th", {}, "Input"), g.columns.map((c) => el("th", {}, COLUMN_TITLES[c])));
  const rows: HTMLElement[] = [];
  for (const v of g.rows) {
    const open = state.open === v.id, k = `row-${v.id}`;
    rows.push(
      el(
        "tr",
        {
          class: open ? "sel" : undefined,
          role: "button",
          tabindex: 0,
          "aria-expanded": open ? "true" : "false",
          "data-k": k,
          style: { cursor: "pointer" },
          onclick: () => toggle(v.id),
          onkeydown: (e: KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") (e.preventDefault(), toggle(v.id));
          },
        },
        el("td", {}, el("div", { class: "vn" }, v.name), el("div", { class: "vs" }, v.detail)),
        g.columns.map((c) => el("td", {}, square(v.cells[c]))),
      ),
    );
  }
  const open = g.rows.find((v) => v.id === state.open);
  // the open variant's frame under the grid (as the board has it)
  return el("div", {}, el("div", { class: "mx" }, el("table", {}, head, rows)), open ? frameFor(d, open) : null);
}

function languages(d: StressView): HTMLElement | null {
  if (!d.languages.length) return null;
  return el(
    "div",
    { class: "grp" },
    el("div", { class: "gh" }, el("span", { class: "eyebrow" }, "Breaks in other AE languages")),
    d.languages.map((l, i) => {
      const prop = l.property.split("/").pop() ?? l.property;
      const err = state.rowError.get(`lang${i}`);
      return el(
        "div",
        { class: "row" },
        el("span", { class: `g ${l.severity === "fail" ? "bad" : "warn"}` }),
        el("span", { class: "tc" }, `${l.layer} › ${prop}`),
        el("div", { class: "msg" }, `${l.ref} ${l.message}${/[.!?)]$/.test(l.message) ? "" : "."}`, el("div", { class: "fix" }, sentence(l.suggestion ? `${l.fix}: ${l.suggestion}` : l.fix)), err ? el("div", { class: "err" }, err) : null),
        el("button", { class: "btn sm", "data-k": `lang${i}`, onclick: () => revealLayer(i) }, "Show in AE"),
      );
    }),
  );
}

function render() {
  const d = state.data;
  if (!d) return;
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.k;
  const v = el("div", { class: "v" }, header(d), verdictBar(d));
  if (state.error) v.append(el("div", { class: "err note" }, state.error));
  if (d.variants.length)
    v.append(el("div", { class: "grp" }, el("div", { class: "gh" }, el("span", { class: "eyebrow" }, "Variants"), el("span", { class: "grow" }), el("span", { class: "mono mut", style: { fontSize: "11px" } }, "failing first")), grid(d)));
  const lang = languages(d);
  if (lang) v.append(lang);
  const g = gridModel(d, state.all);
  v.append(
    el(
      "div",
      { class: "foot" },
      el("span", { class: "sum grow" }, footerText(g, !!state.all, d.variants.length)),
      g.hidden.length || state.all ? el("button", { class: "btn", "data-k": "all", "aria-expanded": state.all ? "true" : "false", onclick: () => ((state.all = !state.all), render()) }, state.all ? "Show less" : "Show all") : null,
    ),
  );
  root.replaceChildren(v);
  if (focused) (root.querySelector(`[data-k="${CSS.escape(focused)}"]`) as HTMLElement | null)?.focus();
}

function toggle(id: string) {
  state.open = state.open === id ? undefined : id;
  render();
  if (state.open === id) void loadFrame(id);
}

async function loadFrame(id: string) {
  const d = state.data!, v = d.variants.find((x) => x.id === id);
  const had = state.frames.get(id);
  if (!view || !v?.frame || (had && !had.error)) return;
  state.frames.set(id, {});
  const r = await view.call("ae_view_stress_frame", { run: d.run, file: v.frame.file });
  if (state.data !== d) return; // run again meanwhile
  if (!r.ok) state.frames.set(id, { error: r.message });
  else {
    const img = r.result.content?.find((c) => c.type === "image");
    state.frames.set(id, img?.data ? { src: `data:${img.mimeType ?? "image/jpeg"};base64,${img.data}`, frame: viewData<FrameView>(r.result) } : { error: "No frame came back." });
  }
  render();
}

async function reveal(v: StressVariant) {
  const d = state.data!, f = leadFinding(v);
  if (!view) return;
  state.rowError.delete(v.id);
  const time = f?.time ?? v.frame?.time;
  const r = await view.call("ae_view_reveal", { comp: d.comp.id, ...(time !== undefined ? { time } : {}), ...(f?.layerIndex ? { layer: f.layerIndex } : {}) });
  if (!r.ok) state.rowError.set(v.id, r.message);
  render();
}

async function revealLayer(i: number) {
  const d = state.data!, l = d.languages[i];
  if (!view) return;
  state.rowError.delete(`lang${i}`);
  const r = await view.call("ae_view_reveal", { comp: l.compId, layer: l.layerIndex });
  if (!r.ok) state.rowError.set(`lang${i}`, r.message);
  render();
}

async function askFix(v: StressVariant) {
  const d = state.data!;
  state.rowError.delete(v.id);
  if (!view || !(await view.ask(fixRequest(d, v)))) state.rowError.set(v.id, "The request couldn't be written into the chat.");
  render();
}

async function runAgain() {
  if (!view || state.running) return;
  const args = state.args ?? state.data?.args;
  if (!args) {
    state.error = "The test's arguments aren't available here: ask the AI to run the stress test again.";
    return render();
  }
  state.running = true;
  state.error = undefined;
  render();
  const r = await view.call("ae_stress_test", args);
  state.running = false;
  const d = r.ok ? viewData<StressView>(r.result) : undefined;
  if (d) show(d);
  else {
    state.error = r.ok ? errorText(undefined, r.result.content?.find((c) => c.type === "text")?.text) : r.message;
    render();
  }
}

/** The first failing (else warning) variant is open. */
function show(d: StressView) {
  state.data = d;
  state.frames.clear();
  state.rowError.clear();
  state.error = undefined;
  state.all = false;
  const first = gridModel(d).rows.find((v) => v.status === "fail" || v.status === "warn");
  state.open = first?.id;
  render();
  if (first) void loadFrame(first.id);
}

function onResult(r: ToolResult) {
  const d = viewData<StressView>(r);
  if (d) return show(d);
  // a refusal (nothing variable, a missing margin) or After Effects not reachable: the text itself
  root.replaceChildren(textResult("Stress test", r));
}

startView("Stress test", { onInput: (a) => (state.args = a), onResult })
  .then((v) => (view = v))
  .catch(() => undefined);
