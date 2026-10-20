import { createHash } from "node:crypto";
import helperTemplate from "./aemcp.jsxinc";
import { VERSION } from "./config.js";
import { evalRaw, type EvalOptions } from "./bridge.js";
import { callContext } from "./context.js";

export const NEED_HELPERS = "__AEMCP_NEED_HELPERS__";
/** Version + content hash, so AE reloads the helpers whenever their source changes. */
export const HELPER_VERSION = `${VERSION}-${createHash("sha1").update(helperTemplate).digest("hex").slice(0, 10)}`;
export const helperSource = helperTemplate.replace("__AEMCP_VERSION__", HELPER_VERSION);

export interface RunOptions {
  /** Report what changed: comps (refs) to compare layer by layer besides the active comp. */
  report?: unknown[];
  /**
   * Read-only check: where AE has app.project.revision, take no property snapshot and only say whether
   * the project changed (`changes.unlisted`). Older AE versions get the full report.
   */
  checkOnly?: boolean;
  /** Undo group name; false = no undo group (read-only tools). */
  undoGroup?: string | false;
  /**
   * Undo this call in the same script, only if it changed something, and check the project is back
   * (`RunResult.rollback`). "changes": whenever it changed something (read-only mode); "requested": only
   * when the body returns `{ rollback: true }` (atomic batch). Needs an undo group.
   */
  rollback?: "changes" | "requested";
  /** Serialization depth for the returned value. */
  depth?: number;
  timeoutMs?: number;
  /** Bridge options: label for the AE panel log, approval request ("ask" mode), cancellation. */
  bridge?: EvalOptions;
}

export interface Changes {
  items: [string, string, string, unknown?][];
  layers: [string, string, string, string?][];
  /** [op, layer, property path, what changed, comp] */
  props: [string, string, string, (string | null)?, string?][];
  scope: string[];
  partial?: boolean;
  truncated?: boolean;
  error?: string;
  /** app.project.revision was used: properties weren't snapshotted after the call (they hadn't changed) */
  fast?: boolean;
  /** the project changed, but nothing was snapshotted to list what (checkOnly) */
  unlisted?: boolean;
}

/** What the guarded rollback did (aemcp.jsxinc). */
export interface Rollback {
  /** Edit > Undo was run once */
  undone: boolean;
  /**
   * true: nothing changed (not undone), or undone and the project is back to how it was before the call.
   * "sentinel": undone, and Surehand MCP's undo marker shows the Undo reverted the undo step it was in, with items
   * and layer attributes back as before, but property values were not compared (read-only check's light
   * snapshot), so a call that split its own undo group could still have left edits behind. Truthy: not a problem.
   */
  verified: boolean | "sentinel";
  /** with verified "sentinel": "values were not compared" */
  note?: string;
  /**
   * "unknown": couldn't tell whether the call changed anything, so nothing was undone;
   * "undo did nothing"; "not this call": Edit > Undo reverted something else than this call's undo step
   * (the call opened or closed undo groups itself; its sentinel was left behind and removed by hand);
   * "undo did nothing / not this call": the sentinel was untouched and this AE has no project.revision to
   * tell which;
   * "not back": still different after the undo (see `remaining`); "not checked...": undone but couldn't
   * compare; "no undo group"; "failed: ...".
   */
  problem?: string;
  /** what still differs from before the call, after the undo */
  remaining?: Changes;
  /** the name of the rollback's temporary folder (sentinel) when it couldn't be removed */
  leftover?: string;
}

