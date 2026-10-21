// The data the in-chat views get, shared by the server (which builds it) and the views (which draw it).
// It travels in a tool result's _meta["surehand/view"], never in its text or structuredContent: Claude Code
// and ChatGPT give structuredContent to the model instead of the text, which must stay as it is.

/** Where a tool result carries its view's data. */
export const VIEW_META_KEY = "surehand/view";
/** An app-only tool's error kind, for a short message in the view ("AE isn't open", "AE is busy"). */
export const VIEW_ERROR_KEY = "surehand/error";

/** The X-ray view's resource (here, not in tools/views.ts: the JSX tool list can't import that module). */
export const XRAY_VIEW_URI = "ui://surehand/xray.html";

/** A comp-pixel rectangle [x0, y0, x1, y1]. */
export type Rect = [number, number, number, number];

export interface PreflightFinding {
  /** the check (e.g. "safeAreas.title") and its group's heading in the view ("Safe areas") */
  check: string;
  group: string;
  severity: "fail" | "warn" | "info";
  message: string;
  /** seconds in the comp / file, and as timecode in its frame rate */
  at?: number | [number, number];
  tc?: string;
  tcEnd?: string;
  /** "Main › Lower third › Name" */
  where?: string;
  /** the delivered comp's layer it is on or in (1-based), for Show in AE */
  layer?: number;
  fix?: string;
  /** the layer's bounds at `at`, and the safe area it must stay in (comp pixels) */
  box?: Rect;
  area?: { name: "title" | "action" | "frame"; rect: Rect };
}

export interface PreflightView {
  view: "preflight";
  /** PASS / FAIL / WARNINGS / INCOMPLETE, and the text report's whole verdict line ("FAIL (2)") */
  verdict: "PASS" | "FAIL" | "WARNINGS" | "INCOMPLETE";
  verdictLine: string;
  counts: { failed: number; warnings: number; notRun: number; passed: number };
  /** the spec's file name, or its name */
  spec: string;
  target: "project" | "file" | "both";
  comp?: { id: number; name: string; width: number; height: number; fps: number; duration: number; durationTc: string };
  file?: { name: string; width?: number; height?: number; fps?: number; duration?: number; durationTc?: string };
  findings: PreflightFinding[];
  /** findings left out of the view (it shows at most MAX_VIEW_FINDINGS; the text report has its own limit) */
  more: number;
  notRun: { check: string; label: string; reason: string }[];
  /** the checks that ran and found nothing, by name */
  passed: string[];
}

/**
 * One change to the project, as the views list it: "Scale 100 % → 64 %" under "Endcard › Logo_Mark › Transform".
 * Built from the change report (an edit's "Changes") or the history diff, beside their text lines.
 */
export interface ViewChange {
  op: "+" | "-" | "~";
  /** where: comp, layer, the property's group path (display names); comp and layer also serve Show in AE */
  comp?: string;
  layer?: string;
  /** the layer's index when the source knows it (the history diff) */
  layerIndex?: number;
  path?: string;
  /** what changed: a property or field name with its old and new value, or a whole phrase */
  what: string;
  from?: string;
  to?: string;
}

/** A compared frame of a proof (ae_prove_identical). */
export interface ProofFrame {
  comp: string;
  compId: number;
  /** the frame's index in its comp's reference frames (what ae_view_proof_frame takes) */
  index: number;
  time: number;
  tc: string;
  /** beyond the tolerance; maxDiff is the largest channel difference (0-255) */
  differs: boolean;
  maxDiff?: number;
  /** not compared: the comp was deleted, changed size, or a frame couldn't be read */
  missing?: boolean;
}

