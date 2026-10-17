// Tests the current build on this Mac: installs it (without touching the AI apps' settings)
// and runs the full self-test against every After Effects that is open here.
// The Windows counterpart is test-windows.mjs.
//
//   npm run test:mac
//   npm run test:mac -- --allow-no-ae   (pass even if no After Effects is open)
//
// After Effects only loads a new extension when it starts: an open AE keeps running the
// previous one, which this reports (restart AE and run again to test the new extension too).
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.error("test-mac runs on macOS only.");
  process.exit(1);
}
const allowNoAe = process.argv.includes("--allow-no-ae");
const bundle = fileURLToPath(new URL("../dist/ae-mcp.mjs", import.meta.url));
const buildVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const installed = join(homedir(), ".aemcp", "server", "ae-mcp.mjs");
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const node = (args, env = {}) => {
  const r = spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 32 * 1024 * 1024 });
  return { status: r.status, out: plain((r.stdout || "") + (r.stderr || "")) };
};

console.log(`Mac test (v${buildVersion})`);
console.log("\n== install");
const inst = node([bundle, "install", "--skip-clients"]);
console.log(inst.out.split("\n").filter((l) => /✔|✖|!/.test(l)).join("\n"));
if (inst.status !== 0 || !/Extension:/.test(inst.out)) {
  console.error("install failed:\n" + inst.out);
  process.exit(1);
}

const alive = (pid) => {
  try {
    return !pid || process.kill(pid, 0);
  } catch (e) {
    return e.code === "EPERM";
  }
};
const dir = join(homedir(), ".aemcp", "instances");
let instances = [];
try {
  instances = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
    .filter((i) => i.port && alive(i.pid)); // skip files left behind by an After Effects that crashed
} catch {}

let failed = 0;
if (!instances.length) {
  console.log("\n== no After Effects open: running the checks that don't need it");
  console.log(node([installed, "selftest"]).out.split("\n").filter((l) => /✔|✖|!/.test(l)).join("\n"));
  if (!allowNoAe) {
    console.error("\nOpen After Effects and run again (or pass --allow-no-ae).");
    process.exit(1);
  }
} else {
  for (const i of instances) {
    console.log(`\n== After Effects ${i.host?.appVersion ?? "?"} (bridge port ${i.port})`);
    const r = node([installed, "selftest", "--full"], { AEMCP_BRIDGE_PORT: String(i.port) });
    console.log(r.out.split("\n").filter((l) => /✖|signature|Bridge running|steps passed|step\(s\) failed|All checks|problem/i.test(l)).join("\n"));
    const bridge = /bridge v(\S+?)\)/.exec(r.out)?.[1];
    if (bridge && bridge !== buildVersion)
      console.log(`  ! this After Effects still runs the v${bridge} extension: restart it to test v${buildVersion}'s extension too`);
    if (r.status !== 0) failed++;
  }
}
console.log(failed ? `\n${failed} After Effects version(s) failed on this Mac.` : `\nMac: all passed on ${instances.length} After Effects version(s).`);
process.exit(failed ? 1 : 0);
