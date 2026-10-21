// ae_stress_test: where a run keeps its failing frames (for the in-chat view) and, by default, its contact sheets:
// ~/.surehand/ae/stress/<run>/. The newest runs stay; older ones are removed when a new run starts.
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { appFile } from "../paths.js";

export const stressRoot = () => appFile("stress");
export const MAX_RUNS = 20;

/** Old runs' folders go (the newest `keep` stay). */
export function pruneRuns(keep = MAX_RUNS) {
  try {
    const ids = readdirSync(stressRoot()).filter((d) => /^[\w-]+$/.test(d)).sort();
    for (const id of ids.slice(0, Math.max(0, ids.length - keep))) rmSync(join(stressRoot(), id), { recursive: true, force: true });
  } catch {}
}

/** A failing frame a run kept (ae_view_stress_frame), or null (bad name, or the run is gone). */
export function stressFramePath(run: string, file: string): string | null {
  if (!/^[\w-]+$/.test(run) || !/^[\w.@+-]+\.png$/.test(file)) return null;
  const p = join(stressRoot(), run, file);
  try {
    return statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}
