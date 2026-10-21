// ae_undo / ae_redo compare every comp for their change report: the step undone can be in any comp (live, AE 26.5: a
// rename and an opacity change in a comp that wasn't active were undone, and the report said "Changes: none").
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "surehand-undo-"));
vi.mock("node:os", async (orig) => ({ ...(await orig<typeof import("node:os")>()), homedir: () => home }));
const seen: { body: string; opts: any }[] = [];
vi.mock("../src/jsx.js", async (orig) => ({
  ...(await orig<typeof import("../src/jsx.js")>()),
  runJsx: async (body: string, _args: unknown, opts: any) => (seen.push({ body, opts }), { ok: true, logs: [], result: { undone: 1 } }),
}));
const { registerJsxTools } = await import("../src/tools/registry.js");
const { appTools } = await import("../src/tools/app.js");

describe("undo and redo change reports", () => {
  it("compare every comp", async () => {
    const tools = new Map<string, (a: any) => Promise<any>>();
    registerJsxTools({ registerTool: (name: string, _c: unknown, cb: any) => void tools.set(name, cb) } as any, appTools);
    for (const name of ["ae_undo", "ae_redo"]) {
      await tools.get(name)!({});
      expect(seen.pop()!.opts.report).toEqual(["*"]);
    }
  });
});
