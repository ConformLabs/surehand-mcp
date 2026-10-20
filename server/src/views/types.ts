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
