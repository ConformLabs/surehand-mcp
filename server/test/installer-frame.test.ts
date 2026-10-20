// The Conform Labs installer frame (installer/common) and this app's installers: what can be checked without
// Windows or the Mac Installer. Nothing here runs an installer or touches the real home folder.
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const nsh = read("installer/common/conformlabs.nsh");
const nsi = read("installer/windows/nsis/surehand-mcp.nsi");
const app = JSON.parse(read("installer/app.json"));
const frameUrl = new URL("../../installer/common/frame.mjs", import.meta.url).href;

// the body of an NSIS function
const fn = (text: string, name: string) => {
  const m = new RegExp(`^\\s*Function ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n([\\s\\S]*?)^\\s*FunctionEnd`, "m").exec(text);
  if (!m) throw new Error(`no Function ${name}`);
  return m[1];
};

describe("Windows installer: maintenance page (Setup run again)", () => {
  it("comes first and replaces the welcome page when the app is installed", () => {
    const pages = [...nsi.matchAll(/^!insertmacro (CL_PAGE_\w+|CL_UNPAGE_\w+|MUI_PAGE_\w+|MUI_UNPAGE_\w+)/gm)].map((m) => m[1]);
    expect(pages).toEqual(["CL_PAGE_MAINTENANCE", "CL_PAGE_WELCOME", "CL_PAGE_INSTFILES", "CL_PAGE_FINISH", "CL_UNPAGE_CONFIRM", "CL_UNPAGE_INSTFILES"]);
    expect(fn(nsi, ".onInit")).toMatch(/!insertmacro CL_ONINIT/);
    expect(fn(nsh, "cl.WelcomePre")).toMatch(/\$cl\.Installed == 1\s*\n\s*Abort/);
  });

  it("is never shown by a silent Setup, which installs or upgrades", () => {
    const create = fn(nsh, "cl.MaintenanceCreate");
    expect(create).toMatch(/\$\{If\} \$cl\.Installed != 1\s*\n\s*\$\{OrIf\} \$\{Silent\}\s*\n\s*Abort/);
    // detection only reads the registry: no prompts that a silent Setup would stop at
    expect(fn(nsh, "cl.DetectInstalled")).not.toMatch(/MessageBox|Abort|Quit/);
    // the install section itself does not depend on the maintenance page
    expect(nsi.slice(nsi.indexOf('Section "Install"'))).not.toMatch(/\$cl\./);
  });

  it("detects the installation by the uninstall entry and uninstaller this installer writes", () => {
    expect(nsi).toMatch(/!define CL_UNINST_KEY "\$\{UNINST_KEY\}"/);
    expect(nsi).toMatch(/!define CL_UNINST_EXE "\$\{UNINST_EXE\}"/);
    for (const v of ["DisplayVersion", "InstallLocation"]) expect(nsi).toMatch(new RegExp(`WriteRegStr HKCU "\\$\\{UNINST_KEY\\}" "${v}"`));
    expect(nsi).toMatch(/WriteUninstaller "\$INSTDIR\\\$\{UNINST_EXE\}"/);
    const detect = fn(nsh, "cl.DetectInstalled");
    expect(detect).toMatch(/ReadRegStr \$cl\.InstalledVersion HKCU "\$\{CL_UNINST_KEY\}" "DisplayVersion"/);
    expect(detect).toMatch(/ReadRegStr \$cl\.InstalledDir HKCU "\$\{CL_UNINST_KEY\}" "InstallLocation"/);
    expect(detect).toMatch(/FileExists\} "\$cl\.InstalledDir\\\$\{CL_UNINST_EXE\}"/);
    // Update / Reinstall / Install X (you have Y)
    for (const t of ["Reinstall ${CL_APP_VERSION}", "Update to ${CL_APP_VERSION}", "Install ${CL_APP_VERSION} (you have $cl.InstalledVersion)"]) expect(detect).toContain(t);
  });

  it("uninstalls by running the installed uninstaller and waiting for it, not with logic of its own", () => {
    const leave = fn(nsh, "cl.MaintenanceLeave");
    expect(leave).toMatch(/CopyFiles \/SILENT "\$cl\.InstalledDir\\\$\{CL_UNINST_EXE\}" "\$PLUGINSDIR\\uninstall\.exe"/);
    expect(leave).toMatch(/ExecWait '"\$PLUGINSDIR\\uninstall\.exe" _\?=\$cl\.InstalledDir' \$0/);
    expect(leave).toMatch(/\$\{If\} \$0 == 0\s*\n\s*Quit/); // done: Setup closes
    expect(leave).toMatch(/Abort ; cancelled or failed/); // cancelled: back on the page
    // the frame removes nothing itself: that stays in the app's uninstall section
    expect(nsh).not.toMatch(/\bRMDir\b|\bDelete(RegKey)? "\$(INSTDIR|PROFILE)|nsExec|uninstall --keep-config/);
    // and that section still keeps the shared Node.js for another Surehand app
    expect(nsi).toMatch(/Section "Uninstall"[\s\S]*another Surehand app uses it/);
  });
});

