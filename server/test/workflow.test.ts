import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalBody, formatChanges, runJsx, type RunResult } from "../src/jsx.js";
import { readOnlyRefusal, readOnlyRunOptions } from "../src/tools/core.js";
import { _internal, runBatch } from "../src/tools/workflow.js";
import { transpileUserCode } from "../src/transpile.js";
import { fakeAE, loadHelpers, type Fake } from "./fake-ae.js";

describe("checkpoints", () => {
  it("keeps a separate, stable folder per project file", () => {
    const a = _internal.projectDir("/work/Client A/Spot v3.aep");
    expect(a).toBe(_internal.projectDir("/work/Client A/Spot v3.aep"));
    expect(a).not.toBe(_internal.projectDir("/work/Client B/Spot v3.aep"));
    expect(a).toMatch(/Spot_v3-[0-9a-f]{8}$/);
  });
});

describe("script library scan", () => {
  it("finds scripts with their header description, marks panels, skips (support) folders", () => {
    const root = mkdtempSync(join(tmpdir(), "aemcp-scripts-"));
    mkdirSync(join(root, "ScriptUI Panels"));
    mkdirSync(join(root, "(support)"));
    writeFileSync(join(root, "Rename Layers.jsx"), "/*\n * Renames the selected layers.\n */\napp.beginUndoGroup('x');");
    writeFileSync(join(root, "ScriptUI Panels", "My Panel.jsx"), "// A dockable panel\nvar w = new Window('palette');");
    writeFileSync(join(root, "(support)", "helper.jsx"), "// internal");
    writeFileSync(join(root, "notes.txt"), "not a script");
    const found = _internal.scanScripts(root, "After Effects");
    const byName = Object.fromEntries(found.map((s: any) => [s.name, s]));
    expect(Object.keys(byName).sort()).toEqual(["My Panel", "Rename Layers"]);
    expect(byName["Rename Layers"].description).toBe("Renames the selected layers.");
    expect(byName["My Panel"].kind).toMatch(/panel/);
  });
});

describe("batch script", () => {
  it("the combined ExtendScript of several steps is valid ES3", async () => {
    const { ALL_JSX_TOOLS } = await import("../src/tools/all.js");
    const { parse } = await import("acorn");
    const pick = ["ae_create_comp", "ae_add_layer", "ae_set_keyframes", "ae_edit_keyframes", "ae_set_camera", "ae_add_text_animator"];
    const bodies = pick.map((n) => ALL_JSX_TOOLS.find((t) => t.name === n)!.jsx);
    const body = "var __steps = [\n" + bodies.map((b) => `function (args, log) {\n${b}\n}`).join(",\n") + "\n];";
    expect(() => parse(`(function(args, log){${body}\n})`, { ecmaVersion: 3, allowReserved: false })).not.toThrow();
  });
});

// ---------- guarded rollback (read-only mode, atomic batch) ----------
// The real helper library and tool code, run against a fake After Effects with an undo stack
// (test/fake-ae.ts). The bridge is replaced by a direct call into the fake.
let fake: Fake;
let helpers: any;
vi.mock("../src/bridge.js", async (original) => ({
  ...(await original<typeof import("../src/bridge.js")>()),
  evalRaw: async (script: string) => new Function("aemcp", "app", "return " + script)(helpers, fake.app),
}));

/** A fake AE where the user already made one edit (Opacity 100 -> 50): their last undo step. */
function withManualEdit(opts: Parameters<typeof fakeAE>[0] = {}) {
  fake = fakeAE(opts);
  helpers = loadHelpers(fake);
  fake.app.beginUndoGroup("user: opacity 50");
  fake.opacity.value = 50;
  fake.app.endUndoGroup();
}
const OP = "var op = app.project.item(1).layer(1).property(1).property(1);";
const opacity = () => {
  const n = fake.reads.n, v = fake.opacity.value;
  fake.reads.n = n;
  return v;
};

