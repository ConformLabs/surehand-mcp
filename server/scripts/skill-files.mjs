// The Agent Skills in skills/ (one folder per skill: SKILL.md plus optional references/), as text keyed by their
// path ("surehand-ae/SKILL.md"). Shared by build.mjs (which embeds them, so the single-file server can install them)
// and vitest.config.ts (the tests see the real files).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const SKILLS_ROOT = new URL("../../skills/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

export function readSkillFiles() {
  const files = {};
  (function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      // Windows checkouts may turn line ends into CRLF: the skills are written as they are in the repo
      else files[relative(SKILLS_ROOT, p).split(sep).join("/")] = readFileSync(p, "utf8").replace(/\r\n/g, "\n");
    }
  })(SKILLS_ROOT);
  return files;
}
