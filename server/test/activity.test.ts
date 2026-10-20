// The activity log's optional fields for the panel (change list, revision, undo step, verdicts) and the
// background render status files. Temporary home.
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "surehand-activity-"));
process.env.HOME = process.env.USERPROFILE = home;
delete process.env.SUREHAND_AE_NO_ACTIVITY_LOG;
delete process.env.AEMCP_NO_ACTIVITY_LOG;
const { activityDetails, activityFile, logActivity, readActivity } = await import("../src/activity.js");

describe("activity details", () => {
  it("the change report's lines (at most 20), the revision and the undo step", () => {
    const lines = Array.from({ length: 25 }, (_, i) => `~ Title > Transform/Position: [${i}, 0] -> [${i + 1}, 0]`);
    const text = `Set 1 property.\nChanges (1 comp):\n${lines.join("\n")}\n... and more`;
    const d = activityDetails("ae_set_property", text, { revision: 42, undoGroup: "ae_set_property" });
    expect(d.changeList).toHaveLength(20);
    expect(d.changeList![0]).toBe("~ Title > Transform/Position: [0, 0] -> [1, 0]");
    expect(d).toMatchObject({ revision: 42, undoGroup: "ae_set_property" });
    expect(activityDetails("ae_get_comp_info", "{}", undefined)).toEqual({});
  });

  it("verdicts of ae_preflight and ae_prove_identical", () => {
    expect(activityDetails("ae_preflight", "FAIL (2)\nChecked Main against the Broadcast spec\n...").result).toEqual({ verdict: "FAIL", summary: "FAIL (2) · Checked Main against the Broadcast spec" });
    expect(activityDetails("ae_preflight", "PASS\nChecked Main").result?.verdict).toBe("PASS");
    expect(activityDetails("ae_versions_from_data", 'FAIL (2 of 12 rows)\n12 versions of "Card"').result).toEqual({ verdict: "FAIL", summary: 'FAIL (2 of 12 rows) · 12 versions of "Card"' });
    expect(activityDetails("ae_versions_from_data", "Dry run: the mapping fits the comp").result).toBeUndefined();
    expect(activityDetails("ae_prove_identical", "Verdict: DIFFERS in 2 of 5 frames (exact): 0:00, 0:01.\nProof p1").result).toEqual({ verdict: "DIFFERS", summary: "in 2 of 5 frames (exact): 0:00, 0:01." });
    expect(activityDetails("ae_prove_identical", "Verdict: IDENTICAL WITHIN TOLERANCE: all 5 frames match").result?.verdict).toBe("IDENTICAL WITHIN TOLERANCE");
    expect(activityDetails("ae_prove_identical", "Captured proof p1: ...").result?.verdict).toBe("CAPTURED");
  });

  it("are written with the entry", () => {
    logActivity({ at: "2026-10-20T00:00:00Z", tool: "ae_set_property", ms: 5, ok: true, changeList: ["~ a"], revision: 7, undoGroup: "x" });
    expect(activityFile()).toBe(join(home, ".surehand", "ae", "activity.jsonl"));
    expect(readActivity(1)[0]).toMatchObject({ changeList: ["~ a"], revision: 7, undoGroup: "x" });
  });
});

describe("background render status files", () => {
  it("renders/<id>.json with {id, comp, frames, done, status, output, startedAt, endedAt?}", async () => {
    const { writeJobFile } = await import("../src/tools/renderjobs.js");
    const job = { id: "r1", comp: "Main", frames: 100, frameRendered: 40, status: "running" as const, output: "/out/main.mov", startedAt: "2026-10-20T00:00:00Z" };
    writeJobFile(job);
    const file = join(home, ".surehand", "ae", "renders", "r1.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ id: "r1", comp: "Main", frames: 100, done: 40, status: "running", output: "/out/main.mov", startedAt: "2026-10-20T00:00:00Z" });
    writeJobFile({ ...job, status: "done", frameRendered: 99, endedAt: "2026-10-20T00:01:00Z" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ done: 100, status: "done", endedAt: "2026-10-20T00:01:00Z" });
  });
});
