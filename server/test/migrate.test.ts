// Moving a 1.3 installation (~/.aemcp) to ~/.surehand/ae, in temporary home folders.
import { beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { lateMerge, mapLegacyPath, migrateLegacy, migrationBusy } from "../src/migrate.js";
import { appDir, configPath, installedServer, legacyDir, migrationInProgress, migrationMarker, migrationPending, newAppDir, privateFfmpegDir, privateNodeDir, surehandRoot } from "../src/paths.js";
import { ensureConfig } from "../src/cli/setup.js";
import { movesLegacyBeforeRunning } from "../src/cli/commands.js";
import { loadConfig } from "../src/config.js";
import { instanceDirs, listInstances } from "../src/bridge.js";
import { createServer } from "node:http";

let home = "";
const L = () => join(home, ".aemcp");
const R = () => join(home, ".surehand");
const A = () => join(home, ".surehand", "ae");

function newHome() {
  home = mkdtempSync(join(tmpdir(), "surehand-migrate-"));
  process.env.HOME = process.env.USERPROFILE = home;
  delete process.env.AEMCP_CONFIG;
  delete process.env.SUREHAND_AE_CONFIG;
}

const put = (file: string, text = "x") => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

/** Every file under dir with its contents (relative paths), to compare a folder before and after. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  (function walk(d: string) {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[path.relative(dir, p).split(path.sep).join("/")] = readFileSync(p, "utf8");
    }
  })(dir);
  return out;
}

/** A 1.3 installation: private Node and ffmpeg, the server, settings, checkpoints, history, proofs, the user's own files. */
function legacyInstall() {
  const l = L();
  put(join(l, "node", "bin", "node"), "node-binary");
  put(join(l, "ffmpeg", "ffmpeg"), "ffmpeg-binary");
  put(join(l, "server", "ae-mcp.mjs"), "server 1.3.4");
  put(join(l, "server", "ae-mcp.mjs.previous"), "server 1.3.3");
  put(join(l, "config.json"), JSON.stringify({ token: "a".repeat(48), bridgePort: 8765, httpPort: 8766, toolProfile: "full" }));
  put(join(l, "runtime.json"), JSON.stringify({ node: join(l, "node", "bin", "node"), server: join(l, "server", "ae-mcp.mjs"), version: "1.3.4" }));
  put(join(l, "activity.jsonl"), '{"tool":"ae_status"}\n');
  put(join(l, "update-check.json"), "{}");
  put(join(l, "extension-hash"), "abc 1.3.4");
  put(join(l, "instances", "8765.json"), '{"port":8765}');
  const cp = join(l, "checkpoints", "Spot-1234abcd");
  put(join(cp, "2026-01-01-00-00-00-v1.aep"), "aep v1");
  put(join(cp, "index.json"), JSON.stringify([{ id: "2026-01-01-00-00-00", at: "2026-01-01T00:00:00Z", label: "v1", file: join(cp, "2026-01-01-00-00-00-v1.aep"), project: "/work/Spot.aep" }]));
  put(join(l, "history", "Spot-1234abcd", "index.json"), "[]");
  put(join(l, "proofs", "p1", "manifest.json"), "{}");
  put(join(l, "backups", "client.aep"), "the user's own file");
  put(join(l, "notes.txt"), "the user's notes");
}

beforeEach(newHome);

describe("paths", () => {
  it("a fresh install uses ~/.surehand/ae, with Node.js and ffmpeg shared in ~/.surehand", () => {
    expect(migrationPending()).toBe(false);
    expect(appDir()).toBe(A());
    expect(configPath()).toBe(join(A(), "config.json"));
    expect(installedServer()).toBe(join(A(), "server", "surehand-ae.mjs"));
    expect(privateNodeDir()).toBe(join(R(), "node"));
    expect(privateFfmpegDir()).toBe(join(R(), "ffmpeg"));
    expect(migrateLegacy().status).toBe("not-needed");
    expect(existsSync(R())).toBe(false);
  });

  it("SUREHAND_AE_CONFIG and the older AEMCP_CONFIG both move the config", () => {
    process.env.AEMCP_CONFIG = "/x/old.json";
    expect(configPath()).toBe("/x/old.json");
    process.env.SUREHAND_AE_CONFIG = "/x/new.json";
    expect(configPath()).toBe("/x/new.json");
  });

  it("an empty ~/.aemcp is nothing to move", () => {
    mkdirSync(L());
    expect(migrationPending()).toBe(false);
    expect(appDir()).toBe(A());
  });
});

describe("mapLegacyPath", () => {
  it("maps ~/.aemcp paths (node and ffmpeg to the shared root, the server file to its new name)", () => {
    const o = { home: "/Users/ron", path: path.posix };
    expect(mapLegacyPath("/Users/ron/.aemcp/server/ae-mcp.mjs", o)).toBe("/Users/ron/.surehand/ae/server/surehand-ae.mjs");
    expect(mapLegacyPath("/Users/ron/.aemcp/server/ae-mcp.mjs.previous", o)).toBe("/Users/ron/.surehand/ae/server/surehand-ae.mjs.previous");
    expect(mapLegacyPath("/Users/ron/.aemcp/node/bin/node", o)).toBe("/Users/ron/.surehand/node/bin/node");
    expect(mapLegacyPath("/Users/ron/.aemcp/ffmpeg/ffprobe", o)).toBe("/Users/ron/.surehand/ffmpeg/ffprobe");
    expect(mapLegacyPath("/Users/ron/.aemcp/checkpoints/a/v.aep", o)).toBe("/Users/ron/.surehand/ae/checkpoints/a/v.aep");
    expect(mapLegacyPath("/Users/ron/.aemcp", o)).toBe("/Users/ron/.surehand/ae");
    expect(mapLegacyPath("/Users/ron/.aemcp-signing/x.p12", o)).toBe("/Users/ron/.aemcp-signing/x.p12");
    expect(mapLegacyPath("/usr/local/bin/node", o)).toBe("/usr/local/bin/node");
  });

  it("Windows paths: any case, either slash", () => {
    const o = { home: "C:\\Users\\Ron", path: path.win32 };
    expect(mapLegacyPath("C:\\Users\\Ron\\.aemcp\\node\\node.exe", o)).toBe("C:\\Users\\Ron\\.surehand\\node\\node.exe");
    expect(mapLegacyPath("c:\\users\\ron\\.AEMCP\\server\\ae-mcp.mjs", o)).toBe("C:\\Users\\Ron\\.surehand\\ae\\server\\surehand-ae.mjs");
    expect(mapLegacyPath("C:/Users/Ron/.aemcp/checkpoints/a/v.aep", o)).toBe("C:\\Users\\Ron\\.surehand\\ae\\checkpoints\\a\\v.aep");
    expect(mapLegacyPath("C:\\Program Files\\nodejs\\node.exe", o)).toBe("C:\\Program Files\\nodejs\\node.exe");
  });
});

describe("migrateLegacy", () => {
  it("moves a 1.3 installation: everything arrives, nothing of the user's is lost, ~/.aemcp keeps what the old extension needs", () => {
    legacyInstall();
    const before = tree(L());
    expect(migrationPending()).toBe(true);
    expect(appDir()).toBe(L()); // until it has moved
    expect(installedServer()).toBe(join(L(), "server", "ae-mcp.mjs"));

    const r = migrateLegacy({ platform: "darwin" });
    expect(r.status).toBe("migrated");
    expect(r.moved.sort()).toEqual(["activity.jsonl", "backups", "checkpoints", "config.json", "extension-hash", "ffmpeg", "history", "instances", "node", "notes.txt", "proofs", "runtime.json", "server", "update-check.json"]);
    expect(appDir()).toBe(A());
    expect(migrationPending()).toBe(false);

    // every file is there, under its new name
    const after = { ...tree(A()), ...Object.fromEntries(Object.entries(tree(join(R(), "node"))).map(([k, v]) => [`node/${k}`, v])), ...Object.fromEntries(Object.entries(tree(join(R(), "ffmpeg"))).map(([k, v]) => [`ffmpeg/${k}`, v])) };
    for (const [rel, text] of Object.entries(before)) {
      const moved = rel.replace(/^server\/ae-mcp\.mjs/, "server/surehand-ae.mjs");
      if (rel.endsWith("index.json") && rel.startsWith("checkpoints") || rel === "runtime.json") continue; // rewritten with the new paths
      expect(after[moved], moved).toBe(text);
    }
    expect(readFileSync(join(A(), "server", "surehand-ae.mjs"), "utf8")).toBe("server 1.3.4");
    expect(readFileSync(join(A(), "server", "surehand-ae.mjs.previous"), "utf8")).toBe("server 1.3.3");
    expect(readFileSync(join(A(), "backups", "client.aep"), "utf8")).toBe("the user's own file");
    expect(readFileSync(join(R(), "node", "bin", "node"), "utf8")).toBe("node-binary");
    expect(readFileSync(join(R(), "ffmpeg", "ffmpeg"), "utf8")).toBe("ffmpeg-binary");

    // absolute paths in checkpoint indexes and runtime.json point at the new place
    const cp = join(A(), "checkpoints", "Spot-1234abcd");
    expect(JSON.parse(readFileSync(join(cp, "index.json"), "utf8"))[0].file).toBe(join(cp, "2026-01-01-00-00-00-v1.aep"));
    const rt = { node: join(R(), "node", "bin", "node"), server: join(A(), "server", "surehand-ae.mjs"), version: "1.3.4" };
    expect(JSON.parse(readFileSync(join(A(), "runtime.json"), "utf8"))).toEqual(rt);

    // what stays in ~/.aemcp for the 1.3 extension (until After Effects restarts) and old AI app settings
    expect(readdirSync(L()).sort()).toEqual(["MOVED.txt", "config.json", "instances", "node", "runtime.json", "server"]);
    expect(readFileSync(join(L(), "config.json"), "utf8")).toBe(readFileSync(join(A(), "config.json"), "utf8"));
    expect(readdirSync(join(L(), "instances"))).toEqual([]);
    expect(JSON.parse(readFileSync(join(L(), "runtime.json"), "utf8"))).toEqual(rt);
    expect(lstatSync(join(L(), "node")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(L(), "node", "bin", "node"), "utf8")).toBe("node-binary");
    expect(readFileSync(join(L(), "MOVED.txt"), "utf8")).toContain(A());
    expect(readFileSync(r.log, "utf8")).toMatch(/done: moved/);
  });

  it("the file left at ~/.aemcp/server/ae-mcp.mjs runs the moved server with the same arguments", () => {
    legacyInstall();
    migrateLegacy();
    writeFileSync(join(A(), "server", "surehand-ae.mjs"), 'console.log("new server " + process.argv.slice(2).join(" "));\n');
    const r = spawnSync(process.execPath, [join(L(), "server", "ae-mcp.mjs"), "selftest", "--full"], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe("new server selftest --full");
  });

  it("is idempotent: a second run changes nothing", () => {
    legacyInstall();
    expect(migrateLegacy().status).toBe("migrated");
    const a = tree(A()), l = readdirSync(L()).sort();
    expect(migrateLegacy({ force: true }).status).toBe("not-needed");
    expect(tree(A())).toEqual(a);
    expect(readdirSync(L()).sort()).toEqual(l);
  });

  it("a rename that fails half way moves everything back: ~/.aemcp is exactly as it was and stays in use", () => {
    legacyInstall();
    const before = tree(L());
    let calls = 0;
    const r = migrateLegacy({
      rename: (from, to) => {
        if (++calls > 1 && path.basename(from) === "proofs") throw Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
        renameSync(from, to);
      },
    });
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/EBUSY/);
    expect(tree(L())).toEqual(before);
    expect(existsSync(A())).toBe(false);
    expect(existsSync(join(R(), "node"))).toBe(false);
    expect(appDir()).toBe(L());
    expect(configPath()).toBe(join(L(), "config.json"));
    expect(loadConfig().toolProfile).toBe("full");
    expect(readFileSync(r.log, "utf8")).toMatch(/failed, everything was moved back .*EBUSY/);
    // not retried on every start right away; install/update (force) try again
    expect(migrateLegacy().status).toBe("postponed");
    expect(migrateLegacy({ force: true }).status).toBe("migrated");
    expect(appDir()).toBe(A());
  });

  it("a Node.js that is in use (Windows) is copied, and the rest still moves", () => {
    legacyInstall();
    const r = migrateLegacy({
      platform: "win32",
      rename: (from, to) => {
        if (path.basename(from) === "node") throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
        renameSync(from, to);
      },
    });
    expect(r.status).toBe("migrated");
    expect(r.kept.join()).toMatch(/node \(in use, copied/);
    expect(readFileSync(join(R(), "node", "bin", "node"), "utf8")).toBe("node-binary");
    expect(readFileSync(join(L(), "node", "bin", "node"), "utf8")).toBe("node-binary");
    expect(lstatSync(join(L(), "node")).isSymbolicLink()).toBe(false);
  });

  it("after a 1.4 installer put a new server and Node.js in place: those win, the old copies make way", () => {
    legacyInstall();
    put(join(A(), "server", "surehand-ae.mjs"), "server 1.4.0");
    put(join(R(), "node", "bin", "node"), "node 24");
    expect(appDir()).toBe(L()); // not moved yet
    const r = migrateLegacy();
    expect(r.status).toBe("migrated");
    expect(r.kept.join()).toMatch(/server\/ae-mcp\.mjs \(.* already exists\)/);
    // the folder is merged: the old server's leftovers arrive under the new name
    expect(readFileSync(join(A(), "server", "surehand-ae.mjs.previous"), "utf8")).toBe("server 1.3.3");
    expect(readFileSync(join(A(), "server", "surehand-ae.mjs"), "utf8")).toBe("server 1.4.0");
    expect(readFileSync(join(R(), "node", "bin", "node"), "utf8")).toBe("node 24");
    // the old server file forwards; the old Node.js is replaced by a link to the new one
    expect(readFileSync(join(L(), "server", "ae-mcp.mjs"), "utf8")).toMatch(/await import\(".*surehand-ae\.mjs"\)/);
    expect(lstatSync(join(L(), "node")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(L(), "node", "bin", "node"), "utf8")).toBe("node 24");
    expect(readFileSync(join(A(), "checkpoints", "Spot-1234abcd", "2026-01-01-00-00-00-v1.aep"), "utf8")).toBe("aep v1");
  });

  it("one process at a time: a fresh lock means another one is moving it; a stale lock is taken over", () => {
    legacyInstall();
    put(join(R(), ".migrate-ae.lock"), "");
    expect(migrateLegacy().status).toBe("busy");
    expect(migrationPending()).toBe(true);
    const old = (Date.now() - 10 * 60_000) / 1000;
    utimesSync(join(R(), ".migrate-ae.lock"), old, old);
    expect(migrateLegacy().status).toBe("migrated");
    expect(existsSync(join(R(), ".migrate-ae.lock"))).toBe(false);
  });
});

describe("the 1.3 extension until After Effects restarts", () => {
  it("its token is accepted while the new config has none", () => {
    put(join(A(), "config.json"), JSON.stringify({ bridgePort: 9000 }));
    put(join(L(), "MOVED.txt"));
    put(join(L(), "config.json"), JSON.stringify({ token: "legacy-token" }));
    expect(loadConfig()).toMatchObject({ token: "legacy-token", bridgePort: 9000 });
    put(join(A(), "config.json"), JSON.stringify({ token: "new-token" }));
    expect(loadConfig().token).toBe("new-token");
  });

  it("bridges registered in ~/.aemcp/instances are found too", async () => {
    put(join(L(), "MOVED.txt"));
    const srv = createServer((req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, name: "aemcp-bridge", version: "1.3.4", host: { appVersion: "25.6" } })));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as any).port;
    try {
      put(join(A(), "config.json"), JSON.stringify({ token: "t", bridgePort: 1 }));
      put(join(L(), "instances", `${port}.json`), JSON.stringify({ port, host: { appVersion: "25.6" }, lastActivated: "2026-10-01T00:00:00Z" }));
      expect(instanceDirs()).toEqual([join(A(), "instances"), join(L(), "instances")]);
      const list = await listInstances(true);
      expect(list).toEqual([expect.objectContaining({ port, appVersion: "25.6", label: "After Effects 2025", bridgeVersion: "1.3.4", lastActivated: "2026-10-01T00:00:00Z" })]);
      // a custom config path is self-contained
      process.env.SUREHAND_AE_CONFIG = join(home, "elsewhere", "config.json");
      expect(instanceDirs()).toEqual([join(home, "elsewhere", "instances")]);
    } finally {
      srv.close();
    }
  });
});

