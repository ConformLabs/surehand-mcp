// Cuts a release in one go:
//   version bump -> sign the AE extension -> check (types, tests, build) -> Mac + Windows tests ->
//   package -> release pull request -> wait for its CI -> merge -> GitHub release with the zip, .mcpb
//   and server file, on the merged commit.
//
//   npm run release -- 1.3.2 --notes notes.md
//   options: --skip-mac       don't run the Mac test (scripts/test-mac.mjs: needs After Effects open here)
//            --skip-windows   don't run the Windows test (scripts/test-windows.mjs)
//            --draft          create the GitHub release as a draft
//
// main only accepts changes through a pull request with green CI (a GitHub ruleset), so the release
// commit goes on a release/X.Y.Z branch with its own PR. Stops at the first failure: nothing is pushed
// until everything local has passed, and if the PR's CI fails, main is untouched and nothing is published
// (the PR stays open to fix or close).
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("..", import.meta.url));
const ROOT = join(SERVER, "..");
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : undefined);
const version = args.find((a) => /^\d+\.\d+\.\d+$/.test(a));
const notes = opt("--notes") && resolve(process.cwd(), opt("--notes"));
const tag = `v${version}`;

const die = (m) => {
  console.error(`\n✖ ${m}`);
  process.exit(1);
};
const step = (m) => console.log(`\n== ${m}`);
const sh = (cmd, a, o = {}) => execFileSync(cmd, a, { cwd: ROOT, encoding: "utf8", ...o }).trim();
const run = (cmd, a, cwd = SERVER) => {
  const r = spawnSync(cmd, a, { cwd, stdio: "inherit" });
  if (r.status !== 0) die(`${cmd} ${a.join(" ")} failed`);
};
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

