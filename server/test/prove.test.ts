// ae_prove_identical against a fake After Effects: the bridge (runJsx) is replaced by a small scene that
// "renders" PNGs the way PROVE_RENDER_JSX does (same arguments, same files, same result shape).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePng } from "../src/png.js";

interface FakeComp { id: number; name: string; width: number; height: number; pixelAspect: number; frameRate: number; duration: number; square: number; shade: number }
let comps: FakeComp[];
let calls: { kind: "render" | "batch"; opts: any }[];
/** what the batch does to the scene (run), or a failing batch */
let batchEdit: (() => void) | "fail" = () => {};

function draw(c: FakeComp): Buffer {
  const px = new Uint8Array(c.width * c.height * 4);
  for (let y = 0; y < c.height; y++)
    for (let x = 0; x < c.width; x++) {
      const o = (y * c.width + x) * 4, inSquare = x >= c.square && x < c.square + 4 && y >= 2 && y < 6;
      px.set(inSquare ? [c.shade, 40, 40, 255] : [0, 0, 0, 0], o);
    }
  return encodePng(c.width, c.height, px, 4);
}

function fakeRender(args: any) {
  const out: any[] = [];
  for (const spec of args.comps) {
    let c: FakeComp | undefined;
    let times: number[];
    if (spec.id !== undefined) {
      c = comps.find((k) => k.id === spec.id);
      if (!c) {
        out.push({ id: spec.id, missing: true });
        continue;
      }
      if (c.width !== spec.width || c.height !== spec.height || c.pixelAspect !== spec.pixelAspect) {
        out.push({ id: c.id, name: c.name, width: c.width, height: c.height, pixelAspect: c.pixelAspect, sizeChanged: true });
        continue;
      }
      times = spec.times;
    } else {
      c = spec.ref === "active" ? comps[0] : comps.find((k) => k.id === spec.ref || k.name === spec.ref);
      if (!c) return { ok: false, logs: [], error: { message: `Item '${spec.ref}' not found`, user: true } };
      const n = args.frames ?? 5;
      times = args.times ?? Array.from({ length: n }, (_, i) => (i * (c!.duration - 1 / c!.frameRate)) / Math.max(1, n - 1));
    }
    const frames = times.map((time, j) => {
      const path = join(args.dir, `${args.prefix}${c!.id}_${j}.png`);
      writeFileSync(path, draw(c!));
      return { time, path };
    });
    out.push({ id: c.id, name: c.name, width: c.width, height: c.height, pixelAspect: c.pixelAspect, frameRate: c.frameRate, renderW: c.width, renderH: c.height, frames });
  }
  return { ok: true, logs: [], result: { project: "/work/spot.aep", comps: out } };
}

vi.mock("../src/jsx.js", async (original) => {
  const real = await original<typeof import("../src/jsx.js")>();
  return {
    ...real,
    runJsx: async (body: string, args: any, opts: any) => {
      const { PROVE_RENDER_JSX } = await import("../src/tools/prove.js");
      if (body === PROVE_RENDER_JSX) {
        calls.push({ kind: "render", opts });
        return fakeRender(args);
      }
      // the ae_batch body
      calls.push({ kind: "batch", opts });
      if (batchEdit === "fail")
        return { ok: true, logs: [], result: { steps: [{ ok: false, error: "boom" }], failed: 0, rollback: true }, rollback: { undone: true, verified: true } };
      batchEdit();
      return { ok: true, logs: [], result: { steps: args.stepArgs.map(() => ({ ok: true })), failed: -1 } };
    },
  };
});

const { prove, pruneProofs, PROVE_RENDER_JSX, MAX_PROOFS } = await import("../src/tools/prove.js");
const FULL = { mode: "full", allowShell: true };
const text = (r: any) => r.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
const image = (r: any) => r.content.find((c: any) => c.type === "image");

let home: string;
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "aemcp-prove-"));
  process.env.HOME = process.env.USERPROFILE = home;
});
afterAll(() => {
  process.env.HOME = saved.HOME;
  process.env.USERPROFILE = saved.USERPROFILE;
});
beforeEach(() => {
  comps = [
    { id: 12, name: "Main", width: 32, height: 16, pixelAspect: 1, frameRate: 25, duration: 4, square: 10, shade: 200 },
    { id: 30, name: "Logo Precomp", width: 16, height: 16, pixelAspect: 1, frameRate: 25, duration: 4, square: 4, shade: 100 },
  ];
  calls = [];
  batchEdit = () => {};
});

