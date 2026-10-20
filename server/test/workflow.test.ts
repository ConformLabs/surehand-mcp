import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalBody, formatChanges, rollbackProblem, runJsx, type RunResult } from "../src/jsx.js";
import { READ_ONLY_RUN_OPTIONS, READ_ONLY_STILL_RUNNING, readOnlyBlockedCalls, readOnlyRefusal, readOnlyScriptRefusal, registerCoreTools } from "../src/tools/core.js";
import { BridgeError, explainBlocked } from "../src/bridge.js";
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
/** when set, the bridge throws it instead of running the script (a timeout, a cancel) */
let bridgeError: Error | null = null;
vi.mock("../src/bridge.js", async (original) => ({
  ...(await original<typeof import("../src/bridge.js")>()),
  evalRaw: async (script: string) => {
    if (bridgeError) throw bridgeError;
    return new Function("aemcp", "app", "return " + script)(helpers, fake.app);
  },
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
    JSON.parse(helpers.run(fn, {}, { undoGroup: "Surehand MCP test", report: ["*"], ...opts }));

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
    // the marker shows the Undo reverted the call's step, but values weren't compared: never "true"
    expect(r.rollback).toEqual({ undone: true, verified: "sentinel", note: "values were not compared" });
    expect(opacity()).toBe(50);
  });

  it("an edit that doesn't move the revision (label) is caught by the snapshot and undone", () => {
    withManualEdit();
    const r = run(() => (fake.comp.label = 5), { rollback: "changes", checkOnly: true });
    expect(r.rollback).toEqual({ undone: true, verified: "sentinel", note: "values were not compared" });
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

  it("a call that closed its own undo group early: the sentinel shows the undo missed it; reported, not undone again", () => {
    withManualEdit();
    const r = run(() => {
      fake.opacity.value = 20;
      fake.app.endUndoGroup(); // closes the call's group: the next edits (and the sentinel) are undo steps of their own
      fake.opacity.value = 30;
    }, { rollback: "changes" });
    expect(fake.undos.n).toBe(1); // it only reverted the sentinel's rename
    expect(r.rollback?.undone).toBe(true);
    expect(r.rollback?.verified).toBe(false);
    expect(r.rollback?.problem).toBe("not this call");
    expect(formatChanges(r.rollback?.remaining)).toContain("Opacity: 50 -> 30");
    expect(formatChanges(r.rollback?.remaining)).not.toContain("__aemcp_rollback");
    expect(opacity()).toBe(30);
    expect(fake.folders()).toEqual([]); // the sentinel was removed by hand
    expect(fake.undoStack().slice(0, 2)).toEqual(["user: opacity 50", "Surehand MCP test"]); // the user's step is still there
  });

  it("the same with the light (read-only) snapshot, which can't compare values: still caught by the sentinel", () => {
    withManualEdit();
    const r = run(() => {
      fake.opacity.value = 20;
      fake.app.endUndoGroup();
      fake.opacity.value = 30;
    }, { rollback: "changes", checkOnly: true });
    expect(r.rollback).toMatchObject({ undone: true, verified: false, problem: "not this call" });
    expect(fake.undos.n).toBe(1);
    expect(fake.folders()).toEqual([]);
  });

  it("a value written unchanged (revision moves, no undo step): only the call is undone, the user's edit survives", () => {
    withManualEdit();
    const r = run(() => (fake.opacity.value = fake.opacity.value), { rollback: "changes", checkOnly: true });
    expect(r.rollback).toEqual({ undone: true, verified: "sentinel", note: "values were not compared" });
    expect(fake.undos.n).toBe(1);
    expect(opacity()).toBe(50);
    expect(fake.undoStack()).toEqual(["user: opacity 50"]);
    expect(fake.folders()).toEqual([]);
  });

  it("the same with the full snapshot: nothing is listed as changed, the user's edit survives", () => {
    withManualEdit();
    const r = run(() => (fake.opacity.value = 50), { rollback: "changes" });
    expect(formatChanges(r.changes)).toBe("Changes: none");
    expect(r.rollback).toEqual({ undone: true, verified: true });
    expect(opacity()).toBe(50);
    expect(fake.undoStack()).toEqual(["user: opacity 50"]);
    expect(fake.folders()).toEqual([]);
  });

  it("the sentinel is never part of a change report", () => {
    withManualEdit();
    const r = run(() => fake.app.project.items.addFolder("Renders"), { rollback: "changes" });
    expect(formatChanges(r.changes)).toBe('Changes (layers/properties compared in: Main):\n+ folder "Renders"');
    expect(r.rollback).toEqual({ undone: true, verified: true });
    expect(fake.folders()).toEqual([]);
  });

  it("AE without revision, nothing listed but part of the project not compared (very large comp): unknown, nothing undone", () => {
    fake = fakeAE({ revision: false, bigComp: true });
    helpers = loadHelpers(fake);
    const r = run(() => fake.comp.name, { rollback: "changes", checkOnly: true });
    expect(r.changes?.partial).toBe(true);
    expect(r.rollback).toEqual({ undone: false, verified: false, problem: "unknown" });
    expect(fake.undos.n).toBe(0);
    expect(readOnlyRefusal(r)).toContain("It couldn't be checked whether the script changed the project, so nothing was undone.");
  });

  it("AE without revision, a report scoped to some comps: unknown, nothing undone (read-only)", () => {
    withManualEdit({ revision: false, otherComp: true });
    const r = run(() => (fake.other!.opacity.value = 10), { rollback: "changes", report: ["Main"] });
    expect(r.rollback).toEqual({ undone: false, verified: false, problem: "unknown" });
    expect(fake.undos.n).toBe(0);
  });

  it("Edit > Undo that does nothing is reported", () => {
    withManualEdit({ undoWorks: false });
    const r = run(() => (fake.opacity.value = 20), { rollback: "changes" });
    expect(r.rollback).toMatchObject({ undone: true, verified: false, problem: "undo did nothing" });
    expect(fake.folders()).toEqual([]); // the sentinel was removed by hand
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

// Renders: saveFrameToPng writes after the script returns (AE 26.5), so the render's undo step stays until Node has
// the file; aemcp.finishRollback (a second call) then undoes it. Here the "render" adds a temporary folder and, as in a
// 32 bpc project with linear blending, switches the project to 16 bpc without it.
describe("deferred rollback (renders)", () => {
  const RENDER = () => {
    fake.app.project.items.addFolder("__aemcp_preview");
    fake.app.project.bitsPerChannel = 16;
    fake.app.project.linearBlending = false;
    return "saved";
  };
  const run = (fn: () => unknown, opts: Record<string, unknown> = {}): RunResult =>
    JSON.parse(helpers.run(fn, {}, { undoGroup: "Surehand MCP preview", report: ["*"], checkOnly: true, rollback: "deferred", ...opts }));
  const color = () => [fake.app.project.bitsPerChannel, fake.app.project.linearBlending];

  it("the render's changes stay until finishRollback; then its step is undone once and checked", () => {
    withManualEdit();
    const r = run(RENDER);
    expect(r.ok).toBe(true);
    expect(r.rollback).toBeUndefined();
    expect(typeof r.pending).toBe("string");
    // while AE writes the file: the folder and the settings are still there, nothing undone yet
    expect(fake.folders()).toEqual(["__aemcp_preview", expect.stringMatching(/^__aemcp_rollback_/)]);
    expect(color()).toEqual([16, false]);
    expect(fake.undos.n).toBe(0);
    const rb = helpers.finishRollback(r.pending, () => []);
    expect(rb).toMatchObject({ undone: true, verified: "sentinel" });
    expect(fake.undos.n).toBe(1);
    expect(fake.folders()).toEqual([]);
    expect(color()).toEqual([32, true]);
    expect(opacity()).toBe(50);
    expect(fake.undoStack()).toEqual(["user: opacity 50"]);
    // a token is used once
    expect(helpers.finishRollback(r.pending, () => [])).toEqual({ undone: false, verified: false, problem: "unknown" });
  });

  it("the project changed before finishRollback: nothing is undone (it would revert that change), the render is cleaned up by hand", () => {
    withManualEdit();
    const r = run(RENDER);
    fake.app.beginUndoGroup("user: opacity 70");
    fake.opacity.value = 70;
    fake.app.endUndoGroup();
    const rb = helpers.finishRollback(r.pending, () => {
      fake.app.project.bitsPerChannel = 32;
      fake.app.project.linearBlending = true;
      return ["bit depth 32 bpc", "linear blending on"];
    });
    expect(rb).toEqual({ undone: false, verified: false, problem: "changed meanwhile", byHand: ["bit depth 32 bpc", "linear blending on"] });
    expect(fake.undos.n).toBe(0);
    expect(opacity()).toBe(70);
    expect(fake.folders().some((n: string) => n.startsWith("__aemcp_rollback_"))).toBe(false);
    expect(rollbackProblem(rb, "the render")).toMatch(/^The project changed while After Effects was writing the image .*Edit > Undo would have reverted that change instead[\s\S]*Set back by hand: bit depth 32 bpc; linear blending on\./);
  });

  it("settings the Undo didn't restore are set back by hand, and the project checked again", () => {
    withManualEdit({ colorNotUndone: true });
    const r = run(RENDER);
    const rb = helpers.finishRollback(r.pending, () => {
      const done: string[] = [];
      if (fake.app.project.bitsPerChannel !== 32) (fake.app.project.bitsPerChannel = 32), done.push("bit depth 32 bpc");
      if (!fake.app.project.linearBlending) (fake.app.project.linearBlending = true), done.push("linear blending on");
      return done;
    });
    expect(rb).toMatchObject({ undone: true, verified: true, byHand: ["bit depth 32 bpc", "linear blending on"] });
    expect(color()).toEqual([32, true]);
  });

  it("a render that fails is undone at once (nothing pending)", () => {
    withManualEdit();
    const r = run(() => {
      RENDER();
      throw new Error("no such comp");
    });
    expect(r.ok).toBe(false);
    expect(r.pending).toBeUndefined();
    expect(r.rollback).toMatchObject({ undone: true });
    expect(color()).toEqual([32, true]);
    expect(fake.folders()).toEqual([]);
  });

  it("a render that changed nothing (an 8 bpc frame of the comp itself) leaves nothing pending", () => {
    withManualEdit();
    const r = run(() => "saved");
    expect(r.pending).toBeUndefined();
    expect(r.rollback).toEqual({ undone: false, verified: true });
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
    expect(text(r)).toContain("Edit > Undo was run once for the batch, but the Undo did not revert the batch's changes as a whole");
    expect(text(r)).toContain("the project still isn't how it was before the batch");
    expect(text(r)).toContain("The Undo was not repeated.");
    expect(text(r)).toContain("Hint: steps in a batch must not open or close undo groups themselves");
    expect(text(r)).not.toContain("__aemcp_rollback");
    expect(fake.undos.n).toBe(1);
    expect(opacity()).toBe(20); // the Undo only reverted the sentinel's rename
    expect(fake.folders()).toEqual([]);
  });

  it("a step writes a value unchanged, a later step fails: the user's edit in another comp survives", async () => {
    fake = fakeAE({ otherComp: true });
    helpers = loadHelpers(fake);
    fake.app.beginUndoGroup("user: Other opacity 50");
    fake.other!.opacity.value = 50;
    fake.app.endUndoGroup();
    const r = await runBatch({ steps: [script(`${OP} op.setValue(op.value);`), script('throw new Error("boom")')] }, full);
    expect(text(r)).toContain("Batch stopped at step 2 of 2 and was rolled back (nothing changed).");
    expect(fake.undos.n).toBe(1);
    expect(fake.other!.opacity.value).toBe(50);
    expect(fake.undoStack()).toEqual(["user: Other opacity 50"]);
    expect(fake.folders()).toEqual([]);
  });

  it("AE without revision: a step edits a comp outside the report, a later step fails: still rolled back, the user's edit survives", async () => {
    fake = fakeAE({ otherComp: true, revision: false });
    helpers = loadHelpers(fake);
    fake.app.beginUndoGroup("user: Other opacity 50");
    fake.other!.opacity.value = 50;
    fake.app.endUndoGroup();
    const other = "var op = app.project.item(2).layer(1).property(1).property(1);";
    const r = await runBatch({ steps: [script(`${other} op.setValue(10);`), script('throw new Error("boom")')] }, full);
    expect(text(r)).toContain("was rolled back (nothing changed)");
    expect(fake.undos.n).toBe(1);
    expect(fake.other!.opacity.value).toBe(50);
    expect(fake.undoStack()).toEqual(["user: Other opacity 50"]);
    expect(fake.folders()).toEqual([]);
  });

  it("AE without revision: a batch that changed nothing and fails is undone safely (only its own step)", async () => {
    withManualEdit({ revision: false, otherComp: true });
    const r = await runBatch({ steps: [script('throw new Error("boom")')] }, full);
    expect(text(r)).toContain("was rolled back (nothing changed)");
    expect(fake.undos.n).toBe(1); // reverted the sentinel only
    expect(opacity()).toBe(50);
    expect(fake.undoStack()).toEqual(["user: opacity 50"]);
    expect(fake.folders()).toEqual([]);
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

  it("a step's result formatter that throws never hides the batch's edits: plain JSON instead", async () => {
    const { ALL_JSX_TOOLS } = await import("../src/tools/all.js");
    const info = ALL_JSX_TOOLS.find((t) => t.name === "ae_get_project_info")!;
    const saved = { format: info.format, jsx: info.jsx };
    info.jsx = "return { items: 1 };";
    info.format = () => {
      throw new Error("formatter bug");
    };
    try {
      withManualEdit();
      const r = await runBatch({ steps: [script(`${OP} op.setValue(10);`), { tool: "ae_get_project_info", args: {} }], verbose: true }, full);
      expect(r.isError).toBeFalsy();
      expect(text(r)).toMatch(/^Batch done: 2 steps in one undo step\./);
      expect(text(r)).toMatch(/2\. ae_get_project_info: \{"items":1\}\n\(The summary for this result could not be built \(formatter bug\); this is the raw result\.\)/s);
      expect(text(r)).toContain("Opacity: 50 -> 10");
      expect(opacity()).toBe(10);
    } finally {
      Object.assign(info, saved);
    }
  });
});

describe("ae_run_script in read-only mode", () => {
  const readOnly = async (code: string) => {
    const r = await runJsx(evalBody(transpileUserCode(code).source), {}, READ_ONLY_RUN_OPTIONS);
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
    expect(refusal).toContain("so its changes were undone (checked by Surehand MCP's undo marker; property values were not compared).");
    expect(fake.undos.n).toBe(1);
    expect(opacity()).toBe(50);
    expect(fake.undoStack()).toEqual(["user: opacity 50"]);
    expect(fake.folders()).toEqual([]);
  });

  it("a script that sets a value to what it already is: only its own step is undone, the user's edit survives", async () => {
    withManualEdit();
    const { r, refusal } = await readOnly(`${OP} op.value = op.value; return 1;`);
    expect(r.rollback).toEqual({ undone: true, verified: "sentinel", note: "values were not compared" });
    expect(refusal).toContain("This script wrote to the project (perhaps only values that were already set)");
    expect(refusal).not.toContain("This script changed the project");
    expect(fake.undos.n).toBe(1);
    expect(opacity()).toBe(50);
    expect(fake.undoStack()).toEqual(["user: opacity 50"]);
    expect(fake.folders()).toEqual([]);
  });

  it("a script that edits an attribute (listed): its change is named in the reply", async () => {
    withManualEdit();
    const { refusal } = await readOnly(`app.project.item(1).label = 5; return 1;`);
    expect(refusal).toContain("This script changed the project, so its changes were undone (checked by Surehand MCP's undo marker; property values were not compared):");
    expect(refusal).toContain('~ comp "Main": label 1 -> 5');
    expect(fake.comp.label).toBe(1);
  });

  it("a script that ends its undo group by an assembled name (past the text check): caught by the sentinel, not undone again", async () => {
    expect(READ_ONLY_RUN_OPTIONS).toMatchObject({ checkOnly: true, rollback: "changes", report: ["*"] });
    withManualEdit();
    const { refusal } = await readOnly(`${OP} op.setValue(80); app["end" + "UndoGroup"](); op.setValue(90); return 1;`);
    expect(refusal).toContain("the Undo did not revert the script's changes as a whole");
    expect(refusal).toContain("The Undo was not repeated.");
    expect(refusal).not.toContain("undo marker");
    expect(refusal).not.toContain("__aemcp_rollback");
    expect(fake.undos.n).toBe(1);
    expect(opacity()).toBe(90); // only the sentinel's rename was undone
    expect(fake.undoStack()[0]).toBe("user: opacity 50");
    expect(fake.folders()).toEqual([]);
  });
});

describe("ae_run_script in read-only mode: undo-stack calls are refused before anything runs", () => {
  // the real ae_run_script handler, with the permission mode from a temporary config file
  const runScript = async (mode: string, code: string, extra: Record<string, unknown> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "aemcp-perm-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ token: "x", permissions: { mode } }));
    const prev = process.env.AEMCP_CONFIG;
    process.env.AEMCP_CONFIG = join(dir, "config.json");
    try {
      let handler: any;
      registerCoreTools({ registerTool: (name: string, _def: unknown, h: unknown) => void (name === "ae_run_script" && (handler = h)) } as any);
      const r = await handler({ code, ...extra });
      return { isError: !!r.isError, text: String(r.content?.[0]?.text ?? ""), all: (r.content ?? []).map((c: any) => c.text ?? "").join("\n") };
    } finally {
      if (prev === undefined) delete process.env.AEMCP_CONFIG;
      else process.env.AEMCP_CONFIG = prev;
    }
  };

  for (const call of ["app.executeCommand(16);", "app.beginUndoGroup('x');", "app.endUndoGroup();", "app.purge(PurgeTarget.UNDO_CACHES);"]) {
    it(`refuses ${call.replace(/\(.*/, "")}: nothing ran, the user's edit and the undo stack are untouched`, async () => {
      withManualEdit();
      const { isError, text } = await runScript("read-only", `${OP} op.setValue(80);\n${call}\nreturn 1;`);
      expect(isError).toBe(true);
      expect(text).toMatch(/^Nothing ran\./);
      expect(text).toContain(`this script mentions ${call.replace(/^app\.|\(.*/g, "")}`);
      expect(text).toMatch(/undo history outside Surehand MCP's control/);
      expect(text).toMatch(/switch to Full or Ask with the mode selector/);
      expect(opacity()).toBe(50);
      expect(fake.undos.n).toBe(0);
      expect(fake.undoStack()).toEqual(["user: opacity 50"]);
    });
  }

  it("a name only in a comment isn't refused (the script runs)", async () => {
    withManualEdit();
    const { isError, text } = await runScript("read-only", `// never app.executeCommand(16) here\n/* or app.endUndoGroup(),\n   beginUndoGroup, purge */\n${OP} return op.value;`);
    expect(isError).toBe(false);
    expect(text).toContain("50");
    expect(fake.undos.n).toBe(0);
  });

  it("a comment marker inside a string doesn't hide a call after it", () => {
    expect(readOnlyBlockedCalls('var u = "http://x"; app.executeCommand(16); // done')).toEqual(["executeCommand"]);
    expect(readOnlyBlockedCalls("var r = /\\/*/; app.endUndoGroup();")).toEqual(["endUndoGroup"]);
  });

  it("a name written with \\u escapes is refused (checked decoded, and on the transpiled code)", async () => {
    const code = "app.\\u0065xecuteCommand(16);";
    expect(readOnlyBlockedCalls(code)).toEqual(["executeCommand"]);
    expect(readOnlyBlockedCalls("app.\\u{65}ndUndoGroup();")).toEqual(["endUndoGroup"]);
    // the transpiled code is checked too
    expect(readOnlyBlockedCalls("return 1;", "(function(args, log){app.executeCommand(16)\n})")).toEqual(["executeCommand"]);
    expect(readOnlyScriptRefusal(code, transpileUserCode(code).source)).toMatch(/^Nothing ran\./);
    for (const transpile of [true, false]) {
      withManualEdit();
      const { isError, text } = await runScript("read-only", `${OP} op.setValue(80);\n${code}\nreturn 1;`, { transpile });
      expect(isError).toBe(true);
      expect(text).toMatch(/^Nothing ran\./);
      expect(text).toContain("mentions executeCommand");
      expect(opacity()).toBe(50);
      expect(fake.undos.n).toBe(0);
    }
  });

  for (const call of ["app.scheduleTask('x()', 1000, false);", "app.newProject();", "app.open(new File('/x.aep'));", "app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);", "app.project.save();", "app.project.saveWithDialog();"]) {
    it(`refuses ${call.replace(/\(.*/, "")} (can't be undone): nothing ran`, async () => {
      withManualEdit();
      const { isError, text } = await runScript("read-only", `${OP} op.setValue(80);\n${call}\nreturn 1;`);
      expect(isError).toBe(true);
      expect(text).toMatch(/^Nothing ran\. Surehand MCP is in read-only mode, and this script mentions /);
      expect(text).toContain("which read-only mode can't undo");
      expect(text).not.toContain("undo history outside Surehand MCP's control");
      expect(text).toMatch(/switch to Full or Ask with the mode selector/);
      expect(opacity()).toBe(50);
      expect(fake.undos.n).toBe(0);
    });
  }

  it("names what each refused call is: one list", () => {
    expect(readOnlyBlockedCalls("app.scheduleTask('a', 1, false); app.newProject(); app.open(f); app.project.close(c); app.project.save(f); p.saveWithDialog();")).toEqual([
      "scheduleTask", "newProject", "app.open", "project.close", "save", "saveWithDialog",
    ]);
  });

  it("reading and writing files isn't refused (File.open / close are not project calls)", async () => {
    expect(readOnlyBlockedCalls('var f = new File("/tmp/x.txt"); f.open("r"); var s = f.read(); f.close(); return s;')).toEqual([]);
    withManualEdit();
    const { isError } = await runScript("read-only", `var w = { close: function () {} }; w.close(); ${OP} return op.value;`);
    expect(isError).toBe(false);
  });

  it("a timeout or cancel in read-only mode says the rollback still runs in After Effects", async () => {
    withManualEdit();
    for (const code of ["TIMEOUT", "CANCELLED"] as const) {
      bridgeError = new BridgeError(`it ${code}`, code);
      try {
        const ro = await runScript("read-only", `${OP} return op.value;`);
        expect(ro.isError).toBe(true);
        expect(ro.all).toContain(READ_ONLY_STILL_RUNNING);
        const full = await runScript("full", `${OP} return op.value;`);
        expect(full.all).not.toContain(READ_ONLY_STILL_RUNNING);
      } finally {
        bridgeError = null;
      }
    }
  });

  it("BLOCKED in read-only mode: nothing ran, so no rollback is claimed and it is not treated as a timeout", async () => {
    withManualEdit();
    const msg = explainBlocked({ waitingForMs: 4000, waitingFor: "ae_run_script", queue: 0 });
    bridgeError = new BridgeError(msg, "BLOCKED");
    try {
      const ro = await runScript("read-only", `${OP} return op.value;`);
      expect(ro.isError).toBe(true);
      expect(ro.all).toContain("This call did not run and will not run later.");
      expect(ro.all).not.toContain(READ_ONLY_STILL_RUNNING);
      expect(ro.all).not.toMatch(/rollback|rolled back|undone/i);
      expect(opacity()).toBe(50);
      expect(fake.undos.n).toBe(0);
    } finally {
      bridgeError = null;
    }
  });

  it("edit mode is unaffected: the same calls run", async () => {
    withManualEdit();
    const { isError } = await runScript("full", `${OP} app.endUndoGroup(); app.beginUndoGroup("mine"); op.setValue(80); return 1;`);
    expect(isError).toBe(false);
    expect(opacity()).toBe(80);
  });
});

describe("no blind Edit > Undo", () => {
  it("read-only mode and ae_batch don't send Edit > Undo themselves (aemcp.run does, guarded)", () => {
    for (const f of ["core.ts", "workflow.ts"]) expect(readFileSync(new URL(`../src/tools/${f}`, import.meta.url), "utf8")).not.toMatch(/executeCommand\(16\)/);
  });
});

describe("guarded rollback: what it can and can't prove", () => {
  const run = (fn: () => unknown, opts: Record<string, unknown>): RunResult =>
    JSON.parse(helpers.run(fn, {}, { undoGroup: "Surehand MCP test", report: ["*"], ...opts }));
  const readOnly = async (code: string) => {
    const r = await runJsx(evalBody(transpileUserCode(code).source), {}, READ_ONLY_RUN_OPTIONS);
    return { r, refusal: readOnlyRefusal(r) };
  };
  // ends its undo group and opens a new one: its first edit stays in a closed step, the marker lands in the new group
  const split = (v: number) => () => {
    fake.opacity.value = v;
    fake.app.endUndoGroup();
    fake.app.beginUndoGroup("x");
  };

  it("split undo group, light snapshot: the Undo only reverts the new group; reported as checked by the marker, never as verified", () => {
    withManualEdit();
    const r = run(split(20), { rollback: "changes", checkOnly: true });
    expect(r.rollback).toEqual({ undone: true, verified: "sentinel", note: "values were not compared" });
    expect(r.rollback?.verified).not.toBe(true);
    expect(fake.undos.n).toBe(1);
    expect(opacity()).toBe(20); // the limit: values weren't compared, so the edit left behind isn't seen
    expect(fake.folders()).toEqual([]);
    expect(fake.undoStack()[0]).toBe("user: opacity 50");
  });

  it("split undo group, full snapshot: the edit left behind is found (not back)", () => {
    withManualEdit();
    const r = run(split(20), { rollback: "changes" });
    expect(r.rollback).toMatchObject({ undone: true, verified: false, problem: "not back" });
    expect(formatChanges(r.rollback?.remaining)).toContain("Opacity: 50 -> 20");
    expect(fake.undos.n).toBe(1);
  });

  it("read-only reply for a split group (assembled names): says the values were not compared", async () => {
    withManualEdit();
    const { r, refusal } = await readOnly(`${OP} op.setValue(80); app["end" + "UndoGroup"](); app["begin" + "UndoGroup"]("x"); return 1;`);
    expect(r.rollback?.verified).toBe("sentinel");
    expect(refusal).toContain("so its changes were undone (checked by Surehand MCP's undo marker; property values were not compared)");
    expect(refusal).not.toMatch(/values were compared|verified/);
    expect(fake.undos.n).toBe(1);
  });

  it("app.project.revision can't show a split group: Undo moves it forward, it never restores it (fake = AE)", () => {
    withManualEdit();
    const rev0 = fake.app.project.revision;
    run(() => (fake.opacity.value = 20), { rollback: "changes" });
    expect(opacity()).toBe(50);
    expect(fake.app.project.revision).toBeGreaterThan(rev0); // back to the same values, not to the same revision
  });

  it("nested unclosed begin (assembled): the fake folds it into the call's group; the user's edit survives", async () => {
    withManualEdit();
    const { r, refusal } = await readOnly(`${OP} op.setValue(80); app["begin" + "UndoGroup"]("x"); return 1;`);
    expect(r.rollback?.undone).toBe(true);
    expect(refusal).toContain("so its changes were undone");
    expect(opacity()).toBe(50);
    expect(fake.undoStack()).toEqual(["user: opacity 50"]);
    expect(fake.folders()).toEqual([]);
  });

  it("the marker's rename fails: removed again, nothing undone, \"couldn't prepare the undo\"", () => {
    withManualEdit({ renameFails: true });
    const r = run(() => (fake.opacity.value = 20), { rollback: "changes" });
    expect(r.rollback).toEqual({ undone: false, verified: false, problem: "failed: couldn't prepare the undo (the undo marker couldn't be renamed)" });
    expect(fake.undos.n).toBe(0);
    expect(fake.folders()).toEqual([]);
    expect(readOnlyRefusal(r)).toContain("so nothing was undone");
  });

  it("an error after the Undo: undone is told by the marker (gone), never claimed blindly", () => {
    withManualEdit({ throwAfterUndo: true });
    const r = run(() => (fake.opacity.value = 20), { rollback: "changes" });
    expect(r.rollback).toEqual({ undone: true, verified: false, problem: "failed: project busy" });
    expect(opacity()).toBe(50);
    expect(fake.folders()).toEqual([]);
  });

  it("an error after an Undo that didn't revert the marker: not this call, the marker is removed", () => {
    withManualEdit({ throwAfterUndo: true, undoWorks: false });
    const r = run(() => (fake.opacity.value = 20), { rollback: "changes" });
    expect(r.rollback).toEqual({ undone: true, verified: false, problem: "not this call" });
    expect(fake.folders()).toEqual([]);
    expect(rollbackProblem(r.rollback!, "the script")).toContain("The Undo was not repeated.");
  });

  it("AE without revision, Undo did nothing: says it can't tell nothing from another step (never claims the marker was reverted)", () => {
    withManualEdit({ revision: false, undoWorks: false });
    const r = run(() => (fake.opacity.value = 20), { rollback: "changes" });
    expect(r.rollback).toMatchObject({ undone: true, verified: false, problem: "undo did nothing / not this call" });
    const msg = rollbackProblem(r.rollback!, "the script");
    expect(msg).toContain("After Effects either undid nothing or undid a different step");
    expect(msg).not.toContain("marker");
    expect(fake.folders()).toEqual([]);
  });

  it("AE without revision, the call closed its group early: the marker's reverted rename shows it (not this call)", () => {
    withManualEdit({ revision: false });
    const r = run(() => {
      fake.opacity.value = 20;
      fake.app.endUndoGroup();
    }, { rollback: "changes" });
    expect(r.rollback).toMatchObject({ undone: true, verified: false, problem: "not this call" });
    expect(fake.folders()).toEqual([]);
  });

  it("atomic batch whose step splits the undo group: not back, with the hint about undo groups", async () => {
    withManualEdit();
    const script = (code: string) => ({ tool: "ae_run_script", args: { code } });
    const r = await runBatch({ steps: [script(`${OP} op.setValue(10); app.endUndoGroup(); app.beginUndoGroup("x");`), script('throw new Error("boom")')] }, { mode: "full", allowShell: false });
    const t = (r.content[0] as { text: string }).text;
    expect(t).toContain("the project still isn't how it was before the batch");
    expect(t).toContain("Hint: steps in a batch must not open or close undo groups themselves");
    expect(fake.undos.n).toBe(1);
  });

  it("a batch rolled back cleanly has no undo-group hint", async () => {
    withManualEdit();
    const script = (code: string) => ({ tool: "ae_run_script", args: { code } });
    const r = await runBatch({ steps: [script(`${OP} op.setValue(10);`), script('throw new Error("boom")')] }, { mode: "full", allowShell: false });
    expect((r.content[0] as { text: string }).text).not.toContain("Hint: steps in a batch");
  });
});

describe("read-only refusal: bypass forms", () => {
  const cases: [string, string[]][] = [
    ['app["open"](f);', ["app.open"]],
    ["app['open'](f);", ["app.open"]],
    ["app[`open`](f);", ["app.open"]],
    ["app?.open(f);", ["app.open"]],
    ["app.open?.(f);", ["app.open"]],
    ['app?.["open"](f);', ["app.open"]],
    ["var o = app.open;", ["app.open"]],
    ['app.project["close"](CloseOptions.DO_NOT_SAVE_CHANGES);', ["project.close"]],
    ["app.project?.close(1);", ["project.close"]],
    ["app.project['save']();", ["save"]],
    ["app.project?.save();", ["save"]],
    ["app.project.save?.();", ["save"]],
    ['app["\\x6fpen"](f);', ["app.open"]],
    ['app["\\157pen"](f);', ["app.open"]],
    ['app["\\u006fpen"](f);', ["app.open"]],
    ['app["\\x65xecuteCommand"](16);', ["executeCommand"]],
    ['app["\\145ndUndoGroup"]();', ["endUndoGroup"]],
    ['app["beginUndoGroup"]("x");', ["beginUndoGroup"]],
    ["app[`endUndoGroup`]();", ["endUndoGroup"]],
    ["app?.executeCommand(16);", ["executeCommand"]],
    ["app.openFast(f);", ["openFast"]],
    ['app["openFast"](f);', ["openFast"]],
    ["app.quit();", ["quit"]],
    ['app["quit"]();', ["quit"]],
    ["app.project.renderQueue.render();", ["render"]],
    ["var rq = app.project.renderQueue; rq['render']();", ["render"]],
    ['app.preferences.savePrefAsLong("s", "k", 1, PREFType.PREF_Type_MACHINE_INDEPENDENT);', ["savePrefAs*"]],
    ['app.preferences.savePrefAsString("s", "k", "v");', ["savePrefAs*"]],
    ['app.settings.saveSetting("s", "k", "v");', ["saveSetting"]],
    ["app.preferences.saveToDisk();", ["saveToDisk"]],
  ];
  for (const [code, names] of cases)
    it(`refuses ${code}`, () => {
      expect(readOnlyBlockedCalls(code)).toEqual(names);
      const msg = readOnlyScriptRefusal(code, transpileUserCode(code).source)!;
      expect(msg).toMatch(/^Nothing ran\. Surehand MCP is in read-only mode, and this script mentions /);
    });

  it("the transpiled code is checked too (optional chaining and template keys)", () => {
    for (const code of ["app?.open(f);", "app[`open`](f);", "app.project?.save();"]) {
      const t = transpileUserCode(code).source;
      expect(readOnlyBlockedCalls(code, t).length).toBe(1);
    }
  });

  it("each refused name comes with a short reason", () => {
    const msg = readOnlyScriptRefusal("app.quit(); app.openFast(f); app.project.renderQueue.render(); app.settings.saveSetting('a','b','c');")!;
    expect(msg).toContain("this script mentions openFast, quit, render, saveSetting.");
    expect(msg).toContain("openFast: replaces the open project, which read-only mode can't undo.");
    expect(msg).toContain("quit: quits After Effects");
    expect(msg).toContain("render: renders files to disk (renderQueue.render)");
    expect(msg).toContain("saveSetting: changes After Effects preferences");
    expect(msg).toContain("the same method name on another object, such as obj.save()");
  });

  it("not refused: File.open/close, a variable or function named save/open/quit/render, a word in a comment", () => {
    for (const code of [
      'var f = new File("/tmp/x.txt"); f.open("r"); var s = f.read(); f.close(); return s;',
      "var save = 1; return save + 1;",
      "function save(x) { return x; } return save(2);",
      "var open = true, quit = false, render = 3; return [open, quit, render];",
      "var w = { close: function () {} }; w.close();",
      "var opened = app.project.file; var saved = 1; return opened;",
      "// app.quit(); app['open'](f)\nreturn 1;",
      "return app.project.renderQueue.numItems;",
      "var p = app.preferences; return p.getPrefAsLong('a', 'b');",
    ])
      expect(readOnlyBlockedCalls(code, transpileUserCode(code).source)).toEqual([]);
  });

  it("a rare false positive on another object's save() is refused, and the reply says the script mentions it", () => {
    const msg = readOnlyScriptRefusal("var obj = { save: function () {} }; obj.save();")!;
    expect(msg).toContain("this script mentions save.");
  });
});
