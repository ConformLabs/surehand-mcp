// Tests the current build on this Mac: installs it (without touching the AI apps' settings)
// and runs the full self-test against every After Effects that is open here.
// The Windows counterpart is test-windows.mjs.
//
//   npm run test:mac
//   npm run test:mac -- --allow-no-ae   (pass even if no After Effects is open)
//
// After Effects only loads a new extension when it starts: an open AE keeps running the
// previous one, which this reports (restart AE and run again to test the new extension too).
//
// The installed server, the extension and the open After Effects are shared by every checkout
// on this Mac, so one run at a time: a run waits (up to --wait-minutes, default 30) while another
// holds ~/.surehand/test-mac.lock, and fails if the installed server stops being its own build.
//
// "~" is the user's real home folder even when $HOME points elsewhere (agent runners set it to a
// temp folder): that is where the installed server, the extension and After Effects are.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock, buildInfo, describeBuild, interruptedBy, realHome, sha256File } from "./test-guard.mjs";

if (process.platform !== "darwin") {
  console.error("test-mac runs on macOS only.");
  process.exit(1);
}
const allowNoAe = process.argv.includes("--allow-no-ae");
const waitArg = process.argv.indexOf("--wait-minutes");
const waitMinutes = waitArg > 0 && Number.isFinite(Number(process.argv[waitArg + 1])) ? Number(process.argv[waitArg + 1]) : 30;
const bundle = fileURLToPath(new URL("../dist/surehand-ae.mjs", import.meta.url));
const buildVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const home = realHome();
// ~/.surehand/ae/server/surehand-ae.mjs; ~/.aemcp/server/ae-mcp.mjs only while a 1.3 installation could not be moved
const newInstalled = join(home, ".surehand", "ae", "server", "surehand-ae.mjs");
const legacyInstalled = join(home, ".aemcp", "server", "ae-mcp.mjs");
const legacyPending = () => existsSync(join(home, ".aemcp")) && !existsSync(join(home, ".aemcp", "MOVED.txt")) && readdirSync(join(home, ".aemcp")).length > 0;
let installed = newInstalled;
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const build = describeBuild(buildInfo(dirname(bundle)));
const bundleSha = sha256File(bundle);
const tested = `${build}, dist/surehand-ae.mjs sha256 ${bundleSha}`;
const node = (args, env = {}) => {
  const r = spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, HOME: home, ...env }, maxBuffer: 32 * 1024 * 1024 });
  const sig = interruptedBy(r);
  if (sig) {
    // stop here: an interrupted step is not a test failure, and the rest of the run would not be a result
    console.error(`\nInterrupted (${sig}): no result for ${tested}.`);
    process.exit(130);
  }
  return { status: r.status, out: plain((r.stdout || "") + (r.stderr || "")) };
};
console.log(`Mac test (v${buildVersion}): ${tested}`);
console.log(`Home folder: ${home}${process.env.HOME && process.env.HOME !== home ? ` (not $HOME ${process.env.HOME})` : ""}`);

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => process.exit(130)); // while waiting for the lock; the exit hook releases it
try {
  await acquireLock(join(home, ".surehand", "test-mac.lock"), { owner: { build, bundleSha, cwd: process.cwd() }, waitMs: waitMinutes * 60_000 });
} catch (e) {
  console.error(`\n${e.message}. Run again later (or pass --wait-minutes N).`);
  process.exit(1);
}
/** Fails the run if something outside this run replaced the installed server. */
const checkInstalled = (when) => {
  let sha = "missing";
  try {
    sha = sha256File(installed);
  } catch {}
  if (sha === bundleSha) return;
  console.error(`\nThe installed server (${installed}) is not this build ${when}: sha256 ${sha}, expected ${bundleSha}. Results are not valid for ${build}.`);
  process.exit(1);
};

console.log("\n== install");
const inst = node([bundle, "install", "--skip-clients"]);
console.log(inst.out.split("\n").filter((l) => /✔|✖|!/.test(l)).join("\n"));
if (inst.status !== 0 || !/Extension:/.test(inst.out)) {
  console.error("install failed:\n" + inst.out);
  process.exit(1);
}
if (legacyPending()) {
  installed = legacyInstalled;
  console.log(`  ! ~/.aemcp could not be moved to ~/.surehand/ae (see ~/.surehand/migration.log): testing ${installed}`);
}
checkInstalled("after install");

const alive = (pid) => {
  try {
    return !pid || process.kill(pid, 0);
  } catch (e) {
    return e.code === "EPERM";
  }
};
// this version's extension registers in ~/.surehand/ae/instances; a 1.3 extension (an After Effects not restarted
// since the update) in ~/.aemcp/instances
let instances = [];
for (const dir of [join(home, ".surehand", "ae", "instances"), join(home, ".aemcp", "instances")]) {
  try {
    instances.push(
      ...readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
        .filter((i) => i.port && alive(i.pid) && !instances.some((j) => j.port === i.port)), // skip files left behind by an After Effects that crashed
    );
  } catch {}
}

let failed = 0;
if (!instances.length) {
  console.log("\n== no After Effects open: running the checks that don't need it");
  console.log(node([installed, "selftest"]).out.split("\n").filter((l) => /✔|✖|!/.test(l)).join("\n"));
  checkInstalled("after the self-test");
  if (!allowNoAe) {
    console.error("\nOpen After Effects and run again (or pass --allow-no-ae).");
    process.exit(1);
  }
} else {
  for (const i of instances) {
    console.log(`\n== After Effects ${i.host?.appVersion ?? "?"} (bridge port ${i.port})`);
    const r = node([installed, "selftest", "--full"], { SUREHAND_AE_BRIDGE_PORT: String(i.port), AEMCP_BRIDGE_PORT: String(i.port) });
    console.log(r.out.split("\n").filter((l) => /✖|signature|Bridge running|steps passed|step\(s\) failed|All checks|problem/i.test(l)).join("\n"));
    const bridge = /bridge v(\S+?)\)/.exec(r.out)?.[1];
    if (bridge && bridge !== buildVersion)
      console.log(`  ! this After Effects still runs the v${bridge} extension: restart it to test v${buildVersion}'s extension too`);
    if (r.status !== 0) failed++;
    checkInstalled(`after the self-test on After Effects ${i.host?.appVersion ?? "?"}`);
  }
}
console.log(failed ? `\n${failed} After Effects version(s) failed on this Mac.` : `\nMac: all passed on ${instances.length} After Effects version(s).`);
console.log(`Tested: ${tested}`);
process.exit(failed ? 1 : 0);
