// `ae-mcp selftest --full`: 1.3.4 regression cases not covered by the revision and rollback steps:
// ES3 reserved words as names (T1), a full-mode edit still reports its changes with the fast path on
// (T2), and a frame preview never overwrites an existing file (T4b; Save As and checkpoint restore are
// checked by projectSafetyTests in fulltest.ts).
//
// These drive the real MCP tool handlers (in-memory client) and then check the result through a separate
// channel (plain runJsx reads, node:fs), never the tool's own report. Everything they create is named
// __aemcp_fulltest_134* and removed by the full self-test's cleanup.
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { VERSION } from "../config.js";
import { runJsx } from "../jsx.js";
import { permissions } from "../permissions.js";
import { ALL_JSX_TOOLS } from "../tools/all.js";
import { registerCoreTools } from "../tools/core.js";
import { registerJsxTools } from "../tools/registry.js";
import { warn } from "./util.js";

export interface RegressionStep { step: string; ok: boolean; ms: number; error?: string; skipped?: boolean }

const P = "__aemcp_fulltest_134";
type Call = (name: string, args: Record<string, unknown>) => Promise<{ isError: boolean; text: string }>;

async function connect(): Promise<Call> {
  const server = new McpServer({ name: "selftest", version: VERSION });
  registerCoreTools(server);
  registerJsxTools(server, ALL_JSX_TOOLS);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "selftest", version: VERSION });
  await Promise.all([server.connect(b), client.connect(a)]);
  return async (name, args) => {
    const r: any = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
    return { isError: !!r.isError, text: (r.content || []).map((c: any) => c.text ?? "").join("\n") };
  };
}

/** Read project state with a plain script: the independent channel for every verdict below. */
async function peek(code: string): Promise<any> {
  const r = await runJsx(code, {}, { undoGroup: false });
  if (!r.ok) throw new Error(`verifier script failed: ${r.error?.message}`);
  return r.result;
}
const countNamed = (name: string) =>
  peek(`var n = 0; for (var i = 1; i <= app.project.numItems; i++) if (app.project.item(i).name === ${JSON.stringify(name)}) n++; return n;`) as Promise<number>;

const NAMES = [
  "T1 reserved words as names (int, short, byte, default, class)",
  "T1 reserved words: error line numbers still match the user's code",
  "T2 an editing script still reports its changes",
  "T4b ae_render_frame refuses to overwrite an existing outputPath",
];

export async function regressionSteps(tmpDir: string, say: (ok: boolean, line: string) => void): Promise<RegressionStep[]> {
  // the tool handlers follow the user's permissions; these cases need them to run and edit without asking
  const mode = permissions().mode;
  if (mode !== "full") {
    for (const n of NAMES) warn(`${n}: skipped (permissions mode is "${mode}"; these cases need "full")`);
    return NAMES.map((step) => ({ step, ok: true, ms: 0, skipped: true }));
  }

  const out: RegressionStep[] = [];
  const step = async (name: string, fn: () => Promise<string | null>) => {
    const t0 = Date.now();
    let problem: string | null;
    try {
      problem = await fn();
    } catch (e: any) {
      problem = e?.message ?? String(e);
    }
    const ms = Date.now() - t0;
    out.push({ step: name, ok: !problem, ms, error: problem ?? undefined });
    say(!problem, problem ? `${name}: ${problem}` : `${name} (${ms} ms)`);
  };

  let call: Call;
  try {
    call = await connect();
  } catch (e: any) {
    const error = `couldn't start the in-process tool server: ${e?.message ?? e}`;
    say(false, `1.3.4 regression cases: ${error}`);
    return [{ step: "1.3.4 regression cases", ok: false, ms: 0, error }];
  }

  // ---- T1: ES3 reserved words as names, through ae_run_script ----
  await step(NAMES[0], async () => {
    const code = "const int = 1; function short() { return 2; } const f = (byte) => byte; const o = {}; o.default = 4; const g = { class: 5 }; return [int, short(), f(3), o.default, g.class];";
    const r = await call("ae_run_script", { code, report: false });
    if (r.isError) return `ae_run_script failed: ${r.text.slice(0, 300)}`;
    return r.text.trim() === "[1,2,3,4,5]" ? null : `expected [1,2,3,4,5], got ${r.text.slice(0, 200)}`;
  });
  await step(NAMES[1], async () => {
    const r = await call("ae_run_script", { code: "const int = 1;\nconst short = 2;\nthrow new Error('boom ' + (int + short));", report: false });
    return r.isError && /boom 3/.test(r.text) && /\(line 3\)|>\s*3 \|/.test(r.text) ? null : `expected an error 'boom 3' on line 3, got: ${r.text.slice(0, 300)}`;
  });

  // ---- T2: the revision fast path must not hide a real edit in full mode ----
  await step(NAMES[2], async () => {
    const name = `${P}_reported`;
    const rev0 = await peek("return app.project.revision === undefined ? null : app.project.revision;");
    const r = await call("ae_run_script", { code: `app.project.items.addFolder(${JSON.stringify(name)}); return 1;` });
    const made = await countNamed(name);
    const rev1 = await peek("return app.project.revision === undefined ? null : app.project.revision;");
    if (r.isError || made !== 1) return `edit did not run (found ${made}): ${r.text.slice(0, 200)}`;
    return /^Changes( \([^)]*\))?:\s*\n\+ folder /m.test(r.text) && !/Changes: none/.test(r.text) ? null : `the edit wasn't reported (revision ${rev0} -> ${rev1}, items ${await peek("return app.project.numItems;")}): ${JSON.stringify(r.text.slice(0, 300))}`;
  });

  // ---- T4b: a frame preview never overwrites an existing file ----
  await step(NAMES[3], async () => {
    const comp = `${P}_frame`;
    const made = await runJsx(`app.project.items.addComp(args.name, 320, 180, 1, 1, 25); return true;`, { name: comp }, { undoGroup: "AE MCP self-test" });
    if (!made.ok) return `couldn't create the test comp: ${made.error?.message}`;
    const file = join(tmpDir, `${P}_frame.png`);
    const keep = "DO-NOT-OVERWRITE";
    writeFileSync(file, keep);
    try {
      const r = await call("ae_render_frame", { comp, time: 0, outputPath: file });
      if (!r.isError) return `outputPath over an existing file was not refused: ${r.text.slice(0, 200)}`;
      if (!/overwrite: true/.test(r.text)) return `refusal does not say to pass overwrite: true: ${r.text.slice(0, 200)}`;
      return readFileSync(file, "utf8") === keep ? null : "the existing file was changed";
    } finally {
      try {
        unlinkSync(file);
      } catch {}
    }
  });

  return out;
}
