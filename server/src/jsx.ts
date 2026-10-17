import { createHash } from "node:crypto";
import helperTemplate from "./aemcp.jsxinc";
import { VERSION } from "./config.js";
import { evalRaw } from "./bridge.js";

export const NEED_HELPERS = "__AEMCP_NEED_HELPERS__";
/** Version + content hash, so AE reloads the helpers whenever their source changes. */
export const HELPER_VERSION = `${VERSION}-${createHash("sha1").update(helperTemplate).digest("hex").slice(0, 10)}`;
export const helperSource = helperTemplate.replace("__AEMCP_VERSION__", HELPER_VERSION);

export interface RunOptions {
  /** Undo group name; false = no undo group (read-only tools). */
  undoGroup?: string | false;
  /** Serialization depth for the returned value. */
  depth?: number;
  timeoutMs?: number;
}

export interface RunResult {
  ok: boolean;
  result?: unknown;
  logs: string[];
  error?: { message: string; name?: string; line?: number; user?: boolean };
}

/** JSON.stringify that is also a valid ES3 literal (U+2028/2029 are illegal in ES3 strings). */
export function toJsLiteral(v: unknown): string {
  return (JSON.stringify(v ?? null) ?? "null").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/**
 * Wrap a function body so it runs through aemcp.run (undo group, error capture, serialization).
 * The body sees `args` (the JSON args) and `log(...)`.
 */
export function wrapBody(body: string, args: unknown, opts: RunOptions = {}): string {
  const runOpts = { undoGroup: opts.undoGroup === undefined ? "AE MCP" : opts.undoGroup, depth: opts.depth };
  return (
    "(function(){\n" +
    `if (typeof aemcp === 'undefined' || aemcp.version !== ${toJsLiteral(HELPER_VERSION)}) return ${toJsLiteral(NEED_HELPERS)};\n` +
    "return aemcp.run(function(args, log){\n" +
    body +
    `\n}, ${toJsLiteral(args ?? {})}, ${toJsLiteral(runOpts)});\n` +
    "})()"
  );
}

/**
 * Body for user-supplied code. The code is compiled with eval() inside the try block, so
 * syntax errors are reported (with line numbers relative to the user's code) instead of
 * AE's opaque "EvalScript error.".
 */
export function userCodeBody(code: string): string {
  return `var __fn = eval(${toJsLiteral("(function(args, log){" + code + "\n})")});\nreturn __fn(args, log);`;
}

export function parseResult(raw: string): RunResult {
  if (raw === "EvalScript error.")
    return { ok: false, logs: [], error: { message: "ExtendScript could not evaluate the script (EvalScript error). This usually means a syntax error outside the user code wrapper." } };
  try {
    const r = JSON.parse(raw);
    if (r && typeof r === "object" && "ok" in r) return { logs: [], ...r };
    return { ok: true, result: r, logs: [] };
  } catch {
    return { ok: true, result: raw, logs: [] };
  }
}

export async function ensureHelpers(): Promise<void> {
  const r = await evalRaw(helperSource, 30_000);
  if (!r.startsWith("aemcp loaded")) throw new Error("Failed to load aemcp helpers into After Effects: " + r);
}

/** Run a JSX function body in AE, loading the helper library on demand. */
export async function runJsx(body: string, args: unknown = {}, opts: RunOptions = {}): Promise<RunResult> {
  const script = wrapBody(body, args, opts);
  let raw = await evalRaw(script, opts.timeoutMs);
  if (raw === NEED_HELPERS) {
    await ensureHelpers();
    raw = await evalRaw(script, opts.timeoutMs);
  }
  return parseResult(raw);
}
