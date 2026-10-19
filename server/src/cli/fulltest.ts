// `ae-mcp selftest --full`: exercises every major tool against the connected After Effects in
// temporary comps (removed afterwards) and saves a compatibility report for this AE version.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { CAPABILITIES_JSX, FEATURE_NOTES } from "../capabilities.js";
import { VERSION } from "../config.js";
import { evalBody, runJsx, type RunResult } from "../jsx.js";
import { transpileUserCode } from "../transpile.js";
import { ALL_JSX_TOOLS } from "../tools/all.js";
import { CONTACT_SHEET_JSX, RENDER_FRAME_JSX } from "../tools/core.js";
import { restoreCheckpoint, saveCheckpoint } from "../tools/workflow.js";
import { regressionSteps } from "./fulltest-regression.js";
import { revisionSteps } from "./fulltest-revision.js";
import { rollbackSteps } from "./fulltest-rollback.js";
import { bold, fail, green, ok, red, warn } from "./util.js";

const ALL = ALL_JSX_TOOLS;
const C = "__aemcp_fulltest";

interface Step { name: string; tool?: string; args?: Record<string, unknown>; jsx?: string; needs?: string; check?: (r: RunResult) => string | null }
interface StepResult { step: string; ok: boolean; ms: number; error?: string; skipped?: boolean }

const jsxOf = (tool: string) => ALL.find((t) => t.name === tool)!.jsx;
const run = (body: string, args: Record<string, unknown> = {}) => runJsx(body, args, { undoGroup: false, timeoutMs: 120_000 });
type ProjectState = { file: string | null; dirty: boolean };
const PROJECT_STATE = "return { file: app.project.file ? app.project.file.fsName : null, dirty: app.project.dirty };";
export const projectState = async () => (await run(PROJECT_STATE)).result as ProjectState | undefined;

/**
 * Save As refusal and checkpoint restore of a dirty project, in a scratch project. They need to
 * switch projects, so they run only if the project had no unsaved changes before the self-test
 * (the self-test's own edits are removed again); that project is reopened afterwards.
 */