/** ae_prove_identical (verdict, frames, the edit's changes) or ae_project_history diff (changes only). */
export interface ChangesView {
  view: "changes";
  source: "proof" | "history";
  /** the header: "Proven edit · Endcard" / "What changed · Spot.aep", and the line under it */
  title: string;
  subtitle: string;
  proof?: {
    id: string;
    /** this comparison (its "after" frames are kept with the proof until the next comparison) */
    compared: string;
    verdict: "IDENTICAL" | "DIFFERS" | "NOT PROVEN";
    /** the text's verdict line */
    verdictLine: string;
    tolerance: number;
    maxDiff: number;
    frames: ProofFrame[];
  };
  changes: ViewChange[];
  /** changes left out of the view (it lists at most MAX_VIEW_CHANGES) or of the source's own list */
  moreChanges: number;
  /** under the list: "One undo step in After Effects", or the history diff's summary */
  footnote: string;
}

/** X-ray problem kinds: the chips, the tags in the tree and the detail pane's sections. */
export type XrayTag = "missing" | "placeholder" | "fragile" | "heavy" | "unused";

/** A node of the "What renders" tree: a render queue item, a comp, a footage item, or a group of roots. */
export interface XrayNode {
  /** "q1" (render queue item 1), "c12" (comp id 12), "f33" (footage id 33), "g:unused" / "g:top" (groups) */
  key: string;
  kind: "rq" | "comp" | "footage" | "group";
  name: string;
  /** after the name: "30 s · 14 layers", "→ Main_16x9.mov" */
  meta?: string;
  tags: XrayTag[];
  childCount: number;
  /** loaded children (with how many layers use each); undefined until loaded (ae_view_xray_node) */
  children?: { key: string; n?: number }[];
  /** for Show in AE: open this comp, or select this project item */
  comp?: number;
  item?: number;
}

/** One problem of a node, as the detail pane shows it. */
export interface XrayProblem {
  tag: XrayTag;
  /** "An expression finds a layer by its name" */
  title: string;
  /** "Endcard › CTA_Text › Opacity" */
  where?: string;
  /** the expression, and the part of it to mark */
  code?: string;
  mark?: string;
  text: string;
  /** Show in AE */
  reveal?: { comp?: number; layer?: number; item?: number };
  /** the "Ask the AI to …" button and what it writes into the chat */
  ask?: { label: string; text: string };
}

export interface XrayView {
  view: "xray";
  /** this X-ray's analysis is kept under this id for ae_view_xray_node */
  run: string;
  title: string;
  subtitle: string;
  chips: { tag: XrayTag; count: number }[];
  roots: string[];
  /** the tree's first levels (more come from ae_view_xray_node) */
  nodes: Record<string, XrayNode>;
  /** for each problem: paths (root first) to the nodes that have it, so a chip can filter the tree */
  paths: Partial<Record<XrayTag, string[][]>>;
  /** the scan stopped early: why */
  partial?: string;
}

/** ae_view_xray_node: a node's children and its problems. */
export interface XrayNodeView {
  view: "xrayNode";
  node: XrayNode;
  children: XrayNode[];
  problems: XrayProblem[];
  /** problems left out (the view lists at most MAX_NODE_PROBLEMS) */
  moreProblems: number;
}

/** One still from ae_view_frame (the image itself is the result's image content). */
export interface FrameView {
  view: "frame";
  comp: string;
  time: number;
  /** the comp's size in pixels (the still is scaled to fit `width` x `height`) */
  compWidth: number;
  compHeight: number;
  width: number;
  height: number;
}

/** The stress test view's resource (here, beside X-ray's: the tool module and the views module both need it). */
export const STRESS_VIEW_URI = "ui://surehand/stress.html";

/** A check column of the stress test grid; "other" holds numbers, values that couldn't be set and expression errors. */
export type StressColumn = "fit" | "safe" | "size" | "glyphs" | "lines" | "other";
export type StressCell = "ok" | "bad" | "warn" | "na";

