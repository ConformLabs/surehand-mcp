// Moving a 1.3 installation (~/.aemcp) to the 1.4 layout (~/.surehand/ae, with Node.js and ffmpeg shared
// in ~/.surehand). Runs from `install`, from `update` and when the MCP server starts (a cheap check once
// done); commands that only read (clients, test, checkpoints, diagnostics, activity) never move anything.
//
// The algorithm (idempotent, resumable, never deletes the user's data):
//  1. Nothing to do unless a move is pending (paths.ts migrationPending: an unfinished move's marker,
//     or ~/.aemcp with 1.3 data and no MOVED.txt; a Node.js left by an uninstall is not data).
//  2. One process at a time: a lock file in ~/.surehand holding the owner's process id and start time;
//     a lock whose process is gone (or that is very old) is taken over.
//  3. Before the first rename, a marker (~/.surehand/.migrate-ae.inprogress) records the plan. From then
//     on the move counts as started: new data goes to ~/.surehand/ae, and if the process is killed the
//     next run finishes the remaining steps. The marker is removed after the very last step.
//  4. Every entry of ~/.aemcp is renamed (same disk: instant, nothing copied): the user's data first,
//     then server/ (ae-mcp.mjs* becomes surehand-ae.mjs*), node/ and ffmpeg/ last (to ~/.surehand), so
//     an interrupted move leaves the old server and Node.js working where AI apps expect them.
//     When the destination already exists, folders are MERGED (their contents are moved one by one)
//     and a clashing file arrives as <name>.from-aemcp; only an old server file whose new name is taken
//     (the 1.4 installer put a fresh server there) stays behind. node/ffmpeg are only a runtime: one
//     that is in use and can't be renamed (Windows, a running node.exe) is copied instead, or left.
//  5. If a rename fails in a fresh move, every rename of this run is undone, so ~/.aemcp is exactly as it
//     was and the server keeps working from there; the reason goes to the log and a later start tries
//     again (install / update right away).
//  6. Then, for the 1.3 extension still running in an After Effects that hasn't restarted (it reads
//     ~/.aemcp/config.json and registers in ~/.aemcp/instances) and for AI app settings that still
//     name the old paths: checkpoint indexes and runtime.json with the new paths, a copy of config.json,
//     an empty instances/, a tiny server/ae-mcp.mjs that forwards to the new server, a link from
//     ~/.aemcp/node to the moved Node.js, AI app settings pointed at the new place (the caller's
//     `repoint`), MOVED.txt (listing anything that stayed), and last the marker is removed.
//  7. After the move (later starts): data an older server still wrote into ~/.aemcp is merged in the
//     same way, and settings the 1.3 panel saved in ~/.aemcp/config.json are adopted (lateMerge).
import { appendFileSync, closeSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { readJsonFile, writeFileAtomic } from "./fsutil.js";
import {
  APP, FORWARDER_MARK, isForwarder, LEGACY_SERVER_FILE, LEGACY_VOLATILE as VOLATILE, legacyDir, migrationInProgress, migrationMarker, migrationPending, MOVED_NOTE, newAppDir,
  SERVER_FILE, surehandRoot,
} from "./paths.js";

type PathImpl = typeof nodePath.posix;

/**
 * Where a path inside ~/.aemcp is after the migration (anything else is returned unchanged).
 * `path` lets tests check Windows paths (path.win32) on any platform.
 */
export function mapLegacyPath(p: string, o: { home?: string; path?: PathImpl } = {}): string {
  const P = o.path ?? nodePath;
  const home = o.home ?? homedir();
  const L = P.join(home, ".aemcp"), R = P.join(home, ".surehand"), A = P.join(R, APP);
  const win = P.sep === "\\";
  const norm = (s: string) => (win ? s.replace(/\//g, "\\").toLowerCase() : s);
  const np = norm(p), nl = norm(L);
  if (np !== nl && !np.startsWith(nl + P.sep)) return p;
  const rel = p.slice(L.length + 1).split(win ? /[\\/]/ : /\//).filter(Boolean);
  if (!rel.length) return A;
  if (rel[0] === "node" || rel[0] === "ffmpeg") return P.join(R, ...rel);
  if (rel[0] === "server" && rel[1]?.startsWith(LEGACY_SERVER_FILE)) rel[1] = SERVER_FILE + rel[1].slice(LEGACY_SERVER_FILE.length);
  return P.join(A, ...rel);
}

/** Replaces old paths in a parsed JSON value (checkpoint indexes, runtime.json). */
function mapStrings(v: unknown): unknown {
  if (typeof v === "string") return mapLegacyPath(v);
  if (Array.isArray(v)) return v.map(mapStrings);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x)]));
  return v;
}