async function projectSafetyTests(tmpDir: string, before: ProjectState | undefined): Promise<StepResult[]> {
  const names = ["Save As refuses to overwrite", "restore checkpoint over a dirty project"];
  if (before?.dirty !== false) {
    for (const n of names) warn(`${n}: skipped (the open project has unsaved changes; save it to run this)`);
    return names.map((step) => ({ step, ok: true, ms: 0, skipped: true }));
  }
  const dir = join(tmpDir, `fulltest_project_${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const scratch = join(dir, "scratch.aep");
  const existing = join(dir, "existing.aep");
  writeFileSync(existing, "not a project: must not be overwritten");
  const results: StepResult[] = [];
  const step = async (name: string, fn: () => Promise<string | null>) => {
    const t0 = Date.now();
    let problem: string | null;
    try {
      problem = await fn();
    } catch (e: any) {
      problem = e?.message ?? String(e);
    }
    const ms = Date.now() - t0;
    results.push({ step: name, ok: !problem, ms, error: problem ?? undefined });
    problem ? fail(`${name}: ${problem}`) : ok(`${name} (${ms} ms)`);
  };
  let checkpointDir: string | undefined;
  let switched = false;
  try {
    const sw = await run(
      `if (String(app.project.file && app.project.file.fsName) !== String(args.file)) aemcp.fail("a different project is open now"); app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); app.newProject(); return true;`,
      { file: before.file },
    );
    if (!sw.ok) throw new Error(`could not switch to a scratch project: ${sw.error?.message}`);
    switched = true;

    await step(names[0], async () => {
      const saved = await run(jsxOf("ae_save_project"), { path: scratch });
      if (!saved.ok) return `Save As to a new file failed: ${saved.error?.message}`;
      const refused = await run(jsxOf("ae_save_project"), { path: existing });
      if (refused.ok) return "Save As overwrote an existing file without overwrite: true";
      if (!/overwrite: true/.test(refused.error?.message ?? "")) return `refusal does not say to pass overwrite: true: ${refused.error?.message}`;
      if (readFileSync(existing, "utf8") !== "not a project: must not be overwritten") return "the existing file was changed";
      const now = (await run(PROJECT_STATE)).result as { file: string };
      return now.file === scratch ? null : `the open project moved to ${now.file}`;
    });

    await step(names[1], async () => {
      const cp = await saveCheckpoint("fulltest");
      checkpointDir = dirname(cp.file);
      const dirty = await run(`app.project.items.addFolder("__aemcp_fulltest_unsaved"); return app.project.dirty;`);
      if (dirty.result !== true) return "could not make the scratch project dirty";
      const refused = await restoreCheckpoint(scratch, cp).then(() => "restored over unsaved changes without discardChanges", (e) => (/discardChanges: true/.test(e.message) ? null : e.message));
      if (refused) return refused;
      const first = await restoreCheckpoint(scratch, cp, true);
      let now = (await run(PROJECT_STATE)).result as { file: string; dirty: boolean };
      if (now.file !== first || now.dirty) return `after restore the open project is ${now.file}${now.dirty ? " (unsaved)" : ""}, not ${first}`;
      // restoring the same checkpoint again must not overwrite the first restore
      const back = await run(jsxOf("ae_open_project"), { path: scratch, discardChanges: true });
      if (!back.ok) return `could not reopen the scratch project: ${back.error?.message}`;
      await run(`app.project.items.addFolder("__aemcp_fulltest_unsaved"); return true;`);
      const second = await restoreCheckpoint(scratch, cp, true);
      now = (await run(PROJECT_STATE)).result as { file: string; dirty: boolean };
      if (second === first || !existsSync(first)) return `second restore reused ${basename(first)}`;
      return now.file === second ? null : `after the second restore the open project is ${now.file}, not ${second}`;
    });
  } catch (e: any) {
    const done = new Set(results.map((r) => r.step));
    for (const n of names.filter((n) => !done.has(n))) {
      results.push({ step: n, ok: false, ms: 0, error: e?.message ?? String(e) });
      fail(`${n}: ${e?.message ?? e}`);
    }
  } finally {
    // back to the project that was open before (only discards the scratch project, never the user's)
    if (switched) {
      const r = before.file ? await run(jsxOf("ae_open_project"), { path: before.file, discardChanges: true }) : await run(jsxOf("ae_new_project"), { discardChanges: true });
      if (!r.ok) {
        results.push({ step: "reopen the original project", ok: false, ms: 0, error: r.error?.message });
        fail(`Could not reopen ${before.file ?? "an empty project"}: ${r.error?.message}`);
      }
    }
    rmSync(dir, { recursive: true, force: true });
    if (checkpointDir) rmSync(checkpointDir, { recursive: true, force: true });
  }
  return results;
}

/** `before`: the project state before any self-test edits (the project-switching checks need it). */
export async function fullSelftest(before?: ProjectState): Promise<number> {
  console.log(bold(`\nFull self-test: every major tool against this After Effects (temporary comps, removed afterwards)\n`));
  const caps = await runJsx(CAPABILITIES_JSX, {}, { undoGroup: "Surehand MCP self-test", timeoutMs: 60_000 });
  if (!caps.ok) {
    fail(`Could not read capabilities: ${caps.error?.message}`);
    return 1;
  }
  const { appVersion, os, features } = caps.result as { appVersion: string; os: string; features: Record<string, unknown> };
  console.log(`  After Effects ${appVersion} · ${os}`);
  for (const [k, v] of Object.entries(features)) {
    if (k === "expressionEngine" || k === "scriptsCanWriteFiles") continue;
    (v ? ok : warn)(`${k}: ${v ? "yes" : "no"}${FEATURE_NOTES[k] ? `  (${FEATURE_NOTES[k]})` : ""}`);
  }
  console.log(`  expression engine: ${features.expressionEngine} · scripts can write files: ${features.scriptsCanWriteFiles}\n`);

  const start = await runJsx("var m = 0; for (var i = 1; i <= app.project.numItems; i++) m = Math.max(m, app.project.item(i).id); return { maxId: m, rq: app.project.renderQueue.numItems };", {}, { undoGroup: false });
  const { maxId, rq } = start.result as { maxId: number; rq: number };
  const tmpDir = join(homedir(), ".aemcp", "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const frame = join(tmpDir, `fulltest_${Date.now()}.png`);

  const steps: Step[] = [
    { name: "create comp", tool: "ae_create_comp", args: { name: C, width: 1280, height: 720, duration: 4, frameRate: 25 } },
    { name: "solid layer", tool: "ae_add_layer", args: { comp: C, type: "solid", name: "BG", color: "#20304a" } },
    { name: "text layer", tool: "ae_add_layer", args: { comp: C, type: "text", name: "Title", text: "Full Self Test", fontSize: 72, font: "ArialMT" } },
    { name: "shape layer", tool: "ae_add_shape", args: { comp: C, shape: "ellipse", size: [200, 200], fill: "#ffcc00", name: "Dot" } },
    { name: "null + camera", tool: "ae_add_layer", args: { comp: C, type: "null", name: "Rig" } },
    { name: "set property", tool: "ae_set_property", args: { comp: C, layer: "BG", path: "Transform/Opacity", value: 90 } },
    { name: "keyframes + ease", tool: "ae_set_keyframes", args: { comp: C, layer: "Title", path: "Transform/Position", keyframes: [{ time: 0, value: [640, 800] }, { time: 1, value: [640, 360] }], easyEase: true } },
    { name: "edit keyframes (tangents, label, move)", tool: "ae_edit_keyframes", args: { comp: C, layer: "Title", path: "Transform/Position", keys: [{ index: 2, label: 2, inSpatialTangent: [-50, 0], moveTo: 1.5 }] } },
    { name: "copy keyframes", tool: "ae_copy_keyframes", args: { from: { comp: C, layer: "Title", path: "Transform/Position" }, to: [{ comp: C, layer: "Rig", path: "Transform/Position" }] } },
    { name: "expression", tool: "ae_set_expression", args: { comp: C, layer: "Dot", path: "Transform/Rotation", expression: "time * 90" }, check: (r) => ((r.result as any)?.error ? "expression error" : null) },
    { name: "list expressions", tool: "ae_get_expressions", args: { comp: C } },
    { name: "apply effect + params", tool: "ae_apply_effect", args: { comp: C, layer: "Title", effect: "ADBE Drop Shadow", params: { "ADBE Drop Shadow-0004": 10 } } }, // Distance, by match name
    { name: "inspect effect", tool: "ae_get_effect_params", args: { effect: "ADBE Glo2" } },
    { name: "English names (any AE language)", tool: "ae_get_effect_params", args: { effect: "glow" } },
    { name: "mask", tool: "ae_add_mask", args: { comp: C, layer: "BG", shape: "ellipse", feather: 50 } },
    { name: "parent + blend", tool: "ae_set_layer_attributes", args: { comp: C, layer: "Dot", parent: "Rig", blendingMode: "SCREEN" } },
    { name: "style text range", tool: "ae_style_text_range", args: { comp: C, layer: "Title", match: "Self", style: { fillColor: "#ff3b30" } }, needs: "perCharacterText" },
    { name: "paragraph", tool: "ae_set_paragraph", args: { comp: C, layer: "Title", justification: "CENTER_JUSTIFY" } },
    { name: "text animator", tool: "ae_add_text_animator", args: { comp: C, layer: "Title", properties: { opacity: 0 }, selector: { basedOn: "words", shape: "rampUp" } } },
    { name: "layer bounds", tool: "ae_get_layer_bounds", args: { comp: C }, check: (r) => (((r.result as any)?.layers || []).some((l: any) => l.bounds) ? null : "no bounds measured") },
    { name: "sample pixels", tool: "ae_sample_pixels", args: { comp: C, points: [[640, 360]] } },
    { name: "comp map", tool: "ae_get_comp_map", args: { comp: C } },
    { name: "find properties", tool: "ae_find_properties", args: { comp: C, onlyAnimated: true } },
    { name: "precompose", tool: "ae_precompose", args: { comp: C, layers: ["Dot"], name: `${C}_pre` } },
    { name: "time remap", tool: "ae_set_time_remap", args: { comp: C, layer: `${C}_pre`, freezeAt: 0.5 } },
    { name: "essential graphics", tool: "ae_essential_graphics", args: { comp: C, add: [{ layer: "BG", path: "Transform/Opacity", name: "BG Opacity" }] }, needs: "essentialGraphics" },
    { name: "render queue add", tool: "ae_add_to_render_queue", args: { comp: C, outputPath: join(tmpDir, "fulltest.mov") } },
    { name: "render settings", tool: "ae_set_render_settings", args: { renderSettings: { Quality: "Draft" } }, needs: "renderSettingsApi" },
    { name: "project health", tool: "ae_project_health", args: {} },
    { name: "camera", tool: "ae_set_camera", args: { comp: C, focalLength: 50, type: "two-node", depthOfField: true } },
    { name: "light", tool: "ae_set_light", args: { comp: C, type: "SPOT", intensity: 120, castsShadows: true } },
    { name: "3D material", tool: "ae_set_material", args: { comp: C, layers: ["BG"], castsShadows: "on", specular: 30 } },
    { name: "check expression", tool: "ae_check_expression", args: { comp: C, layer: "BG", path: "Transform/Opacity", expression: "50 + 50 * Math.sin(time)" }, check: (r) => ((r.result as any)?.ok ? null : `expression reported an error: ${(r.result as any)?.error}`) },
    { name: "replace in expressions (dry run)", tool: "ae_replace_in_expressions", args: { find: "time", replace: "time", comps: [C], dryRun: true } },
    { name: "color settings", tool: "ae_color_settings", args: { listProfiles: true } },
    { name: "system info", tool: "ae_system_info", args: {} },
    { name: "frame preview", jsx: RENDER_FRAME_JSX, args: { comp: C, time: 1, outputPath: frame, tmpDir }, check: () => (existsSync(frame) && statSync(frame).size > 0 ? null : "no PNG written") },
    { name: "contact sheet", jsx: CONTACT_SHEET_JSX, args: { comp: C, frames: 4, tmpDir } },
    {
      name: "modern JavaScript",
      jsx: evalBody(transpileUserCode("const names = [];\nfor (let i = 1; i <= app.project.numItems; i++) names.push(app.project.item(i).name);\nreturn names.filter((n) => n.startsWith('__aemcp_fulltest')).length ?? 0;").source),
      args: {},
      check: (r) => (Number(r.result) >= 1 ? null : `unexpected result ${JSON.stringify(r.result)}`),
    },
  ];

  const results: StepResult[] = await projectSafetyTests(tmpDir, before ?? (await projectState()));
  for (const s of steps) {
    if (s.needs && !features[s.needs]) {
      results.push({ step: s.name, ok: true, ms: 0, skipped: true });
      warn(`${s.name}: skipped (needs ${s.needs})`);
      continue;
    }
    const t0 = Date.now();
    let r: RunResult;
    try {
      const body = s.jsx ?? ALL.find((t) => t.name === s.tool)?.jsx;
      if (!body) throw new Error(`unknown tool ${s.tool}`);
      r = await runJsx(body, s.args ?? {}, { undoGroup: "Surehand MCP self-test", timeoutMs: 120_000, report: [C] });
    } catch (e: any) {
      r = { ok: false, logs: [], error: { message: e.message } };
    }
    const problem = !r.ok ? r.error?.message ?? "failed" : s.check?.(r) ?? null;
    const ms = Date.now() - t0;
    results.push({ step: s.name, ok: !problem, ms, error: problem ?? undefined });
    problem ? fail(`${s.name}: ${problem}`) : ok(`${s.name} (${ms} ms)`);
  }

  results.push(...(await revisionSteps(features, (good, line) => (good ? ok : fail)(line))));
  results.push(...(await rollbackSteps((good, line) => (good ? ok : fail)(line))));
  results.push(...(await regressionSteps(tmpDir, (good, line) => (good ? ok : fail)(line))));

  // clean up everything the test created
  await runJsx(
    `var p = app.project, rq = p.renderQueue;
for (var r = rq.numItems; r > args.rq; r--) rq.item(r).remove();
for (var i = p.numItems; i >= 1; i--) { var it = p.item(i); if (it.id > args.maxId) it.remove(); }
return p.numItems;`,
    { maxId, rq },
    { undoGroup: "Surehand MCP self-test cleanup" },
  );
  try {
    unlinkSync(frame);
  } catch {}

  const failed = results.filter((r) => !r.ok);
  const dir = join(homedir(), ".aemcp", "compat");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `after-effects-${appVersion.replace(/[^\w.]+/g, "_")}.json`);
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), server: VERSION, appVersion, os, platform: process.platform, features, results }, null, 2));
  console.log(
    failed.length
      ? `\n${red(bold(`${failed.length} of ${results.length} steps failed`))} on After Effects ${appVersion}.`
      : `\n${green(bold(`All ${results.length} steps passed`))} on After Effects ${appVersion}.`,
  );
  console.log(`Compatibility report: ${file}\n`);
  return failed.length ? 1 : 0;
}
