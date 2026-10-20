// Server-side safeguards: a config that can't be read fails closed, approval texts, what the panel's
// Undo needs in the activity log, the panel's own read-only checks, render file housekeeping.
import { beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resetConfigCache } from "../src/config.js";
import { approvalSummary, permissions, READ_ONLY_REFUSAL, scriptFileApproval } from "../src/permissions.js";
import { activityDetails } from "../src/activity.js";
import { pruneRenders } from "../src/tools/renderjobs.js";
import { callContext, type CallContext } from "../src/context.js";

let home = "";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "surehand-safety-"));
  process.env.HOME = process.env.USERPROFILE = home;
  delete process.env.SUREHAND_AE_CONFIG;
  delete process.env.AEMCP_CONFIG;
  resetConfigCache();
});
const cfgFile = () => join(home, ".surehand", "ae", "config.json");
const putCfg = (text: string) => {
  mkdirSync(join(home, ".surehand", "ae"), { recursive: true });
  writeFileSync(cfgFile(), text);
};

describe("config.json that can't be read (H3)", () => {
  it("fails closed: no token, read-only and no shell, with a refusal that says why", () => {
    putCfg('{"token": "abc", "permissions": {"mode": "full"');
    const cfg = loadConfig();
    expect(cfg.token).toBe("");
    expect(cfg.unreadable).toMatch(/config\.json: it isn't valid JSON/);
    expect(permissions()).toMatchObject({ mode: "read-only", allowShell: false });
    expect(READ_ONLY_REFUSAL).toMatch(/settings file can't be read .*Nothing was run/);
    putCfg(JSON.stringify({ token: "t1", permissions: { mode: "full" } }));
    expect(permissions()).toEqual({ mode: "full", allowShell: true });
    expect(READ_ONLY_REFUSAL).toMatch(/read-only mode/);
  });

  it("a torn read uses the last good config (never defaults, which would mean full permissions)", () => {
    putCfg(JSON.stringify({ token: "t1", permissions: { mode: "ask", allowShell: false }, paused: true }));
    expect(permissions()).toEqual({ mode: "ask", allowShell: false });
    putCfg('{"token": "t1", "perm');
    expect(permissions()).toEqual({ mode: "ask", allowShell: false });
    expect(loadConfig().token).toBe("t1");
    putCfg("﻿" + JSON.stringify({ token: "t2" })); // a BOM is fine
    expect(loadConfig().token).toBe("t2");
  });
});

describe("ensureConfig never replaces a config it can't read (H3)", () => {
  it("throws and leaves the file; fills in a readable one atomically, readable only by the user", async () => {
    const { ensureConfig } = await import("../src/cli/setup.js");
    putCfg('{"permissions": {"mode": "ask"}, "tok');
    expect(() => ensureConfig()).toThrow(/can't be read .*left as it is/);
    expect(readFileSync(cfgFile(), "utf8")).toBe('{"permissions": {"mode": "ask"}, "tok');
    putCfg(JSON.stringify({ permissions: { mode: "ask" } }));
    expect(ensureConfig()).toBe(true);
    const cfg = JSON.parse(readFileSync(cfgFile(), "utf8"));
    expect(cfg).toMatchObject({ permissions: { mode: "ask" }, bridgePort: 8765, httpPort: 8766, token: expect.stringMatching(/^[0-9a-f]{48}$/) });
    if (process.platform !== "win32") expect((await import("node:fs")).statSync(cfgFile()).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(home, ".surehand", "ae")).sort()).toEqual(["config.json", "sessions"]); // no temporary file left
  });
});

describe("approval texts (M3)", () => {
  it("are sent in full (the bridge shortens what it shows and checks all of it)", () => {
    const big = { layer: "x".repeat(5000) };
    expect(approvalSummary("ae_set_property", big)).toBe(JSON.stringify(big));
  });

  it("ae_run_script_file shows the file: its path and first 4000 characters, saying how much more there is", () => {
    const src = "// harmless start\n" + "a();\n".repeat(1000) + "system.callSystem('rm -rf ~');";
    const a = scriptFileApproval("/scripts/tidy.jsx", src);
    expect(a.tool).toBe("Run script file");
    expect(a.summary.startsWith("/scripts/tidy.jsx\n\n// harmless start")).toBe(true);
    expect(a.summary).toMatch(new RegExp(`\\n… ${src.length - 4000} more characters not shown$`));
    expect(a.summary).not.toContain("callSystem");
    expect(a.full).toContain("callSystem"); // what the bridge checks for risks
    expect(scriptFileApproval("/s.jsx", "").summary).toMatch(/could not be read here/);
  });
});

describe("what the panel's Undo needs (M5)", () => {
  it("the activity entry records the project, the undo steps and the After Effects that ran the call", () => {
    const d = activityDetails("ae_set_property", "OK", { undoGroup: "Set property", revision: 9, project: "/w/Spot.aep" }, { undoSteps: 1, instance: { port: 8765, pid: 77 } });
    expect(d).toEqual({ undoGroup: "Set property", revision: 9, project: "/w/Spot.aep", undoSteps: 1, instance: { port: 8765, pid: 77 } });
    expect(activityDetails("ae_batch", "OK", { undoGroup: "B", revision: 3 }, { undoSteps: 4 }).undoSteps).toBe(4);
  });
});

describe("the panel's own read-only checks run as the panel (L7) and record the instance (M5)", () => {
  it("with SUREHAND_AE_PANEL_SECRET (set by the panel only) jobs carry the secret and fromPanel", async () => {
    const seen: any[] = [];
    const srv = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        seen.push({ secret: req.headers["x-surehand-panel"], body: b ? JSON.parse(b) : null });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result: "r", instance: { port: 4321, pid: 99 } }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as any).port;
    putCfg(JSON.stringify({ token: "t", bridgePort: port }));
    process.env.SUREHAND_AE_BRIDGE_PORT = String(port);
    const { evalRaw } = await import("../src/bridge.js");
    try {
      const ctx: CallContext = { tool: "x" };
      await callContext.run(ctx, () => evalRaw("1", 5000));
      expect(seen[0].secret).toBeUndefined();
      expect(seen[0].body.fromPanel).toBeUndefined();
      expect(ctx.instance).toEqual({ port: 4321, pid: 99 });
      process.env.SUREHAND_AE_PANEL_SECRET = "s".repeat(64);
      await evalRaw("2", 5000);
      expect(seen[1].secret).toBe("s".repeat(64));
      expect(seen[1].body.fromPanel).toBe(true);
    } finally {
      delete process.env.SUREHAND_AE_PANEL_SECRET;
      delete process.env.SUREHAND_AE_BRIDGE_PORT;
      srv.close();
    }
  });
});

