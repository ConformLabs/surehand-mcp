// The panel's pure logic (extension/js/panel-model.js) and the shared file locations (extension/js/paths.js).
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { posix } from "node:path";

const require = createRequire(import.meta.url);
const UI = require("../../extension/js/panel-model.js");
const Paths = require("../../extension/js/paths.js");

describe("file locations (paths.js)", () => {
  const resolve = (files: string[], env: Record<string, string> = {}) =>
    Paths.resolve({ path: posix, home: "/u", env, exists: (p: string) => files.includes(p) });

  it("uses ~/.surehand/ae, with node and ffmpeg shared under ~/.surehand", () => {
    const p = resolve(["/u/.surehand/ae/config.json", "/u/.aemcp/config.json"]);
    expect(p).toMatchObject({
      legacy: false, root: "/u/.surehand", dir: "/u/.surehand/ae", config: "/u/.surehand/ae/config.json",
      instances: "/u/.surehand/ae/instances", activity: "/u/.surehand/ae/activity.jsonl", runtime: "/u/.surehand/ae/runtime.json",
      updateCheck: "/u/.surehand/ae/update-check.json", bridgeStatus: "/u/.surehand/ae/bridge-status.json",
      checkpoints: "/u/.surehand/ae/checkpoints", renders: "/u/.surehand/ae/renders", node: "/u/.surehand/node", ffmpeg: "/u/.surehand/ffmpeg",
    });
  });

  it("a fresh install (nothing yet) also uses ~/.surehand/ae", () => {
    expect(resolve([]).config).toBe("/u/.surehand/ae/config.json");
  });

  it("falls back to ~/.aemcp for everything on a 1.3 install that isn't migrated", () => {
    const p = resolve(["/u/.aemcp/config.json"]);
    expect(p).toMatchObject({
      legacy: true, dir: "/u/.aemcp", config: "/u/.aemcp/config.json", instances: "/u/.aemcp/instances", activity: "/u/.aemcp/activity.jsonl",
      renders: "/u/.aemcp/renders", checkpoints: "/u/.aemcp/checkpoints", node: "/u/.aemcp/node", ffmpeg: "/u/.aemcp/ffmpeg",
    });
  });

  it("SUREHAND_AE_CONFIG / AEMCP_CONFIG name the config, and the files live next to it", () => {
    expect(resolve(["/u/.aemcp/config.json"], { AEMCP_CONFIG: "/tmp/x/config.json" })).toMatchObject({ legacy: false, dir: "/tmp/x", instances: "/tmp/x/instances" });
    expect(resolve([], { SUREHAND_AE_CONFIG: "/a/c.json", AEMCP_CONFIG: "/b/c.json" }).config).toBe("/a/c.json");
  });
});

describe("layout", () => {
  it("narrow below 260 px, two columns when wide and short, else the default", () => {
    expect(UI.layoutFor(220, 560)).toBe("narrow");
    expect(UI.layoutFor(259, 200)).toBe("narrow");
    expect(UI.layoutFor(260, 560)).toBe("default");
    expect(UI.layoutFor(320, 560)).toBe("default");
    expect(UI.layoutFor(760, 200)).toBe("wide");
    expect(UI.layoutFor(760, 300)).toBe("wide");
    expect(UI.layoutFor(760, 420)).toBe("default"); // wide but tall: one column
    expect(UI.layoutFor(560, 200)).toBe("default");
  });
});

describe("status", () => {
  it("bridge problems, then paused, then waiting, then not connected, then ready with the AI app", () => {
    expect(UI.statusFor({ bridgeError: "Bridge not running", paused: true })).toMatchObject({ kind: "problem", tile: "gray" });
    expect(UI.statusFor({ paused: true, pendingCount: 2 })).toMatchObject({ kind: "paused", tile: "amber", text: "AI paused" });
    expect(UI.statusFor({ pendingCount: 2, everConnected: true })).toMatchObject({ kind: "waiting", text: "Waiting for you · 2 requests" });
    expect(UI.statusFor({ pendingCount: 1 }).text).toBe("Waiting for you");
    expect(UI.statusFor({ everConnected: false })).toMatchObject({ kind: "idle", tile: "gray", text: "No AI app connected" });
    expect(UI.statusFor({ everConnected: true, client: "Claude Desktop" })).toMatchObject({ kind: "ready", tile: "green", text: "Ready · Claude Desktop" });
  });
  it("names AI apps for people, from the most recent call", () => {
    expect(UI.clientName("claude-ai")).toBe("Claude Desktop");
    expect(UI.clientName("claude-code")).toBe("Claude Code");
    expect(UI.clientName("cursor-vscode")).toBe("Cursor");
    expect(UI.clientName("my-tool")).toBe("My Tool");
    expect(UI.lastClient([{ tool: "x" }, { tool: "y", client: "claude-code" }, { tool: "z", client: "claude-ai" }])).toBe("Claude Code");
  });
  it("mode texts follow the boards", () => {
    expect(UI.MODES.map((m: any) => m.label)).toEqual(["Full", "Ask", "Read-only"]);
    expect(UI.MODES[1].desc).toBe("Every change waits for your OK in this panel. Looking at the project is always allowed.");
    expect(UI.modeOf({ permissions: { mode: "ask" } })).toBe("ask");
    expect(UI.modeOf({})).toBe("full");
  });
});

