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
const aiApps = JSON.parse(read("installer/ai-apps.json"));
const frameUrl = new URL("../../installer/common/frame.mjs", import.meta.url).href;
const aiAppsUrl = new URL("../../installer/ai-apps.mjs", import.meta.url).href;
const frame = await import(frameUrl);

// the body of an NSIS function
const fn = (text: string, name: string) => {
  const m = new RegExp(`^\\s*Function ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n([\\s\\S]*?)^\\s*FunctionEnd`, "m").exec(text);
  if (!m) throw new Error(`no Function ${name}`);
  return m[1];
};
const macro = (text: string, name: string) => {
  const m = new RegExp(`^!macro ${name}\\b[^\\n]*\\n([\\s\\S]*?)^!macroend`, "m").exec(text);
  if (!m) throw new Error(`no !macro ${name}`);
  return m[1];
};

describe("Windows installer: pages", () => {
  it("Update or uninstall / Welcome, Choose AI apps, progress, finish", () => {
    const pages = [...nsi.matchAll(/^(?:!insertmacro (CL_PAGE_\w+|CL_UNPAGE_\w+|MUI_PAGE_\w+|MUI_UNPAGE_\w+)|Page custom (\w+))/gm)].map((m) => m[1] ?? m[2]);
    expect(pages).toEqual(["CL_PAGE_MAINTENANCE", "CL_PAGE_WELCOME", "AppsCreate", "CL_PAGE_INSTFILES", "CL_PAGE_FINISH", "CL_UNPAGE_CONFIRM", "CL_UNPAGE_INSTFILES"]);
    expect(fn(nsi, ".onInit")).toMatch(/!insertmacro CL_ONINIT/);
    expect(fn(nsi, "un.onInit")).toMatch(/!insertmacro CL_UNONINIT/);
    for (const f of [".onGUIEnd", "un.onGUIEnd"]) expect(fn(nsi, f)).toMatch(/!insertmacro CL_ONGUIEND/);
    expect(nsh).toMatch(/Function cl\.WelcomePre\n\s*\$\{If\} \$cl\.Installed == 1\s*\n\s*Abort/);
  });

  it("the welcome copy is the design's, word for word", () => {
    expect(nsi).toContain('!define MUI_WELCOMEPAGE_TITLE "Install ${PRODUCT}"');
    expect(nsi).toContain('!define CL_WELCOME_SUB "for Adobe® After Effects®"');
    expect(nsi).toContain('!define CL_WELCOME_TEXT1 "Surehand lets the AI apps you use, like Claude, ChatGPT and Cursor, work in After Effects on this computer. Every edit is listed. You can undo it in After Effects."');
    expect(nsi).toContain('!define CL_WELCOME_TEXT2 "It installs for your Windows account only. No administrator rights needed."');
    expect(nsi).toContain('!define CL_WELCOME_TEXT3 "Next, you choose which AI apps to connect."');
    expect(nsi).toContain('!insertmacro MUI_HEADER_TEXT "Choose AI apps" "Surehand connects the apps you tick. You can change this later in the panel."');
    expect(nsh).toContain('Caption "${CL_APP_NAME} setup"');
  });

  it("is never interactive when silent: no maintenance page, every AI app found is connected as before", () => {
    expect(fn(nsh, "cl.MaintenanceCreate")).toMatch(/\$\{If\} \$cl\.Installed != 1\s*\n\s*\$\{OrIf\} \$\{Silent\}\s*\n\s*Abort/);
    expect(fn(nsh, "cl.DetectInstalled")).not.toMatch(/MessageBox|Abort|Quit/);
    const section = nsi.slice(nsi.indexOf('Section "Install"'), nsi.indexOf("SectionEnd", nsi.indexOf('Section "Install"')));
    // the page was not shown (silent): plain `install`, which connects every app it finds
    expect(section).toMatch(/StrCpy \$1 "install --clients none"\s*\n\s*\$\{If\} \$\{Silent\}\s*\n\s*\$\{OrIf\} \$App1\.Chosen == ""\s*\n\s*StrCpy \$1 "install"/);
    // every MessageBox in the install section answers itself when silent
    for (const m of section.match(/MessageBox[^\n]*/g) ?? []) expect(m).toMatch(/\/SD ID(OK|YES|NO)/);
    expect(fn(nsi, "CheckClaudeDesktop")).toMatch(/MessageBox[^\n]*\/SD IDOK/);
  });
});