describe("folders", () => {
  it("legacyDir / newAppDir / surehandRoot", () => {
    expect([legacyDir(), newAppDir(), surehandRoot()]).toEqual([L(), A(), R()]);
  });
});

describe("an interrupted move is finished, never forgotten (H1)", () => {
  const steps = ["planned", "move activity.jsonl", "move server", "move node", "checkpoint indexes", "runtime.json", "config.json copy", "instances", "server forwarder", "node link", "AI app settings", "MOVED.txt", "marker"];
  for (const at of steps) {
    it(`killed at "${at}": the next run finishes it, and nothing is lost`, () => {
      legacyInstall();
      const before = tree(L());
      const kill = Object.assign(new Error("killed"), { simulatedKill: true });
      expect(() => migrateLegacy({ platform: "darwin", repoint: () => [], interrupt: (s) => { if (s === at) throw kill; } })).toThrow("killed");
      // still pending (the marker), new data goes to the destination, and the lock is free again
      expect(migrationInProgress()).toBe(true);
      expect(migrationPending()).toBe(true);
      expect(appDir()).toBe(A());
      expect(migrationBusy()).toBe(false);
      const repointed: string[] = [];
      const r = migrateLegacy({ platform: "darwin", repoint: () => (repointed.push("x"), ["Cursor"]) });
      expect(r.status).toBe("migrated");
      expect(repointed).toEqual(["x"]); // the settings are pointed at the new place before the marker goes
      expect(migrationInProgress()).toBe(false);
      expect(migrationPending()).toBe(false);
      expect(existsSync(join(L(), "MOVED.txt"))).toBe(true);
      expect(readdirSync(L()).sort()).toEqual(["MOVED.txt", "config.json", "instances", "node", "runtime.json", "server"]);
      expect(readFileSync(join(L(), "server", "ae-mcp.mjs"), "utf8")).toMatch(/await import/);
      // every file arrived exactly once
      const after = { ...tree(A()), ...Object.fromEntries(Object.entries(tree(join(R(), "node"))).map(([k, v]) => [`node/${k}`, v])), ...Object.fromEntries(Object.entries(tree(join(R(), "ffmpeg"))).map(([k, v]) => [`ffmpeg/${k}`, v])) };
      for (const [rel, text] of Object.entries(before)) {
        if ((rel.endsWith("index.json") && rel.startsWith("checkpoints")) || rel === "runtime.json") continue;
        expect(after[rel.replace(/^server\/ae-mcp\.mjs/, "server/surehand-ae.mjs")], rel).toBe(text);
      }
      expect(Object.keys(after).some((k) => k.includes(".from-aemcp"))).toBe(false);
    });
  }

  it("~/.aemcp emptied by a killed move (no MOVED.txt) still counts as pending", () => {
    legacyInstall();
    const kill = Object.assign(new Error("killed"), { simulatedKill: true });
    expect(() => migrateLegacy({ interrupt: (s) => { if (s === "checkpoint indexes") throw kill; } })).toThrow();
    expect(readdirSync(L())).toEqual([]); // everything renamed, nothing written yet
    expect(migrationPending()).toBe(true);
    expect(readFileSync(migrationMarker(), "utf8")).toMatch(/"phase": "finishing"/);
    expect(migrateLegacy().status).toBe("migrated");
  });

  it("the server and Node.js move last: until then AI apps' old settings keep working", () => {
    legacyInstall();
    const kill = Object.assign(new Error("killed"), { simulatedKill: true });
    expect(() => migrateLegacy({ interrupt: (s) => { if (s === "move server") throw kill; } })).toThrow();
    expect(existsSync(join(L(), "server", "ae-mcp.mjs"))).toBe(true);
    expect(existsSync(join(L(), "node", "bin", "node"))).toBe(true);
    expect(existsSync(join(A(), "checkpoints"))).toBe(true);
    expect(installedServer()).toBe(join(L(), "server", "ae-mcp.mjs"));
    expect(privateNodeDir()).toBe(join(L(), "node"));
  });
});