export interface MigrationResult {
  status: "not-needed" | "migrated" | "failed" | "busy" | "postponed";
  /** entries of ~/.aemcp that moved */
  moved: string[];
  /** entries left in ~/.aemcp, with the reason */
  kept: string[];
  /** files that arrived under another name because the destination had one already ("old -> new name") */
  renamed: string[];
  notes: string[];
  /** AI apps whose settings now point at the new place (from the caller's repoint) */
  repointed: string[];
  error?: string;
  log: string;
}

export interface MigrationOptions {
  /** try now even if an attempt failed a moment ago (install / update) */
  force?: boolean;
  /** tests: stand-in for fs.renameSync (to make a rename fail) */
  rename?: (from: string, to: string) => void;
  /** tests: the platform (link type for the moved Node.js) */
  platform?: NodeJS.Platform;
  /** points AI app settings at the new place (run before MOVED.txt; returns the apps changed) */
  repoint?: () => string[];
  /** tests: called before each step; an error with simulatedKill: true stops the move as a killed process would */
  interrupt?: (step: string) => void;
}

const LOCK = ".migrate-ae.lock";
const FAILED = ".migrate-ae.failed";
/** a lock this old is stale even if a process with its id runs (process ids are reused) */
const LOCK_MAX_AGE_MS = 30 * 60_000;
/** a lock without a readable owner (written by a 1.4 beta, or being written right now) is stale after this */
const LOCK_UNREADABLE_STALE_MS = 120_000;
const RETRY_AFTER_MS = 5 * 60_000;
const FROM_LEGACY = ".from-aemcp";

/** What stays in ~/.aemcp after the move on purpose: for the 1.3 extension and AI app settings. */
const COMPAT = new Set([MOVED_NOTE, "config.json", "instances", "server", "runtime.json", "node"]);
/** Our own status files: the one in ~/.surehand/ae is the current one; a copy in ~/.aemcp is stale (see lateMerge). */
const STALE_STATUS = new Set(["install-result.json", "install.log"]);

export const migrationLog = () => nodePath.join(surehandRoot(), "migration.log");
const lockFile = () => nodePath.join(surehandRoot(), LOCK);

/** The forwarding file left at ~/.aemcp/server/ae-mcp.mjs: AI app settings written by 1.3 keep working. */
export const forwarder = (target: string) =>
  `// Surehand MCP moved to ${nodePath.dirname(nodePath.dirname(target))} (see ../${MOVED_NOTE}).\n` +
  `// ${FORWARDER_MARK}; it runs the server from its new place.\n` +
  `await import(${JSON.stringify(pathToFileURL(target).href)});\n`;

function movedText(now: string, still: string[]): string {
  const userFiles = still.length
    ? `Also still here (not moved; nothing was deleted):\n${still.map((s) => `  ${s}`).join("\n")}\n` +
      `These may hold your data: move them yourself if you need them. Uninstalling Surehand MCP leaves them here.\n`
    : `Nothing here holds your data any more; uninstalling Surehand MCP removes these as well.\n`;
  return `Surehand MCP for Adobe After Effects moved (version 1.4, ${now}).

Your settings, checkpoints, project history and other files are now in
  ${newAppDir()}
The private Node.js and ffmpeg (shared by the Surehand apps) are in
  ${surehandRoot()}
A file that was already there under the same name arrived as <name>${FROM_LEGACY}.

What is still here, until After Effects has been restarted once:
  config.json, instances/   for the previous After Effects extension, which keeps running until then
  server/${LEGACY_SERVER_FILE}       forwards to ${nodePath.join(newAppDir(), "server", SERVER_FILE)}
  node                      a link to ${nodePath.join(surehandRoot(), "node")} (if Node.js was moved)
${userFiles}`;
}

