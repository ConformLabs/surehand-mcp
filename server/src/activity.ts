// Activity log: every tool call with its arguments (including script code), duration and result,
// one JSON object per line in ~/.surehand/ae/activity.jsonl (rotated at 5 MB, keeps one older file).
// Shown in the Surehand MCP panel; `surehand-ae activity` prints it.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { appDir, appFile, env } from "./paths.js";

export const activityFile = () => appFile("activity.jsonl");
const MAX_BYTES = 5 * 1024 * 1024;

export interface ActivityEntry {
  at: string;
  client?: string;
  tool: string;
  args?: unknown;
  ms: number;
  ok: boolean;
  /** first line of the result or error */
  summary?: string;
  /** number of lines in the change report, when there was one */
  changes?: number;
  /** the change report's lines (at most 20), e.g. "~ Title > Transform/Position: ..." */
  changeList?: string[];
  /** app.project.revision after the call (the panel's Undo only undoes when nothing happened since) */
  revision?: number;
  /** the undo step the call made in After Effects */
  undoGroup?: string;
  /** how many undo steps the call made (the panel's Undo is offered only for exactly one) */
  undoSteps?: number;
  /** the project the call changed ("" when unsaved), and the After Effects (bridge port and process) that ran it */
  project?: string;
  instance?: { port: number; pid?: number };
  /** ae_preflight / ae_versions_from_data / ae_prove_identical: the verdict and its line */
  result?: { verdict: string; summary: string };
}

const MAX_CHANGE_LINES = 20;

/** The optional fields the panel reads, from a tool's text result and its call context. */
export function activityDetails(
  tool: string,
  text: string,
  last?: { revision?: number; undoGroup?: string; project?: string },
  call?: { undoSteps?: number; instance?: { port: number; pid?: number } },
): Partial<ActivityEntry> {
  const out: Partial<ActivityEntry> = {};
  const at = text.indexOf("\nChanges");
  if (at >= 0) {
    const lines = text.slice(at).split("\n").filter((l) => /^[+~-] /.test(l));
    if (lines.length) out.changeList = lines.slice(0, MAX_CHANGE_LINES).map((l) => l.slice(0, 300));
  }
  if (typeof last?.revision === "number") out.revision = last.revision;
  if (last?.undoGroup) out.undoGroup = last.undoGroup;
  if (typeof last?.project === "string") out.project = last.project;
  if (call?.undoSteps) out.undoSteps = call.undoSteps;
  if (call?.instance) out.instance = call.instance;
  const first = text.split("\n")[0] ?? "";
  if (tool === "ae_preflight" || tool === "ae_versions_from_data") {
    const m = /^(PASS|FAIL|WARNINGS|INCOMPLETE)\b/.exec(first);
    if (m) out.result = { verdict: m[1], summary: [first, text.split("\n")[1] ?? ""].filter(Boolean).join(" · ").slice(0, 300) };
  } else if (tool === "ae_prove_identical") {
    const m = /^Verdict: (IDENTICAL WITHIN TOLERANCE|IDENTICAL|DIFFERS|NOT PROVEN)\b[:.]?\s*(.*)$/.exec(first);
    if (m) out.result = { verdict: m[1], summary: (m[2] || m[1]).slice(0, 300) };
    else if (/^Captured proof /.test(first)) out.result = { verdict: "CAPTURED", summary: first.slice(0, 300) };
  }
  return out;
}

function trimArgs(args: unknown): unknown {
  const json = JSON.stringify(args ?? {});
  if (json.length <= 20_000) return args;
  return { truncated: true, preview: json.slice(0, 20_000) };
}

export function logActivity(e: ActivityEntry) {
  if (env("NO_ACTIVITY_LOG")) return;
  try {
    mkdirSync(appDir(), { recursive: true });
    const file = activityFile();
    if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, file + ".1");
    appendFileSync(file, JSON.stringify({ ...e, args: trimArgs(e.args) }) + "\n");
  } catch {
    // logging must never break a tool call
  }
}

export function readActivity(limit = 50): ActivityEntry[] {
  try {
    const lines = readFileSync(activityFile(), "utf8").trim().split("\n");
    return lines.slice(-limit).map((l) => JSON.parse(l)).reverse();
  } catch {
    return [];
  }
}
