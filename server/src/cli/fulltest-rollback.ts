// `ae-mcp selftest --full`: the guarded rollback of an atomic batch and of read-only mode, in a real
// After Effects. Each case first makes a "manual edit" in its own undo step (the user's last action)
// and checks it survives. Everything it creates is named __aemcp_fulltest_rb and removed by the full
// self-test's cleanup.
import { runJsx } from "../jsx.js";
import { runReadOnly } from "../tools/core.js";
import { runBatch } from "../tools/workflow.js";
import { sentinelsLeft } from "./fulltest-revision.js";
import { warn } from "./util.js";

export interface RollbackStep { step: string; ok: boolean; ms: number; error?: string }

const P = "__aemcp_fulltest_rb";
const OP = `var c = null; for (var i = 1; i <= app.project.numItems; i++) if (app.project.item(i).name === "${P}") c = app.project.item(i);
var op = c.layer(1).property("ADBE Transform Group").property("ADBE Opacity");`;
const FULL = { mode: "full", allowShell: false };

async function state(): Promise<{ opacity: number; revision: number | null }> {
  const r = await runJsx(`${OP} return { opacity: op.value, revision: aemcp.revision() };`, {}, { undoGroup: false });
  if (!r.ok) throw new Error(`couldn't read the test comp: ${r.error?.message}`);
  return r.result as { opacity: number; revision: number | null };
}

/** The user's last action: Opacity -> value, as an undo step of its own. */
async function manualEdit(value: number) {
  const r = await runJsx(`${OP} op.setValue(args.value); return 1;`, { value }, { undoGroup: "Surehand MCP self-test: manual edit" });
  if (!r.ok) throw new Error(`manual edit failed: ${r.error?.message}`);
}

const text = (r: { content: unknown[] }) => (r.content[0] as { text?: string })?.text ?? "";
const script = (code: string) => ({ tool: "ae_run_script", args: { code } });
const readOnly = async (code: string) => (await runReadOnly(code)).refusal;