/** Is a process with this id running? (EPERM: it runs, as another user.) */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EPERM";
  }
}

/** True when the lock file belongs to a move that is running (not ours to take). */
function lockHeld(): boolean {
  const f = lockFile();
  let mtime: number;
  try {
    mtime = statSync(f).mtimeMs;
  } catch {
    return false;
  }
  const r = readJsonFile<{ pid?: number; startedAt?: number }>(f);
  if (!r.ok || typeof r.data?.pid !== "number") return Date.now() - mtime < LOCK_UNREADABLE_STALE_MS;
  if (Date.now() - (Number(r.data.startedAt) || mtime) > LOCK_MAX_AGE_MS) return false;
  return processAlive(r.data.pid);
}

/** Another process is moving ~/.aemcp right now. */
export const migrationBusy = () => lockHeld();

/** Takes the lock: its file descriptor, or null when a running process holds it. */
function takeLock(): number | null {
  const f = lockFile();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(f, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      return fd;
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      if (lockHeld()) return null;
      rmSync(f, { force: true }); // stale: its process is gone
    }
  }
  return null;
}

function releaseLock(fd: number) {
  try {
    closeSync(fd);
  } catch {}
  rmSync(lockFile(), { force: true });
}

function logLine(m: string) {
  try {
    mkdirSync(surehandRoot(), { recursive: true });
    appendFileSync(migrationLog(), `${new Date().toISOString()} ${m}\n`);
  } catch {}
}

const isKill = (e: any) => !!e?.simulatedKill;

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
function isRealDir(p: string): boolean {
  try {
    const s = lstatSync(p);
    return s.isDirectory() && !s.isSymbolicLink();
  } catch {
    return false;
  }
}
const there = (p: string) => existsSync(p) || isLink(p);

/** <to>.from-aemcp (-2, -3...): the first free one. */
function freeName(to: string): string {
  let alt = to + FROM_LEGACY;
  for (let i = 2; there(alt); i++) alt = `${to}${FROM_LEGACY}-${i}`;
  return alt;
}

/** Moves entries with rename: merges into an existing folder, gives a clashing file a free name, and can undo it all. */
class Mover {
  journal: [string, string][] = [];
  renamed: string[] = [];
  constructor(private rename: (from: string, to: string) => void) {}
  move(from: string, to: string, label: string) {
    if (!there(to)) {
      this.rename(from, to);
      this.journal.push([from, to]);
      return;
    }
    if (isRealDir(from) && isRealDir(to)) {
      for (const child of readdirSync(from)) this.move(nodePath.join(from, child), nodePath.join(to, child), `${label}/${child}`);
      try {
        rmdirSync(from); // empty now (undo recreates it)
      } catch {}
      return;
    }
    const alt = freeName(to);
    this.rename(from, alt);
    this.journal.push([from, alt]);
    this.renamed.push(`${label} -> ${nodePath.basename(alt)}`);
  }
  /** Undoes every rename of this run, newest first. Returns what could not be moved back. */
  undo(): string[] {
    const failed: string[] = [];
    for (const [from, to] of [...this.journal].reverse()) {
      try {
        mkdirSync(nodePath.dirname(from), { recursive: true });
        renameSync(to, from);
      } catch (e: any) {
        failed.push(`${to} -> ${from}: ${e.message}`);
      }
    }
    return failed;
  }
}

interface Plan {
  phase: "moving" | "finishing";
  startedAt: string;
  /** the entries of ~/.aemcp to move, in order */
  entries: string[];
}

function readPlan(): Plan | null {
  const r = readJsonFile<Plan>(migrationMarker());
  return r.ok && r.data && Array.isArray(r.data.entries) ? r.data : null;
}
const writePlan = (p: Plan) => writeFileAtomic(migrationMarker(), JSON.stringify(p, null, 2));

