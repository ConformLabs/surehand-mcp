import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _internal } from "../src/tools/workflow.js";

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
