import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("permissions come from ~/.aemcp/config.json", () => {
  it("reads mode and allowShell (regression: loadConfig dropped them)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aemcp-perm-"));
    const file = join(dir, "config.json");
    process.env.AEMCP_CONFIG = file;
    const { permissions, usesShell, approvalSummary } = await import("../src/permissions.js");
    writeFileSync(file, JSON.stringify({ token: "x", permissions: { mode: "read-only", allowShell: false } }));
    expect(permissions()).toEqual({ mode: "read-only", allowShell: false });
    writeFileSync(file, JSON.stringify({ token: "x", permissions: { mode: "ask" } }));
    expect(permissions()).toEqual({ mode: "ask", allowShell: true });
    writeFileSync(file, JSON.stringify({ token: "x", permissions: { mode: "nonsense" } }));
    expect(permissions().mode).toBe("full");
    writeFileSync(file, JSON.stringify({ token: "x" }));
    expect(permissions()).toEqual({ mode: "full", allowShell: true });
    expect(usesShell("system.callSystem('ls')")).toBe(true);
    expect(usesShell("system['call' + 'System']('ls')")).toBe(true);
    expect(usesShell("app.project.numItems")).toBe(false);
    expect(approvalSummary("ae_run_script", { code: "return 1;" })).toBe("return 1;");
  });
});
