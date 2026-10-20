// "Allow Scripts to Write Files and Access Network" (After Effects > Settings > Scripting & Expressions): the helper
// library reads it, and a script whose shell command fails with "Permission denied" while it is off gets a hint that
// says where to turn it on. Measured in AE 26.5 through the CEP bridge: off, scripts still write files, but
// system.callSystem throws. Runs the real helper library on the fake After Effects.
import { describe, expect, it } from "vitest";
import { fakeAE, fakeWriteAccess, loadHelpers } from "./fake-ae.js";
import { formatResult } from "../src/tools/registry.js";
import { WRITE_ACCESS_HINT } from "../src/permissions.js";

/** The helpers in a fake After Effects whose setting is `state`, and its `system` global. */
function helpers(state: boolean | "unreadable" | undefined) {
  const f = fakeAE({ writeAccess: state });
  const { system } = fakeWriteAccess(state ?? "unreadable");
  return { aemcp: loadHelpers(f, { system }), system };
}
const run = (state: boolean | "unreadable" | undefined, fn: (system: any) => unknown) => {
  const h = helpers(state);
  return JSON.parse(h.aemcp.run(() => fn(h.system), {}, { undoGroup: false }));
};
const text = (r: any) => (formatResult(r).content[0] as any).text as string;

describe("aemcp.canWriteFiles", () => {
  it("reads the preference: 1 = on, 0 = off, null when it can't be read (no test write: off, scripts still write files)", () => {
    expect(helpers(true).aemcp.canWriteFiles()).toBe(true);
    expect(helpers(false).aemcp.canWriteFiles()).toBe(false);
    expect(helpers("unreadable").aemcp.canWriteFiles()).toBeNull();
    expect(helpers(undefined).aemcp.canWriteFiles()).toBeNull(); // no app.preferences at all
  });
});

describe("a shell command while the setting is off", () => {
  it("fails with After Effects' Permission denied, and gets the hint that says where to turn it on", () => {
    const r = run(false, (system) => system.callSystem("echo hi"));
    expect(r.ok).toBe(false);
    expect(r.writeAccess).toBe(false);
    expect(text(r)).toBe(
      "Error: Permission denied (is Preferences > Scripting & Expressions > Allow Scripts to Write Files and Access Network enabled?)\n\n" + WRITE_ACCESS_HINT,
    );
    expect(WRITE_ACCESS_HINT).toBe(
      "Note: 'Allow Scripts to Write Files and Access Network' is off in After Effects, so scripts can't run shell commands " +
        "(system.callSystem) or use the network. If the script needs that, ask the user to turn it on in After Effects > Settings > " +
        "Scripting & Expressions (Windows: Edit > Preferences > Scripting & Expressions).",
    );
  });

  it("works while it is on; other failures get no hint, also while it is off", () => {
    expect(run(true, (system) => system.callSystem("echo hi"))).toMatchObject({ ok: true, result: "hi\n" });
    const other = run(false, () => {
      throw new Error("Unable to save the project");
    });
    expect(other.writeAccess).toBe(false);
    expect(text(other)).toBe("Error: Unable to save the project");
    // the setting not known (or on): no hint even for a Permission denied
    expect(text(run(undefined, (system) => system.callSystem("echo hi")))).not.toContain("Note:");
    expect(run(false, () => 1).writeAccess).toBeUndefined();
  });
});
