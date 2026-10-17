// `ae-mcp selftest`: checks every link of the chain and runs a small non-destructive job in After Effects.
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { health } from "../bridge.js";
import { loadConfig, VERSION } from "../config.js";
import { runJsx } from "../jsx.js";
import { diagnostics } from "./diagnostics.js";
import { fullSelftest } from "./fulltest.js";
import { checkForUpdate, compareVersions, updateCheckEnabled, updateMessage } from "../update.js";
import { bundledExtensionSigned, debugModeEnabled, installedExtensionHash, installedExtensionSignature, installedExtensionVersion } from "./setup.js";
import {
  AEMCP_DIR, CONFIG_FILE, CSXS_VERSIONS, SERVER_NAME, bold, claudeDesktopConfig, extensionDir, fail, green, isMac, isWin, ok, readJson, red, sleep, warn,
} from "./util.js";
import { spawnSync } from "node:child_process";

export async function selftest(full = false): Promise<number> {
  let failures = 0;
  const bad = (m: string) => { failures++; fail(m); };
  console.log(bold(`\nAfter Effects MCP self-test v${VERSION}`));
  console.log(`  ${process.platform} · node ${process.version}\n`);

  if (updateCheckEnabled()) {
    const u = await checkForUpdate(true);
    const msg = updateMessage(u);
    if (msg) warn(msg);
    else if (u?.latest) ok(`Up to date (latest release v${u.latest})`);
  }

  // --- installation ---
  if (existsSync(CONFIG_FILE) && loadConfig().token) ok(`Config ${CONFIG_FILE}`);
  else bad(`No config at ${CONFIG_FILE}. Run the installer.`);

  const hash = installedExtensionHash();
  if (!existsSync(join(extensionDir(), "CSXS", "manifest.xml"))) bad(`After Effects extension missing at ${extensionDir()}. Run the installer.`);
  else if (hash !== __AEMCP_CEP_HASH__ && compareVersions(installedExtensionVersion() ?? "0", VERSION) > 0)
    warn(`A newer After Effects extension (v${installedExtensionVersion()}) is installed than this server (v${VERSION}): another copy of AE MCP is newer. Update this one (ae-mcp update, or the latest .mcpb).`);
  else if (hash !== __AEMCP_CEP_HASH__) warn(`Extension at ${extensionDir()} is a different version (${hash ?? "unknown"} vs ${__AEMCP_CEP_HASH__}). Re-run the installer.`);
  else ok("After Effects extension installed");

  if (bundledExtensionSigned) {
    const sig = installedExtensionSignature();
    if (sig.ok) ok("Extension signature valid (loads without PlayerDebugMode)");
    else if (debugModeEnabled()) warn(`Extension signature: ${sig.problems.join("; ")}. It still loads because PlayerDebugMode is on; re-run the installer to fix.`);
    else bad(`Extension signature: ${sig.problems.join("; ")}. After Effects will not load it. Re-run the installer.`);
  } else if (debugModeEnabled()) ok("Unsigned extensions allowed (PlayerDebugMode)");
  else bad(`This is an unsigned development build and PlayerDebugMode is off for some CSXS versions (${CSXS_VERSIONS.join(", ")}). Run the installer.`);

  const desktop = readJson<any>(claudeDesktopConfig(), null);
  if (desktop?.mcpServers?.[SERVER_NAME]) {
    const cmd = desktop.mcpServers[SERVER_NAME].command;
    if (cmd && !existsSync(cmd)) bad(`Claude Desktop points to a Node that no longer exists: ${cmd}. Re-run the installer.`);
    else ok("Claude Desktop configured");
  } else console.log("  - Claude Desktop config has no after-effects entry (fine if you use the .mcpb extension or another app)");

  // --- After Effects connection ---
  console.log("");
  let h;
  try {
    h = await health();
  } catch (e: any) {
    bad(`Bridge not reachable on 127.0.0.1:${loadConfig().bridgePort}. Is After Effects running? (restart it after installing)`);
    const statusFile = join(AEMCP_DIR, "bridge-status.json");
    if (existsSync(statusFile)) {
      const st = readJson<any>(statusFile, {});
      console.log(`    last bridge status: ${st.listening ? "listening" : "not listening"}${st.error ? " - " + st.error : ""} (${st.at})`);
    }
    return summary(failures);
  }
  ok(`Bridge running inside ${h.host?.appName ?? "AE"} ${h.host?.appVersion ?? ""} (bridge v${h.version})`);
  if ((h as any).authorized === false) {
    bad("Bridge rejected our token: config mismatch. Re-run the installer and restart After Effects.");
    return summary(failures);
  }

  const info = await runJsx(
    "var w = null; try { w = app.preferences.getPrefAsLong('Main Pref Section', 'Pref_SCRIPTING_FILE_NETWORK_SECURITY') === 1; } catch (e) {} return { version: app.version, os: $.os, canWrite: w };",
    {},
    { undoGroup: false, timeoutMs: 15000 },
  ).catch((e) => ({ ok: false, error: { message: e.message } }) as any);
  if (!info.ok) return bad(`ExtendScript failed: ${info.error?.message}`), summary(failures);
  ok(`ExtendScript works: After Effects ${info.result.version} on ${info.result.os}`);
  if (info.result.canWrite === false)
    warn("'Allow Scripts to Write Files and Access Network' is OFF. Previews still work; scripts that write files themselves (File.write, exports) or use the network need it: AE Settings > Scripting & Expressions.");

  // --- functional test in a temporary comp ---
  const tmpDir = join(AEMCP_DIR, "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const png = join(tmpDir, `selftest_${Date.now()}.png`);
  const job = await runJsx(
    `var c = app.project.items.addComp("__aemcp_selftest", 640, 360, 1, 2, 30);
var t = c.layers.addText("AE MCP OK");
var p = t.property("ADBE Transform Group").property("ADBE Position");
p.setValuesAtTimes([0, 1], [[100, 180], [540, 180]]);
var fx = t.property("ADBE Effect Parade").addProperty("ADBE Drop Shadow");
t.property("ADBE Transform Group").property("ADBE Opacity").expression = "50 + 50 * Math.sin(time)";
var f = new File(args.png);
var wrote = false;
// saveFrameToPng works even when "Allow Scripts to Write Files" is off (confirmed on macOS and Windows)
c.saveFrameToPng(1, f); var w = 0; while (!f.exists && w < 10000) { $.sleep(50); w += 50; } wrote = f.exists; $.sleep(100);
var r = { keys: p.numKeys, effect: fx.matchName, exprError: t.property("ADBE Transform Group").property("ADBE Opacity").expressionError, wrote: wrote };
c.remove();
return r;`,
    { png },
    { undoGroup: "AE MCP self-test", timeoutMs: 60000 },
  );
  if (!job.ok) bad(`Test job failed: ${job.error?.message}`);
  else {
    const r = job.result as any;
    if (r.keys === 2 && r.effect === "ADBE Drop Shadow" && !r.exprError) ok("Created a comp, text layer, keyframes, effect and expression (then removed it)");
    else bad(`Unexpected test result: ${JSON.stringify(r)}`);
    {
      for (let i = 0; i < 50 && !(existsSync(png) && statSync(png).size > 0); i++) await sleep(100);
      if (existsSync(png) && statSync(png).size > 0) {
        const sig = readFileSync(png).subarray(1, 4).toString();
        sig === "PNG" ? ok("Rendered a frame preview") : bad("Frame preview is not a valid PNG");
        try { unlinkSync(png); } catch {}
      } else bad(`Frame preview was not written to ${png}`);
    }
  }
  if (full && !failures) {
    failures += await fullSelftest();
  }
  return summary(failures);
}

async function summary(failures: number): Promise<number> {
  if (!failures) {
    console.log(`\n${green(bold("All checks passed. After Effects MCP is ready."))}\n`);
    return 0;
  }
  console.log(`\n${red(bold(`${failures} problem(s) found.`))} See README > Troubleshooting.`);
  console.log("If you report it, include everything below (it contains no secrets):\n");
  console.log(await diagnostics());
  return 1;
}