describe("locks and clashes (M2)", () => {
  it("a lock is stale when its process is gone (not only by age), and held while it runs", () => {
    legacyInstall();
    mkdirSync(R(), { recursive: true });
    writeFileSync(join(R(), ".migrate-ae.lock"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    expect(migrationBusy()).toBe(true);
    expect(migrateLegacy().status).toBe("busy");
    // a process that has exited
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
    writeFileSync(join(R(), ".migrate-ae.lock"), JSON.stringify({ pid: Number(dead), startedAt: Date.now() }));
    expect(migrationBusy()).toBe(false);
    expect(migrateLegacy().status).toBe("migrated");
  });

  it("never creates a config while another process is moving (it would get a new token)", () => {
    legacyInstall();
    mkdirSync(R(), { recursive: true });
    writeFileSync(join(R(), ".migrate-ae.lock"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    rmSync(join(L(), "config.json"));
    expect(ensureConfig({ waitMs: 50 })).toBe(false);
    expect(existsSync(join(A(), "config.json"))).toBe(false);
    expect(existsSync(join(L(), "config.json"))).toBe(false);
  });

  it("merges into folders that already exist; a clashing file arrives as <name>.from-aemcp", () => {
    legacyInstall();
    put(join(A(), "checkpoints", "Other-99999999", "index.json"), "[]");
    put(join(A(), "history", "Spot-1234abcd", "index.json"), '["newer"]');
    put(join(A(), "notes.txt"), "written by 1.4");
    const r = migrateLegacy();
    expect(r.status).toBe("migrated");
    expect(readdirSync(join(A(), "checkpoints")).sort()).toEqual(["Other-99999999", "Spot-1234abcd"]);
    expect(readFileSync(join(A(), "history", "Spot-1234abcd", "index.json"), "utf8")).toBe('["newer"]');
    expect(readFileSync(join(A(), "history", "Spot-1234abcd", "index.json.from-aemcp"), "utf8")).toBe("[]");
    expect(readFileSync(join(A(), "notes.txt.from-aemcp"), "utf8")).toBe("the user's notes");
    expect(r.renamed.sort()).toEqual(["history/Spot-1234abcd/index.json -> index.json.from-aemcp", "notes.txt -> notes.txt.from-aemcp"]);
    // nothing of the user's stayed behind
    expect(readdirSync(L()).sort()).toEqual(["MOVED.txt", "config.json", "instances", "node", "runtime.json", "server"]);
  });
});

describe("after the move (M6)", () => {
  it("MOVED.txt lists what stayed in ~/.aemcp and only then says nothing there holds data", () => {
    legacyInstall();
    // a Node.js in use (Windows) is copied: the original stays
    migrateLegacy({ platform: "win32", rename: (from, to) => { if (path.basename(from) === "node") throw Object.assign(new Error("busy"), { code: "EPERM" }); renameSync(from, to); } });
    const text = readFileSync(join(L(), "MOVED.txt"), "utf8");
    expect(text).toMatch(/Also still here[\s\S]*node \(a copy/);
    expect(text).not.toMatch(/Nothing here holds your data/);
    // a clean move says it
    newHome();
    legacyInstall();
    migrateLegacy({ platform: "darwin" });
    expect(readFileSync(join(L(), "MOVED.txt"), "utf8")).toMatch(/Nothing here holds your data any more/);
  });

  it("merges what an older server still wrote into ~/.aemcp, and logs it", () => {
    legacyInstall();
    migrateLegacy({ platform: "darwin" });
    // a 1.3 server still running writes a checkpoint and activity there
    put(join(L(), "checkpoints", "Late-1", "v.aep"), "late aep");
    put(join(L(), "activity.jsonl"), '{"tool":"late"}\n');
    put(join(L(), "bridge-status.json"), "{}"); // status of the 1.3 bridge: stays
    const r = lateMerge();
    expect(r.merged.sort()).toEqual(["activity.jsonl", "checkpoints"]);
    expect(readFileSync(join(A(), "checkpoints", "Late-1", "v.aep"), "utf8")).toBe("late aep");
    expect(readFileSync(join(A(), "activity.jsonl.from-aemcp"), "utf8")).toBe('{"tool":"late"}\n');
    expect(existsSync(join(L(), "checkpoints"))).toBe(false);
    expect(existsSync(join(L(), "bridge-status.json"))).toBe(true);
    expect(readFileSync(join(R(), "migration.log"), "utf8")).toMatch(/after the move: merged activity.jsonl, checkpoints/);
    expect(lateMerge().merged).toEqual([]);
  });

  it("adopts permissions and a pause the 1.3 panel saved in ~/.aemcp/config.json (newer and different); never undoes a pause", () => {
    legacyInstall();
    migrateLegacy({ platform: "darwin" });
    const cfg = JSON.parse(readFileSync(join(A(), "config.json"), "utf8"));
    put(join(L(), "config.json"), JSON.stringify({ ...cfg, permissions: { mode: "read-only", allowShell: false } }));
    const later = Date.now() / 1000 + 5;
    utimesSync(join(L(), "config.json"), later, later);
    expect(lateMerge().adopted).toEqual(["permissions"]);
    expect(JSON.parse(readFileSync(join(A(), "config.json"), "utf8"))).toMatchObject({ token: cfg.token, permissions: { mode: "read-only", allowShell: false } });
    // paused in 1.4 meanwhile; the 1.3 panel (no Pause) saves again: the pause stays
    put(join(A(), "config.json"), JSON.stringify({ ...cfg, permissions: { mode: "read-only", allowShell: false }, paused: true }));
    put(join(L(), "config.json"), JSON.stringify({ ...cfg, permissions: { mode: "read-only", allowShell: false } }));
    utimesSync(join(L(), "config.json"), later + 10, later + 10);
    expect(lateMerge().adopted).toEqual([]);
    expect(JSON.parse(readFileSync(join(A(), "config.json"), "utf8")).paused).toBe(true);
    expect(readFileSync(join(R(), "migration.log"), "utf8")).toMatch(/adopted permissions/);
  });
});

describe("only commands that set things up move ~/.aemcp (L2)", () => {
  it("the server's start and setup commands do; commands that only read never do", () => {
    for (const c of [undefined, "--http", "--tools", "setup", "connect", "disconnect", "chatgpt"]) expect(movesLegacyBeforeRunning(c), String(c)).toBe(true);
    for (const c of ["clients", "test", "selftest", "checkpoints", "checkpoint-diff", "diagnostics", "activity", "update", "install", "uninstall", "bogus"])
      expect(movesLegacyBeforeRunning(c), c).toBe(false);
  });

  it("server and After Effects always use the same config.json, and none is created in ~/.aemcp", () => {
    put(join(L(), "notes.txt"), "pending move, no config there");
    expect(configPath()).toBe(join(A(), "config.json"));
    put(join(L(), "config.json"), "{}");
    expect(configPath()).toBe(join(L(), "config.json"));
    put(join(A(), "config.json"), "{}");
    expect(configPath()).toBe(join(A(), "config.json"));
  });
});