/** Checkpoint indexes in <A>/checkpoints that still name files in ~/.aemcp: pointed at the new place. */
function mapCheckpointIndexes(A: string) {
  const root = nodePath.join(A, "checkpoints");
  if (!existsSync(root)) return;
  for (const d of readdirSync(root)) {
    const f = nodePath.join(root, d, "index.json");
    if (!existsSync(f)) continue;
    const text = readFileSync(f, "utf8");
    const next = JSON.stringify(mapStrings(JSON.parse(text)), null, 2);
    if (next !== JSON.stringify(JSON.parse(text), null, 2)) writeFileAtomic(f, next);
  }
}

/** Order of the move: the user's data first, then the server, Node.js and ffmpeg last. */
function ordered(names: string[]): string[] {
  const late = ["server", "node", "ffmpeg"];
  return [...names.filter((n) => !late.includes(n)).sort(), ...late.filter((n) => names.includes(n))];
}

const readdirSafe = (d: string) => {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
};

export function migrateLegacy(o: MigrationOptions = {}): MigrationResult {
  const res: MigrationResult = { status: "not-needed", moved: [], kept: [], renamed: [], notes: [], repointed: [], log: migrationLog() };
  if (!migrationPending()) return res;
  const L = legacyDir(), R = surehandRoot(), A = newAppDir();
  const rename = o.rename ?? renameSync;
  const platform = o.platform ?? process.platform;
  const kill = (step: string) => o.interrupt?.(step);

  try {
    mkdirSync(R, { recursive: true });
  } catch (e: any) {
    logLine(`failed: can't create ${R}: ${e.message}`);
    return { ...res, status: "failed", error: `can't create ${R}: ${e.message}` };
  }
  // a failure a moment ago (a file in use) is retried at a later start, not on every start
  if (!o.force) {
    try {
      if (Date.now() - statSync(nodePath.join(R, FAILED)).mtimeMs < RETRY_AFTER_MS) return { ...res, status: "postponed" };
    } catch {}
  }

  let fd: number | null;
  try {
    fd = takeLock();
  } catch (e: any) {
    return { ...res, status: "failed", error: `lock: ${e.message}` };
  }
  if (fd === null) return { ...res, status: "busy" };

  try {
    // another process may have finished it while we waited
    if (!migrationPending()) return res;
    let plan = readPlan();
    const resuming = !!plan || migrationInProgress();
    if (!plan) {
      plan = { phase: "moving", startedAt: new Date().toISOString(), entries: ordered(readdirSafe(L).filter((n) => n !== MOVED_NOTE)) };
      writePlan(plan); // from here on the move counts as started
    }
    logLine(resuming ? `resuming the unfinished move of ${L} (${plan.phase})` : `migrating ${L} -> ${A} (node, ffmpeg -> ${R})`);
    kill("planned");

    const mover = new Mover(rename);
    const copies: string[] = [];
    const superseded: string[] = [];
    const createdA = !existsSync(A);
    if (plan.phase === "moving") {
      try {
        mkdirSync(A, { recursive: true });
        for (const name of plan.entries) {
          const from = nodePath.join(L, name);
          if (!there(from)) continue; // moved before an interruption
          kill(`move ${name}`);
          if (name === "node" || name === "ffmpeg") {
            const to = nodePath.join(R, name);
            if (isLink(from)) continue;
            if (existsSync(to)) {
              // the 1.4 installer already put one there: this older copy goes once the move is done
              superseded.push(from);
              continue;
            }
            try {
              rename(from, to);
              mover.journal.push([from, to]);
              res.moved.push(name);
            } catch (e: any) {
              if (isKill(e)) throw e;
              // a runtime, not the user's data: a copy will do (the original may be running this process)
              try {
                cpSync(from, to, { recursive: true, verbatimSymlinks: true });
                copies.push(to);
                res.kept.push(`${name} (in use, copied to ${to}: ${e.code || e.message})`);
              } catch (e2: any) {
                rmSync(to, { recursive: true, force: true });
                res.kept.push(`${name} (in use and could not be copied: ${e2.code || e2.message})`);
              }
            }
            continue;
          }
          if (name === "server" && isRealDir(from)) {
            // the server file gets its new name (with its .previous / .download leftovers); an old server
            // whose new name is taken (a 1.4 server is there) stays: it becomes the forwarder
            const dir = nodePath.join(A, "server");
            mkdirSync(dir, { recursive: true });
            for (const f of readdirSync(from)) {
              const mapped = f.startsWith(LEGACY_SERVER_FILE) ? SERVER_FILE + f.slice(LEGACY_SERVER_FILE.length) : f;
              const to = nodePath.join(dir, mapped);
              if (f.startsWith(LEGACY_SERVER_FILE) && there(to)) {
                res.kept.push(`server/${f} (${to} already exists)`);
                continue;
              }
              mover.move(nodePath.join(from, f), to, `server/${f}`);
            }
            try {
              rmdirSync(from); // empty unless an old server stayed (the forwarder recreates it)
            } catch {}
            res.moved.push("server");
            continue;
          }
          mover.move(from, nodePath.join(A, name), name);
          res.moved.push(name);
        }
      } catch (e: any) {
        if (isKill(e)) throw e;
        const undone = mover.undo();
        for (const c of copies) rmSync(c, { recursive: true, force: true });
        if (createdA) {
          try {
            rmdirSync(nodePath.join(A, "server")); // only if empty
          } catch {}
          try {
            rmdirSync(A); // only if empty
          } catch {}
        }
        const why = `${e.code ? `${e.code}: ` : ""}${e.message}`;
        // a fresh move that was fully undone is as if it never started; a resumed one stays unfinished
        const clean = !resuming && !undone.length;
        if (clean) rmSync(migrationMarker(), { force: true });
        logLine(
          clean
            ? `failed, everything was moved back to ${L}: ${why}`
            : `failed${resuming ? " while finishing an interrupted move" : ""}: ${why}${undone.length ? `; could NOT move back: ${undone.join("; ")}` : ""}; the next start tries again`,
        );
        try {
          writeFileSync(nodePath.join(R, FAILED), why);
        } catch {}
        return { ...res, status: "failed", moved: [], renamed: [], error: why, notes: undone.map((u) => `could not move back ${u}`) };
      }
      res.renamed.push(...mover.renamed);
      plan = { ...plan, phase: "finishing" };
      writePlan(plan);
    } else {
      // killed after the renames: an older runtime still in ~/.aemcp next to the moved one is superseded
      for (const name of ["node", "ffmpeg"]) {
        const from = nodePath.join(L, name);
        if (isRealDir(from) && existsSync(nodePath.join(R, name))) superseded.push(from);
      }
    }
    rmSync(nodePath.join(R, FAILED), { force: true });

    // --- moved: compatibility files for what still uses ~/.aemcp (every step can run again) ---
    const step = (what: string, fn: () => void) => {
      kill(what);
      try {
        fn();
      } catch (e: any) {
        if (isKill(e)) throw e;
        res.notes.push(`${what}: ${e.message}`);
      }
    };
    step("checkpoint indexes", () => mapCheckpointIndexes(A));
    step("runtime.json", () => {
      const f = nodePath.join(A, "runtime.json");
      if (!existsSync(f)) return;
      const rt = mapStrings(JSON.parse(readFileSync(f, "utf8")));
      writeFileAtomic(f, JSON.stringify(rt, null, 2));
      // the 1.3 panel's Update button reads it from here
      writeFileAtomic(nodePath.join(L, "runtime.json"), JSON.stringify(rt, null, 2));
    });
    step("config.json copy", () => {
      const f = nodePath.join(A, "config.json");
      if (existsSync(f) && !existsSync(nodePath.join(L, "config.json"))) copyFileSync(f, nodePath.join(L, "config.json"));
    });
    step("instances", () => mkdirSync(nodePath.join(L, "instances"), { recursive: true }));
    step("server forwarder", () => {
      // also when the installer already put a new server in place: the old program file is replaced
      const target = nodePath.join(A, "server", SERVER_FILE);
      if (!existsSync(target)) return;
      mkdirSync(nodePath.join(L, "server"), { recursive: true });
      writeFileAtomic(nodePath.join(L, "server", LEGACY_SERVER_FILE), forwarder(target));
    });
    for (const from of superseded) {
      // an older Node.js / ffmpeg (a runtime, not the user's data), unless it is running this process
      if (process.execPath.startsWith(from + nodePath.sep)) res.kept.push(`${nodePath.basename(from)} (in use; ${nodePath.join(R, nodePath.basename(from))} is used)`);
      else step(`remove the older ${from}`, () => rmSync(from, { recursive: true, force: true }));
    }
    step("node link", () => {
      if (there(nodePath.join(L, "node")) || !existsSync(nodePath.join(R, "node"))) return;
      symlinkSync(nodePath.join(R, "node"), nodePath.join(L, "node"), platform === "win32" ? "junction" : "dir");
    });
    if (o.repoint) step("AI app settings", () => res.repointed.push(...o.repoint!()));
    // what is still in ~/.aemcp apart from the compatibility files (MOVED.txt names it)
    const still = stillInLegacy();
    kill("MOVED.txt");
    writeFileSync(nodePath.join(L, MOVED_NOTE), movedText(new Date().toISOString(), still));
    kill("marker");
    rmSync(migrationMarker(), { force: true });
    logLine(
      `done: moved ${res.moved.join(", ") || "nothing"}${res.renamed.length ? `; arrived under another name: ${res.renamed.join("; ")}` : ""}` +
        `${res.kept.length ? `; kept in ${L}: ${res.kept.join("; ")}` : ""}${still.length ? `; still in ${L}: ${still.join(", ")}` : ""}` +
        `${res.repointed.length ? `; AI apps updated: ${res.repointed.join(", ")}` : ""}${res.notes.length ? `; notes: ${res.notes.join("; ")}` : ""}`,
    );
    return { ...res, status: "migrated" };
  } finally {
    releaseLock(fd);
  }
}