describe("feed", () => {
  const at = (m: number) => new Date(Date.UTC(2026, 9, 19, 16, m)).toISOString();
  const log = [
    {
      at: at(42), client: "claude-ai", tool: "ae_set_keyframes", args: { layer: "Title", comp: "Main" }, ms: 120, ok: true, summary: '{"keys":2}', changes: 2,
      undoGroup: "Set keyframes", undoSteps: 1, revision: 812, project: "/work/Spot.aep", instance: { port: 8765, pid: 4242 },
    },
    { at: at(40), tool: "ae_apply_effect", args: { effect: "Deep Glow" }, ms: 50, ok: false, summary: "Effect not found: Deep Glow" },
    { at: at(31), tool: "ae_prove_identical", args: {}, ms: 900, ok: true, summary: "Verdict: IDENTICAL: all 5 frames are bit-identical to the reference." },
    { at: at(30), tool: "ae_get_comp_info", args: { comp: "Main" }, ms: 30, ok: true, summary: "{}" },
    { at: at(20), tool: "ae_preflight", args: { spec: { name: "Channel 4 HD" }, comp: "Main" }, ms: 5000, ok: true, summary: "FAIL (3)" },
    { at: at(10), tool: "ae_call", args: { tool: "ae_preflight", args: {} }, ms: 5000, ok: true, summary: "PASS" },
  ];

  it("turns log entries into readable items", () => {
    const items = UI.feedItems(log, { limit: 10 });
    expect(items.map((i: any) => [i.kind, i.title])).toEqual([
      ["change", "Set keyframes"],
      ["problem", "Apply effect failed"],
      ["proof", "Proven identical"],
      ["read", "Read comp Main"],
      ["problem", "Preflight: 3 problems"],
      ["proof", "Preflight passed"],
    ]);
    expect(items[0].line).toBe("Title in Main · 2 changes");
    expect(items[1].line).toBe("Effect not found: Deep Glow");
    expect(items[2].line).toBe("5 frames");
    expect(items[4].line).toBe("Channel 4 HD · Main");
  });

  // this After Effects with the project as the newest entry left it
  const here = { port: 8765, pid: 4242, project: "/work/Spot.aep", revision: 812 };

  it("offers Undo only on the newest entry, only if it changed the project and wasn't undone", () => {
    expect(UI.feedItems(log, { current: here }).map((i: any) => i.undoable)).toEqual([true, false, false, false, false, false]);
    expect(UI.feedItems(log.slice(1), { current: here }).some((i: any) => i.undoable)).toBe(false); // newest is a failure
    const undone = { [UI.entryKey(log[0])]: true };
    expect(UI.feedItems(log, { undone, current: here })[0].undoable).toBe(false);
    expect(UI.feedItems(log, { limit: 3 })).toHaveLength(3);
  });

  it("offers Undo only when Edit > Undo would undo exactly that call: same After Effects, same project, nothing since, one step", () => {
    const e = log[0];
    expect(UI.canUndo(e, here)).toBe(true);
    expect(UI.feedItems(log)[0].undoable).toBe(false); // current state not known
    expect(UI.canUndo(e, { ...here, revision: 813 })).toBe(false); // something changed the project since
    expect(UI.canUndo(e, { ...here, project: "/work/Other.aep" })).toBe(false); // another project is open
    expect(UI.canUndo(e, { ...here, port: 8766 })).toBe(false); // another After Effects ran it
    expect(UI.canUndo(e, { ...here, pid: 1 })).toBe(false); // After Effects was restarted
    expect(UI.canUndo({ ...e, undoSteps: 3 }, here)).toBe(false); // a batch made several undo steps
    expect(UI.canUndo({ ...e, undoSteps: undefined }, here)).toBe(false);
    expect(UI.canUndo({ ...e, undoGroup: undefined }, here)).toBe(false);
    expect(UI.canUndo({ ...e, revision: undefined }, here)).toBe(false);
    expect(UI.canUndo({ ...e, instance: undefined }, here)).toBe(false); // older servers didn't record it
    expect(UI.canUndo(e, null)).toBe(false);
  });

  it("uses the change report's lines when the log has them", () => {
    const e = { at: at(1), tool: "ae_set_property", ok: true, changes: 3, changeList: ['~ layer "Title" in "Main": Position', "~ Title > Opacity: 100 -> 0", "+ layer \"X\" in \"Main\""] };
    expect(UI.describeEntry(e).line).toBe("Title › Position · Title › Opacity: 100 -> 0 · +1");
    expect(UI.entryDetails(e)).toContain("Opacity");
  });

  it("reads aerender progress, from the activity entry or the log itself", () => {
    const info = UI.renderStartInfo({ summary: "Background render started: job r1abc (Main, 300 frames) from /p.aep." });
    expect(info).toEqual({ id: "r1abc", comp: "Main", frames: 300 });
    const log1 = "PROGRESS:  0;00;00;00 (1): 0 Seconds\nPROGRESS:  0;00;06;11 (192): 0 Seconds\n";
    expect(UI.renderProgress(log1, info)).toMatchObject({ done: false, frame: 192, frames: 300, pct: 64, comp: "Main" });
    const log2 = 'PROGRESS:  Starting composition “Titles”.\nPROGRESS:  Duration: 0:00:10:00\nPROGRESS:  Frame Rate: 30.00 (comp)\nPROGRESS:  0:00:02:14 (75): 1 Seconds\n';
    expect(UI.renderProgress(log2, null)).toMatchObject({ comp: "Titles", frames: 300, frame: 75, pct: 25 });
    expect(UI.renderProgress(log2 + "PROGRESS:  Total Time Elapsed: 1 Min\n", null).done).toBe(true);
    expect(UI.timeLeft(50, 60_000)).toBe("1:00 left");
    expect(UI.timeLeft(null, 60_000)).toBeNull();
  });
});

