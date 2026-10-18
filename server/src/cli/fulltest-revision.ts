// `ae-mcp selftest --full`: the read-only check and change report with app.project.revision (fast path),
// whether read-only mode's rollback only ever reverts the script (never the user's last edit),
// plus a timing of a read-only query on a project with many comps, fast path vs the full snapshot.
// Everything it creates is named __aemcp_fulltest_rev* and removed by the full self-test's cleanup.
import { evalRaw } from "../bridge.js";
import { evalBody, formatChanges, runJsx, type RunOptions, type RunResult } from "../jsx.js";
import { runReadOnly } from "../tools/core.js";

export interface RevisionStep { step: string; ok: boolean; ms: number; error?: string; skipped?: boolean; bench?: Record<string, number>; note?: string }

const P = "__aemcp_fulltest_rev";
const COMPS = 30;
const LAYERS = 12;
// what ae_run_script sends in read-only mode (core.ts)
const READ_ONLY: RunOptions = { undoGroup: "AE MCP Script (read-only check)", report: ["*"], checkOnly: true, timeoutMs: 300_000 };
const user = (code: string) => evalBody(`(function(args, log){${code}\n})`);
const findComp = `var c = null; for (var i = 1; i <= app.project.numItems; i++) if (app.project.item(i).name === "${P}") c = app.project.item(i);`;
const U = `${P}_undo`;
const UNDO = 16;
const REDO = 2035;

export async function revisionSteps(features: Record<string, unknown>, say: (ok: boolean, line: string) => void): Promise<RevisionStep[]> {
  const fast = !!features.revision;
  const out: RevisionStep[] = [];
  let note: string | undefined; // what a step saw, kept in the report even when it passes
  const step = async (name: string, fn: () => Promise<string | null>, bench?: Record<string, number>) => {
    const t0 = Date.now();
    let problem: string | null;
    try {
      problem = await fn();
    } catch (e: any) {
      problem = e.message;
    }
    const ms = Date.now() - t0;
    out.push({ step: name, ok: !problem, ms, error: problem ?? undefined, bench, note });
    note = undefined;
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

  // Read-only mode refuses, before it runs, a script that calls the undo stack (executeCommand,
  // begin/endUndoGroup, purge), and undoes any other script that changed the project, in the same call
  // (aemcp.run's guarded rollback). Neither may revert the user's earlier edits. Each case has its own
  // comp (made as its own undo step), then a "user" rename as another undo step, then the read-only
  // script through ae_run_script's read-only path; afterwards the layer must be exactly as the user left it.
  let k = 0;
  // `refused`: must be refused before it runs. `assembled`: a call the text check can't see; the project must
  // be back, or the reply must say it isn't, with nothing undone twice (only the script's own Undo of the
  // user's rename). What happened is printed either way.
  const undoSafe = (name: string, script: string, opts: { userUndoes?: boolean; refused?: boolean; assembled?: boolean } = {}) =>
    step(`read-only undo keeps the user's last edit: ${name}`, async () => {
      const comp = `${U}_${++k}`;
      const findLayer = `var c = null; for (var i = 1; i <= app.project.numItems; i++) if (app.project.item(i).name === "${comp}") c = app.project.item(i); var L = c && c.layer(1);`;
      const edit = async (code: string, label: string) => {
        const r = await runJsx(code, {}, { undoGroup: `AE MCP self-test: ${label}` });
        if (!r.ok) throw new Error(`${label} failed: ${r.error?.message}`);
      };
      const state = async () => {
        const r = await runJsx(`${findLayer} return L ? [L.name, L.opacity.value, L.rotation.value].join(" | ") : "the test comp is gone";`, {}, { undoGroup: false });
        if (!r.ok) throw new Error(`couldn't read the test layer: ${r.error?.message}`);
        return String(r.result);
      };
      await edit(`app.project.items.addComp("${comp}", 320, 180, 1, 4, 25).layers.addSolid([1, 0, 0], "solid", 320, 180, 1); return 1;`, "make comp");
      await edit(`${findLayer} L.name = "user rename 1"; return 1;`, "user rename");
      if (opts.userUndoes) {
        // a second rename that the user undoes: Redo would bring it back
        await edit(`${findLayer} L.name = "user rename 2"; return 1;`, "user rename");
        await evalRaw(`app.executeCommand(${UNDO}); 1`, 30_000);
      }
      const before = await state();
      if (!before.startsWith("user rename 1 |")) return `setup didn't leave the user's rename: ${before}`;
      const { refusal, r } = await runReadOnly(`${findLayer}\n${script}\nreturn L ? L.name : null;`, 300_000);
      const after = await state();
      if (opts.refused) {
        if (r) return `not refused: the script ran (layer name ${r.result}); ${refusal ? `then: ${refusal}` : "no refusal"}; before: ${before}; after: ${after}`;
        if (!/^Nothing ran\./.test(refusal ?? "")) return `unexpected reply: ${refusal}`;
        return after === before ? null : `refused, but the layer changed: before ${before}; after ${after}`;
      }
      if (!r) return `refused, but the script doesn't call the undo stack: ${refusal}`;
      if (opts.assembled) {
        note = `the script saw layer name ${r.result}; before: ${before}; after: ${after}; rollback: ${JSON.stringify(r.rollback)}; reply: ${refusal ?? "(none)"}`;
        say(true, `  ${name}: ${note}`);
        if (after === before) return null;
        if (after !== before.replace(/^user rename 1/, "solid")) return `the project isn't back and more than the script's own Undo changed it: before ${before}; after ${after}`;
        return refusal && /not undone again|nothing was undone/.test(refusal) ? null : `the project isn't back and the reply doesn't say so: ${refusal}`;
      }
      if (after !== before) return `before the script: ${before}; after the ${refusal ? "refusal and Undo" : "script (not refused)"}: ${after}`;
      return null;
    });

  await undoSafe("script calls Edit > Undo", `app.executeCommand(${UNDO});`, { refused: true });
  await undoSafe("script calls Edit > Redo", `app.executeCommand(${REDO});`, { userUndoes: true, refused: true });
  await undoSafe("script sets a property to its current value", "L.opacity.setValue(L.opacity.value);");
  await undoSafe("script ends the undo group early, then edits", "app.endUndoGroup(); L.opacity.setValue(33);", { refused: true });
  await undoSafe("script edits, ends the undo group, edits again", "L.opacity.setValue(33); app.endUndoGroup(); L.rotation.setValue(10);", { refused: true });
  await undoSafe("script only ends the undo group early", "app.endUndoGroup();", { refused: true });
  await undoSafe("script calls Edit > Undo by an assembled name", `app["execute" + "Command"](${UNDO});`, { assembled: true });

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
