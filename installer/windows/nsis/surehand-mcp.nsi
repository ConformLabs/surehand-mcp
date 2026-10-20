; Surehand MCP: per-user Windows installer (Setup .exe), built with NSIS on macOS or Windows.
; Do not run makensis on this file directly: `npm run package:win-installer` (server/scripts/
; package-win-installer.mjs) downloads and verifies Node.js, builds the server and passes these defines:
;   VERSION        package version, e.g. 1.4.0           VERSION4    the same as a.b.c.d
;   NODE_EXE       verified official node.exe (win-x64)   NODE_VERSION e.g. 24.22.0
;   SERVER_MJS     the single-file server (server/dist/surehand-ae.mjs)
;   LOG_FILTER     log-filter.cjs (next to this file)     ICON        the .ico
;   OUTFILE        the Setup .exe to write                ESTIMATED_KB installed size for Add/Remove Programs
;   SIGN_CMD       optional: a command that Authenticode-signs the file given as its last argument in place
;
; What it installs (the same places as installer/run.ps1 and `surehand-ae install`):
;   %USERPROFILE%\.surehand\node\node.exe                a private Node.js, shared by the Surehand apps (replaces an older private copy)
;   %USERPROFILE%\.surehand\ae\server\surehand-ae.mjs    the server; then `node surehand-ae.mjs install` moves a 1.3
;                                                      installation (%USERPROFILE%\.aemcp), installs the After Effects
;                                                      extension, writes the config and connects AI apps
;   %LOCALAPPDATA%\Programs\Surehand MCP\        the uninstaller and the icon (Add/Remove Programs entry)

Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor /SOLID lzma

!include LogicLib.nsh
!include x64.nsh
!include WinVer.nsh

!define PRODUCT "Surehand MCP"
!define PUBLISHER "Ron Yitzhaki"
!define HOMEPAGE "https://github.com/ConformLabs/surehand-mcp"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\SurehandMCP"
!define UNINST_EXE "Uninstall Surehand MCP.exe"
!define SUREHAND "$PROFILE\.surehand"
!define APPDIR "$PROFILE\.surehand\ae"
!define LEGACY "$PROFILE\.aemcp"
!define NODE_DIR "$PROFILE\.surehand\node"
!define SERVER_DIR "$PROFILE\.surehand\ae\server"
!define SERVER "$PROFILE\.surehand\ae\server\surehand-ae.mjs"
!define CEP_EXT "$APPDATA\Adobe\CEP\extensions\com.aemcp"

!ifdef SIGN_CMD
  ; runs after the installer / the uninstaller are written; %1 is the file
  !finalize '${SIGN_CMD} "%1"' = 0
  !uninstfinalize '${SIGN_CMD} "%1"' = 0
!endif

Name "${PRODUCT}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT}"

VIProductVersion "${VERSION4}"
VIFileVersion "${VERSION4}"
VIAddVersionKey /LANG=1033 "ProductName" "${PRODUCT}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "FileDescription" "${PRODUCT} Setup"
VIAddVersionKey /LANG=1033 "CompanyName" "${PUBLISHER}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Copyright (c) ${PUBLISHER}. MIT License."
VIAddVersionKey /LANG=1033 "Comments" "${HOMEPAGE}"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"

; --- the Conform Labs installer frame (installer/common): look, maintenance page; this app's part below ---
!define CL_APP_NAME "${PRODUCT}"
!define CL_APP_VERSION "${VERSION}"
!define CL_ACCENT "3DD68C" ; installer/app.json accent.dark
!define CL_ART "${__FILEDIR__}\art" ; node installer/common/generate-art.mjs
!define CL_UNINST_KEY "${UNINST_KEY}"
!define CL_UNINST_EXE "${UNINST_EXE}"
!define CL_KEEP_NOTE "Your settings, project checkpoints and AI app connections are kept."
!define CL_UNINSTALL_NOTE "Removes the server, the After Effects extension and its AI app connections. Your settings and project checkpoints are kept."
!include "${__FILEDIR__}\..\..\common\conformlabs.nsh"

