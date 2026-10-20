// The data the in-chat views get, shared by the server (which builds it) and the views (which draw it).
// It travels in a tool result's _meta["surehand/view"], never in its text or structuredContent: Claude Code
// and ChatGPT give structuredContent to the model instead of the text, which must stay as it is.

/** Where a tool result carries its view's data. */
export const VIEW_META_KEY = "surehand/view";
/** An app-only tool's error kind, for a short message in the view ("AE isn't open", "AE is busy"). */
export const VIEW_ERROR_KEY = "surehand/error";

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
