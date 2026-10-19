// Moving a 1.3 installation (~/.aemcp) to the 1.4 layout (~/.surehand/ae, with Node.js and ffmpeg shared
// in ~/.surehand). Runs from `install`, from `update` and at every server start (a cheap check once done).
//
// The algorithm (idempotent, never deletes the user's data):
//  1. Nothing to do unless ~/.aemcp has contents and no MOVED.txt (migrationPending).
//  2. One process at a time (a lock file in ~/.surehand; a stale one is taken over).
//  3. Every entry of ~/.aemcp is renamed (same disk: instant, nothing copied): node/ and ffmpeg/ to
//     ~/.surehand, everything else to ~/.surehand/ae, and server/ae-mcp.mjs* becomes surehand-ae.mjs*.
//     An entry whose target already exists (e.g. the 1.4 installer put a fresh server there) stays in
//     ~/.aemcp. node/ffmpeg are only a runtime: one that is in use and can't be renamed (Windows, a
//     running node.exe) is copied instead, or left where it is.
//  4. If any rename fails, every rename already done is undone, so ~/.aemcp is exactly as it was and
//     the server keeps working from there (appDir() stays ~/.aemcp); the reason goes to the log and the
//     next start tries again.
//  5. Then, for the 1.3 extension still running in an After Effects that hasn't restarted (it reads
//     ~/.aemcp/config.json and registers in ~/.aemcp/instances) and for AI app settings that still
//     name the old paths: a copy of config.json, an empty instances/ (both read by the server too), a
//     runtime.json and a tiny server/ae-mcp.mjs that forwards to the new server, a link from
//     ~/.aemcp/node to the moved Node.js, checkpoint indexes with the new paths, and MOVED.txt last
//     (which marks the move as done). AI app settings are rewritten by the caller (cli/clients.ts).
import { appendFileSync, closeSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { APP, LEGACY_SERVER_FILE, legacyDir, migrationPending, MOVED_NOTE, newAppDir, SERVER_FILE, surehandRoot } from "./paths.js";

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
  notes: string[];
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
}

const LOCK = ".migrate-ae.lock";
const FAILED = ".migrate-ae.failed";
const STALE_LOCK_MS = 120_000;
const RETRY_AFTER_MS = 5 * 60_000;

export const migrationLog = () => nodePath.join(surehandRoot(), "migration.log");

/** The forwarding file left at ~/.aemcp/server/ae-mcp.mjs: AI app settings written by 1.3 keep working. */
export const forwarder = (target: string) =>
  `// Surehand MCP moved to ${nodePath.dirname(nodePath.dirname(target))} (see ../${MOVED_NOTE}).\n` +
  `// AI app settings from version 1.3 still start this file; it runs the server from its new place.\n` +
  `await import(${JSON.stringify(pathToFileURL(target).href)});\n`;

const movedText = (now: string) => `Surehand MCP for Adobe After Effects moved (version 1.4, ${now}).

Your settings, checkpoints, project history and other files are now in
  ${newAppDir()}
The private Node.js and ffmpeg (shared by the Surehand apps) are in
  ${surehandRoot()}

What is still here, until After Effects has been restarted once:
  config.json, instances/   for the previous After Effects extension, which keeps running until then
  server/${LEGACY_SERVER_FILE}       forwards to ${nodePath.join(newAppDir(), "server", SERVER_FILE)}
  node                      a link to ${nodePath.join(surehandRoot(), "node")} (if Node.js was moved)
Nothing here holds your data any more; uninstalling Surehand MCP removes these as well.
`;