!define MUI_WELCOMEPAGE_TITLE "Install ${PRODUCT} ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "${PRODUCT} lets Claude and other AI apps work in Adobe After Effects on this computer.$\r$\n$\r$\nSetup installs it for your Windows account only (no administrator rights needed): a private copy of Node.js, the ${PRODUCT} server, and the After Effects extension. It then connects the AI apps it finds (Claude Desktop, Claude Code, Cursor, ChatGPT desktop / Codex).$\r$\n$\r$\nIf After Effects is open, restart it after installing.$\r$\n$\r$\nClick Install to continue."
!define MUI_FINISHPAGE_TITLE "${PRODUCT} is installed"
!define MUI_FINISHPAGE_TEXT "Restart After Effects if it is open, and restart your AI apps.$\r$\n$\r$\nThen open your AI app and ask it something about your After Effects project, like “What’s in my project?” The Surehand panel in After Effects (Window › Extensions › Surehand MCP) shows when it's connected."
!define CL_FINISHPAGE_LINK_CAPTION "Documentation and help:"
!define MUI_FINISHPAGE_LINK "github.com/ConformLabs/surehand-mcp"
!define MUI_FINISHPAGE_LINK_LOCATION "${HOMEPAGE}"
!define MUI_FINISHPAGE_NOREBOOTSUPPORT
!define MUI_UNCONFIRMPAGE_TEXT_TOP "${PRODUCT} will be removed: the server, the After Effects extension, its AI app connections and its private Node.js. Your settings (.surehand\ae\config.json) and project checkpoints (.surehand\ae\checkpoints) and your other files there are kept."

!insertmacro CL_PAGE_MAINTENANCE ; Setup run again on a computer that has it: update / reinstall, or uninstall
!insertmacro CL_PAGE_WELCOME
!insertmacro CL_PAGE_INSTFILES
!insertmacro CL_PAGE_FINISH

!insertmacro CL_UNPAGE_CONFIRM
!insertmacro CL_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Var AERunning

; $0 = process image name -> $0 = 1 if running, else 0
!macro IsRunning EXE
  nsExec::ExecToStack '"$SYSDIR\cmd.exe" /c "$SYSDIR\tasklist.exe" /FI "IMAGENAME eq ${EXE}" /NH | "$SYSDIR\find.exe" /I "${EXE}"'
  Pop $0
  Pop $1
  ${If} $0 == 0
    StrCpy $0 1
  ${Else}
    StrCpy $0 0
  ${EndIf}
!macroend

Function .onInit
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP "${PRODUCT} needs Windows 10 or later." /SD IDOK
    SetErrorLevel 3
    Abort
  ${EndIf}
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "${PRODUCT} needs 64-bit Windows." /SD IDOK
    SetErrorLevel 3
    Abort
  ${EndIf}
  !insertmacro CL_ONINIT ; is it installed already? (the maintenance page; a silent Setup ignores it)
FunctionEnd

Section "Install"
  SetShellVarContext current
  SetDetailsPrint both

  !insertmacro IsRunning "AfterFX.exe"
  StrCpy $AERunning $0
  ${If} $AERunning == 1
    DetailPrint "After Effects is open: restart it after installing to load ${PRODUCT}."
  ${EndIf}

  ; A Claude Desktop that is open rewrites its settings from memory and can drop a new connection.
  ; `surehand-ae install` would offer to restart it, but only in an interactive console (it skips that here).
  !insertmacro IsRunning "claude.exe"
  ${If} $0 == 1
    MessageBox MB_OKCANCEL|MB_ICONINFORMATION "Claude Desktop is open.$\r$\n$\r$\nIf ${PRODUCT} is not connected to Claude Desktop yet, quit Claude Desktop now (tray icon > Quit), then click OK. Otherwise just click OK." /SD IDOK IDOK claude_ok
    SetErrorLevel 4
    Abort "Cancelled."
    claude_ok:
  ${EndIf}

  ; --- private Node.js ---
  DetailPrint "Installing Node.js ${NODE_VERSION} to ${NODE_DIR}"
  CreateDirectory "${NODE_DIR}"
  Delete "${NODE_DIR}\node.exe.old-*"
  ${If} ${FileExists} "${NODE_DIR}\node.exe"
    Delete "${NODE_DIR}\node.exe"
    ${If} ${FileExists} "${NODE_DIR}\node.exe"
      ; in use by an AI app that is running the server: a running .exe can be renamed, not replaced
      System::Call "kernel32::GetTickCount()i.r2"
      ClearErrors
      Rename "${NODE_DIR}\node.exe" "${NODE_DIR}\node.exe.old-$2"
      ${If} ${Errors}
        MessageBox MB_ICONSTOP "Could not replace ${NODE_DIR}\node.exe (it is in use). Quit your AI apps and run Setup again." /SD IDOK
        SetErrorLevel 2
        Abort "Node.js is in use."
      ${EndIf}
    ${EndIf}
  ${EndIf}
  SetOutPath "${NODE_DIR}"
  File "/oname=node.exe" "${NODE_EXE}"

  ; --- the server, then its own installer (extension, config, AI apps) ---
  DetailPrint "Installing the server to ${SERVER_DIR}"
  SetOutPath "${SERVER_DIR}"
  File "/oname=surehand-ae.mjs" "${SERVER_MJS}"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "/oname=log-filter.cjs" "${LOG_FILTER}"
  DetailPrint "Running: node surehand-ae.mjs install"
  ; log-filter.cjs runs it without a console (no prompts) and makes its output readable here
  nsExec::ExecToLog '"${NODE_DIR}\node.exe" "$PLUGINSDIR\log-filter.cjs" "${SERVER}" install'
  Pop $0
  SetOutPath "$TEMP"
  ${If} $0 != 0
    DetailPrint "surehand-ae install failed (exit code $0)."
    MessageBox MB_ICONSTOP "${PRODUCT} could not finish installing (exit code $0). Click Show details for the reason." /SD IDOK
    SetErrorLevel 2
    Abort "Installation failed."
  ${EndIf}

  ; --- uninstaller + Add/Remove Programs (per user) ---
  SetOutPath "$INSTDIR"
  File "/oname=surehand-mcp.ico" "${ICON}"
  WriteUninstaller "$INSTDIR\${UNINST_EXE}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\surehand-mcp.ico"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\${UNINST_EXE}"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\${UNINST_EXE}" /S'
  WriteRegStr HKCU "${UNINST_KEY}" "URLInfoAbout" "${HOMEPAGE}"
  WriteRegStr HKCU "${UNINST_KEY}" "HelpLink" "${HOMEPAGE}"
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" ${ESTIMATED_KB}
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

  ${If} $AERunning == 1
    MessageBox MB_ICONINFORMATION "After Effects is open. Restart After Effects to load ${PRODUCT}." /SD IDOK
  ${EndIf}