describe("guarded rollback in aemcp.run", () => {
  const run = (fn: () => unknown, opts: Record<string, unknown>): RunResult =>
    JSON.parse(helpers.run(fn, {}, { undoGroup: "AE MCP test", report: ["*"], ...opts }));

  it("a call that changed nothing leaves the undo stack alone (the user's last edit survives)", () => {
    withManualEdit();
    const r = run(() => fake.comp.name, { rollback: "changes", checkOnly: true });
    expect(r.rollback).toEqual({ undone: false, verified: true });
    expect(fake.undos.n).toBe(0);
    expect(opacity()).toBe(50);
    expect(fake.undoStack()).toEqual(["user: opacity 50"]);
  });

  it("a call that edited is undone exactly once and checked; the user's edit survives", () => {
    withManualEdit();
    const r = run(() => (fake.opacity.value = 20), { rollback: "changes" });
    expect(r.rollback).toEqual({ undone: true, verified: true });
    expect(fake.undos.n).toBe(1);
    expect(opacity()).toBe(50);
    expect(fake.undoStack()).toEqual(["user: opacity 50"]);
  });

  it("read-only fast path (no property snapshot): an edit is still undone once", () => {
    withManualEdit();
    const r = run(() => (fake.opacity.value = 20), { rollback: "changes", checkOnly: true });
    expect(r.changes?.unlisted).toBe(true);
    expect(r.rollback).toEqual({ undone: true, verified: true });
    expect(opacity()).toBe(50);
  });

  it("an edit that doesn't move the revision (label) is caught by the snapshot and undone", () => {
    withManualEdit();
    const r = run(() => (fake.comp.label = 5), { rollback: "changes", checkOnly: true });
    expect(r.rollback).toEqual({ undone: true, verified: true });
    expect(fake.comp.label).toBe(1);
    expect(opacity()).toBe(50);
  });

  it("a call that edited and then threw is undone too", () => {
    withManualEdit();
    const r = run(() => {
      fake.opacity.value = 20;
      throw new Error("boom");
    }, { rollback: "changes" });
    expect(r.ok).toBe(false);
    expect(r.rollback).toEqual({ undone: true, verified: true });
    expect(opacity()).toBe(50);
  });

  it("AE without app.project.revision: decided and checked by the snapshot alone", () => {
    withManualEdit({ revision: false });
    expect(run(() => 1, { rollback: "changes" }).rollback).toEqual({ undone: false, verified: true });
    const r = run(() => (fake.opacity.value = 20), { rollback: "changes" });
    expect(r.rollback).toEqual({ undone: true, verified: true });
    expect(opacity()).toBe(50);
  });

  it('"requested": only when the call asks for it', () => {
    withManualEdit();
    const kept = run(() => ((fake.opacity.value = 20), { rollback: false }), { rollback: "requested" });
    expect(kept.rollback).toBeUndefined();
    expect(opacity()).toBe(20);
    const back = run(() => ((fake.opacity.value = 30), { rollback: true }), { rollback: "requested" });
    expect(back.rollback).toEqual({ undone: true, verified: true });
    expect(opacity()).toBe(20);
  });

  it("a call that closed its own undo group early: undone once, not back, reported, not undone again", () => {
    withManualEdit();
    const r = run(() => {
      fake.opacity.value = 20;
      fake.app.endUndoGroup(); // closes the call's group: the next edit is an undo step of its own
      fake.opacity.value = 30;
    }, { rollback: "changes" });
    expect(fake.undos.n).toBe(1);
    expect(r.rollback?.undone).toBe(true);
    expect(r.rollback?.verified).toBe(false);
    expect(r.rollback?.problem).toBe("not back");
    expect(formatChanges(r.rollback?.remaining)).toContain("Opacity: 50 -> 20");
    expect(fake.undoStack()).toEqual(["user: opacity 50", "AE MCP test"]); // the user's step is still there
  });

  it("Edit > Undo that does nothing is reported", () => {
    withManualEdit({ undoWorks: false });
    const r = run(() => (fake.opacity.value = 20), { rollback: "changes" });
    expect(r.rollback).toMatchObject({ undone: true, verified: false, problem: "undo did nothing" });
  });

  it("can't tell whether anything changed (no revision, no snapshot): nothing is undone", () => {
    withManualEdit({ revision: false });
    const r = run(() => (fake.opacity.value = 20), { rollback: "changes", report: undefined });
    expect(r.rollback).toEqual({ undone: false, verified: false, problem: "unknown" });
    expect(fake.undos.n).toBe(0);
  });

  it("no undo group: nothing to roll back to, nothing is undone", () => {
    withManualEdit();
    const r = run(() => (fake.opacity.value = 20), { rollback: "changes", undoGroup: false });
    expect(r.rollback).toMatchObject({ undone: false, verified: false, problem: "no undo group" });
    expect(fake.undos.n).toBe(0);
  });
});

