// Tests the current build on a Windows PC over SSH: copies dist/surehand-ae.mjs, installs it
// (without touching the AI apps' settings) and runs the full self-test against every
// After Effects that is open there.
//
//   npm run test:windows                    (host "ron-pc" from ~/.ssh/config)
//   AEMCP_WIN_HOST=other-pc npm run test:windows
//   npm run test:windows -- --allow-no-ae   (pass even if no After Effects is open)
//
// Needs key-based SSH to the PC (OpenSSH server on Windows). SSH cannot open windows on the
// PC's desktop, so After Effects has to be opened there by hand.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const host = process.env.AEMCP_WIN_HOST || "ron-pc";
const allowNoAe = process.argv.includes("--allow-no-ae");
const bundle = fileURLToPath(new URL("../dist/surehand-ae.mjs", import.meta.url));
const buildVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const SSH = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

/** Runs a cmd.exe command line on the PC. */
function remote(cmdline, { quiet = false } = {}) {
  const r = spawnSync("ssh", [...SSH, host, cmdline], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const out = (r.stdout || "") + (r.stderr || "");
  if (!quiet) process.stdout.write(out);
  return { status: r.status, out };
}

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

console.log(`Windows test on ${host}`);
if (remote("echo ok", { quiet: true }).out.trim() !== "ok") {
  console.error(`Cannot reach ${host} over SSH (key login). See the windows-testing notes.`);
  process.exit(1);
}

const scp = spawnSync("scp", [...SSH, "-q", bundle, `${host}:surehand-ae-test.mjs`], { stdio: "inherit" });
if (scp.status !== 0) process.exit(1);

// Surehand MCP's own Node if the installer downloaded one, else the one on PATH
const nodeExe =
  remote(
    `powershell -NoProfile -Command "$p = Join-Path $env:USERPROFILE '.surehand\\node\\node.exe'; $q = Join-Path $env:USERPROFILE '.aemcp\\node\\node.exe'; if (Test-Path $p) { $p } elseif (Test-Path $q) { $q } else { (Get-Command node -ErrorAction SilentlyContinue).Source }"`,
    { quiet: true },
  ).out.trim() || "node";
const run = (args) => `cd /d "%USERPROFILE%" && "${nodeExe}" ${args}`;

console.log(`\n== install (${nodeExe})`);
const inst = remote(run("surehand-ae-test.mjs install --skip-clients & del surehand-ae-test.mjs"), { quiet: true });
const instOut = plain(inst.out);
console.log(instOut.split(/\r?\n/).filter((l) => /✔|✖|!|installer v/.test(l)).join("\n"));
if (!/Extension:/.test(instOut)) {
  console.error("install failed:\n" + instOut);
  process.exit(1);
}

const list = remote(
  `powershell -NoProfile -Command "Get-ChildItem $env:USERPROFILE\\.surehand\\ae\\instances\\*.json, $env:USERPROFILE\\.aemcp\\instances\\*.json -ErrorAction SilentlyContinue | ForEach-Object { $j = Get-Content $_ -Raw | ConvertFrom-Json; '{0} {1}' -f $j.port, $j.host.appVersion }"`,
  { quiet: true },
);
const instances = list.out.split(/\r?\n/).map((l) => l.trim().split(" ")).filter((p, i, all) => /^\d+$/.test(p[0]) && all.findIndex((q) => q[0] === p[0]) === i);
// the installed server: ~/.aemcp's only while a 1.3 installation could not be moved (see .surehand\migration.log)
const moved = remote(`if exist "%USERPROFILE%\\.surehand\\ae\\server\\surehand-ae.mjs" (echo new) else (echo old)`, { quiet: true }).out.trim();
const server = moved === "old" ? ".aemcp\\server\\ae-mcp.mjs" : ".surehand\\ae\\server\\surehand-ae.mjs";

let failed = 0;
if (!instances.length) {
  console.log("\n== no After Effects open on the PC: running the checks that don't need it");
  const r = remote(run(`${server} selftest`), { quiet: true });
  console.log(plain(r.out).split(/\r?\n/).filter((l) => /✔|✖|!/.test(l)).join("\n"));
  if (!allowNoAe) {
    console.error("\nOpen After Effects on the PC and run again (or pass --allow-no-ae).");
    process.exit(1);
  }
} else {
  for (const [port, aeVersion] of instances) {
    console.log(`\n== After Effects ${aeVersion} (bridge port ${port})`);
    const r = remote(run(`${server} selftest --full`).replace("&& ", `&& set SUREHAND_AE_BRIDGE_PORT=${port}&& `), { quiet: true });
    const out = plain(r.out);
    console.log(out.split(/\r?\n/).filter((l) => /✖|signature|Bridge running|steps passed|step\(s\) failed|All checks|problem/i.test(l)).join("\n"));
    const bridge = /bridge v(\S+?)\)/.exec(out)?.[1];
    if (bridge && bridge !== buildVersion) {
      console.log(`  ! this After Effects still runs the v${bridge} extension: restart it on the PC to test v${buildVersion}'s extension too`);
      if (r.status !== 0) console.log(`  ! a failure here is likely that mix (v${bridge} extension, v${buildVersion} server): restart After Effects on the PC and run again before looking further`);
    }
    if (r.status !== 0) failed++;
  }
}
console.log(failed ? `\n${failed} After Effects version(s) failed on Windows.` : `\nWindows: all passed on ${instances.length} After Effects version(s).`);
process.exit(failed ? 1 : 0);
