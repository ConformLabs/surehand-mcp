// `surehand-ae checkpoints` and `surehand-ae checkpoint-diff <id>`: the panel's Checkpoints screen.
//   checkpoints --json [--project <path>]   {checkpoints: [{id, at, label, file, history?}]} (history: the id of the
//                                           project history snapshot stored with it; only those can be diffed)
//   checkpoint-diff <id> [--project <path>] [--json]   what changed since a checkpoint: plain text ({text} with --json)
// Errors: a message on stderr, or with --json {error} (checkpoints: {checkpoints: [], error}); exit code 1.
// Without --project, the project open in After Effects. The diff always needs After Effects (it reads
// the open project), and only compares with the project that is open there.
import { runJsx } from "../jsx.js";
import { HistoryRefError, historyDiff, snapshotIndex } from "../tools/history.js";
import { checkpointIndex } from "../tools/workflow.js";

const opt = (args: string[], name: string) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);

export interface CheckpointRow {
  id: string;
  at: string;
  label: string | null;
  file: string;
  /** the project history snapshot stored with it (only those can be diffed) */
  history?: string;
}

/** The project open in After Effects (null when it has never been saved); throws when AE can't be reached. */
async function openProject(): Promise<string | null> {
  const r = await runJsx("return app.project.file ? app.project.file.fsName : null;", {}, { undoGroup: false, timeoutMs: 15_000 });
  if (!r.ok) throw new Error(r.error?.message || "After Effects did not answer");
  return (r.result as string | null) ?? null;
}

const NO_AE = (e: any) =>
  `After Effects isn't reachable (${String(e?.message || e).split(".")[0]}). Open After Effects with the project, or pass --project <path to the .aep>.`;

export function listCheckpoints(project: string): CheckpointRow[] {
  const snaps = snapshotIndex(project);
  return checkpointIndex(project).map((c) => {
    const snap = snaps.find((s) => s.checkpoint === c.id);
    return { id: c.id, at: c.at, label: c.label ?? null, file: c.file, ...(snap ? { history: snap.id } : {}) };
  });
}

export async function checkpointsCommand(args: string[]): Promise<number> {
  const json = args.includes("--json");
  let project = opt(args, "--project");
  if (!project) {
    try {
      project = (await openProject()) ?? undefined;
    } catch (e) {
      return out(json, NO_AE(e), { checkpoints: [] });
    }
    if (!project) return out(json, "The project open in After Effects has never been saved, so it has no checkpoints.", { checkpoints: [] });
  }
  const rows = listCheckpoints(project);
  if (json) console.log(JSON.stringify({ checkpoints: rows }));
  else if (!rows.length) console.log(`No checkpoints for ${project}.`);
  else for (const r of [...rows].reverse()) console.log(`${r.id}  ${r.label ? `"${r.label}"  ` : ""}${r.history ? "" : "(no snapshot: can't be diffed)  "}${r.file}`);
  return 0;
}

export async function checkpointDiffCommand(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const id = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--project");
  if (!id) return out(json, "usage: surehand-ae checkpoint-diff <checkpoint id> [--project <path>] [--json]");
  let open: string | null;
  try {
    open = await openProject();
  } catch (e) {
    return out(json, `${NO_AE(e).split(" Open")[0]}. The diff compares the checkpoint with the project open in After Effects, so After Effects has to be running.`);
  }
  const project = opt(args, "--project") ?? open;
  if (!project) return out(json, "The project open in After Effects has never been saved, so it has no checkpoints.");
  if (open !== project) return out(json, `The diff compares with the project open in After Effects (${open ?? "an unsaved project"}), not ${project}. Open that project first.`);
  try {
    const text = await historyDiff(project, { from: id, to: "current" });
    if (json) console.log(JSON.stringify({ text }));
    else console.log(text);
    return 0;
  } catch (e: any) {
    return out(json, e instanceof HistoryRefError ? e.message.replace(/^from: /, "") : e?.message || String(e));
  }
}

function out(json: boolean, error: string, extra: Record<string, unknown> = {}): number {
  if (json) console.log(JSON.stringify({ ...extra, error }));
  else console.error(error);
  return 1;
}