export async function rollbackSteps(say: (ok: boolean, line: string) => void): Promise<RollbackStep[]> {
  const out: RollbackStep[] = [];
  const step = async (name: string, fn: () => Promise<string | null>) => {
    const t0 = Date.now();
    let problem: string | null;
    try {
      problem = await fn();
    } catch (e: any) {
      problem = e.message;
    }
    const ms = Date.now() - t0;
    out.push({ step: name, ok: !problem, ms, error: problem ?? undefined });
    say(!problem, problem ? `${name}: ${problem}` : `${name} (${ms} ms)`);
  };
  // undo-stress cases (see fulltest-revision.ts): only with AEMCP_SELFTEST_UNDO_STRESS=1
  const skipStress = async (name: string, _fn: () => Promise<string | null>) => warn(`${name}: skipped (undo-stress case; can crash After Effects; run with AEMCP_SELFTEST_UNDO_STRESS=1)`);
  // every case: the rollback's temporary folder (sentinel) never stays in the project
  const clean = async (problem: string | null) => problem ?? ((await sentinelsLeft()) ? `the rollback's temporary folder was left: ${await sentinelsLeft()}` : null);

  await step("rollback: set up", async () => {
    const r = await runJsx(`var c = app.project.items.addComp("${P}", 640, 360, 1, 4, 25); c.layers.addSolid([0.2, 0.4, 0.6], "${P} solid", 64, 64, 1); return 1;`, {}, { undoGroup: "Surehand MCP self-test" });
    return r.ok ? null : `couldn't create the test comp: ${r.error?.message}`;
  });

  await step("rollback: manual edit, then an atomic batch that fails at step 1: the manual edit survives", async () => {
    await manualEdit(37);
    const before = await state();
    const r = await runBatch({ steps: [script('throw new Error("fails before changing anything")'), script(`${OP} op.setValue(5);`)] }, FULL);
    const after = await state();
    if (!/nothing to undo/.test(text(r))) return `unexpected reply: ${text(r)}`;
    if (after.opacity !== 37) return `the manual edit was reverted: Opacity is ${after.opacity}, expected 37`;
    if (before.revision !== null && after.revision !== before.revision) return `the undo stack was touched (revision ${before.revision} -> ${after.revision})`;
    return null;
  });

  await step("rollback: atomic batch that edits, then fails at step 2: rolled back once, the manual edit survives", async () => {
    await manualEdit(41);
    const r = await runBatch({ steps: [script(`${OP} op.setValue(5);`), script('throw new Error("fails after an edit")')], name: "Surehand MCP self-test batch" }, FULL);
    const after = await state();
    if (!/was rolled back \(nothing changed\)/.test(text(r))) return `unexpected reply: ${text(r)}`;
    return clean(after.opacity === 41 ? null : `Opacity is ${after.opacity}, expected 41 (5 = not rolled back, 100/37 = undone twice)`);
  });

  // AE may make no undo step for a group in which only an unchanged value was written (the revision still
  // moves): the rollback must undo the call's own step (its sentinel), never the manual edit
  await step("rollback: read-only script that writes Opacity's current value: the manual edit survives", async () => {
    await manualEdit(39);
    const refusal = await readOnly(`${OP} op.setValue(op.value); return 1;`);
    const after = await state();
    if (after.opacity !== 39) return `the manual edit was reverted: Opacity is ${after.opacity}, expected 39`;
    if (refusal && !/its changes were undone/.test(refusal)) return `unexpected reply: ${refusal}`;
    return clean(null);
  });

  await step("rollback: atomic batch that writes Opacity's current value, then fails: the manual edit survives", async () => {
    await manualEdit(40);
    const r = await runBatch({ steps: [script(`${OP} op.setValue(op.value);`), script('throw new Error("fails after a no-op write")')] }, FULL);
    const after = await state();
    if (after.opacity !== 40) return `the manual edit was reverted: Opacity is ${after.opacity}, expected 40`;
    if (!/was rolled back \(nothing changed\)|nothing to undo/.test(text(r))) return `unexpected reply: ${text(r)}`;
    return clean(null);
  });

  await step("rollback: read-only script that edits is reverted exactly once", async () => {
    await manualEdit(43);
    const refusal = await readOnly(`${OP} op.setValue(80); return 1;`);
    const after = await state();
    if (!refusal || !/its changes were undone/.test(refusal)) return `unexpected reply: ${refusal}`;
    return clean(after.opacity === 43 ? null : `Opacity is ${after.opacity}, expected 43 (80 = not reverted, 41 = undone twice)`);
  });

  await step("rollback: read-only script that only reads leaves the undo stack alone", async () => {
    await manualEdit(47);
    const before = await state();
    const refusal = await readOnly(`${OP} return op.value;`);
    const after = await state();
    if (refusal) return `refused a script that only reads: ${refusal}`;
    if (after.opacity !== 47) return `Opacity is ${after.opacity}, expected 47`;
    return before.revision !== null && after.revision !== before.revision ? `revision moved ${before.revision} -> ${after.revision}` : null;
  });

  await step("rollback: read-only script that closes its own undo group: refused, nothing ran", async () => {
    await manualEdit(53);
    const refusal = await readOnly(`${OP} op.setValue(80); app.endUndoGroup(); op.setValue(90); return 1;`);
    const after = await state();
    if (!refusal || !/^Nothing ran\./.test(refusal)) return `unexpected reply: ${refusal}`;
    return after.opacity === 53 ? null : `Opacity is ${after.opacity}, expected 53 (nothing ran)`;
  });

  // the same script with the call assembled at runtime, which the text check can't see: the rollback
  // is the backstop
  await (process.env.AEMCP_SELFTEST_UNDO_STRESS === "1" ? step : skipStress)("rollback: read-only script that closes its own undo group by an assembled name: reported, not undone again", async () => {
    await manualEdit(59);
    const refusal = await readOnly(`${OP} op.setValue(80); app["end" + "UndoGroup"](); op.setValue(90); return 1;`);
    const after = await state();
    if (!refusal || !/did not revert the script's changes as a whole/.test(refusal) || !/The Undo was not repeated/.test(refusal)) return `unexpected reply: ${refusal}`;
    // the sentinel lands outside the closed group: the one undo only reverts its rename, so Opacity stays 90
    // (80 = the script's last edit was undone, 59 = undone twice or the user's step)
    return clean(after.opacity === 90 ? null : `Opacity is ${after.opacity}, expected 90 (only the sentinel's rename undone)`);
  });

  // a script that ends its group and opens a new one (assembled names, past the text check): its first edit
  // stays in a closed undo step, the marker lands in the new group, and the one Undo reverts only that.
  // The light (read-only) snapshot can't compare values, so the reply must never claim they were compared.
  await (process.env.AEMCP_SELFTEST_UNDO_STRESS === "1" ? step : skipStress)("rollback: read-only script that splits its undo group (assembled end + begin): reported honestly, never claims values were compared", async () => {
    await manualEdit(61);
    const { refusal, r } = await runReadOnly(`${OP} op.setValue(80); app["end" + "UndoGroup"](); app["begin" + "UndoGroup"]("x"); return 1;`);
    const after = await state();
    if (!r) return `refused before it ran: ${refusal}`;
    say(true, `  split undo group: Opacity ${after.opacity} (61 = back, 80 = the closed step stayed); rollback: ${JSON.stringify(r.rollback)}; reply: ${refusal ?? "(none)"}`);
    const rb = r.rollback;
    if (!rb || !refusal) return `no rollback reported: ${refusal}`;
    if (rb.verified === true && after.opacity !== 61) return `claims verified, but Opacity is ${after.opacity} (expected 61): ${refusal}`;
    if (rb.verified === "sentinel" && !/property values were not compared/.test(refusal)) return `reply doesn't say values were not compared: ${refusal}`;
    if (!rb.verified && !/not repeated|not undone again|nothing was undone/.test(refusal)) return `unverified, and the reply doesn't say so: ${refusal}`;
    if (after.opacity !== 80 && after.opacity !== 61) return `Opacity is ${after.opacity}, expected 80 (closed step left) or 61 (back); anything else = more than the script was undone`;
    return clean(null);
  });

  // the marker (a folder added and renamed inside the call's undo group) must not change what the user
  // has selected in the Project panel or the active item (viewer)
  await step("rollback: the undo marker leaves the Project panel selection and the active item alone", async () => {
    const ui = async () => {
      const r = await runJsx(
        `var s = app.project.selection, ids = []; for (var i = 0; i < s.length; i++) ids.push(s[i].id);
return { selection: s.length, ids: ids.join(","), active: app.project.activeItem ? app.project.activeItem.id : null };`,
        {},
        { undoGroup: false },
      );
      if (!r.ok) throw new Error(`couldn't read the selection: ${r.error?.message}`);
      return r.result as { selection: number; ids: string; active: number | null };
    };
    // make both meaningful: the test comp open in the viewer and selected in the Project panel
    const set = await runJsx(`${OP} try { c.openInViewer(); } catch (e) {} try { c.selected = true; } catch (e) {} return 1;`, {}, { undoGroup: false });
    if (!set.ok) return `couldn't select the test comp: ${set.error?.message}`;
    await manualEdit(67);
    const before = await ui();
    const refusal = await readOnly(`${OP} op.setValue(80); return 1;`);
    const after = await ui();
    const st = await state();
    say(true, `  selection ${before.selection} [${before.ids}] -> ${after.selection} [${after.ids}]; active item ${before.active} -> ${after.active}`);
    if (!refusal || !/its changes were undone/.test(refusal)) return `unexpected reply: ${refusal}`;
    if (st.opacity !== 67) return `Opacity is ${st.opacity}, expected 67`;
    if (before.selection !== after.selection || before.ids !== after.ids) return `the rollback changed the Project panel selection: ${before.selection} [${before.ids}] -> ${after.selection} [${after.ids}]`;
    if (before.active !== after.active) return `the rollback changed the active item: ${before.active} -> ${after.active}`;
    return clean(null);
  });

  return out;
}
