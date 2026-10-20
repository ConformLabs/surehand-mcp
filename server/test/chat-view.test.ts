// The Chat screen's pure logic in the panel model (extension/js/panel-model.js): the boards' states (ChatStart,
// ChatWorking, ChatAsk, and ChatSignIn: "AI apps for chat"), the conversation built from the runner's events, and the tool rows.
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const UI = require("../../extension/js/panel-model.js");

describe("the Chat screen (chatView, chatApply, chatToolView)", () => {
  const codex = { id: "codex", label: "Codex", found: true, signedIn: true, account: "ChatGPT", path: "/opt/homebrew/bin/codex" };
  const claude = { id: "claude", label: "Claude Code", found: true, signedIn: true, account: "Claude" };
  const agy = { id: "agy", label: "Antigravity", found: true, signedIn: null, connected: true };
  const none = (id: string, label: string) => ({ id, label, found: false, signedIn: null });
  const view = (c: any, platform = "darwin") => UI.chatView({ items: [], running: false, asking: false, ...c }, platform);

  it("looking for the agents; none ready: the AI apps screen instead", () => {
    expect(view({ agents: null }).status).toEqual({ glyph: "pending", text: "Looking for your AI apps…" });
    const v = view({ agents: [{ ...codex, signedIn: false }, none("claude", "Claude Code"), none("agy", "Antigravity")], agent: "codex" });
    expect(v.apps).toBe(true);
    expect(v.status).toEqual({ glyph: "notrun", text: "No AI app ready" });
    expect(v.button).toEqual({ text: "Send", main: false, disabled: true });
  });

  it("ChatStart: only the ready apps (three or two equal segments, one: its name), what it does, Add another, what to try", () => {
    const v = view({ agents: [codex, claude, agy], agent: "codex" });
    expect(v.status).toEqual({ glyph: "verified", text: "Codex · signed in with ChatGPT" });
    expect(v.picker).toEqual([{ id: "codex", label: "Codex", checked: true }, { id: "claude", label: "Claude Code", checked: false }, { id: "agy", label: "Antigravity", checked: false }]);
    expect(v.single).toBeNull();
    expect(v.desc).toBe("Only AI apps that are installed and signed in are listed. Each runs on its own sign-in and works in this project through Surehand, under the same Full / Ask / Read-only setting.");
    expect(v.addLink).toBe("Add another AI app ›");
    expect(v.tries).toHaveLength(3);
    expect(v.input).toEqual({ disabled: false, placeholder: "Ask about this project, or describe an edit…" });
    expect(v.hint).toBe("Enter sends · Shift+Enter new line");
    expect(v.button).toEqual({ text: "Send", main: true, disabled: false });
    expect(v.newChat.disabled).toBe(true);
    // not signed in or not installed: not listed
    expect(view({ agents: [codex, { ...claude, signedIn: false }, none("agy", "Antigravity")], agent: "codex" })).toMatchObject({ picker: null, single: "Codex" });
    expect(view({ agents: [codex, claude, none("agy", "Antigravity")], agent: "claude" }).picker.map((p: any) => p.label)).toEqual(["Codex", "Claude Code"]);
  });

  it("ChatWorking and ChatAsk: header, field, hint and Stop", () => {
    const items = [{ kind: "user", text: "hi", at: "2026-10-20T20:10:00Z" }];
    const w = view({ agents: [codex], agent: "codex", items, running: true });
    expect(w.status).toEqual({ glyph: "waiting", text: "Codex is working…" });
    expect(w.input).toEqual({ disabled: true, placeholder: "Codex is working…" });
    expect(w.hint).toBe("Every edit is also in the activity list");
    expect(w.button).toEqual({ text: "Stop", main: false, disabled: false });
    expect(w.newChat.disabled).toBe(false);
    expect(w.picker).toBeNull();
    const a = view({ agents: [codex], agent: "codex", items, running: true, asking: true });
    expect(a.status).toEqual({ glyph: "waiting", text: "Waiting for you · Ask mode" });
    expect(a.input.placeholder).toBe("Codex is waiting for your OK…");
    expect(a.hint).toBe("Deny tells Codex it wasn’t allowed");
  });

  it("AI apps for chat (ChatSignIn): each app's own state, how to sign in or install, in Terminal or PowerShell", () => {
    const v = UI.chatAppsView([codex, { ...claude, signedIn: false, authText: "Not logged in" }, none("agy", "Antigravity")], "darwin");
    expect(v.title).toBe("AI apps for chat");
    expect(v.sub).toBe("1 ready · 2 need setting up");
    expect(v.foot).toBe("Surehand never sees your sign-in. Each AI app keeps its own.");
    expect(v.rows).toEqual([
      { id: "codex", label: "Codex", glyph: "verified", word: "Ready", lines: ["Signed in with ChatGPT."] },
      { id: "claude", label: "Claude Code", glyph: "notrun", word: "Not signed in",
        lines: ["Installed. To sign in, open Terminal and run:", { report: "claude auth login" }, "Sign in in the browser, then press Check again.", { says: "Not logged in" }] },
      { id: "agy", label: "Antigravity", glyph: "pending", word: "Not installed",
        lines: ["Google’s Antigravity command-line tool. Install it from antigravity.google, then in Terminal run:", { report: "agy" },
          "Sign in the first time it starts, then press Check again. Surehand asks before it connects to Antigravity."] },
    ]);
    const w = UI.chatAppsView([{ ...codex, signedIn: false }, none("claude", "Claude Code"), { ...agy, signedIn: false }], "win32");
    expect(w.sub).toBe("0 ready · 3 need setting up");
    expect(w.rows[0].lines).toEqual(["Installed. To sign in, open PowerShell and run:", { report: "codex login" }, "Sign in in the browser, then press Check again."]);
    expect(w.rows[1].lines).toEqual(["Anthropic’s Claude Code. Install it from claude.com/claude-code, then in PowerShell run:", { report: "claude auth login" }, "Sign in in the browser, then press Check again."]);
    expect(w.rows[2].lines).toEqual(["Installed. To sign in, open PowerShell and run:", { report: "agy" }, "Sign in the first time it starts, then press Check again.", "Surehand asks before it connects to Antigravity."]);
    expect(UI.chatAppsView([none("codex", "Codex")], "darwin").rows[0].lines[0]).toMatch(/npm install -g @openai\/codex.*brew install --cask codex/);
    // Codex from the desktop app on Windows: sign in there
    const app = UI.chatAppsView([{ ...codex, signedIn: false, path: "C:\\Users\\r\\AppData\\Local\\OpenAI\\Codex\\bin\\ab12\\codex.exe" }], "win32");
    expect(app.rows[0].lines).toEqual(["Installed with the Codex app. Open it and sign in with ChatGPT, then press Check again."]);
    // all ready
    expect(UI.chatAppsView([codex, claude, { ...agy, signedIn: true, connected: false }], "darwin").sub).toBe("3 ready");
    expect(UI.chatAppsView([codex, claude, { ...agy, signedIn: true, connected: false }], "darwin").rows[2].lines).toEqual(["Signed in.", "Surehand asks before it connects to Antigravity."]);
  });

  it("a turn that says the agent isn't signed in: what to do, another app offered, Send off", () => {
    const items = [{ kind: "user", text: "hi" }];
    const v = view({ agents: [codex, { ...claude, signedIn: false, authText: "Not logged in · Please run /login" }], agent: "claude", items });
    expect(v.status).toEqual({ glyph: "notrun", text: "Claude Code · not signed in" });
    expect(v.note).toMatchObject({ kind: "signin", title: "Sign in to Claude Code first", says: "Not logged in · Please run /login",
      buttons: [{ id: "apps", text: "How to sign in" }, { id: "use:codex", text: "Use Codex instead" }] });
    expect(v.input).toEqual({ disabled: true, placeholder: "Sign in to Claude Code to chat" });
    expect(v.button.disabled).toBe(true);
  });

  it("Antigravity: connected once, on the user's click", () => {
    const v = view({ agents: [codex, { ...agy, connected: false }], agent: "agy" });
    expect(v.status).toEqual({ glyph: "notrun", text: "Antigravity · not connected" });
    expect(v.note.kind).toBe("connect");
    expect(v.note.buttons[0]).toEqual({ id: "connect", text: "Connect", main: true });
    expect(view({ agents: [{ ...agy, signedIn: true }], agent: "agy" }).status.text).toBe("Antigravity · signed in");
  });

  it("picks the agent: the one chosen before if ready, else the first ready; the menu's line", () => {
    const list = [{ ...codex, signedIn: false }, claude];
    expect(UI.chatPick(list, null)).toBe("claude");
    expect(UI.chatPick(list, "codex")).toBe("claude");
    expect(UI.chatPick([codex, claude], "claude")).toBe("claude");
    expect(UI.chatPick([none("codex", "Codex")], "codex")).toBeNull();
    expect(UI.chatMenuSub(null, null)).toBe("Codex, Claude Code or Antigravity");
    expect(UI.chatMenuSub([codex], "codex")).toBe("Codex · signed in");
    expect(UI.chatMenuSub([none("codex", "Codex")], null)).toBe("No AI app ready: set one up");
  });
  it("builds the conversation from the runner's events", () => {
    const c: any = { agents: [{ ...claude }], agent: "claude", items: [{ kind: "user", text: "hi" }], running: true, replyHead: true };
    const at = "2026-10-20T20:10:00Z";
    for (const ev of [
      { type: "session", id: "s1" },
      { type: "text", delta: "Reading " }, { type: "text", delta: "the comp." },
      { type: "tool", phase: "start", id: "t1", name: "ae_get_comp_info", args: { comp: "Main" } },
      { type: "tool", phase: "end", id: "t1", name: "ae_get_comp_info", ok: true },
      { type: "text", id: "m2", text: "Main" }, { type: "text", id: "m2", text: "Main has 3 layers." },
      { type: "tool", phase: "start", id: "t2", name: "ae_render_frame" },
    ]) UI.chatApply(c, ev, at);
    expect(c.session).toBe("s1");
    expect(c.items.map((x: any) => [x.kind, x.text ?? x.name, x.head ?? false, x.state ?? null])).toEqual([
      ["user", "hi", false, null], ["agent", "Reading the comp.", true, null], ["tool", "ae_get_comp_info", false, "done"], ["agent", "Main has 3 layers.", false, null], ["tool", "ae_render_frame", false, "running"],
    ]);
    UI.chatApply(c, { type: "done", ok: true, stopped: true, session: "s1" }, at);
    expect(c.running).toBe(false);
    expect(c.items[4].state).toBe("stopped");
    expect(c.items[5]).toMatchObject({ kind: "notice", text: "Stopped." });
    // a turn that says it isn't signed in: the agent shows as not signed in, with its words
    UI.chatApply(c, { type: "error", message: "Not logged in · Please run /login", auth: true }, at);
    expect(c.agents[0]).toMatchObject({ signedIn: false, authText: "Not logged in · Please run /login" });
  });

  it("tool rows: running, refused, failed, and the feed's row once the activity log has it", () => {
    const t = { kind: "tool", id: "t", name: "ae_set_keyframes", args: { comp: "Main", layer: "Title", property: "Position" }, startedAt: "2026-10-20T20:10:00.000Z" };
    expect(UI.chatToolView({ ...t, state: "running" })).toEqual({ glyph: "pending", title: "Set keyframes", word: "Running", line: "Main › Title › Position", muted: true, list: null });
    expect(UI.chatToolView({ ...t, state: "failed", error: "You denied this change in the Surehand panel." })).toMatchObject({ glyph: "notrun", word: "Not run", line: "You denied it." });
    expect(UI.chatToolView({ ...t, state: "failed", error: "Error: Cannot reach After Effects" })).toMatchObject({ glyph: "failed", word: "Failed", line: "After Effects wasn’t reachable. Is it open?" });
    expect(UI.chatToolView({ kind: "tool", name: "shell", builtin: true, state: "failed", args: { command: "ls" } })).toMatchObject({ title: "Shell command", word: "Not run", line: "Not allowed in the chat." });
    const entry = { at: "2026-10-20T20:10:01.000Z", tool: "ae_set_keyframes", args: { comp: "Main", layer: "Title" }, ok: true, ms: 10, changes: 2, changeList: ['~ layer "Title" in "Main": Position: 10 -> 12'] };
    const older = { ...entry, at: "2026-10-20T20:00:00.000Z" };
    expect(UI.chatEntryFor({ ...t, state: "done" }, [entry, older], {})).toBe(entry);
    expect(UI.chatEntryFor({ ...t, state: "done" }, [entry], { [UI.entryKey(entry)]: true })).toBeNull();
    expect(UI.chatToolView({ ...t, state: "done" }, entry)).toMatchObject({ glyph: "changed", word: "Changed", title: "Set keyframes", list: entry.changeList });
    expect(UI.clientName("antigravity-cli")).toBe("Antigravity");
  });
});