describe("approval card", () => {
  it("titles the card with the tool, quotes the AI's comment, and shows risk chips", () => {
    const v = UI.approvalView({ tool: "Run script", client: "claude-ai", summary: "// rebuild the lower thirds\nvar c = app.project.activeItem;\nc.layer(1).remove();\nc.layers.addText('x');" });
    // the AI wrote that comment: it is quoted, not presented as what the script does
    expect(v.title).toBe("Run script");
    expect(v.says).toBe("rebuild the lower thirds");
    expect(v.client).toBe("Claude Desktop");
    expect(v.chips).toEqual([
      { text: "deletes", danger: true },
      { text: "adds layers", danger: false },
    ]);
    expect(UI.approvalView({ tool: "Set property", summary: '{"layer":"Title"}' }, "Cursor")).toMatchObject({ title: "Set property", client: "Cursor" });
    expect(UI.riskChips("system.callSystem('rm -rf x')", "Run script")[0]).toEqual({ text: "runs a shell command", danger: true });
    // the bridge's chips (from the whole text) win over what the shortened text shows
    expect(UI.approvalView({ tool: "Run script", summary: "// just a tweak\nvar a = 1;", chips: [{ text: "runs a shell command", danger: true }] }).chips).toEqual([{ text: "runs a shell command", danger: true }]);
    expect(UI.approvalView({ tool: "Set property", summary: "{}" }).says).toBeNull();
  });
  it("counts down to the 10-minute limit", () => {
    const now = Date.parse("2026-10-19T16:00:00Z");
    expect(UI.countdown("2026-10-19T16:00:42Z", now)).toBe("0:42");
    expect(UI.countdown("2026-10-19T16:01:18Z", now)).toBe("1:18");
    expect(UI.countdown("2026-10-19T15:59:00Z", now)).toBe("0:00");
  });
  it("reads a CLI's JSON answer after any progress lines", () => {
    expect(UI.parseCliJson('downloading\n{"ok":true,"to":"1.4.1"}\n')).toEqual({ ok: true, to: "1.4.1" });
    expect(UI.parseCliJson("Surehand MCP selftest\nok")).toBeNull();
  });
});