export function migrateLegacy(o: MigrationOptions = {}): MigrationResult {
  const res: MigrationResult = { status: "not-needed", moved: [], kept: [], notes: [], log: migrationLog() };
  if (!migrationPending()) return res;
  const L = legacyDir(), R = surehandRoot(), A = newAppDir();
  const rename = o.rename ?? renameSync;
  const platform = o.platform ?? process.platform;
  const log = (m: string) => {
    try {
      mkdirSync(R, { recursive: true });
      appendFileSync(migrationLog(), `${new Date().toISOString()} ${m}\n`);
    } catch {}
  };

  try {
    mkdirSync(R, { recursive: true });
  } catch (e: any) {
    log(`failed: can't create ${R}: ${e.message}`);
    return { ...res, status: "failed", error: `can't create ${R}: ${e.message}` };
  }
  // a failure a moment ago (a file in use) is retried at a later start, not on every start
  if (!o.force) {
    try {
      if (Date.now() - statSync(nodePath.join(R, FAILED)).mtimeMs < RETRY_AFTER_MS) return { ...res, status: "postponed" };
    } catch {}
  }

  const lock = nodePath.join(R, LOCK);
  let fd: number | null = null;
  for (let attempt = 0; attempt < 2 && fd === null; attempt++) {
    try {
      fd = openSync(lock, "wx");
    } catch (e: any) {
      if (e.code !== "EEXIST") return { ...res, status: "failed", error: `lock: ${e.message}` };
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) unlinkSync(lock);
        else return { ...res, status: "busy" };
      } catch {}
    }
  }
  if (fd === null) return { ...res, status: "busy" };

  try {
    // another process may have finished it while we waited
    if (!migrationPending()) return res;
    log(`migrating ${L} -> ${A} (node, ffmpeg -> ${R})`);
    const journal: [string, string][] = [];
    const copies: string[] = [];
    const superseded: string[] = [];
    const createdA = !existsSync(A);
    try {
      mkdirSync(A, { recursive: true });
      for (const name of readdirSync(L)) {
        const from = nodePath.join(L, name);
        if (name === "node" || name === "ffmpeg") {
          const to = nodePath.join(R, name);
          if (existsSync(to)) {
            // the 1.4 installer already put one there: this older copy goes once the move is done
            superseded.push(from);
            continue;
          }
          try {
            rename(from, to);
            journal.push([from, to]);
            res.moved.push(name);
          } catch (e: any) {
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
        const to = nodePath.join(A, name);
        if (existsSync(to)) {
          res.kept.push(`${name} (${to} already exists)`);
          continue;
        }
        rename(from, to);
        journal.push([from, to]);
        res.moved.push(name);
      }
      // the server file's new name (and its .previous / .download leftovers)
      if (res.moved.includes("server")) {
        const dir = nodePath.join(A, "server");
        for (const f of readdirSync(dir)) {
          if (!f.startsWith(LEGACY_SERVER_FILE)) continue;
          const to = nodePath.join(dir, SERVER_FILE + f.slice(LEGACY_SERVER_FILE.length));
          if (existsSync(to)) continue;
          rename(nodePath.join(dir, f), to);
          journal.push([nodePath.join(dir, f), to]);
        }
      }
    } catch (e: any) {
      const undone: string[] = [];
      for (const [from, to] of journal.reverse()) {
        try {
          renameSync(to, from);
        } catch (e2: any) {
          undone.push(`${to} -> ${from}: ${e2.message}`);
        }
      }
      for (const c of copies) rmSync(c, { recursive: true, force: true });
      if (createdA) {
        try {
          rmdirSync(A); // only if empty
        } catch {}
      }
      const why = `${e.code ? `${e.code}: ` : ""}${e.message}`;
      log(`failed, everything was moved back to ${L}: ${why}${undone.length ? `; could NOT move back: ${undone.join("; ")}` : ""}`);
      try {
        writeFileSync(nodePath.join(R, FAILED), why);
      } catch {}
      return { ...res, status: "failed", moved: [], error: why, notes: undone.map((u) => `could not move back ${u}`) };
    }
    rmSync(nodePath.join(R, FAILED), { force: true });

    // --- moved: compatibility files for what still uses ~/.aemcp ---
    const step = (what: string, fn: () => void) => {
      try {
        fn();
      } catch (e: any) {
        res.notes.push(`${what}: ${e.message}`);
      }
    };
    step("checkpoint indexes", () => {
      const root = nodePath.join(A, "checkpoints");
      if (!existsSync(root)) return;
      for (const d of readdirSync(root)) {
        const f = nodePath.join(root, d, "index.json");
        if (!existsSync(f)) continue;
        const text = readFileSync(f, "utf8");
        const next = JSON.stringify(mapStrings(JSON.parse(text)), null, 2);
        if (next !== JSON.stringify(JSON.parse(text), null, 2)) writeFileSync(f, next);
      }
    });
    step("runtime.json", () => {
      const f = nodePath.join(A, "runtime.json");
      if (!existsSync(f)) return;
      const rt = mapStrings(JSON.parse(readFileSync(f, "utf8")));
      writeFileSync(f, JSON.stringify(rt, null, 2));
      // the 1.3 panel's Update button reads it from here
      writeFileSync(nodePath.join(L, "runtime.json"), JSON.stringify(rt, null, 2));
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
      writeFileSync(nodePath.join(L, "server", LEGACY_SERVER_FILE), forwarder(target));
    });
    for (const from of superseded) {
      // an older Node.js / ffmpeg (a runtime, not the user's data), unless it is running this process
      if (process.execPath.startsWith(from + nodePath.sep)) res.kept.push(`${nodePath.basename(from)} (in use; ${nodePath.join(R, nodePath.basename(from))} is used)`);
      else step(`remove the older ${from}`, () => rmSync(from, { recursive: true, force: true }));
    }
    step("node link", () => {
      if (existsSync(nodePath.join(L, "node")) || !existsSync(nodePath.join(R, "node"))) return;
      symlinkSync(nodePath.join(R, "node"), nodePath.join(L, "node"), platform === "win32" ? "junction" : "dir");
    });
    writeFileSync(nodePath.join(L, MOVED_NOTE), movedText(new Date().toISOString()));
    log(`done: moved ${res.moved.join(", ") || "nothing"}${res.kept.length ? `; kept in ${L}: ${res.kept.join("; ")}` : ""}${res.notes.length ? `; notes: ${res.notes.join("; ")}` : ""}`);
    return { ...res, status: "migrated" };
  } finally {
    try {
      closeSync(fd);
    } catch {}
    rmSync(lock, { force: true });
  }
}