const proofsDir = () => join(home, ".aemcp", "proofs");
const idOf = (r: any) => /proof (\S+?):/.exec(text(r))![1];

describe("ae_prove_identical", () => {
  it("the render script is valid ES3", async () => {
    const { parse } = await import("acorn");
    expect(() => parse(`(function(args, log){${PROVE_RENDER_JSX}\n})`, { ecmaVersion: 3, allowReserved: false })).not.toThrow();
  });

  it("capture stores the frames and a manifest; compare with nothing changed is identical", async () => {
    const cap = await prove({ action: "capture" }, FULL);
    expect(cap.isError).toBeFalsy();
    const id = idOf(cap);
    const m = JSON.parse(readFileSync(join(proofsDir(), id, "manifest.json"), "utf8"));
    expect(m.comps).toHaveLength(1);
    expect(m.comps[0]).toMatchObject({ id: 12, name: "Main", width: 32, height: 16 });
    expect(m.comps[0].frames).toHaveLength(5);
    for (const f of m.comps[0].frames) expect(existsSync(join(proofsDir(), id, f.file))).toBe(true);
    // rendering is a preview: one undo group, no approval
    expect(calls[0].opts).toMatchObject({ undoGroup: "Surehand MCP proof" });
    expect(calls[0].opts.bridge).toBeUndefined();

    const cmp = await prove({ action: "compare", id }, FULL);
    expect(text(cmp)).toMatch(/Verdict: IDENTICAL: all 5 frames are bit-identical/);
    expect(image(cmp)).toBeUndefined();
    // the frames rendered for the comparison are removed again
    expect(readdirSync(join(home, ".aemcp", "tmp"))).toEqual([]);
  });

  it("compare defaults to the latest proof", async () => {
    await prove({ action: "capture", comps: ["Logo Precomp"] }, FULL);
    const cmp = await prove({ action: "compare" }, FULL);
    expect(text(cmp)).toMatch(/"Logo Precomp" \(id 30\)/);
  });

  it("a difference of 1/255 differs at tolerance 0 and is identical within tolerance 1", async () => {
    const id = idOf(await prove({ action: "capture", frames: 2 }, FULL));
    comps[0].shade = 201;
    const strict = await prove({ action: "compare", id }, FULL);
    expect(text(strict)).toMatch(/Verdict: DIFFERS in 2 of 2 frames \(tolerance 0: bit-identical\)/);
    expect(text(strict)).toMatch(/16 px \(3\.13%\) beyond the tolerance, max channel difference 1\/255/);
    const loose = await prove({ action: "compare", id, tolerance: 1 }, FULL);
    expect(text(loose)).toMatch(/Verdict: IDENTICAL WITHIN TOLERANCE: all 2 frames match within 1\/255 per channel \(largest difference 1\/255\)/);
    expect(image(loose)).toBeDefined(); // within-tolerance pixels show as dark blue
  });

  it("a layer nudged by 1 px differs, with the area and a difference image", async () => {
    const id = idOf(await prove({ action: "capture", times: [1] }, FULL));
    comps[0].square = 11;
    const r = await prove({ action: "compare", id }, FULL);
    expect(text(r)).toMatch(/Verdict: DIFFERS in 1 of 1 frames/);
    expect(text(r)).toMatch(/1s \(f25\): DIFFERS: 8 px .* max channel difference 255\/255, max ΔE [\d.]+, inside x 10-14, y 2-5 \(5x4 rendered px\)/);
    expect(image(r)).toMatchObject({ mimeType: "image/png" });
    expect(text(r)).toMatch(/Difference image of "Main" at 1s \(f25\) \(32x16\): black = identical/);
  });

  it("a deleted comp is not proven; a renamed one is matched by id; a resized one is reported", async () => {
    const id = idOf(await prove({ action: "capture", comps: [12, 30], frames: 1 }, FULL));
    comps = [{ ...comps[0], name: "Main v2" }];
    let r = await prove({ action: "compare", id }, FULL);
    expect(text(r)).toMatch(/Verdict: NOT PROVEN: "Logo Precomp" \(id 30\) was deleted since the capture\. The 1 frames that could be compared match/);
    expect(text(r)).toMatch(/"Main" \(id 12\) \(renamed to "Main v2"\)/);
    comps[0].width = 64;
    r = await prove({ action: "compare", id }, FULL);
    expect(text(r)).toMatch(/size changed from 32x16 \(pixel aspect 1\) to 64x16/);
    expect(text(r)).toMatch(/Verdict: NOT PROVEN: "Main" \(id 12\) changed size; "Logo Precomp" \(id 30\) was deleted since the capture\.\n/);
  });

  it("an unknown proof id or comp is an error", async () => {
    expect(text(await prove({ action: "compare", id: "20200101-000000-dead" }, FULL))).toMatch(/Proof 20200101-000000-dead not found/);
    expect((await prove({ action: "compare", id: "../../etc" }, FULL)).isError).toBe(true);
    // (the tool handler turns this into an error result)
    await expect(prove({ action: "capture", comps: ["Nope"] }, FULL)).rejects.toThrow(/Item 'Nope' not found/);
    // a failed capture leaves no proof behind
    expect(readdirSync(proofsDir()).every((d) => existsSync(join(proofsDir(), d, "manifest.json")))).toBe(true);
  });

  it("run: capture, the batch, compare, in one call", async () => {
    batchEdit = () => (comps[0].square = 12);
    const r = await prove({ action: "run", frames: 1, steps: [{ tool: "ae_set_property", args: { layer: 1, path: "Transform/Position", value: [12, 4] } }] }, FULL);
    expect(r.isError).toBeFalsy();
    expect(calls.map((c) => c.kind)).toEqual(["render", "batch", "render"]);
    expect(text(r)).toMatch(/^Verdict: DIFFERS in 1 of 1 frames.*\nProof \S+ \(reference captured/);
    expect(text(r)).toMatch(/Edits \(one undo step\):\nBatch done: 1 steps in one undo step\./);
  });

  it("run: a failed batch is rolled back and nothing is compared", async () => {
    batchEdit = "fail";
    const r = await prove({ action: "run", steps: [{ tool: "ae_set_property", args: { layer: 1, path: "Transform/Opacity", value: 0 } }] }, FULL);
    expect(r.isError).toBe(true);
    expect(calls.map((c) => c.kind)).toEqual(["render", "batch"]);
    expect(text(r)).toMatch(/rolled back/);
    expect(text(r)).toMatch(/Nothing was compared: the batch did not complete\. The reference frames are kept as proof/);
  });

  it("run follows ae_batch's permissions: refused in read-only mode, approval in ask mode", async () => {
    const ro = await prove({ action: "run", steps: [{ tool: "ae_set_property", args: {} }] }, { mode: "read-only", allowShell: true });
    expect(text(ro)).toMatch(/read-only mode/);
    expect(calls).toEqual([]);
    // capture and compare only render, as ae_render_frame: allowed in read-only mode
    expect((await prove({ action: "capture" }, { mode: "read-only", allowShell: true })).isError).toBeFalsy();
    calls = [];
    await prove({ action: "run", frames: 1, steps: [{ tool: "ae_set_property", args: { layer: 1 } }] }, { mode: "ask", allowShell: true });
    const batch = calls.find((c) => c.kind === "batch")!;
    expect(batch.opts.bridge.approval.tool).toBe("Batch (1 steps)");
    expect(calls.filter((c) => c.kind === "render").every((c) => !c.opts.bridge)).toBe(true);
    const shell = await prove({ action: "run", steps: [{ tool: "ae_run_script", args: { code: "system.callSystem('ls')" } }] }, { mode: "full", allowShell: false });
    expect(text(shell)).toMatch(/Shell commands/);
  });

  it("keeps at most 30 proofs and none older than 7 days", () => {
    mkdirSync(proofsDir(), { recursive: true });
    for (let i = 0; i < 40; i++) mkdirSync(join(proofsDir(), `19990101-0000${String(i).padStart(2, "0")}-aaaa`), { recursive: true });
    const old = join(proofsDir(), "19990101-000041-aaaa");
    mkdirSync(old);
    const longAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    utimesSync(old, longAgo, longAgo);
    pruneProofs();
    const left = readdirSync(proofsDir());
    expect(left).toHaveLength(MAX_PROOFS);
    expect(left).not.toContain("19990101-000041-aaaa");
    expect(left).not.toContain("19990101-000000-aaaa"); // the oldest went first
  });
});
