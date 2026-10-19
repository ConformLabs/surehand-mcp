// Keeps parallel test runs on one machine from testing each other's build.
// The installed server (~/.surehand/ae/server), the After Effects extension and the open After Effects
// are shared by every checkout on the machine, so a run holds a machine-wide lock from install to
// the last self-test, and checks that the installed server is still its own build.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

/**
 * The user's own home folder from the account database, not $HOME: agent runners set $HOME to a
 * temp folder, but the installed server, the extension and After Effects live in the real one.
 * Falls back to $HOME when the account has no database entry.
 */
export function realHome(info = userInfo) {
  try {
    return info().homedir || homedir();
  } catch {
    return homedir();
  }
}

export const sha256File = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Branch and commit of the checkout in `dir` (null fields when git can't tell). */
export function buildInfo(dir) {
  const git = (...args) => {
    const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const status = git("status", "--porcelain");
  return { branch: git("rev-parse", "--abbrev-ref", "HEAD"), commit: git("rev-parse", "HEAD"), dirty: status === null ? null : status !== "" };
}

/** "fix/x @ 4849391e6ffa (+ uncommitted changes)" */
export const describeBuild = ({ branch, commit, dirty }) =>
  `${branch ?? "?"} @ ${commit ? commit.slice(0, 12) : "unknown commit"}${dirty ? " (+ uncommitted changes)" : ""}`;

/**
 * The signal that stopped a spawnSync() child when the user interrupted the run (Ctrl-C, kill),
 * else null. A synchronous script never gets to run its own signal handlers while it waits on
 * the child, so it has to check this after every child and stop.
 */
export function interruptedBy(r) {
  if (["SIGINT", "SIGTERM", "SIGHUP"].includes(r.signal)) return r.signal;
  if (r.status === 130) return "SIGINT"; // the child caught it and exited the conventional way
  if (r.status === 143) return "SIGTERM";
  return null;
}

const alive = (pid) => {
  try {
    return process.kill(pid, 0);
  } catch (e) {
    return e.code === "EPERM";
  }
};

/**
 * Takes the lock directory `dir` (mkdir is atomic), waiting up to `waitMs` while another live
 * run holds it. A lock whose owner process is gone (or that never got its owner file) is stale
 * and taken over. Returns release(); the lock is also released when this process exits.
 */
export async function acquireLock(dir, { owner = {}, waitMs = 30 * 60_000, pollMs = 5000, log = console.log } = {}) {
  const ownerFile = join(dir, "owner.json");
  const deadline = Date.now() + waitMs;
  let reported = null;
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(ownerFile, JSON.stringify({ ...owner, pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    let holder = null;
    try {
      holder = JSON.parse(readFileSync(ownerFile, "utf8"));
    } catch {}
    let age = 0;
    try {
      age = Date.now() - statSync(dir).mtimeMs;
    } catch {
      continue; // released meanwhile
    }
    if (holder ? !alive(holder.pid) : age > 60_000) {
      log(`  ! removing a stale test lock${holder ? ` (pid ${holder.pid} is gone)` : ""}`);
      rmSync(dir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline)
      throw new Error(`another test run still holds ${dir}${holder ? `: ${holder.build ?? "?"} (pid ${holder.pid}, since ${holder.startedAt})` : ""}`);
    const who = holder ? `${holder.build ?? "?"} (pid ${holder.pid}, since ${holder.startedAt})` : "another run";
    if (who !== reported) log(`  waiting for the test run of ${who} to finish...`);
    reported = who;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  let held = true;
  const release = () => {
    if (!held) return;
    held = false;
    try {
      if (JSON.parse(readFileSync(ownerFile, "utf8")).pid === process.pid) rmSync(dir, { recursive: true, force: true });
    } catch {}
  };
  process.once("exit", release);
  return release;
}
