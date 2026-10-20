// The Agent Skills (skills/ in the repo): their format (what claude.ai and the AI apps accept), that every tool they
// name exists, and how `install` / `uninstall` write and remove them. A temporary home: nothing real is touched.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { registeredTools } from "./registered-tools.js";

const home = mkdtempSync(join(tmpdir(), "surehand-skills-"));
vi.mock("node:os", async (orig) => ({ ...(await orig<typeof import("node:os")>()), homedir: () => home }));
const installed = new Set<string>();
vi.mock("../src/cli/clients.js", async (orig) => ({ ...(await orig<typeof import("../src/cli/clients.js")>()), clientInstalled: (id: string) => installed.has(id) }));

const { SKILL_NAMES, installSkills, skillsStatus, skillZip, uninstallSkills } = await import("../src/cli/skills.js");
const { serverInstructions } = await import("../src/docs.js");

const ROOT = fileURLToPath(new URL("../../skills/", import.meta.url));
const folders = readdirSync(ROOT).filter((n) => !n.startsWith("."));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
/** Every file of a skill (path inside the skill folder). */
const filesOf = (name: string): string[] => {
  const out: string[] = [];
  (function walk(dir: string, rel: string) {
    for (const n of readdirSync(dir, { withFileTypes: true })) {
      if (n.isDirectory()) walk(join(dir, n.name), `${rel}${n.name}/`);
      else out.push(`${rel}${n.name}`);
    }
  })(join(ROOT, name), "");
  return out.sort();
};

/** The frontmatter's top-level keys and values (only simple `key: value` lines are allowed in ours). */
function frontmatter(text: string): { keys: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error("no frontmatter");
  const keys: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([a-z-]+):\s?(.*)$/.exec(line);
    if (kv) keys[kv[1]] = kv[2];
    else if (!/^\s/.test(line)) throw new Error(`frontmatter line: ${line}`);
  }
  return { keys, body: m[2] };
}

describe("the skills' format", () => {
  it("are exactly SKILL_NAMES, and the bundle carries every file", () => {
    expect(folders.sort()).toEqual([...SKILL_NAMES].sort());
    const bundled = Object.keys(__AEMCP_SKILLS__).sort();
    expect(bundled).toEqual(folders.flatMap((n) => filesOf(n).map((f) => `${n}/${f}`)).sort());
  });

  for (const name of folders) {
    it(`${name}: frontmatter claude.ai accepts, a short body, no presets or dates`, () => {
      const { keys, body } = frontmatter(read(`${name}/SKILL.md`));
      // claude.ai's upload rejects any other key
      for (const k of Object.keys(keys)) expect(["name", "description", "license", "metadata"]).toContain(k);
      expect(keys.name).toBe(name);
      expect(keys.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(keys.description.length).toBeGreaterThan(50);
      expect(keys.description.length).toBeLessThan(200);
      expect(keys.description).toMatch(/After Effects/);
      expect(keys.description).not.toMatch(/^(I|You|Use)\b/); // third person: what it does, then when
      expect(keys.description).not.toMatch(/[<>]/);
      expect(body.split("\n").length).toBeLessThan(150);
      for (const f of filesOf(name)) {
        const text = read(`${name}/${f}`);
        expect(text).not.toMatch(/\bpresets?\b|\btemplates?\b|canned/i);
        expect(text).not.toMatch(/\b20\d\d\b/);
        expect(text).not.toMatch(/\r/);
      }
    });
  }

  it("every ae_* tool the skills and the server instructions name is registered (core or on demand)", () => {
    const tools = registeredTools();
    const texts = [...folders.flatMap((n) => filesOf(n).map((f) => read(`${n}/${f}`))), serverInstructions(true)];
    const named = new Set(texts.flatMap((t) => [...t.matchAll(/\bae_[a-z_]+/g)].map((m) => m[0])));
    expect(named.size).toBeGreaterThan(20);
    expect([...named].filter((n) => !tools.has(n))).toEqual([]);
  });

  it("the references a skill points to are there", () => {
    for (const name of folders)
      for (const m of read(`${name}/SKILL.md`).matchAll(/references\/[\w.-]+/g)) expect(existsSync(join(ROOT, name, m[0]))).toBe(true);
  });
});

describe("the server instructions", () => {
  it("stay under 4,000 characters (Claude Code cuts at 4,096), and the rules come first", () => {
    for (const onDemand of [true, false]) {
      const t = serverInstructions(onDemand);
      expect(t.length).toBeLessThan(4000);
      expect(t.indexOf("ae_status")).toBeLessThan(t.indexOf("ae_get_project_info"));
      expect(t.indexOf("Changes")).toBeLessThan(t.indexOf("ae_project_xray"));
    }
    expect(serverInstructions(true)).toMatch(/ae_tools lists them.*\n.*ae_call runs them/);
    expect(serverInstructions(false)).not.toMatch(/ae_call/);
  });
});

/** The entries of a zip: path -> content (directories: null). */
function unzip(buf: Buffer): Map<string, string | null> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, string | null>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const data = buf.subarray(start, start + csize);
    out.set(name, name.endsWith("/") ? null : (method === 8 ? inflateRawSync(data) : data).toString("utf8"));
    p += 46 + nlen + elen + clen;
  }
  return out;
}