describe("renders/ keeps the newest 50 jobs (L5)", () => {
  it("removes the oldest jobs' files, never a running one", () => {
    const dir = join(home, "renders");
    mkdirSync(dir);
    for (let i = 0; i < 60; i++) {
      const id = `r${(1000 + i).toString(36)}`;
      for (const ext of ["log", "json"]) {
        writeFileSync(join(dir, `${id}.${ext}`), "x");
        utimesSync(join(dir, `${id}.${ext}`), 1_700_000_000 + i, 1_700_000_000 + i);
      }
    }
    writeFileSync(join(dir, "notes.txt"), "not a render");
    const oldest = `r${(1000).toString(36)}`;
    pruneRenders(dir, 50, new Set([oldest]));
    const left = readdirSync(dir);
    expect(left.filter((f) => f.endsWith(".log"))).toHaveLength(51);
    expect(left).toContain(`${oldest}.log`); // still running
    expect(left).not.toContain(`r${(1001).toString(36)}.log`);
    expect(left).toContain(`r${(1059).toString(36)}.json`);
    expect(left).toContain("notes.txt");
  });
});

describe("install's closing message (L6)", () => {
  it("names the server in the ChatGPT desktop line (no literal ${SERVER_NAME})", () => {
    const src = readFileSync(new URL("../src/cli/install.ts", import.meta.url), "utf8");
    expect(src).not.toContain('"  ChatGPT desktop app: restart it; ${SERVER_NAME}');
    expect(src).toContain("`  ChatGPT desktop app: restart it; ${SERVER_NAME} appears");
  });
});