/** One measured problem of a variant (or of the comp as it is: the baseline). Frames count from the comp's start (0). */
export interface StressFinding {
  /** "text.overflow", "safeAreas.title", "text.glyphs", "number.format"... and the grid column it counts in */
  check: string;
  column: StressColumn;
  severity: "fail" | "warn";
  message: string;
  /** the comp's own layer (index: for Show in AE), or "Precomp › Layer" when nested */
  layer?: string;
  layerIndex?: number;
  frame?: number;
  frameEnd?: number;
  /** seconds and timecode of `frame` */
  time?: number;
  tc?: string;
  /** comp pixels [x0, y0, x1, y1]: the layer's bounds there, its paragraph box (media: the area it covered), the safe area */
  box?: Rect;
  textBox?: Rect;
  area?: { name: "title" | "action" | "frame"; rect: Rect };
  /** the measured amount, comp px (overflow, overshoot, overlap, uncovered) */
  amountPx?: number;
}

/** What a variant measured on a text layer of the comp. */
export interface StressLayer {
  layer: string;
  layerIndex: number;
  text: string;
  font?: string;
  fontSize?: number;
  /** the size it renders at in the comp (font size through the layer's scale) */
  renderedPx?: number;
  lines?: number;
  linesNeeded?: number;
  overflowPx?: number;
  box?: Rect;
  direction?: string;
  composer?: string;
  substituted?: boolean;
}

export interface StressVariant {
  /** "de-long@Title", "row-3", "own-1@Price", "de-long@all" */
  id: string;
  name: string;
  set: "generated" | "together" | "own" | "data" | "combination";
  caseId?: string;
  group?: string;
  /** the muted sub-line: "Title · 52 chars, compounds" */
  detail: string;
  /** what was set: the control and the input exactly as typed */
  inputs: { target: string; value: string; detail?: string }[];
  status: "fail" | "warn" | "pass" | "incomplete" | "notRun";
  cells: Record<StressColumn, StressCell>;
  /** findings new with this variant (what already fails in the comp as it is is in the baseline) */
  findings: StressFinding[];
  layers: StressLayer[];
  /** why a check couldn't run */
  notRun: { column: StressColumn; reason: string }[];
  /** the contact sheet of its failing frames, and its first failing frame (ae_view_stress_frame reads it) */
  sheet?: string;
  frame?: { file: string; frame: number; time: number; tc: string; width: number; height: number };
}

/** An expression that breaks in After Effects in another language. */
export interface StressLanguageRisk {
  comp: string;
  compId: number;
  layer: string;
  layerIndex: number;
  property: string;
  ref: string;
  code: string;
  severity: "fail" | "warn";
  message: string;
  fix: string;
  suggestion?: string;
}

/** ae_stress_test: everything the run measured (the text report is built from the same data). */
export interface StressView {
  view: "stress";
  /** the run's id (its frames are kept under it for ae_view_stress_frame) */
  run: string;
  verdict: "PASS" | "FAIL" | "WARNINGS" | "INCOMPLETE";
  verdictLine: string;
  comp: { id: number; name: string; width: number; height: number; fps: number; duration: number; dst?: number; df?: boolean };
  counts: { variants: number; failed: number; warnings: number; passed: number; incomplete: number; notRun: number; languageRisks: number; targets: number; frames: number };
  targets: { id: string; name: string; kind: string; source: "egp" | "layer" | "data"; layer?: number; layerName?: string; current?: string; problem?: string }[];
  /** the frames every variant was measured at */
  frames: number[];
  columns: { id: StressColumn; label: string; ran: boolean; why?: string }[];
  /** failing first, then warnings, incomplete, passed, not run */
  variants: StressVariant[];
  /** what fails in the comp as it is, before any variant */
  baseline: StressFinding[];
  languages: StressLanguageRisk[];
  /** the cap: how many variants there would have been, and how the kept ones were picked */
  sampled?: { total: number; kept: number; how: string };
  /** the user's comp read back after the run (and the pixel proof, when asked) */
  restore: { verified: boolean; values: number; partial?: boolean; differences: string[]; proof?: string };
  notes: string[];
  /** where the contact sheets are */
  folder?: string;
  /** this run's arguments (Run again) */
  args?: Record<string, unknown>;
}
