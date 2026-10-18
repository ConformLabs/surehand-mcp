import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, buildInfo, describeBuild, interruptedBy, sha256File } from "../scripts/test-guard.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "aemcp-guard-"));
const quiet = () => {};

describe("test run lock", () => {
  it("takes a free lock, records the owner and releases it", async () => {
    const lock = join(tmp(), "test-mac.lock");
    const release = await acquireLock(lock, { owner: { build: "fix/a @ 111" }, log: quiet });
    const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
    expect(owner).toMatchObject({ build: "fix/a @ 111", pid: process.pid });
    release();
    expect(existsSync(lock)).toBe(false);
  });

  it("waits for a live holder and gives up after waitMs, naming the holder", async () => {
    const lock = join(tmp(), "test-mac.lock");
    const release = await acquireLock(lock, { owner: { build: "fix/a @ 111" }, log: quiet });
    const lines: string[] = [];
    await expect(acquireLock(lock, { owner: { build: "fix/b @ 222" }, waitMs: 50, pollMs: 10, log: (l) => lines.push(l) })).rejects.toThrow(
      /fix\/a @ 111/,
    );
    expect(lines.join("\n")).toMatch(/waiting for the test run of fix\/a @ 111/);
    expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).build).toBe("fix/a @ 111");
    release();
  });

  it("gets the lock once the holder releases it", async () => {
    const lock = join(tmp(), "test-mac.lock");
    const release = await acquireLock(lock, { log: quiet });
    setTimeout(release, 30);
    const second = await acquireLock(lock, { owner: { build: "fix/b" }, waitMs: 2000, pollMs: 10, log: quiet });
    expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).build).toBe("fix/b");
    second();
  });

  it("takes over a lock whose owner process is gone", async () => {
    const lock = join(tmp(), "test-mac.lock");
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    mkdirSync(lock);
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: Number(dead.stdout), build: "crashed" }));
    const lines: string[] = [];
    const release = await acquireLock(lock, { owner: { build: "fix/b" }, waitMs: 0, log: (l) => lines.push(l) });
    expect(lines.join("\n")).toMatch(/stale/);
    expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).build).toBe("fix/b");
    release();
  });

  it("does not remove a lock another run took over", async () => {
    const lock = join(tmp(), "test-mac.lock");
    const release = await acquireLock(lock, { log: quiet });
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid + 1_000_000, build: "other" }));
    release();
    expect(existsSync(lock)).toBe(true);
  });
});

describe("build provenance", () => {
  it("hashes files with sha256", () => {
    const f = join(tmp(), "x");
    writeFileSync(f, "abc");
    expect(sha256File(f)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("describes the checkout's branch and commit", () => {
    const info = buildInfo(process.cwd());
    expect(info.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(describeBuild(info)).toContain(info.commit!.slice(0, 12));
    expect(describeBuild({ branch: "fix/x", commit: "4849391e6ffa6567542ebdb2d29b7970dbade197", dirty: true })).toBe(
      "fix/x @ 4849391e6ffa (+ uncommitted changes)",
    );
    expect(describeBuild(buildInfo(tmp()))).toBe("? @ unknown commit");
  });
});

describe("interrupted child", () => {
  const child = (code: string) => spawnSync(process.execPath, ["-e", code], { encoding: "utf8" });

  it("reports a child stopped by Ctrl-C or kill", () => {
    expect(interruptedBy(child("process.kill(process.pid, 'SIGINT')"))).toBe("SIGINT");
    expect(interruptedBy(child("process.kill(process.pid, 'SIGTERM')"))).toBe("SIGTERM");
    expect(interruptedBy(child("process.exit(130)"))).toBe("SIGINT");
  });

  it("does not treat a failing or passing child as interrupted", () => {
    expect(interruptedBy(child("process.exit(1)"))).toBeNull();
    expect(interruptedBy(child(""))).toBeNull();
  });
});
