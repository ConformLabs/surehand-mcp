; Surehand MCP: per-user Windows installer (Setup .exe), built with NSIS on macOS or Windows.
; Do not run makensis on this file directly: `npm run package:win-installer` (server/scripts/
; package-win-installer.mjs) downloads and verifies Node.js, builds the server and passes these defines:
;   VERSION        package version, e.g. 1.4.0           VERSION4    the same as a.b.c.d
;   NODE_EXE       verified official node.exe (win-x64)   NODE_VERSION e.g. 24.22.0
;   SERVER_MJS     the single-file server (server/dist/ae-mcp.mjs)
;   LOG_FILTER     log-filter.cjs (next to this file)     ICON        the .ico
;   OUTFILE        the Setup .exe to write                ESTIMATED_KB installed size for Add/Remove Programs
;   SIGN_CMD       optional: a command that Authenticode-signs the file given as its last argument in place
;
; What it installs (the same places as installer/run.ps1 and `ae-mcp install`):
;   %USERPROFILE%\.aemcp\node\node.exe          a private Node.js (replaces an older private copy)
;   %USERPROFILE%\.aemcp\server\ae-mcp.mjs       the server; then `node ae-mcp.mjs install` installs the
;                                                After Effects extension, writes the config and connects AI apps
;   %LOCALAPPDATA%\Programs\Surehand MCP\        the uninstaller and the icon (Add/Remove Programs entry)

Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor /SOLID lzma

!include MUI2.nsh
!include LogicLib.nsh
!include x64.nsh
!include WinVer.nsh

!define PRODUCT "Surehand MCP"
!define PUBLISHER "Ron Yitzhaki"
!define HOMEPAGE "https://github.com/ConformLabs/surehand-mcp"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\SurehandMCP"
!define UNINST_EXE "Uninstall Surehand MCP.exe"
!define AEMCP "$PROFILE\.aemcp"
!define NODE_DIR "$PROFILE\.aemcp\node"
!define SERVER_DIR "$PROFILE\.aemcp\server"
!define SERVER "$PROFILE\.aemcp\server\ae-mcp.mjs"
!define CEP_EXT "$APPDATA\Adobe\CEP\extensions\com.aemcp"

!ifdef SIGN_CMD
  ; runs after the installer / the uninstaller are written; %1 is the file
  !finalize '${SIGN_CMD} "%1"' = 0
  !uninstfinalize '${SIGN_CMD} "%1"' = 0
!endif

Name "${PRODUCT}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT}"
BrandingText "${PRODUCT} ${VERSION}"
ShowInstDetails show
ShowUninstDetails show

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
!define MUI_ABORTWARNING

!define MUI_WELCOMEPAGE_TITLE "Install ${PRODUCT} ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "${PRODUCT} lets Claude and other AI apps work in Adobe After Effects on this computer.$\r$\n$\r$\nSetup installs it for your Windows account only (no administrator rights needed): a private copy of Node.js, the ${PRODUCT} server, and the After Effects extension. It then connects the AI apps it finds (Claude Desktop, Claude Code, Cursor, ChatGPT desktop / Codex).$\r$\n$\r$\nIf After Effects is open, restart it after installing.$\r$\n$\r$\nClick Install to continue."
!define MUI_FINISHPAGE_TITLE "${PRODUCT} is installed"
!define MUI_FINISHPAGE_TEXT "Restart After Effects if it is open, and restart your AI apps.$\r$\n$\r$\nThen try asking Claude: $\"Check After Effects is connected, then make a 1080p comp with an animated title.$\""
!define MUI_FINISHPAGE_LINK "Documentation and help: github.com/ConformLabs/surehand-mcp"
!define MUI_FINISHPAGE_LINK_LOCATION "${HOMEPAGE}"
!define MUI_FINISHPAGE_NOREBOOTSUPPORT
!define MUI_UNCONFIRMPAGE_TEXT_TOP "${PRODUCT} will be removed: the server, the After Effects extension, its AI app connections and its private Node.js. Your settings (.aemcp\config.json) and project checkpoints (.aemcp\checkpoints) are kept."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

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
  ; `ae-mcp install` would offer to restart it, but only in an interactive console (it skips that here).
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
  File "/oname=ae-mcp.mjs" "${SERVER_MJS}"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "/oname=log-filter.cjs" "${LOG_FILTER}"
  DetailPrint "Running: node ae-mcp.mjs install"
  ; log-filter.cjs runs it without a console (no prompts) and makes its output readable here
  nsExec::ExecToLog '"${NODE_DIR}\node.exe" "$PLUGINSDIR\log-filter.cjs" "${SERVER}" install'
  Pop $0
  SetOutPath "$TEMP"
  ${If} $0 != 0
    DetailPrint "ae-mcp install failed (exit code $0)."
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