describe("installing and removing the skills", () => {
  const claude = join(home, ".claude", "skills"), agents = join(home, ".agents", "skills"), zips = join(home, ".surehand", "ae", "skills");
  beforeEach(() => {
    for (const d of [".claude", ".agents", ".surehand"]) rmSync(join(home, d), { recursive: true, force: true });
    installed.clear();
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("writes a skills folder only for the AI apps on this computer that read it, and always the zips", () => {
    installed.add("claude-code");
    const r = installSkills();
    expect(r.targets.map((t) => [t.dir, t.written])).toEqual([
      [claude, true],
      [agents, false],
    ]);
    expect(readdirSync(claude).sort()).toEqual([...SKILL_NAMES].sort());
    expect(existsSync(agents)).toBe(false);
    expect(readFileSync(join(claude, "surehand-ae", "references", "extendscript-traps.md"), "utf8")).toBe(read("surehand-ae/references/extendscript-traps.md"));
    expect(r.zips).toEqual(SKILL_NAMES.map((n) => join(zips, `${n}.zip`)));

    installed.clear();
    installed.add("windsurf");
    expect(installSkills().targets.map((t) => t.written)).toEqual([true, true]); // ~/.claude/skills is there now
  });

  it("each zip holds the skill folder at its root, exactly as in the repo", () => {
    installSkills();
    for (const name of SKILL_NAMES) {
      const entries = unzip(readFileSync(join(zips, `${name}.zip`)));
      for (const path of entries.keys()) expect(path.startsWith(`${name}/`)).toBe(true);
      for (const f of filesOf(name)) expect(entries.get(`${name}/${f}`)).toBe(read(`${name}/${f}`));
      expect([...entries.values()].filter((v) => v !== null).length).toBe(filesOf(name).length);
      expect(skillZip(name).equals(readFileSync(join(zips, `${name}.zip`)))).toBe(true); // the same bytes every time
    }
  });

  it("overwrites only our own folders, never another skill or Claude's synced ones", () => {
    installed.add("cursor");
    for (const d of ["my-skill", "synced/x", "anthropic-skills/y"]) {
      mkdirSync(join(claude, d), { recursive: true });
      writeFileSync(join(claude, d, "SKILL.md"), "mine");
    }
    mkdirSync(join(claude, "surehand-ae"), { recursive: true });
    writeFileSync(join(claude, "surehand-ae", "old.md"), "from an older version");
    installSkills();
    expect(existsSync(join(claude, "surehand-ae", "old.md"))).toBe(false);
    expect(skillsStatus().targets[0]).toMatchObject({ installed: SKILL_NAMES, outdated: [] });
    writeFileSync(join(claude, "surehand-ae", "SKILL.md"), "edited");
    expect(skillsStatus().targets[0].outdated).toEqual(["surehand-ae"]);

    const removed = uninstallSkills();
    expect(removed).toHaveLength(SKILL_NAMES.length * 3); // the folders in both places and the zips
    expect(readdirSync(claude).sort()).toEqual(["anthropic-skills", "my-skill", "synced"]);
    for (const d of ["my-skill", "synced/x", "anthropic-skills/y"]) expect(readFileSync(join(claude, d, "SKILL.md"), "utf8")).toBe("mine");
    expect(readdirSync(agents)).toEqual([]);
    expect(existsSync(zips)).toBe(false);
  });

  it("the server's uninstall removes them too", async () => {
    const { uninstall } = await import("../src/cli/uninstall.js");
    vi.spyOn(console, "log").mockImplementation(() => {});
    installed.add("codex");
    installSkills();
    mkdirSync(join(agents, "other"), { recursive: true });
    uninstall([]);
    expect(readdirSync(agents)).toEqual(["other"]);
    expect(existsSync(zips)).toBe(false);
  });
});

// installer/run.sh and run.ps1 remove our skills when there is no Node.js to run the server's uninstaller
describe("uninstall without Node.js (installer launchers)", () => {
  const LAUNCHERS = new URL("../../installer/", import.meta.url);
  it("run.sh and run.ps1 carry the same skill names as the server", () => {
    const sh = readFileSync(new URL("run.sh", LAUNCHERS), "utf8");
    const ps = readFileSync(new URL("run.ps1", LAUNCHERS), "utf8");
    expect(/^SKILLS="([^"]*)"/m.exec(sh)?.[1].split(" ")).toEqual(SKILL_NAMES);
    expect([.../^\$skills = @\(([^)]*)\)/m.exec(ps)![1].matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual(SKILL_NAMES);
  });

  it.skipIf(process.platform === "win32")("run.sh uninstall removes exactly our skills", () => {
    const h = mkdtempSync(join(tmpdir(), "surehand-runsh-skills-"));
    for (const d of [".claude/skills/surehand-ae", ".claude/skills/mine", ".agents/skills/surehand-ae-delivery"]) mkdirSync(join(h, d), { recursive: true });
    const r = spawnSync("bash", [fileURLToPath(new URL("run.sh", LAUNCHERS)), "uninstall"], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", HOME: h, SUREHAND_AE_FORCE_NODE_DOWNLOAD: "1", SUREHAND_AE_BRIDGE_PORT: "1", AEMCP_BRIDGE_PORT: "1" },
    });
    expect(r.status).toBe(0);
    expect(readdirSync(join(h, ".claude", "skills"))).toEqual(["mine"]);
    expect(readdirSync(join(h, ".agents", "skills"))).toEqual([]);
    rmSync(h, { recursive: true, force: true });
  });
});
