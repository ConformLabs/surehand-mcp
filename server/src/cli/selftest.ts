// `surehand-ae selftest`: checks every link of the chain and runs a small non-destructive job in After Effects.
// `surehand-ae test --json` gives the same quick checks as data for the panel:
// {checks: [{ok, name, message?, fix?: {connect, label?}}]} (fix.connect: an AI app id the panel can connect).
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { health } from "../bridge.js";
import { loadConfig, VERSION } from "../config.js";
import { runJsx } from "../jsx.js";
import { appFile, configPath, legacyDir, migrationPending } from "../paths.js";
import { migrationLog } from "../migrate.js";
import { diagnostics } from "./diagnostics.js";
import { fullSelftest, projectState } from "./fulltest.js";
import { checkForUpdate, compareVersions, updateCheckEnabled, updateMessage } from "../update.js";
import { bundledExtensionSigned, debugModeEnabled, installedExtensionHash, installedExtensionSignature, installedExtensionVersion } from "./setup.js";
import { clientInfo } from "./clients.js";
import { CSXS_VERSIONS, bold, extensionDir, fail, green, ok, readJson, red, sleep, warn } from "./util.js";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** what to do about it */
  fix?: string;
  /** passed, with something worth knowing */
  warning?: boolean;
  /** an AI app the panel can connect to fix it */
  connect?: { id: string; label?: string };
}

/** The panel's shape of a check. */
export function checkJson(c: Check): { ok: boolean; name: string; message?: string; fix?: { connect: string; label?: string } } {
  const message = c.detail + (c.fix && (!c.ok || c.warning) ? ` ${c.fix}` : "");
  return { ok: c.ok, name: c.name, ...(message ? { message } : {}), ...(c.connect ? { fix: { connect: c.connect.id, ...(c.connect.label ? { label: c.connect.label } : {}) } } : {}) };
}

/** The bridge's last status: this version's, else the one the 1.3 extension (before an AE restart) writes. */
function bridgeStatus(): any {
  return readJson<any>(appFile("bridge-status.json"), null) ?? readJson<any>(join(legacyDir(), "bridge-status.json"), null);
}

