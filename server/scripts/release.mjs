// Cuts a release in one go:
//   version bump -> sign the AE extension -> check (types, tests, build) -> Mac + Windows tests ->
//   package -> commit + push -> wait for CI -> GitHub release with the zip, .mcpb and server file.
//
//   npm run release -- 1.3.2 --notes notes.md
//   options: --skip-mac       don't run the Mac test (scripts/test-mac.mjs: needs After Effects open here)
//            --skip-windows   don't run the Windows test (scripts/test-windows.mjs)
//            --draft          create the GitHub release as a draft
//
// Stops at the first failure. Nothing is pushed until everything local has passed; if CI then
// fails, the commit is on main but no release is published.
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
if (sh("git", ["tag", "-l", tag])) die(`tag ${tag} already exists`);
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
const zip = join(dist, `AE-MCP-${version}.zip`);
const mcpb = join(dist, "AE-MCP.mcpb");
copyFileSync(join(dist, "AE-MCP", "1. Claude Desktop (easiest)", "AE-MCP.mcpb"), mcpb);
// the single-file server, for `ae-mcp update` and the panel's Update button
const serverFile = join(dist, "ae-mcp.mjs");
copyFileSync(join(SERVER, "dist", "ae-mcp.mjs"), serverFile);
const digest = await new Promise((ok, bad) => {
  const h = createHash("sha256");
  createReadStream(serverFile).on("data", (d) => h.update(d)).on("end", () => ok(h.digest("hex"))).on("error", bad);
});
writeFileSync(`${serverFile}.sha256`, `${digest}  ae-mcp.mjs\n`);
for (const f of [zip, mcpb, serverFile]) if (!existsSync(f)) die(`missing ${f}`);

step("commit and push");
sh("git", ["add", "-A"]);
sh("git", ["commit", "-q", "-m", `Release ${version}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`]);
sh("git", ["push", "-q", "origin", "main"]);
const sha = sh("git", ["rev-parse", "HEAD"]);
console.log(sha.slice(0, 7));

step("wait for CI");
let runId = "";
for (let i = 0; i < 40 && !runId; i++) {
  runId = sh("gh", ["run", "list", "--commit", sha, "--json", "databaseId", "--jq", ".[0].databaseId"]);
  if (!runId) await new Promise((r) => setTimeout(r, 3000));
}
if (!runId) die("CI did not start for this commit");
const ci = spawnSync("gh", ["run", "watch", runId, "--exit-status", "--interval", "15"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
console.log(sh("gh", ["run", "view", runId, "--json", "jobs", "--jq", '.jobs[] | "\\(.name): \\(.conclusion)"']));
if (ci.status !== 0) die(`CI failed (run ${runId}); ${tag} was not released`);

step("GitHub release");
run("gh", ["release", "create", tag, zip, mcpb, serverFile, `${serverFile}.sha256`, "--title", tag, "--notes-file", notes, ...(flag("--draft") ? ["--draft"] : [])], ROOT);
console.log(`\n✔ released ${tag}: ${sh("gh", ["release", "view", tag, "--json", "url", "--jq", ".url"])}`);