; Uninstall keeps the user's data: ~/.aemcp/config.json (settings, token) and ~/.aemcp/checkpoints
; (project safety copies). It removes the server, the After Effects extension, the AI app entries
; (all done by `ae-mcp uninstall --keep-config`), the private Node.js and the uninstaller.
Section "Uninstall"
  SetShellVarContext current
  SetDetailsPrint both

  !insertmacro IsRunning "AfterFX.exe"
  StrCpy $AERunning $0

  ${If} ${FileExists} "${NODE_DIR}\node.exe"
  ${AndIf} ${FileExists} "${SERVER}"
    ; `ae-mcp uninstall --keep-config` removes everything in .aemcp except config.json and node\,
    ; so move the checkpoints out of the way while it runs.
    StrCpy $3 0
    ${If} ${FileExists} "${AEMCP}\checkpoints\*.*"
      ${If} ${FileExists} "$PROFILE\.aemcp-checkpoints-keep\*.*"
        MessageBox MB_ICONSTOP "$PROFILE\.aemcp-checkpoints-keep already exists (left by an earlier uninstall). Move it back to ${AEMCP}\checkpoints or delete it, then uninstall again." /SD IDOK
        SetErrorLevel 2
        Abort "Nothing was removed."
      ${EndIf}
      ClearErrors
      Rename "${AEMCP}\checkpoints" "$PROFILE\.aemcp-checkpoints-keep"
      ${If} ${Errors}
        MessageBox MB_ICONSTOP "Could not set the checkpoints aside (${AEMCP}\checkpoints is in use). Quit your AI apps and uninstall again." /SD IDOK
        SetErrorLevel 2
        Abort "Nothing was removed."
      ${EndIf}
      StrCpy $3 1
    ${EndIf}
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File "/oname=log-filter.cjs" "${LOG_FILTER}"
    nsExec::ExecToLog '"${NODE_DIR}\node.exe" "$PLUGINSDIR\log-filter.cjs" "${SERVER}" uninstall --keep-config'
    Pop $0
    SetOutPath "$TEMP"
    ${If} $3 == 1
      ClearErrors
      Rename "$PROFILE\.aemcp-checkpoints-keep" "${AEMCP}\checkpoints"
      ${If} ${Errors}
        DetailPrint "Your project checkpoints are in $PROFILE\.aemcp-checkpoints-keep"
      ${Else}
        DetailPrint "Kept the project checkpoints in ${AEMCP}\checkpoints"
      ${EndIf}
    ${EndIf}
    ${If} $0 != 0
      DetailPrint "ae-mcp uninstall reported a problem (exit code $0)."
    ${EndIf}
  ${Else}
    ; no Node or server left (e.g. removed by hand): remove the extension; AI app settings are left as they are
    DetailPrint "The ${PRODUCT} server was not found; removing the After Effects extension only."
    RMDir /r "${CEP_EXT}"
    Delete "${SERVER}"
    RMDir "${SERVER_DIR}"
  ${EndIf}

  ; the private Node.js (an AI app still running the server can keep node.exe in use)
  RMDir /r "${NODE_DIR}"
  ${If} ${FileExists} "${NODE_DIR}\*.*"
    DetailPrint "Some of ${NODE_DIR} is in use; quit your AI apps and delete it by hand."
  ${EndIf}
  RMDir "${AEMCP}" ; only if empty (config.json and checkpoints are kept)

  DeleteRegKey HKCU "${UNINST_KEY}"
  Delete "$INSTDIR\surehand-mcp.ico"
  Delete "$INSTDIR\${UNINST_EXE}"
  RMDir "$INSTDIR"

  ${If} $AERunning == 1
    MessageBox MB_ICONINFORMATION "Restart After Effects to finish removing ${PRODUCT}." /SD IDOK
  ${EndIf}
SectionEnd