// --- preflight: everything that can be checked before changing anything ---
step("checks before starting");
if (!version || !notes) die("usage: npm run release -- <x.y.z> --notes <notes.md> [--skip-mac] [--skip-windows] [--draft]");
if (!existsSync(notes)) die(`notes file not found: ${notes}`);
const pkg = JSON.parse(readFileSync(join(SERVER, "package.json"), "utf8"));
if (!newer(version, pkg.version)) die(`${version} is not newer than the current ${pkg.version}`);
if (sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]) !== "main") die("not on main");
if (sh("git", ["status", "--porcelain"])) die("the working tree has uncommitted changes: commit or stash them first");
sh("git", ["fetch", "-q", "origin", "main"]);
if (sh("git", ["rev-list", "--count", "HEAD..origin/main"]) !== "0") die("main is behind origin/main: pull first");
if (sh("git", ["rev-list", "--count", "origin/main..HEAD"]) !== "0") die("main has commits that aren't on origin/main: get them merged through a PR first");
if (sh("git", ["tag", "-l", tag])) die(`tag ${tag} already exists`);
if (spawnSync("gh", ["release", "view", tag], { cwd: ROOT, stdio: "ignore" }).status === 0) die(`GitHub release ${tag} already exists`);
const branch = `release/${version}`;
if (sh("git", ["ls-remote", "--heads", "origin", branch])) die(`branch ${branch} already exists on GitHub: delete it or finish that release first`);
const repo = sh("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
if (spawnSync("gh", ["auth", "status"], { stdio: "ignore" }).status !== 0) die("gh is not logged in");
console.log(`releasing ${pkg.version} -> ${version}`);

step("version");
run("npm", ["version", version, "--no-git-tag-version"]);

step("sign the After Effects extension");
run("npm", ["run", "sign"]);

step("check: types, tests, build");
run("npm", ["run", "check"]);

if (!flag("--skip-mac")) {
  step("Mac");
  run(process.execPath, [join(SERVER, "scripts", "test-mac.mjs")]);
}

if (!flag("--skip-windows")) {
  step("Windows");
  run(process.execPath, [join(SERVER, "scripts", "test-windows.mjs")]);
}

step("package");
run("npm", ["run", "package"]);
const dist = join(ROOT, "dist-zip");
const zip = join(dist, `Surehand-MCP-${version}.zip`);
const mcpb = join(dist, "Surehand-MCP.mcpb");
copyFileSync(join(dist, "Surehand-MCP", "1. Claude Desktop (easiest)", "Surehand-MCP.mcpb"), mcpb);
// the single-file server, for `ae-mcp update` and the panel's Update button
const serverFile = join(dist, "ae-mcp.mjs");
copyFileSync(join(SERVER, "dist", "ae-mcp.mjs"), serverFile);
const digest = await new Promise((ok, bad) => {
  const h = createHash("sha256");
  createReadStream(serverFile).on("data", (d) => h.update(d)).on("end", () => ok(h.digest("hex"))).on("error", bad);
});
writeFileSync(`${serverFile}.sha256`, `${digest}  ae-mcp.mjs\n`);
for (const f of [zip, mcpb, serverFile]) if (!existsSync(f)) die(`missing ${f}`);

step(`release pull request (${branch})`);
sh("git", ["checkout", "-q", "-b", branch]);
sh("git", ["add", "-A"]);
sh("git", ["commit", "-q", "-m", `Release ${version}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`]);
const tested = sh("git", ["rev-parse", "HEAD"]);
sh("git", ["push", "-q", "-u", "origin", branch]);
// gh api, not "gh pr create/merge": those can fail on GitHub's retired Projects (classic) GraphQL fields
const prBody = `Version ${version}: made by \`npm run release\` after check, test:mac and test:windows passed locally. Merged by the release script when CI is green.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
const pr = JSON.parse(sh("gh", ["api", "-X", "POST", `repos/${repo}/pulls`, "-f", `title=Release ${version}`, "-f", `head=${branch}`, "-f", "base=main", "-f", `body=${prBody}`]));
console.log(`PR #${pr.number}: ${pr.html_url}`);

step("wait for the PR's CI");
// checks appear a few seconds after the push
const checks = () => spawnSync("gh", ["pr", "checks", String(pr.number)], { cwd: ROOT, encoding: "utf8" }).stdout || "";
for (let i = 0; i < 60 && !/\t(pass|fail|pending)/.test(checks()); i++) await new Promise((r) => setTimeout(r, 5000));
spawnSync("gh", ["pr", "checks", String(pr.number), "--watch", "--interval", "15"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
const result = checks();
console.log(result.split("\n").map((l) => l.split("\t").slice(0, 2).join(": ")).filter(Boolean).join("\n"));
if (!/\tpass/.test(result) || /\t(fail|pending|cancel)/.test(result)) {
  sh("git", ["checkout", "-q", "main"]);
  die(`CI didn't pass on PR #${pr.number}; main is untouched and ${tag} was not released. Fix it on ${branch} or close the PR.`);
}

step("merge");
const merged = JSON.parse(sh("gh", ["api", "-X", "PUT", `repos/${repo}/pulls/${pr.number}/merge`, "-f", "merge_method=squash", "-f", `commit_title=Release ${version} (#${pr.number})`]));
if (!merged.merged) die(`PR #${pr.number} wasn't merged: ${merged.message}`);
const sha = merged.sha;
sh("git", ["fetch", "-q", "origin", "main"]);
// the merged commit must be exactly what was tested and packaged
if (sh("git", ["rev-parse", `${sha}^{tree}`]) !== sh("git", ["rev-parse", `${tested}^{tree}`])) die(`the merged main (${sha.slice(0, 7)}) differs from the tested release commit (${tested.slice(0, 7)}); nothing was published`);
sh("git", ["checkout", "-q", "main"]);
sh("git", ["reset", "-q", "--hard", "origin/main"]);
sh("git", ["branch", "-q", "-D", branch]);
console.log(`main is at ${sha.slice(0, 7)}`);

step("GitHub release");
run("gh", ["release", "create", tag, zip, mcpb, serverFile, `${serverFile}.sha256`, "--target", sha, "--title", tag, "--notes-file", notes, ...(flag("--draft") ? ["--draft"] : [])], ROOT);
console.log(`\n✔ released ${tag}: ${sh("gh", ["release", "view", tag, "--json", "url", "--jq", ".url"])}`);
