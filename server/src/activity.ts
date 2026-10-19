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
