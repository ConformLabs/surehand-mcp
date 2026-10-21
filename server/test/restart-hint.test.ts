// After an update while After Effects keeps running, AE still runs the previous Surehand panel (bridge) until it is
// restarted. Failed calls and unverified rollbacks then say so (the server here is vtest).
import { describe, expect, it } from "vitest";
import { noteBridgeVersion, restartToFinishUpdate, staleBridgeVersion } from "../src/bridge.js";
import { rollbackProblem } from "../src/jsx.js";
import { callContext } from "../src/context.js";
import { withRestartHint } from "../src/tools/profile.js";

const HINT = "After Effects is still running the previous Surehand panel (v1.4.0-beta.3). Restart After Effects to finish the update.";

describe("a bridge of another version", () => {
  noteBridgeVersion(61001, "1.4.0-beta.3");
  noteBridgeVersion(61002, "test");

  it("is known by port; the same version is not stale", () => {
    expect(staleBridgeVersion(61001)).toBe("1.4.0-beta.3");
    expect(staleBridgeVersion(61002)).toBeNull();
    expect(restartToFinishUpdate("1.4.0-beta.3")).toBe(HINT);
  });

  it("a failed call gets the hint once; a call that worked, or one on a current bridge, doesn't", () => {
    const failed = { isError: true, content: [{ type: "text", text: "Error: something went wrong" }] };
    const r = withRestartHint(failed, 61001);
    expect(r.content.map((c: any) => c.text)).toEqual(["Error: something went wrong", HINT]);
    expect(withRestartHint(r, 61001).content).toHaveLength(2);
    expect(withRestartHint(failed, 61002)).toBe(failed);
    const ok = { content: [{ type: "text", text: "OK" }] };
    expect(withRestartHint(ok, 61001)).toBe(ok);
  });

  it("an unverified rollback (the read-only self-test step) says why it may have failed", () => {
    const rb = { undone: true, verified: false as const, problem: "not this call" };
    const stale = callContext.run({ tool: "ae_run_script", instance: { port: 61001 } }, () => rollbackProblem(rb, "the script"));
    expect(stale).toMatch(/Edit > Undo was run once for the script/);
    expect(stale.endsWith(`\n${HINT}`)).toBe(true);
    const current = callContext.run({ tool: "ae_run_script", instance: { port: 61002 } }, () => rollbackProblem(rb, "the script"));
    expect(current).not.toMatch(/Restart After Effects/);
    // a verified rollback has nothing to say
    expect(callContext.run({ tool: "ae_run_script", instance: { port: 61001 } }, () => rollbackProblem({ undone: true, verified: true }, "the script"))).toBe("");
  });
});