SectionEnd

; Uninstall keeps the user's data: ~/.surehand/ae/config.json (settings, token) and ~/.surehand/ae/checkpoints
; (project safety copies). It removes the server, the After Effects extension, the AI app entries
; (all done by `surehand-ae uninstall --keep-config`, which also leaves any other files in .surehand\ae alone and
; removes what 1.3's .aemcp kept for the move), the private Node.js and the uninstaller.
Section "Uninstall"
  SetShellVarContext current
  SetDetailsPrint both

  !insertmacro IsRunning "AfterFX.exe"
  StrCpy $AERunning $0

  ${If} ${FileExists} "${NODE_DIR}\node.exe"
  ${AndIf} ${FileExists} "${SERVER}"
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File "/oname=log-filter.cjs" "${LOG_FILTER}"
    ; keeps config.json, the checkpoints and any files in .surehand\ae that aren't ours
    nsExec::ExecToLog '"${NODE_DIR}\node.exe" "$PLUGINSDIR\log-filter.cjs" "${SERVER}" uninstall --keep-config'
    Pop $0
    SetOutPath "$TEMP"
    ${If} $0 != 0
      DetailPrint "surehand-ae uninstall reported a problem (exit code $0)."
    ${EndIf}
  ${Else}
    ; no Node or server left (e.g. removed by hand): remove the extension; AI app settings are left as they are
    DetailPrint "The ${PRODUCT} server was not found; removing the After Effects extension only."
    RMDir /r "${CEP_EXT}"
    Delete "${SERVER}"
    RMDir "${SERVER_DIR}"
  ${EndIf}

  ; the private Node.js is shared by the Surehand apps: removed only when no other one (.surehand\<app>)
  ; is installed (an AI app still running the server can keep node.exe in use)
  StrCpy $1 0
  FindFirst $2 $3 "${SUREHAND}\*.*"
  ${DoWhile} $3 != ""
    ${If} ${FileExists} "${SUREHAND}\$3\*.*"
    ${AndIf} $3 != "."
    ${AndIf} $3 != ".."
    ${AndIf} $3 != "ae"
    ${AndIf} $3 != "node"
    ${AndIf} $3 != "ffmpeg"
      StrCpy $4 $3 1
      ${If} $4 != "."
        StrCpy $1 1
      ${EndIf}
    ${EndIf}
    FindNext $2 $3
  ${Loop}
  FindClose $2
  ${If} $1 == 1
    DetailPrint "Kept ${NODE_DIR}: another Surehand app uses it."
  ${Else}
    RMDir /r "${NODE_DIR}"
    ${If} ${FileExists} "${NODE_DIR}\*.*"
      DetailPrint "Some of ${NODE_DIR} is in use; quit your AI apps and delete it by hand."
    ${EndIf}
  ${EndIf}
  RMDir "${APPDIR}" ; only if empty (config.json and checkpoints are kept)
  RMDir "${SUREHAND}"
  RMDir "${LEGACY}"

  DeleteRegKey HKCU "${UNINST_KEY}"
  Delete "$INSTDIR\surehand-mcp.ico"
  Delete "$INSTDIR\${UNINST_EXE}"
  RMDir "$INSTDIR"

  ${If} $AERunning == 1
    MessageBox MB_ICONINFORMATION "Restart After Effects to finish removing ${PRODUCT}." /SD IDOK
  ${EndIf}
SectionEnd
