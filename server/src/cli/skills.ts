// Agent Skills: how to use Surehand well (skills/ in the repo, embedded in the bundle by build.mjs).
//
//   ~/.claude/skills/<name>/          Claude Code (Cursor and VS Code read it too)
//   ~/.agents/skills/<name>/          ChatGPT desktop / Codex, Cursor, VS Code, Windsurf / Devin Desktop
//   ~/.surehand/ae/skills/<name>.zip  Claude Desktop chat and claude.ai can't read files: the user uploads these
//                                     (Customize › Skills › Upload a skill)
// (%USERPROFILE% on Windows.) A skills folder is written only when an app that reads it is on this computer
// (clientInstalled, as `install` decides which apps to connect) or the folder is there already. `install` and
// `setup` (which `update` runs) write them; `uninstall` removes them.
//
// Only our own folders (SKILL_NAMES) are ever written or removed: every other skill stays as it is, and Claude's
// own folders in ~/.claude/skills (synced/, anthropic-skills) are never touched.
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { writeFileAtomic } from "../fsutil.js";
import { appFile } from "../paths.js";
import { crc32 } from "../png.js";
import { CLIENT_NAMES, clientInstalled, type ClientId } from "./clients.js";

/** Our skills. installer/run.sh and run.ps1 (uninstall without Node.js) carry the same list: a test keeps them equal. */
export const SKILL_NAMES = ["surehand-ae", "surehand-ae-delivery", "surehand-ae-safe-restructure", "surehand-ae-timing-layout"];

export interface SkillTarget {
  dir: string;
  /** the AI apps that read skills from it */
  apps: ClientId[];
}

export const skillTargets = (): SkillTarget[] => [
  { dir: join(homedir(), ".claude", "skills"), apps: ["claude-code", "cursor", "vscode"] },
  { dir: join(homedir(), ".agents", "skills"), apps: ["codex", "cursor", "vscode", "windsurf"] },
];

/** The zips for Claude Desktop chat / claude.ai. */
export const skillZipDir = () => appFile("skills");

/** A skill's files as they are installed: [path inside the skill folder, text]. */
function skillFiles(name: string): [string, string][] {
  return Object.entries(__AEMCP_SKILLS__)
    .filter(([rel]) => rel.startsWith(`${name}/`))
    .map(([rel, text]) => [rel.slice(name.length + 1), text]);
}

/** Replaces our skill folder `name` in `dir` with the bundled one. */
function writeSkill(dir: string, name: string) {
  if (!SKILL_NAMES.includes(name)) throw new Error(`not a Surehand skill: ${name}`);
  const target = join(dir, name);
  rmSync(target, { recursive: true, force: true });
  for (const [rel, text] of skillFiles(name)) {
    const p = join(target, ...rel.split("/"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
}

/** Is the bundled skill there, file for file? */
function skillCurrent(dir: string, name: string): boolean {
  return skillFiles(name).every(([rel, text]) => {
    try {
      return readFileSync(join(dir, name, ...rel.split("/")), "utf8") === text;
    } catch {
      return false;
    }
  });
}

/**
 * One skill as a zip, the skill folder at its root (what Customize › Skills › Upload a skill takes). Deflated,
 * UTF-8 names, every entry dated 1980-01-01 so the same skill always gives the same bytes.
 */
export function skillZip(name: string): Buffer {
  const files = skillFiles(name);
  const dirs = [...new Set(files.flatMap(([rel]) => rel.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"))))];
  const entries = [
    { path: `${name}/`, data: null as Buffer | null },
    ...dirs.map((d) => ({ path: `${name}/${d}/`, data: null })),
    ...files.map(([rel, text]) => ({ path: `${name}/${rel}`, data: Buffer.from(text, "utf8") })),
  ];
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.path, "utf8");
    const raw = e.data ?? Buffer.alloc(0);
    const packed = e.data ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed: 2.0
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(e.data ? 8 : 0, 8); // deflate / stored
    head.writeUInt16LE(0, 10); // 00:00
    head.writeUInt16LE(0x21, 12); // 1980-01-01
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    local.push(head, nameBuf, packed);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(e.data ? 8 : 0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(packed.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(e.data ? 0 : 0x10, 38); // MS-DOS directory attribute
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += head.length + nameBuf.length + packed.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

export interface SkillsInstallResult {
  /** each skills folder: written, or why not */
  targets: { dir: string; apps: string[]; written: boolean; reason?: string; error?: string }[];
  /** the zips written for Claude Desktop chat / claude.ai */
  zips: string[];
  zipError?: string;
}

/** Writes (or overwrites) our skills where an app reads them, and the zips. Never throws. */
export function installSkills(): SkillsInstallResult {
  const res: SkillsInstallResult = { targets: [], zips: [] };
  for (const t of skillTargets()) {
    const apps = t.apps.map((id) => CLIENT_NAMES[id]);
    if (!existsSync(t.dir) && !t.apps.some(clientInstalled)) {
      res.targets.push({ dir: t.dir, apps, written: false, reason: `none of ${apps.join(", ")} found` });
      continue;
    }
    try {
      for (const name of SKILL_NAMES) writeSkill(t.dir, name);
      res.targets.push({ dir: t.dir, apps, written: true });
    } catch (e: any) {
      res.targets.push({ dir: t.dir, apps, written: false, error: e.message });
    }
  }
  try {
    mkdirSync(skillZipDir(), { recursive: true });
    for (const name of SKILL_NAMES) {
      const file = join(skillZipDir(), `${name}.zip`);
      writeFileAtomic(file, skillZip(name));
      res.zips.push(file);
    }
  } catch (e: any) {
    res.zipError = e.message;
  }
  return res;
}

/** Removes exactly our skill folders and zips; returns what was removed. */
export function uninstallSkills(): string[] {
  const removed: string[] = [];
  for (const t of skillTargets())
    for (const name of SKILL_NAMES) {
      const p = join(t.dir, name);
      if (!existsSync(p)) continue;
      rmSync(p, { recursive: true, force: true });
      removed.push(p);
    }
  for (const name of SKILL_NAMES) {
    const p = join(skillZipDir(), `${name}.zip`);
    if (!existsSync(p)) continue;
    rmSync(p, { force: true });
    removed.push(p);
  }
  try {
    rmdirSync(skillZipDir());
  } catch {} // not empty (or not there): left as it is
  return removed;
}

/** `skills --json`: where our skills are installed. */
export function skillsStatus() {
  return {
    skills: SKILL_NAMES,
    targets: skillTargets().map((t) => ({
      dir: t.dir,
      apps: t.apps.map((id) => CLIENT_NAMES[id]),
      installed: SKILL_NAMES.filter((n) => existsSync(join(t.dir, n, "SKILL.md"))),
      outdated: SKILL_NAMES.filter((n) => existsSync(join(t.dir, n, "SKILL.md")) && !skillCurrent(t.dir, n)),
    })),
    zips: { dir: skillZipDir(), files: SKILL_NAMES.map((n) => join(skillZipDir(), `${n}.zip`)).filter((f) => existsSync(f)) },
  };
}