describe("UX pass: refusals, readable errors, grouped reads, working row", () => {
  const e = (o: Record<string, unknown>) => ({ at: "2026-10-20T01:00:00.000Z", ok: true, summary: "", ...o });
  it("a call the user stopped (Pause, Deny, Read-only, shell off, no answer) is 'blocked', not a failure", () => {
    expect(UI.describeEntry(e({ tool: "ae_create_comp", ok: false, summary: "Paused in the Surehand panel: nothing was run. Ask the user to resume." }))).toMatchObject({ kind: "blocked", title: "Create comp", line: "Not run: the AI was paused" });
    expect(UI.describeEntry(e({ tool: "ae_run_script", ok: false, summary: "The user denied this change in After Effects (Surehand MCP panel)." }))).toMatchObject({ kind: "blocked", line: "You denied it" });
    expect(UI.describeEntry(e({ tool: "ae_run_script", ok: false, summary: "No one approved this change in the Surehand MCP panel within 10 minutes." })).line).toBe("Not run: no answer within 10 minutes");
    expect(UI.describeEntry(e({ tool: "ae_set_property", ok: false, summary: "Surehand MCP is in read-only mode, so tools that change the project are disabled." })).line).toBe("Not run: Read-only mode");
    expect(UI.describeEntry(e({ tool: "ae_run_script", ok: false, summary: "Shell commands (system.callSystem) are disabled in the Surehand MCP permissions." })).line).toBe("Not run: shell commands are off");
    // a script that read-only mode refused because it can't be undone is a real problem for the AI to fix
    expect(UI.describeEntry(e({ tool: "ae_run_script", ok: false, summary: "This script writes the project to disk, which read-only mode can't undo" })).kind).toBe("problem");
  });
  it("failures read as plain words, never as instructions meant for the AI", () => {
    expect(UI.readableError("Cannot reach After Effects. Make sure After Effects is running and the Surehand MCP bridge is loaded (it starts...)")).toBe("After Effects wasn’t reachable. Is it open?");
    expect(UI.readableError("After Effects is busy or showing a dialog: it has not accepted a script for 30s. Ask...")).toBe("After Effects was busy or showing a dialog.");
    expect(UI.readableError("Timed out after 120s waiting for After Effects (it may be busy).")).toBe("Took longer than 120 s: After Effects may have been busy.");
    expect(UI.readableError("Error: Layer 'Title' not found in comp 'Main'. Available: A, B")).toBe("Layer 'Title' not found in comp 'Main'.");
  });
  it("consecutive reads are one feed row; the next change still gets its own", () => {
    const log = [
      e({ tool: "ae_get_comp_info", args: { comp: "Main" } }),
      e({ tool: "ae_get_comp_info", args: { comp: "Main" } }),
      e({ tool: "ae_get_layer_info", args: { layer: "Title" } }),
      e({ tool: "ae_set_property", changes: 1 }),
      e({ tool: "ae_get_comp_info", args: { comp: "Main" } }),
      e({ tool: "ae_get_comp_info", args: { comp: "Main" } }),
    ];
    const items = UI.feedItems(log, { limit: 5 });
    expect(items.map((i: any) => [i.kind, i.title, i.line, i.count ?? 1])).toEqual([
      ["read", "Looked at the project", "Read comp Main · Read layer Title", 3],
      ["change", "Set property", "1 change", 1],
      ["read", "Read comp Main", "2 times", 2],
    ]);
    expect(UI.entryDetails(items[0].entry, items[0].group).split("\n")).toHaveLength(3);
  });
  it("says what the AI is doing right now, and when After Effects keeps it waiting", () => {
    expect(UI.workingView(null)).toBeNull();
    expect(UI.workingView({ busy: true, busyWith: "panel: project state" })).toBeNull();
    expect(UI.workingView({ busy: true, busyWith: "ae_create_comp", busyForMs: 3200 })).toEqual({ text: "Working · Create comp", time: "3 s", line: "", waiting: false });
    expect(UI.workingView({ busy: true, busyWith: "ae_run_script", waitingForMs: 9000 })).toMatchObject({ text: "Waiting for After Effects", waiting: true });
    // the bridge stopped answering: the panel is frozen with After Effects while a script runs; after a minute it says so
    expect(UI.workingView(null, 20_000)).toBeNull();
    expect(UI.workingView(null, 90_000)).toMatchObject({ text: "After Effects isn’t answering", waiting: true });
  });
});

describe("Preflight rows", () => {
  it("name a spec file by its file name, not its whole path", () => {
    const it = UI.describeEntry({ at: "2026-10-20T01:00:00Z", ok: true, tool: "ae_preflight", args: { spec: "C:/Users/Ron/AppData/Local/Temp/sh-pf/pf-spec.json", comp: "Main" }, summary: "PASS" });
    expect(it.line).toBe("pf-spec.json · Main");
  });
});