describe("Windows installer: Conform Labs look", () => {
  it("uses this app's accent and the frame's colours and fonts", () => {
    expect(`#${/!define CL_ACCENT "([0-9A-F]{6})"/.exec(nsi)?.[1]}`).toBe(app.accent.dark.toUpperCase());
    expect(nsh).toMatch(/SetFont "Segoe UI" 9/);
    expect(nsh).toMatch(/BrandingText "A Conform Labs product"/);
    expect(nsh).toMatch(/!define MUI_BGCOLOR "\$\{CL_PANEL\}"/);
    expect(nsh).toMatch(/!define MUI_INSTFILESPAGE_COLORS/);
    expect(nsi).toMatch(/!include "\$\{__FILEDIR__\}\\\.\.\\\.\.\\common\\conformlabs\.nsh"/);
  });

  it("darkens the title bar, hides MUI's white separators, and has no Back on the first page", () => {
    const gui = fn(nsh, "${UN}cl.GUIInit");
    expect(gui).toMatch(/DwmSetWindowAttribute\(p \$HWNDPARENT, i 20, \*i 1, i 4\)/);
    expect(gui).toMatch(/DwmSetWindowAttribute\(p \$HWNDPARENT, i 19, \*i 1, i 4\)/); // older Windows 10
    const hide = fn(nsh, "${UN}cl.HideLines");
    for (const id of [1035, 1036, 1045]) expect(hide).toMatch(new RegExp(`GetDlgItem \\$0 \\$HWNDPARENT ${id}\\s*\\n\\s*ShowWindow \\$0 \\$\\{SW_HIDE\\}`));
    // MUI shows the separators again on page changes: every page hides them
    for (const page of ["cl.MaintenanceCreate", "cl.WelcomeShow", "cl.FinishShow", "${UN}cl.InnerPageShow"]) expect(fn(nsh, page)).toMatch(/Call (\$\{UN\})?cl\.HideLines/);
    for (const page of ["cl.MaintenanceCreate", "cl.WelcomeShow"]) expect(fn(nsh, page)).toMatch(/Call cl\.DisableBack/);
    expect(fn(nsh, "cl.DisableBack")).toMatch(/GetDlgItem \$0 \$HWNDPARENT 3\s*\n\s*EnableWindow \$0 0/);
  });

  it("draws the finish page's help link as two left-aligned lines, the link clickable", () => {
    const finish = fn(nsh, "cl.FinishShow");
    expect(finish).toMatch(/ShowWindow \$mui\.FinishPage\.Link \$\{SW_HIDE\}/);
    expect(finish).toMatch(/NSD_CreateLabel\} 120u 166u 195u 10u "\$\{CL_FINISHPAGE_LINK_CAPTION\}"/);
    expect(finish).toMatch(/NSD_CreateLabel\} 120u 177u 195u 11u "\$\{CL_FINISH_LINK\}"/);
    expect(finish).toMatch(/NSD_OnClick\} \$0 cl\.FinishLinkClick/);
    expect(fn(nsh, "cl.FinishLinkClick")).toMatch(/ExecShell "open" "\$\{CL_FINISH_URL\}"/);
    expect(nsi).toMatch(/!define CL_FINISHPAGE_LINK_CAPTION "Documentation and help:"/);
    expect(nsi).toMatch(/!define MUI_FINISHPAGE_LINK "github\.com\/ConformLabs\/surehand-mcp"/);
  });

  it("finish wording matches the panel's first-run hint, on Windows and Mac", () => {
    const hint = "ask it something about your After Effects project, like “What’s in my project?” The Surehand panel in After Effects (Window › Extensions › Surehand MCP) shows when it's connected.";
    expect(nsi).toContain(`Restart After Effects if it is open, and restart your AI apps.$\\r$\\n$\\r$\\nThen open your AI app and ${hint}`);
    expect(read("installer/mac/pkg/resources/conclusion.body.html")).toContain(`Then open your AI app and ${hint}`);
  });

  it("has every bitmap size the frame picks from, as 24-bit BMPs of the right size", async () => {
    const { WIZARD_SIZES, HEADER_SIZES } = await import(frameUrl);
    const pick = fn(nsh, "${UN}cl.PickArt");
    for (const [kind, sizes] of [["wizard", WIZARD_SIZES], ["header", HEADER_SIZES]] as [string, number[][]][]) {
      const widths = sizes.map(([w]) => w);
      // nearest size: the thresholds in cl.PickArt are the midpoints between the widths
      const block = pick.slice(pick.indexOf(`StrCpy $1 ${widths[0]}`));
      for (let i = 1; i < widths.length; i++) expect(block).toContain(`$0 > ${Math.floor((widths[i - 1] + widths[i]) / 2)} \${|} StrCpy $1 ${widths[i]}`);
      for (const [w, h] of sizes) {
        const file = join(ROOT, "installer/windows/nsis/art", `${kind}-${w}.bmp`);
        const b = readFileSync(file);
        expect([b.toString("latin1", 0, 2), b.readInt32LE(18), b.readInt32LE(22), b.readUInt16LE(28)]).toEqual(["BM", w, h, 24]);
      }
    }
    expect(nsh).toMatch(/MUI_WELCOMEFINISHPAGE_BITMAP "\$\{CL_ART\}\\wizard-164\.bmp"/);
    expect(nsh).toMatch(/MUI_HEADERIMAGE_BITMAP "\$\{CL_ART\}\\header-150\.bmp"/);
  });

  // makensis (brew install makensis) compiles the real script with a stand-in payload; any warning fails (-WX)
  const makensis = spawnSync("makensis", ["-VERSION"], { encoding: "utf8" }).status === 0;
  it.skipIf(!makensis)("compiles with makensis without warnings", () => {
    const dir = mkdtempSync(join(tmpdir(), "surehand-nsis-"));
    try {
      for (const f of ["node.exe", "surehand-ae.mjs"]) writeFileSync(join(dir, f), "stand-in");
      const defines = {
        VERSION: "1.4.0-beta.1", VERSION4: "1.4.0.0", NODE_VERSION: "24.22.0", NODE_EXE: join(dir, "node.exe"), SERVER_MJS: join(dir, "surehand-ae.mjs"),
        LOG_FILTER: join(ROOT, "installer/windows/nsis/log-filter.cjs"), ICON: join(ROOT, "brand/Surehand.ico"), OUTFILE: join(dir, "Surehand-MCP-Setup-1.4.0-beta.1.exe"), ESTIMATED_KB: "100",
      };
      const r = spawnSync("makensis", ["-V2", "-WX", "-INPUTCHARSET", "UTF8", ...Object.entries(defines).map(([k, v]) => `-D${k}=${v}`), join(ROOT, "installer/windows/nsis/surehand-mcp.nsi")], {
        encoding: "utf8",
        env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" }, // makensis on macOS aborts without a UTF-8 locale
      });
      expect(`${r.stdout}${r.stderr}`.trim()).toBe("");
      expect(r.status).toBe(0);
      expect(existsSync(defines.OUTFILE)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("Mac installer: Conform Labs frame", () => {
  it("fills the welcome and conclusion pages from this app's bodies", async () => {
    const { macPage } = await import(frameUrl);
    for (const page of ["welcome", "conclusion"]) {
      const html: string = macPage(page, { version: "9.8.7" });
      expect(html).not.toMatch(/@[A-Z_]+@/);
      expect(html).toContain("9.8.7");
      expect(html).toContain(app.name);
      expect(html).toContain("for Adobe® After Effects®");
      expect(html).toMatch(/prefers-color-scheme: dark/);
      expect(html).toContain(app.accent.dark);
    }
    const dist = read("installer/mac/pkg/distribution.xml");
    for (const f of ["welcome.html", "conclusion.html", "background-light.tiff", "background-dark.tiff"]) expect(dist).toContain(`file="${f}"`);
    for (const f of ["background-light.tiff", "background-dark.tiff"]) expect(existsSync(join(ROOT, "installer/mac/pkg/resources", f))).toBe(true);
    expect(read("server/scripts/package-mac-pkg.mjs")).toMatch(/macPage\(page, \{ version \}\)/);
  });
});