describe("ae_batch: atomic rollback", () => {
  const full = { mode: "full", allowShell: false };
  const script = (code: string) => ({ tool: "ae_run_script", args: { code } });
  const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

  it("fails at step 1 before changing anything: the undo stack isn't touched, the user's edit survives", async () => {
    withManualEdit();
    const r = await runBatch({ steps: [script('throw new Error("no such layer")'), script(`${OP} op.setValue(10);`)] }, full);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Batch stopped at step 1 of 2. It hadn't changed anything yet, so there was nothing to undo.");
    expect(fake.undos.n).toBe(0);
    expect(opacity()).toBe(50);
    expect(fake.undoStack()).toEqual(["user: opacity 50"]);
  });

  it("fails at step 2 after step 1 edited: rolled back once, checked, the user's edit survives", async () => {
    withManualEdit();
    const r = await runBatch({ steps: [script(`${OP} op.setValue(10);`), script('throw new Error("boom")')] }, full);
    expect(text(r)).toContain("Batch stopped at step 2 of 2 and was rolled back (nothing changed).");
    expect(text(r)).toContain("Opacity: 50 -> 10");
    expect(fake.undos.n).toBe(1);
    expect(opacity()).toBe(50);
    expect(fake.undoStack()).toEqual(["user: opacity 50"]);
  });

  it("a rollback that can't be verified is reported and not undone again", async () => {
    withManualEdit();
    const r = await runBatch({ steps: [script(`${OP} op.setValue(10); app.endUndoGroup(); op.setValue(20);`), script('throw new Error("boom")')] }, full);
    expect(text(r)).toContain("The undo step of the batch was undone once, but the project still isn't how it was before the batch");
    expect(text(r)).toContain("It was not undone again");
    expect(fake.undos.n).toBe(1);
    expect(opacity()).toBe(10);
  });

  it("atomic: false keeps the successful steps and never undoes", async () => {
    withManualEdit();
    const r = await runBatch({ steps: [script(`${OP} op.setValue(10);`), script('throw new Error("boom")')], atomic: false }, full);
    expect(text(r)).toContain("Batch finished with errors");
    expect(fake.undos.n).toBe(0);
    expect(opacity()).toBe(10);
  });

  it("a batch that succeeds isn't undone", async () => {
    withManualEdit();
    const r = await runBatch({ steps: [script(`${OP} op.setValue(10);`)] }, full);
    expect(r.isError).toBeUndefined();
    expect(fake.undos.n).toBe(0);
    expect(opacity()).toBe(10);
  });
});

describe("ae_run_script in read-only mode", () => {
  const readOnly = async (code: string) => {
    const r = await runJsx(evalBody(transpileUserCode(code).source), {}, readOnlyRunOptions(code));
    return { r, refusal: readOnlyRefusal(r) };
  };

  it("a script that only reads: no refusal, nothing undone", async () => {
    withManualEdit();
    const { refusal } = await readOnly(`${OP} return op.value;`);
    expect(refusal).toBeNull();
    expect(fake.undos.n).toBe(0);
    expect(opacity()).toBe(50);
  });

  it("a script that edits is reverted exactly once; the user's edit survives", async () => {
    withManualEdit();
    const { refusal } = await readOnly(`${OP} op.setValue(80); return 1;`);
    expect(refusal).toMatch(/read-only/i);
    expect(refusal).toContain("This script changed the project, so its changes were undone.");
    expect(fake.undos.n).toBe(1);
    expect(opacity()).toBe(50);
    expect(fake.undoStack()).toEqual(["user: opacity 50"]);
  });

  it("a script that touches the undo stack gets the full comparison, so a partial undo is caught", async () => {
    expect(readOnlyRunOptions("return app.project.numItems;")).toMatchObject({ checkOnly: true, rollback: "changes", report: ["*"] });
    for (const code of ["app.endUndoGroup();", "app.beginUndoGroup('x');", "app.executeCommand(16);", "app.purge(PurgeTarget.UNDO_CACHES);"])
      expect(readOnlyRunOptions(code).checkOnly).toBe(false);
    withManualEdit();
    const { refusal } = await readOnly(`${OP} op.setValue(80); app.endUndoGroup(); op.setValue(90); return 1;`);
    expect(refusal).toContain("the project still isn't how it was before the script");
    expect(refusal).toContain("Opacity: 50 -> 80");
    expect(refusal).toContain("It was not undone again");
    expect(fake.undos.n).toBe(1);
  });
});

describe("no blind Edit > Undo", () => {
  it("read-only mode and ae_batch don't send Edit > Undo themselves (aemcp.run does, guarded)", () => {
    for (const f of ["core.ts", "workflow.ts"]) expect(readFileSync(new URL(`../src/tools/${f}`, import.meta.url), "utf8")).not.toMatch(/executeCommand\(16\)/);
  });
});
