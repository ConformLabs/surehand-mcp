// The Preflight report view (browser code): the verdict, a timeline of the findings, the findings grouped by
// check. Opening a row fetches that frame with the problem marked (ae_view_frame); Show in AE moves After
// Effects there (ae_view_reveal); Ask the AI to fix this writes the request into the chat; Run again re-runs
// ae_preflight with the same arguments. Nothing here edits the project.
import { el, errorText, sentence, startView, tile, viewData, type ToolResult, type View } from "./shared.js";
import type { FrameView, PreflightFinding, PreflightView } from "./types.js";

interface Frame {
  src?: string;
  frame?: FrameView;
  error?: string;
}

const state: {
  data?: PreflightView;
  args?: Record<string, unknown>;
  /** the open row (index into data.findings) */
  open?: number;
  frames: Map<number, Frame>;
  /** per-row messages (Show in AE / Ask the AI failed), and one for the whole report (Run again) */
  rowError: Map<number, string>;
  error?: string;
  running?: boolean;
  allPassed?: boolean;
} = { frames: new Map(), rowError: new Map() };

let view: View | undefined;
const root = document.getElementById("app")!;

const VERDICT_CLASS: Record<PreflightView["verdict"], string> = { FAIL: "bad", WARNINGS: "warn", INCOMPLETE: "nr", PASS: "ok" };
const startOf = (f: PreflightFinding) => (f.at === undefined ? undefined : Array.isArray(f.at) ? f.at[0] : f.at);
const endOf = (f: PreflightFinding) => (f.at === undefined ? undefined : Array.isArray(f.at) ? f.at[1] : f.at);
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const pct = (n: number) => `${Math.max(0, Math.min(100, n * 100))}%`;

function duration(d: PreflightView): number | undefined {
  return d.comp?.duration ?? d.file?.duration;
}

/** a tick label: "00:05", or "00:02.5" on a short comp */
function tick(s: number, dur: number): string {
  const m = Math.floor(s / 60), sec = s - m * 60;
  const ss = dur < 6 ? sec.toFixed(1).padStart(4, "0") : String(Math.round(sec)).padStart(2, "0");
  return `${String(m).padStart(2, "0")}:${ss}`;
}

function header(d: PreflightView): HTMLElement {
  const sub: string[] = [d.spec];
  const c = d.comp, f = d.file;
  if (c) sub.push(`${c.width}×${c.height}`, `${c.fps} fps`, c.durationTc);
  else if (f) {
    if (f.width && f.height) sub.push(`${f.width}×${f.height}`);
    if (f.fps) sub.push(`${f.fps} fps`);
    if (f.durationTc) sub.push(f.durationTc);
  }
  const run = el("button", { class: "btn sm", "data-k": "run", disabled: state.running || undefined, onclick: runAgain }, state.running ? "Running…" : "Run again");
  return el("div", { class: "vh" }, tile(), el("div", { class: "grow" }, el("div", { class: "t" }, `Preflight · ${c?.name ?? f?.name ?? "report"}`), el("div", { class: "s" }, sub.join(" · "))), run);
}

function verdictBar(d: PreflightView): HTMLElement {
  const n = d.counts, parts: string[] = [];
  if (n.failed) parts.push(`${n.failed} failed`);
  if (n.warnings) parts.push(plural(n.warnings, "warning"));
  if (n.notRun) parts.push(`${n.notRun} not run`);
  parts.push(`${n.passed} passed`);
  const cls = VERDICT_CLASS[d.verdict];
  return el("div", { class: "verdict" }, el("span", { class: `g ${cls}` }), el("span", { class: `big ${cls === "nr" ? "mut" : cls}` }, d.verdict), el("span", { class: "mono mut" }, parts.join(" · ")));
}

function timeline(d: PreflightView): HTMLElement | null {
  const dur = duration(d);
  if (!dur || dur <= 0) return null;
  const track = el("div", { class: "track" });
  const timed = d.findings.filter((f) => f.at !== undefined);
  // warnings under failures
  for (const f of [...timed].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "warn" ? -1 : 1))) {
    const a = startOf(f)!, b = endOf(f)!;
    track.append(el("span", { class: `m ${f.severity === "fail" ? "bad" : "warn"}`, style: { left: pct(a / dur), width: pct((b - a) / dur) } }));
  }
  const whole = d.findings.filter((f) => f.at === undefined);
  if (whole.length) track.append(el("span", { class: `m whole ${whole.some((f) => f.severity === "fail") ? "bad" : "warn"}` }));
  const open = state.open !== undefined ? d.findings[state.open] : undefined;
  if (open && open.at !== undefined) track.append(el("span", { class: "ph", style: { left: pct(startOf(open)! / dur) } }));
  const ticks = el("div", { class: "ticks" });
  for (let i = 0; i <= 6; i++) ticks.append(el("span", {}, tick((dur * i) / 6, dur)));
  return el("div", { class: "tl" }, track, ticks);
}

