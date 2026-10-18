// `ae-mcp selftest --full`: the read-only check and change report with app.project.revision (fast path),
// plus a timing of a read-only query on a project with many comps, fast path vs the full snapshot.
// Everything it creates is named __aemcp_fulltest_rev* and removed by the full self-test's cleanup.
import { evalBody, formatChanges, runJsx, type RunOptions, type RunResult } from "../jsx.js";

export interface RevisionStep { step: string; ok: boolean; ms: number; error?: string; skipped?: boolean; bench?: Record<string, number> }

const P = "__aemcp_fulltest_rev";
const COMPS = 30;
const LAYERS = 12;
// what ae_run_script sends in read-only mode (core.ts)
const READ_ONLY: RunOptions = { undoGroup: "AE MCP Script (read-only check)", report: ["*"], checkOnly: true, timeoutMs: 300_000 };
const user = (code: string) => evalBody(`(function(args, log){${code}\n})`);
const findComp = `var c = null; for (var i = 1; i <= app.project.numItems; i++) if (app.project.item(i).name === "${P}") c = app.project.item(i);`;

export async function revisionSteps(features: Record<string, unknown>, say: (ok: boolean, line: string) => void): Promise<RevisionStep[]> {
  const fast = !!features.revision;
  const out: RevisionStep[] = [];
  const step = async (name: string, fn: () => Promise<string | null>, bench?: Record<string, number>) => {
    const t0 = Date.now();
    let problem: string | null;
    try {
      problem = await fn();
    } catch (e: any) {
      problem = e.message;
    }
    const ms = Date.now() - t0;
    out.push({ step: name, ok: !problem, ms, error: problem ?? undefined, bench });
    say(!problem, problem ? `${name}: ${problem}` : `${name} (${ms} ms)${bench ? ": " + Object.entries(bench).map(([k, v]) => `${k} ${v} ms`).join(", ") : ""}`);
  };
  const check = (r: RunResult) => (r.ok ? null : `script failed: ${r.error?.message}`);

  await step(`build ${COMPS} comps x ${LAYERS} layers`, async () => {
    const r = await runJsx(
      `for (var k = 0; k < args.comps; k++) {
  var c = app.project.items.addComp(k ? "${P}_" + k : "${P}", 1280, 720, 1, 4, 25);
  for (var j = 0; j < args.layers; j++) {
    var L = c.layers.addShape(); L.name = "S" + j;
    L.property("ADBE Root Vectors Group").addProperty("ADBE Vector Shape - Ellipse");
    L.property("ADBE Effect Parade").addProperty("ADBE Gaussian Blur 2");
    L.property("ADBE Transform Group").property("ADBE Position").setValueAtTime(1, [j, j]);
  }
}
return app.project.numItems;`,
      { comps: COMPS, layers: LAYERS },
      { undoGroup: "AE MCP self-test", timeoutMs: 300_000 },
    );
    return check(r);
  });

  await step("read-only check: a script that only reads", async () => {
    const r = await runJsx(user("var n = 0; for (var i = 1; i <= app.project.numItems; i++) n += app.project.item(i).name.length; return n;"), {}, READ_ONLY);
    if (!r.ok) return check(r);
    if (formatChanges(r.changes) !== "Changes: none") return `reported ${formatChanges(r.changes)}`;
    return fast && !r.changes?.fast ? "app.project.revision is available but the fast path wasn't used" : null;
  });

  await step("read-only check: catches a property edit", async () => {
    const r = await runJsx(user(`${findComp} c.layer(1).property("ADBE Transform Group").property("ADBE Opacity").setValue(40); return 1;`), {}, READ_ONLY);
    if (!r.ok) return check(r);
    const text = formatChanges(r.changes);
    if (fast) return r.changes?.unlisted ? null : `expected "the project changed (not listed)", got ${text}`;
    return /Opacity: 100 -> 40/.test(text ?? "") ? null : `the edit wasn't listed: ${text}`;
  });

  // app.project.revision doesn't move for these: the item/layer attributes are still compared
  await step("read-only check: catches a label and comment change", async () => {
    const r = await runJsx(user(`${findComp} c.label = 5; c.comment = "x"; return 1;`), {}, READ_ONLY);
    if (!r.ok) return check(r);
    const text = formatChanges(r.changes) ?? "";
    return /label/.test(text) && /comment/.test(text) ? null : `not reported: ${text}`;
  });

  // a read-only query on a project with many comps, the way ae_run_script runs it (median of 3)
  const bench: Record<string, number> = {};
  await step(
    `read-only query on ${COMPS + 1}+ comps: fast path vs full snapshot`,
    async () => {
      const query = user("var n = 0; for (var i = 1; i <= app.project.numItems; i++) n += app.project.item(i).name.length; return n;");
      const time = async (opts: RunOptions) => {
        const xs: number[] = [];
        for (let i = 0; i < 3; i++) {
          const t0 = Date.now();
          const r = await runJsx(query, {}, opts);
          if (!r.ok) throw new Error(`query failed: ${r.error?.message}`);
          xs.push(Date.now() - t0);
        }
        return xs.sort((a, b) => a - b)[1];
      };
      bench.fullSnapshot = await time({ ...READ_ONLY, checkOnly: false });
      bench.readOnly = await time(READ_ONLY);
      bench.noReport = await time({ undoGroup: false });
      return null;
    },
    bench,
  );
  return out;
}
