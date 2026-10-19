// Preflight checks on a rendered file (ffprobe / ffmpeg). Placeholder: implemented on feat/1.4-m3-render.
import type { Finding, Spec } from "./spec.js";

export interface FileCheck {
  findings: Finding[];
  /** what ffprobe reported (codec, size, rate, duration, audio...) in a compact form */
  probe: Record<string, unknown>;
  /** PNG frames at notable times (absolute paths), for the report */
  thumbnails?: { at: number; path: string; label: string }[];
  /** checks skipped and why (e.g. no ffmpeg) */
  skipped?: string[];
}

export async function checkFile(_path: string, _spec: Spec, _opts: { thumbnails?: boolean; signal?: AbortSignal } = {}): Promise<FileCheck> {
  throw new Error("render checks are not implemented yet");
}