/** "Fix the Safe areas finding at 00:00:12:10 in Main › LT_Name: outside title-safe by up to 18 px on the bottom." */
export function fixRequest(f: PreflightFinding): string {
  const msg = f.message.trim().replace(/[.]$/, "");
  return `Fix the ${f.group} finding${f.tc ? ` at ${f.tc}` : ""}${f.where ? ` in ${f.where}` : ""}: ${msg}.`;
}

function frameFor(d: PreflightView, i: number): HTMLElement {
  const f = d.findings[i], c = d.comp, fr = state.frames.get(i);
  const ask = el("button", { class: "btn sm", "data-k": `ask${i}`, onclick: () => askFix(i) }, "Ask the AI to fix this");
  const canFrame = !!c && f.at !== undefined;
  const area = f.area && f.area.name !== "frame" ? `${f.area.name} safe` : undefined;
  const caption = canFrame ? `Frame ${f.tc ?? ""}${area ? `, ${area} dashed` : ""}.` : "";
  const cap = el("div", { class: "mono mut cap" }, caption, caption ? [el("br"), el("br")] : null, ask);
  if (!canFrame) return el("div", { class: "frame noimg" }, cap);
  const W = c!.width, H = c!.height;
  const box = (r: [number, number, number, number]) => ({ left: pct(r[0] / W), top: pct(r[1] / H), width: pct((r[2] - r[0]) / W), height: pct((r[3] - r[1]) / H) });
  const still = el(
    "div",
    { class: "still", style: { aspectRatio: `${fr?.frame ? fr.frame.width : W} / ${fr?.frame ? fr.frame.height : H}` } },
    fr?.src ? el("img", { src: fr.src, alt: `Frame ${f.tc ?? ""}` }) : null,
    f.area && f.area.name !== "frame" ? el("span", { class: "safe", style: box(f.area.rect) }) : null,
    f.box ? el("span", { class: `hit${f.severity === "warn" ? " warn" : ""}`, style: box(f.box) }) : null,
    fr?.error ? el("div", { class: "err" }, fr.error) : null,
  );
  return el("div", { class: "frame" }, still, cap);
}

function findingRow(d: PreflightView, i: number): HTMLElement[] {
  const f = d.findings[i], open = state.open === i, start = startOf(f);
  const whole = d.target === "file" ? "whole file" : "whole comp";
  const tc = el("span", { class: "tc" }, f.tc ?? whole, f.tcEnd ? [el("br"), el("span", { class: "mut" }, `→ ${f.tcEnd}`)] : null);
  const err = state.rowError.get(i);
  const msg = el(
    "span",
    { class: "msg" },
    sentence(f.message),
    f.where ? el("div", { class: "where" }, f.where) : null,
    open && f.fix ? el("div", { class: "fix" }, sentence(f.fix)) : null,
    err ? el("div", { class: "err" }, err) : null,
  );
  const canShow = !!d.comp && start !== undefined;
  const show = canShow
    ? el("button", { class: "btn sm", "data-k": `show${i}`, onclick: (e: Event) => (e.stopPropagation(), reveal(i)), onkeydown: (e: Event) => e.stopPropagation() }, "Show in AE")
    : el("span");
  const row = el(
    "div",
    {
      class: `row open-able${open ? " sel" : ""}`,
      role: "button",
      tabindex: 0,
      "aria-expanded": open ? "true" : "false",
      "data-k": `row${i}`,
      onclick: () => toggle(i),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") (e.preventDefault(), toggle(i));
      },
    },
    el("span", { class: `g ${f.severity === "fail" ? "bad" : "warn"}` }),
    tc,
    msg,
    show,
  );
  return open ? [row, frameFor(d, i)] : [row];
}

