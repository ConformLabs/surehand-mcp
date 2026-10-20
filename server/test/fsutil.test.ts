// Careful writes of settings files other programs read and write (src/fsutil.ts), in temporary folders.
import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupFile, BACKUPS_KEPT, readJsonFile, stripJsonc, UnreadableFileError, updateJsonFile, writeFileAtomic } from "../src/fsutil.js";

const dir = () => mkdtempSync(join(tmpdir(), "surehand-fsutil-"));

describe("reading settings files", () => {
  it("ignores a BOM, and tells a missing file from one that can't be read", () => {
    const d = dir();
    writeFileSync(join(d, "bom.json"), "﻿" + JSON.stringify({ mcpServers: {} }));
    expect(readJsonFile(join(d, "bom.json"))).toMatchObject({ ok: true, data: { mcpServers: {} } });
    expect(readJsonFile(join(d, "none.json"))).toEqual({ ok: false, missing: true });
    writeFileSync(join(d, "half.json"), '{"mcpServers": {"x": {"comm');
    expect(readJsonFile(join(d, "half.json"))).toMatchObject({ ok: false, error: expect.stringMatching(/isn't valid JSON/) });
    writeFileSync(join(d, "empty.json"), "");
    expect(readJsonFile(join(d, "empty.json"))).toMatchObject({ ok: false, error: expect.stringMatching(/empty/) });
  });

  it("accepts comments and trailing commas only where the app does (JSONC), leaving strings alone", () => {
    const text = '{\n  // my servers\n  "mcpServers": {\n    "web": { "url": "https://example.com/a//b", "note": "/* not a comment */", },\n  },\n  /* end */\n}\n';
    expect(JSON.parse(stripJsonc(text))).toEqual({ mcpServers: { web: { url: "https://example.com/a//b", note: "/* not a comment */" } } });
    const d = dir();
    writeFileSync(join(d, "mcp.json"), text);
    expect(readJsonFile(join(d, "mcp.json")).ok).toBe(false);
    expect(readJsonFile(join(d, "mcp.json"), { jsonc: true })).toMatchObject({ ok: true, data: { mcpServers: { web: { url: "https://example.com/a//b" } } } });
  });
});

describe("writing settings files", () => {
  it("writes atomically, keeps the file's permissions, and follows a symbolic link", () => {
    const d = dir();
    const f = join(d, "settings.json");
    writeFileSync(f, "{}");
    if (process.platform !== "win32") chmodSync(f, 0o640);
    writeFileAtomic(f, '{"a":1}');
    expect(readFileSync(f, "utf8")).toBe('{"a":1}');
    if (process.platform !== "win32") expect(statSync(f).mode & 0o777).toBe(0o640);
    expect(readdirSync(d)).toEqual(["settings.json"]); // no temporary file left
    if (process.platform !== "win32") {
      const real = join(d, "real.json"), link = join(d, "link.json");
      writeFileSync(real, "{}");
      symlinkSync(real, link);
      writeFileAtomic(link, '{"b":2}');
      expect(readFileSync(real, "utf8")).toBe('{"b":2}');
      expect(statSync(link).isFile()).toBe(true);
    }
  });

  it("backs up before every write, keeping the original and the newest three; backups it did not make stay", () => {
    const d = dir();
    const f = join(d, "claude_desktop_config.json");
    writeFileSync(f, "v0");
    // backups the user (or another tool) made, whose names start like ours: never removed
    const theirs = [f + ".surehand-mine.bak", f + ".surehand-before-plugins.bak", f + ".bak"];
    for (const t of theirs) writeFileSync(t, "theirs");
    for (let i = 1; i <= 8; i++) {
      backupFile(f, new Date(Date.UTC(2026, 9, 20, 10, 0, i)));
      writeFileSync(f, `v${i}`);
    }
    for (const t of theirs) expect(readFileSync(t, "utf8")).toBe("theirs");
    const backups = readdirSync(d).filter((n) => /\.surehand-\d{8}-.*\.bak$/.test(n)).sort();
    expect(backups).toHaveLength(BACKUPS_KEPT);
    expect(backups.map((n) => readFileSync(join(d, n), "utf8"))).toEqual(["v5", "v6", "v7"]);
    expect(readFileSync(f + ".surehand.bak", "utf8")).toBe("v0"); // the very first original
  });

  it("never replaces a file it can't read (it reports the file and why) and makes no backup then", () => {
    const d = dir();
    const f = join(d, "claude_desktop_config.json");
    writeFileSync(f, '{"mcpServers": {"mine": {"command": "x"}');
    let err: any;
    try {
      updateJsonFile(f, () => true, { missing: () => ({}) });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnreadableFileError);
    expect(err.message).toContain(f);
    expect(err.message).toMatch(/isn't valid JSON.*left unchanged/);
    expect(readFileSync(f, "utf8")).toBe('{"mcpServers": {"mine": {"command": "x"}');
    expect(readdirSync(d)).toEqual(["claude_desktop_config.json"]);
  });

  it("reads the file again right before writing: a change another app made meanwhile is kept", () => {
    const d = dir();
    const f = join(d, "settings.json");
    writeFileSync(f, JSON.stringify({ mcpServers: { a: 1 } }));
    let first = true;
    const changed = updateJsonFile<any>(f, (data) => {
      if (first) {
        first = false;
        // the AI app writes its settings while we work
        writeFileSync(f, JSON.stringify({ mcpServers: { a: 1, theirs: 2 }, theme: "dark" }));
      }
      data.mcpServers.ours = 3;
      return true;
    });
    expect(changed).toBe(true);
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ mcpServers: { a: 1, theirs: 2, ours: 3 }, theme: "dark" });
  });
});