/** Entries of ~/.aemcp that aren't compatibility or status files (they may be the user's data). */
export function stillInLegacy(): string[] {
  const L = legacyDir();
  const out: string[] = [];
  for (const n of readdirSafe(L)) {
    if (VOLATILE.has(n) || n === MOVED_NOTE || n === "config.json" || n === "runtime.json" || n === "instances") continue;
    if (n === "node" || n === "ffmpeg") {
      if (!isLink(nodePath.join(L, n))) out.push(`${n} (a copy of the private ${n === "node" ? "Node.js" : "ffmpeg"} that was in use)`);
      continue;
    }
    if (n === "server") {
      out.push(...readdirSafe(nodePath.join(L, "server")).filter((f) => f !== LEGACY_SERVER_FILE).map((f) => `server/${f}`));
      continue;
    }
    out.push(n);
  }
  return out;
}

export interface LateMergeResult {
  merged: string[];
  renamed: string[];
  adopted: string[];
  /** put right in ~/.aemcp: a full server where the forwarder belongs, stale status files */
  repaired: string[];
  notes: string[];
}

/**
 * After the move (on later starts): what a 1.3 server or panel that kept running wrote into ~/.aemcp
 * since then. Data (checkpoints, history, activity...) is merged into ~/.surehand/ae with the same
 * rules as the move; settings the 1.3 panel saved (permissions, pause) in ~/.aemcp/config.json are
 * adopted when that file is newer and they differ. Logged; cheap when there is nothing to do.
 *
 * It also repairs what 1.4.0-beta.3 and earlier could write into ~/.aemcp when a reinstall after an
 * uninstall took a leftover ~/.aemcp/node for a 1.3 installation and resolved its paths there before the
 * move: a full server where the forwarder belongs (AI apps pointed at it would never get updates), and
 * install-result.json / install.log (ours; the ones in ~/.surehand/ae are current, so those copies go;
 * one that only exists here moves). Data it wrote (checkpoints, history...) is merged like any other.
 */
