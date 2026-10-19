// `surehand-ae test --json`: the quick self-test as structured checks, in a temporary home with no After Effects.
import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "surehand-selftest-"));
process.env.HOME = process.env.USERPROFILE = home;
process.env.APPDATA = join(home, "AppData", "Roaming");
process.env.SUREHAND_AE_NO_UPDATE_CHECK = "1";

/** A port nothing listens on. */
const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as any).port;
      s.close(() => r(p));
    });
  });

describe("test --json", () => {
  it("prints [{name, ok, detail, fix?}]: what is wrong and what to do about it", async () => {
    process.env.SUREHAND_AE_BRIDGE_PORT = String(await freePort());
    const { selftestJson } = await import("../src/cli/selftest.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await selftestJson();
    const checks = JSON.parse(log.mock.calls.at(-1)![0]);
    log.mockRestore();
    expect(code).toBe(1);
    for (const c of checks) {
      expect(Object.keys(c).every((k) => ["name", "ok", "detail", "fix", "warning"].includes(k))).toBe(true);
      expect(typeof c.detail).toBe("string");
    }
    const by = Object.fromEntries(checks.map((c: any) => [c.name, c]));
    expect(by.config).toEqual({ name: "config", ok: false, detail: `No config at ${join(home, ".surehand", "ae", "config.json")}.`, fix: "Run the installer (1. Install) again." });
    expect(by.extension).toMatchObject({ ok: false, fix: expect.any(String) });
    expect(by.bridge).toMatchObject({ ok: false, detail: expect.stringMatching(/^Bridge not reachable/), fix: expect.stringMatching(/After Effects running/) });
    expect(checks.at(-1).name).toBe("bridge"); // nothing after an unreachable bridge
  });

  it("a configured installation passes its installation checks", async () => {
    const A = join(home, ".surehand", "ae");
    mkdirSync(A, { recursive: true });
    writeFileSync(join(A, "config.json"), JSON.stringify({ token: "x".repeat(48), bridgePort: 8765, httpPort: 8766 }));
    const { quickChecks } = await import("../src/cli/selftest.js");
    const checks = await quickChecks(false);
    expect(checks.find((c) => c.name === "config")).toEqual({ name: "config", ok: true, detail: `Config ${join(A, "config.json")}` });
  });
});