export interface RunResult {
  ok: boolean;
  result?: unknown;
  /** app.project.revision after a call with an undo group (AE versions that have it) */
  revision?: number;
  /** the project's file after a call with an undo group ("" when unsaved) */
  projectFile?: string;
  changes?: Changes;
  rollback?: Rollback;
  logs: string[];
  error?: { message: string; name?: string; line?: number; user?: boolean };
  /** false: the call failed while "Allow Scripts to Write Files and Access Network" is off (formatResult may say so) */
  writeAccess?: false;
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
  const runOpts = { undoGroup: opts.undoGroup === undefined ? "Surehand MCP" : opts.undoGroup, depth: opts.depth, report: opts.report, checkOnly: opts.checkOnly || undefined, rollback: opts.rollback };
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
  if (/Illegal use of reserved word/i.test(m)) return 'ExtendScript (ES3) reserves words such as int, short, char, float, double, long, byte, boolean, class, default. Don\'t use them as names or as .property names (write o["default"]); ae_run_script renames declared names automatically unless transpile is false.';
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
  // defaults from the tool call: label for the AE panel log, and the AI app's cancel signal
  const ctx = callContext.getStore();
  opts = { ...opts, bridge: { label: ctx?.tool, cancel: ctx?.signal, ...opts.bridge } };
  // the approval prompt in After Effects names the AI app that asks
  if (opts.bridge?.approval && ctx?.client && !opts.bridge.approval.client) opts.bridge = { ...opts.bridge, approval: { ...opts.bridge.approval, client: ctx.client } };
  if (opts.bridge?.approval) {
    // make sure the helpers are loaded first, so the user is asked to approve only once
    const probe = await evalRaw(`(typeof aemcp !== 'undefined' && aemcp.version === ${toJsLiteral(HELPER_VERSION)}) ? 'ok' : 'no'`, 10_000, { cancel: opts.bridge.cancel });
    if (probe !== "ok") await ensureHelpers();
  }
  let raw = await evalRaw(script, opts.timeoutMs, opts.bridge);
  if (raw === NEED_HELPERS) {
    await ensureHelpers();
    raw = await evalRaw(script, opts.timeoutMs, opts.bridge);
  }
  const res = parseResult(raw);
  // for the activity log: the undo step this call made and the revision after it (the panel's Undo)
  if (ctx && opts.undoGroup !== false && opts.undoGroup !== "") {
    ctx.last = {
      undoGroup: typeof opts.undoGroup === "string" && opts.undoGroup ? opts.undoGroup : "Surehand MCP",
      ...(typeof res.revision === "number" ? { revision: res.revision } : {}),
      ...(typeof res.projectFile === "string" ? { project: res.projectFile } : {}),
    };
    ctx.undoSteps = (ctx.undoSteps ?? 0) + 1;
  }
  return res;
}

/** The change report as short, readable lines. */
export function formatChanges(ch: Changes | undefined): string | null {
  if (!ch) return null;
  if (ch.error) return `Changes: (could not be determined: ${ch.error})`;
  if (ch.unlisted) return "Changes: the project changed (not listed)";
  const lines: string[] = [];
  for (const [op, type, name, extra] of ch.items) {
    if (op === "+") {
      const e = extra as { layers: number; names: string[] } | number | undefined;
      const inside =
        typeof e === "object" && e ? ` (${e.layers} layer${e.layers === 1 ? "" : "s"}${e.names.length ? `: ${e.names.join(", ")}${e.layers > e.names.length ? ", ..." : ""}` : ""})` : typeof e === "number" ? ` (${e} layers)` : "";
      lines.push(`+ ${type} "${name}"${inside}`);
    }
    else if (op === "-") lines.push(`- ${type} "${name}"`);
    else if (type === "project") lines.push(`~ project settings: ${extra}`);
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

/**
 * What to tell the user when a guarded rollback isn't verified ("" when it is). `what` names the
 * call: "the script", "the batch".
 */
export function rollbackProblem(rb: Rollback, what: string): string {
  if (rb.verified) return "";
  const check = "Check the project before going on (Edit > Undo and Edit > Redo still work step by step).";
  const leftover = rb.leftover ? `\nA temporary folder "${rb.leftover}" (Surehand MCP's undo marker) couldn't be removed; it can be deleted.` : "";
  if (!rb.undone)
    return `It couldn't be checked whether ${what} changed the project${rb.problem && rb.problem !== "unknown" ? ` (${rb.problem})` : ""}, so nothing was undone. ${check}${leftover}`;
  const remaining = rb.remaining ? (formatChanges(rb.remaining) ?? "").replace(/^Changes[^\n]*:\n/, "") : "";
  const notBack = `the project still isn't how it was before ${what}:\n${remaining}`;
  if (rb.problem === "not this call" || rb.problem === "undo did nothing / not this call")
    return (
      `Edit > Undo was run once for ${what}, but the Undo did not revert ${what}'s changes as a whole ` +
      (rb.problem === "not this call"
        ? `(${what} may have opened or closed undo groups itself), `
        : `(After Effects either undid nothing or undid a different step; this version of After Effects can't tell which), `) +
      `${remaining ? `and ${notBack}` : "so some of its changes may still be in the project."}\n` +
      `The Undo was not repeated. ${check}${leftover}`
    );
  const why =
    rb.problem === "not back"
      ? notBack
      : rb.problem === "undo did nothing"
        ? "After Effects didn't undo anything."
        : `the result couldn't be checked (${rb.problem}).`;
  return `The undo step of ${what} was undone once, but ${why}\nIt was not undone again, so nothing else in the undo history was reverted. ${check}${leftover}`;
}