function render() {
  const d = state.data;
  if (!d) return;
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.k;
  const v = el("div", { class: "v" }, header(d), verdictBar(d));
  if (state.error) v.append(el("div", { class: "err note" }, state.error));
  const tl = timeline(d);
  if (tl) v.append(tl);
  // groups in the order the findings come (worst first)
  const groups = new Map<string, number[]>();
  d.findings.forEach((f, i) => groups.set(f.group, [...(groups.get(f.group) ?? []), i]));
  for (const [g, rows] of groups) v.append(el("div", { class: "grp" }, el("div", { class: "gh" }, el("span", { class: "eyebrow" }, g)), rows.flatMap((i) => findingRow(d, i))));
  if (d.notRun.length)
    v.append(
      el(
        "div",
        { class: "grp" },
        el("div", { class: "gh" }, el("span", { class: "eyebrow" }, "Not run")),
        d.notRun.map((n) => el("div", { class: "row" }, el("span", { class: "g nr" }), el("span", { class: "tc" }, n.label), el("span", { class: "msg mut" }, sentence(n.reason)), el("span"))),
      ),
    );
  const names = state.allPassed ? d.passed.join(", ") : d.passed.slice(0, 3).join(", ") + (d.passed.length > 3 ? " …" : "");
  const more = d.more ? `${d.findings.length} findings shown; ${d.more} more in the text report · ` : "";
  const sum = `${more}${plural(d.passed.length, "check")} passed${d.passed.length ? ` · ${names}` : ""}`;
  v.append(
    el(
      "div",
      { class: "foot" },
      el("span", { class: "sum grow" }, sum),
      d.passed.length > 3 ? el("button", { class: "btn sm", "data-k": "all", "aria-expanded": state.allPassed ? "true" : "false", onclick: () => ((state.allPassed = !state.allPassed), render()) }, state.allPassed ? "Show less" : "Show all") : null,
    ),
  );
  root.replaceChildren(v);
  if (focused) (root.querySelector(`[data-k="${focused}"]`) as HTMLElement | null)?.focus();
}

function toggle(i: number) {
  state.open = state.open === i ? undefined : i;
  render();
  if (state.open === i) void loadFrame(i);
}

async function loadFrame(i: number) {
  const d = state.data!, f = d.findings[i];
  // cached per row: loading or loaded; one that failed is fetched again when the row is opened again
  const had = state.frames.get(i);
  if (!view || !d.comp || f.at === undefined || (had && !had.error)) return;
  state.frames.set(i, {});
  const r = await view.call("ae_view_frame", { comp: d.comp.id, time: startOf(f) });
  if (state.data !== d) return; // run again meanwhile
  if (!r.ok) state.frames.set(i, { error: r.message });
  else {
    const img = r.result.content?.find((c) => c.type === "image");
    state.frames.set(i, img?.data ? { src: `data:${img.mimeType ?? "image/jpeg"};base64,${img.data}`, frame: viewData<FrameView>(r.result) } : { error: "No frame came back." });
  }
  render();
}

async function reveal(i: number) {
  const d = state.data!, f = d.findings[i];
  if (!view || !d.comp) return;
  state.rowError.delete(i);
  const r = await view.call("ae_view_reveal", { comp: d.comp.id, time: startOf(f), ...(f.layer ? { layer: f.layer } : {}) });
  if (!r.ok) state.rowError.set(i, r.message);
  render();
}

async function askFix(i: number) {
  const d = state.data!;
  state.rowError.delete(i);
  if (!view || !(await view.ask(fixRequest(d.findings[i])))) state.rowError.set(i, "The request couldn't be written into the chat.");
  render();
}

async function runAgain() {
  if (!view || state.running) return;
  if (!state.args) {
    state.error = "The check's arguments aren't available here: ask the AI to run Preflight again.";
    return render();
  }
  state.running = true;
  state.error = undefined;
  render();
  const r = await view.call("ae_preflight", state.args);
  state.running = false;
  const d = r.ok ? viewData<PreflightView>(r.result) : undefined;
  if (d) show(d);
  else {
    state.error = r.ok ? errorText(undefined, r.result.content?.find((c) => c.type === "text")?.text) : r.message;
    render();
  }
}

function show(d: PreflightView) {
  state.data = d;
  state.open = undefined;
  state.frames.clear();
  state.rowError.clear();
  state.error = undefined;
  render();
}

function onResult(r: ToolResult) {
  const d = viewData<PreflightView>(r);
  if (d) return show(d);
  // an error, or an older Surehand without view data: the text says it
  const text = r.content?.find((c) => c.type === "text")?.text;
  root.replaceChildren(el("div", { class: "v" }, el("div", { class: "vh" }, tile(), el("div", { class: "grow" }, el("div", { class: "t" }, "Preflight"))), el("div", { class: "err note" }, errorText(r._meta?.["surehand/error"] as string | undefined, text))));
}

startView("Preflight", { onInput: (a) => (state.args = a), onResult })
  .then((v) => (view = v))
  .catch(() => undefined);