export function lateMerge(o: { rename?: (from: string, to: string) => void } = {}): LateMergeResult {
  const out: LateMergeResult = { merged: [], renamed: [], adopted: [], repaired: [], notes: [] };
  const L = legacyDir(), A = newAppDir();
  if (migrationPending() || !existsSync(nodePath.join(L, MOVED_NOTE)) || !existsSync(A)) return out;
  const data = readdirSafe(L).filter((n) => !COMPAT.has(n) && !VOLATILE.has(n) && n !== "ffmpeg" && !n.endsWith(".tmp"));
  const legacyCfg = nodePath.join(L, "config.json"), cfg = nodePath.join(A, "config.json");
  const adopt = adoptable(legacyCfg, cfg);
  const oldServer = nodePath.join(L, "server", LEGACY_SERVER_FILE), server = nodePath.join(A, "server", SERVER_FILE);
  const fullServer = existsSync(oldServer) && existsSync(server) && !isForwarder(oldServer);
  if (!data.length && !adopt && !fullServer) return out;
  let fd: number | null = null;
  try {
    fd = takeLock();
  } catch {}
  if (fd === null) return out; // another process is at it
  try {
    const mover = new Mover(o.rename ?? renameSync);
    for (const n of data) {
      try {
        if (STALE_STATUS.has(n) && existsSync(nodePath.join(A, n))) {
          rmSync(nodePath.join(L, n), { recursive: true, force: true });
          out.repaired.push(`removed the stale ${n}`);
          continue;
        }
        mover.move(nodePath.join(L, n), nodePath.join(A, n), n);
        out.merged.push(n);
      } catch (e: any) {
        out.notes.push(`${n}: ${e.code || e.message}`);
      }
    }
    out.renamed.push(...mover.renamed);
    if (out.merged.includes("checkpoints")) {
      try {
        mapCheckpointIndexes(A);
      } catch (e: any) {
        out.notes.push(`checkpoint indexes: ${e.message}`);
      }
    }
    if (fullServer) {
      try {
        writeFileAtomic(oldServer, forwarder(server));
        out.repaired.push(`server/${LEGACY_SERVER_FILE} forwards again`);
      } catch (e: any) {
        out.notes.push(`server/${LEGACY_SERVER_FILE}: ${e.message}`);
      }
    }
    if (adopt) {
      try {
        const next = { ...adopt.current };
        for (const k of adopt.keys) {
          if (adopt.legacy[k] === undefined) delete next[k];
          else next[k] = adopt.legacy[k];
        }
        writeFileAtomic(cfg, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
        out.adopted.push(...adopt.keys);
      } catch (e: any) {
        out.notes.push(`settings from ${legacyCfg}: ${e.message}`);
      }
    }
    if (out.merged.length || out.adopted.length || out.repaired.length || out.notes.length)
      logLine(
        `after the move: ${out.merged.length ? `merged ${out.merged.join(", ")} from ${L}` : ""}` +
          `${out.repaired.length ? `; repaired in ${L}: ${out.repaired.join("; ")}` : ""}` +
          `${out.renamed.length ? `; arrived under another name: ${out.renamed.join("; ")}` : ""}` +
          `${out.adopted.length ? `; adopted ${out.adopted.join(", ")} saved by the previous panel in ${legacyCfg}` : ""}` +
          `${out.notes.length ? `; problems: ${out.notes.join("; ")}` : ""}`,
      );
  } finally {
    releaseLock(fd);
  }
  return out;
}

/** The 1.3 panel's settings in ~/.aemcp/config.json, when that file is newer than ours and they differ. */
function adoptable(legacyFile: string, file: string): { keys: string[]; legacy: Record<string, unknown>; current: Record<string, unknown> } | null {
  try {
    if (statSync(legacyFile).mtimeMs <= statSync(file).mtimeMs) return null;
  } catch {
    return null;
  }
  const l = readJsonFile<Record<string, unknown>>(legacyFile), c = readJsonFile<Record<string, unknown>>(file);
  if (!l.ok || !c.ok || !l.data || !c.data) return null; // never write over an unreadable config
  // the token and ports stay ours: only what the user chose in the panel (permissions, with allowShell);
  // a pause is adopted, but never undone from there (the 1.3 panel has no Pause: a missing flag means nothing)
  const keys: string[] = [];
  if (JSON.stringify(l.data.permissions) !== JSON.stringify(c.data.permissions) && l.data.permissions !== undefined) keys.push("permissions");
  if (l.data.paused === true && c.data.paused !== true) keys.push("paused", "pausedAt");
  return keys.length ? { keys, legacy: l.data, current: c.data } : null;
}