/** The quick checks (installation, AI app, connection, a small job in a temporary comp). `print` writes them as they run. */
export async function quickChecks(print: boolean, beforeJob?: () => Promise<void>): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (c: Check, plain = false) => {
    checks.push(c);
    if (!print) return;
    const text = c.detail + (c.fix && (!c.ok || c.warning) ? ` ${c.fix}` : "");
    if (!c.ok) fail(text);
    else if (c.warning) warn(text);
    else if (plain) console.log(`  - ${text}`);
    else ok(text);
  };
  const pass = (name: string, detail: string) => add({ name, ok: true, detail });
  const note = (name: string, detail: string, fix?: string) => add({ name, ok: true, warning: true, detail, ...(fix ? { fix } : {}) });
  const bad = (name: string, detail: string, fix?: string) => add({ name, ok: false, detail, ...(fix ? { fix } : {}) });
  const REINSTALL = "Run the installer (1. Install) again.";

  if (updateCheckEnabled()) {
    const u = await checkForUpdate(true);
    const msg = updateMessage(u);
    if (msg) note("update", msg, "Install it with: surehand-ae update (or the panel's Update button).");
    else if (u?.latest) pass("update", `Up to date (latest release v${u.latest})`);
  }

  // --- installation ---
  if (migrationPending()) note("folder", `Your files are still in ${legacyDir()}: moving them to ~/.surehand/ae didn't work yet (see ${migrationLog()}).`, "Quit your AI apps and After Effects, then run the installer again.");
  if (existsSync(configPath()) && loadConfig().token) pass("config", `Config ${configPath()}`);
  else bad("config", `No config at ${configPath()}.`, REINSTALL);

  const hash = installedExtensionHash();
  if (!existsSync(join(extensionDir(), "CSXS", "manifest.xml"))) bad("extension", `After Effects extension missing at ${extensionDir()}.`, REINSTALL);
  else if (hash !== __AEMCP_CEP_HASH__ && compareVersions(installedExtensionVersion() ?? "0", VERSION) > 0)
    note("extension", `A newer After Effects extension (v${installedExtensionVersion()}) is installed than this server (v${VERSION}): another copy of Surehand MCP is newer.`, "Update this one (surehand-ae update, or the latest .mcpb).");
  else if (hash !== __AEMCP_CEP_HASH__) note("extension", `Extension at ${extensionDir()} is a different version (${hash ?? "unknown"} vs ${__AEMCP_CEP_HASH__}).`, REINSTALL);
  else pass("extension", "After Effects extension installed");

  if (bundledExtensionSigned) {
    const sig = installedExtensionSignature();
    if (sig.ok) pass("signature", "Extension signature valid (loads without PlayerDebugMode)");
    else if (debugModeEnabled()) note("signature", `Extension signature: ${sig.problems.join("; ")}. It still loads because PlayerDebugMode is on.`, REINSTALL);
    else bad("signature", `Extension signature: ${sig.problems.join("; ")}. After Effects will not load it.`, REINSTALL);
  } else if (debugModeEnabled()) pass("signature", "Unsigned extensions allowed (PlayerDebugMode)");
  else bad("signature", `This is an unsigned development build and PlayerDebugMode is off for some CSXS versions (${CSXS_VERSIONS.join(", ")}).`, REINSTALL);

  const desktop = clientInfo("claude-desktop");
  if (desktop.configured && desktop.note && /no longer exists/.test(desktop.note))
    add({ name: "claude-desktop", ok: false, detail: `Claude Desktop: ${desktop.note}.`, fix: REINSTALL, connect: { id: "claude-desktop", label: "Reconnect Claude Desktop" } });
  else if (desktop.configured) pass("claude-desktop", `Claude Desktop configured${desktop.note ? ` (${desktop.note})` : ""}`);
  else
    add(
      {
        name: "claude-desktop",
        ok: true,
        detail: "Claude Desktop has no surehand-ae entry (fine if you use the .mcpb extension or another app)",
        ...(desktop.installed ? { connect: { id: "claude-desktop", label: "Connect Claude Desktop" } } : {}),
      },
      true,
    );

  // --- After Effects connection ---
  if (print) console.log("");
  let h;
  try {
    h = await health();
  } catch (e: any) {
    const st = bridgeStatus();
    const last = st ? ` Last bridge status: ${st.listening ? "listening" : "not listening"}${st.error ? " - " + st.error : ""} (${st.at}).` : "";
    bad("bridge", `Bridge not reachable on 127.0.0.1:${loadConfig().bridgePort}.${last}`, "Is After Effects running? Restart it after installing.");
    return checks;
  }
  pass("bridge", `Bridge running inside ${h.host?.appName ?? "AE"} ${h.host?.appVersion ?? ""} (bridge v${h.version})`);
  if ((h as any).authorized === false) {
    bad("token", "Bridge rejected our token: config mismatch.", "Re-run the installer and restart After Effects.");
    return checks;
  }

  const info = await runJsx(
    "var w = null; try { w = app.preferences.getPrefAsLong('Main Pref Section', 'Pref_SCRIPTING_FILE_NETWORK_SECURITY') === 1; } catch (e) {} return { version: app.version, os: $.os, canWrite: w };",
    {},
    { undoGroup: false, timeoutMs: 15000 },
  ).catch((e) => ({ ok: false, error: { message: e.message } }) as any);
  if (!info.ok) {
    bad("extendscript", `ExtendScript failed: ${info.error?.message}`);
    return checks;
  }
  pass("extendscript", `ExtendScript works: After Effects ${info.result.version} on ${info.result.os}`);
  if (info.result.canWrite === false)
    note(
      "scripting-prefs",
      "'Allow Scripts to Write Files and Access Network' is OFF. Previews still work; scripts that write files themselves (File.write, exports) or use the network need it.",
      "AE Settings > Scripting & Expressions.",
    );

  // --- functional test in a temporary comp ---
  await beforeJob?.();
  const tmpDir = appFile("tmp");
  mkdirSync(tmpDir, { recursive: true });
  const png = join(tmpDir, `selftest_${Date.now()}.png`);
  const job = await runJsx(
    `var c = app.project.items.addComp("__aemcp_selftest", 640, 360, 1, 2, 30);
var t = c.layers.addText("Surehand MCP OK");
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
    { undoGroup: "Surehand MCP self-test", timeoutMs: 60000 },
  );
  if (!job.ok) bad("test-job", `Test job failed: ${job.error?.message}`);
  else {
    const r = job.result as any;
    if (r.keys === 2 && r.effect === "ADBE Drop Shadow" && !r.exprError) pass("test-job", "Created a comp, text layer, keyframes, effect and expression (then removed it)");
    else bad("test-job", `Unexpected test result: ${JSON.stringify(r)}`);
    for (let i = 0; i < 50 && !(existsSync(png) && statSync(png).size > 0); i++) await sleep(100);
    if (existsSync(png) && statSync(png).size > 0) {
      const sig = readFileSync(png).subarray(1, 4).toString();
      if (sig === "PNG") pass("preview", "Rendered a frame preview");
      else bad("preview", "Frame preview is not a valid PNG");
      try {
        unlinkSync(png);
      } catch {}
    } else bad("preview", `Frame preview was not written to ${png}`);
  }
  return checks;
}

export async function selftest(full = false): Promise<number> {
  console.log(bold(`\nSurehand MCP self-test v${VERSION}`));
  console.log(`  ${process.platform} · node ${process.version}\n`);
  let before: Awaited<ReturnType<typeof projectState>>;
  // before the test job marks the project as changed
  const checks = await quickChecks(true, full ? async () => void (before = await projectState()) : undefined);
  let failures = checks.filter((c) => !c.ok).length;
  if (full && !failures && checks.some((c) => c.name === "test-job")) failures += await fullSelftest(before);
  return summary(failures);
}

/** `test --json`: the quick checks as JSON on stdout. */
export async function selftestJson(): Promise<number> {
  const checks = await quickChecks(false);
  console.log(JSON.stringify({ checks: checks.map(checkJson) }));
  return checks.every((c) => c.ok) ? 0 : 1;
}
async function summary(failures: number): Promise<number> {
  if (!failures) {
    console.log(`\n${green(bold("All checks passed. Surehand MCP is ready."))}\n`);
    return 0;
  }
  console.log(`\n${red(bold(`${failures} problem(s) found.`))} See README > Troubleshooting.`);
  console.log("If you report it, include everything below (it contains no secrets):\n");
  console.log(await diagnostics());
  return 1;
}
