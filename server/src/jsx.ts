import { createHash } from "node:crypto";
import helperTemplate from "./aemcp.jsxinc";
import { VERSION } from "./config.js";
import { evalRaw } from "./bridge.js";

export const NEED_HELPERS = "__AEMCP_NEED_HELPERS__";
/** Version + content hash, so AE reloads the helpers whenever their source changes. */
export const HELPER_VERSION = `${VERSION}-${createHash("sha1").update(helperTemplate).digest("hex").slice(0, 10)}`;
export const helperSource = helperTemplate.replace("__AEMCP_VERSION__", HELPER_VERSION);

export interface RunOptions {
  /** Report what changed: comps (refs) to compare layer by layer besides the active comp. */
  report?: unknown[];
  /** Undo group name; false = no undo group (read-only tools). */
  undoGroup?: string | false;
  /** Serialization depth for the returned value. */
  depth?: number;
  timeoutMs?: number;
}

export interface Changes {
  items: [string, string, string, unknown?][];
  layers: [string, string, string, string?][];
  props: [string, string, string, string?][];
  scope: string[];
  partial?: boolean;
  truncated?: boolean;
  error?: string;
}

export interface RunResult {
  ok: boolean;
  result?: unknown;
  changes?: Changes;
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
  const runOpts = { undoGroup: opts.undoGroup === undefined ? "AE MCP" : opts.undoGroup, depth: opts.depth, report: opts.report };
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
  return evalBody("(function(args, log){" + code + "\n})");
}

/** Body that compiles a function-expression source with eval() (so syntax errors are catchable) and calls it. */
export function evalBody(fnSource: string): string {
  return `var __fn = eval(${toJsLiteral(fnSource)});\nreturn __fn(args, log);`;
}

/** Common ExtendScript/AE errors -> a hint on how to fix them. */
export function errorHint(message: string): string | null {
  const m = message || "";
  if (/Object is invalid/i.test(m)) return "The After Effects object no longer exists (e.g. a layer/comp was removed or the project changed). Look it up again.";
  if (/out of range|index.*range/i.test(m)) return "AE collections are 1-based: app.project.item(1..numItems), comp.layer(1..numLayers), prop.property(1..numProperties).";
  if (/Function .+ is undefined/i.test(m)) return "That method doesn't exist on this object in ExtendScript. Check the object type (ae_get_scripting_guide) or use aemcp helpers.";
  if (/undefined is not an object|null is not an object/i.test(m)) return "Something is undefined: a lookup returned nothing (names are case-sensitive; activeItem may not be a comp).";
  if (/does not have a value/i.test(m)) return "Syntax error (ExtendScript reports these as '... does not have a value').";
  if (/Can not .* to a (layer|property)|cannot set|not settable|read.?only/i.test(m)) return "That attribute is read-only or can't be set in this state (e.g. the layer is locked, or the property has expressions/keyframes).";
  return null;
}

/** "  3 | code" excerpt around a 1-based line of the user's code. */
export function codeExcerpt(code: string, line: number, context = 2): string {
  const lines = code.split(/\r?\n/);
  if (!line || line < 1 || line > lines.length) return "";
  const from = Math.max(1, line - context), to = Math.min(lines.length, line + context);
  const width = String(to).length;
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(`${i === line ? ">" : " "} ${String(i).padStart(width)} | ${lines[i - 1]}`);
  return out.join("\n");
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

/**
 * Loads the helper library through eval() inside try/catch: a syntax or runtime error then comes
 * back as text instead of After Effects showing a modal error dialog (which also blocks AE).
 * The library only assigns globals (aemcp, JSON, polyfills), so evaluating it in a function is safe.
 */
export const helperLoader =
  "(function(){try{eval(" + toJsLiteral(helperSource) + ");return 'aemcp loaded ' + aemcp.version;}" +
  "catch(e){return 'aemcp load error: ' + e.message + ' (line ' + e.line + ')';}})()";

export async function ensureHelpers(): Promise<void> {
  const r = await evalRaw(helperLoader, 30_000);
  if (!r.startsWith("aemcp loaded")) throw new Error("Failed to load the aemcp helper library into After Effects: " + r);
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

/** The change report as short, readable lines. */
export function formatChanges(ch: Changes | undefined): string | null {
  if (!ch) return null;
  if (ch.error) return `Changes: (could not be determined: ${ch.error})`;
  const lines: string[] = [];
  for (const [op, type, name, extra] of ch.items) {
    if (op === "+") lines.push(`+ ${type} "${name}"${type === "comp" && extra !== undefined ? ` (${extra} layers)` : ""}`);
    else if (op === "-") lines.push(`- ${type} "${name}"`);
    else lines.push(`~ ${type} "${name}": ${extra}`);
  }
  for (const [op, comp, layer, extra] of ch.layers) {
    if (op === "+") lines.push(`+ layer "${layer}" in "${comp}"`);
    else if (op === "-") lines.push(`- layer "${layer}" in "${comp}"`);
    else lines.push(`~ layer "${layer}" in "${comp}": ${extra}`);
  }
  for (const [op, layer, path, extra] of ch.props) {
    if (op === "+") lines.push(`+ ${layer} > ${path}`);
    else if (op === "-") lines.push(`- ${layer} > ${path}`);
    else lines.push(`~ ${layer} > ${path}: ${extra}`);
  }
  if (!lines.length) return "Changes: none";
  const notes: string[] = [];
  if (ch.scope.length) notes.push(`layers/properties compared in: ${ch.scope.join(", ")}`);
  if (ch.partial) notes.push("very large comp: some properties not compared");
  if (ch.truncated) notes.push("more changes not listed");
  return `Changes${notes.length ? ` (${notes.join("; ")})` : ""}:\n${lines.join("\n")}`;
}