describe("Windows installer: Choose AI apps (one list with the Mac Installer)", () => {
  it("is generated from installer/ai-apps.json", async () => {
    const { nsisApps } = await import(aiAppsUrl);
    const text: string = nsisApps();
    aiApps.apps.forEach((a: any, i: number) => expect(text).toContain(`!insertmacro \${MACRO} ${i + 1} "${a.id}" "${a.name}"`));
    expect(text).toContain(`!define AI_APP_COUNT ${aiApps.apps.length}`);
    expect(text).toContain(`!define AI_WEB_TITLE "${aiApps.web.title}"`);
    expect(nsi).toMatch(/!include "\$\{AI_APPS_NSH\}"/);
    expect(read("server/scripts/package-win-installer.mjs")).toMatch(/writeFileSync\(appsNsh, nsisApps\(\)\)/);
  });

  it("the server names the apps from the same list", async () => {
    const { CLIENT_NAMES, CLIENT_IDS, INSTALLER_ORDER } = await import("../src/cli/clients.js");
    for (const a of aiApps.apps) expect(CLIENT_NAMES[a.id as keyof typeof CLIENT_NAMES]).toBe(a.name);
    expect([...INSTALLER_ORDER].sort()).toEqual([...CLIENT_IDS].sort());
  });

  it("reads what is installed and connected with `surehand-ae clients --json`, before installing", () => {
    expect(fn(nsi, "DetectApps")).toMatch(/cl-run\.cjs" --ini "\$PLUGINSDIR\\clients\.ini" -- "\$PLUGINSDIR\\rt\\surehand-ae\.mjs" clients --json/);
    const find = fn(nsi, "FindClient");
    expect(find).toMatch(/ReadINIStr \$1 "\$PLUGINSDIR\\clients\.ini" "clients\.\$4" "installed"/);
    expect(find).toMatch(/ReadINIStr \$2 "\$PLUGINSDIR\\clients\.ini" "clients\.\$4" "configured"/);
  });

  it("ticks what was found (the current connections when updating); a not-found app's box alone is disabled", () => {
    const row = macro(nsi, "_APP_ROW");
    expect(row).toMatch(/StrCpy \$R2 "Not found on this PC\. Install it, then run Setup again\."\s*\n\s*StrCpy \$R3 0/);
    expect(row).toMatch(/\$\{If\} \$cl\.Installed == 1\s*\n\s*StrCpy \$App\$\{N\}\.Chosen \$2\s*\n\s*\$\{Else\}\s*\n\s*StrCpy \$App\$\{N\}\.Chosen \$1/);
    const check = fn(nsh, "cl.CheckRow");
    // disabled: the box only; the name stays an enabled (muted) label
    expect(check).toMatch(/\$\{Else\}\s*\n\s*SetCtlColors \$0 "\$\{CL_MUTED\}" "\$\{CL_PAPER\}"\s*\n\s*EnableWindow \$R5 0/);
    expect(check).not.toMatch(/EnableWindow \$0 0/);
    // the cloudflared choice is never ticked by default
    expect(fn(nsi, ".onInit")).toMatch(/StrCpy \$Tunnel 0/);
    expect(nsi).toContain("Downloads Cloudflare's cloudflared (about 55 MB) for the secure link ChatGPT uses.");
  });

  it("every check box and radio button has its real text as its name (what screen readers say)", () => {
    const controls = [...`${nsh}\n${nsi}`.matchAll(/\$\{NSD_Create(Checkbox|RadioButton)\}[^\n]*/g)].map((m) => m[0]);
    expect(controls.length).toBeGreaterThanOrEqual(3);
    for (const c of controls) expect(c).not.toMatch(/""\s*$/);
  });

  it("the install connects each ticked app as its own step, disconnects one unticked when updating, then cloudflared", () => {
    const run = macro(nsi, "_APP_STEP_RUN");
    expect(run).toMatch(/StrCpy \$1 "install --connect-only --clients \$\{ID\}"/);
    expect(run).toMatch(/StrCpy \$1 "install --connect-only --disconnect \$\{ID\}"/);
    expect(run).toMatch(/!if "\$\{ID\}" == "claude-desktop"\s*\n\s*Call CheckClaudeDesktop/);
    expect(nsi).toMatch(/StrCpy \$1 "install --connect-only --tunnel"/);
    // the steps listed on the progress page are the ones run, in the same order
    const names = macro(nsi, "_APP_STEP_NAME");
    expect(names).toMatch(/Push "Connecting \$\{NAME\}"/);
    expect(names).toMatch(/Push "Disconnecting \$\{NAME\}"/);
    expect(fn(nsi, "ListSteps").match(/Push "[^"]+"/g)).toEqual(['Push "Installing ${PRODUCT}"', 'Push "Setting up After Effects"', 'Push "Downloading cloudflared"']);
  });
});

describe("Windows installer: progress and finish pages", () => {
  it("the progress page shows plain steps; the raw log stays behind Show details", () => {
    expect(nsh).toMatch(/^ShowInstDetails hide/m);
    const show = nsh.slice(nsh.indexOf("Function cl.InstFilesShow"), nsh.indexOf("FunctionEnd", nsh.indexOf("Function cl.InstFilesShow")));
    expect(show).toMatch(/GetDlgItem \$0 \$cl\.InnerDlg 1006\s*\n\s*ShowWindow \$0 \$\{SW_HIDE\}/); // MUI's status line
    expect(show).toMatch(/Call \$\{CL_INSTFILES_STEPS\}/);
    expect(show).toMatch(/GetDlgItem \$0 \$cl\.InnerDlg 1016[\s\S]*Call cl\.BringToTop/); // the log covers the steps when shown
    expect(fn(nsh, "cl.StepEnd")).toMatch(/STR:DONE[\s\S]*STR:FAILED/);
    expect(fn(nsh, "cl.StepStart")).toMatch(/STR:NOW/);
  });

  it("the finish page shows the server's results (install-result.json as an INI) and its next steps", () => {
    expect(nsi).toMatch(/!define CL_RESULTS_INI "\$PLUGINSDIR\\results\.ini"/);
    expect(nsi).toMatch(/cl-run\.cjs" --ini "\$\{CL_RESULTS_INI\}" --json-file "\$\{RESULT_JSON\}"/);
    expect(nsi).toMatch(/!define RESULT_JSON "\$PROFILE\\\.surehand\\ae\\install-result\.json"/);
    const results = fn(nsh, "cl.FinishResults");
    expect(results).toMatch(/ReadINIStr \$R8 "\$\{CL_RESULTS_INI\}" "summary" "count"/);
    expect(results).toMatch(/glyph-\$1-sunk-\$R7\.bmp/);
    expect(results).toMatch(/SetCtlColors \$0 "" "\$\{CL_INK\}"/); // the 2 px ink rule
    expect(results).toMatch(/SetCtlColors \$R6 "" "\$\{CL_SUNK\}"/); // the box
    expect(results).toMatch(/ReadINIStr \$R8 "\$\{CL_RESULTS_INI\}" "next" "count"/);
    // "restart After Effects" only comes from the results (the server says it only when After Effects is open)
    expect(nsi.slice(nsi.indexOf('Section "Install"'), nsi.indexOf('Section "Uninstall"'))).not.toMatch(/Restart After Effects/);
  });

  it("cl-run.cjs turns the results into an INI file NSIS can read (UTF-16)", async () => {
    const { toIni } = await import(new URL("../../installer/common/windows/cl-run.cjs", import.meta.url).href);
    const ini: string = toIni({ ok: true, summary: [{ kind: "done", text: "Connected Cursor" }], next: ["Restart Cursor."], clients: [{ id: "cursor", installed: true }] });
    expect(ini).toContain("[summary]\r\ncount=1");
    expect(ini).toContain("[summary.0]\r\nkind=done\r\ntext=Connected Cursor");
    expect(ini).toContain("[next]\r\ncount=1\r\n0=Restart Cursor.");
    expect(ini).toContain("[clients.0]\r\nid=cursor\r\ninstalled=1");
    const dir = mkdtempSync(join(tmpdir(), "surehand-clrun-"));
    try {
      writeFileSync(join(dir, "r.json"), JSON.stringify({ next: ["Restart After Effects (it is open)."] }));
      const r = spawnSync(process.execPath, [join(ROOT, "installer/common/windows/cl-run.cjs"), "--ini", join(dir, "r.ini"), "--json-file", join(dir, "r.json")]);
      expect(r.status).toBe(0);
      const b = readFileSync(join(dir, "r.ini"));
      expect([b[0], b[1]]).toEqual([0xff, 0xfe]);
      expect(b.subarray(2).toString("utf16le")).toContain("0=Restart After Effects (it is open).");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Windows installer: update or uninstall", () => {
  it("detects the installation by the uninstall entry and uninstaller this installer writes", () => {
    expect(nsi).toMatch(/!define CL_UNINST_KEY "\$\{UNINST_KEY\}"/);
    expect(nsi).toMatch(/!define CL_UNINST_EXE "\$\{UNINST_EXE\}"/);
    for (const v of ["DisplayVersion", "InstallLocation"]) expect(nsi).toMatch(new RegExp(`WriteRegStr HKCU "\\$\\{UNINST_KEY\\}" "${v}"`));
    const detect = fn(nsh, "cl.DetectInstalled");
    expect(detect).toMatch(/ReadRegStr \$cl\.InstalledDir HKCU "\$\{CL_UNINST_KEY\}" "InstallLocation"/);
    for (const t of ["Reinstall ${CL_APP_VERSION}", "Update to ${CL_APP_VERSION}", "Install ${CL_APP_VERSION} (you have $cl.InstalledVersion)"]) expect(detect).toContain(t);
    expect(detect).toContain("Replaces $cl.InstalledVersion. ${CL_KEEP_NOTE}");
    expect(nsi).toContain('!define CL_KEEP_NOTE "Next, you can change which AI apps are connected. Your settings and checkpoints are kept."');
  });

  it("is titled Update or uninstall; the remove-my-data box works only with Uninstall, and the button then says Uninstall", () => {
    const create = fn(nsh, "cl.MaintenanceCreate");
    expect(create).toContain('!insertmacro MUI_HEADER_TEXT "Update or uninstall ${CL_APP_NAME}" "Version $cl.InstalledVersion is installed for your Windows account."');
    expect(create).toMatch(/\$\{NSD_CreateCheckbox\} [^\n]*"\$\{CL_UNINSTALL_ALL\}"/);
    expect(nsi).toContain('!define CL_UNINSTALL_ALL "Also remove my settings and checkpoints"');
    expect(nsi).toContain('!define CL_UNINSTALL_NOTE "Removes the server, the Adobe® After Effects® extension and the AI app connections."');
    expect(fn(nsh, "cl.ChooseInstall")).toMatch(/EnableWindow \$cl\.RemoveAllBox 0[\s\S]*StrCpy \$0 "&Next"/);
    expect(fn(nsh, "cl.ChooseUninstall")).toMatch(/EnableWindow \$cl\.RemoveAllBox 1[\s\S]*StrCpy \$0 "U&ninstall"/);
  });

  it("uninstalls with the installed uninstaller (with /ALL when the box is ticked), and the uninstaller then runs --all", () => {
    const leave = fn(nsh, "cl.MaintenanceLeave");
    expect(leave).toMatch(/CopyFiles \/SILENT "\$cl\.InstalledDir\\\$\{CL_UNINST_EXE\}" "\$PLUGINSDIR\\uninstall\.exe"/);
    expect(leave).toMatch(/StrCpy \$cl\.RemoveAll 1\s*\n\s*StrCpy \$1 " \/ALL"/);
    expect(leave).toMatch(/ExecWait '"\$PLUGINSDIR\\uninstall\.exe"\$1 _\?=\$cl\.InstalledDir' \$0/);
    expect(leave).toMatch(/\$\{If\} \$0 == 0[\s\S]*Call \$\{CL_AFTER_UNINSTALL\}[\s\S]*Quit/);
    expect(leave).toMatch(/Abort ; cancelled or failed/);
    expect(fn(nsi, "un.onInit")).toMatch(/\$\{GetOptions\} \$0 "\/ALL" \$1[\s\S]*StrCpy \$UnAll 1/);
    const un = nsi.slice(nsi.indexOf('Section "Uninstall"'));
    expect(un).toMatch(/StrCpy \$1 "--keep-config"\s*\n\s*\$\{If\} \$UnAll == 1\s*\n\s*StrCpy \$1 "--all"/);
    expect(un).toMatch(/uninstall \$1'/);
    // an older uninstaller ignores /ALL: this version's server removes what it kept
    expect(fn(nsi, "AfterUninstall")).toMatch(/\$cl\.RemoveAll == 1[\s\S]*surehand-ae\.mjs" uninstall --all/);
    // the frame removes nothing itself
    expect(nsh).not.toMatch(/\bRMDir\b|\bDelete(RegKey)? "\$(INSTDIR|PROFILE)|uninstall --keep-config/);
    expect(nsi).toMatch(/Section "Uninstall"[\s\S]*another Surehand app uses it/);
  });
});

describe("Windows installer: the Conform Labs look", () => {
  it("uses the design system's dark colours and this app's accent", () => {
    expect(`#${/!define CL_ACCENT "([0-9A-F]{6})"/.exec(nsi)?.[1]}`).toBe(app.accent.dark.toUpperCase());
    const def = (n: string) => `#${new RegExp(`!define ${n} "([0-9A-F]{6})"`).exec(nsh)?.[1]}`;
    expect(def("CL_PAPER")).toBe(frame.COLORS.paper);
    expect(def("CL_SUNK")).toBe(frame.COLORS.paperSunk);
    expect(def("CL_RULE")).toBe(frame.COLORS.rule);
    expect(def("CL_INK")).toBe(frame.COLORS.ink);
    expect(def("CL_MUTED")).toBe(frame.COLORS.inkMuted);
    expect(def("CL_REFUSED")).toBe(frame.COLORS.refused);
    expect(frame.COLORS).toMatchObject({ paper: "#14161A", paperSunk: "#0D0E11", rule: "#2C3036", ink: "#F2EFE8", inkMuted: "#A6A49D" });
    expect(nsh).toMatch(/!define MUI_BGCOLOR "\$\{CL_PAPER\}"/);
    // the title bar in paper-sunk (Windows 11), dark before that
    const gui = fn(nsh, "${UN}cl.GUIInit");
    expect(gui).toMatch(/DwmSetWindowAttribute\(p \$HWNDPARENT, i 20, \*i 1, i 4\)/);
    expect(gui).toMatch(/DwmSetWindowAttribute\(p \$HWNDPARENT, i 35, \*i \$\{CL_SUNK_COLORREF\}, i 4\)/);
    expect(nsh).toMatch(/!define CL_SUNK_COLORREF 0x110E0D/);
    // the accent only on the main button
    expect(gui).toMatch(/SetCtlColors \$cl\.MainBtn "\$\{CL_ON_ACCENT\}" "\$\{CL_ACCENT\}"/);
  });

  it("keeps Segoe UI 9 as the dialog font and loads the Conform Labs fonts privately for its own labels", () => {
    expect(nsh).toMatch(/^SetFont "Segoe UI" 9/m);
    const load = fn(nsh, "${UN}cl.LoadFonts");
    for (const k of ["display", "textStrong", "mono", "monoMedium"]) {
      const f = frame.FONTS[k];
      expect(load).toContain(`File "\${CL_FONT_DIR}\\${f.ttf}"`);
      expect(load).toContain(`AddFontResourceExW(w '$PLUGINSDIR\\cl\\${f.ttf}', i \${CL_FR_PRIVATE}, p 0)`);
      expect(fn(nsh, "${UN}cl.UnloadFonts")).toContain(`RemoveFontResourceExW(w '$PLUGINSDIR\\cl\\${f.ttf}', i \${CL_FR_PRIVATE}, p 0)`);
      expect(existsSync(join(ROOT, "installer/common/fonts", f.ttf))).toBe(true);
    }
    expect(nsh).toMatch(/!define CL_FR_PRIVATE 0x10/);
    // the names Windows knows them by (TrueType name ID 1)
    expect(nsh).toContain(`!define CL_GDI_DISPLAY "${frame.FONTS.display.gdi}"`);
    expect(nsh).toContain(`!define CL_GDI_STRONG "${frame.FONTS.textStrong.gdi}"`);
    expect(nsh).toContain(`!define CL_GDI_MONO "${frame.FONTS.mono.gdi}"`);
    expect(nsh).toContain(`!define CL_GDI_MONO_MEDIUM "${frame.FONTS.monoMedium.gdi}"`);
    // a font Windows does not load falls back
    expect(load).toMatch(/\$\{IfThen\} \$0 = 0 \$\{\|\} StrCpy \$cl\.FaceDisplay "Segoe UI"/);
    // the fonts' licences ship with them
    for (const f of ["OFL-SpaceGrotesk.txt", "OFL-IBMPlexSans.txt", "OFL-IBMPlexMono.txt"]) expect(read(`installer/common/fonts/${f}`)).toMatch(/SIL Open Font License, Version 1\.1/);
  });

  it("the TrueType files are the names and weights the frame asks Windows for", () => {
    for (const k of ["display", "textStrong", "mono", "monoMedium"]) {
      const f = frame.FONTS[k], b = readFileSync(join(ROOT, "installer/common/fonts", f.ttf));
      const tables: Record<string, number> = {};
      for (let i = 0; i < b.readUInt16BE(4); i++) tables[b.toString("latin1", 12 + i * 16, 16 + i * 16)] = b.readUInt32BE(12 + i * 16 + 8);
      const nt = tables.name, strings = nt + b.readUInt16BE(nt + 4);
      let family = "";
      for (let i = 0; i < b.readUInt16BE(nt + 2); i++) {
        const r = nt + 6 + i * 12;
        if (b.readUInt16BE(r) === 3 && b.readUInt16BE(r + 6) === 1) family = b.subarray(strings + b.readUInt16BE(r + 10), strings + b.readUInt16BE(r + 10) + b.readUInt16BE(r + 8)).swap16().toString("utf16le");
      }
      expect([family, b.readUInt16BE(tables["OS/2"] + 4)]).toEqual([f.gdi, f.weight]);
    }
  });

  it("has every bitmap size the frame picks from (sidebar, header band, status glyphs), as 24-bit BMPs", () => {
    const pick = fn(nsh, "${UN}cl.PickArt");
    const sizes: [string, number[][]][] = [["wizard", frame.WIZARD_SIZES], ["header", frame.HEADER_SIZES]];
    for (const [kind, list] of sizes) {
      const widths = list.map(([w]) => w);
      const block = pick.slice(pick.indexOf(`StrCpy $1 ${widths[0]}`));
      for (let i = 1; i < widths.length; i++) expect(block).toContain(`$0 > ${Math.floor((widths[i - 1] + widths[i]) / 2)} \${|} StrCpy $1 ${widths[i]}`);
      for (const [w, h] of list) {
        const b = readFileSync(join(ROOT, "installer/windows/nsis/art", `${kind}-${w}.bmp`));
        expect([b.toString("latin1", 0, 2), b.readInt32LE(18), b.readInt32LE(22), b.readUInt16LE(28)]).toEqual(["BM", w, h, 24]);
        expect(b.subarray(54).reduce((m, x) => Math.max(m, x), 0), `${kind}-${w}.bmp is empty`).toBeGreaterThan(150);
      }
    }
    const g: number[] = frame.GLYPH_SIZES;
    const block = pick.slice(pick.indexOf(`StrCpy $1 ${g[0]}`));
    for (let i = 1; i < g.length; i++) expect(block).toContain(`$0 > ${Math.floor((g[i - 1] + g[i]) / 2)} \${|} StrCpy $1 ${g[i]}`);
    for (const kind of frame.GLYPH_KINDS)
      for (const bg of Object.keys(frame.GLYPH_BACKGROUNDS))
        for (const px of g) {
          const b = readFileSync(join(ROOT, "installer/windows/nsis/art", `glyph-${kind}-${bg}-${px}.bmp`));
          expect([b.readInt32LE(18), b.readInt32LE(22), b.readUInt16LE(28)]).toEqual([px, px, 24]);
        }
    // a done glyph is the accent, pre-composited on paper-sunk at its edge
    const done = readFileSync(join(ROOT, "installer/windows/nsis/art", "glyph-done-sunk-18.bmp"));
    const centre = 54 + 9 * Math.ceil((18 * 3) / 4) * 4 + 9 * 3;
    expect([done[centre + 2], done[centre + 1], done[centre]]).toEqual([0x3d, 0xd6, 0x8c]);
  });

  it("the sidebar pages carry the version; header-band pages a hairline under the band; Finish alone on the finish page", () => {
    expect(macro(nsh, "_CL_SIDEBAR")).toMatch(/NSD_CreateLabel\} 12u 178u 90u 9u "\$\{CL_APP_VERSION\}"[\s\S]*\$cl\.FontMono/);
    expect(fn(nsh, "${UN}cl.GUIInit")).toMatch(/StrCpy \$0 1036[^\n]*\n\s*Call \$\{UN\}cl\.OuterRule\s*\n\s*StrCpy \$cl\.HeadRule \$cl\.cOut/);
    expect(nsh).toMatch(/Function cl\.FinishShow[\s\S]*StrCpy \$0 "both" ; Finish only/);
    expect(nsh).toMatch(/^BrandingText " "/m); // the endorsement is on the sidebar
  });

  // makensis (brew install makensis) compiles the real script with a stand-in payload; any warning fails (-WX)
  const makensis = spawnSync("makensis", ["-VERSION"], { encoding: "utf8" }).status === 0;
  it.skipIf(!makensis)("compiles with makensis without warnings", async () => {
    const { nsisApps } = await import(aiAppsUrl);
    const dir = mkdtempSync(join(tmpdir(), "surehand-nsis-"));
    try {
      for (const f of ["node.exe", "surehand-ae.mjs"]) writeFileSync(join(dir, f), "stand-in");
      writeFileSync(join(dir, "ai-apps.nsh"), nsisApps());
      const defines = {
        VERSION: "1.4.0-beta.1", VERSION4: "1.4.0.0", NODE_VERSION: "24.22.0", NODE_EXE: join(dir, "node.exe"), SERVER_MJS: join(dir, "surehand-ae.mjs"),
        CL_RUN: join(ROOT, "installer/common/windows/cl-run.cjs"), AI_APPS_NSH: join(dir, "ai-apps.nsh"), ICON: join(ROOT, "brand/Surehand.ico"),
        OUTFILE: join(dir, "Surehand-MCP-Setup-1.4.0-beta.1.exe"), ESTIMATED_KB: "100",
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
  }, 120_000);
});

describe("Mac installer: choices on Installation Type", () => {
  const template = read("installer/mac/pkg/distribution.xml");
  const gen = async () => {
    const { macDistribution } = await import(aiAppsUrl);
    return macDistribution(template, { version: "9.8.7", componentPkg: "surehand-mcp-9.8.7-component.pkg" }) as string;
  };

  it("shows the choices directly: Surehand MCP (required), one per AI app, cloudflared unticked, the summary hidden and last", async () => {
    const xml = await gen();
    expect(xml).not.toMatch(/@[A-Z_]+@/);
    expect(xml).toMatch(/<options customize="always"/);
    expect(xml).toMatch(/<domains enable_anywhere="false" enable_currentUserHome="true" enable_localSystem="false"\/>/);
    const outline = [...xml.matchAll(/<line choice="([^"]+)"\/>/g)].map((m) => m[1]);
    expect(outline).toEqual(["main", ...aiApps.apps.flatMap((a: any) => [`app-${a.id}`, `app-${a.id}-missing`]), "tunnel", "summary"]);
    expect(xml).toMatch(/<choice id="main" title="Surehand MCP" [^>]*enabled="false" selected="true">\s*<pkg-ref id="com\.conformlabs\.surehand-mcp"\/>/);
    for (const a of aiApps.apps) {
      expect(xml).toContain(`<choice id="app-${a.id}" title="Connect ${a.name}" description="Surehand connects the apps you tick. You can change this later in the Surehand panel in Adobe® After Effects®." visible="found('${a.id}')" start_selected="found('${a.id}')">`);
      expect(xml).toMatch(new RegExp(`<choice id="app-${a.id}-missing" title="Connect ${a.name.replace("/", "\\/")} \\(not found on this Mac\\)"[^>]*visible="!found\\('${a.id}'\\)" enabled="false" selected="false"/>`));
      expect(xml).toContain(`<pkg-ref id="com.conformlabs.surehand-mcp.connect.${a.id}" version="9.8.7" onConclusion="none">surehand-mcp-connect-${a.id}.pkg</pkg-ref>`);
    }
    expect(xml).toMatch(/<choice id="tunnel" title="Set up ChatGPT on the web \(downloads cloudflared, 20 MB\)"[^>]*start_selected="false">/);
    expect(xml).toMatch(/<choice id="summary" title="Summary" visible="false" enabled="false" selected="true">/);
    expect(xml).toContain('<pkg-ref id="com.conformlabs.surehand-mcp" version="9.8.7" onConclusion="none">surehand-mcp-9.8.7-component.pkg</pkg-ref>');
  });

  it("greys out the apps that aren't on this Mac (the installer script's found())", async () => {
    const xml = await gen();
    const script = /<script><!\[CDATA\[([\s\S]*?)\]\]><\/script>/.exec(xml)![1];
    const there = new Set(["/Users/me/Library/Application Support/Claude", "/opt/homebrew/bin/codex"]);
    const system = { env: { HOME: "/Users/me" }, files: { fileExistsAtPath: (p: string) => there.has(p) }, version: { ProductVersion: "15.1" }, compareVersions: () => 1 };
    const found = new Function("system", "my", `${script}; return found;`)(system, { result: {} });
    expect(found("claude-desktop")).toBe(true);
    expect(found("codex")).toBe(true);
    expect(found("cursor")).toBe(false);
    expect(found("claude-code")).toBe(false);
  });

  it("each choice is a payload-free step that runs after the main package: connect the app, get cloudflared, the summary", async () => {
    const { macComponents } = await import(aiAppsUrl);
    const steps = macComponents();
    expect(steps.map((c: any) => c.args.join(" "))).toEqual([...aiApps.apps.map((a: any) => `install --connect-only --clients ${a.id}`), "install --connect-only --tunnel", "install --summary"]);
    const pkg = read("server/scripts/package-mac-pkg.mjs");
    expect(pkg).toMatch(/run\("pkgbuild", \["--nopayload", "--scripts", dir/);
    expect(pkg).toMatch(/stepTemplate\.replace\("@STEP_ARGS@"/);
    expect(pkg).toMatch(/macDistribution\(readFileSync\(join\(PKG_SRC, "distribution\.xml"\), "utf8"\), \{ version, componentPkg: componentName \}\)/);
    // the main package installs and connects nothing; the steps connect what was ticked
    expect(read("installer/mac/pkg/scripts/postinstall")).toMatch(/run_server 180 install --clients none/);
    const step = read("installer/mac/pkg/scripts/step");
    expect(step).toMatch(/STEP_ARGS=\(@STEP_ARGS@\)/);
    // the summary goes at the top of install.log
    expect(step).toMatch(/install --summary[\s\S]*\{ cat "\$SUMMARY"; [\s\S]*cat "\$LOG"[\s\S]*\} >"\$LOG\.tmp" && mv -f "\$LOG\.tmp" "\$LOG"/);
  });

  it("the step script writes the summary at the top of the log (run with a stand-in server)", () => {
    if (process.platform === "win32") return;
    const h = mkdtempSync(join(tmpdir(), "surehand-step-"));
    try {
      const S = join(h, ".surehand");
      for (const d of ["node/bin", "ae/server"]) spawnSync("mkdir", ["-p", join(S, d)]);
      writeFileSync(join(S, "node/bin/node"), '#!/bin/sh\n[ "$2 $3" = "install --summary" ] && echo "Surehand MCP 9 is installed" && exit 0\necho "ran $*"\n');
      spawnSync("chmod", ["+x", join(S, "node/bin/node")]);
      writeFileSync(join(S, "ae/server/surehand-ae.mjs"), "");
      writeFileSync(join(S, "ae/install.log"), "older details\n");
      const scripts = join(h, "scripts");
      spawnSync("mkdir", ["-p", scripts]);
      writeFileSync(join(scripts, "common.sh"), read("installer/mac/pkg/scripts/common.sh"));
      const make = (args: string) => {
        writeFileSync(join(scripts, "postinstall"), read("installer/mac/pkg/scripts/step").replace("@STEP_ARGS@", args));
        return spawnSync("bash", [join(scripts, "postinstall"), "x.pkg", S, "/"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: h } });
      };
      expect(make('"install" "--connect-only" "--clients" "cursor"').status).toBe(0);
      expect(readFileSync(join(S, "ae/install.log"), "utf8")).toMatch(/older details\n--- [\d:]+ install --connect-only --clients cursor\nran .*install --connect-only --clients cursor/);
      expect(make('"install" "--summary"').status).toBe(0);
      expect(readFileSync(join(S, "ae/install.log"), "utf8")).toMatch(/^Surehand MCP 9 is installed\n\nThe details of this install and the ones before it follow\.\n\nolder details/);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe("Mac installer: pages", () => {
  it("fills the welcome and conclusion pages with the design's copy, the Conform Labs fonts inlined, light and dark", async () => {
    for (const page of ["welcome", "conclusion"]) {
      const html: string = frame.macPage(page, { version: "9.8.7" });
      expect(html).not.toMatch(/@[A-Z_]+@/);
      expect(html).toContain("9.8.7");
      expect(html).toContain("for Adobe® After Effects®");
      expect(html).toMatch(/prefers-color-scheme: dark/);
      for (const family of ["Space Grotesk", "IBM Plex Sans", "IBM Plex Mono"]) expect(html).toMatch(new RegExp(`@font-face\\{font-family:"${family}";[^}]*src:url\\("data:font/woff2;base64,`));
    }
    const welcome: string = frame.macPage("welcome", { version: "9.8.7" });
    for (const s of ["Install Surehand MCP", "Surehand lets the AI apps you use, like Claude, ChatGPT and Cursor, work in After Effects on this Mac. Every edit is listed. You can undo it in After Effects.", "It installs for your Mac account only. No administrator password needed.", "Next, you choose which AI apps to connect."])
      expect(welcome).toContain(s);
    const conclusion: string = frame.macPage("conclusion", { version: "9.8.7" });
    expect(conclusion).toContain("listed at the top of <code>~/.surehand/ae/install.log</code>");
    expect(conclusion).toContain("Then open your AI app and ask it something about your After Effects project, like “What’s in my project?” The Surehand panel in After Effects (Window › Extensions › Surehand MCP) shows when it's connected.");
    const dist = read("installer/mac/pkg/distribution.xml");
    for (const f of ["welcome.html", "conclusion.html", "background-light.tiff", "background-dark.tiff"]) expect(dist).toContain(`file="${f}"`);
    expect(read("server/scripts/package-mac-pkg.mjs")).toMatch(/macPage\(page, \{ version \}\)/);
  });

  it("the background art is sized for the Installer's sidebar (152 x 120 points, @2x)", () => {
    for (const mode of ["light", "dark"]) {
      const tiff = join(ROOT, "installer/mac/pkg/resources", `background-${mode}.tiff`);
      expect(existsSync(tiff)).toBe(true);
      if (process.platform !== "darwin") continue;
      const info = spawnSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", tiff], { encoding: "utf8" }).stdout;
      expect(info).toMatch(/pixelWidth: (152|304)/);
      expect(info).toMatch(/pixelHeight: (120|240)/);
    }
  });

  it("shows the app's tile (square in the installers), the same S as the After Effects panel", () => {
    expect(frame.appArt(app, "dark")).toEqual({ file: "brand/surehand-tile.svg", tiled: true });
    expect(frame.wordmark(app)).toEqual(["Surehand", "MCP"]);
    const tile = read("brand/surehand-tile.svg");
    const panel = /<svg id="tile"[\s\S]*?<\/svg>/.exec(read("extension/index.html"))?.[0] ?? "";
    for (const part of tile.match(/<(path|circle)[^>]*>/g) ?? []) expect(panel.replace(/><\/(path|circle)>/g, "/>")).toContain(part);
    expect(read("installer/common/generate-art.mjs")).toMatch(/if \(square\) svg = svg\.replace\(\/\(<rect\\b\[\^>\]\*\?\)\\s\+rx="\[\^"\]\*"\/, "\$1"\)/);
  });
});
